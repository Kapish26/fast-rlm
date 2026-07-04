# Resumable Sessions

A `Session` lets follow-up queries reuse the work of earlier ones instead of re-exploring from scratch. There is no long-lived process — each `query()` is a normal run, and what persists between runs is the root agent's REPL state.

```python
import fast_rlm

session = fast_rlm.Session(session_dir="sessions", session_id="podcasts",
                           config={"primary_agent": "z-ai/glm-5"})

r1 = session.query("Here are all transcripts... Build a guest index and "
                   "summarize what the ML guests said about AGI.\n" + transcripts)
r2 = session.query("Using the index you already built: which guests were most "
                   "optimistic about AGI timelines?")   # no re-exploration
```

## Where state lives

Both arguments are optional, and how you pass them decides whether anything touches disk:

| Call | State location | Resumable later? |
|---|---|---|
| `Session()` | private temp dir, **auto-deleted** on close / GC / exit | No — every `Session()` is a clean slate |
| `Session(session_dir="runs")` | `runs/state.json` | Yes — re-open the same dir |
| `Session(session_dir="runs", session_id="podcasts")` | `runs/podcasts/state.json` | Yes — `session_id` namespaces many sessions under one dir |
| `Session(session_id="podcasts")` | — | `ValueError`: an id needs a dir |

The default `Session()` is **ephemeral**: queries in the same object still share variables, but nothing is written to a path a later run could accidentally resume — so experiments never pick up stale state by mistake. Close it early with `session.close()` or a `with` block; otherwise it is cleaned up when the object is collected or the process exits.

Also available as `fast_rlm.run(..., session_dir=..., session_id=...)` and `fast-rlm --session-dir ... --session-id ...`.

## What persists

After **every step** of the root agent, the engine sweeps the REPL into `<session_dir>/state.json` (written atomically — a killed run resumes from its last completed step):

| Saved | How |
|---|---|
| Picklable variables (≤ 5 MB each) | pickled; restored live into the next run's REPL |
| REPL-defined functions & classes | as **source** (recovered from the step code), re-executed on resume |
| Comments next to assignments | attached to the variable they describe, shown in the resume inventory |
| Query → `FINAL` ledger | shown to the resumed agent |
| The code of every step | shown to the resumed agent (failed steps compressed to one line) |

Not saved: `context` (it holds each query anew), open handles, generators, JS proxies — these are listed as *dropped* so the resumed agent knows what's missing.

> The 5 MB per-variable cap is generous — it comfortably holds indexes, parsed corpora, and embeddings for typical workloads, and a variable over the cap is reported in `session.dropped()` rather than silently lost. To rebalance the sweep cost, unchanged large immutable values (e.g. a loaded corpus string) are re-used from an in-process cache instead of being re-pickled on every step.

## What the resumed agent sees

A resumed query starts a **fresh conversation** (the old one is not carried; per-query context stays bounded no matter how old the session is), seeded with:

1. a preamble: earlier queries + `FINAL` answers, and the full code dump — the agent's own comments double as notes;
2. the step-0 probe printing the ground-truth inventory of restored variables (type, preview, comment, note) and any restore failures.

## Should the resumed agent see its earlier code?

By default it does, controlled by `add_session_code_to_context` (default `True`; CLI `--no-session-code` to turn it off):

```python
session = fast_rlm.Session(session_dir="runs/podcasts",
                           add_session_code_to_context=True)  # default
```

The restored variables alone are enough for the agent to *answer* a follow-up, so it's natural to ask whether the code dump earns its place in the prompt. We measured it: a synthetic-corpus session where the first query builds an index + helper, followed by six follow-up queries answered purely from the restored state (the corpus is never re-sent), run identically with the code dump ON vs OFF.

**Settings:** `google/gemini-3.5-flash` via OpenRouter; 40-episode synthetic podcast corpus; per-query input prompt tokens and answer correctness recorded on independent session directories.

| query | code ON — input tokens | code OFF — input tokens |
|---|---:|---:|
| Q1 (build) | 58,678 | 72,738 |
| Q2 | 16,757 | 56,223 |
| Q3 | 8,577 | 23,634 |
| Q4 | 8,737 | 63,881 |
| Q5 | 8,881 | 32,978 |
| Q6 | 8,983 | 32,685 |
| Q7 | 9,131 | 32,822 |
| **total** | **119,744** | **314,961** |

Both variants answered **every** query correctly. But with the code dump ON, per-query cost stays flat (~8–9k tokens) and the whole session is **~2.6× cheaper** — because the agent reuses *how* it built things instead of re-exploring the restored state from scratch each time. Keeping the earlier code is the recommended default; turn it off only when minimizing the resume prompt matters more than resume efficiency.

> The code dump grows with the amount of *new code* each query writes, not with the number of queries. In the reuse pattern above, follow-ups add only a line or two each (~100–200 chars), so the dump stayed tiny (~3.5 KB after seven queries). A session where every query does heavy multi-step work is the case to watch.

## The `commit()` tool

Inside the REPL the root agent has `commit(name, note=None)` — auto-saving is the safety net, `commit` is curation: attach a human-readable note to a variable, or force-save names the sweep skips (like `context`). Committed variables carry `committed: true` and the note in the state file.

## Inspecting a session from Python

```python
session.queries()    # [{"query": ..., "final": ...}] — completed ledger
session.variables()  # {name: {type, preview, comment, note, committed}}
session.functions()  # {name: source}
session.dropped()    # {name: reason it could not be saved}
session.clear()      # delete state; next query starts fresh
```

`variables()` never exposes the pickled bytes — values are only unpickled inside the REPL on resume.

## Scope and guarantees

- **Root agent only.** Sub-agents never see or contribute session state; they stay fresh and isolated.
- **Saved code is shown, never re-executed** (replaying old `llm_query` calls would be non-deterministic and cost money). The only re-execution is function/class definitions, which are deterministic.
- **Not a 1:1 process clone** — it is a directory of your agent's variables and notes, which is exactly what a follow-up query needs.

> **One live query per session directory.** State is written per step with no cross-process lock, so two queries running against the same persistent session dir at the same time (in one process or across processes) will race and one can clobber the other's saved state. Run queries in a session serially; use separate `session_id`s (or separate dirs) for concurrent work.
