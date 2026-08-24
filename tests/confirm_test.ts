// The compression guard is documented as fail-open: only an explicit NO blocks
// a delegation. The old per-backend check took the first 4 characters and asked
// startsWith("NO"), which also rejected "Nothing", "None", "Note:" — turning
// fail-open into fail-closed and forcing a spurious compress+retry.
//
// Run:  deno test tests/confirm_test.ts
import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { parseConfirmVerdict } from "../src/confirm.ts";

Deno.test("an explicit NO rejects, however it is decorated", () => {
    for (const reply of ["NO", "no", "No.", "**NO** - too big", "  no, compress first"]) {
        assertEquals(parseConfirmVerdict(reply).approve, false, reply);
    }
});

Deno.test("words merely starting with 'no' are NOT rejections", () => {
    // Each of these was a false reject under the old 4-char prefix test.
    for (const reply of [
        "Nothing blocks this delegation.",
        "None of the concerns apply here.",
        "Note: this is a genuine map step.",
        "Not a problem — proceed.",
        "Normal chunked delegation, fine.",
    ]) {
        assertEquals(parseConfirmVerdict(reply).approve, true, reply);
    }
});

Deno.test("a plain YES approves", () => {
    assertEquals(parseConfirmVerdict("YES").approve, true);
    assertEquals(parseConfirmVerdict("Yes — this is one chunk of a map.").approve, true);
});

Deno.test("empty or punctuation-only replies fail open with a placeholder reason", () => {
    assertEquals(parseConfirmVerdict("").approve, true);
    assertEquals(parseConfirmVerdict("").reason, "(no reason given)");
    assertEquals(parseConfirmVerdict("   ").approve, true);
    assertEquals(parseConfirmVerdict("???").approve, true);
});

Deno.test("the reason preserves the full trimmed reply", () => {
    const reply = "NO\nThe caller should slice by keyword first.";
    const v = parseConfirmVerdict(reply);
    assertEquals(v.approve, false);
    assertEquals(v.reason, reply);
});
