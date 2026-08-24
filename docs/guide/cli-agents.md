# CLI Agents

fast-rlm can drive a coding agent through its **own non-interactive mode** —
`claude -p`, `codex exec`, `opencode run` — as the model behind a run.

This is the recommended way to use Claude Code, Codex, or opencode with
fast-rlm. The [ACP route](acp-agents.md) still works and is still supported.

## Why this exists

The ACP route puts three independently-versioned pieces between fast-rlm and the
agent: a pinned ACP provider, a third-party bridge package, and the ACP protocol
itself. Each can lag behind a CLI that ships almost daily, and fast-rlm then has
to cut a release before you can catch up.

The direct route has nothing in between:

```
fast-rlm  ->  claude -p            (or: codex exec / opencode run)
```

Those `--json` modes are maintained by the same teams that ship the agents, so
there is no bridge to fall out of date. Concretely, compared to `acp:`:

| | `acp:` | `cli:` |
| --- | --- | --- |
| Install step | `fast-rlm acp install` | none |
| Needs Node/npx | yes (bridge packages) | no |
| Startup | downloads/launches a bridge | spawns the agent directly |
| Token & cost budgets | inert (no usage reported) | **work normally** |
| Subprocess permission | blanket `--allow-run` | scoped to the named binaries |

## Quick start

Nothing to install — you only need the agent's own CLI, already logged in.

```yaml
primary_agent: "cli:claude-code?model=claude-sonnet-5"
sub_agent:     "cli:codex?model=gpt-5.5-codex"
```

A model is **required** for every `cli:` agent — see [Choosing a model](#choosing-a-model--required).

```python
from fast_rlm import run, RLMConfig

run("What is 2+2?", config=RLMConfig(primary_agent="cli:opencode?model=anthropic/claude-sonnet-5"))
```

```bash
fast-rlm "Summarize this" --input-file notes.md --primary-agent "cli:claude-code?model=sonnet"
```

### Built-in presets

| `cli:` name       | Launches                                          | Isolation |
| ----------------- | ------------------------------------------------- | --------- |
| `cli:claude-code` | `claude -p --output-format json`                  | `--disallowedTools` + temp cwd |
| `cli:codex`       | `codex exec --json --sandbox read-only`           | read-only sandbox + temp cwd |
| `cli:opencode`    | `opencode run --format json --pure`               | temp cwd |

**Prerequisites:** the agent's CLI installed and authenticated in its own right
(`claude` — subscription login or `ANTHROPIC_API_KEY`; `codex login`;
`opencode auth login`). No Node, no npx, no fast-rlm install step.

## How it works

Identical in shape to every other backend:

1. fast-rlm sends the agent its system prompt and the message history, flattened
   into a single prompt on **stdin**.
2. The agent replies with a ` ```repl ` block.
3. fast-rlm executes that block in **its own Pyodide sandbox** and feeds the
   output back on the next turn.

The agent never executes the code and never writes files — fast-rlm does.

Two details that matter:

- **The system prompt is replaced, not appended.** For Claude Code,
  `--system-prompt` swaps out its coding-agent prompt entirely rather than
  stacking fast-rlm's on top. Appending would leave the whole agent harness
  prompt and its tool definitions in context — and fast-rlm would then have to
  argue the model out of using tools it can still see.
- **The prompt goes on stdin, never as an argument.** `--disallowedTools` is
  variadic and silently swallows a trailing positional prompt; stdin also avoids
  argv size limits, which RLM prompts routinely exceed.

Agents with no system-prompt flag (codex, opencode) get fast-rlm's system prompt
prepended to the prompt text instead.

## Choosing a model — required

**Every CLI agent must state its model.** A run that omits one fails before
anything is spawned:

```
'cli:claude-code' does not specify a model, and fast-rlm does not pick one for you.
```

This is deliberate. Left unset, the model is whatever that vendor's CLI happens
to default to: it changes between releases, it appears nowhere in your run's
config, and for Claude Code it is **Opus** — the most expensive option, at
roughly $0.17/step. An unstated model is a silent cost and a silent
reproducibility hole, so fast-rlm refuses to guess.

`?model=` is passed straight through to the CLI's own flag. Aliases and exact
ids both work — whatever that CLI accepts:

```yaml
primary_agent: "cli:claude-code?model=sonnet"            # alias — always latest Sonnet
primary_agent: "cli:claude-code?model=claude-sonnet-5"   # exact id — pinned (preferred)
primary_agent: "cli:claude-code?model=opus"
primary_agent: "cli:codex?model=gpt-5.5-codex"
primary_agent: "cli:opencode?model=anthropic/claude-sonnet-5"   # provider/model
```

| agent | flag | accepts |
| --- | --- | --- |
| `cli:claude-code` | `--model` | alias (`sonnet`, `opus`, `fable`) or full id (`claude-sonnet-5`) |
| `cli:codex` | `-m` | model id (`gpt-5.5-codex`) |
| `cli:opencode` | `-m` | `provider/model` |

To set a default for a project rather than per call, re-declare the preset:

```yaml
cli_agents:
  claude-code:
    command: claude
    args: ["-p", "--output-format", "json", "--strict-mcp-config",
           "--disallowedTools", "Bash Read Write Edit MultiEdit WebFetch WebSearch Task Glob Grep NotebookEdit"]
    model_flag: "--model"
    model: "claude-sonnet-5"        # exact id instead of the alias
    system_prompt_flag: "--system-prompt"
    extract: { kind: json, path: result }
```

!!! tip "Alias or exact id?"
    An **alias** (`sonnet`) follows the latest release of that model — convenient,
    but what runs underneath can change without you noticing. An **exact id**
    (`claude-sonnet-5`) pins it, at the cost of eventually being retired.

    For benchmarks or anything you need to reproduce months later, pin the exact
    id and record it alongside the results.

## Budgets and cost

!!! danger "`cli:claude-code` refuses to run while `ANTHROPIC_API_KEY` is set"
    `claude` silently prefers that key over your Pro/Max login, so a run you
    believe is using your plan is **billed per token instead** — with no error
    and no warning fast-rlm can surface. Rather than let that happen quietly,
    the run fails immediately, before any process is spawned:

    ```
    'cli:claude-code' refuses to run while ANTHROPIC_API_KEY is set.

      Use your subscription:  unset ANTHROPIC_API_KEY
      Or accept API billing:  RLMConfig(cli_allow_api_key=True), or --cli-allow-api-key
      cli_minimal implies it: that mode cannot read a subscription login.
    ```

    Set `cli_allow_api_key: true` if you genuinely want metered billing — for
    instance if you have no Claude subscription at all. `cli_minimal` implies
    it, since `--bare` cannot read a subscription login.

    Custom agents can declare the same protection with `forbid_env`.

!!! note "No model is chosen for you"
    Claude Code's own default is **Opus**, which at ~25k prompt tokens per step
    costs around $0.17 — far more than an RLM step needs. The preset therefore
    so fast-rlm requires you to name one rather than inheriting that default.
    Sonnet passes the full verification suite at roughly a fifth the cost per
    token:

    ```yaml
    primary_agent: "cli:claude-code?model=claude-sonnet-5"
    ```

Unlike ACP, these CLIs report token usage — so `max_money_spent`,
`max_completion_tokens`, and `max_prompt_tokens` all work.

Claude splits prompt tokens across uncached, cache-read, and cache-creation
fields; fast-rlm sums them, so `prompt_tokens` means the same thing here as on
every other backend.

!!! note "Cost under subscription auth"
    Claude Code reports `total_cost_usd` even when you are logged in with a
    subscription rather than an API key. That figure is **API-equivalent cost,
    not money billed to you**. It remains a useful `max_money_spent` guardrail;
    just don't read it as a bill. Codex reports no cost at all (tokens only).

## `cli_minimal` — cheaper steps, API key required

Claude Code's `--bare` skips hooks, `CLAUDE.md` discovery, plugins, LSP and
auto-memory. Measured on a real fast-rlm step:

| | prompt tokens/step | cost/step |
| --- | --- | --- |
| default | 25,680 | $0.161 |
| `cli_minimal: true` | **8,465** | **$0.055** |

The ~17k difference is Claude Code harness context that an RLM run has no use
for. Multiply by dozens of steps and recursive sub-agents and it is substantial.

The catch: **`--bare` never reads OAuth or the keychain**, so it only works with
`ANTHROPIC_API_KEY` set. That is why it is off by default — subscription logins
must keep working. Enabling it without a key fails immediately, saying so.

```yaml
primary_agent: "cli:claude-code?model=claude-sonnet-5"
cli_minimal: true          # requires ANTHROPIC_API_KEY
```

```bash
fast-rlm "..." --primary-agent "cli:claude-code?model=sonnet" --cli-minimal
```

## Registering your own agent

Any agent with a JSON-emitting non-interactive mode works — no code changes.
Register it under `cli_agents` and select it by name. **A registered name
overrides a built-in preset**, which is how you repair a preset locally if a CLI
changes a flag, rather than waiting for a fast-rlm release.

```yaml
primary_agent: "cli:myagent?model=some-model"   # or set `model:` below
cli_agents:
  myagent:
    command: myagent
    args: ["run", "--json"]
    model_flag: "-m"          # declaring this makes a model required
    system_prompt_flag: "--system"     # omit to inline the system prompt
    prompt_via: stdin                  # or "arg"
    extract:
      kind: json                       # json | jsonl | text
      path: reply
    usage:
      kind: json
      input: usage.prompt_tokens
      output: usage.completion_tokens
```

| Field | Required | Meaning |
| --- | --- | --- |
| `command` | yes | Executable to spawn. |
| `args` | no | Static arguments. |
| `extract` | yes | Where the reply text is — see below. |
| `model_flag` | no | Flag that selects the model. Without it, `?model=` has no effect. |
| `system_prompt_flag` | no | Flag that sets the system prompt. Omitted → prepended to the prompt text. |
| `prompt_via` | no | `stdin` (default) or `arg`. |
| `usage` | no | Where token counts live. Omitted → usage reports zero and token budgets go inert, as with ACP. |
| `error_flag` | no | `{path, message_path?}` for CLIs that exit 0 and signal failure in the payload. |
| `minimal_args` / `minimal_requires_env` | no | Extra flags under `cli_minimal`, and env vars that mode then needs. |
| `forbid_env` | no | Env vars that must **not** be set, because they would silently redirect billing away from the agent's own login. Refused unless `cli_allow_api_key`. |
| `model` | no | Default model id for this agent, overridable per call via `?model=`. Required in one place or the other whenever `model_flag` is set. |
| `env` | no | Extra environment variables for the agent process. |
| `config_files` | no | Relative path → JSON content, written into the temp cwd before launch. |

### `extract`

| `kind` | Shape | Fields |
| --- | --- | --- |
| `json` | Whole stdout is one JSON object | `path` (dotted) |
| `jsonl` | Stdout is JSONL | `match` (dotted path → exact value), `path`, `join` |
| `text` | Raw stdout is the reply | — |

For `jsonl`, the last matching event wins unless `join: true`, which
concatenates every match in order (needed when a reply arrives in several
streamed parts). Lines that are not valid JSON — progress chatter, partial
lines — are skipped rather than treated as fatal.

### `usage`

Same `kind`/`match` selection, plus dotted paths: `input`, `output`, `cached`,
`reasoning`, `cost`. Missing fields report zero. `input` also accepts a **list
of paths, which are summed** — for CLIs like Claude that split prompt tokens
across several fields.

`iterations` handles CLIs that run several model iterations inside one turn and
report usage **summed across them**. Summing is right for billing but wrong for
`prompt_tokens`, which `max_prompt_tokens` reads as "how large did this
context get": the same cached prefix gets counted once per iteration. Observed
on `claude -p`: **563,963** reported input tokens for a context of roughly 15k,
which tripped the 200k per-call budget. With `iterations` set, `prompt_tokens`
is the largest single iteration instead.

## Keeping work in the REPL

The premise of an RLM run is that all computation is observable in the REPL. A
coding agent with its own shell breaks that: it can compute internally and
return a hardcoded answer, which looks identical to REPL work from the outside.

Each preset was tested by planting a canary file in the cwd and asking the agent
to read it and to run a shell command:

| preset | mechanism | canary read | shell ran |
| --- | --- | --- | --- |
| `cli:claude-code` | `--disallowedTools` | no | no |
| `cli:opencode` | injected `opencode.json` denials | no | no |
| `cli:codex` | *(cannot be disabled)* | **yes** | **yes** |

Three things this surfaced, all now handled:

- **`--pure` does not remove opencode's tools** — it only skips external
  plugins. The injected `opencode.json` is what denies them.
- **Denying opencode's `bash`/`read` is not enough**: its `task` tool spawns a
  subagent that does *not* inherit the denials, and the model will delegate
  "read this file for me" to it. `task` and `skill` are denied too.
- **Codex cannot be locked down.** `--sandbox read-only` blocks writes but still
  permits reads and command execution, and `sandbox_permissions=[]` changes
  nothing. There is no flag that removes its shell.

### Detection, where prevention is impossible

Because codex cannot be prevented, its bypasses are **detected**. Presets
declare `native_tool_events` — output-stream signatures meaning the agent used
its own tools — and the run fails with a clear error when one appears:

```
"codex" used its own tools (command_execution) instead of the fast-rlm REPL.
Results computed inside the agent's harness are invisible to the REPL loop and
may be fabricated.
```

Control it with `cli_native_tools`: `"error"` (default), `"warn"`, or `"off"`.
A *blocked* attempt is not a violation — opencode reports a denied call as tool
`invalid`, which means the guard worked.

### Verifying it yourself

`scripts/verify_agents.py` runs a real query whose answers cannot be guessed
(random data plus a canary token buried in the context) and then audits the
run's transcript:

```bash
python scripts/verify_agents.py --all
python scripts/verify_agents.py cli:codex --seed 4242   # reproducible
```

It checks correctness against locally-computed ground truth, that the answer
contains the canary (proving the agent actually read the context it was given),
that the transcript contains steps indexing into `context`, that no answer
appears as a literal in non-computing code, and that no native tool use was
detected. Exit code is non-zero on any failure.

## Safety

- **Isolated cwd.** Every agent runs in a throwaway temp directory, removed
  afterwards, so a stray write lands there rather than in your project. The
  child's `PWD` is set to it as well as its working directory — agents that
  discover project config from `PWD` (opencode does) otherwise read *your*
  project and silently ignore the permission config written for them.
- **Scoped subprocess permission.** The Deno host is granted
  `--allow-run=claude,codex` — only the binaries the run can actually spawn —
  rather than the blanket `--allow-run` that ACP requires for `npx`.
- **Registered agents are launched as written.** fast-rlm adds no sandbox flags
  of its own; put the agent's own read-only flags in `args`.

## Limitations

- **No streaming.** One reply per turn, as with ACP. fast-rlm consumes whole
  turns anyway.
- **Each call is a fresh process.** History is re-sent every step, so there is no
  provider-side cache reuse across steps. Both CLIs support session resume
  (`claude --resume`, `codex exec resume`) — a possible future optimisation.
- **Version drift.** Presets are verified against `claude 2.1.x`,
  `codex-cli 0.149.x`, and current opencode. If a flag changes, override the
  preset under `cli_agents` — you do not need a fast-rlm release.
