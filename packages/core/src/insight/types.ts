// AI Insight layer — types & provider abstraction (Doc 07). The AI role is
// INTERPRETATION, not calculation (§6). Insights turn engine `review` Issues into
// auditor questions with evidence (§4.1/§4.2). No fabricated numbers, no K-IFRS
// claims without KB grounding (§5), no verdicts — "추가 검토 권장" tone (§21).

import type { AomObject, Issue, ReviewResult, Severity } from "../aom/types.js";

export type InsightConfidence = "high" | "medium" | "low";

/** One grounded evidence link (§4, §20). Figures are quoted, never derived (§6). */
export interface InsightEvidence {
  objectId: string;
  label: string; // human label (account/note/table)
  xmlPath: string; // §20 drill-down
  page?: number;
  figures: string[]; // figures quoted from this evidence / ReviewResult only
}

export interface Insight {
  id: string;
  issueId: string;
  check: string;
  severity: Severity;
  question: string; // auditor question (§4.1)
  rationale: string; // why these are connected (§4.2), no new numbers
  potentialRisk: string; // ROMM-oriented, not a verdict (§4.1)
  evidence: InsightEvidence[]; // ≥1 required (§2.1)
  confidence: InsightConfidence; // §7
  provider: string;
}

export interface InsightPolicy {
  language: "ko";
  tone: "dry-professional";
  noVerdict: boolean;
}

/**
 * Grounded evidence bundle handed to a provider (§3). Deliberately NOT the whole
 * DSD — only the normalized evidence for one Issue (§18 privacy, §5 hallucination).
 * `kbSnippets` is absent by default → providers must not make K-IFRS statements (§5).
 */
export interface InsightContext {
  issue: Issue;
  reviewResults: ReviewResult[];
  evidenceObjects: AomObject[];
  noteTitles: Map<string, string>; // noteNo → title, for self-explanatory labels
  policy: InsightPolicy;
}

export interface InsightProvider {
  readonly name: string;
  /** Offline providers MUST be pure & deterministic (§19). */
  generate(ctx: InsightContext): Insight[];
}

export const DEFAULT_POLICY: InsightPolicy = {
  language: "ko",
  tone: "dry-professional",
  noVerdict: true,
};
