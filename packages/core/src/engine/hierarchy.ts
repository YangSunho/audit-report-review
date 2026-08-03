// Hierarchy & Multi-step Footing Engine — Doc 06 확장.
// 4대 재무제표(BS, IS, SCE, CF) 본문 전수 계층 구조(Tree) 재구성 및 Bottom-Up 가감 Footing / Tie-out 검증.

import type { FinancialStatementLine, ReviewResult } from "../aom/types.js";
import { ENGINE_VERSION, withinTolerance, type Tolerance } from "./types.js";
import { fmtWon, fmtDelta } from "../labels.js";

const roundingTol: Tolerance = { mode: "rounding", unitKrw: 1 };

function norm(s: string): string {
  return s.replace(/\s/g, "");
}

/** 차감 계정 라벨 판별 (대손충당금, 감가상각누계액, 차감, (-) 등) */
function isDeductionAccount(label: string): boolean {
  const n = norm(label);
  return /(차감|대손충당금|감가상각누계액|손상차손누계액|정부보조금|현재가치할인차금|자기주식|\(-\))/.test(n);
}

/** §21 FP discipline: 구조적 확증 불가능 시 mismatch 대신 review 적용 */
function failStatus(certifiable: boolean): "mismatch" | "review" {
  return certifiable ? "mismatch" : "review";
}

function result(
  id: string,
  check: string,
  targets: string[],
  status: ReviewResult["status"],
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
    ...(extra.subject ? { subject: extra.subject } : {}),
  };
}

// ── 계정명 정밀 매칭 도우미 ───────────────────────────────────────────────

function isAssetTotal(a: string): boolean {
  const n = norm(a);
  return n === "자산총계" || n.endsWith("자산총계");
}

function isCurrentAsset(a: string): boolean {
  const n = norm(a);
  return /^([Ⅰ1]\.?)?유동자산$/.test(n);
}

function isNonCurrentAsset(a: string): boolean {
  const n = norm(a);
  return /^([Ⅱ2]\.?)?비유동자산$/.test(n);
}

function isLiabTotal(a: string): boolean {
  const n = norm(a);
  return n === "부채총계" || n.endsWith("부채총계");
}

function isCurrentLiab(a: string): boolean {
  const n = norm(a);
  return /^([Ⅰ1]\.?)?유동부채$/.test(n);
}

function isNonCurrentLiab(a: string): boolean {
  const n = norm(a);
  return /^([Ⅱ2]\.?)?비유동부채$/.test(n);
}

function isEquityTotal(a: string): boolean {
  const n = norm(a);
  return n === "자본총계" || n.endsWith("자본총계");
}

function isSales(a: string): boolean {
  const n = norm(a);
  return n === "매출액" || n === "수익" || n === "수익(매출액)";
}

function isCogs(a: string): boolean {
  const n = norm(a);
  return n === "매출원가" || n === "영업비용(매출원가)";
}

function isGrossProfit(a: string): boolean {
  const n = norm(a);
  return n === "매출총이익" || n === "매출총손익" || n === "매출총이익(손실)";
}

function isSga(a: string): boolean {
  const n = norm(a);
  return n === "판매비와관리비" || n === "판매비와 관리비";
}

function isOperatingProfit(a: string): boolean {
  const n = norm(a);
  return n === "영업이익" || n === "영업이익(손실)" || n === "영업손익";
}

function isPbt(a: string): boolean {
  const n = norm(a);
  return n.includes("차감전") && (n.includes("법인세") || n.includes("순이익") || n.includes("순손익"));
}

function isTax(a: string): boolean {
  const n = norm(a);
  return (n === "법인세비용" || n === "법인세비용(수익)") && !n.includes("차감전");
}

function isNetIncome(a: string): boolean {
  const n = norm(a);
  return (n === "당기순이익" || n === "당기순손익" || n === "연결당기순이익" || n === "당기순이익(손실)") && !n.includes("차감전") && !n.includes("포괄");
}

// ── 1. 재무상태표 (BS) 계층 Footing ──────────────────────────────────────────

export function checkBsHierarchy(lines: FinancialStatementLine[]): ReviewResult[] {
  const bsLines = lines.filter((l) => l.statement === "BS");
  if (bsLines.length === 0) return [];

  const out: ReviewResult[] = [];

  const totalAsset = bsLines.find((l) => isAssetTotal(l.account));
  const currentAsset = bsLines.find((l) => isCurrentAsset(l.account));
  const nonCurrentAsset = bsLines.find((l) => isNonCurrentAsset(l.account));

  const totalLiab = bsLines.find((l) => isLiabTotal(l.account));
  const currentLiab = bsLines.find((l) => isCurrentLiab(l.account));
  const nonCurrentLiab = bsLines.find((l) => isNonCurrentLiab(l.account));

  const totalEquity = bsLines.find((l) => isEquityTotal(l.account));

  // [1-1] 자산총계 = 유동자산 + 비유동자산
  if (totalAsset && currentAsset && nonCurrentAsset) {
    const expected = currentAsset.amount.current.value + nonCurrentAsset.amount.current.value;
    const actual = totalAsset.amount.current.value;
    const ok = withinTolerance(expected, actual, roundingTol);
    out.push(
      result(
        "bs:hierarchy:assets",
        "BsAssetStructure",
        [totalAsset.id, currentAsset.id, nonCurrentAsset.id],
        ok ? "match" : "review", // §21: 표구조 모호 시 review
        {
          expected,
          actual,
          sourceRefs: [totalAsset.source.xmlPath],
          subject: "자산총계 계층구조",
          ...(ok ? {} : { note: `자산총계(${fmtWon(actual)}) ≠ 유동자산+비유동자산(${fmtWon(expected)}) [Δ${fmtDelta(actual - expected)}]` }),
        },
      ),
    );
  }

  // [1-2] 부채총계 = 유동부채 + 비유동부채
  if (totalLiab && currentLiab && nonCurrentLiab) {
    const expected = currentLiab.amount.current.value + nonCurrentLiab.amount.current.value;
    const actual = totalLiab.amount.current.value;
    const ok = withinTolerance(expected, actual, roundingTol);
    out.push(
      result(
        "bs:hierarchy:liabilities",
        "BsLiabStructure",
        [totalLiab.id, currentLiab.id, nonCurrentLiab.id],
        ok ? "match" : "review",
        {
          expected,
          actual,
          sourceRefs: [totalLiab.source.xmlPath],
          subject: "부채총계 계층구조",
          ...(ok ? {} : { note: `부채총계(${fmtWon(actual)}) ≠ 유동부채+비유동부채(${fmtWon(expected)}) [Δ${fmtDelta(actual - expected)}]` }),
        },
      ),
    );
  }

  // [1-3] 유동자산 세부 항목 Footing
  if (currentAsset && nonCurrentAsset) {
    const cAssetIdx = bsLines.indexOf(currentAsset);
    const ncAssetIdx = bsLines.indexOf(nonCurrentAsset);
    if (cAssetIdx >= 0 && ncAssetIdx > cAssetIdx + 1) {
      const subItems = bsLines.slice(cAssetIdx + 1, ncAssetIdx);
      if (subItems.length >= 2) {
        let sum = 0;
        for (const item of subItems) {
          const val = item.amount.current.value;
          sum += isDeductionAccount(item.account) && val > 0 ? -val : val;
        }
        const actual = currentAsset.amount.current.value;
        const ok = withinTolerance(sum, actual, roundingTol);
        out.push(
          result(
            "bs:hierarchy:current_assets_sub",
            "BsCurrentAssetFooting",
            [currentAsset.id, ...subItems.map((i) => i.id)],
            ok ? "match" : "review",
            {
              expected: sum,
              actual,
              sourceRefs: [currentAsset.source.xmlPath],
              subject: "유동자산 세부합계",
              ...(ok ? {} : { note: `유동자산(${fmtWon(actual)}) ≠ 구성 세부항목 합계(${fmtWon(sum)}) [Δ${fmtDelta(actual - sum)}]` }),
            },
          ),
        );
      }
    }
  }

  // [1-4] 비유동자산 세부 항목 Footing
  if (nonCurrentAsset && totalAsset) {
    const ncAssetIdx = bsLines.indexOf(nonCurrentAsset);
    const assetTotIdx = bsLines.indexOf(totalAsset);
    if (ncAssetIdx >= 0 && assetTotIdx > ncAssetIdx + 1) {
      const subItems = bsLines.slice(ncAssetIdx + 1, assetTotIdx);
      if (subItems.length >= 2) {
        let sum = 0;
        for (const item of subItems) {
          const val = item.amount.current.value;
          sum += isDeductionAccount(item.account) && val > 0 ? -val : val;
        }
        const actual = nonCurrentAsset.amount.current.value;
        const ok = withinTolerance(sum, actual, roundingTol);
        out.push(
          result(
            "bs:hierarchy:non_current_assets_sub",
            "BsNonCurrentAssetFooting",
            [nonCurrentAsset.id, ...subItems.map((i) => i.id)],
            ok ? "match" : "review",
            {
              expected: sum,
              actual,
              sourceRefs: [nonCurrentAsset.source.xmlPath],
              subject: "비유동자산 세부합계",
              ...(ok ? {} : { note: `비유동자산(${fmtWon(actual)}) ≠ 구성 세부항목 합계(${fmtWon(sum)}) [Δ${fmtDelta(actual - sum)}]` }),
            },
          ),
        );
      }
    }
  }

  // [1-5] 자본총계 세부 항목 Footing
  if (totalLiab && totalEquity) {
    const liabIdx = bsLines.indexOf(totalLiab);
    const eqIdx = bsLines.indexOf(totalEquity);
    if (liabIdx >= 0 && eqIdx > liabIdx + 1) {
      let subItems = bsLines.slice(liabIdx + 1, eqIdx);
      subItems = subItems.filter((i) => !norm(i.account).includes("부채와자본"));
      if (subItems.length >= 2) {
        let sum = 0;
        for (const item of subItems) {
          const val = item.amount.current.value;
          sum += isDeductionAccount(item.account) && val > 0 ? -val : val;
        }
        const actual = totalEquity.amount.current.value;
        const ok = withinTolerance(sum, actual, roundingTol);
        out.push(
          result(
            "bs:hierarchy:equity_sub",
            "BsEquityFooting",
            [totalEquity.id, ...subItems.map((i) => i.id)],
            ok ? "match" : "review",
            {
              expected: sum,
              actual,
              sourceRefs: [totalEquity.source.xmlPath],
              subject: "자본총계 세부합계",
              ...(ok ? {} : { note: `자본총계(${fmtWon(actual)}) ≠ 자본 구성 세부항목 합계(${fmtWon(sum)}) [Δ${fmtDelta(actual - sum)}]` }),
            },
          ),
        );
      }
    }
  }

  return out;
}

// ── 2. 손익계산서 (IS/CIS) 다단계 손익 산식 Footing ──────────────────────────

export function checkIsHierarchy(lines: FinancialStatementLine[]): ReviewResult[] {
  const isLines = lines.filter((l) => l.statement === "IS");
  if (isLines.length === 0) return [];

  const out: ReviewResult[] = [];

  const sales = isLines.find((l) => isSales(l.account));
  const cogs = isLines.find((l) => isCogs(l.account));
  const grossProfit = isLines.find((l) => isGrossProfit(l.account));

  const sga = isLines.find((l) => isSga(l.account));
  const operatingProfit = isLines.find((l) => isOperatingProfit(l.account));

  const pbt = isLines.find((l) => isPbt(l.account));
  const tax = isLines.find((l) => isTax(l.account));
  const netIncome = isLines.find((l) => isNetIncome(l.account));

  // [2-1] 매출총이익 = 매출액 - 매출원가
  if (sales && cogs && grossProfit) {
    const sVal = sales.amount.current.value;
    const cVal = cogs.amount.current.value;
    const expected = sVal - cVal;
    const actual = grossProfit.amount.current.value;
    const ok = withinTolerance(expected, actual, roundingTol);
    out.push(
      result(
        "is:hierarchy:gross_profit",
        "IsGrossProfitFormula",
        [grossProfit.id, sales.id, cogs.id],
        ok ? "match" : "review",
        {
          expected,
          actual,
          sourceRefs: [grossProfit.source.xmlPath],
          subject: "매출총이익 산식",
          ...(ok ? {} : { note: `매출총이익(${fmtWon(actual)}) ≠ 매출액(${fmtWon(sVal)}) - 매출원가(${fmtWon(cVal)}) [Δ${fmtDelta(actual - expected)}]` }),
        },
      ),
    );
  }

  // [2-2] 영업이익 = 매출총이익 - 판매비와관리비
  if (grossProfit && sga && operatingProfit) {
    const gpVal = grossProfit.amount.current.value;
    const sgaVal = sga.amount.current.value;
    const expected = gpVal - sgaVal;
    const actual = operatingProfit.amount.current.value;
    const ok = withinTolerance(expected, actual, roundingTol);
    out.push(
      result(
        "is:hierarchy:operating_profit",
        "IsOperatingProfitFormula",
        [operatingProfit.id, grossProfit.id, sga.id],
        ok ? "match" : "review",
        {
          expected,
          actual,
          sourceRefs: [operatingProfit.source.xmlPath],
          subject: "영업이익 산식",
          ...(ok ? {} : { note: `영업이익(${fmtWon(actual)}) ≠ 매출총이익(${fmtWon(gpVal)}) - 판매비와관리비(${fmtWon(sgaVal)}) [Δ${fmtDelta(actual - expected)}]` }),
        },
      ),
    );
  }

  // [2-3] 당기순이익 = 법인세차감전순이익 - 법인세비용
  if (pbt && tax && netIncome) {
    const pbtVal = pbt.amount.current.value;
    const taxVal = tax.amount.current.value;
    const expected = pbtVal - taxVal;
    const actual = netIncome.amount.current.value;
    const ok = withinTolerance(expected, actual, roundingTol);
    out.push(
      result(
        "is:hierarchy:net_income",
        "IsNetIncomeFormula",
        [netIncome.id, pbt.id, tax.id],
        ok ? "match" : "review",
        {
          expected,
          actual,
          sourceRefs: [netIncome.source.xmlPath],
          subject: "당기순이익 산식",
          ...(ok ? {} : { note: `당기순이익(${fmtWon(actual)}) ≠ 법인세차감전순이익(${fmtWon(pbtVal)}) - 법인세비용(${fmtWon(taxVal)}) [Δ${fmtDelta(actual - expected)}]` }),
        },
      ),
    );
  }

  return out;
}

// ── 3. 재무제표 간 (FS-to-FS) Tie-out ────────────────────────────────────────

export function checkCrossStatementTieOut(lines: FinancialStatementLine[]): ReviewResult[] {
  const out: ReviewResult[] = [];

  const isNetIncomeLine = lines.filter((l) => l.statement === "IS").find((l) => isNetIncome(l.account));
  const cfNetIncomeLine = lines.filter((l) => l.statement === "CF").find((l) => isNetIncome(l.account));

  const bsCashLine = lines.filter((l) => l.statement === "BS").find((l) => norm(l.account).includes("현금및현금성자산"));
  const cfEndCashLine = lines.filter((l) => l.statement === "CF").find((l) => norm(l.account).includes("기말") && norm(l.account).includes("현금"));

  // [3-1] 손익계산서 당기순이익 == 현금흐름표 당기순이익
  if (isNetIncomeLine && cfNetIncomeLine) {
    const isVal = isNetIncomeLine.amount.current.value;
    const cfVal = cfNetIncomeLine.amount.current.value;
    const ok = withinTolerance(isVal, cfVal, roundingTol);
    out.push(
      result(
        "tieout:is_cf_net_income",
        "TieOutIsCfNetIncome",
        [isNetIncomeLine.id, cfNetIncomeLine.id],
        ok ? "match" : "review",
        {
          expected: isVal,
          actual: cfVal,
          sourceRefs: [isNetIncomeLine.source.xmlPath, cfNetIncomeLine.source.xmlPath],
          subject: "IS-CF 당기순이익 대사",
          ...(ok ? {} : { note: `손익계산서 당기순이익(${fmtWon(isVal)}) ≠ 현금흐름표 당기순이익(${fmtWon(cfVal)})` }),
        },
      ),
    );
  }

  // [3-2] 재무상태표 현금및현금성자산 == 현금흐름표 기말현금
  if (bsCashLine && cfEndCashLine) {
    const bsVal = bsCashLine.amount.current.value;
    const cfVal = cfEndCashLine.amount.current.value;
    const ok = withinTolerance(bsVal, cfVal, roundingTol);
    out.push(
      result(
        "tieout:bs_cf_cash",
        "TieOutBsCfCash",
        [bsCashLine.id, cfEndCashLine.id],
        ok ? "match" : "review",
        {
          expected: bsVal,
          actual: cfVal,
          sourceRefs: [bsCashLine.source.xmlPath, cfEndCashLine.source.xmlPath],
          subject: "BS-CF 기말현금 대사",
          ...(ok ? {} : { note: `재무상태표 현금및현금성자산(${fmtWon(bsVal)}) ≠ 현금흐름표 기말현금(${fmtWon(cfVal)})` }),
        },
      ),
    );
  }

  return out;
}

/** 4대 재무제표전수 계층 및 Tie-out 검증 통합 호출 함수 */
export function checkFsHierarchyAndTieOut(lines: FinancialStatementLine[]): ReviewResult[] {
  return [
    ...checkBsHierarchy(lines),
    ...checkIsHierarchy(lines),
    ...checkCrossStatementTieOut(lines),
  ];
}
