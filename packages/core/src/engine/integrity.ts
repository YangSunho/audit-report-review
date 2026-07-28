// Financial Statement Integrity — 재무제표 무결성 (Doc 06 §6). Deterministic, exact (§10).
//  · 대차평균: 자산총계 = 부채와자본총계 = 부채총계 + 자본총계 (1원 단위, exact).
//  · Anchor cross-check: BS/IS 총계를 SUMMARY EXTRACTION(백만원 단위) 앵커와 대조.
// Exact by default (Doc 06 §6): 단수차이조차 노출. Anchor는 표시단위(백만원) 반올림 대조.

import type { AomObject, FinancialStatementLine, ReviewResult } from "../aom/types.js";
import { ENGINE_VERSION } from "./types.js";
import { fmtWon } from "../labels.js";

const MILLION = 1_000_000;

function norm(s: string): string {
  return s.replace(/\s/g, "");
}

function findLine(
  lines: FinancialStatementLine[],
  pred: (acct: string) => boolean,
): FinancialStatementLine | undefined {
  return lines.find((l) => pred(norm(l.account)));
}

function mk(
  id: string,
  check: string,
  status: ReviewResult["status"],
  targets: string[],
  extra: Partial<ReviewResult>,
): ReviewResult {
  return {
    id,
    objectType: "ReviewResult",
    check,
    targets,
    status,
    toleranceApplied: extra.toleranceApplied ?? 0,
    engineVersion: ENGINE_VERSION,
    sourceRefs: extra.sourceRefs ?? [],
    ...(extra.expected !== undefined ? { expected: extra.expected } : {}),
    ...(extra.actual !== undefined ? { actual: extra.actual } : {}),
    ...(extra.note ? { note: extra.note } : {}),
  };
}

export function checkFsIntegrity(objects: AomObject[]): ReviewResult[] {
  const bs = objects.filter(
    (o): o is FinancialStatementLine =>
      o.objectType === "FinancialStatementLine" && o.statement === "BS",
  );
  const is = objects.filter(
    (o): o is FinancialStatementLine =>
      o.objectType === "FinancialStatementLine" && o.statement === "IS",
  );
  const doc = objects.find((o) => o.objectType === "Document");
  const extractions = doc?.objectType === "Document" ? doc.extractions : {};

  const out: ReviewResult[] = [];

  const assetTotal = findLine(bs, (a) => a.includes("자산총계"));
  const liabTotal = findLine(bs, (a) => a === "부채총계");
  const equityTotal = findLine(bs, (a) => a === "자본총계");
  const liabEquityTotal = findLine(bs, (a) => /부채와자본총계|부채및자본총계/.test(a));

  // 대차평균 (exact): 자산총계 == 부채와자본총계.
  if (assetTotal && liabEquityTotal) {
    const a = assetTotal.amount.current.value;
    const le = liabEquityTotal.amount.current.value;
    out.push(
      mk("fsintegrity:balance", "FsBalance", a === le ? "match" : "mismatch", [
        assetTotal.id,
        liabEquityTotal.id,
      ], {
        expected: a,
        actual: le,
        sourceRefs: [assetTotal.source.xmlPath, liabEquityTotal.source.xmlPath],
        ...(a === le ? {} : { note: `대차 불일치: 자산총계 ${a} ≠ 부채와자본총계 ${le}` }),
      }),
    );
  }

  // 자산총계 == 부채총계 + 자본총계 (exact).
  if (assetTotal && liabTotal && equityTotal) {
    const a = assetTotal.amount.current.value;
    const sum = liabTotal.amount.current.value + equityTotal.amount.current.value;
    out.push(
      // 별도 check 코드를 쓰는 이유: 위 대차평균과 기대·실제 값이 같아 보고서에서
      // 두 행이 구분되지 않았다. 검증 이름으로 무엇을 대조했는지 드러낸다.
      mk("fsintegrity:asset=liab+equity", "FsBalanceComponents", a === sum ? "match" : "mismatch", [
        assetTotal.id,
        liabTotal.id,
        equityTotal.id,
      ], {
        expected: a,
        actual: sum,
        sourceRefs: [assetTotal.source.xmlPath],
        ...(a === sum ? {} : { note: `자산총계 ${fmtWon(a)} ≠ 부채+자본 ${fmtWon(sum)}` }),
      }),
    );
  }

  // Anchor cross-checks (백만원 단위 반올림 대조).
  const anchor = (
    code: string,
    line: FinancialStatementLine | undefined,
    label: string,
  ): void => {
    const raw = extractions[code];
    if (!line || raw === undefined || raw === "" || !/^\d+$/.test(raw)) return;
    const anchorVal = Number(raw); // 백만원
    const actualMillions = Math.round(line.amount.current.value / MILLION);
    const ok = actualMillions === anchorVal;
    out.push(
      mk(`fsintegrity:anchor:${code}`, "FsAnchor", ok ? "match" : "review", [line.id], {
        expected: anchorVal * MILLION,
        actual: line.amount.current.value,
        toleranceApplied: MILLION,
        sourceRefs: [line.source.xmlPath],
        note: ok
          ? `${label} ≈ ${code} ${anchorVal}백만원`
          : `표지 요약(${code} ${anchorVal}백만원)이 감사받은 ${label} 당기(${actualMillions}백만원)과 상이 — 재무제표 값이 기준이며 표지 요약수치 확인이 권장됩니다`,
      }),
    );
  };
  anchor("TOT_ASSETS", assetTotal, "자산총계");
  anchor("TOT_DEBTS", liabTotal, "부채총계");
  anchor("TOT_SALES", is.find((l) => norm(l.account) === "매출액"), "매출액");

  return out;
}
