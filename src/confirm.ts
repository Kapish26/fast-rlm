// Shared parsing for the compression guard's YES/NO verdict.
//
// The guard is documented as fail-open: only an explicit NO rejects a
// delegation. Every backend used to reimplement that check as
// `text.slice(0, 4).toUpperCase().startsWith("NO")`, which also rejects any
// reply opening with "Nothing", "None", "Note:", "Not really a problem" — the
// contract silently became fail-closed and forced a spurious compress+retry.
// Matching a whole first word fixes it in one place for all backends.

export interface ConfirmVerdict {
    approve: boolean;
    reason: string;
}

export function parseConfirmVerdict(text: string): ConfirmVerdict {
    const content = text.trim();
    // First alphabetic run, e.g. "**NO** - too big" -> "NO", "Nothing" -> "NOTHING".
    const firstWord = (content.match(/[a-zA-Z]+/)?.[0] ?? "").toUpperCase();
    return {
        approve: firstWord !== "NO",
        reason: content || "(no reason given)",
    };
}
