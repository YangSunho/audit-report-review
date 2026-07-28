// Rule registry (Doc 06 §8, Rule DSL). Checks are declared here rather than
// hard-coded across the codebase (§9 Knowledge-driven). M2 decision: rules are
// typed TS objects (external YAML loading deferred to a later milestone); the
// shape mirrors the Doc 06 §8 DSL so a YAML loader can populate it unchanged.

import type { CheckStatus, Severity } from "../aom/types.js";

export interface RuleSpec {
  id: string;
  check: string; // ReviewResult.check this rule governs
  tolerance: { mode: "exact" | "rounding" | "percent"; unitKrw: number };
  /** Severity when a result of this check is not a clean match (§21). */
  onFail: Severity;
}

export const RULES: readonly RuleSpec[] = [
  { id: "rollforward", check: "RollForward", tolerance: { mode: "rounding", unitKrw: 1 }, onFail: "error" },
  { id: "crossfooting", check: "CrossFooting", tolerance: { mode: "rounding", unitKrw: 1 }, onFail: "error" },
  { id: "footing", check: "Footing", tolerance: { mode: "rounding", unitKrw: 1 }, onFail: "error" },
  { id: "ref.resolve", check: "ReferenceResolve", tolerance: { mode: "exact", unitKrw: 0 }, onFail: "review" },
  { id: "fs.balance", check: "FsBalance", tolerance: { mode: "exact", unitKrw: 0 }, onFail: "error" },
  { id: "fs.anchor", check: "FsAnchor", tolerance: { mode: "rounding", unitKrw: 1_000_000 }, onFail: "review" },
] as const;

const byCheck = new Map(RULES.map((r) => [r.check, r]));

/** Map a (check,status) to Issue severity per §21 and the rule's onFail. */
export function severityFor(check: string, status: CheckStatus): Severity {
  if (status === "match") return "info";
  if (status === "skipped") return "info";
  if (status === "mismatch") return byCheck.get(check)?.onFail ?? "error";
  // review
  return "review";
}
