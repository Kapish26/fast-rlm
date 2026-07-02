// Unit tests for Anthropic prompt-cache breakpoint placement (feature P3).
// Anthropic does not prefix-cache automatically, so we attach cache_control to
// the system prompt AND the last message (so the growing conversation prefix is
// cached incrementally). These test the transformation without hitting the API;
// end-to-end cache hits were verified live against claude-haiku.
//
// Run:  deno test tests/anthropic_cache_test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { cachedSystem, toAnthropicMessages } from "../src/anthropic.ts";

const EPHEMERAL = { type: "ephemeral" };

Deno.test("cachedSystem wraps the prompt in one ephemeral-cached text block", () => {
    assertEquals(cachedSystem("SYSTEM"), [
        { type: "text", text: "SYSTEM", cache_control: EPHEMERAL },
    ]);
});

Deno.test("only the LAST message carries a cache breakpoint", () => {
    const out = toAnthropicMessages([
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
    ]);
    // Earlier messages stay plain strings...
    assertEquals(out[0], { role: "user", content: "one" });
    assertEquals(out[1], { role: "assistant", content: "two" });
    // ...and the last is a block array with cache_control (caches the whole prefix).
    assertEquals(out[2], {
        role: "user",
        content: [{ type: "text", text: "three", cache_control: EPHEMERAL }],
    });
});

Deno.test("system messages are dropped; roles normalize to user/assistant", () => {
    const out = toAnthropicMessages([
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "tool", content: "weird" },
    ]);
    assertEquals(out.length, 2);
    assertEquals(out[0], { role: "user", content: "hi" });
    // non-assistant roles collapse to "user"; last one gets the breakpoint.
    assertEquals(out[1].role, "user");
    assert(Array.isArray(out[1].content));
    assertEquals(out[1].content[0].cache_control, EPHEMERAL);
});

Deno.test("non-string content is JSON-stringified before caching", () => {
    const out = toAnthropicMessages([{ role: "user", content: { a: 1 } }]);
    assertEquals(out[0].content[0].text, JSON.stringify({ a: 1 }));
    assertEquals(out[0].content[0].cache_control, EPHEMERAL);
});

Deno.test("empty message list does not throw and yields no messages", () => {
    assertEquals(toAnthropicMessages([]), []);
    // list of only system messages also collapses to empty
    assertEquals(toAnthropicMessages([{ role: "system", content: "s" }]), []);
});
