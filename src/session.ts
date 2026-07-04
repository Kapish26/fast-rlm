// Resumable disk-based sessions.
//
// A session is a directory holding one `state.json`. The engine (root agent
// only) sweeps the REPL after every step: every non-engine global that pickles
// is saved, functions/classes are saved as source (recovered from the step code
// via ast, since inspect.getsource fails on REPL-defined code), and comments
// adjacent to assignments are attached to the variables they describe. On the
// next run over the same session dir, the state is restored into a fresh REPL
// and the agent is shown a resume preamble: prior queries + FINAL answers and
// the code dump (comments included) — the conversation itself is NOT carried.
//
// This is deliberately NOT 1:1 process replication: live handles, generators,
// and JS proxies don't survive; they are listed as dropped so the model knows.
// Saved code is only ever SHOWN to the model, never re-executed (replaying old
// llm_query calls would be non-deterministic and cost money); the exceptions
// are function/class defs, whose re-exec is deterministic.

export interface SessionVariable {
    pickle_b64: string;
    type: string;
    preview: string;
    comment: string | null;
    note: string | null;
    committed: boolean;
}

export interface SessionCodeEntry {
    q: number; // index into queries (== queries.length while the query is pending)
    step: number;
    ok: boolean;
    code: string;
}

export interface SessionState {
    version: number;
    queries: { query: string; final: unknown }[];
    pending_query: string | null; // set while a query runs; moved into queries at FINAL
    code_log: SessionCodeEntry[];
    variables: Record<string, SessionVariable>;
    functions: Record<string, string>; // name -> source (functions AND classes)
    dropped: Record<string, string>; // name -> reason it could not be saved
}

export function emptySessionState(): SessionState {
    return {
        version: 1,
        queries: [],
        pending_query: null,
        code_log: [],
        variables: {},
        functions: {},
        dropped: {},
    };
}

export function loadSessionState(path: string): SessionState | null {
    try {
        const raw = Deno.readTextFileSync(path);
        const st = JSON.parse(raw) as SessionState;
        if (typeof st !== "object" || st === null || st.version !== 1) return null;
        return { ...emptySessionState(), ...st };
    } catch {
        return null; // missing or corrupt -> start fresh
    }
}

// A per-run writer that writes atomically (tmp + rename, so a crash mid-write
// never corrupts the state) and skips the (potentially multi-MB) write entirely
// when the serialized state is byte-identical to what it last wrote — the common
// case on a step that changed nothing persistable. Crash-safety is unaffected:
// if nothing changed there is nothing new to lose.
export function makeSessionWriter(path: string): (state: SessionState) => Promise<void> {
    let last = "";
    return async (state: SessionState) => {
        const json = JSON.stringify(state);
        if (json === last) return;
        const tmp = path + ".tmp";
        await Deno.writeTextFile(tmp, json);
        await Deno.rename(tmp, path);
        last = json;
    };
}

export interface SweepResult {
    variables: Record<string, SessionVariable>;
    functions: Record<string, string>;
    dropped: Record<string, string>;
}

// Merge one post-step sweep into the state. The sweep is a FULL snapshot of the
// current heap, so it replaces variables/functions — a variable the agent
// `del`ed disappears, as it should. `preserve` names failed to restore into
// this run's REPL (so the sweep can't see them); their old entries are kept
// rather than silently erased.
export function applySweep(
    state: SessionState,
    sweep: SweepResult,
    entry: SessionCodeEntry,
    preserve: Set<string>,
    prev: { variables: Record<string, SessionVariable>; functions: Record<string, string> },
): void {
    state.code_log.push(entry);
    const vars = { ...sweep.variables };
    const fns = { ...sweep.functions };
    for (const name of preserve) {
        if (!(name in vars) && prev.variables[name]) vars[name] = prev.variables[name];
        if (!(name in fns) && prev.functions[name]) fns[name] = prev.functions[name];
    }
    state.variables = vars;
    state.functions = fns;
    state.dropped = { ...state.dropped, ...sweep.dropped };
    for (const name of Object.keys(vars)) delete state.dropped[name]; // saved after all
}

function trunc(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + `...[truncated, ${s.length} chars total]` : s;
}

// The message section shown to a resumed agent BEFORE the step-0 probe.
// Prior queries/answers + the code dump are here; the live-variable inventory
// is printed by the probe itself (SESSION_PROBE_PY), so the model sees ground
// truth for what actually exists rather than trusting this text.
export function buildSessionPreamble(state: SessionState, queryTrunc = 1500, includeCode = true): string {
    if (!state.queries.length && !state.code_log.length) return "";
    const parts: string[] = [
        "=== RESUMED SESSION ===",
        "This run continues a persistent session. The conversation of earlier runs is not shown;",
        "instead you get (a) earlier queries and their FINAL answers, (b) the code you executed",
        "(its comments are your own notes), and (c) your saved variables, restored live into this",
        "REPL — see the probe below for the inventory. `context` now holds the NEW query only;",
        "earlier contexts were NOT saved unless committed.",
        "",
        "Earlier queries in this session:",
    ];
    state.queries.forEach((q, i) => {
        parts.push(`[${i + 1}] QUERY: ${trunc(q.query, queryTrunc)}`);
        let fin: string;
        try {
            fin = typeof q.final === "string" ? q.final : JSON.stringify(q.final);
        } catch {
            fin = String(q.final);
        }
        parts.push(`    FINAL: ${trunc(fin ?? "null", queryTrunc)}`);
    });
    if (state.pending_query != null) {
        parts.push(
            `[${state.queries.length + 1}] QUERY: ${trunc(state.pending_query, queryTrunc)}`,
            `    (crashed or was interrupted before FINAL — its variables may still be saved)`,
        );
    }
    // The historical code dump is what lets a resumed agent reuse HOW it built
    // things instead of re-deriving them; experiments show it materially speeds
    // up follow-up queries. `includeCode=false` (add_session_code_to_context in
    // the Python API) omits it for the rare case where prompt size matters more.
    if (state.code_log.length && includeCode) {
        parts.push("", "Code executed in earlier runs (failed steps compressed to comments):", "```python");
        for (const e of state.code_log) {
            if (e.ok) {
                parts.push(`# --- query ${e.q + 1}, step ${e.step} ---`, e.code.trim());
            } else {
                const first = e.code.trim().split("\n")[0] ?? "";
                parts.push(`# --- query ${e.q + 1}, step ${e.step} FAILED: ${trunc(first, 120)}`);
            }
        }
        parts.push("```");
    }
    parts.push("=======================", "");
    return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Python injected into the root REPL when session mode is on. Defines:
//   commit(name, note=None)      — agent-facing: force-save + annotate a variable
//   __session_sweep__(step_code) — full-heap snapshot -> JSON (called per step)
//   __session_restore__(json)    — rebuild functions + unpickle variables
// Baseline names captured at setup are engine-owned and never swept (commit
// overrides). Functions/classes are captured as source at sweep time by
// ast-parsing the step's code; comments are attached to assignment targets via
// tokenize (inline comment first, else the contiguous comment block above).
// ---------------------------------------------------------------------------
export const SESSION_SETUP_PY = `
import json as __ss_json
import pickle as __ss_pickle
import base64 as __ss_b64
import ast as __ss_ast
import io as __ss_io
import types as __ss_types
import tokenize as __ss_tokenize

__session_comments__ = {}
__session_commits__ = {}
__session_fn_sources__ = {}
__session_restore_result__ = None
__SESSION_MAX_VAR_BYTES__ = 5_000_000

# Per-step re-pickling is the sweep's dominant cost when a big value (e.g. a
# loaded corpus string) sits in the heap unchanged across many steps. Cache the
# pickle of deeply-immutable values keyed by name; reuse it while the bound
# object identity is unchanged (immutable content can't have mutated). Mutable
# values (dict/list/set/custom) are always re-pickled — they may have changed
# in place with no identity change. The cache holds the object itself (not just
# id()) so a freed-then-recycled id can't cause a stale-blob false match.
__session_pickle_cache__ = {}  # name -> (val, blob_bytes)
__SESSION_IMMUTABLE__ = (str, bytes, int, float, bool, complex, type(None))


def commit(name, note=None):
    """Force-save a REPL variable into the persistent session and attach a note.

    Picklable variables you create are auto-saved anyway; use commit() to add a
    note describing the variable, or to save names the auto-sweep skips (like
    'context'). Example: commit("episode_index", note="dict: guest -> [episode ids]")
    """
    if not isinstance(name, str):
        raise TypeError("commit(name, note=None): pass the variable's NAME as a string")
    if name not in globals():
        raise KeyError(f"No variable named {name!r} in the REPL")
    __session_commits__[name] = note
    return f"committed {name!r}"


def __session_scan_code__(code):
    comments = {}
    try:
        for tok in __ss_tokenize.generate_tokens(__ss_io.StringIO(code).readline):
            if tok.type == __ss_tokenize.COMMENT:
                comments[tok.start[0]] = tok.string.lstrip("#").strip()
    except Exception:
        pass
    try:
        tree = __ss_ast.parse(code)
    except SyntaxError:
        return
    for node in tree.body:
        if isinstance(node, (__ss_ast.FunctionDef, __ss_ast.AsyncFunctionDef, __ss_ast.ClassDef)):
            src = __ss_ast.get_source_segment(code, node)
            if src:
                __session_fn_sources__[node.name] = src
            continue
        targets = []
        if isinstance(node, __ss_ast.Assign):
            targets = [t.id for t in node.targets if isinstance(t, __ss_ast.Name)]
        elif isinstance(node, (__ss_ast.AnnAssign, __ss_ast.AugAssign)) and isinstance(
            node.target, __ss_ast.Name
        ):
            targets = [node.target.id]
        if not targets:
            continue
        c = comments.get(node.lineno) or comments.get(getattr(node, "end_lineno", node.lineno))
        if c is None:
            block, l = [], node.lineno - 1
            while l in comments:
                block.append(comments[l])
                l -= 1
            if block:
                c = " ".join(reversed(block))
        if c:
            for t in targets:
                __session_comments__[t] = c


def __session_sweep__(step_code=None):
    if step_code:
        __session_scan_code__(step_code)
    out_vars, dropped = {}, {}
    g = dict(globals())
    for name, val in g.items():
        if name.startswith("_"):
            continue
        committed = name in __session_commits__
        if name in __session_baseline__ and not committed:
            continue
        if isinstance(val, __ss_types.ModuleType):
            continue
        if name in __session_fn_sources__ and callable(val):
            continue  # persisted as source below
        cached = __session_pickle_cache__.get(name)
        if (
            isinstance(val, __SESSION_IMMUTABLE__)
            and cached is not None
            and cached[0] is val
        ):
            blob = cached[1]  # same immutable object -> pickle can't have changed
        else:
            try:
                blob = __ss_pickle.dumps(val, protocol=4)
            except Exception as e:
                dropped[name] = (f"not picklable: {type(e).__name__}: {e}")[:200]
                __session_pickle_cache__.pop(name, None)
                continue
            if isinstance(val, __SESSION_IMMUTABLE__):
                __session_pickle_cache__[name] = (val, blob)
        if len(blob) > __SESSION_MAX_VAR_BYTES__:
            dropped[name] = f"too large to save: {len(blob)} bytes (cap {__SESSION_MAX_VAR_BYTES__})"
            continue
        preview = repr(val)
        if len(preview) > 200:
            preview = preview[:200] + "...[truncated]"
        out_vars[name] = {
            "pickle_b64": __ss_b64.b64encode(blob).decode(),
            "type": type(val).__name__,
            "preview": preview,
            "comment": __session_comments__.get(name),
            "note": __session_commits__.get(name),
            "committed": committed,
        }
    out_fns = {
        n: s for n, s in __session_fn_sources__.items() if n in g and callable(g[n])
    }
    return __ss_json.dumps({"variables": out_vars, "functions": out_fns, "dropped": dropped})


def __session_restore__(state_json):
    global __session_restore_result__
    st = __ss_json.loads(state_json)
    restored, failed = [], {}
    # Functions/classes first: instances unpickled below may reference them.
    for name, src in (st.get("functions") or {}).items():
        try:
            exec(compile(src, f"<session:{name}>", "exec"), globals())
            __session_fn_sources__[name] = src
            restored.append(name)
        except Exception as e:
            failed[name] = (f"function restore failed: {type(e).__name__}: {e}")[:200]
    for name, meta in (st.get("variables") or {}).items():
        target = name
        if name in __session_baseline__:
            # Never clobber engine names (or the NEW query in 'context');
            # park the old value under a suffixed name instead.
            target = name + "_saved"
            if target in __session_baseline__ or target in globals():
                failed[name] = "name collides with engine builtins"
                continue
        try:
            globals()[target] = __ss_pickle.loads(__ss_b64.b64decode(meta["pickle_b64"]))
            restored.append(name if target == name else f"{name} -> {target}")
            if meta.get("comment"):
                __session_comments__[target] = meta["comment"]
            if meta.get("committed"):
                __session_commits__[target] = meta.get("note")
        except Exception as e:
            failed[name] = (f"unpickle failed: {type(e).__name__}: {e}")[:200]
    __session_restore_result__ = {"restored": restored, "failed": failed}
    return __ss_json.dumps(__session_restore_result__)


# Everything defined up to here (engine bridges, tools, context, these helpers)
# is engine-owned and excluded from the sweep. MUST stay the last statement.
__session_baseline__ = set(globals().keys()) | {"__session_baseline__"}
`;

// Appended to the step-0 probe when session mode is on: announces persistence +
// commit(), and prints the ground-truth inventory of restored state.
export const SESSION_PROBE_PY = `
print("---")
print("SESSION MODE: this run is part of a persistent, resumable session.")
print("Picklable variables you create are auto-saved after every step. Use")
print("commit(name, note='...') to attach a note describing a variable (or to")
print("force-save skipped names like 'context'). Unpicklable values (open")
print("handles, generators, JS proxies) are NOT saved across runs.")
if __session_restore_result__:
    _r = __session_restore_result__
    if _r["restored"]:
        print(f"Restored into this REPL ({len(_r['restored'])}):")
        for _n in _r["restored"]:
            _t = _n.split(" -> ")[-1]
            _v = globals().get(_t)
            _p = repr(_v)
            if len(_p) > 150:
                _p = _p[:150] + "...[truncated]"
            _c = __session_comments__.get(_t)
            _note = __session_commits__.get(_t)
            _extra = f"  # {_c}" if _c else ""
            _extra += f"  [note: {_note}]" if _note else ""
            print(f"  {_n} ({type(_v).__name__}): {_p}{_extra}")
    if _r["failed"]:
        print(f"Could NOT be restored ({len(_r['failed'])}):")
        for _n, _why in _r["failed"].items():
            print(f"  {_n}: {_why}")
`;
