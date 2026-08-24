#!/usr/bin/env python3
"""End-to-end verification that an agent backend really uses the REPL.

A backend can return the right answer for the wrong reason: a coding agent with
its own shell can compute internally and hand back a hardcoded result, which is
indistinguishable from REPL work if you only look at `results`. This harness
makes the difference observable.

It builds a context whose answers are impossible to guess — random data plus a
canary string buried at a random index — runs a real query through the backend,
then audits the run's .jsonl transcript:

  1. CORRECTNESS   every value matches ground truth computed locally
  2. CANARY        the answer contains a token that only exists deep in the
                   context, so the agent must have actually read what it was given
  3. REPL USED     the transcript contains executed steps whose code references
                   `context`, with real stdout — not just `FINAL(<literal>)`
  4. NO HARDCODING the final values do not appear as literals in the generated
                   code before they were computed
  5. NO NATIVE TOOLS  the engine detected no use of the agent's own shell/file
                   tools (see native_tool_events in src/cli_agent.ts)

Each run makes real LLM calls. A model is required — fast-rlm does not pick one.

Usage:
    python scripts/verify_agents.py cli:claude-code --model claude-sonnet-5
    python scripts/verify_agents.py --all --model sonnet
    python scripts/verify_agents.py "cli:codex?model=gpt-5.5-codex"

Exit code is non-zero if any agent fails any check.
"""

import argparse
import glob
import json
import os
import random
import re
import string
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

DEFAULT_AGENTS = ["cli:claude-code", "cli:codex", "cli:opencode"]

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


INSTRUCTION = (
    "Work ONLY inside the Python REPL, using the `context` variable. Compute these "
    "five values and return them as a single dict via FINAL:\n"
    "  sum_div_7:         sum of all numbers in context['numbers'] divisible by 7\n"
    "  count_div_7:       how many numbers in context['numbers'] are divisible by 7\n"
    "  max_gap:           largest difference between consecutive values once "
    "context['numbers'] is sorted ascending\n"
    "  words_with_double: how many words in context['words'] contain a doubled "
    "adjacent letter\n"
    "  canary:            the single word in context['words'] starting with 'CANARY-'\n"
    "Return exactly these five keys. Do not invent other keys."
)


def build_case(seed: int) -> tuple[dict, dict, str]:
    """Random context + locally-computed ground truth + the canary token.

    Nothing here is derivable without reading the data: the numbers are random,
    and the canary is a random token at a random depth in a 4000-element list.
    """
    rng = random.Random(seed)
    numbers = [rng.randint(1000, 9999) for _ in range(4000)]
    words = ["".join(rng.choice("abcdefg") for _ in range(6)) for _ in range(2000)]

    canary = "CANARY-" + "".join(rng.choice(string.ascii_uppercase + string.digits) for _ in range(10))
    canary_index = rng.randrange(1500, 1900)
    words[canary_index] = canary

    srt = sorted(numbers)
    truth = {
        "sum_div_7": sum(n for n in numbers if n % 7 == 0),
        "count_div_7": sum(1 for n in numbers if n % 7 == 0),
        "max_gap": max(b - a for a, b in zip(srt, srt[1:])),
        "words_with_double": sum(
            1 for w in words if any(w[i] == w[i + 1] for i in range(len(w) - 1))
        ),
        "canary": canary,
    }
    # The task goes through `instruction=`, NOT into the context dict: the
    # engine's step-0 probe truncates each context value to 200 chars, so a task
    # buried there is only half-visible until the agent prints it. `instruction`
    # lands in the system prompt, where every backend sees all of it.
    context = {"numbers": numbers, "words": words}
    return context, truth, canary


def load_events(log_file: str) -> list[dict]:
    with open(log_file) as f:
        return [json.loads(line) for line in f if line.strip()]


def audit(events: list[dict], truth: dict, results) -> list[tuple[str, bool, str]]:
    """Run the five checks against the transcript. Returns (name, ok, detail)."""
    checks: list[tuple[str, bool, str]] = []

    # 1. correctness
    if isinstance(results, str):
        try:
            results = json.loads(results)
        except json.JSONDecodeError:
            pass
    ok_correct, detail = True, "all values match"
    if not isinstance(results, dict):
        ok_correct, detail = False, f"expected a dict, got {type(results).__name__}"
    else:
        wrong = {
            k: (results.get(k), v) for k, v in truth.items()
            if str(results.get(k)) != str(v)
        }
        if wrong:
            ok_correct = False
            detail = "; ".join(f"{k}: got {g!r} want {w!r}" for k, (g, w) in wrong.items())
    checks.append(("correctness", ok_correct, detail))

    # 2. canary — only obtainable by scanning the supplied context
    got_canary = isinstance(results, dict) and results.get("canary") == truth["canary"]
    checks.append((
        "canary from context", got_canary,
        truth["canary"] if got_canary else f"missing/wrong (want {truth['canary']})",
    ))

    # Steps that actually ran (step 0 is the engine's own probe).
    executed = [
        e for e in events
        if e.get("event_type") in ("execution_result", "code_generated")
        and (e.get("step") or 0) > 0
        and (e.get("code") or "").strip()
    ]

    # 3. the REPL did the work: code that touches `context` and produced stdout
    touching = [e for e in executed if "context" in (e.get("code") or "")]
    # Real computation, not just `FINAL(<literal>)`: the code has to actually
    # index into the data. (The step that calls FINAL is logged without an
    # `output` field, so stdout presence is reported but not required.)
    computing = [
        e for e in touching
        if re.search(r"context\s*\[", e.get("code") or "")
    ]
    with_output = [e for e in executed if (e.get("output") or "").strip()]
    ok_repl = bool(computing)
    checks.append((
        "REPL used", ok_repl,
        f"{len(executed)} step(s); {len(computing)} indexed into `context`; "
        f"{len(with_output)} produced stdout",
    ))

    # 4. no hardcoding: a numeric answer must not appear as a literal in code
    #    that does not also compute it. We look for the value written verbatim
    #    in a step whose code never mentions `context`.
    hardcoded = []
    for key in ("sum_div_7", "count_div_7", "words_with_double"):
        literal = str(truth[key])
        for e in executed:
            code = e.get("code") or ""
            if "context" in code:
                continue
            if re.search(rf"(?<!\d){re.escape(literal)}(?!\d)", code):
                hardcoded.append(f"{key}={literal} in step {e.get('step')}")
    checks.append((
        "no hardcoded answers", not hardcoded,
        "; ".join(hardcoded) if hardcoded else "no answer literals in non-context code",
    ))

    # 5. native tool use — the engine raises on this, so reaching here is a pass,
    #    but surface any warning the transcript recorded.
    warned = [e for e in events if "used its own tools" in json.dumps(e)]
    checks.append((
        "no native tool use", not warned,
        "engine detected none" if not warned else "native tool use recorded in transcript",
    ))

    return checks


def verify(agent: str, seed: int, max_money: float, max_calls: int, verbosity: int) -> bool:
    import fast_rlm
    from fast_rlm import RLMConfig

    context, truth, _canary = build_case(seed)
    log_dir = tempfile.mkdtemp(prefix="frlm_verify_")

    print(f"\n{'=' * 72}\n{agent}\n{'=' * 72}")
    print(f"{DIM}context: {len(context['numbers'])} numbers, {len(context['words'])} words, "
          f"{len(json.dumps(context)):,} chars{RESET}")

    started = time.time()
    try:
        out = fast_rlm.run(
            context,
            instruction=INSTRUCTION,
            config=RLMConfig(
                primary_agent=agent,
                max_global_calls=max_calls,
                max_money_spent=max_money,
            ),
            log_dir=log_dir,
            verbosity=verbosity,
        )
    except Exception as e:  # a failed run is a failed verification, not a crash
        print(f"{RED}RUN FAILED{RESET}: {e}")
        return False
    elapsed = time.time() - started

    log_file = out.get("log_file") or sorted(
        glob.glob(os.path.join(log_dir, "*.jsonl")), key=os.path.getmtime
    )[-1]
    checks = audit(load_events(log_file), truth, out.get("results"))

    for name, ok, detail in checks:
        mark = f"{GREEN}PASS{RESET}" if ok else f"{RED}FAIL{RESET}"
        print(f"  [{mark}] {name:<22} {DIM}{detail}{RESET}")

    usage = out.get("usage") or {}
    cost = usage.get("cost")
    print(f"  {DIM}{elapsed:.0f}s | {usage.get('prompt_tokens', 0):,} prompt, "
          f"{usage.get('completion_tokens', 0):,} completion | "
          f"cost {('$%.4f' % cost) if cost else 'not reported'}{RESET}")
    print(f"  {DIM}transcript: {log_file}{RESET}")

    # Usage reporting is the other thing ACP could not do; flag it, don't fail.
    if not usage.get("prompt_tokens"):
        print(f"  {YELLOW}note{RESET}: no token usage reported — token budgets are inert here")

    return all(ok for _, ok, _ in checks)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("agents", nargs="*", help="agent strings, e.g. cli:codex acp:opencode")
    p.add_argument("--all", action="store_true", help=f"verify {', '.join(DEFAULT_AGENTS)}")
    p.add_argument("--seed", type=int, default=None, help="fix the random case (default: random)")
    p.add_argument("--model", default=None,
                   help="Model to use for every agent that does not already carry "
                        "?model= (e.g. 'claude-sonnet-5'). A model is REQUIRED — "
                        "fast-rlm does not pick one for you.")
    p.add_argument("--max-money", type=float, default=3.0)
    p.add_argument("--max-calls", type=int, default=12)
    p.add_argument("-v", "--verbose", action="store_true", help="stream engine output")
    args = p.parse_args()

    agents = args.agents or (DEFAULT_AGENTS if args.all else [])
    if not agents:
        p.error("name at least one agent, or pass --all")

    seed = args.seed if args.seed is not None else random.randrange(10**6)
    print(f"seed {seed} (reproduce with --seed {seed})")

    if args.model:
        agents = [a if "model=" in a else f"{a}?model={args.model}" for a in agents]
    missing = [a for a in agents if "model=" not in a]
    if missing:
        p.error(
            "a model is required for " + ", ".join(missing) +
            " — pass --model <id>, or write it inline as cli:<agent>?model=<id>. "
            "fast-rlm does not pick a model for you."
        )

    results = {
        a: verify(a, seed, args.max_money, args.max_calls, 2 if args.verbose else 0)
        for a in agents
    }

    print(f"\n{'=' * 72}")
    for agent, ok in results.items():
        print(f"  {GREEN + 'PASS' + RESET if ok else RED + 'FAIL' + RESET}  {agent}")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
