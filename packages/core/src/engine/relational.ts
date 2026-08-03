// Relational Review — Cross-Note (③, Doc 06 §4) + Cash Flow (④, Doc 06 §5).
// Deterministic + relationship graph (§12). Pure (§6, §19). Runs after the
// standalone checks (§8 order). Builds RelationshipEdges linking evidence and
// reconciles connected figures. Cross-statement/expected differences are surfaced
// as `review` with evidence (§21, Doc 06 §5), never asserted as errors.

import type {
  AomObject,
  FinancialStatementLine,
  FinancialStatementTable,
  RelationshipEdge,
  RelationKind,
  ReviewResult,
} from "../aom/types.js";
import { ENGINE_VERSION } from "./types.js";
import { fmtWon } from "../labels.js";

export interface RelationalReport {
  results: ReviewResult[];
  edges: RelationshipEdge[];
}

const norm = (s: string): string => s.replace(/\s/g, "");

function edge(
  id: string,
  from: string,
  to: string,
  relation: RelationKind,
  basis: string,
  dsdFileHash: string,
  xmlPath: string,
): RelationshipEdge {
  return {
    id,
    objectType: "RelationshipEdge",
    schemaVersion: "1.0",
    source: { dsdFileHash, xmlPath },
    provenance: { extractedBy: "RelationalEngine", semanticBy: "rule:relational", confidence: "high" },
    from,
    to,
    relation,
    basis,
  };
}

function rr(
  id: string,
  check: string,
  status: ReviewResult["status"],
  targets: string[],
  sourceRefs: string[],
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
    sourceRefs,
    ...(extra.expected !== undefined ? { expected: extra.expected } : {}),
    ...(extra.actual !== undefined ? { actual: extra.actual } : {}),
    ...(extra.note ? { note: extra.note } : {}),
  };
}

// ── selectors ────────────────────────────────────────────────────────────────

function cfLine(
  lines: FinancialStatementLine[],
  pred: (acct: string) => boolean,
): FinancialStatementLine | undefined {
  return lines.find((l) => l.statement === "CF" && pred(norm(l.account)));
}

// ── ④ Cash Flow Intelligence (Doc 06 §5) ─────────────────────────────────────

export function checkCashFlow(objects: AomObject[]): RelationalReport {
  const lines = objects.filter(
    (o): o is FinancialStatementLine => o.objectType === "FinancialStatementLine",
  );
  const dsdFileHash = objects[0]?.source.dsdFileHash ?? "";
  const results: ReviewResult[] = [];
  const edges: RelationshipEdge[] = [];

  const bsCash = lines.find((l) => l.statement === "BS" && norm(l.account) === "현금및현금성자산");
  const cfEnd = cfLine(lines, (a) => a.includes("기말") && a.includes("현금및현금성자산"));
  const cfBegin = cfLine(lines, (a) => a.includes("기초") && a.includes("현금및현금성자산"));
  const cfDelta = cfLine(lines, (a) => a.includes("현금및현금성자산의증가"));
  // 표기가 제출사마다 다르다: "환율변동효과" · "현금및현금성자산의 환율변동으로 인한 효과".
  // 좁게 잡으면 환율효과를 빼먹고 기초+증감=기말 이 그 금액만큼 어긋난 것으로 보고한다
  // (반기보고서에서 Δ101,850,814 = 환율효과 전액이 그대로 불일치로 나왔다).
  const cfFx = cfLine(lines, (a) => /환율변동/.test(a) && /효과/.test(a));

  // Cash tie-out: CF 기말현금 == BS 현금및현금성자산 (exact, both in 원).
  if (cfEnd && bsCash) {
    const expected = bsCash.amount.current.value;
    const actual = cfEnd.amount.current.value;
    edges.push(
      edge(
        "aom:edge:cf-cash-bs",
        cfEnd.id,
        bsCash.id,
        "reconciles_with",
        "현금흐름표 기말현금 ↔ 재무상태표 현금및현금성자산",
        dsdFileHash,
        cfEnd.source.xmlPath,
      ),
    );
    results.push(
      rr(
        "relational:cash-tieout",
        "CashTieOut",
        expected === actual ? "match" : "mismatch",
        [cfEnd.id, bsCash.id],
        [cfEnd.source.xmlPath, bsCash.source.xmlPath],
        {
          expected,
          actual,
          note:
            expected === actual
              ? "기말현금 = BS 현금및현금성자산"
              : `기말현금 불일치: CF ${fmtWon(actual)} ≠ BS ${fmtWon(expected)}`,
        },
      ),
    );
  }

  // CF internal roll-forward: 기초 + 증감 + 환율효과 = 기말 (exact).
  if (cfBegin && cfDelta && cfEnd) {
    const expected =
      cfBegin.amount.current.value +
      cfDelta.amount.current.value +
      (cfFx?.amount.current.value ?? 0);
    const actual = cfEnd.amount.current.value;
    results.push(
      rr(
        "relational:cash-rollforward",
        "CashFlowRollForward",
        expected === actual ? "match" : "mismatch",
        [cfBegin.id, cfDelta.id, cfEnd.id, ...(cfFx ? [cfFx.id] : [])],
        [cfEnd.source.xmlPath],
        {
          expected,
          actual,
          note:
            expected === actual
              ? "기초 + 증감 + 환율효과 = 기말"
              : `현금흐름 항등식 불일치 (Δ${actual - expected})`,
        },
      ),
    );
  }

  // Investing ↔ PPE note reconciliation (§5): 즉시 mismatch 아닌 review + evidence.
  const cfPpeAcq = cfLine(lines, (a) => a === "유형자산의취득");
  const ppeAcq = ppeRollForwardMovement(objects, "취득");
  if (cfPpeAcq && ppeAcq) {
    edges.push(
      edge(
        "aom:edge:cf-ppe-acq",
        cfPpeAcq.id,
        ppeAcq.table.id,
        "reconciles_with",
        "현금흐름표 유형자산 취득 ↔ 유형자산 주석 취득열",
        dsdFileHash,
        cfPpeAcq.source.xmlPath,
      ),
    );
    const cfVal = Math.abs(cfPpeAcq.amount.current.value);
    const diff = Math.abs(cfVal - ppeAcq.value);
    // 상태를 "review" 로 못박아 두면 **두 값이 같아도** 검토 권장으로 나온다.
    // 실제로 차액 0원인데 확인이 필요한 항목으로 표시됐다. 값이 일치하면 일치다.
    // 차이가 있을 때만 §5 에 따라 단정하지 않고 확인을 권한다(비현금취득·미지급금).
    const same = diff === 0;
    results.push(
      rr(
        "relational:cf-ppe-acq",
        "CashFlowPpeAcq",
        same ? "match" : "review",
        [cfPpeAcq.id, ppeAcq.table.id],
        [cfPpeAcq.source.xmlPath, ppeAcq.table.source.xmlPath],
        {
          expected: ppeAcq.value,
          actual: cfVal,
          note: same
            ? `유형자산 취득 ${fmtWon(cfVal)}원이 현금흐름표와 유형자산 주석에서 일치`
            : `유형자산 취득 대사(검토 권장): CF ${fmtWon(cfVal)}원 vs 주석 취득 ${fmtWon(ppeAcq.value)}원 (차액 ${fmtWon(diff)}원 — 비현금취득·미지급금 조정 여부 확인)`,
        },
      ),
    );
  }

  return { results, edges };
}

/** Total value of a named movement row (e.g. 취득) in a PPE roll-forward note. */
function ppeRollForwardMovement(
  objects: AomObject[],
  rowLabel: string,
): { table: FinancialStatementTable; value: number } | undefined {
  const tables = objects.filter(
    (o): o is FinancialStatementTable =>
      o.objectType === "FinancialStatementTable" &&
      o.note === "13" &&
      o.tableType === "RollForward",
  );
  for (const t of tables) {
    const row = t.rows.find((r) => norm(r.label) === rowLabel);
    if (!row) continue;
    const nums = row.cells.filter((c) => c.number);
    if (nums.length === 0) continue;
    const total = nums[nums.length - 1]!.number!.value; // 합계 column
    return { table: t, value: total };
  }
  return undefined;
}

// ── ③ Cross-Note Integrity (Doc 06 §4) — depreciation chain ──────────────────

/**
 * Depreciation chain (§4): collect 감가상각비 from asset roll-forward notes
 * (유형자산·투자부동산) and link them into the graph. Presented as `review`
 * evidence (표시단위·집계 범위 판단 필요), not a machine-asserted equality.
 */
export function checkCrossNoteDepreciation(objects: AomObject[]): RelationalReport {
  const dsdFileHash = objects[0]?.source.dsdFileHash ?? "";
  const results: ReviewResult[] = [];
  const edges: RelationshipEdge[] = [];

  const contributors: { table: FinancialStatementTable; value: number }[] = [];
  for (const o of objects) {
    if (o.objectType !== "FinancialStatementTable") continue;
    if (o.tableType !== "RollForward") continue;
    const row = o.rows.find((r) => /감가상각비|감가상각/.test(norm(r.label)));
    if (!row) continue;
    const nums = row.cells.filter((c) => c.number);
    if (nums.length === 0) continue;
    contributors.push({ table: o, value: nums[nums.length - 1]!.number!.value });
  }
  if (contributors.length === 0) return { results, edges };

  const total = contributors.reduce((s, c) => s + c.value, 0);
  for (const c of contributors) {
    edges.push(
      edge(
        `aom:edge:dep:${c.table.id}`,
        c.table.id,
        "aom:chain:depreciation",
        "depreciation_flows_to",
        "감가상각비 → 비용의 성격별 분류 / 현금흐름 가산조정",
        dsdFileHash,
        c.table.source.xmlPath,
      ),
    );
  }
  results.push(
    rr(
      "relational:xnote-depreciation",
      "CrossNoteDepreciation",
      "review",
      contributors.map((c) => c.table.id),
      contributors.map((c) => c.table.source.xmlPath),
      {
        actual: total,
        note: `감가상각비 관계 체인(검토 권장): ${contributors.length}개 주석 표에서 감가상각비 집계 ${fmtWon(total)}원 (비용의 성격별 분류·현금흐름 가산조정과의 정합 확인)`,
      },
    ),
  );

  return { results, edges };
}

export function checkRelational(objects: AomObject[]): RelationalReport {
  const cf = checkCashFlow(objects);
  const xn = checkCrossNoteDepreciation(objects);
  return { results: [...cf.results, ...xn.results], edges: [...cf.edges, ...xn.edges] };
}
