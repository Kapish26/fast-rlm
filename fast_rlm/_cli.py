import argparse
import json
import os
import shutil
import subprocess
import sys

from fast_rlm._runner import _find_engine_dir

USAGE = (
    "Usage: fast-rlm-log <log-file.jsonl> [--stats|--tui]\n"
    "       fast-rlm-log <session-dir | state.json> [--stats]   "
    "(session: query timeline across runs)"
)


def _run_totals(log_path: str) -> dict:
    """Tokens/cost/steps for one run's .jsonl (best-effort; {} if unreadable)."""
    try:
        with open(log_path) as f:
            entries = [json.loads(line) for line in f if line.strip()]
    except (OSError, json.JSONDecodeError):
        return {}
    tokens = cost = steps = 0
    for e in entries:
        if e.get("event_type") in ("execution_result", "code_generated"):
            steps += 1
        u = e.get("usage")
        if u:
            tokens += u.get("total_tokens", 0)
            cost += u.get("cost", 0) or 0
    return {"tokens": tokens, "cost": cost, "steps": steps}


def _truncate(s: str, n: int = 120) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _print_session(state_file: str):
    """Render a whole session: the query→FINAL timeline across its runs, with
    per-query token/cost totals pulled from each run's linked .jsonl log."""
    with open(state_file) as f:
        st = json.load(f)
    session_dir = os.path.dirname(state_file)
    queries = st.get("queries", [])

    print(f"Session:  {session_dir}")
    print(f"State:    {state_file}  (v{st.get('version', '?')})")
    print(f"Queries:  {len(queries)} completed"
          + ("  (+1 pending/interrupted)" if st.get("pending_query") else ""))
    print(f"Saved:    {len(st.get('variables', {}))} variable(s), "
          f"{len(st.get('functions', {}))} function(s), "
          f"{len(st.get('dropped', {}))} dropped")
    print()

    grand_tokens = 0
    grand_cost = 0.0
    for i, q in enumerate(queries, 1):
        print(f"[{i}] {_truncate(q.get('query', ''))}")
        print(f"    FINAL: {_truncate(q.get('final'))}")
        log_file = q.get("log_file")
        if log_file and os.path.exists(log_file):
            t = _run_totals(log_file)
            if t:
                grand_tokens += t["tokens"]
                grand_cost += t["cost"]
                print(f"    run:   {t['steps']} step(s), {t['tokens']:,} tokens, "
                      f"${t['cost']:.6f}")
            print(f"    log:   {log_file}   "
                  f"(view: fast-rlm-log {log_file} --tui)")
        elif log_file:
            print(f"    log:   {log_file}  (missing — rotated or moved)")
        else:
            print("    log:   (not linked — run predates session log linking)")
        print()

    print(f"Session total: {grand_tokens:,} tokens, ${grand_cost:.6f} "
          f"across {len(queries)} run(s)")


def main():
    """`fast-rlm` CLI entry point — a thin front door over fast_rlm.run()."""
    p = argparse.ArgumentParser(
        prog="fast-rlm",
        description="Run a fast-rlm query from the command line.",
    )
    p.add_argument("prompt", nargs="?", default=None,
                   help="The task/prompt. Goes into the system prompt as the "
                        "instruction. Optional only if --input-file is given.")
    p.add_argument("--input-file", default=None,
                   help="Path to the input. .json/.yaml/.yml -> dict/list, "
                        ".jsonl/.ndjson -> list[dict]; anything else (.csv, .tsv, "
                        ".xml, .toml, .txt, ...) -> raw text the model parses "
                        "itself (the extension is passed to it). Becomes the query "
                        "context; the prompt stays the instruction.")
    p.add_argument("--primary-agent", default=None,
                   help="Root-agent model (e.g. 'z-ai/glm-5', 'acp:opencode').")
    p.add_argument("--sub-agent", default=None,
                   help="Sub-agent model (defaults to --primary-agent).")
    p.add_argument("--max-depth", type=int, default=None,
                   help="Max recursive sub-agent depth (default: RLMConfig's 3).")
    p.add_argument("--max-calls", type=int, default=None,
                   help="Max REPL calls per sub-agent (default: RLMConfig's 20).")
    p.add_argument("--max-global-calls", type=int, default=None,
                   help="Global cap on total LLM calls across the whole run "
                        "(root + all sub-agents). Recommended for ACP agents.")
    p.add_argument("--acp-agents", default=None,
                   help="JSON registry of custom ACP agents (or @file.json). "
                        "Only needed for non-preset agents.")
    p.add_argument("--prefix", default=None, help="Log filename prefix.")
    p.add_argument("--log-dir", default=None,
                   help="Directory for the run's .jsonl transcript (default: ./logs).")
    p.add_argument("--session-dir", default=None,
                   help="Directory of a persistent, resumable session (created if "
                        "missing). Variables/functions the agent builds are saved "
                        "after every step and restored on the next run over the "
                        "same directory.")
    p.add_argument("--session-id", default=None,
                   help="Name of the session within --session-dir; state lives in "
                        "<session-dir>/<session-id>. Requires --session-dir.")
    p.add_argument("--no-session-code", action="store_true",
                   help="On resume, omit earlier queries' code from the agent's "
                        "context (keeps the resume prompt smaller; loses the "
                        "speed-up from reusing prior code). Default: code included.")
    p.add_argument("--vertex", action="store_true",
                   help="Route models through Vertex AI (ADC auth).")
    p.add_argument("-q", "--quiet", action="store_true",
                   help="Suppress the engine's streamed output (same as "
                        "--verbosity silent).")
    p.add_argument("--verbosity", default=None,
                   choices=["silent", "summary", "full"],
                   help="How much the engine prints: silent (nothing), summary "
                        "(final result + usage), or full (per-step, default). "
                        "Overrides -q/--quiet.")
    args = p.parse_args()

    if not args.prompt and not args.input_file:
        p.error("provide a prompt, --input-file, or both.")

    if args.input_file and not os.path.exists(args.input_file):
        p.error(f"input file not found: {args.input_file}")

    if args.session_id and not args.session_dir:
        p.error("--session-id requires --session-dir.")

    config: dict = {}
    if args.primary_agent:
        config["primary_agent"] = args.primary_agent
    if args.sub_agent:
        config["sub_agent"] = args.sub_agent
    if args.max_depth is not None:
        config["max_depth"] = args.max_depth
    if args.max_calls is not None:
        config["max_calls_per_subagent"] = args.max_calls
    if args.max_global_calls is not None:
        config["max_global_calls"] = args.max_global_calls
    if args.acp_agents:
        raw = args.acp_agents
        if raw.startswith("@"):
            with open(raw[1:]) as f:
                raw = f.read()
        config["acp_agents"] = json.loads(raw)

    # Imported here so `fast-rlm-log` and --help don't pay the import cost.
    from fast_rlm._runner import run

    # The positional prompt is always the instruction (it goes into the system
    # prompt). With no --input-file it's also the query; otherwise run() loads the
    # file into the query and handles the extension note / dict injection.
    data = run(
        query=None if args.input_file else args.prompt,
        input_file=args.input_file,
        instruction=args.prompt,
        config=config or None,
        prefix=args.prefix,
        log_dir=args.log_dir,
        session_dir=args.session_dir,
        session_id=args.session_id,
        add_session_code_to_context=not args.no_session_code,
        vertex=args.vertex,
        verbose=not args.quiet,
        verbosity=args.verbosity,
    )

    results = data.get("results")
    if isinstance(results, (dict, list)):
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        print(results)
    if data.get("log_file"):
        print(f"\nLog: {data['log_file']}", file=sys.stderr)


def _print_stats(log_path: str):
    with open(log_path) as f:
        entries = [json.loads(line) for line in f if line.strip()]

    if not entries:
        print("No log entries found.")
        return

    runs = {}
    for e in entries:
        rid = e.get("run_id", "unknown")
        if rid not in runs:
            runs[rid] = {"depth": e.get("depth", 0), "steps": 0, "usage": None}
        if e.get("event_type") in ("execution_result", "code_generated"):
            runs[rid]["steps"] += 1
        if e.get("usage"):
            runs[rid]["usage"] = e["usage"]

    total_tokens = 0
    total_cost = 0.0
    for e in entries:
        u = e.get("usage")
        if u:
            total_tokens += u.get("total_tokens", 0)
            total_cost += u.get("cost", 0)

    max_depth = max(e.get("depth", 0) for e in entries)
    roots = [r for r in runs.values() if r["depth"] == 0]

    print(f"Log entries:  {len(entries)}")
    print(f"Total runs:   {len(runs)}")
    print(f"Root runs:    {len(roots)}")
    print(f"Max depth:    {max_depth}")
    print(f"Total tokens: {total_tokens:,}")
    print(f"Total cost:   ${total_cost:.6f}")


def view_log():
    args = sys.argv[1:]
    if not args or args[0].startswith("-"):
        print(USAGE)
        sys.exit(1)

    target = os.path.abspath(args[0])
    if not os.path.exists(target):
        print(f"Error: not found: {target}", file=sys.stderr)
        sys.exit(1)

    mode = args[1] if len(args) > 1 else "--stats"

    # Session mode: a directory holding state.json, or a state.json file itself.
    state_file = None
    if os.path.isdir(target):
        cand = os.path.join(target, "state.json")
        if os.path.exists(cand):
            state_file = cand
        else:
            print(f"Error: no state.json in {target} (not a session directory).",
                  file=sys.stderr)
            sys.exit(1)
    elif os.path.basename(target) == "state.json":
        state_file = target

    if state_file:
        if mode == "--tui":
            _launch_tui(state_file)  # session timeline; drill into any query's run
            return
        _print_session(state_file)
        return

    log_path = target

    if mode == "--stats":
        _print_stats(log_path)
        return

    if mode == "--tui":
        _launch_tui(log_path)
        return

    print(f"Unknown flag: {mode}")
    print(USAGE)
    sys.exit(1)


def _launch_tui(path: str):
    """Launch the OpenTUI viewer (bun). Accepts a single run's .jsonl or a
    session's state.json — the viewer picks session vs single-run by the path."""
    if shutil.which("bun") is None:
        if os.name == "nt":
            msg = (
                "Error: bun is required for the TUI log viewer but was not found on PATH.\n"
                "Install it with:\n"
                "  powershell -c \"irm bun.sh/install.ps1 | iex\"\n"
                "  or: npm install -g bun"
            )
        else:
            msg = (
                "Error: bun is required for the TUI log viewer but was not found on PATH.\n"
                "Install it with: curl -fsSL https://bun.sh/install | bash"
            )
        print(msg, file=sys.stderr)
        sys.exit(1)

    engine_dir = _find_engine_dir()
    tui_dir = engine_dir / "tui_log_viewer"

    if not (tui_dir / "node_modules").exists():
        print("Installing log viewer dependencies...")
        subprocess.run(["bun", "install"], cwd=str(tui_dir), check=True)

    cmd = ["bun", "run", "src/index.tsx", path]
    sys.exit(subprocess.run(cmd, cwd=str(tui_dir)).returncode)
