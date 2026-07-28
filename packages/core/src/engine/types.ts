// Review engine contracts. Source of truth: 06_Review_Engine_Spec.md
// All checks are pure & deterministic (§6). Same input + engineVersion -> same output (§19).

import type { ReviewResult, Severity } from "../aom/types.js";

export const ENGINE_VERSION = "0.2.0";

export type ToleranceMode = "exact" | "rounding" | "percent";

export interface Tolerance {
  mode: ToleranceMode;
  unitKrw: number; // e.g. 1 for ±1 won rounding
  note?: string;
}

/** A single deterministic check over AOM objects. Must be a pure function. */
export interface Check<Input> {
  readonly name: string; // "Footing" | "RollForward" | "ReferenceResolve" | ...
  readonly defaultSeverityOnFail: Severity;
  run(input: Input, tolerance: Tolerance): ReviewResult[];
}

/** Compare with tolerance. Returns true when within allowed difference. */
export function withinTolerance(
  expected: number,
  actual: number,
  tol: Tolerance,
): boolean {
  const diff = Math.abs(expected - actual);
  switch (tol.mode) {
    case "exact":
      return diff === 0;
    case "rounding":
      return diff <= tol.unitKrw;
    case "percent":
      return expected === 0 ? diff === 0 : diff / Math.abs(expected) <= tol.unitKrw;
  }
}
