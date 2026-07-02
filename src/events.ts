/**
 * Machine-readable event stream.
 *
 * When run() is given an `on_step` callback it passes `--events-file <path>`;
 * this module appends one JSON object per line (NDJSON) to that file as steps
 * occur. Writes are synchronous (open→write→close per line) so the Python side
 * can tail the file and deliver events live, mid-run — the persistent Pino log
 * is `sync: false` and buffered, so it is not a reliable live channel.
 *
 * No-op unless initEvents() has been called with a path.
 */

let eventsFile: string | null = null;

/** Point the emitter at a file (call once, before any emitEvent). */
export function initEvents(path: string): void {
    eventsFile = path;
}

/** Append one event as an NDJSON line. No-op when no events file is set. */
export function emitEvent(event: Record<string, unknown>): void {
    if (!eventsFile) return;
    try {
        Deno.writeTextFileSync(eventsFile, JSON.stringify(event) + "\n", {
            append: true,
        });
    } catch {
        // Never let event emission break a run; the persistent log still has it.
    }
}
