// Insight output guardrails (Doc 07 §2). An insight is stored only if it passes.
// This is the enforcement point for §4 (evidence), §6 (no new numbers), §21 (no
// verdict). It validates provider output independently — a defense in depth that
// holds for the offline provider AND any future LLM provider.

import type { Insight } from "./types.js";

export interface GuardrailResult {
  ok: boolean;
  violations: string[];
}

const VERDICT_WORDS = /(틀렸|틀립니다|틀린|오류입니다|잘못되었|명백히|확실히 오류)/;
const RECOMMEND_PHRASE = /(추가 검토|검토가 권장|권장됩니다|확인해|확인이 필요|수 있습니다)/;

/** Digit tokens (with optional thousands separators), normalized to digits only. */
function numericTokens(s: string): string[] {
  return (s.match(/\d[\d,]*/g) ?? []).map((t) => t.replace(/,/g, ""));
}

export function validateInsight(insight: Insight): GuardrailResult {
  const v: string[] = [];

  // §2.1 evidence required.
  if (insight.evidence.length === 0) v.push("no-evidence");

  // §2.2 no fabricated numbers — every figure in the prose must be grounded in
  // evidence: a quoted figure, a number inside a grounded label (e.g. 주석13),
  // or a page number. Anything else is a fabrication and fails.
  const allowed = new Set<string>();
  for (const e of insight.evidence) {
    for (const f of e.figures) allowed.add(f.replace(/,/g, ""));
    for (const t of numericTokens(e.label)) allowed.add(t);
    if (e.page !== undefined) allowed.add(String(e.page));
  }
  const prose = `${insight.question} ${insight.rationale} ${insight.potentialRisk}`;
  for (const tok of numericTokens(prose)) {
    if (!allowed.has(tok)) v.push(`fabricated-number:${tok}`);
  }

  // §2.3 no verdict phrasing (except machine-certain `error`).
  if (insight.severity !== "error" && VERDICT_WORDS.test(prose)) v.push("verdict-tone");

  // §21 review must carry a recommendation phrasing.
  if (insight.severity === "review" && !RECOMMEND_PHRASE.test(prose))
    v.push("missing-recommendation");

  // §7 confidence must be present & valid.
  if (!["high", "medium", "low"].includes(insight.confidence)) v.push("bad-confidence");

  return { ok: v.length === 0, violations: v };
}
