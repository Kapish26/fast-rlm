// Unit test: the inherit_tools / inherit_mcp prompt options flip the two
// delegation-inheritance sentences in the root system prompt.
//
// These assertions matter because the swap is a literal string replace: if the
// sentences in SYSTEM_PROMPT are ever reworded, the replace silently no-ops and
// the agent is told the opposite of how the runtime actually behaves. That is
// the exact failure these flags exist to prevent, so it must fail loudly here.
//
// Run:  deno test --allow-read --allow-env tests/inherit_test.ts
import { assert, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { buildSystemPrompt } from "../src/prompt.ts";

const TOOLS_NO = "Sub-agents do NOT automatically inherit your tools";
const TOOLS_YES = "Sub-agents automatically inherit your tools";
const MCP_NO = "Sub-agents do NOT inherit MCP access";
const MCP_YES = "Sub-agents automatically inherit your MCP servers";

Deno.test("default root prompt states that nothing is inherited", () => {
    const p = buildSystemPrompt(false, {});
    assertStringIncludes(p, TOOLS_NO);
    assertStringIncludes(p, MCP_NO);
    assert(!p.includes(TOOLS_YES));
    assert(!p.includes(MCP_YES));
});

Deno.test("inheritTools swaps only the tools sentence", () => {
    const p = buildSystemPrompt(false, { inheritTools: true });
    assertStringIncludes(p, TOOLS_YES);
    assert(!p.includes(TOOLS_NO));
    // MCP guidance is independent and must be untouched.
    assertStringIncludes(p, MCP_NO);
});

Deno.test("inheritMcp swaps only the MCP sentence", () => {
    const p = buildSystemPrompt(false, { inheritMcp: true });
    assertStringIncludes(p, MCP_YES);
    assert(!p.includes(MCP_NO));
    assertStringIncludes(p, TOOLS_NO);
});

Deno.test("both flags swap both sentences", () => {
    const p = buildSystemPrompt(false, { inheritTools: true, inheritMcp: true });
    assertStringIncludes(p, TOOLS_YES);
    assertStringIncludes(p, MCP_YES);
    assert(!p.includes(TOOLS_NO));
    assert(!p.includes(MCP_NO));
});

Deno.test("the swapped sentences document the empty-list override", () => {
    // An explicit [] must always mean "grant nothing", so the prompt has to say
    // so once inheritance is the default; otherwise an agent has no way to deny.
    const p = buildSystemPrompt(false, { inheritTools: true, inheritMcp: true });
    assertStringIncludes(p, "tools=[]");
    assertStringIncludes(p, "mcp=[]");
});

Deno.test("leaf prompt has no delegation sentences to swap", () => {
    // Leaf agents cannot call llm_query, so the flags must be inert for them.
    const plain = buildSystemPrompt(true, {});
    const flagged = buildSystemPrompt(true, { inheritTools: true, inheritMcp: true });
    assert(plain === flagged);
});
