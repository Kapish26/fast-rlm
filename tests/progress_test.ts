// Unit tests for the progress/verbosity plumbing (feature P2):
//   - events.ts: emitEvent writes NDJSON lines to the configured file, and is a
//     no-op (no throw, no file) before initEvents.
//   - ui.ts: setVerbosity gates the display functions — printStep and spinners
//     at level >= 2, showFinalResult/showGlobalUsage at level >= 1.
//
// No LLM and no Pyodide are involved; these exercise the mechanisms directly.
//
// Run:  deno test --allow-read --allow-write tests/progress_test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { emitEvent, initEvents } from "../src/events.ts";
import {
    getVerbosity,
    printStep,
    setVerbosity,
    showFinalResult,
    showGlobalUsage,
    startSpinner,
    type StepData,
} from "../src/ui.ts";

const SAMPLE_STEP: StepData = {
    run_id: "r1",
    depth: 0,
    step: 1,
    maxSteps: 3,
    code: "FINAL(4)",
    output: "4",
    hasError: false,
    usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        cached_tokens: 0,
        reasoning_tokens: 0,
        cost: undefined,
    },
};

const SAMPLE_USAGE = SAMPLE_STEP.usage;

// Capture everything written to console.log while `fn` runs.
function captureLog(fn: () => void): string[] {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
    };
    try {
        fn();
    } finally {
        console.log = orig;
    }
    return lines;
}

Deno.test("emitEvent appends one NDJSON line per call", () => {
    const path = Deno.makeTempFileSync({ suffix: ".events.jsonl" });
    try {
        initEvents(path);
        emitEvent({ event_type: "code_generated", step: 1 });
        emitEvent({ event_type: "final_result", result: 42 });

        const lines = Deno.readTextFileSync(path).trim().split("\n");
        assertEquals(lines.length, 2);
        const first = JSON.parse(lines[0]);
        const second = JSON.parse(lines[1]);
        assertEquals(first.event_type, "code_generated");
        assertEquals(first.step, 1);
        assertEquals(second.event_type, "final_result");
        assertEquals(second.result, 42);
    } finally {
        // Reset the module's target so later tests don't append here.
        initEvents("");
        Deno.removeSync(path);
    }
});

Deno.test("emitEvent is a no-op before initEvents (empty path)", () => {
    initEvents(""); // simulate "no --events-file": empty string is falsy in the guard
    // Should not throw and should not create any file.
    emitEvent({ event_type: "code_generated", step: 1 });
});

Deno.test("verbosity 0 (silent): all display suppressed", () => {
    setVerbosity(0);
    try {
        assertEquals(getVerbosity(), 0);
        assertEquals(captureLog(() => printStep(SAMPLE_STEP)).length, 0);
        assertEquals(captureLog(() => showFinalResult("done", 0)).length, 0);
        assertEquals(captureLog(() => showGlobalUsage(SAMPLE_USAGE)).length, 0);
    } finally {
        setVerbosity(2);
    }
});

Deno.test("verbosity 1 (summary): result + usage print, step does not", () => {
    setVerbosity(1);
    try {
        assertEquals(captureLog(() => printStep(SAMPLE_STEP)).length, 0);
        assert(captureLog(() => showFinalResult("done", 0)).length > 0);
        assert(captureLog(() => showGlobalUsage(SAMPLE_USAGE)).length > 0);
    } finally {
        setVerbosity(2);
    }
});

Deno.test("verbosity 2 (full): per-step boxes print", () => {
    setVerbosity(2);
    assert(captureLog(() => printStep(SAMPLE_STEP)).length > 0);
});

Deno.test("startSpinner returns a silent no-op stub below level 2", () => {
    setVerbosity(0);
    try {
        const spinner = startSpinner("working...");
        // The stub exposes the yocto-spinner subset the engine uses and never
        // starts a timer (so no output, no leaked interval).
        const out = captureLog(() => {
            spinner.success("done");
            spinner.stop();
        });
        assertEquals(out.length, 0);
    } finally {
        setVerbosity(2);
    }
});
