// Engine runner (Doc 06 §7 pipeline). Orchestrates the deterministic checks over
// an AOM model and aggregates results into Issues (severity per §21). Pure (§6, §19).
//
// Order (§8): Mechanical / Reference / FS Integrity first (this milestone);
// relational checks (Cross-Note / Cash Flow) attach in M4.

import type { AomObject, Issue, ReviewResult, Severity } from "../aom/types.js";
import type { AomModel } from "../aom/builder.js";
import { ENGINE_VERSION } from "./types.js";
import { checkMechanical } from "./mechanical.js";
import { checkReferences } from "./reference.js";
import { checkFsIntegrity } from "./integrity.js";
import { checkArticulation } from "./articulation.js";
import { checkRelational } from "./relational.js";
import { severityFor } from "./rules.js";
import type { RelationshipEdge } from "../aom/types.js";
import { generateInsights, selectInsightProvider, type InsightOptions } from "../insight/generate.js";
import type { Insight } from "../insight/types.js";

export interface EngineReport {
  engineVersion: string;
  dsdFileHash: string;
  results: ReviewResult[];
  issues: Issue[];
  /** Relationship graph edges discovered by relational checks (Doc 03 §3.5). */
  edges: RelationshipEdge[];
  /** AI interpretation layer (Doc 07): auditor questions grounded in evidence. */
  insights: Insight[];
  summary: {
    total: number;
    byStatus: Record<string, number>;
    byCheck: Record<string, number>;
    issues: Record<Severity, number>;
    /** False-positive proxy (Doc 06 §9): machine-asserted errors on this report. */
    mismatches: number;
  };
}

export function runEngine(model: AomModel, insightOpts: InsightOptions = {}): EngineReport {
  const objects = model.objects;
  const results: ReviewResult[] = [];

  // ① Mechanical over note tables. Primary statements (BS/IS/CF/SCE) have
  // hierarchical subtotals and are covered by FS Integrity (§6) / Cash Flow (M4),
  // so summing them naively would be unsound — skip them here.
  for (const o of objects) {
    if (o.objectType === "FinancialStatementTable" && o.statement === "NOTE")
      results.push(...checkMechanical(o));
  }
  // ② Reference Review.
  results.push(...checkReferences(objects).results);
  // ⑤ FS Integrity.
  results.push(...checkFsIntegrity(objects));
  // ⑥ Articulation — 재무제표 간 연계성 (자본변동표 ↔ 재무상태표 ↔ 손익 ↔ 현금흐름).
  results.push(...checkArticulation(objects));
  // ③ Cross-Note + ④ Cash Flow (relational, run after standalone checks — §8).
  const relational = checkRelational(objects);
  results.push(...relational.results);

  const issues = buildIssues(objects, results);

  // AI interpretation (Doc 07). Default provider is offline & deterministic (§8/§19);
  // an LLM provider is opt-in via insightOpts and never used unless injected.
  const insights = generateInsights(
    { objects, issues, results },
    selectInsightProvider(insightOpts),
  );

  const byStatus: Record<string, number> = {};
  const byCheck: Record<string, number> = {};
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    byCheck[r.check] = (byCheck[r.check] ?? 0) + 1;
  }
  const issueSev: Record<Severity, number> = { error: 0, review: 0, info: 0 };
  for (const i of issues) issueSev[i.severity]++;

  return {
    engineVersion: ENGINE_VERSION,
    dsdFileHash: model.dsdFileHash,
    results,
    issues,
    edges: relational.edges,
    insights,
    summary: {
      total: results.length,
      byStatus,
      byCheck,
      issues: issueSev,
      mismatches: byStatus["mismatch"] ?? 0,
    },
  };
}

/** One Issue per non-clean result (mismatch/review); match/skipped are not issues. */
function buildIssues(objects: AomObject[], results: ReviewResult[]): Issue[] {
  const idOf = new Set(objects.map((o) => o.id));
  const issues: Issue[] = [];
  for (const r of results) {
    if (r.status === "match" || r.status === "skipped") continue;
    const severity: Severity = severityFor(r.check, r.status);
    const evidence = r.targets.filter((t) => idOf.has(t));
    issues.push({
      id: `issue:${r.id}`,
      objectType: "Issue",
      severity,
      title: r.note ?? `${r.check} ${r.status}`,
      evidence,
      reviewResults: [r.id],
      aiNote: null, // filled only by the Doc 07 AI layer (M5)
      drilldown: [r.check, ...evidence, ...r.sourceRefs],
    });
  }
  return issues;
}
