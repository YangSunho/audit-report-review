// Variance analysis — 당기 vs 전기 증감액·증감율 with significance flags.
//
// Replaces the old "BS 발췌" dump (which just restated the source). What an
// auditor actually does first is scan for movements worth explaining, so the
// report leads with 증감 and marks what deserves attention.
//
// Pure & deterministic (§19). Only the parsed figures are used; the ratio is a
// presentation-level computation over quoted values (no accounting judgment).

import type { FinancialStatementLine, Statement } from "../aom/types.js";
import type { AomModel } from "../aom/builder.js";

export interface VarianceRow {
  account: string;
  current: number;
  prior?: number;
  delta?: number;
  /** Percent change vs prior, undefined when prior is 0/absent. */
  pct?: number;
  /** Flagged when the movement is large in both relative and absolute terms. */
  significant: boolean;
  reason?: string;
  noteRef: string[];
  xmlPath: string;
}

export interface VarianceSection {
  statement: Statement;
  title: string;
  rows: VarianceRow[];
}

const TITLES: Partial<Record<Statement, string>> = {
  BS: "재무상태표",
  IS: "손익계산서",
  CF: "현금흐름표",
  SCE: "자본변동표",
};

/**
 * Significance: a movement matters when it is BOTH relatively large (≥30%) and
 * material in size (≥1% of the statement's largest line) — relative-only flags
 * every tiny account, absolute-only flags every big one.
 */
function markSignificant(rows: VarianceRow[]): void {
  const scale = rows.reduce((m, r) => Math.max(m, Math.abs(r.current)), 0);
  const materialityFloor = scale * 0.01;
  for (const r of rows) {
    if (r.delta === undefined || r.pct === undefined) continue;
    const big = Math.abs(r.delta) >= materialityFloor;
    const steep = Math.abs(r.pct) >= 30;
    if (big && steep) {
      r.significant = true;
      r.reason = `전기 대비 ${r.pct > 0 ? "증가" : "감소"} ${Math.abs(Math.round(r.pct))}%`;
    } else if (r.prior === 0 && r.current !== 0) {
      r.significant = true;
      r.reason = "전기 잔액 없음(신규)";
    }
  }
}

export function buildVariance(model: AomModel): VarianceSection[] {
  const lines = model.objects.filter(
    (o): o is FinancialStatementLine => o.objectType === "FinancialStatementLine",
  );
  const out: VarianceSection[] = [];

  for (const st of ["BS", "IS", "CF"] as Statement[]) {
    const rows: VarianceRow[] = lines
      .filter((l) => l.statement === st)
      .map((l) => {
        const current = l.amount.current.value;
        const prior = l.amount.prior?.value;
        const delta = prior !== undefined ? current - prior : undefined;
        const pct =
          prior !== undefined && prior !== 0 && delta !== undefined
            ? (delta / Math.abs(prior)) * 100
            : undefined;
        return {
          account: l.account,
          current,
          ...(prior !== undefined ? { prior } : {}),
          ...(delta !== undefined ? { delta } : {}),
          ...(pct !== undefined ? { pct } : {}),
          significant: false,
          noteRef: l.noteRef,
          xmlPath: l.source.xmlPath,
        };
      });
    if (rows.length === 0) continue;
    markSignificant(rows);
    out.push({ statement: st, title: TITLES[st] ?? st, rows });
  }
  return out;
}
