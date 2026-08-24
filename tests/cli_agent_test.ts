// Unit tests for the direct-CLI backend's parsing layer (src/cli_agent.ts).
//
// Every payload below is REAL output captured from the CLIs (claude 2.1.241,
// codex-cli 0.149.1, opencode) — these tests are the contract with each CLI's
// JSON shape, so if an upstream change breaks extraction, this fails first.
// No process is spawned and no network is used.
//
// Run:  deno test tests/cli_agent_test.ts
import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import {
    buildArgs,
    cliPreset,
    cliPresetNames,
    dig,
    extractReply,
    flattenMessages,
    isCliModel,
} from "../src/cli_agent.ts";

// --- Real captured payloads --------------------------------------------------

const CLAUDE_JSON = JSON.stringify({
    is_error: false,
    session_id: "1ba321d8",
    total_cost_usd: 0.000456,
    usage: {
        input_tokens: 173,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 11,
    },
    result: "```repl\n2+2\n```",
    type: "result",
});

const CODEX_JSONL = [
    `{"type":"thread.started","thread_id":"01a0339e"}`,
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"\`\`\`repl\\nprint(2+2)\\n\`\`\`"}}`,
    `{"type":"turn.completed","usage":{"input_tokens":15923,"cached_input_tokens":9984,"cache_write_input_tokens":0,"output_tokens":15,"reasoning_output_tokens":0}}`,
].join("\n");

const OPENCODE_JSONL = [
    `{"type":"step_start","part":{"type":"step-start"}}`,
    `{"type":"text","part":{"type":"text","text":"\`\`\`repl\\nprint(2+2)\\n\`\`\`"}}`,
    `{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":10161,"input":10084,"output":14,"reasoning":63,"cache":{"write":0,"read":7}},"cost":0.00143332}}`,
].join("\n");

// --- dig ---------------------------------------------------------------------

Deno.test("dig: walks dotted paths and tolerates gaps", () => {
    const obj = { a: { b: { c: 7 } }, n: null };
    assertEquals(dig(obj, "a.b.c"), 7);
    assertEquals(dig(obj, "a.b"), { c: 7 });
    assertEquals(dig(obj, "a.missing.c"), undefined);
    assertEquals(dig(obj, "n.anything"), undefined);
    assertEquals(dig(undefined, "a"), undefined);
});

// --- claude: single JSON object ----------------------------------------------

Deno.test("claude: extracts the reply and sums split prompt tokens", () => {
    const { text, usage } = extractReply(cliPreset("claude-code"), CLAUDE_JSON);
    assertEquals(text, "```repl\n2+2\n```");
    assertEquals(usage.prompt_tokens, 173);
    assertEquals(usage.completion_tokens, 11);
    assertEquals(usage.cost, 0.000456);
});

Deno.test("claude: prompt_tokens includes cache creation and cache reads", () => {
    // The non---bare path reports ~2 uncached input tokens and tens of thousands
    // of cache-creation tokens. Counting only input_tokens under-reports the
    // real context by ~4 orders of magnitude and would neuter max_prompt_tokens.
    const payload = JSON.stringify({
        is_error: false,
        result: "```repl\n1\n```",
        total_cost_usd: 0.0836,
        usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 33323,
            cache_read_input_tokens: 100,
            output_tokens: 30,
        },
    });
    const { usage } = extractReply(cliPreset("claude-code"), payload);
    assertEquals(usage.prompt_tokens, 2 + 33323 + 100);
    assertEquals(usage.cached_tokens, 100);
    assertEquals(usage.total_tokens, 2 + 33323 + 100 + 30);
});

Deno.test("claude: an is_error payload raises instead of returning empty text", () => {
    // `claude -p` exits 0 on some failures and signals them in the body; without
    // error_flag this would surface as a confusing "no repl block" retry loop.
    const payload = JSON.stringify({
        is_error: true,
        result: "Credit balance is too low",
        usage: { input_tokens: 0, output_tokens: 0 },
    });
    assertThrows(
        () => extractReply(cliPreset("claude-code"), payload),
        Error,
        "Credit balance is too low",
    );
});

Deno.test("claude: tolerates a warning line printed before the JSON body", () => {
    const noisy = "⚠ claude.ai connectors are disabled because ...\n" + CLAUDE_JSON;
    const { text } = extractReply(cliPreset("claude-code"), noisy);
    assertEquals(text, "```repl\n2+2\n```");
});

// --- codex: JSONL ------------------------------------------------------------

Deno.test("codex: picks the agent_message event and turn.completed usage", () => {
    const { text, usage } = extractReply(cliPreset("codex"), CODEX_JSONL);
    assertEquals(text, "```repl\nprint(2+2)\n```");
    assertEquals(usage.prompt_tokens, 15923);
    assertEquals(usage.completion_tokens, 15);
    assertEquals(usage.cached_tokens, 9984);
    assertEquals(usage.cost, undefined); // codex reports no cost
});

Deno.test("codex: a nested match key does not confuse other item.completed events", () => {
    // Only item.type == agent_message is the reply; reasoning/command events
    // share the item.completed envelope.
    const withNoise = [
        `{"type":"item.completed","item":{"type":"reasoning","text":"thinking..."}}`,
        CODEX_JSONL,
    ].join("\n");
    assertEquals(extractReply(cliPreset("codex"), withNoise).text, "```repl\nprint(2+2)\n```");
});

// --- opencode: JSONL with joined text parts ----------------------------------

Deno.test("opencode: joins text parts and reads nested token paths", () => {
    const { text, usage } = extractReply(cliPreset("opencode"), OPENCODE_JSONL);
    assertEquals(text, "```repl\nprint(2+2)\n```");
    assertEquals(usage.prompt_tokens, 10084);
    assertEquals(usage.completion_tokens, 14);
    assertEquals(usage.cached_tokens, 7); // part.tokens.cache.read
    assertEquals(usage.reasoning_tokens, 63);
    assertEquals(usage.cost, 0.00143332);
});

Deno.test("opencode: a reply split across text parts is concatenated in order", () => {
    const split = [
        `{"type":"text","part":{"text":"\`\`\`repl\\nprint("}}`,
        `{"type":"text","part":{"text":"2+2)\\n\`\`\`"}}`,
    ].join("\n");
    assertEquals(extractReply(cliPreset("opencode"), split).text, "```repl\nprint(2+2)\n```");
});

// --- generic behaviour -------------------------------------------------------

Deno.test("malformed and partial JSONL lines are skipped, not fatal", () => {
    const messy = [
        "Reading additional input from stdin...",
        `{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}`,
        `{"type":"turn.completed","usage":{`, // truncated line
    ].join("\n");
    const { text } = extractReply(cliPreset("codex"), messy);
    assertEquals(text, "ok");
});

Deno.test("unparseable output raises with a preview of what came back", () => {
    assertThrows(
        () => extractReply(cliPreset("claude-code"), "command not found: claude"),
        Error,
        "Could not parse",
    );
});

Deno.test("missing usage fields report zero rather than NaN", () => {
    const { usage } = extractReply(
        cliPreset("claude-code"),
        JSON.stringify({ is_error: false, result: "hi" }),
    );
    assertEquals(usage.prompt_tokens, 0);
    assertEquals(usage.completion_tokens, 0);
    assertEquals(usage.total_tokens, 0);
    assertEquals(usage.cost, undefined);
});

// --- argument assembly -------------------------------------------------------

Deno.test("buildArgs: model flag is appended only when the spec declares one", () => {
    const claude = buildArgs(cliPreset("claude-code"), "sonnet", false);
    assertEquals(claude.slice(-2), ["--model", "sonnet"]);
    assertEquals(buildArgs(cliPreset("claude-code"), undefined, false).includes("--model"), false);
});

Deno.test("buildArgs: minimal flags are opt-in", () => {
    assertEquals(buildArgs(cliPreset("claude-code"), undefined, false).includes("--bare"), false);
    assertEquals(buildArgs(cliPreset("claude-code"), undefined, true).includes("--bare"), true);
});

Deno.test("codex keeps its stdin placeholder ahead of appended flags", () => {
    // `-` tells codex exec to read the prompt from stdin; it is part of the
    // preset args, so appending --model after it must not displace it.
    const args = buildArgs(cliPreset("codex"), "gpt-5.5-codex", false);
    assertEquals(args.includes("-"), true);
    assertEquals(args.slice(-2), ["-m", "gpt-5.5-codex"]);
});

// --- prompt assembly ---------------------------------------------------------

Deno.test("flattenMessages: labels roles and drops system messages", () => {
    const out = flattenMessages([
        { role: "system", content: "ignored" },
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
    ]);
    assertEquals(out, "### USER\nfirst\n\n### ASSISTANT\nsecond");
});

Deno.test("flattenMessages: non-string content is JSON-encoded", () => {
    assertEquals(flattenMessages([{ role: "user", content: { a: 1 } }]), '### USER\n{"a":1}');
});

// --- selection ---------------------------------------------------------------

Deno.test("isCliModel only matches the cli: prefix", () => {
    assertEquals(isCliModel("cli:codex"), true);
    assertEquals(isCliModel("acp:codex"), false);
    assertEquals(isCliModel("z-ai/glm-5"), false);
});

Deno.test("the three verified presets are present", () => {
    assertEquals(cliPresetNames().sort(), ["claude-code", "codex", "opencode"]);
});

// --- native tool-use detection ----------------------------------------------
//
// A CLI agent that computes in its own shell and returns a hardcoded answer is
// indistinguishable from one that used the REPL — except in its event stream.
// codex cannot be told to drop its shell at all, so detection is the guard.

import { detectNativeToolUse } from "../src/cli_agent.ts";

function docs(...lines: string[]): unknown[] {
    return lines.map((l) => JSON.parse(l));
}

Deno.test("codex: a command_execution item is flagged", () => {
    // Verified real behaviour: under --sandbox read-only codex still ran
    // `python3 -c` and still read a file in its cwd.
    const hits = detectNativeToolUse(cliPreset("codex"), docs(
        `{"type":"item.completed","item":{"type":"command_execution","command":"python3 -c 'print(6*7)'"}}`,
        `{"type":"item.completed","item":{"type":"agent_message","text":"42"}}`,
    ));
    assertEquals(hits, ["command_execution"]);
});

Deno.test("codex: a clean turn flags nothing", () => {
    assertEquals(detectNativeToolUse(cliPreset("codex"), docs(CODEX_JSONL.split("\n")[2])), []);
});

Deno.test("opencode: real tool executions are flagged", () => {
    const hits = detectNativeToolUse(cliPreset("opencode"), docs(
        `{"type":"tool_use","part":{"tool":"bash","state":{"status":"completed"}}}`,
        `{"type":"tool_use","part":{"tool":"read","state":{"status":"completed"}}}`,
    ));
    assertEquals(hits.sort(), ["bash", "read"]);
});

Deno.test("opencode: the task tool is flagged — it escapes the deny config", () => {
    // With bash/read denied but task allowed, the model delegates "read this
    // file for me" to a subagent that does NOT inherit the denials. Observed.
    assertEquals(
        detectNativeToolUse(cliPreset("opencode"), docs(
            `{"type":"tool_use","part":{"tool":"task","state":{"status":"completed"}}}`,
        )),
        ["task"],
    );
});

Deno.test("opencode: a BLOCKED call is not a violation", () => {
    // A denied tool surfaces as tool "invalid" — that is the guard working, and
    // flagging it would turn a successful block into a failed run.
    assertEquals(
        detectNativeToolUse(cliPreset("opencode"), docs(
            `{"type":"tool_use","part":{"tool":"invalid","state":{"status":"completed","input":{"tool":"bash","error":"Model tried to call unavailable tool 'bash'."}}}}`,
            `{"type":"tool_use","part":{"tool":"todowrite","state":{"status":"completed"}}}`,
        )),
        [],
    );
});

Deno.test("claude: no detection patterns means no false positives", () => {
    // claude's tools are genuinely removed by --disallowedTools (verified: it
    // could neither read a planted file nor run a shell command), so its preset
    // declares no patterns and must never flag.
    assertEquals(detectNativeToolUse(cliPreset("claude-code"), docs(CLAUDE_JSON)), []);
});

Deno.test("presets that can be locked down inject the config that does it", () => {
    // --pure alone does NOT remove opencode's tools; opencode.json does.
    const oc = cliPreset("opencode").config_files as Record<string, any>;
    const perms = oc["opencode.json"].permission;
    for (const tool of ["bash", "read", "edit", "write", "glob", "grep", "task"]) {
        assertEquals(perms[tool], "deny", `${tool} must be denied`);
    }
});

// --- multi-iteration usage ---------------------------------------------------

Deno.test("claude: prompt_tokens is the largest iteration, not their sum", () => {
    // `claude -p` sums usage across every internal model iteration. Summing is
    // right for billing but wrong for prompt_tokens, which max_prompt_tokens
    // reads as "how big did this context get" — the same cached prefix would be
    // counted once per iteration. Observed in the wild: 563,963 reported
    // "input" tokens for a context of roughly 15k.
    const payload = JSON.stringify({
        is_error: false,
        result: "```repl\n1\n```",
        usage: {
            // Top level is the SUM across the three iterations below.
            input_tokens: 6,
            cache_read_input_tokens: 90_000,
            cache_creation_input_tokens: 12_000,
            output_tokens: 300,
            iterations: [
                { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 12_000 },
                { input_tokens: 2, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 },
                { input_tokens: 2, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 },
            ],
        },
    });
    const { usage } = extractReply(cliPreset("claude-code"), payload);
    assertEquals(usage.prompt_tokens, 50_002); // biggest iteration, not 102,006
    assertEquals(usage.completion_tokens, 300);
});

Deno.test("claude: falls back to the summed fields when no iterations are reported", () => {
    const payload = JSON.stringify({
        is_error: false,
        result: "ok",
        usage: {
            input_tokens: 100,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 300,
            output_tokens: 5,
        },
    });
    assertEquals(extractReply(cliPreset("claude-code"), payload).usage.prompt_tokens, 600);
});

Deno.test("claude: an empty iterations array falls back rather than reporting zero", () => {
    const payload = JSON.stringify({
        is_error: false,
        result: "ok",
        usage: { input_tokens: 7, output_tokens: 1, iterations: [] },
    });
    assertEquals(extractReply(cliPreset("claude-code"), payload).usage.prompt_tokens, 7);
});



Deno.test("?model= passes an exact model id through unchanged", () => {
    // Aliases follow the latest release; exact ids pin it. Both are just
    // strings to us — whatever the CLI accepts.
    for (const model of ["sonnet", "opus", "claude-sonnet-5", "gpt-5.5-codex"]) {
        assertEquals(buildArgs(cliPreset("claude-code"), model, false).slice(-2), ["--model", model]);
    }
});

Deno.test("opencode takes a provider/model id", () => {
    assertEquals(
        buildArgs(cliPreset("opencode"), "anthropic/claude-sonnet-5", false).slice(-2),
        ["-m", "anthropic/claude-sonnet-5"],
    );
});

// --- explicit model requirement ----------------------------------------------

import { parseCliModelForTest } from "../src/cli_agent.ts";

Deno.test("every preset refuses to resolve without a model", () => {
    for (const name of cliPresetNames()) {
        assertThrows(
            () => parseCliModelForTest(`cli:${name}`),
            Error,
            "does not specify a model",
        );
    }
});

Deno.test("a stated model resolves normally", () => {
    assertEquals(parseCliModelForTest("cli:claude-code?model=claude-sonnet-5").modelId, "claude-sonnet-5");
    assertEquals(parseCliModelForTest("cli:codex?model=gpt-5.5-codex").modelId, "gpt-5.5-codex");
});

Deno.test("no preset ships a default model", () => {
    // A preset choosing a model is what the requirement exists to prevent:
    // Claude Code's own fallback is Opus, the most expensive option.
    for (const name of cliPresetNames()) {
        assertEquals(cliPreset(name).model, undefined, `${name} sets a default model`);
    }
});
