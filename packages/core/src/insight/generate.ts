// Insight orchestration (Doc 07). Builds a grounded evidence bundle per Issue and
// runs the selected provider, then enforces the output guardrails (§2) — anything
// that fails is discarded, never shown. Default provider is the offline grounded
// generator (deterministic, no key/network, §18/§19).

import type { AomObject, Issue, ReviewResult } from "../aom/types.js";
import { noteTitleMap } from "../labels.js";
import { DEFAULT_POLICY, type Insight, type InsightContext, type InsightProvider } from "./types.js";
import { OfflineGroundedProvider } from "./offline.js";
import { validateInsight } from "./guardrails.js";

export const OFFLINE_PROVIDER: InsightProvider = new OfflineGroundedProvider();

export interface InsightInput {
  objects: AomObject[];
  issues: Issue[];
  results: ReviewResult[];
}

export interface InsightOptions {
  /** Opt-in override. Absent → offline grounded provider (§18 local-first). */
  provider?: InsightProvider;
}

/**
 * Provider selection: explicit opt-in wins; otherwise the offline provider.
 * With no key/provider configured this ALWAYS returns the deterministic offline
 * provider — external calls never happen by default (§18, §8 deterministic-first).
 */
export function selectInsightProvider(opts: InsightOptions = {}): InsightProvider {
  return opts.provider ?? OFFLINE_PROVIDER;
}

function buildContext(
  issue: Issue,
  input: InsightInput,
  noteTitles: Map<string, string>,
): InsightContext {
  const resultById = new Map(input.results.map((r) => [r.id, r]));
  const objectById = new Map(input.objects.map((o) => [o.id, o]));
  const reviewResults = issue.reviewResults
    .map((id) => resultById.get(id))
    .filter((r): r is ReviewResult => r !== undefined);
  const evidenceObjects = issue.evidence
    .map((id) => objectById.get(id))
    .filter((o): o is AomObject => o !== undefined);
  return { issue, reviewResults, evidenceObjects, noteTitles, policy: DEFAULT_POLICY };
}

/**
 * Generate insights for every Issue, in deterministic Issue order. Guardrails (§2)
 * are enforced: an insight without evidence, with a fabricated number, or with a
 * verdict tone is dropped (§4/§6/§21).
 */
export function generateInsights(
  input: InsightInput,
  provider: InsightProvider = OFFLINE_PROVIDER,
): Insight[] {
  const out: Insight[] = [];
  const noteTitles = noteTitleMap(input.objects);
  for (const issue of input.issues) {
    const ctx = buildContext(issue, input, noteTitles);
    for (const insight of provider.generate(ctx)) {
      if (validateInsight(insight).ok) out.push(insight);
    }
  }
  return out;
}
