// Direct-CLI backend.
//
// Drives a coding agent through its OWN non-interactive mode (`claude -p`,
// `codex exec`, `opencode run`) instead of through the ACP protocol. The agent
// is a drop-in "model": it gets fast-rlm's system prompt plus the message
// history and is expected to reply with a ```repl``` block, which subagents.ts
// executes in Pyodide — the same contract as every other backend.
//
// Selection (mirrors the "acp:" / "vertex/" prefix convention):
//     "cli:<name>"                 -> built-in preset or registered agent
//     "cli:<name>?model=<modelId>" -> same, overriding the agent's model
//
// Why this exists alongside acp.ts: the ACP route stacks a pinned provider, a
// third-party bridge package, and the ACP protocol itself between fast-rlm and
// the agent — three independently-versioned pieces, each able to lag behind a
// CLI that ships almost daily. These CLIs' `--json` modes are maintained by the
// same teams that ship the agents, so there is nothing in between to fall out
// of date. It also needs no npm dependencies and no Node.
//
// Unlike ACP, these CLIs report token usage, so the token/cost budgets that are
// inert for "acp:" models work normally here.
//
// Safety: every agent runs in a throwaway temp cwd (any stray write is
// contained there, not in the user's project) and is launched with its own
// read-only / tool-denying flags — see the presets below.
import { buildSystemPrompt, PromptOptions } from "./prompt.ts";
import { parseConfirmVerdict } from "./confirm.ts";
import { loadConfig, type CliAgentSpec } from "./config.ts";
import type { ApiRetryOptions, CodeReturn, ConfirmResult, Usage } from "./call_llm.ts";

const CLI_PREFIX = "cli:";

// One agent turn can legitimately take minutes: the CLI boots, the model
// thinks, and (for codex/opencode) a whole session spins up. `api_timeout_ms`
// defaults to 30s because it is tuned for HTTP API calls, so applying it here
// would kill healthy turns. A spec can override with `timeout_ms`.
const DEFAULT_CLI_TIMEOUT_MS = 600_000;

export function isCliModel(model: string): boolean {
    return model.startsWith(CLI_PREFIX);
}

// ---- Presets ---------------------------------------------------------------
//
// Every field is plain data, and `cli_agents` in the user's config can override
// any preset by re-declaring its name. That is deliberate: if a CLI renames a
// flag, a user can repair it in their own YAML instead of waiting for a
// fast-rlm release. It is also how any other agent with a JSON-emitting
// non-interactive mode gets supported without code changes.

// Written into the throwaway cwd so opencode picks it up as project config.
// This — not --pure — is what removes its tools.
//
// `task` MUST be denied too: it spawns a SUBAGENT that does not inherit these
// permissions, so with bash/read denied but task allowed the model simply
// delegates "read this file for me" to a subagent that still has the tools.
// Verified — that is exactly what it tried.
const OPENCODE_CONFIG = {
    "opencode.json": {
        permission: {
            bash: "deny",
            read: "deny",
            edit: "deny",
            write: "deny",
            glob: "deny",
            grep: "deny",
            webfetch: "deny",
            task: "deny",
            skill: "deny",
        },
    },
};

const PRESETS: Record<string, CliAgentSpec> = {
    // `claude -p --output-format json` emits ONE JSON object with the reply in
    // `result` and full usage (including a real dollar cost) alongside it.
    //
    // --system-prompt REPLACES Claude Code's own coding-agent prompt rather than
    // appending to it. Appending leaves the whole agent harness prompt and its
    // tool definitions in context — measured at ~33k prompt tokens per step,
    // versus ~18k with a replace — and fast-rlm then has to talk the model out
    // of using tools it can still see. Replacing is both cheaper and clearer.
    //
    // The prompt goes on stdin, NOT as an argument: --disallowedTools is
    // variadic and silently swallows a trailing positional prompt ("Error:
    // Input must be provided either through stdin or as a prompt argument").
    "claude-code": {
        command: "claude",
        args: [
            "-p",
            "--output-format", "json",
            "--strict-mcp-config",
            "--disallowedTools",
            "Bash Read Write Edit MultiEdit WebFetch WebSearch Task Glob Grep NotebookEdit",
        ],
        model_flag: "--model",
        // No default model: presets deliberately do not choose one — see
        // requireModel(). Claude Code's own fallback is Opus, the most
        // expensive option, so an unstated model is a costly accident.
        system_prompt_flag: "--system-prompt",
        prompt_via: "stdin",
        // --bare additionally skips hooks, CLAUDE.md discovery, plugins, LSP and
        // auto-memory (~173 prompt tokens/step instead of ~18k), but it never
        // reads OAuth or the keychain — so it locks the run to an API key and is
        // opt-in via `cli_minimal: true`.
        minimal_args: ["--bare"],
        minimal_requires_env: ["ANTHROPIC_API_KEY"],
        // Refuse to run while an API key is set: `claude` prefers it over the
        // subscription login with no error and no visible warning, so a run
        // that looks like it is using your plan is quietly metered instead.
        forbid_env: ["ANTHROPIC_API_KEY"],
        extract: { kind: "json", path: "result" },
        error_flag: { path: "is_error", message_path: "result" },
        usage: {
            kind: "json",
            // Claude splits prompt tokens three ways; sum them so prompt_tokens
            // means the same thing here as on the OpenAI/Anthropic paths.
            input: [
                "usage.input_tokens",
                "usage.cache_read_input_tokens",
                "usage.cache_creation_input_tokens",
            ],
            output: "usage.output_tokens",
            // `claude -p` sums usage over every internal model iteration, so
            // the top-level numbers over-count a cached prefix once per
            // iteration (observed: 563,963 "input" tokens for a ~15k-token
            // context). Take the biggest single iteration instead.
            iterations: {
                path: "usage.iterations",
                input: [
                    "input_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                ],
            },
            cached: "usage.cache_read_input_tokens",
            // Under subscription auth this is API-equivalent cost, not billed
            // spend. Documented; still a useful max_money_spent guardrail.
            cost: "total_cost_usd",
        },
        tested_versions: "2.1.x",
    },

    // `codex exec --json` streams JSONL: the reply arrives as an
    // `item.completed` event whose item is an `agent_message`, and usage as
    // `turn.completed`. A trailing "-" makes it read the prompt from stdin.
    // Codex exec has no system-prompt flag, so the system prompt is prepended
    // to the prompt text (system_prompt_flag omitted).
    "codex": {
        command: "codex",
        args: [
            "exec",
            "--json",
            "--sandbox", "read-only",
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-user-config",
            "-",
        ],
        model_flag: "-m",
        prompt_via: "stdin",
        extract: {
            kind: "jsonl",
            match: { "type": "item.completed", "item.type": "agent_message" },
            path: "item.text",
        },
        // Codex has NO flag that removes its shell: --sandbox read-only blocks
        // writes but still permits reads and command execution (verified — it
        // read a file in its cwd and ran `python3 -c` under read-only, and
        // `sandbox_permissions=[]` changed nothing). So native tool use is
        // detected from the stream instead of prevented, and the throwaway cwd
        // keeps it from seeing anything of yours.
        native_tool_events: [
            { "type": "item.completed", "item.type": "command_execution" },
            { "type": "item.completed", "item.type": "file_change" },
        ],
        usage: {
            kind: "jsonl",
            match: { "type": "turn.completed" },
            input: "usage.input_tokens",
            output: "usage.output_tokens",
            cached: "usage.cached_input_tokens",
            reasoning: "usage.reasoning_output_tokens",
        },
        tested_versions: "0.149.x",
    },

    // `opencode run --format json` streams JSONL: reply text in `type: "text"`
    // events (part.text), usage in `type: "step_finish"` (part.tokens/part.cost).
    // No system-prompt flag, so it is inlined.
    //
    // --pure only skips external PLUGINS; it does not remove tools. Verified:
    // with --pure alone the agent still read a file in its cwd and ran a shell
    // command. The opencode.json below is what actually denies them.
    "opencode": {
        command: "opencode",
        args: ["run", "--format", "json", "--pure"],
        config_files: OPENCODE_CONFIG,
        // Only real tool executions count. A denied call surfaces as tool
        // "invalid", which means the guard worked — flagging it would turn a
        // successful block into a failed run.
        native_tool_events: [
            { "type": "tool_use", "part.tool": "bash" },
            { "type": "tool_use", "part.tool": "read" },
            { "type": "tool_use", "part.tool": "edit" },
            { "type": "tool_use", "part.tool": "write" },
            { "type": "tool_use", "part.tool": "glob" },
            { "type": "tool_use", "part.tool": "grep" },
            { "type": "tool_use", "part.tool": "webfetch" },
            { "type": "tool_use", "part.tool": "task" },
        ],
        model_flag: "-m",
        prompt_via: "stdin",
        extract: {
            kind: "jsonl",
            match: { "type": "text" },
            path: "part.text",
            // A turn can emit several text parts; concatenate in order so a
            // repl block split across parts still parses.
            join: true,
        },
        usage: {
            kind: "jsonl",
            match: { "type": "step_finish" },
            input: "part.tokens.input",
            output: "part.tokens.output",
            cached: "part.tokens.cache.read",
            reasoning: "part.tokens.reasoning",
            cost: "part.cost",
        },
        tested_versions: "0.x",
    },
};

// Exported for tests: exercises the model requirement without spawning.
export function parseCliModelForTest(model: string) {
    return parseCliModel(model);
}

export function cliPresetNames(): string[] {
    return Object.keys(PRESETS);
}

// Exported for tests: the presets are the contract with each CLI's output.
export function cliPreset(name: string): CliAgentSpec {
    return PRESETS[name];
}

interface ParsedCli {
    spec: CliAgentSpec;
    name: string;
    modelId?: string;
}

// A model must be stated explicitly for every CLI agent that can take one.
//
// Leaving it to the CLI means the model is whatever that vendor currently
// defaults to — it changes under you between releases, it is invisible in the
// run's config, and it is usually the priciest option (Claude Code falls back
// to Opus at roughly $0.17/step). Neither reproducible nor cheap by accident,
// so it is required rather than guessed.
function requireModel(model: string, name: string, spec: CliAgentSpec, modelId?: string): void {
    if (!spec.model_flag) {
        // Nothing to pass it to — accepting ?model= here would silently drop it.
        if (modelId) {
            throw new Error(
                `"${model}" specifies a model, but the "${name}" agent declares no ` +
                `model_flag, so it cannot be passed. Add model_flag to its cli_agents entry.`,
            );
        }
        return;
    }
    if (modelId) return;
    throw new Error(
        `"${model}" does not specify a model, and fast-rlm does not pick one for you.\n\n` +
        `  Left unset, the model is whatever ${spec.command} currently defaults to — it ` +
        `changes between releases, it is invisible in your run config, and for Claude Code ` +
        `it is Opus, the most expensive option.\n\n` +
        `  Per run:      primary_agent: "cli:${name}?model=<id>"\n` +
        `  Per project:  set "model" on the agent's cli_agents entry\n\n` +
        `  Aliases and exact ids both work; pin an exact id for anything you need to ` +
        `reproduce later.`,
    );
}

// "cli:codex?model=gpt-5.5-codex" -> resolved spec + model override.
// Registered agents (config.cli_agents) take precedence over built-in presets,
// so a user can repair or retune a preset without a fast-rlm release.
function parseCliModel(model: string): ParsedCli {
    const rest = model.slice(CLI_PREFIX.length);
    const [name, query] = rest.split("?", 2);
    if (!name) {
        throw new Error(`Invalid CLI model "${model}". Expected "cli:<agent>" (e.g. "cli:codex").`);
    }
    const registry = loadConfig().cli_agents ?? {};
    const spec = registry[name] ?? PRESETS[name];
    if (!spec) {
        const known = [...new Set([...Object.keys(PRESETS), ...Object.keys(registry)])].sort();
        throw new Error(
            `Unknown CLI agent "${name}". Built-in presets: ${cliPresetNames().join(", ")}. ` +
            `Register others via cli_agents in your config. Known: ${known.join(", ") || "(none)"}.`,
        );
    }
    let modelOverride: string | undefined;
    if (query) {
        modelOverride = new URLSearchParams(query).get("model") ?? undefined;
    }
    const modelId = modelOverride ?? spec.model;
    requireModel(model, name, spec, modelId);
    return { spec, name, modelId };
}

// ---- JSON plumbing ---------------------------------------------------------

// Dotted path lookup ("usage.input_tokens", "part.tokens.cache.read").
export function dig(obj: unknown, path: string): unknown {
    let cur: unknown = obj;
    for (const key of path.split(".")) {
        if (cur == null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[key];
    }
    return cur;
}

function matches(obj: unknown, match: Record<string, string>): boolean {
    return Object.entries(match).every(([path, want]) => dig(obj, path) === want);
}

function parseJsonl(stdout: string): unknown[] {
    const out: unknown[] = [];
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) continue;
        try {
            out.push(JSON.parse(trimmed));
        } catch { /* progress chatter / partial line — skip */ }
    }
    return out;
}

// Some CLIs print warnings before the JSON body, so don't assume stdout parses
// whole; fall back to the last complete top-level JSON object in the stream.
function parseSingleJson(stdout: string): unknown {
    const trimmed = stdout.trim();
    try {
        return JSON.parse(trimmed);
    } catch { /* fall through */ }
    const lines = parseJsonl(trimmed);
    if (lines.length) return lines[lines.length - 1];
    throw new Error(
        `Could not parse the agent's JSON output. First 400 chars:\n${trimmed.slice(0, 400)}`,
    );
}

function toNumber(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function emptyUsage(): Usage {
    return {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        cost: undefined,
    };
}

function extractUsage(spec: CliAgentSpec, docs: unknown[]): Usage {
    const usage = emptyUsage();
    const u = spec.usage;
    if (!u) return usage;
    // For jsonl, the LAST matching event wins (usage events are cumulative per
    // turn); for a single JSON body there is only one document anyway.
    let source: unknown;
    for (const doc of docs) {
        if (u.match && !matches(doc, u.match)) continue;
        source = doc;
    }
    if (source === undefined) return usage;

    const inputPaths = Array.isArray(u.input) ? u.input : [u.input];
    const summed = inputPaths.reduce((sum, p) => sum + toNumber(dig(source, p)), 0);
    // Prefer the largest single iteration's context over the cross-iteration
    // sum — see CliUsageSpec.iterations. Falls back to the sum when the CLI
    // reports no iteration breakdown.
    let contextTokens = summed;
    if (u.iterations) {
        const arr = dig(source, u.iterations.path);
        if (Array.isArray(arr) && arr.length) {
            contextTokens = Math.max(
                ...arr.map((it) =>
                    u.iterations!.input.reduce((sum, p) => sum + toNumber(dig(it, p)), 0)
                ),
            );
        }
    }
    usage.prompt_tokens = contextTokens;
    usage.completion_tokens = toNumber(dig(source, u.output));
    usage.cached_tokens = u.cached ? toNumber(dig(source, u.cached)) : 0;
    usage.reasoning_tokens = u.reasoning ? toNumber(dig(source, u.reasoning)) : 0;
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    if (u.cost) {
        const cost = dig(source, u.cost);
        if (typeof cost === "number" && Number.isFinite(cost)) usage.cost = cost;
    }
    return usage;
}

// Events proving the agent used its own tools rather than fast-rlm's REPL.
// Returns a short human-readable list of what it used (empty when clean).
export function detectNativeToolUse(spec: CliAgentSpec, docs: unknown[]): string[] {
    const patterns = spec.native_tool_events;
    if (!patterns?.length) return [];
    const hits: string[] = [];
    for (const doc of docs) {
        if (!patterns.some((p) => matches(doc, p))) continue;
        // Label the hit with whatever the stream calls it, for the error text.
        const label = dig(doc, "item.type") ?? dig(doc, "part.tool") ?? dig(doc, "type");
        hits.push(String(label ?? "tool"));
    }
    return hits;
}

// The agent's reply text plus its usage, per the spec's extract/usage rules.
export function extractReply(
    spec: CliAgentSpec,
    stdout: string,
): { text: string; usage: Usage; nativeTools: string[] } {
    const ex = spec.extract;
    if (ex.kind === "text") {
        return { text: stdout, usage: extractUsage(spec, []), nativeTools: [] };
    }
    if (ex.kind === "json") {
        const doc = parseSingleJson(stdout);
        if (spec.error_flag && dig(doc, spec.error_flag.path) === true) {
            const detail = spec.error_flag.message_path
                ? dig(doc, spec.error_flag.message_path)
                : undefined;
            throw new Error(
                `${spec.command} reported an error: ${detail ? String(detail) : "(no detail)"}`,
            );
        }
        const value = dig(doc, ex.path);
        return {
            text: typeof value === "string" ? value : "",
            usage: extractUsage(spec, [doc]),
            nativeTools: detectNativeToolUse(spec, [doc]),
        };
    }
    // jsonl
    const docs = parseJsonl(stdout);
    const hits: string[] = [];
    for (const doc of docs) {
        if (ex.match && !matches(doc, ex.match)) continue;
        const value = dig(doc, ex.path);
        if (typeof value === "string") hits.push(value);
    }
    const text = ex.join ? hits.join("") : (hits.length ? hits[hits.length - 1] : "");
    return {
        text,
        usage: extractUsage(spec, docs),
        nativeTools: detectNativeToolUse(spec, docs),
    };
}

// ---- Prompt assembly -------------------------------------------------------

// These CLIs take a single prompt string, not a message array, so the history is
// flattened into a transcript. Roles are labelled so the model can tell its own
// prior turns from REPL output.
// deno-lint-ignore no-explicit-any
export function flattenMessages(messages: any[]): string {
    return messages
        .filter((m) => m && m.role !== "system")
        .map((m) => {
            const content = typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content ?? "");
            const label = m.role === "assistant" ? "ASSISTANT" : "USER";
            return `### ${label}\n${content}`;
        })
        .join("\n\n");
}

// Reinforces that the agent must work only through fast-rlm's REPL. Shorter than
// the ACP addendum: with --system-prompt the agent's own harness prompt and tool
// definitions are gone, so there is much less to argue against. Agents without a
// system-prompt flag get the full system prompt inlined here too.
const CLI_SYSTEM_ADDENDUM = `

** Execution constraints **
You are a backend model inside the fast-rlm Recursive Language Model framework. Interact with the environment ONLY through the Python REPL described above — the \`context\` variable, \`llm_query\`, \`batch_llm_query\`, \`FINAL\`, and any tools explicitly given to you.

Do NOT use any native tool your own agent harness provides (bash, file reads or writes, web search, web fetch, or any other tool). Every computation and data access must flow through the REPL, where it is observable. Reaching for your own tools invalidates the run.

Reply with exactly one \`\`\`repl code block. If you cannot do something within the REPL, say so — do not work around it with external tools.`;

// ---- Process execution -----------------------------------------------------

export function buildArgs(spec: CliAgentSpec, modelId: string | undefined, minimal: boolean): string[] {
    const args = [...(spec.args ?? [])];
    if (minimal && spec.minimal_args) args.push(...spec.minimal_args);
    if (modelId && spec.model_flag) args.push(spec.model_flag, modelId);
    return args;
}

// Where the prompt goes relative to the spec's own args. "arg" appends it last;
// specs whose CLI needs a positional placeholder (codex's "-") put it in `args`.
function placePrompt(
    spec: CliAgentSpec,
    args: string[],
    system: string | null,
    prompt: string,
): { args: string[]; stdin: string | null } {
    const finalArgs = [...args];
    if (system !== null && spec.system_prompt_flag) {
        finalArgs.push(spec.system_prompt_flag, system);
    }
    if ((spec.prompt_via ?? "stdin") === "arg") {
        finalArgs.push(prompt);
        return { args: finalArgs, stdin: null };
    }
    return { args: finalArgs, stdin: prompt };
}

async function cliComplete(
    // deno-lint-ignore no-explicit-any
    messages: any[],
    model_name: string,
    is_leaf_agent: boolean,
    // Accepted for signature parity with the other backends; the HTTP-tuned
    // timeout it carries is deliberately not applied (see DEFAULT_CLI_TIMEOUT_MS).
    _options: ApiRetryOptions | undefined,
    promptOpts: PromptOptions | undefined,
): Promise<{ text: string; usage: Usage }> {
    const { spec, modelId } = parseCliModel(model_name);
    // Per-spec `minimal` wins; otherwise the run-wide `cli_minimal` toggle.
    const minimal = spec.minimal ?? (loadConfig().cli_minimal === true);

    // Auth guard. Skipped when `minimal` is on — that mode genuinely requires
    // the key (checked just below), so the two rules cannot both apply.
    if (!minimal && spec.forbid_env?.length && !loadConfig().cli_allow_api_key) {
        const present = spec.forbid_env.filter((k) => Deno.env.get(k));
        if (present.length) {
            throw new Error(
                `"${model_name}" refuses to run while ${present.join(", ")} is set.\n\n` +
                `  ${spec.command} silently prefers that key over your subscription login, ` +
                `so this run would be billed per token instead of using your plan — with no ` +
                `warning.\n\n` +
                `  Use your subscription:   unset ${present.join(" ")}\n` +
                `  Or accept API billing:   cli_allow_api_key: true   (RLMConfig / --cli-allow-api-key)\n` +
                `  cli_minimal implies it:  that mode cannot read a subscription login.`,
            );
        }
    }

    if (minimal && spec.minimal_requires_env) {
        const missing = spec.minimal_requires_env.filter((k) => !Deno.env.get(k));
        if (missing.length) {
            throw new Error(
                `cli_minimal is enabled for "${model_name}", which adds ` +
                `${(spec.minimal_args ?? []).join(" ")} — that mode never reads the ` +
                `agent's interactive login, so it requires ${missing.join(", ")} to be ` +
                `set. Either export the key or turn cli_minimal off (subscription ` +
                `login works without it).`,
            );
        }
    }

    const systemPrompt = buildSystemPrompt(is_leaf_agent, promptOpts ?? {}) + CLI_SYSTEM_ADDENDUM;
    const transcript = flattenMessages(messages);
    // Agents with no system-prompt flag get it prepended to the prompt instead.
    const inlineSystem = !spec.system_prompt_flag;
    const promptText = inlineSystem ? `${systemPrompt}\n\n${transcript}` : transcript;

    const baseArgs = buildArgs(spec, modelId, minimal);
    const { args, stdin } = placePrompt(
        spec,
        baseArgs,
        inlineSystem ? null : systemPrompt,
        promptText,
    );

    const cwd = await Deno.makeTempDir({ prefix: "fast_rlm_cli_" });
    if (spec.config_files) {
        for (const [relPath, content] of Object.entries(spec.config_files)) {
            const abs = `${cwd}/${relPath}`;
            await Deno.mkdir(abs.substring(0, abs.lastIndexOf("/")), { recursive: true });
            await Deno.writeTextFile(abs, JSON.stringify(content, null, 2));
        }
    }

    const timeoutMs = spec.timeout_ms ?? DEFAULT_CLI_TIMEOUT_MS;
    try {
        return await runAgent(spec, args, stdin, cwd, timeoutMs);
    } finally {
        try {
            await Deno.remove(cwd, { recursive: true });
        } catch { /* ignore */ }
    }
}

// A CLI agent that computes in its own shell and returns a hardcoded answer
// looks identical to one that used the REPL — except in its event stream. Where
// a CLI exposes that (codex, opencode) we act on it, because a hidden
// computation defeats the whole point of the REPL loop.
function enforceNativeToolPolicy(spec: CliAgentSpec, nativeTools: string[]): void {
    if (!nativeTools.length) return;
    const policy = loadConfig().cli_native_tools ?? "error";
    if (policy === "off") return;
    const summary = [...new Set(nativeTools)].join(", ");
    const message =
        `"${spec.command}" used its own tools (${summary}) instead of the fast-rlm REPL. ` +
        `Results computed inside the agent's harness are invisible to the REPL loop and ` +
        `may be fabricated. Set cli_native_tools: "warn" to allow this, or "off" to stop checking.`;
    if (policy === "warn") {
        console.error(`⚠ ${message}`);
        return;
    }
    throw new Error(message);
}

async function runAgent(
    spec: CliAgentSpec,
    args: string[],
    stdin: string | null,
    cwd: string,
    timeoutMs: number,
): Promise<{ text: string; usage: Usage }> {
    const command = new Deno.Command(spec.command, {
        args,
        cwd,
        // PWD must be overridden, not just `cwd`. Deno sets the child's working
        // directory but leaves the inherited PWD pointing at the PARENT's, and
        // agents that discover project config from PWD (opencode does) then read
        // the user's project instead of the throwaway dir — silently ignoring the
        // permission config written there. Verified: with a stale PWD, opencode
        // ran shell commands despite an opencode.json denying bash; with PWD set
        // to the temp cwd, the same config is honoured.
        env: { ...Deno.env.toObject(), ...(spec.env ?? {}), PWD: cwd },
        stdin: stdin === null ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
    });

    // The constructor does not touch the filesystem — spawn() is what fails when
    // the binary is missing, and its bare "entity not found" says nothing about
    // which binary or how to fix it.
    let child: Deno.ChildProcess;
    try {
        child = command.spawn();
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (error instanceof Deno.errors.NotFound) {
            throw new Error(
                `Could not launch "${spec.command}": not found on PATH. Install the ` +
                `agent's CLI, or point the spec at its full path via cli_agents.`,
            );
        }
        throw new Error(`Could not launch "${spec.command}": ${msg}`);
    }

    // Kill the process on timeout rather than leaving it attached — an
    // abandoned agent would otherwise keep running (and keep spending).
    let timer: number | undefined;
    let timedOut = false;
    if (timeoutMs > 0) {
        timer = setTimeout(() => {
            timedOut = true;
            try {
                child.kill("SIGTERM");
            } catch { /* already gone */ }
        }, timeoutMs);
    }

    try {
        if (stdin !== null) {
            const writer = child.stdin.getWriter();
            try {
                await writer.write(new TextEncoder().encode(stdin));
            } finally {
                // Close before awaiting output: these CLIs read stdin to EOF and
                // will not respond until it closes. Skipping this deadlocks.
                await writer.close().catch(() => {});
            }
        }
        const { code, stdout, stderr } = await child.output();
        const out = new TextDecoder().decode(stdout);
        const err = new TextDecoder().decode(stderr).trim();

        if (timedOut) {
            throw new Error(
                `"${spec.command}" timed out after ${timeoutMs}ms and was killed. ` +
                `Raise it with timeout_ms on the agent's cli_agents entry.`,
            );
        }
        if (code !== 0) {
            throw new Error(
                `"${spec.command}" exited with code ${code}.` +
                (err ? `\nstderr:\n${err.slice(0, 2000)}` : "") +
                (out.trim() ? `\nstdout:\n${out.trim().slice(0, 1000)}` : ""),
            );
        }
        const result = extractReply(spec, out);
        enforceNativeToolPolicy(spec, result.nativeTools);
        return result;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

// ---- Backend entry points --------------------------------------------------

function extractReplCode(content: string): string {
    const matches = [...content.matchAll(/```repl([\s\S]*?)```/g)];
    return matches.map((m) => m[1].trim()).join("\n");
}

// Drop-in for generate_code when model_name is a "cli:" agent.
export async function generateCliCode(
    // deno-lint-ignore no-explicit-any
    messages: any[],
    model_name: string,
    is_leaf_agent = false,
    options?: ApiRetryOptions,
    promptOpts?: PromptOptions,
    _llmKwargs?: Record<string, unknown> | null,
): Promise<CodeReturn> {
    const { text, usage } = await cliComplete(messages, model_name, is_leaf_agent, options, promptOpts);
    const code = extractReplCode(text);
    const message = { role: "assistant", content: text };
    if (!code) {
        return { code: "", success: false, message, usage };
    }
    return { code, success: true, message, usage };
}

// Drop-in for confirmDelegation (compression guard) when model_name is "cli:".
export async function confirmCliDelegation(
    // deno-lint-ignore no-explicit-any
    baseMessages: any[],
    confirmQuestion: string,
    model_name: string,
    is_leaf_agent: boolean,
    options?: ApiRetryOptions,
    promptOpts?: PromptOptions,
    _llmKwargs?: Record<string, unknown> | null,
): Promise<ConfirmResult> {
    const messages = [...baseMessages, { role: "user", content: confirmQuestion }];
    const { text, usage } = await cliComplete(messages, model_name, is_leaf_agent, options, promptOpts);
    // Fail-open: only an explicit "NO" as the whole first word rejects.
    return { ...parseConfirmVerdict(text), usage };
}

// Binaries a run will spawn, so the Python launcher can scope --allow-run to
// exactly those instead of granting blanket subprocess permission.
export function cliCommandFor(model_name: string): string | null {
    try {
        return parseCliModel(model_name).spec.command;
    } catch {
        return null;
    }
}
