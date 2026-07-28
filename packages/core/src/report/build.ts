// Build the audit review report (MVP ⑫; Doc 07 §4.4 tone). Pure, deterministic (§19).
//
// The report only QUOTES figures already produced by the deterministic engine /
// parser — it never computes financial values (§6). Tone follows §21 / Doc 07 §5.1:
//   · `error`  → factual statement (machine-certain).
//   · `review` → "추가 검토 권장" (no assertion).
// Every issue carries evidence with an xml_path Drill-down (§20, Doc 04 §8).

import type { AomObject, FinancialStatementTable, Issue, ReviewResult } from "../aom/types.js";
import type { AomModel } from "../aom/builder.js";
import type { EngineReport } from "../engine/run.js";
import { objectLabel, noteTitleMap, checkKo, resultSubject, fmtWon } from "../labels.js";
import { buildCoverage, coverageTotals } from "./coverage.js";
import { buildVariance } from "./variance.js";
import { buildReviewQueries } from "./queries.js";
import { reviewSubsequentEvents, searchQueries } from "./subsequent.js";
import type { ParsedDocument } from "../dsd/parser.js";
import { creditLine } from "../brand.js";
import { REPORT_VERSION, type Block, type ReportDoc } from "./types.js";

// ── formatting (presentation only — not calculation, §6) ─────────────────────

/** Quote an integer KRW figure as displayed (negatives in parentheses). */
function won(n: number | undefined): string {
  if (n === undefined) return "-";
  const abs = Math.abs(n).toLocaleString("en-US");
  return n < 0 ? `(${abs})` : abs;
}

const STATUS_KO: Record<ReviewResult["status"], string> = {
  match: "일치",
  mismatch: "불일치",
  review: "검토 권장",
  skipped: "해당 없음",
};
const SEVERITY_KO: Record<Issue["severity"], string> = {
  error: "오류",
  review: "검토 권장",
  info: "참고",
};

function labelIndex(objects: AomObject[]): Map<string, AomObject> {
  return new Map(objects.map((o) => [o.id, o]));
}

/** Human label (incl. note title) + source drill-down for an evidence id (§20). */
function evidenceLabel(id: string, index: Map<string, AomObject>, notes: Map<string, string>): string {
  const o = index.get(id);
  if (!o) return id;
  const src = o.source;
  const at = `${src.xmlPath}${src.page !== undefined ? ` · p.${src.page}` : ""}`;
  return `${objectLabel(o, notes)} (${at})`;
}

function primaryPeriod(objects: AomObject[]): { current: string; prior?: string } | undefined {
  const t = objects.find(
    (o): o is FinancialStatementTable =>
      o.objectType === "FinancialStatementTable" && o.statement === "BS",
  );
  return t?.period;
}

// ── report assembly ──────────────────────────────────────────────────────────

export function buildAuditReport(
  model: AomModel,
  engine: EngineReport,
  parsed?: ParsedDocument,
): ReportDoc {
  const objects = model.objects;
  const index = labelIndex(objects);
  const notes = noteTitleMap(objects);
  const doc = objects.find((o) => o.objectType === "Document");
  const company = doc?.objectType === "Document" ? doc.docName : undefined;
  const companyName = doc?.objectType === "Document" ? doc.company : undefined;
  const fiscal = doc?.objectType === "Document" ? doc.fiscal : undefined;
  const schema = doc?.objectType === "Document" ? doc.schema : undefined;
  const pageCount = doc?.objectType === "Document" ? doc.pageCount : undefined;
  const period = primaryPeriod(objects);

  const blocks: Block[] = [];
  const H = (level: 1 | 2 | 3, text: string): void => void blocks.push({ kind: "heading", level, text });
  const P = (text: string): void => void blocks.push({ kind: "paragraph", text });

  // 0) Title + BLUF.
  const errorCount = engine.summary.issues.error;
  const reviewCount = engine.summary.issues.review;
  // 제목에 회사·기수·대상기간을 함께 실어, 문서 하나만 봐도 대상이 특정되게 한다.
  H(1, "감사 검토 리포트 (ARI)");
  if (companyName || fiscal) {
    P(`${companyName ?? ""}${companyName && fiscal ? " · " : ""}${fiscal?.label ?? ""}`);
  }
  P(
    `본 리포트는 DSD 원문을 결정론 엔진으로 검토한 결과입니다. 기계 확정 오류 ${errorCount}건, ` +
      `추가 검토 권장 ${reviewCount}건이 확인되었습니다. 모든 수치는 원문 값을 그대로 인용하며(§6), ` +
      `추가 검토 권장 항목은 오류 단정이 아닌 확인 권고입니다(§21).`,
  );

  // 1) 문서 개요.
  H(2, "1. 문서 개요");
  blocks.push({
    kind: "list",
    items: [
      `회사: ${companyName ?? "-"}`,
      `문서: ${company ?? "-"}`,
      // 기수·회계기간·결산일 — 조서로 쓰려면 어느 기의 검토인지가 반드시 있어야 한다.
      `기수·대상기간: ${fiscal?.label ?? (period ? `${period.current}${period.prior ? ` (전기 ${period.prior})` : ""}` : "-")}`,
      ...(fiscal?.prior?.start
        ? [`전기: 제${fiscal.prior.term}기 ${fiscal.prior.start.replace(/-/g, ".")} ~ ${(fiscal.prior.end ?? "").replace(/-/g, ".")}`]
        : []),
      ...(fiscal?.caveat ? [`유의: ${fiscal.caveat}`] : []),
      `스키마: ${schema ?? "-"} · 페이지: ${pageCount ?? "-"}`,
      `원본 해시(§7): ${model.dsdFileHash}`,
      `엔진 버전(§19): ${engine.engineVersion} · 리포트 버전: ${REPORT_VERSION}`,
    ],
  });

  // 2) 검토 요약.
  H(2, "2. 검토 요약");
  P(
    `총 검증 ${engine.summary.total}건. 기계 확정 불일치(오탐 지표) ${engine.summary.mismatches}건.`,
  );
  blocks.push({
    kind: "table",
    headers: ["판정", "건수"],
    rows: (["match", "mismatch", "review", "skipped"] as const).map((s) => [
      STATUS_KO[s],
      String(engine.summary.byStatus[s] ?? 0),
    ]),
  });
  blocks.push({
    kind: "table",
    headers: ["검증 종류", "건수"],
    rows: Object.entries(engine.summary.byCheck)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => [k, String(v)]),
  });

  // 3) FS Integrity.
  H(2, "3. 재무제표 무결성 (FS Integrity)");
  const fs = engine.results.filter((r) => r.check === "FsBalance" || r.check === "FsAnchor");
  blocks.push({
    kind: "table",
    headers: ["검증", "항목", "기대", "실제", "판정", "근거"],
    rows: fs.map((r) => [
      checkKo(r.check),
      resultSubject(r, index, notes),
      won(r.expected),
      won(r.actual),
      STATUS_KO[r.status],
      r.note ?? "",
    ]),
  });

  // 4) 현금흐름 대사.
  H(2, "4. 현금흐름 대사 (Cash Flow)");
  const cash = engine.results.filter((r) => r.check.startsWith("Cash"));
  blocks.push({
    kind: "table",
    headers: ["검증", "항목", "기대", "실제", "판정", "설명"],
    rows: cash.map((r) => [
      checkKo(r.check),
      resultSubject(r, index, notes),
      won(r.expected),
      won(r.actual),
      STATUS_KO[r.status],
      r.note ?? "",
    ]),
  });

  // 5) 이슈 목록 (severity별, §21 톤).
  H(2, "5. 검토 이슈");
  renderIssues(blocks, engine.issues, "error", index, notes);
  renderIssues(blocks, engine.issues, "review", index, notes);
  if (errorCount === 0 && reviewCount === 0) P("확인된 이슈가 없습니다.");

  // 6) 검토 질문 (Insight) — AI 해석 레이어 (Doc 07 §4.1/§4.2).
  H(2, "6. 검토 질문 (Insight)");
  P(
    "아래 질문은 AI 해석 레이어가 결정론 엔진의 검토 권장 항목을 근거와 함께 감사인 질문으로 " +
      "변환한 것입니다. 오류 단정이 아니며(§21), 모든 수치는 근거에서만 인용합니다(§6·§5). " +
      `제공자: ${engine.insights[0]?.provider ?? "offline-grounded"}.`,
  );
  const CONF_KO: Record<string, string> = { high: "높음", medium: "중간", low: "낮음" };
  engine.insights.forEach((ins, n) => {
    H(3, `Q${n + 1} · ${ins.check} · 신뢰도 ${CONF_KO[ins.confidence] ?? ins.confidence}`);
    P(ins.question);
    P(`판단 근거: ${ins.rationale}`);
    P(`잠재 위험: ${ins.potentialRisk}`);
    blocks.push({
      kind: "list",
      items: ins.evidence.map((e) => {
        const figs = e.figures.length ? ` — 수치 ${e.figures.join(", ")}` : "";
        const at = `${e.xmlPath}${e.page !== undefined ? ` · p.${e.page}` : ""}`;
        return `근거: ${e.label}${figs} (${at})`;
      }),
    });
  });
  if (engine.insights.length === 0) P("생성된 검토 질문이 없습니다.");

  // 심리실 예상 질의 — 제출 전 준비 사항 (가장 먼저 필요한 정보).
  const queries = buildReviewQueries(model);
  if (queries.length > 0) {
    H(2, `심리실 예상 질의 — 제출 전 준비 사항 ${queries.length}건`);
    P(
      "유의적 변동과 재무제표 간 관계를 근거로, 심리 단계에서 제기될 가능성이 높은 질문을 정리했습니다. " +
        "각 질문에 대한 근거 수치와 준비 자료를 함께 표시합니다.",
    );
    blocks.push({
      kind: "table",
      headers: ["우선순위", "구분", "대상", "예상 질의", "근거", "준비 자료"],
      rows: queries.map((q) => [
        q.priority === "high" ? "필수 준비" : "준비 권장",
        q.area,
        q.subject,
        `${q.question}?`,
        q.basis,
        q.prepare,
      ]),
    });
  }

  // 보고기간후사건 점검 (K-IFRS 1010) — 누락이 잦은 공시.
  if (parsed) {
    const se = reviewSubsequentEvents(parsed);
    H(2, "보고기간후사건 점검 (K-IFRS 1010)");
    P(
      `검토 대상 기간: ${se.periodEnd ?? "보고기간말"} ~ ${se.auditReportDate ?? "감사보고서일"}. ` +
        "본 앱은 파일 외부 정보를 알 수 없으므로 누락 여부를 단정하지 않으며, " +
        "아래 유형에 대해 DART 공시·뉴스 확인을 권장합니다.",
    );
    if (se.noteFound) {
      P(`[주석${se.noteNo ?? ""} 기재 내용] ${se.disclosedText.slice(0, 500)}`);
      P(
        `기재가 확인된 유형: ${se.covered.length ? se.covered.map((c) => c.label).join(", ") : "없음"}`,
      );
    } else {
      P("보고기간후사건 주석을 찾지 못했습니다 — 해당 주석 자체의 누락 여부 확인이 필요합니다.");
    }
    blocks.push({
      kind: "table",
      headers: ["사건 유형", "왜 중요한가", "DART·뉴스 검색어"],
      rows: se.toVerify.map((c) => [c.label, c.why, c.searchTerms.join(" / ")]),
    });
    blocks.push({ kind: "list", items: searchQueries(se).slice(0, 10) });
  }

  // 7) 증감분석 — 당기/전기 변동과 유의적 항목 (감사인이 먼저 보는 화면).
  H(2, "7. 증감분석 (당기 vs 전기)");
  const variance = buildVariance(model);
  for (const sec of variance) {
    const flagged = sec.rows.filter((r) => r.significant);
    H(3, `${sec.title} — 유의적 변동 ${flagged.length}건 / 전체 ${sec.rows.length}개 계정`);
    blocks.push({
      kind: "table",
      headers: ["계정", "당기", "전기", "증감액", "증감율", "유의성", "관련주석"],
      rows: sec.rows.map((r) => [
        r.account,
        fmtWon(r.current),
        fmtWon(r.prior),
        fmtWon(r.delta),
        r.pct === undefined ? "-" : `${r.pct > 0 ? "+" : ""}${r.pct.toFixed(1)}%`,
        r.significant ? `● ${r.reason ?? ""}` : "",
        r.noteRef.join(", "),
      ]),
    });
  }

  // 8) 검토 수행 내역 — 무엇을 어떻게 검증했는지 전수 기록 (감사조서 증빙).
  const coverage = buildCoverage(model, engine);
  const tot = coverageTotals(coverage);
  H(2, "8. 검토 수행 내역 (Coverage)");
  P(
    `검토 대상 ${tot.items}개 항목에 대해 총 ${tot.checks}건의 검증을 수행했으며, ` +
      `그중 ${tot.clean}개 항목은 전 검증 항목이 일치했습니다. 아래는 항목별 수행 내역입니다.`,
  );
  blocks.push({
    kind: "table",
    headers: ["항목", "수행한 검증 → 결과", "검증 방법 / 사유", "위치"],
    rows: coverage.map((c) => [
      c.item,
      c.summary,
      [...c.methods, ...c.reasons.map((r) => `사유: ${r}`)].join(" / "),
      c.location,
    ]),
  });

  // 문서 말미 크레딧 — 조서에 편철했을 때 출처와 도구 버전이 남도록.
  P(creditLine());

  return { title: `감사 검토 리포트 — ${companyName ?? ""}${fiscal ? ` ${fiscal.label}` : ""}`.trim(), blocks };
}

function renderIssues(
  blocks: Block[],
  issues: Issue[],
  severity: Issue["severity"],
  index: Map<string, AomObject>,
  notes: Map<string, string>,
): void {
  const list = issues.filter((i) => i.severity === severity);
  if (list.length === 0) return;
  blocks.push({ kind: "heading", level: 3, text: `[${SEVERITY_KO[severity]}] ${list.length}건` });
  for (const i of list) {
    // Prefix with the subject (which note/account) so the issue is self-explanatory.
    const ev0 = i.evidence[0];
    const item = ev0 && index.has(ev0) ? objectLabel(index.get(ev0)!, notes) : "";
    // §21 tone: error → factual; review → recommendation.
    const body = severity === "error" ? i.title : `추가 검토가 권장됩니다 — ${i.title}`;
    const stmt = item ? `[${item}] ${body}` : body;
    blocks.push({ kind: "paragraph", text: stmt });
    const evidence = i.evidence.map((id) => `근거: ${evidenceLabel(id, index, notes)}`);
    const trail = i.drilldown.filter((d) => d.startsWith("/")).map((d) => `Drill-down: ${d}`);
    if (evidence.length || trail.length)
      blocks.push({ kind: "list", items: [...evidence, ...trail] });
  }
}
