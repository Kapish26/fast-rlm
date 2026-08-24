import { parse as parseYaml } from "@std/yaml";

// A user-registered ACP agent ("backdoor"). Built-in presets (claude-code,
// codex, opencode) live in acp.ts; anything else is declared here by command.
export interface AcpAgentSpec {
    // Executable to spawn (e.g. "npx", "opencode", "hermes").
    command: string;
    // Arguments passed to the command (e.g. ["-y", "@acme/foo-acp"]).
    args?: string[];
    // The agent's read-only session mode id, if it has one (e.g. "plan",
    // "read-only"). When set, fast-rlm switches the session into it so the
    // agent cannot edit files. Agents with no modes omit this and are
    // contained only by the isolated cwd.
    readonly_mode?: string;
    // Default model id for the agent (overridable per-call via ?model=...).
    model?: string;
    // ACP auth method id (e.g. "opencode-login", "chatgpt", "claude-login").
    // Only used on the lazy-auth fallback path; pinning it silences the
    // provider's "authMethodId is not configured" warning.
    auth_method?: string;
    // Extra env vars for the agent process.
    env?: Record<string, string>;
    // For built-in presets: the npm package spawned as the ACP bridge. Named
    // here so `fast-rlm acp install` can pin it to an exact version (and follow
    // an upstream rename) purely through the install marker.
    bridge_pkg?: string;
    // Config files to write into the throwaway cwd before the agent launches.
    // Keys are relative paths (e.g. ".claude/settings.json", "opencode.json");
    // values are serialized as JSON. Used to inject per-agent permission configs
    // that strip tool access so the agent acts as a pure text model.
    config_files?: Record<string, unknown>;
}

// How a CLI agent's reply text is located in its output.
export type CliExtractSpec =
    // Whole stdout is one JSON object; the reply is at `path`.
    | { kind: "json"; path: string }
    // Stdout is JSONL; take `path` from events matching every entry in `match`
    // (dotted paths -> exact string). `join` concatenates all matches in order
    // instead of taking the last one.
    | { kind: "jsonl"; match?: Record<string, string>; path: string; join?: boolean }
    // Raw stdout is the reply.
    | { kind: "text" };

// Where token usage lives in the same output. Values are dotted paths; missing
// ones are reported as zero.
export interface CliUsageSpec {
    kind: "json" | "jsonl";
    match?: Record<string, string>;
    // A list is summed. Needed where a CLI splits prompt tokens across fields
    // (Claude reports uncached / cache-read / cache-creation separately) —
    // prompt_tokens must be their sum to match every other backend.
    input: string | string[];
    output: string;
    // Some CLIs run several model iterations inside ONE turn and report usage
    // SUMMED across them. Summing is right for billing but wrong for
    // prompt_tokens, which max_prompt_tokens uses as "how large did this
    // agent's context get": the same cached prefix is counted once per
    // iteration, so a 15k-token context can report 500k+. When `iterations` is
    // set, prompt_tokens becomes the LARGEST single iteration's context.
    //   path:  dotted path to the per-iteration array
    //   input: paths WITHIN one element, summed
    iterations?: { path: string; input: string[] };
    cached?: string;
    reasoning?: string;
    cost?: string;
}

// A CLI-driven coding agent ("cli:<name>"). Built-in presets live in
// cli_agent.ts; this shape is also what `cli_agents` in the user's config
// accepts, so a preset can be repaired or replaced without a fast-rlm release.
export interface CliAgentSpec {
    // Executable to spawn (e.g. "claude", "codex", "opencode").
    command: string;
    // Static arguments, e.g. ["-p", "--output-format", "json"].
    args?: string[];
    // Flag that selects the model (e.g. "--model", "-m"). Omitted -> the agent's
    // own default is used and ?model= has no effect.
    model_flag?: string;
    // Flag that sets the system prompt (e.g. "--system-prompt"). When absent,
    // fast-rlm's system prompt is prepended to the prompt text instead.
    system_prompt_flag?: string;
    // How the prompt reaches the agent. Default "stdin" — required for CLIs
    // with variadic flags that would swallow a trailing positional argument,
    // and for prompts too large for argv.
    prompt_via?: "stdin" | "arg";
    // Where to find the reply, and (optionally) usage.
    extract: CliExtractSpec;
    usage?: CliUsageSpec;
    // Some CLIs exit 0 and signal failure in the payload instead.
    error_flag?: { path: string; message_path?: string };
    // Env vars whose presence makes this agent bill the wrong account, and so
    // must NOT be set. `claude` silently prefers ANTHROPIC_API_KEY over an
    // interactive subscription login, turning a plan-quota run into a metered
    // one with no warning fast-rlm can see. Refused unless cli_allow_api_key.
    forbid_env?: string[];
    // Extra args added only when `minimal` is on, plus any env vars that mode
    // then requires (e.g. claude --bare never reads an interactive login).
    minimal?: boolean;
    minimal_args?: string[];
    minimal_requires_env?: string[];
    // Default model id (overridable per call via "?model=").
    model?: string;
    // Extra environment variables for the agent process.
    env?: Record<string, string>;
    // Files written into the throwaway cwd before launch (relative path -> JSON).
    config_files?: Record<string, unknown>;
    // Output-stream signatures that mean the agent used its OWN tools (shell,
    // file read, web) instead of fast-rlm's REPL. Same dotted-path matching as
    // `extract`. Some CLIs cannot be told to drop their tools (codex has no such
    // flag), so where they cannot be prevented they are at least DETECTED —
    // see cli_forbid_native_tools.
    native_tool_events?: Record<string, string>[];
    // Max wall-clock for one turn, in ms. Defaults to 10 minutes — NOT to
    // `api_timeout_ms`, whose default (30s) is tuned for HTTP API calls and
    // would kill a coding-agent turn that is merely thinking.
    timeout_ms?: number;
    // CLI versions this preset was verified against; shown by diagnostics.
    tested_versions?: string;
}

export interface RlmConfig {
    max_calls_per_subagent?: number;
    max_depth?: number;
    truncate_len?: number;
    primary_agent?: string;
    sub_agent?: string;
    max_money_spent?: number;
    max_completion_tokens?: number;
    max_prompt_tokens?: number;
    // Global cap on the TOTAL number of LLM calls across the whole run (root +
    // all sub-agents, every backend). Once reached, no new calls are allowed and
    // the loop stops. Especially important for ACP agents, where the token/cost
    // budgets are always zero and so never trigger.
    max_global_calls?: number;
    api_max_retries?: number;
    api_timeout_ms?: number;
    // Ablation toggles (default true). When false, the capability is removed at
    // the agent/subagent layer AND stripped from the system prompt.
    enable_tools?: boolean;
    enable_structured_io?: boolean;
    enable_compression_guard?: boolean;
    // Capability inheritance (default false — a sub-agent starts with nothing
    // its parent did not hand it). When true, a sub-agent spawned without an
    // explicit `tools=` / `mcp=` on the llm_query call automatically receives
    // the same Python tools / MCP servers its parent has, and passes them on to
    // its own children. An explicit argument on the call always wins, including
    // an empty list, which means "grant nothing".
    inherit_tools?: boolean;
    inherit_mcp?: boolean;
    compression_min_chars?: number;
    compression_ratio?: number;
    instruction?: string;
    // ACP backdoor: name -> adapter spec. Used to resolve "acp:<name>" model
    // strings for agents that aren't one of the built-in presets.
    acp_agents?: Record<string, AcpAgentSpec>;
    // CLI agents: name -> spec, resolving "cli:<name>". A registered name
    // overrides a built-in preset, which is how a user repairs a preset after
    // an upstream flag change without waiting for a fast-rlm release.
    cli_agents?: Record<string, CliAgentSpec>;
    // Opt into each CLI preset's `minimal_args` (e.g. claude's --bare: far
    // cheaper per step, but it never reads the agent's interactive login and so
    // requires an API key). Off by default: subscription logins keep working.
    cli_minimal?: boolean;
    // What to do when a CLI agent is caught using its own tools instead of the
    // REPL (see native_tool_events). "error" (default) fails the step, because
    // a hidden computation breaks the premise that all work is observable in
    // the REPL; "warn" logs and continues; "off" disables the check.
    cli_native_tools?: "error" | "warn" | "off";
    // Permit running a CLI agent whose `forbid_env` vars are set — i.e. accept
    // metered API billing instead of the agent's own subscription login. Needed
    // by anyone who HAS no subscription, and implied by cli_minimal (whose
    // --bare mode cannot read a subscription login at all).
    cli_allow_api_key?: boolean;
}

export function loadConfig(): RlmConfig {
    try {
        const configIdx = Deno.args.indexOf("--config");
        const configPath = configIdx !== -1 && Deno.args[configIdx + 1]
            ? Deno.args[configIdx + 1]
            : new URL("../rlm_config.yaml", import.meta.url).pathname;
        const raw = Deno.readTextFileSync(configPath);
        return (parseYaml(raw) as RlmConfig) ?? {};
    } catch {
        return {};
    }
}
