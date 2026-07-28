// Articulation — 재무제표 연계성 검증 (Doc 06 §6 확장).
//
// WHY THIS EXISTS: 지금까지의 검증은 표 하나 안에서 닫혀 있었다(합계·롤포워드) 또는
// 두 총계를 맞대는 수준이었다(대차평균·현금 대사). 그러나 감사인이 실제로 확인하는
// 것은 **흩어진 정보 사이의 연결**이다 —
//
//   · 이익잉여금의 증감은 당기순이익과 배당·처분으로 설명되어야 한다
//   · 기타자본(기타포괄손익누계액)의 변동은 손익계산서의 기타포괄손익과 일치해야 한다
//   · 자본변동표의 기말 잔액은 재무상태표의 자본 각 항목과 같아야 한다
//   · 자본변동표의 배당은 현금흐름표의 배당금 지급과 같아야 한다
//
// 이 관계들은 K-IFRS 표시체계상 반드시 성립하므로 결정론적으로 검증할 수 있다(§6).
// 성립하지 않으면 재무제표 간 전기(轉記) 오류이거나 표시 누락이다.
//
// 자본변동표는 전치(transposed) 행렬 — 행=변동원인, 열=자본 구성요소 — 이므로
// FinancialStatementLine 으로 펼치지 않고 표 자체를 읽는다.

import type {
  AomObject,
  FinancialStatementLine,
  FinancialStatementTable,
  ReviewResult,
  TableRow,
} from "../aom/types.js";
import { ENGINE_VERSION, withinTolerance, type Tolerance } from "./types.js";
import { fmtDelta, fmtWon } from "../labels.js";

const norm = (s: string): string => s.replace(/\s/g, "");

// ── 자본변동표 행 분류 ───────────────────────────────────────────────────────
// 총포괄손익 대사를 하려면 "손익성 변동"과 "주주와의 거래"를 나눠야 한다.
// 목록을 명시적으로 두는 이유: 미분류 행이 하나라도 있으면 판정을 단정하지 않고
// 검토 권장으로 낮추기 위해서다(§21). catch-all 로 두면 조용히 틀린다.
const RE_NET_INCOME = /당기순(이익|손실|손익)|분기순|반기순/;
const RE_OCI =
  /재측정|지분법자본변동|재평가|환산|위험회피|공정가치|매도가능|기타포괄|해외사업장|현금흐름위험|보험수리적/;
const RE_OWNER_TX =
  /배당|증자|감자|출자전환|자기주식|주식발행|결손금보전|자본전입|전환권|신주인수권|주식기준보상|주식매수선택권|자본잉여금대체|이익준비금|연결범위|지분추가취득|지분율변동/;
// "총포괄손익" 행은 그 위의 당기순손익·기타포괄손익을 이미 합한 **소계**다.
// 합계|총계 만 보면 걸리지 않아 이중계상되므로 명시적으로 포함한다.
const RE_SUBTOTAL = /합계|총계|^계$|소계|총포괄|포괄손익계$/;
const RE_DATE_ROW = /^\s*20\d{2}\s*[년.]/;

/**
 * 표시 부호 관행 — 결손금과 당기순손실은 재무상태표·손익계산서에서 **차감 항목으로
 * 양수** 표기되지만, 자본변동표에서는 자본을 줄이는 **음수**로 나타난다.
 * 크기가 같고 부호만 반대이며 계정명이 그 관행을 뒷받침하면 오류가 아니다.
 * 계정명 근거가 없으면 이 예외를 적용하지 않는다(§5 — 근거 없이 넘기지 않는다).
 */
const RE_DEDUCTION_BY_NAME = /결손금|순손실|미처리결손/;

type RowKind = "netIncome" | "oci" | "ownerTx" | "unknown";

function classify(label: string): RowKind {
  const l = norm(label);
  if (RE_NET_INCOME.test(l)) return "netIncome";
  if (RE_OCI.test(l)) return "oci";
  if (RE_OWNER_TX.test(l)) return "ownerTx";
  return "unknown";
}

// ── 표 읽기 도우미 ───────────────────────────────────────────────────────────

function cellValue(row: TableRow, col: number): number {
  return row.cells.find((c) => c.col === col)?.number?.value ?? 0;
}

/** 표에 쓰인 표시 단위(원·천원·백만원) 중 가장 큰 값 — 단수차이 허용폭의 근거. */
function tableScale(table: FinancialStatementTable): number {
  let s = 1;
  for (const r of table.rows)
    for (const c of r.cells) if (c.number && c.number.scale > s) s = c.number.scale;
  return s;
}

interface SceColumn {
  /** 가장 구체적인 열 제목 (자본금·결손금·소계…) — 계정 대응에 쓴다 */
  label: string;
  /** 이 열을 덮는 상위 병합 제목 (지배기업소유주지분 등) */
  group?: string;
  /** 사람이 읽는 이름 */
  display: string;
}

interface SceBlock {
  table: FinancialStatementTable;
  /** 열 인덱스 → 열 제목 (자본금·자본잉여금·…·총계) */
  columns: Map<number, SceColumn>;
  /** 총계 열 (없으면 undefined) */
  totalCol?: number;
  opening: TableRow;
  closing: TableRow;
  /** 기초와 기말 사이의 변동 행 (소계 제외) */
  movements: TableRow[];
  /** 분류되지 않은 변동 행이 있는가 — 있으면 총포괄손익 대사를 단정하지 않는다 */
  hasUnknown: boolean;
  scale: number;
}

/**
 * 자본변동표에서 **당기** 블록을 뽑는다.
 * 자본변동표는 전기·당기를 한 표에 세로로 이어 붙이므로, 날짜 행이 4개(전기초·전기말·
 * 당기초·당기말) 나타난다. 마지막 날짜 행이 당기말, 그 앞 날짜 행이 당기초다.
 */
function readSce(table: FinancialStatementTable): SceBlock | undefined {
  const rows = table.rows;
  if (rows.length < 4) return undefined;

  const dateIdx: number[] = [];
  rows.forEach((r, i) => {
    if (RE_DATE_ROW.test(r.label)) dateIdx.push(i);
  });
  if (dateIdx.length < 2) return undefined;

  const closeIdx = dateIdx[dateIdx.length - 1]!;
  const openIdx = dateIdx[dateIdx.length - 2]!;
  if (closeIdx - openIdx < 2) return undefined; // 변동 행이 없으면 대사할 것이 없다

  // 열 제목은 첫 날짜 행 앞의 모든 머리행에서 읽는다. 연결재무제표는 머리행이 2단이다 —
  //   1단: [구분] [지배기업소유주지분 (5칸 병합)] [비지배지분] [총계]
  //   2단:        [자본금][자본잉여금][기타자본][결손금][소계]
  // 병합 셀은 그룹명으로, 단일 셀은 그 열의 고유 제목으로 삼는다. 그룹명을 그대로
  // 열 제목으로 쓰면 자본금 열이 "지배기업소유주지분"으로 읽혀 자본총계와 대사된다.
  const firstDate = dateIdx[0]!;
  if (firstDate === 0) return undefined;
  const columns = new Map<number, SceColumn>();
  const groups = new Map<number, string>();
  for (let i = 0; i < firstDate; i++) {
    for (const c of rows[i]!.cells) {
      if (c.col === 0) continue;
      const t = norm(c.text ?? "");
      if (!t) continue;
      const span = c.colSpan ?? 1;
      if (span > 1) {
        for (let k = c.col; k < c.col + span; k++) groups.set(k, t);
      } else {
        columns.set(c.col, { label: t, display: t });
      }
    }
  }
  for (const [col, g] of groups) {
    const cur = columns.get(col);
    if (cur) columns.set(col, { label: cur.label, group: g, display: `${g} ${cur.label}` });
    else columns.set(col, { label: g, display: g });
  }
  if (columns.size === 0) return undefined;

  // 총계 열은 가장 바깥쪽 합계 — 마지막에 나타나는 합계성 열을 쓴다.
  // (연결에서는 "소계"(지배기업지분)와 "총계"가 함께 있으므로 순서가 중요하다.)
  let totalCol: number | undefined;
  for (const [col, c] of columns) if (RE_SUBTOTAL.test(c.label)) totalCol = col;

  const movements: TableRow[] = [];
  let hasUnknown = false;
  for (let i = openIdx + 1; i < closeIdx; i++) {
    const r = rows[i]!;
    if (RE_SUBTOTAL.test(norm(r.label))) continue; // "자본 증가(감소)합계" 는 소계
    if (!r.label.trim()) continue;
    movements.push(r);
    if (classify(r.label) === "unknown") hasUnknown = true;
  }
  if (movements.length === 0) return undefined;

  return {
    table,
    columns,
    ...(totalCol !== undefined ? { totalCol } : {}),
    opening: rows[openIdx]!,
    closing: rows[closeIdx]!,
    movements,
    hasUnknown,
    scale: tableScale(table),
  };
}

// ── 재무상태표 자본 계정 대응 ────────────────────────────────────────────────

/** 자본변동표 열 제목 → 재무상태표 계정을 찾는 규칙. 순서가 곧 우선순위다. */
const EQUITY_COLUMN_TO_BS: { col: RegExp; bs: RegExp; label: string }[] = [
  { col: /^자본금$/, bs: /^자본금$/, label: "자본금" },
  { col: /자본잉여금|주식발행초과금/, bs: /자본잉여금|주식발행초과금/, label: "자본잉여금" },
  { col: /자본조정/, bs: /자본조정/, label: "자본조정" },
  {
    col: /기타포괄손익누계액|기타자본구성요소|^기타포괄/,
    bs: /기타포괄손익누계액|기타자본구성요소/,
    label: "기타포괄손익누계액",
  },
  { col: /이익잉여금|결손금/, bs: /이익잉여금|결손금/, label: "이익잉여금(결손금)" },
  // 연결재무제표의 지분 구분 열. "비지배지분"이 "지배기업소유주지분"보다 먼저 걸리지
  // 않도록 각각 고유 어절로 제한한다.
  {
    col: /지배기업소유주지분|지배기업의소유주|지배주주지분/,
    bs: /지배기업소유주지분|지배기업의소유주|지배주주지분/,
    label: "지배기업 소유주지분",
  },
  { col: /비지배지분|비지배주주지분/, bs: /비지배지분|비지배주주지분/, label: "비지배지분" },
  { col: /총계|합계/, bs: /^자본총계$/, label: "자본총계" },
];

/** 크기는 같고 부호만 반대이며, 계정명이 차감 표기를 뒷받침하는가. */
function isSignConvention(a: number, b: number, label: string, band: Tolerance): boolean {
  if (a === 0 || b === 0 || Math.sign(a) === Math.sign(b)) return false;
  if (!RE_DEDUCTION_BY_NAME.test(norm(label))) return false;
  return withinTolerance(Math.abs(a), Math.abs(b), band);
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
    ...(extra.subject ? { subject: extra.subject } : {}),
  };
}

// ── 검증 ─────────────────────────────────────────────────────────────────────

export function checkArticulation(objects: AomObject[]): ReviewResult[] {
  const lines = objects.filter(
    (o): o is FinancialStatementLine => o.objectType === "FinancialStatementLine",
  );
  const sceTable = objects.find(
    (o): o is FinancialStatementTable =>
      o.objectType === "FinancialStatementTable" && o.statement === "SCE",
  );
  if (!sceTable) return [];
  const sce = readSce(sceTable);
  if (!sce) return [];

  const bs = lines.filter((l) => l.statement === "BS");
  const is = lines.filter((l) => l.statement === "IS");
  const cf = lines.filter((l) => l.statement === "CF");
  const findIs = (re: RegExp): FinancialStatementLine | undefined =>
    is.find((l) => re.test(norm(l.account)));

  const out: ReviewResult[] = [];
  const src = [sceTable.source.xmlPath];
  // 단수차이 허용폭: 표시 단위 × 항 수. 서로 다른 표(자본변동표↔재무상태표)를
  // 맞대므로 반올림이 양쪽에서 발생할 수 있다.
  const tol = (terms: number): Tolerance => ({
    mode: "rounding",
    unitKrw: sce.scale * Math.max(1, terms),
  });

  // ① 자본 각 항목의 기초 + 변동 = 기말 (열별 롤포워드).
  //    이익잉여금 열이 곧 "이익잉여금 증감 = 당기순이익 ± 배당·처분" 검증이다.
  for (const [col, colInfo] of sce.columns) {
    const title = colInfo.display;
    const open = cellValue(sce.opening, col);
    const move = sce.movements.reduce((s, r) => s + cellValue(r, col), 0);
    const close = cellValue(sce.closing, col);
    // 전 항목이 0 인 열(당기 변동 없음 + 잔액 0)은 대사 의미가 없다.
    if (open === 0 && move === 0 && close === 0) continue;
    const band = tol(sce.movements.length);
    const ok = withinTolerance(open + move, close, band);
    const causes = sce.movements
      .filter((r) => cellValue(r, col) !== 0)
      .map((r) => r.label.trim())
      .slice(0, 4)
      .join(" · ");
    out.push(
      mk(`articulation:sce:${col}`, "EquityRollForward", ok ? "match" : "mismatch", [sceTable.id], {
        subject: `${title} [자본변동표]`,
        expected: open + move,
        actual: close,
        toleranceApplied: band.unitKrw,
        sourceRefs: src,
        note: ok
          ? `${title}: 기초 ${fmtWon(open)} + 변동 ${fmtWon(move)} = 기말 ${fmtWon(close)}${causes ? ` (변동원인: ${causes})` : ""}`
          : `${title} 자본변동표 대사 불일치: 기초+변동 ${fmtWon(open + move)} ≠ 기말 ${fmtWon(close)} (Δ${fmtDelta(close - open - move)})`,
      }),
    );
  }

  // ② 자본변동표 기말 잔액 = 재무상태표 자본 각 항목.
  for (const [col, colInfo] of sce.columns) {
    // 열 제목이 "소계"처럼 그 자체로는 무엇의 합인지 알 수 없으면 그룹명을 붙여 판단한다.
    // 그래야 연결의 "지배기업소유주지분 소계"가 자본총계로 잘못 대사되지 않는다.
    const key =
      colInfo.group && /소계|합계|총계/.test(colInfo.label) ? colInfo.display : colInfo.label;
    const rule = EQUITY_COLUMN_TO_BS.find((r) => r.col.test(key));
    if (!rule) continue;
    const bsLine = bs.find((l) => rule.bs.test(norm(l.account)));
    if (!bsLine) continue;
    const sceVal = cellValue(sce.closing, col);
    const bsVal = bsLine.amount.current.value;
    if (sceVal === 0 && bsVal === 0) continue;
    const band = tol(1);
    const exact = withinTolerance(sceVal, bsVal, band);
    const bySign = !exact && isSignConvention(sceVal, bsVal, bsLine.account, band);
    const ok = exact || bySign;
    out.push(
      mk(`articulation:sce2bs:${col}`, "EquityToBs", ok ? "match" : "mismatch", [sceTable.id, bsLine.id], {
        subject: `${rule.label} [SCE↔BS]`,
        expected: sceVal,
        actual: bsVal,
        toleranceApplied: band.unitKrw,
        sourceRefs: [...src, bsLine.source.xmlPath],
        note: bySign
          ? `${rule.label}: 금액 ${fmtWon(Math.abs(bsVal))} 일치 — 재무상태표는 차감 항목으로 양수 표기, 자본변동표는 음수 표기(표시 관행 차이)`
          : exact
            ? `${rule.label}: 자본변동표 기말 = 재무상태표 ${fmtWon(bsVal)}`
            : `${rule.label} 불일치: 자본변동표 기말 ${fmtWon(sceVal)} ≠ 재무상태표 ${fmtWon(bsVal)} (Δ${fmtDelta(bsVal - sceVal)})`,
      }),
    );
  }

  const totalCol = sce.totalCol;
  if (totalCol === undefined) return out;

  const sumOf = (kinds: RowKind[]): number =>
    sce.movements
      .filter((r) => kinds.includes(classify(r.label)))
      .reduce((s, r) => s + cellValue(r, totalCol), 0);

  // ③ 당기순이익: 손익계산서 → 자본변동표.
  const niLine = findIs(/^[^가-힣]*당기순(이익|손실|손익)/);
  const niSce = sumOf(["netIncome"]);
  if (niLine && niSce !== 0) {
    const band = tol(1);
    const isVal = niLine.amount.current.value;
    const exact = withinTolerance(niSce, isVal, band);
    // "당기순손실 24,072"처럼 손익계산서가 손실을 양수로 표기하면 자본변동표(음수)와
    // 부호가 반대가 된다 — 계정명이 손실임을 밝히므로 오류가 아니다.
    const bySign = !exact && isSignConvention(niSce, isVal, niLine.account, band);
    const ok = exact || bySign;
    out.push(
      mk("articulation:ni", "NetIncomeToEquity", ok ? "match" : "mismatch", [sceTable.id, niLine.id], {
        subject: "당기순손익 [IS→SCE]",
        expected: isVal,
        actual: niSce,
        toleranceApplied: band.unitKrw,
        sourceRefs: [...src, niLine.source.xmlPath],
        note: bySign
          ? `당기순손실 ${fmtWon(Math.abs(niSce))} 이 손익계산서에서 자본변동표로 전기됨 (손익계산서는 손실을 양수로 표기)`
          : exact
            ? `당기순이익 ${fmtWon(niSce)} 이 손익계산서에서 자본변동표로 그대로 전기됨`
            : `당기순이익 전기 불일치: 손익계산서 ${fmtWon(isVal)} ≠ 자본변동표 ${fmtWon(niSce)} (Δ${fmtDelta(niSce - isVal)})`,
      }),
    );
  }

  // ④ 총포괄손익: 손익계산서 총포괄손익 = 자본변동표의 손익성 변동(당기순손익 + 기타포괄손익).
  //    주주와의 거래(배당·증자 등)는 제외한다. 미분류 행이 있으면 단정하지 않는다(§21).
  const ciLine = findIs(/총포괄(이익|손실|손익)/);
  if (ciLine) {
    const ciSce = sumOf(["netIncome", "oci"]);
    const band = tol(sce.movements.length);
    const ok = withinTolerance(ciSce, ciLine.amount.current.value, band);
    const unknownRows = sce.movements
      .filter((r) => classify(r.label) === "unknown")
      .map((r) => r.label.trim());
    out.push(
      mk(
        "articulation:ci",
        "ComprehensiveIncomeToEquity",
        ok ? "match" : sce.hasUnknown ? "review" : "mismatch",
        [sceTable.id, ciLine.id],
        {
          subject: "총포괄손익 [IS↔SCE]",
          expected: ciLine.amount.current.value,
          actual: ciSce,
          toleranceApplied: band.unitKrw,
          sourceRefs: [...src, ciLine.source.xmlPath],
          note: ok
            ? `총포괄손익 ${fmtWon(ciSce)} = 당기순손익 + 기타포괄손익 (자본변동표의 손익성 변동과 일치)`
            : sce.hasUnknown
              ? `총포괄손익 대사 차이 (Δ${fmtDelta(ciSce - ciLine.amount.current.value)}) — 자본변동표에 성격을 판정하지 못한 변동 행이 있어 단정하지 않습니다: ${unknownRows.join(" · ")}`
              : `총포괄손익 불일치: 손익계산서 ${fmtWon(ciLine.amount.current.value)} ≠ 자본변동표의 손익성 변동 합 ${fmtWon(ciSce)} (Δ${fmtDelta(ciSce - ciLine.amount.current.value)})`,
        },
      ),
    );
  }

  // ⑤ 배당: 자본변동표 ↔ 현금흐름표 배당금 지급액.
  //    미지급배당이 있으면 차이가 날 수 있으므로 불일치는 검토 권장으로 둔다.
  const divRow = sce.movements.find((r) => /배당/.test(norm(r.label)));
  const divCf = cf.find((l) => /배당금.*(지급|유출)|배당금지급/.test(norm(l.account)));
  if (divRow && divCf) {
    const a = Math.abs(cellValue(divRow, totalCol));
    const b = Math.abs(divCf.amount.current.value);
    const band = tol(1);
    const ok = withinTolerance(a, b, band);
    out.push(
      mk("articulation:dividend", "DividendToCashFlow", ok ? "match" : "review", [sceTable.id, divCf.id], {
        subject: "배당금 [SCE↔CF]",
        expected: a,
        actual: b,
        toleranceApplied: band.unitKrw,
        sourceRefs: [...src, divCf.source.xmlPath],
        note: ok
          ? `배당금 ${fmtWon(a)} 이 자본변동표와 현금흐름표에서 일치`
          : `배당금 차이: 자본변동표 ${fmtWon(a)} vs 현금흐름표 ${fmtWon(b)} (Δ${fmtDelta(b - a)}) — 미지급배당·중간배당 시차 여부 확인이 권장됩니다`,
      }),
    );
  }

  return out;
}
