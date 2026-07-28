// Review coverage — WHAT was checked, item by item, and what came out.
//
// This is the product's core deliverable: an auditor needs evidence that the
// review was performed (감사조서), not just a list of exceptions. Two tables
// with zero issues are not "nothing to report" — they are two tables that were
// footed and tied out, and that fact belongs in the file.
//
// Pure & deterministic (§19); quotes engine output only (§6).

import type { AomObject, FinancialStatementTable, ReviewResult } from "../aom/types.js";
import type { AomModel } from "../aom/builder.js";
import type { EngineReport } from "../engine/run.js";
import { objectLabel, noteTitleMap, checkKo, humanLocation } from "../labels.js";

/**
 * What each check actually does, in auditor language. Shown next to the result
 * so "전부 일치" means something concrete: WHAT was compared to WHAT.
 */
export const CHECK_METHOD: Record<string, string> = {
  Footing: "표의 각 열에서 세부 항목 금액을 합산해 표시된 합계행과 대조",
  CrossFooting: "각 행에서 구성 항목 금액을 합산해 표시된 합계열과 대조",
  RollForward: "기초금액 + 증감내역 = 기말금액 항등식 성립 여부 확인",
  ReferenceResolve: "본문·표의 주석 참조번호가 실제 존재하는 주석을 가리키는지 대조",
  FsBalance: "재무상태표 자산총계와 부채와자본총계를 1원 단위로 대조",
  FsBalanceComponents: "자산총계 = 부채총계 + 자본총계 성립 여부 확인",
  EquityRollForward: "자본변동표의 자본 항목별로 기초잔액 + 당기 변동 = 기말잔액 확인",
  EquityToBs: "자본변동표 기말잔액을 재무상태표의 자본 각 계정과 대조",
  NetIncomeToEquity: "손익계산서 당기순이익이 자본변동표에 그대로 전기되었는지 대조",
  ComprehensiveIncomeToEquity:
    "손익계산서 총포괄손익을 자본변동표의 손익성 변동(당기순손익+기타포괄손익) 합계와 대조",
  DividendToCashFlow: "자본변동표의 배당금을 현금흐름표의 배당금 지급액과 대조",
  FsAnchor: "재무제표 본문 금액을 DART 표지 요약수치(백만원)와 대조",
  CashTieOut: "현금흐름표 기말현금을 재무상태표 현금및현금성자산과 대조",
  CashFlowRollForward: "기초현금 + 증감 + 환율효과 = 기말현금 확인",
  CashFlowPpeAcq: "현금흐름표 유형자산 취득액을 유형자산 주석의 취득란과 대조",
  CrossNoteDepreciation: "여러 주석의 감가상각비를 집계해 상호 정합 확인",
};

export function checkMethod(check: string): string {
  return CHECK_METHOD[check] ?? "결정론 검증 수행";
}

export interface CoverageCheck {
  check: string; // engine check code
  checkKo: string; // Korean name
  count: number;
  match: number;
  review: number;
  mismatch: number;
  skipped: number;
}

export interface CoverageItem {
  /** Sort key: note number then caption, so 22.1 precedes 22.4. */
  sortKey: string;
  item: string; // "주석22. 퇴직급여 — 22.3 순확정급여부채의 변동내역"
  /** Reader-facing location ("주석13. 유형자산 · 13.1 …(p.24)"), not an XML path. */
  location: string;
  xmlPath: string; // kept for traceability (§20), not shown by default
  page?: number;
  checks: CoverageCheck[];
  total: number;
  worst: "match" | "review" | "mismatch" | "skipped";
  /** One-line plain-Korean summary of what was done and what came out. */
  summary: string;
  /** HOW each check was performed (method), for the detail column. */
  methods: string[];
  /** Why a check could not be concluded (only when worst = skipped/review). */
  reasons: string[];
}

const ORDER: Record<string, number> = { mismatch: 0, review: 1, skipped: 2, match: 3 };

function worstOf(results: ReviewResult[]): CoverageItem["worst"] {
  let w: CoverageItem["worst"] = "match";
  for (const r of results) if (ORDER[r.status]! < ORDER[w]!) w = r.status;
  return w;
}

function numericPrefix(caption: string | undefined): number[] {
  const m = caption?.match(/(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : [999, 999];
}

/**
 * Build the per-item coverage list: every AOM table that the engine actually
 * examined, with the checks applied and their outcome.
 */
export function buildCoverage(model: AomModel, engine: EngineReport): CoverageItem[] {
  const objects = model.objects;
  const notes = noteTitleMap(objects);
  const byId = new Map<string, AomObject>(objects.map((o) => [o.id, o]));

  // Group results by their primary target object.
  const grouped = new Map<string, ReviewResult[]>();
  for (const r of engine.results) {
    const id = r.targets[0];
    if (!id) continue;
    const list = grouped.get(id);
    if (list) list.push(r);
    else grouped.set(id, [r]);
  }

  const items: CoverageItem[] = [];
  for (const [id, results] of grouped) {
    const o = byId.get(id);
    if (!o) continue;

    const byCheck = new Map<string, CoverageCheck>();
    for (const r of results) {
      let c = byCheck.get(r.check);
      if (!c) {
        c = {
          check: r.check,
          checkKo: checkKo(r.check),
          count: 0,
          match: 0,
          review: 0,
          mismatch: 0,
          skipped: 0,
        };
        byCheck.set(r.check, c);
      }
      c.count++;
      c[r.status]++;
    }
    const checks = [...byCheck.values()].sort((a, b) => a.check.localeCompare(b.check));
    const worst = worstOf(results);
    const done = checks.map((c) => `${c.checkKo} ${c.count}건`).join(" · ");
    const outcome =
      worst === "match"
        ? "전부 일치"
        : worst === "review"
          ? `검토 권장 ${checks.reduce((s, c) => s + c.review, 0)}건`
          : worst === "mismatch"
            ? `불일치 ${checks.reduce((s, c) => s + c.mismatch, 0)}건`
            : "판정 보류(구조 모호)";

    const table = o.objectType === "FinancialStatementTable" ? (o as FinancialStatementTable) : undefined;
    const [a, b] = numericPrefix(table?.caption ?? (table?.note ? `${table.note}.0` : undefined));
    // Methods: what each performed check actually compares.
    const methods = checks.map((c) => `${c.checkKo}: ${checkMethod(c.check)}`);
    // Reasons: why anything was not concluded (engine note carries the cause).
    const reasons = [
      ...new Set(
        results
          .filter((r) => r.status === "skipped" || r.status === "review")
          .map((r) => r.note)
          .filter((n): n is string => !!n),
      ),
    ];
    items.push({
      sortKey: `${String(a).padStart(3, "0")}.${String(b).padStart(3, "0")}`,
      item: objectLabel(o, notes),
      location: humanLocation(o, notes),
      xmlPath: o.source.xmlPath,
      ...(o.source.page !== undefined ? { page: o.source.page } : {}),
      checks,
      total: results.length,
      worst,
      summary: `${done} → ${outcome}`,
      methods,
      reasons,
    });
  }

  return items.sort((x, y) => x.sortKey.localeCompare(y.sortKey) || x.item.localeCompare(y.item));
}

/** Roll-up of all checks performed, for the report header. */
export function coverageTotals(items: CoverageItem[]): {
  items: number;
  checks: number;
  clean: number;
} {
  return {
    items: items.length,
    checks: items.reduce((s, i) => s + i.total, 0),
    clean: items.filter((i) => i.worst === "match").length,
  };
}
