// Optional LLM insight provider — INTERFACE ONLY, opt-in (Doc 07 §8, §18).
// Not wired into the default pipeline: runEngine always uses the deterministic
// offline provider. An LLM provider is used only when a caller explicitly injects
// one. Safety invariants encoded here:
//   · Only the normalized evidence bundle is ever sent — never the raw DSD (§18).
//   · Output must still pass the §2 guardrails (enforced by generate.ts).

import type { InsightContext } from "./types.js";

/** An async provider (LLM calls are async, unlike the sync offline provider). */
export interface AsyncInsightProvider {
  readonly name: string;
  generate(ctx: InsightContext): Promise<import("./types.js").Insight[]>;
}

export interface LlmConfig {
  /** Env var holding the API key. If unset at call time, the provider must refuse. */
  apiKeyEnv: string; // e.g. "ARI_INSIGHT_API_KEY"
  endpoint?: string; // local or external; caller's choice (opt-in)
  model?: string;
}

/**
 * The exact payload that MAY leave the machine (§18): issue metadata + normalized
 * evidence only. The raw .dsd, extracted XML, and unrelated objects are excluded
 * by construction — there is no field to carry them.
 */
export function toEvidenceBundle(ctx: InsightContext): {
  issue: { id: string; severity: string; check: string };
  evidence: { label: string; xmlPath: string; figures: string[] }[];
  policy: InsightContext["policy"];
} {
  return {
    issue: {
      id: ctx.issue.id,
      severity: ctx.issue.severity,
      check: ctx.issue.drilldown[0] ?? "Issue",
    },
    evidence: ctx.evidenceObjects.map((o) => ({
      label: o.objectType,
      xmlPath: o.source.xmlPath,
      figures: [],
    })),
    policy: ctx.policy,
  };
}

/** True only when the configured key is actually present (opt-in gate, §18). */
export function llmAvailable(config: LlmConfig): boolean {
  const key = process.env[config.apiKeyEnv];
  return typeof key === "string" && key.length > 0;
}
