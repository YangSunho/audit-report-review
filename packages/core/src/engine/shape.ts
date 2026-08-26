// Table shape catalogue (Doc 06 §2). Korean audit notes are not uniform: a human
// reads the layout instantly, code must infer it. Rather than assume one shape,
// we detect structural features first and let each check branch on them.
//
// Measured on the 표본 A (2025 감사보고서) (130 note tables):
//   기간 2단(당기/전기)  62 · 다단헤더(2행+) 48 · 비금액 단위 혼재 46
//   colspan 헤더        27 · 전치형 롤포워드 16 · 계층 들여쓰기 4
//
// Design rule (§21): a shape we cannot classify confidently must NOT produce a
// machine verdict — the caller downgrades to `review`/`skipped` instead.

import type { FinancialStatementTable, TableRow } from "../aom/types.js";

export type ShapeFeature =
  | "MultiRowHeader" // 2+ leading rows carry no figures (구분 / 매출채권·미수금)
  | "PeriodColumns" // 당기·전기 side by side → column groups repeat
  | "SubtotalRows" // 소계 aggregates the detail rows above it
  | "TransposedRollForward" // 기초…기말 as ROWS, classes as columns
  | "IndentedDetail" // "- 근무원가" style child rows under a parent
  | "NonMonetaryUnits" // %, 배, 주, 명 mixed into the figures
  | "MixedCurrency" // KRW and USD/foreign amounts in the same column
  | "TotalColumn" // a single unambiguous 합계 column
  | "TotalRow"; // a single unambiguous 합계 row

export interface TableShape {
  features: Set<ShapeFeature>;
  /** Index of the first data row (rows before it are header rows). */
  bodyStart: number;
  /** Column index of the total column, or -1. */
  totalCol: number;
  /** True when the layout is understood well enough to certify a failure. */
  certifiable: boolean;
}

const norm = (s: string): string => s.replace(/\s/g, "");
const isTotalLabel = (s: string): boolean => /(합계|총계|^계$)/.test(norm(s));
const isSubtotal = (s: string): boolean => /소계/.test(norm(s));

function rowHasFigures(r: TableRow): boolean {
  return r.cells.some((c) => c.number !== undefined);
}

/** Leading rows without figures are header rows (multi-row headers are common). */
function headerDepth(rows: TableRow[]): number {
  let n = 0;
  for (const r of rows) {
    if (rowHasFigures(r)) break;
    n++;
    if (n >= 3) break; // guard: never treat a whole table as header
  }
  return Math.max(1, n);
}

export function detectShape(table: FinancialStatementTable): TableShape {
  const rows = table.rows;
  const features = new Set<ShapeFeature>();
  const bodyStart = headerDepth(rows);
  if (bodyStart >= 2) features.add("MultiRowHeader");

  const headerCells = rows.slice(0, bodyStart).flatMap((r) => r.cells);
  const periodCells = headerCells.filter((c) => c.text && /당기|전기/.test(c.text));
  if (periodCells.length >= 2) features.add("PeriodColumns");

  const body = rows.slice(bodyStart);
  if (body.some((r) => isSubtotal(r.label))) features.add("SubtotalRows");
  if (body.some((r) => /기초/.test(norm(r.label))) && body.some((r) => /기말/.test(norm(r.label))))
    features.add("TransposedRollForward");
  if (body.some((r) => /^[-ㆍ·]\s*/.test(r.label.trim()))) features.add("IndentedDetail");
  // Only a VALUE cell in the body carrying a non-monetary unit counts (지분율
  // 49.9%, 1.2배). Header words like "기업명"/"주당손익" are labels, not values —
  // matching them would wrongly disqualify whole tables from footing.
  const nonMonetary = body.some((r) =>
    r.cells.some(
      (c) => c.col > 0 && c.text !== undefined && !c.number && /^[\d.,]+\s*(%|배)$/.test(c.text.trim()),
    ),
  );
  if (nonMonetary) features.add("NonMonetaryUnits");

  // A currency column (KRW / USD / EUR …) means the amounts beside it are in
  // DIFFERENT units — summing them is meaningless. 약정사항 tables list KRW and
  // USD limits side by side with separate 원화/외화 totals, so a naive column
  // sum produced a false "합계 불일치".
  const currencyCell = /^(KRW|USD|EUR|JPY|CNY|GBP|원화|외화|미화)$/i;
  const hasCurrencyCol = rows.some((r) =>
    r.cells.some((c) => c.col > 0 && c.text !== undefined && currencyCell.test(c.text.trim())),
  );
  const currencies = new Set<string>();
  for (const r of rows)
    for (const c of r.cells) {
      const t = c.text?.trim();
      if (c.col > 0 && t && currencyCell.test(t)) currencies.add(t.toUpperCase());
    }
  if (hasCurrencyCol && currencies.size >= 2) features.add("MixedCurrency");

  const totals = headerCells.filter((c) => c.text && isTotalLabel(c.text));
  const totalCol = totals.length === 1 ? totals[0]!.col : -1;
  if (totalCol >= 0) features.add("TotalColumn");
  const totalRows = body.filter((r) => isTotalLabel(r.label));
  if (totalRows.length === 1) features.add("TotalRow");

  // Certifiable only when the layout carries no ambiguity we know we mishandle:
  // mixed units or mixed currencies make "sum of a column" meaningless.
  const certifiable = !features.has("NonMonetaryUnits") && !features.has("MixedCurrency");

  return { features, bodyStart, totalCol, certifiable };
}
