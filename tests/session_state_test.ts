// Real-Pyodide test for resumable sessions: sweep a heap in kernel A (vars with
// comments, functions, a class + instance, commit notes, unpicklables), persist
// through the real state-merge path, restore into a FRESH kernel B, and verify
// values / functions / comments / dropped reporting. No LLM is invoked.
//
// Run:  deno run --allow-read --allow-env --allow-net --allow-write tests/session_state_test.ts
import { loadPyodide } from "pyodide";
import {
    applySweep,
    buildSessionPreamble,
    emptySessionState,
    SESSION_SETUP_PY,
} from "../src/session.ts";
import type { SweepResult } from "../src/session.ts";

let fail = false;
function ck(label: string, cond: boolean, extra = "") {
    console.log(`  ${cond ? "✔" : "✗"} ${label}${extra ? "  " + extra : ""}`);
    if (!cond) fail = true;
}

// ---- Kernel A: build state -------------------------------------------------
const pyA = await loadPyodide();
pyA.globals.set("context", "the original giant corpus " + "X".repeat(500));
await pyA.runPythonAsync(SESSION_SETUP_PY);

const STEP1 = `
# index of guest name -> episode ids
episode_index = {"karpathy": [1, 5], "lecun": [2]}
counts = [1, 2, 3]  # per-episode mention counts
plain = 42

def top_guest(idx):
    """Return the guest with the most episodes."""
    return max(idx, key=lambda k: len(idx[k]))

class Tally:
    def __init__(self, n):
        self.n = n
    def double(self):
        return self.n * 2

tally = Tally(21)
gen = (x for x in range(10))  # unpicklable: generator
commit("episode_index", note="guest -> [episode ids]")
`;
await pyA.runPythonAsync(STEP1);

const state = emptySessionState();
state.pending_query = "Build an index of the corpus";
const sweep1 = JSON.parse(
    String(await pyA.runPythonAsync(`__session_sweep__(${JSON.stringify(STEP1)})`)),
) as SweepResult;
applySweep(state, sweep1, { q: 0, step: 1, ok: true, code: STEP1 }, new Set(), {
    variables: {},
    functions: {},
});

console.log("\n[A] sweep captures the right things");
ck("episode_index saved", "episode_index" in state.variables);
ck("commit note attached", state.variables["episode_index"]?.note === "guest -> [episode ids]");
ck("comment-above extracted", state.variables["episode_index"]?.comment === "index of guest name -> episode ids");
ck("inline comment extracted", state.variables["counts"]?.comment === "per-episode mention counts");
ck("function saved as source", (state.functions["top_guest"] ?? "").includes("def top_guest"));
ck("class saved as source", (state.functions["Tally"] ?? "").includes("class Tally"));
ck("generator dropped with reason", (state.dropped["gen"] ?? "").includes("not picklable"));
ck("engine baseline (context) not swept", !("context" in state.variables));
ck("function not double-saved as variable", !("top_guest" in state.variables));

console.log("\n[B] del removes a variable from the next sweep");
await pyA.runPythonAsync(`del plain`);
const sweep2 = JSON.parse(
    String(await pyA.runPythonAsync(`__session_sweep__(None)`)),
) as SweepResult;
applySweep(state, sweep2, { q: 0, step: 2, ok: true, code: "del plain" }, new Set(), {
    variables: {},
    functions: {},
});
ck("deleted var gone", !("plain" in state.variables));
ck("others persist", "episode_index" in state.variables && "counts" in state.variables);

state.queries.push({ query: state.pending_query!, final: "karpathy wins" });
state.pending_query = null;

// ---- Kernel B: fresh process, restore --------------------------------------
const pyB = await loadPyodide();
pyB.globals.set("context", "the NEW follow-up query");
await pyB.runPythonAsync(SESSION_SETUP_PY);
const payload = JSON.stringify({ variables: state.variables, functions: state.functions });
const res = JSON.parse(
    String(await pyB.runPythonAsync(`__session_restore__(${JSON.stringify(payload)})`)),
) as { restored: string[]; failed: Record<string, string> };

console.log("\n[C] restore into a fresh kernel");
ck("no restore failures", Object.keys(res.failed).length === 0, JSON.stringify(res.failed));
const idx = await pyB.runPythonAsync(`episode_index["karpathy"]`);
ck("variable value round-trips", JSON.stringify(idx?.toJs ? idx.toJs() : idx) === "[1,5]");
const tg = await pyB.runPythonAsync(`top_guest(episode_index)`);
ck("restored function runs", String(tg) === "karpathy");
const dbl = await pyB.runPythonAsync(`tally.double()`);
ck("class instance round-trips (method works)", Number(dbl) === 42);
const ctx = await pyB.runPythonAsync(`context`);
ck("new context untouched", String(ctx) === "the NEW follow-up query");
const note = await pyB.runPythonAsync(`__session_commits__.get("episode_index")`);
ck("commit note restored", String(note) === "guest -> [episode ids]");

console.log("\n[D] probe + preamble content");
const preamble = buildSessionPreamble(state);
ck("preamble lists prior query", preamble.includes("Build an index of the corpus"));
ck("preamble lists FINAL", preamble.includes("karpathy wins"));
ck("preamble includes code dump w/ comments", preamble.includes("# index of guest name -> episode ids"));
const preambleNoCode = buildSessionPreamble(state, 1500, false);
ck("includeCode=false keeps the query ledger", preambleNoCode.includes("Build an index of the corpus"));
ck("includeCode=false omits the code dump", !preambleNoCode.includes("Code executed in earlier runs"));

console.log("\n[E] baseline-collision variables are parked under *_saved");
// Simulate an earlier run that committed 'context' (baseline name).
await pyA.runPythonAsync(`commit("context")`);
const sweep3 = JSON.parse(
    String(await pyA.runPythonAsync(`__session_sweep__(None)`)),
) as SweepResult;
ck("committed baseline name IS swept", "context" in sweep3.variables);
const pyC = await loadPyodide();
pyC.globals.set("context", "the NEW query");
await pyC.runPythonAsync(SESSION_SETUP_PY);
const res2 = JSON.parse(
    String(await pyC.runPythonAsync(
        `__session_restore__(${JSON.stringify(JSON.stringify({ variables: { context: sweep3.variables["context"] }, functions: {} }))})`,
    )),
) as { restored: string[]; failed: Record<string, string> };
ck("restored under renamed slot", res2.restored.includes("context -> context_saved"));
const saved = await pyC.runPythonAsync(`context_saved[:25]`);
ck("old context value intact", String(saved) === "the original giant corpus");
const newCtx = await pyC.runPythonAsync(`context`);
ck("live context still the new query", String(newCtx) === "the NEW query");

console.log("\n" + "=".repeat(48));
if (fail) {
    console.log("SESSION STATE TESTS FAILED");
    Deno.exit(1);
}
console.log("ALL SESSION STATE TESTS PASSED (no LLM invoked)");
