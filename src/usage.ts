/**
 * Global usage tracker across all subagents
 */

import type { Usage } from "./call_llm.ts";

/**
 * Best-effort spend for one call, in USD.
 *
 * Per OpenRouter's usage-accounting contract (returned on every response, any
 * upstream provider):
 *   - `usage.cost` = the total charged to YOUR OpenRouter account.
 *   - `usage.cost_details.upstream_inference_cost` = the actual cost charged by
 *     the upstream provider; populated ONLY for BYOK requests (0/null otherwise).
 *
 * The subtlety that made `max_money_spent` misbehave: for a **BYOK** key the
 * top-level `cost` is only OpenRouter's *fee* (0 during the free tier, ~5% of
 * the equivalent price beyond it) — NOT the inference spend, which you pay your
 * upstream provider directly. So:
 *   - BYOK (`is_byok === true`): spend = upstream_inference_cost + OpenRouter fee
 *     (the top-level `cost`). In the free tier that's just upstream_inference_cost.
 *   - Non-BYOK: the top-level `cost` already IS the billed amount (credits,
 *     including any margin) — use it directly.
 * Value-based fallbacks cover responses that omit `is_byok`.
 */
// deno-lint-ignore no-explicit-any
export function deriveCost(rawUsage: any): number | undefined {
    const top = typeof rawUsage?.cost === "number" ? rawUsage.cost : undefined;
    const upstream = typeof rawUsage?.cost_details?.upstream_inference_cost === "number"
        ? rawUsage.cost_details.upstream_inference_cost
        : undefined;

    if (rawUsage?.is_byok === true && upstream !== undefined) {
        return upstream + (top && top > 0 ? top : 0);
    }
    if (top !== undefined && top > 0) return top;          // non-BYOK billed amount
    if (upstream !== undefined && upstream > 0) return upstream; // BYOK-like w/o flag
    return top;  // preserve 0 or undefined
}

/** Normalize a provider `usage` payload into our Usage shape (with derived cost). */
// deno-lint-ignore no-explicit-any
export function toUsage(rawUsage: any): Usage {
    return {
        prompt_tokens: rawUsage?.prompt_tokens ?? 0,
        completion_tokens: rawUsage?.completion_tokens ?? 0,
        total_tokens: rawUsage?.total_tokens ?? 0,
        cached_tokens: rawUsage?.prompt_tokens_details?.cached_tokens ?? 0,
        reasoning_tokens: rawUsage?.completion_tokens_details?.reasoning_tokens ?? 0,
        cost: deriveCost(rawUsage),
    };
}

let globalUsage: Usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    cost: undefined,
};

// Running count of LLM calls across ALL agents (root + every sub-agent) and
// every backend (openai/vertex/acp). Backs the max_global_calls budget — the
// stop gap that works for ACP, where token/cost usage is always zero.
let globalCalls = 0;

export function trackCall(): void {
    globalCalls += 1;
}

export function getTotalCalls(): number {
    return globalCalls;
}

export function trackUsage(usage: Usage): void {
    globalUsage.prompt_tokens += usage.prompt_tokens || 0;
    globalUsage.completion_tokens += usage.completion_tokens || 0;
    globalUsage.total_tokens += usage.total_tokens || 0;
    globalUsage.cached_tokens += usage.cached_tokens || 0;
    globalUsage.reasoning_tokens += usage.reasoning_tokens || 0;
    if (usage.cost != null) {
        globalUsage.cost = (globalUsage.cost ?? 0) + usage.cost;
    }
}

export function getTotalUsage(): Usage {
    return { ...globalUsage };
}

export function resetUsage(): void {
    globalUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        cost: undefined,
    };
    globalCalls = 0;
}
