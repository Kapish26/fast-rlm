// Unit tests for cost derivation (feature P1): max_money_spent never fired on
// OpenRouter because the top-level usage.cost is 0 for BYOK keys while the real
// spend lives in usage.cost_details.upstream_inference_cost. deriveCost() must
// fall back to that. Payload shapes below mirror a real OpenRouter response.
//
// Run:  deno test tests/cost_test.ts
import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { deriveCost, toUsage } from "../src/usage.ts";

Deno.test("deriveCost: non-BYOK uses the billed top-level cost", () => {
    // Real shape from a regular (non-BYOK) OpenRouter key: cost is populated and
    // is what's billed to the account; upstream is also present but must NOT be
    // added on top (that would double-count).
    assertEquals(deriveCost({ cost: 0.0123, is_byok: false }), 0.0123);
    assertEquals(
        deriveCost({ cost: 3e-6, is_byok: false, cost_details: { upstream_inference_cost: 3e-6 } }),
        3e-6,
    );
});

Deno.test("deriveCost: BYOK free tier (cost 0) uses upstream_inference_cost", () => {
    // Exact shape observed from a BYOK key inside the 1M-req/month free tier.
    const raw = {
        prompt_tokens: 9,
        completion_tokens: 5,
        cost: 0,
        is_byok: true,
        cost_details: {
            upstream_inference_cost: 4.35e-6,
            upstream_inference_prompt_cost: 1.35e-6,
            upstream_inference_completions_cost: 3e-6,
        },
    };
    assertEquals(deriveCost(raw), 4.35e-6);
});

Deno.test("deriveCost: BYOK past free tier sums upstream + OpenRouter fee", () => {
    // Beyond the free tier the top-level cost is OpenRouter's ~5% fee; true spend
    // is the upstream inference cost PLUS that fee.
    const raw = {
        is_byok: true,
        cost: 5e-8, // ~5% fee
        cost_details: { upstream_inference_cost: 1e-6 },
    };
    assertEquals(deriveCost(raw), 1e-6 + 5e-8);
});

Deno.test("deriveCost: cost 0 with no details stays 0", () => {
    assertEquals(deriveCost({ cost: 0 }), 0);
});

Deno.test("deriveCost: missing cost and no details is undefined", () => {
    assertEquals(deriveCost({ prompt_tokens: 5 }), undefined);
    assertEquals(deriveCost(undefined), undefined);
});

Deno.test("deriveCost: upstream present without is_byok flag still counts (fallback)", () => {
    assertEquals(deriveCost({ cost_details: { upstream_inference_cost: 1e-3 } }), 1e-3);
});

Deno.test("deriveCost: ignores non-positive upstream", () => {
    assertEquals(deriveCost({ cost: 0, cost_details: { upstream_inference_cost: 0 } }), 0);
});

Deno.test("toUsage: maps token fields and derives cost", () => {
    const raw = {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cost: 0,
        prompt_tokens_details: { cached_tokens: 10 },
        completion_tokens_details: { reasoning_tokens: 4 },
        cost_details: { upstream_inference_cost: 0.002 },
    };
    assertEquals(toUsage(raw), {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cached_tokens: 10,
        reasoning_tokens: 4,
        cost: 0.002,
    });
});

Deno.test("toUsage: tolerates a missing usage payload", () => {
    assertEquals(toUsage(undefined), {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        cost: undefined,
    });
});
