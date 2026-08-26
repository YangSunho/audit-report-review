// 재무제표 계층 전수 Footing — 최하위 항목부터 상위 합계까지 (Doc 06 §2.1 확장).
//
// WHY THIS EXISTS: 지금까지의 검증은 "표시된 결과값끼리" 맞는지만 봤다.
// 자산총계 = 부채와자본총계, 자산총계 = 부채총계 + 자본총계 …
// 그런데 감사에서 정작 위험한 것은 **구성항목이 그 소계와 맞는가**다.
//
//   비유동자산 198,231,311,264
//     기타비유동금융자산   243,179,635   ← 이 줄이 통째로 빠져도
//     종속기업및관계기업투자 99,932,392,270
//     …                                  자산총계·대차평균은 그대로 맞는다
//
// 실제로 표본에서 이 형태의 누락을 재현했을 때 다른 모든 검증이 통과했다.
// 그래서 표시된 총계가 아니라 **트리를 재구성해 바닥부터 쌓아 올려** 대조한다.
//
// ── 계층을 어떻게 아는가 ────────────────────────────────────────────────────
// DSD 표에는 들여쓰기 정보가 없다. 대신 제출사들이 공통으로 쓰는 세 가지 신호가
// 있고, 실제 표본 8종에서 이 조합이 모든 편집 형태를 덮는 것을 확인했다:
//
//   ① 열 깊이   소계·총계는 세부항목보다 **바깥 열**에 금액을 쓴다
//               유동자산 → c3 / 현금및현금성자산 → c2   (표본 A·B·C)
//   ② 개요 번호  "Ⅰ. 유동자산" > "1) 당좌자산" > "현금및현금성자산"
//               (표본 D — 같은 열 안에서 단계가 갈린다)
//   ③ 총계 라벨  "자산 총계"는 언제나 최상위. 열·개요와 무관하다
//               (표본 E — 소계에만 개요 번호가 붙어 총계가 더 깊어 보인다)
//
// 세 신호를 하나의 depth 로 합치고(작을수록 상위), 그 위에서 트리를 만든다.

import type { FinancialStatementTable, ReviewResult, TableRow } from "../aom/types.js";
import { ENGINE_VERSION, withinTolerance, type Tolerance } from "./types.js";
import { fmtDelta, fmtWon } from "../labels.js";

const norm = (s: string): string => s.replace(/\s/g, "");

/** "자산 총계"·"합 계" — 열이나 개요 번호와 무관하게 최상위다. */
const RE_TOTAL = /(총계|총액|합계|^계$)/;
/** 상위 개요: Ⅰ. / I. / 1. — 큰 구분 */
const RE_OUTLINE_1 = /^\s*(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|[IVX]{1,4})\s*[.．]/;
/** 하위 개요: 1) / (1) / 가. — 중간 구분 */
const RE_OUTLINE_2 = /^\s*(?:\(?\d{1,2}\)|[가나다라마바사아자차]\s*[.．])/;
/** 금액이 아니라 구획만 나타내는 줄: "자 산", "부 채", "자 본" */
const RE_SECTION = /^(자산|부채|자본|자산총계전|부채와자본)$/;

/**
 * 한 행의 계층 깊이. 작을수록 상위.
 * 총계 라벨을 최우선(100 이하)으로 두는 이유: 표본 E처럼 소계에만 개요 번호가
 * 붙는 편집에서는 "Ⅰ.유동자산"이 "자산총계"보다 얕아 보인다. 총계는 정의상
 * 언제나 그 구획의 꼭대기이므로 다른 신호보다 우선한다.
 */
function depthOf(label: string, columnRank: number): number {
  const l = norm(label);
  const isTotal = RE_TOTAL.test(l);
  const outline = RE_OUTLINE_1.test(label) ? 0 : RE_OUTLINE_2.test(label) ? 1 : 2;
  return (isTotal ? 0 : 100) + columnRank * 8 + outline * 2;
}

interface Node {
  index: number;
  row: TableRow;
  label: string;
  depth: number;
  value: number;
  /** 이 행이 같은 기간의 여러 열에 금액을 갖는가 (세부+소계 겸용 행) */
  ambiguous: boolean;
}

/** 주석 참조 열 — 금액이 아니므로 계층 판단에서 빼야 한다. */
function noteColumnOf(table: FinancialStatementTable): number | undefined {
  const head = table.rows[0];
  if (!head) return undefined;
  const c = head.cells.find((x) => norm(x.text ?? "").includes("주석"));
  return c?.col;
}

/** 금액이 실린 열들. 앞 절반이 당기, 뒤 절반이 전기 (builder 와 같은 규칙). */
function amountColumns(table: FinancialStatementTable, noteCol?: number): number[] {
  const cols = new Set<number>();
  for (const r of table.rows)
    for (const c of r.cells) if (c.number && c.col > 0 && c.col !== noteCol) cols.add(c.col);
  return [...cols].sort((a, b) => a - b);
}

/**
 * 한 기간(열 묶음)에 대한 노드 목록. 열이 바깥일수록 columnRank 가 작다(상위).
 * 금액이 없는 행은 구획 머리글로 보고 장벽(barrier)으로 남긴다.
 */
function nodesFor(table: FinancialStatementTable, cols: number[]): (Node | "barrier")[] {
  const rank = new Map<number, number>();
  // 오른쪽(바깥) 열이 상위 → columnRank 0
  [...cols].reverse().forEach((c, i) => rank.set(c, i));

  const out: (Node | "barrier")[] = [];
  table.rows.forEach((row, index) => {
    const label = (row.label ?? "").trim();
    const filled = row.cells.filter((c) => c.number && cols.includes(c.col));
    if (filled.length === 0) {
      // 라벨만 있는 줄("자 산")은 구획 경계. 빈 줄도 마찬가지로 흐름을 끊지 않게 둔다.
      if (label && RE_SECTION.test(norm(label))) out.push("barrier");
      return;
    }
    // 가장 바깥 열의 값을 그 행의 대표값으로 본다.
    const outer = filled.reduce((a, b) => (rank.get(a.col)! <= rank.get(b.col)! ? a : b));
    out.push({
      index,
      row,
      label,
      depth: depthOf(label, rank.get(outer.col)!),
      value: outer.number!.value,
      ambiguous: filled.length > 1,
    });
  });
  return out;
}

/**
 * 부모의 직계 자식을 찾는다.
 *
 * 한국 재무제표는 두 관습이 한 표에 섞인다 —
 *   · 소계가 **앞**: 유동자산 → 현금 → 매출채권 …
 *   · 총계가 **뒤**: 유동자산, 비유동자산 → 자산 총계
 * 그래서 앞을 먼저 보고, 없으면 뒤를 본다.
 *
 * 직계 자식은 "구간 안에서 가장 얕은 깊이"의 행들이다. 그보다 깊은 행은
 * 손자이므로 제외한다 — 함께 더하면 이중계상이 된다.
 */
function childrenOf(nodes: (Node | "barrier")[], at: number): Node[] {
  const p = nodes[at] as Node;
  const collect = (step: 1 | -1): Node[] => {
    const run: Node[] = [];
    for (let i = at + step; i >= 0 && i < nodes.length; i += step) {
      const n = nodes[i];
      if (n === undefined || n === "barrier") break;
      if (n.depth <= p.depth) break;
      run.push(n);
    }
    if (run.length === 0) return [];
    const shallow = Math.min(...run.map((n) => n.depth));
    return run.filter((n) => n.depth === shallow);
  };
  const forward = collect(1);
  return forward.length >= 2 ? forward : collect(-1);
}

function mk(
  id: string,
  status: ReviewResult["status"],
  table: FinancialStatementTable,
  extra: Partial<ReviewResult>,
): ReviewResult {
  return {
    id,
    objectType: "ReviewResult",
    check: "FsTreeFooting",
    targets: [table.id],
    status,
    toleranceApplied: extra.toleranceApplied ?? 0,
    engineVersion: ENGINE_VERSION,
    sourceRefs: [table.source.xmlPath],
    ...(extra.expected !== undefined ? { expected: extra.expected } : {}),
    ...(extra.actual !== undefined ? { actual: extra.actual } : {}),
    ...(extra.note ? { note: extra.note } : {}),
    ...(extra.subject ? { subject: extra.subject } : {}),
  };
}

export interface TreeFootingOptions {
  /** 기간 이름 (보고서 표기용) */
  periodLabel: string;
}

function checkOnePeriod(
  table: FinancialStatementTable,
  cols: number[],
  periodLabel: string,
  idPrefix: string,
): ReviewResult[] {
  const nodes = nodesFor(table, cols);
  const out: ReviewResult[] = [];
  // 한 표 안에서 세부·소계를 같은 행에 겹쳐 쓰는 편집이 있으면(재고자산평가충당금이
  // 자기 값과 소계를 함께 지는 형태) 트리 해석이 흔들린다. 단정하지 않는다(§21).
  const shaky = nodes.some((n) => n !== "barrier" && n.ambiguous);

  const scale = (() => {
    let s = 1;
    for (const r of table.rows) for (const c of r.cells) if (c.number && c.number.scale > s) s = c.number.scale;
    return s;
  })();

  nodes.forEach((p, i) => {
    if (p === "barrier") return;
    const kids = childrenOf(nodes, i);
    if (kids.length < 2) return; // 자식이 하나면 계층이 아니라 재표시다

    const sum = kids.reduce((s, k) => s + k.value, 0);
    const band: Tolerance = { mode: "rounding", unitKrw: scale * Math.max(1, kids.length) };
    const ok = withinTolerance(sum, p.value, band);
    const names = kids.map((k) => k.label).join(" + ");

    out.push(
      mk(`${idPrefix}:${p.index}`, ok ? "match" : shaky ? "review" : "mismatch", table, {
        subject: `${p.label} [${periodLabel}]`,
        expected: sum,
        actual: p.value,
        toleranceApplied: band.unitKrw,
        note: ok
          ? `${p.label} ${fmtWon(p.value)} = ${names} (구성항목 ${kids.length}개 합계 일치)`
          : shaky
            ? `${p.label} 구성항목 합계 ${fmtWon(sum)} ≠ 표시된 ${fmtWon(p.value)} (Δ${fmtDelta(p.value - sum)}) — 세부와 소계가 한 행에 섞인 표라 단정하지 않습니다`
            : `${p.label} 구성항목 합계가 맞지 않습니다: ${names} = ${fmtWon(sum)} 이나 표시된 금액은 ${fmtWon(p.value)} (Δ${fmtDelta(p.value - sum)}) — 구성항목 누락·오기 확인 필요`,
      }),
    );
  });
  return out;
}

/**
 * 재무제표 본표의 계층을 재구성해 모든 단계에서 Σ구성항목 = 소계 를 검증한다.
 * 당기·전기를 각각 따로 본다 — 전기 숫자가 틀린 경우도 실제로 있다.
 */
export function checkFsTreeFooting(table: FinancialStatementTable): ReviewResult[] {
  // 재무상태표에 한정한다. 손익계산서·현금흐름표는 "부모 = Σ자식"이 아니라
  //   영업이익 = 매출총이익 − 판매비와관리비
  //   투자활동현금흐름 = 유입액 − 유출액
  // 처럼 **가감 산식**이다. 합계 트리로 읽으면 정상 보고서에서도 전부 틀린 것으로
  // 나온다(실제 표본에서 확인). 손익의 단계별 산식은 hierarchy.ts 가 의미 기반으로
  // 따로 검증한다.
  if (table.statement !== "BS") return [];
  const noteCol = noteColumnOf(table);
  const cols = amountColumns(table, noteCol);
  if (cols.length === 0) return [];

  const half = Math.ceil(cols.length / 2);
  const current = cols.slice(0, half);
  const prior = cols.slice(half);

  const cur = checkOnePeriod(table, current, "당기", `fstree:${table.statement}:cur`);
  const pri = prior.length > 0 ? checkOnePeriod(table, prior, "전기", `fstree:${table.statement}:pri`) : [];

  // ── 자기 검증: 다른 기간이 구조의 정답지다 ────────────────────────────────
  // 같은 표의 같은 행이 **한 기간에서는 합계가 맞는다면** 계층 해석이 옳다는 뜻이다.
  // 그 상태에서 다른 기간만 틀리면 그것은 구조 오독이 아니라 실제 수치 오류다.
  // 두 기간 모두 틀리면 계층을 잘못 읽었을 가능성이 남으므로 단정하지 않는다(§21).
  const matchedRow = new Set<number>();
  for (const r of [...cur, ...pri]) {
    if (r.status === "match") matchedRow.add(Number(r.id.split(":").pop()));
  }
  const settle = (r: ReviewResult): ReviewResult => {
    if (r.status !== "mismatch") return r;
    if (matchedRow.has(Number(r.id.split(":").pop()))) return r; // 구조 증명됨
    return {
      ...r,
      status: "review",
      note: `${r.note ?? ""} — 당기·전기 모두 합이 맞지 않아 계층 해석 오류 가능성이 있습니다. 원문 확인이 필요합니다.`,
    };
  };
  return [...cur.map(settle), ...pri.map(settle)];
}
