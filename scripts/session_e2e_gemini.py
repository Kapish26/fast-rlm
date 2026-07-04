"""Live end-to-end experiments for resumable sessions (costs real API money).

Runs against OpenRouter gemini-3.5-flash using RLM_MODEL_API_KEY_2:

    RLM_MODEL_API_KEY="$RLM_MODEL_API_KEY_2" uv run python scripts/session_e2e_gemini.py

Experiments (each on its own session dir under a temp root):
  E1  resume + reuse: Q1 builds an index over a synthetic corpus; Q2 (fresh
      process) must answer from the restored index. Also checks comment capture
      and that Q2 did not re-ingest the corpus.
  E2  function persistence: a helper def'd in Q1 is saved as source and is
      callable in Q2.
  E3  commit(): the agent's note lands in state.json.
  E4  crash resume: Q dies without FINAL (1-call budget) -> pending_query +
      swept vars survive; a resumed run finishes the task.
  E5  dropped reporting: a generator variable is reported as unsaveable.

NOT part of pytest (live LLM, nondeterministic): reports PASS/FAIL per check
and exits 1 if any hard check fails.
"""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import fast_rlm  # noqa: E402

MODEL = "google/gemini-3.5-flash"
ROOT = tempfile.mkdtemp(prefix="rlm_session_e2e_")
CONFIG = {
    "primary_agent": MODEL,
    "max_money_spent": 0.15,
    "max_calls_per_subagent": 8,
    "max_depth": 1,
}

# Synthetic corpus with known ground truth: guest -> episodes.
GUESTS = ["rivera", "chen", "okafor", "lindqvist", "tanaka"]
TRUTH = {g: [] for g in GUESTS}
lines = []
for ep in range(1, 41):
    g = GUESTS[(ep * 7) % len(GUESTS)]
    TRUTH[g].append(ep)
    lines.append(
        f"Episode {ep}. Guest: Dr. {g.title()}. Topic: {'AGI timelines' if ep % 3 == 0 else 'robotics'}. "
        f"Summary: In episode {ep}, Dr. {g.title()} argued about point #{ep * 13 % 97}. " + "filler " * 40
    )
CORPUS = "\n".join(lines)

results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, extra: str = ""):
    results.append((name, cond, extra))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{('  ' + extra) if extra else ''}")


def session(name: str, **cfg_overrides) -> fast_rlm.Session:
    return fast_rlm.Session(
        session_dir=os.path.join(ROOT, name),
        config={**CONFIG, **cfg_overrides},
        verbosity="silent",
        log_dir=os.path.join(ROOT, "logs"),
    )


def steps_of_last_run(s: fast_rlm.Session) -> list[dict]:
    st = json.load(open(s.state_file))
    qmax = max((e["q"] for e in st["code_log"]), default=0)
    return [e for e in st["code_log"] if e["q"] == qmax]


print(f"\n=== E1+E2: resume + reuse, function persistence  (dir: {ROOT}) ===")
s = session("e1")
r1 = s.query(
    "PODCAST CORPUS BELOW. Do two things in your REPL:\n"
    "1. Define a function `episodes_of(guest_index, name)` returning the sorted "
    "episode list for a guest.\n"
    "2. Build `guest_index` (add a Python comment describing it): a dict of "
    "lowercase guest surname -> sorted list of episode numbers.\n"
    "Then FINAL the number of distinct guests (an int).\n\nCORPUS:\n" + CORPUS
)
check("E1 Q1 final correct (5 guests)", r1["results"] == 5, f"got {r1['results']!r}")
v = s.variables()
check("E1 guest_index persisted", "guest_index" in v, str(list(v)))
check("E1 comment captured", bool(v.get("guest_index", {}).get("comment")),
      repr(v.get("guest_index", {}).get("comment")))
check("E2 function saved as source", "episodes_of" in s.functions(), str(list(s.functions())))

r2 = s.query(
    "Using the `guest_index` you already built earlier in this session (do NOT "
    "rebuild it — the corpus is gone), call your `episodes_of` helper and FINAL "
    "the sorted list of episode numbers for guest 'rivera'."
)
got = r2["results"]
check("E1 Q2 answers from restored state", got == TRUTH["rivera"], f"got {got!r} want {TRUTH['rivera']}")
q2_code = "\n".join(e["code"] for e in steps_of_last_run(s))
check("E1 Q2 used restored index (no re-ingest)", "guest_index" in q2_code and "Episode 1." not in q2_code)
check("E2 helper callable in Q2", "episodes_of(" in q2_code, "helper not called (soft)")

print("\n=== E3: commit() note ===")
s3 = session("e3")
s3.query(
    "Create a variable `magic = [7, 11, 13]`, then call "
    "commit('magic', note='the three magic primes') exactly as written. "
    "Then FINAL the string 'done'."
)
m = s3.variables().get("magic", {})
check("E3 variable committed", m.get("committed") is True, str(m))
check("E3 note stored", m.get("note") == "the three magic primes", repr(m.get("note")))

print("\n=== E4: crash resume (no FINAL in run 1) ===")
s4 = session("e4", max_calls_per_subagent=1)
try:
    s4.query(
        "First step: parse the CSV below into a variable `rows` (list of dicts) "
        "and print its length — do NOT call FINAL yet, just explore.\n\n"
        "name,score\nasha,8\nbo,6\ncy,9\n"
    )
    crashed = False
except RuntimeError:
    crashed = True  # budget exhausted before FINAL — the 'crash'
st4 = json.load(open(s4.state_file))
check("E4 run 1 died without FINAL", crashed and st4["pending_query"] is not None)
check("E4 vars swept before death", "rows" in st4["variables"], str(list(st4["variables"])))
s4b = session("e4")  # normal budget, same dir
r4 = s4b.query(
    "Resume: using the `rows` variable already in your REPL from the interrupted "
    "run, FINAL the name with the highest score (a string)."
)
check("E4 resumed run finishes from swept state", r4["results"] == "cy", f"got {r4['results']!r}")

print("\n=== E5: dropped reporting ===")
s5 = session("e5")
s5.query(
    "Create `gen = (x*x for x in range(100))` (a generator — keep it as a "
    "generator, do not consume or listify it) and `total = sum(range(10))`. "
    "Then FINAL the value of total."
)
check("E5 generator reported dropped", "gen" in s5.dropped(), str(s5.dropped()))
check("E5 picklable sibling saved", "total" in s5.variables())

print("\n" + "=" * 56)
hard_fails = [n for n, ok, _ in results if not ok]
print(f"{len(results) - len(hard_fails)}/{len(results)} checks passed.")
if hard_fails:
    print("FAILED:", hard_fails)
print(f"Session dirs kept at {ROOT} for inspection.")
sys.exit(1 if hard_fails else 0)
