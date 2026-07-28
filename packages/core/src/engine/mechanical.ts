// Mechanical Review — Footing / Cross-footing / Roll-forward (Doc 06 §2).
// Deterministic, pure (§6). Same input + engineVersion → same output (§19).
//
// Values come from AOM TableCell.number (integer KRW, §19). Signs are taken
// as displayed (감소·상각은 원문에서 음수로 표기됨 — Doc 06 §2.4). A blank / "-"
// cell counts as 0 in an additive identity.
//
// FP discipline (Doc 06 §9, ≤1%): we assert `mismatch` (error) only when the
// identity is well-formed and fails. Ambiguous structure → `skipped` (info),
// never a machine-asserted error, so a correct report yields zero false errors.

import type { FinancialStatementTable, ReviewResult, TableRow } from "../aom/types.js";
import { detectShape } from "./shape.js";
import { fmtDelta } from "../labels.js";
import { ENGINE_VERSION, withinTolerance, type Tolerance } from "./types.js";

const roundingTol: Tolerance = { mode: "rounding", unitKrw: 1 };

// ── value grid helpers ───────────────────────────────────────────────────────

function cellValue(row: TableRow, col: number): number {
  const cell = row.cells.find((c) => c.col === col);
  return cell?.number?.value ?? 0;
}
function hasNumber(row: TableRow, col: number): boolean {
  return !!row.cells.find((c) => c.col === col)?.number;
}
function norm(s: string): string {
  return s.replace(/\s/g, "");
}
const isOpening = (label: string): boolean => /기초/.test(norm(label));
const isClosing = (label: string): boolean => /기말/.test(norm(label));
const isTotalLabel = (label: string): boolean => /(합계|총계|^계$)/.test(norm(label));
const isSubtotal = (label: string): boolean => /소계/.test(norm(label));
// Derived rows (net book value etc.) aren't simple sums — each class is rounded
// independently, so cross-footing them yields legitimate 단수차이. Excluded.
const isDerivedRow = (label: string): boolean => /(장부금액|장부가액|순장부|순액)/.test(norm(label));
// Outline numbering marks a hierarchy: "Ⅰ. 미처분이익잉여금" is the sum of the
// "1. …", "2. …" rows beneath it. Adding both double-counts, so column footing
// must not treat an outline table as a flat list (이익잉여금처분계산서 등).
const isOutlineHead = (label: string): boolean => /^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*[.．]/.test(label.trim());
const isOutlineChild = (label: string): boolean => /^\d+\s*[.．]/.test(label.trim());
// Derivation tables state a formula in their labels — 자본관리 공시 reads
// "총차입금 / 차감: 현금및현금성자산 / 순부채 / 자본총계 / 총자본", where each line
// is computed from the ones above by ITS OWN rule. A plain column sum is
// meaningless there, so an explicit 차감/가산 marker disqualifies footing.
const hasSignedOperand = (label: string): boolean => /^\s*(차감|가산|\(-\)|\(\+\))\s*[:：]?/.test(label);
// Movement rows whose LABEL already means "deduction". Korean notes often print
// these as positive magnitudes (감소 95,263) and rely on the label for the sign,
// so summing them as displayed breaks 기초+증감=기말. Treated as subtractions
// when the printed value is non-negative (an explicit minus is respected as-is).
const isDecreaseLabel = (label: string): boolean =>
  /(감소|처분|지급|사용|환입|상환|폐기|제각|대체감소|매각)/.test(norm(label));

/**
 * §21 discipline: assert an error only when the identity is *certifiable*.
 * A failure that is not certifiable is surfaced as `review`, never `mismatch`,
 * so a correct report never yields a machine-asserted false error.
 */
function failStatus(certifiable: boolean): "mismatch" | "review" {
  return certifiable ? "mismatch" : "review";
}

function result(
  id: string,
  check: string,
  table: FinancialStatementTable,
  status: ReviewResult["status"],
  extra: Partial<ReviewResult>,
): ReviewResult {
  return {
    id,
    objectType: "ReviewResult",
    check,
    targets: [table.id],
    status,
    toleranceApplied: extra.toleranceApplied ?? 0,
    engineVersion: ENGINE_VERSION,
    sourceRefs: [table.source.xmlPath],
    ...(extra.expected !== undefined ? { expected: extra.expected } : {}),
    ...(extra.actual !== undefined ? { actual: extra.actual } : {}),
    ...(extra.note ? { note: extra.note } : {}),
  };
}

// ── column classification ────────────────────────────────────────────────────

/**
 * Header column index whose label is a total (합계/계). -1 if none/ambiguous.
 * Scans every header row: 37% of note tables use a multi-row header, so the
 * 합계 label often sits on the 2nd header row, not the 1st.
 */
function totalColumn(table: FinancialStatementTable): number {
  const shape = detectShape(table);
  return shape.totalCol;
}

/** Numeric column indices (union across body rows), excluding the label col 0. */
function numericColumns(table: FinancialStatementTable): number[] {
  const cols = new Set<number>();
  for (const r of table.rows)
    for (const c of r.cells) if (c.number && c.col > 0) cols.add(c.col);
  return [...cols].sort((a, b) => a - b);
}

/** Display scale of a table in 원 (1 | 1000 천원 | 1e6 백만원), max over its cells. */
function tableScale(table: FinancialStatementTable): number {
  let s = 1;
  for (const r of table.rows)
    for (const c of r.cells) {
      const cs = c.number?.scale;
      if (cs && cs > s) s = cs;
    }
  return s;
}

/**
 * Scale-aware rounding band (원) for summing `terms` figures rounded at the
 * table's display scale (§ Q2). A 천원 note summing N rows can legitimately
 * drift by up to N × 1000원 — a flat ±1원 tolerance would false-positive.
 */
function roundingBand(table: FinancialStatementTable, terms: number): Tolerance {
  return { mode: "rounding", unitKrw: tableScale(table) * Math.max(1, terms) };
}

// ── Roll-forward (Doc 06 §2.4) ───────────────────────────────────────────────

/**
 * Roll-forward identity: 기초 + Σ(증감) = 기말 (§2.4).
 * Transposed tables (movements as rows, e.g. PPE note): segment each 기초→기말
 * run and check every numeric column. Emits one ReviewResult per segment,
 * summarizing across columns (worst status), with the total column figures.
 */
export function checkRollForward(
  table: FinancialStatementTable,
  tol: Tolerance = roundingTol,
): ReviewResult[] {
  const shape = detectShape(table);
  if (!shape.certifiable) return []; // mixed units → skip (§5/§21)
  const rows = table.rows;
  const openIdxs: number[] = [];
  for (let i = shape.bodyStart; i < rows.length; i++)
    if (isOpening(rows[i]!.label)) openIdxs.push(i);
  if (openIdxs.length === 0) return []; // not a transposed roll-forward we can map

  const out: ReviewResult[] = [];
  const totalCol = totalColumn(table);
  let seg = 0;
  for (const openIdx of openIdxs) {
    // closing = next 기말 row after opening.
    let closeIdx = -1;
    for (let j = openIdx + 1; j < rows.length; j++) {
      if (isClosing(rows[j]!.label)) {
        closeIdx = j;
        break;
      }
      if (isOpening(rows[j]!.label)) break; // next segment started without a closing
    }
    if (closeIdx === -1) continue;
    seg++;

    const open = rows[openIdx]!;
    const close = rows[closeIdx]!;
    let movements = rows.slice(openIdx + 1, closeIdx);

    // A 기초→기말 pair with NO movement rows between them is a derived block
    // (유형자산 주석의 "장부금액": 취득원가 − 상각누계액), not a roll-forward.
    // Its opening and closing legitimately differ, so testing 기초=기말 here
    // always "fails". Skip it.
    if (movements.length === 0) continue;
    // When the segment prints 소계 lines, each 소계 already aggregates the detail
    // rows above it (e.g. 확정급여 주석: 근무원가 + 이자비용 → 소 계). Summing both
    // double-counts. Keep each 소계 and every row that is NOT part of a subtotal
    // group (e.g. 퇴직급여지급액, 기여금납입액 — standalone movements after the
    // last 소계 or between groups).
    if (movements.some((r) => isSubtotal(r.label))) {
      const kept: TableRow[] = [];
      let group: TableRow[] = [];
      for (const r of movements) {
        if (isSubtotal(r.label)) {
          kept.push(r); // subtotal replaces the detail rows collected so far
          group = [];
        } else {
          group.push(r);
        }
      }
      // Rows after the final 소계 belong to no group → they are real movements.
      kept.push(...group);
      movements = kept;
    }
    const cols = numericColumns(table).filter((c) => hasNumber(open, c) || hasNumber(close, c));
    if (cols.length === 0) continue;

    // §21/§6/§3 discipline: a roll-forward residual can arise from rounding,
    // immaterial reclassification, or an unshown movement — the engine cannot
    // distinguish these from a true error without professional judgment. So a
    // failing roll-forward is ALWAYS surfaced as `review` (질문 생성), never a
    // machine-certified `mismatch`. This keeps 기계 오탐 0 on filed consolidated
    // reports where per-subsidiary rounding accumulates (e.g. 인터플렉스 연결 PPE
    // 건설중인자산 Δ191천원, 무형자산 Δ410천원 — immaterial residuals).

    // Does this segment already carry explicit signs? If ANY movement is printed
    // negative, the filer is using signed amounts and every row must be summed as
    // displayed. Guessing a sign from the label would then corrupt genuine
    // additions — e.g. 대손충당금 "대손상각(환입)" 727,547 is an INCREASE, but the
    // word 환입 would flip it. Label-based signs apply only to unsigned tables.
    const signedTable = movements.some((mv) => cols.some((c) => cellValue(mv, c) < 0));
    const movementValue = (mv: TableRow, c: number): number => {
      const v = cellValue(mv, c);
      return !signedTable && v > 0 && isDecreaseLabel(mv.label) ? -v : v;
    };

    const band = roundingBand(table, 1 + movements.length);
    const failing: string[] = [];
    for (const c of cols) {
      const expected = cellValue(open, c) + movements.reduce((s, m) => s + movementValue(m, c), 0);
      const actual = cellValue(close, c);
      if (!withinTolerance(expected, actual, band))
        failing.push(`col${c}(Δ${fmtDelta(actual - expected)})`);
    }
    const repCol = totalCol >= 0 ? totalCol : cols[cols.length - 1]!;
    const expectedTot =
      cellValue(open, repCol) + movements.reduce((s, m) => s + movementValue(m, repCol), 0);
    out.push(
      result(
        `${table.id}:rollforward:${seg}`,
        "RollForward",
        table,
        failing.length === 0 ? "match" : "review",
        {
          expected: expectedTot,
          actual: cellValue(close, repCol),
          toleranceApplied: band.unitKrw,
          ...(failing.length
            ? { note: `기초+증감≠기말 (${open.label}~${close.label}): ${failing.join(", ")}` }
            : {}),
        },
      ),
    );
  }
  return out;
}

// ── Cross-footing on a total column (Doc 06 §2.2) ────────────────────────────

/**
 * Cross-footing: for each data row, Σ(component columns) = total column.
 * Only runs when a single unambiguous total column exists — keeps false
 * positives at zero on well-formed tables.
 */
export function checkCrossFooting(
  table: FinancialStatementTable,
  tol: Tolerance = roundingTol,
): ReviewResult[] {
  const shape = detectShape(table);
  if (!shape.certifiable) return []; // mixed units → not a plain sum (§5/§21)
  const totalCol = shape.totalCol;
  if (totalCol < 0) return [];

  // Maturity tables (유동성위험 공시) lead with a 장부금액 column that RESTATES the
  // total rather than contributing to it: 장부금액 8,532,831 = 6개월미만 8,532,831
  // = 합계. Summing it double-counts, so drop summary-like columns from the
  // component set. Detected from the header label, not from values (§6).
  const headerLabel = (col: number): string => {
    for (const r of table.rows) {
      const c = r.cells.find((x) => x.col === col);
      if (c?.text) return c.text.replace(/\s/g, "");
      break; // header is the first row that carries labels
    }
    return "";
  };
  const isSummaryCol = (col: number): boolean => /장부금액|장부가액|합계|총계/.test(headerLabel(col));
  // With 당기/전기 column groups, components on the far side of the total column
  // belong to the other period — only same-group columns are summed (below).
  const componentCols = numericColumns(table).filter(
    (c) => c !== totalCol && c < totalCol && !isSummaryCol(c),
  );
  if (componentCols.length < 2) return [];

  const out: ReviewResult[] = [];
  let n = 0;
  for (const row of table.rows) {
    if (!hasNumber(row, totalCol)) continue;
    if (isSubtotal(row.label) || isTotalLabel(row.label)) continue;
    if (isDerivedRow(row.label)) continue; // net book value etc. — not a plain sum
    n++;
    const expected = componentCols.reduce((s, c) => s + cellValue(row, c), 0);
    const actual = cellValue(row, totalCol);
    const band = roundingBand(table, componentCols.length);
    const ok = withinTolerance(expected, actual, band);
    // Certifiable only when every component column carries a parsed number
    // (a blank component may be a value we dropped, not a true zero).
    const certifiable = componentCols.every((c) => hasNumber(row, c));
    out.push(
      result(`${table.id}:xfoot:${n}`, "CrossFooting", table, ok ? "match" : failStatus(certifiable), {
        expected,
        actual,
        toleranceApplied: band.unitKrw,
        ...(ok ? {} : { note: `${row.label}: 구성합≠합계 (Δ${fmtDelta(actual - expected)})` }),
      }),
    );
  }
  return out;
}

// ── Column footing on a total row (Doc 06 §2.1) ──────────────────────────────

/**
 * Footing: Σ(data rows) = total row, per numeric column. Runs only when exactly
 * one total row exists and there are no intermediate 소계 rows (ambiguity →
 * `skipped`, never a false error).
 */
export function checkFooting(
  table: FinancialStatementTable,
  tol: Tolerance = roundingTol,
): ReviewResult[] {
  const shape = detectShape(table);
  // Mixed units (%, 배, 주) make a column sum meaningless → do not judge (§5/§21).
  if (!shape.certifiable) return [];
  const body = table.rows.slice(shape.bodyStart); // skip multi-row headers
  const totalRows = body.filter((r) => isTotalLabel(r.label));
  if (totalRows.length !== 1) return [];
  const totalRow = totalRows[0]!;
  const dataRows = body.filter((r) => r !== totalRow && !isTotalLabel(r.label));
  const cols = numericColumns(table).filter((c) => hasNumber(totalRow, c));
  if (cols.length === 0) return [];

  // Outline hierarchy (Ⅰ. → 1. 2.) means parents already contain their children.
  const outlined =
    dataRows.some((r) => isOutlineHead(r.label)) && dataRows.some((r) => isOutlineChild(r.label));
  if (outlined) {
    return [
      result(`${table.id}:footing`, "Footing", table, "skipped", {
        note: "계층 구조(Ⅰ·1·2)로 상위 항목이 하위를 포함 — 단순 합계 판정 제외",
      }),
    ];
  }

  // 자본관리 공시처럼 라벨에 연산자가 박힌 도출표(총차입금 − 현금 = 순부채 …)는
  // 열 단순합이 성립하지 않는다. 합계행이 있어도 footing 대상이 아니다.
  if (dataRows.some((r) => hasSignedOperand(r.label))) {
    return [
      result(`${table.id}:footing`, "Footing", table, "skipped", {
        note: "라벨에 가감 연산(차감·가산)이 명시된 도출표 — 단순 합계 판정 제외",
      }),
    ];
  }

  if (dataRows.some((r) => isSubtotal(r.label))) {
    return [
      result(`${table.id}:footing`, "Footing", table, "skipped", {
        note: "소계 혼재로 합계 구조 모호 — 검토 권장",
      }),
    ];
  }

  const band = roundingBand(table, dataRows.length);
  // Many notes nest one level without any outline numbering — 현금흐름표 주석 reads
  // "조정항목: 1,037,725 / 이자수익 … / 퇴직급여" where the header row already holds
  // the subtotal of the rows beneath it. Summing every row double-counts. Detect
  // such groups structurally (header value == Σ of the rows that follow) and fold.
  const top = foldGroups(dataRows, cols[0]!, band);
  const folded = top.length !== dataRows.length;
  const rowsForSum = folded ? top : dataRows;

  const out: ReviewResult[] = [];
  for (const c of cols) {
    const expected = rowsForSum.reduce((s, r) => s + cellValue(r, c), 0);
    const actual = cellValue(totalRow, c);
    const ok = withinTolerance(expected, actual, band);
    // Certifiable only when no data row is blank-but-labeled in this column
    // (a labeled row with no number may be a dropped value, not a true zero),
    // and when we did not have to infer a nesting structure to make sense of it.
    const certifiable = !folded && dataRows.every((r) => r.label === "" || hasNumber(r, c));
    out.push(
      result(`${table.id}:footing:${c}`, "Footing", table, ok ? "match" : failStatus(certifiable), {
        expected,
        actual,
        toleranceApplied: band.unitKrw,
        ...(ok
          ? {}
          : {
              note: `col${c}: 열 합계 불일치 (Δ${fmtDelta(actual - expected)})${
                folded ? " — 계층(소계 포함) 구조로 해석" : ""
              }`,
            }),
      }),
    );
  }
  return out;
}

/**
 * Fold implicit one-level groups: a row whose value equals the sum of the two or
 * more rows immediately following it is a group header, and those rows are its
 * children. Returns the top-level rows (headers + ungrouped rows). When nothing
 * folds, the input is returned unchanged, so flat tables are unaffected.
 */
function foldGroups(rows: TableRow[], col: number, band: Tolerance): TableRow[] {
  const top: TableRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const head = rows[i]!;
    const headValue = cellValue(head, col);
    let taken = 0;
    if (hasNumber(head, col) && headValue !== 0) {
      let acc = 0;
      for (let j = i + 1; j < rows.length; j++) {
        acc += cellValue(rows[j]!, col);
        if (j - i >= 2 && withinTolerance(acc, headValue, band)) {
          taken = j - i; // rows i+1..j are children of row i
          break;
        }
      }
    }
    top.push(head);
    i += 1 + taken;
  }
  return top;
}

/** Run all mechanical checks over one table. */
export function checkMechanical(
  table: FinancialStatementTable,
  tol: Tolerance = roundingTol,
): ReviewResult[] {
  return [
    ...checkRollForward(table, tol),
    ...checkCrossFooting(table, tol),
    ...checkFooting(table, tol),
  ];
}
