// MVP ⑩ Dashboard — self-contained static HTML dashboard (headless preview of the
// Tauri shell). Deterministic (§19), zero deps, single file openable in any
// browser. Design language: 04_UI_UX_Design_Spec (monochrome · sharp · dense).
// Only QUOTES engine output; never computes figures (§6). §21 tone throughout.

import type { AomObject, FinancialStatementLine } from "../aom/types.js";
import type { AomModel } from "../aom/builder.js";
import type { EngineReport } from "../engine/run.js";
import { objectLabel, noteTitleMap, checkKo, resultSubject, humanLocation } from "../labels.js";
import { buildCoverage, coverageTotals } from "./coverage.js";
import { buildVariance } from "./variance.js";
import { buildReviewQueries, diagnoseQueries } from "./queries.js";
import { reviewSubsequentEvents, searchQueries, searchName } from "./subsequent.js";
import { assessParseHealth } from "./health.js";
import {
  APP_FULL_NAME,
  APP_RELEASED,
  APP_VERSION,
  AUTHOR,
  COPYRIGHT_YEAR,
  DISCLAIMER,
} from "../brand.js";
import type { ParsedDocument } from "../dsd/parser.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function won(n: number | undefined): string {
  if (n === undefined) return "-";
  const a = Math.abs(n).toLocaleString("en-US");
  return n < 0 ? `(${a})` : a;
}
const STATUS_KO: Record<string, string> = {
  match: "일치",
  mismatch: "불일치",
  review: "검토 권장",
  skipped: "해당 없음",
};

// 5절 "재무제표 정합성 · 연계성"에 싣는 검증. Cash* 는 접두사로 따로 걸러진다.
// 연계성 검증(Equity*/…ToEquity/…ToCashFlow)은 여러 표에 흩어진 정보를 맞대는 것이라
// 총계 대사와 같은 자리에서 함께 읽혀야 의미가 있다.
const FS_SECTION_CHECKS = new Set([
  "FsBalance",
  "FsBalanceComponents",
  "FsAnchor",
  "EquityRollForward",
  "EquityToBs",
  "NetIncomeToEquity",
  "ComprehensiveIncomeToEquity",
  "DividendToCashFlow",
]);

// state → CSS class (see <style>): mono match, red critical, outline review.
function stateClass(sev: string): string {
  return sev === "error" ? "s-err" : sev === "info" ? "s-info" : "s-rev";
}

export function renderHtmlDashboard(
  model: AomModel,
  engine: EngineReport,
  parsed?: ParsedDocument,
): string {
  const objects = model.objects;
  const doc = objects.find((o) => o.objectType === "Document");
  const company = doc?.objectType === "Document" ? doc.company : "";
  const docName = doc?.objectType === "Document" ? doc.docName : "";
  const fiscal = doc?.objectType === "Document" ? doc.fiscal : undefined;
  const s = engine.summary;
  const total = s.total || 1;
  const score = Math.round((100 * (s.byStatus["match"] ?? 0)) / total);
  const index = new Map<string, AomObject>(objects.map((o) => [o.id, o]));
  const notes = noteTitleMap(objects);
  const itemOf = (id: string | undefined): string =>
    id && index.has(id) ? objectLabel(index.get(id)!, notes) : "";
  const srcOf = (id: string | undefined): string => {
    if (!id) return "";
    const o = index.get(id);
    if (!o) return "";
    return `${o.source.xmlPath}${o.source.page !== undefined ? ` · p.${o.source.page}` : ""}`;
  };
  const lines = objects.filter(
    (o): o is FinancialStatementLine => o.objectType === "FinancialStatementLine",
  );

  const metric = (label: string, value: string, cls = ""): string =>
    `<div class="m"><div class="ml">${esc(label)}</div><div class="mv ${cls}">${esc(value)}</div></div>`;

  const issueRows = engine.issues
    .map((i) => {
      const stmt = i.severity === "error" ? esc(i.title) : `추가 검토가 권장됩니다 — ${esc(i.title)}`;
      const tag = STATUS_KO[i.severity === "error" ? "mismatch" : i.severity] ?? i.severity;
      const ev = i.evidence[0];
      const loc = ev && index.has(ev) ? humanLocation(index.get(ev)!, notes) : "";
      return `<tr><td><span class="tag ${stateClass(i.severity)}">${esc(tag)}</span></td><td>${esc(itemOf(ev))}</td><td>${stmt}</td><td class="loc">${esc(loc)}</td></tr>`;
    })
    .join("");

  const insightCards = engine.insights
    .map((ins, n) => {
      const ev = ins.evidence
        .map((e) => {
          const figs = e.figures.length ? ` · ${esc(e.figures.join(", "))}` : "";
          const at = e.page !== undefined ? ` (p.${e.page})` : "";
          return `<li>${esc(e.label)}${figs}${at}</li>`;
        })
        .join("");
      return `<div class="ins"><div class="insq">Q${n + 1}. ${esc(ins.question)}</div><div class="insr">판단 근거: ${esc(ins.rationale)}</div><div class="insr">잠재 위험: ${esc(ins.potentialRisk)}</div><ul class="inse">${ev}</ul></div>`;
    })
    .join("");

  const fsRows = engine.results
    .filter((r) => FS_SECTION_CHECKS.has(r.check) || r.check.startsWith("Cash"))
    .map(
      (r) =>
        `<tr><td>${esc(checkKo(r.check))}</td><td>${esc(resultSubject(r, index, notes))}</td><td class="num">${won(r.expected)}</td><td class="num">${won(r.actual)}</td><td><span class="tag ${r.status === "match" ? "s-ok" : "s-rev"}">${STATUS_KO[r.status]}</span></td><td class="src">${esc(r.note ?? "")}</td></tr>`,
    )
    .join("");

  // 증감분석 — 유의적 변동을 먼저 보여준다 (감사인의 첫 작업).
  const variance = buildVariance(model);
  const varianceHtml = variance
    .map((sec) => {
      const flagged = sec.rows.filter((r) => r.significant).length;
      // Bar width is proportional to |증감율|, capped at 100% of the cell.
      const maxPct = Math.max(30, ...sec.rows.map((r) => Math.min(Math.abs(r.pct ?? 0), 300)));
      const rows = sec.rows
        .map((r) => {
          const pctNum = r.pct;
          const pct = pctNum === undefined ? "-" : `${pctNum > 0 ? "+" : ""}${pctNum.toFixed(1)}%`;
          const cls = pctNum === undefined ? "" : pctNum > 0 ? "up" : "down";
          const w =
            pctNum === undefined ? 0 : Math.round((Math.min(Math.abs(pctNum), 300) / maxPct) * 88);
          const bar =
            pctNum === undefined
              ? ""
              : `<div class="barwrap"><span class="${cls}">${pct}</span><span class="bar ${pctNum > 0 ? "p" : "n"}" style="width:${w}px"></span></div>`;
          const flag = r.significant
            ? `<span class="tag s-rev">${esc(r.reason ?? "유의")}</span>`
            : "";
          return `<tr${r.significant ? ' class="hi"' : ""}><td>${esc(r.account)}</td><td class="num">${won(r.current)}</td><td class="num">${won(r.prior)}</td><td class="num ${cls}">${won(r.delta)}</td><td class="num">${bar}</td><td>${flag}</td></tr>`;
        })
        .join("");
      return `<h3>${esc(sec.title)} <span class="sub">유의적 변동 ${flagged}건 / ${sec.rows.length}개 계정</span></h3>
<table><thead><tr><th>계정</th><th style="text-align:right">당기</th><th style="text-align:right">전기</th><th style="text-align:right">증감액</th><th style="text-align:right">증감율</th><th>유의성</th></tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join("");

  // 심리실 예상 질의 — 기말 시즌에 가장 먼저 필요한 것.
  const queries = buildReviewQueries(model);
  const queryCards = queries
    .map((q) => {
      const pri = q.priority === "high" ? "s-err" : "s-rev";
      const priTxt = q.priority === "high" ? "필수 준비" : "준비 권장";
      return `<div class="qcard"><div class="qhead"><span class="tag ${pri}">${priTxt}</span> <span class="qarea">${esc(q.area)}</span> · <b>${esc(q.subject)}</b></div>
<div class="qq">Q. ${esc(q.question)}?</div>
<div class="qb">근거: ${esc(q.basis)}</div>
<div class="qp">준비 자료: ${esc(q.prepare)}</div></div>`;
    })
    .join("");

  // 보고기간후사건 점검 (K-IFRS 1010) — 누락이 잦은 공시.
  let subsequentHtml = "";
  if (parsed) {
    const se = reviewSubsequentEvents(parsed);
    const win =
      se.periodEnd && se.auditReportDate
        ? `${se.periodEnd} ~ ${se.auditReportDate}`
        : "보고기간말 ~ 감사보고서일";
    const disclosed = se.noteFound
      ? `<div class="disc"><b>주석${esc(se.noteNo ?? "")} 기재 내용</b><p>${esc(se.disclosedText.slice(0, 400))}${se.disclosedText.length > 400 ? "…" : ""}</p>
<p class="cov">기재 확인된 유형: ${se.covered.length ? esc(se.covered.map((c) => c.label).join(", ")) : "없음"}</p></div>`
      : `<div class="disc warn2"><b>보고기간후사건 주석이 없습니다 — 외부 확인이 특히 중요합니다</b>
<p>이 보고서에는 보고기간후사건 주석이 기재되어 있지 않습니다. 해당 기간에 공시 대상 사건이 <b>실제로 없었는지</b>, 아니면 <b>기재가 누락된 것인지</b>는 파일만으로 알 수 없습니다.</p>
<p>아래 유형에 대해 DART 공시·뉴스를 반드시 확인하십시오. 공시된 사건이 하나라도 있으면 주석 누락에 해당합니다 (K-IFRS 1010).</p></div>`;
    const rows = se.toVerify
      .map(
        (c) =>
          `<tr><td><b>${esc(c.label)}</b></td><td>${esc(c.why)}</td><td class="q">${esc(c.searchTerms.join(" / "))}</td></tr>`,
      )
      .join("");
    // DART's search form submits via JavaScript, so a URL query cannot pre-run
    // the search — the page would open empty. Instead give the exact trade name
    // to paste (DART matches the trade name only: "영풍전자 주식회사" finds nothing)
    // with a copy button. News search does work as a direct query link.
    const co = searchName(se.company) || (se.company ?? "");
    const dartUrl = `https://dart.fss.or.kr/dsab001/main.do`;
    const newsLink = (term: string): string =>
      `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(`${co} ${term}`)}`;
    const queriesList =
      `<li><a href="${dartUrl}" target="_blank" rel="noopener"><b>DART 회사별 검색 열기</b></a>` +
      ` → 회사명에 <code class="copy" data-copy="${esc(co)}" title="클릭하면 복사됩니다">${esc(co)}</code> 붙여넣기` +
      ` · ${esc(se.periodEnd ?? "")} 이후 접수분 확인` +
      ` <span class="hint">(DART는 "주식회사"를 뺀 상호로 검색합니다)</span></li>` +
      se.toVerify
        .map(
          (c) =>
            `<li>${esc(c.label)}: ` +
            c.searchTerms
              .map(
                (t) =>
                  `<a href="${newsLink(t)}" target="_blank" rel="noopener">${esc(t)}</a>`,
              )
              .join(" · ") +
            `</li>`,
        )
        .join("");
    subsequentHtml = `<p class="lead">검토 대상 기간: <b>${esc(win)}</b>. 이 기간의 DART 공시·뉴스를 아래 항목 기준으로 확인하십시오. 앱은 파일 외부 정보를 알 수 없으므로 <b>누락 여부를 단정하지 않습니다</b>.</p>
${disclosed}
<h3>외부 확인이 필요한 유형 <span class="sub">${se.toVerify.length}개 — 주석에 언급되지 않음</span></h3>
<table><thead><tr><th style="width:20%">사건 유형</th><th style="width:42%">왜 중요한가</th><th>DART·뉴스 검색어</th></tr></thead><tbody>${rows}</tbody></table>
<h3>바로 확인하기 <span class="sub">클릭하면 DART·뉴스 검색이 열립니다</span></h3>
<ul class="inse links">${queriesList}</ul>`;
  }

  // 검토 수행 내역 — 무엇을 검증했고 결과가 무엇인지 (감사조서 증빙).
  const coverage = buildCoverage(model, engine);
  const cov = coverageTotals(coverage);
  const coverageRows = coverage
    .map((c) => {
      const cls = c.worst === "match" ? "s-ok" : c.worst === "mismatch" ? "s-err" : "s-rev";
      const badge =
        c.worst === "match"
          ? "일치"
          : c.worst === "mismatch"
            ? "불일치"
            : c.worst === "review"
              ? "확인 필요"
              : "판정 불가";
      const detail =
        `<details><summary>검증 방법 보기</summary>` +
        c.methods.map((mth) => `<p>· ${esc(mth)}</p>`).join("") +
        (c.reasons.length
          ? c.reasons.map((rs) => `<p>· 사유: ${esc(rs)}</p>`).join("")
          : "") +
        `</details>`;
      return `<tr><td>${esc(c.item)}</td><td class="how">${esc(c.summary)}${detail}</td><td><span class="tag ${cls}">${badge}</span></td><td class="loc">${esc(c.location)}</td></tr>`;
    })
    .join("");

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>감사보고서 검토 결과 · ${esc(company ?? "")}</title>
<style>
:root{--ink900:#191919;--ink800:#3D3D3D;--ink700:#777;--ink300:#E0E0E0;--ink200:#EFEFEF;--ink100:#F7F7F7;
--red:#E5342F;--redbg:#FDECEB;--amber:#B4690E;--amberbg:#FDF3E3;--green:#137A45;--greenbg:#E9F6EE;--blue:#1D4ED8;--bluebg:#EAF1FE}
*{box-sizing:border-box}
body{margin:0;font-family:Pretendard,-apple-system,"Helvetica Neue",sans-serif;letter-spacing:-.01em;color:var(--ink900);background:#fff;font-size:15px;line-height:1.55}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px 56px}
.top{display:flex;align-items:center;gap:12px;padding:18px 0;border-bottom:2px solid var(--ink900)}
.brand{font-weight:900;font-size:22px;letter-spacing:-.03em}
.brand small{display:block;font-size:12px;font-weight:600;color:var(--ink700);letter-spacing:0}
.file{color:var(--ink800);font-size:15px;font-weight:700}
.badge{font-size:11px;font-weight:800;padding:3px 8px;border:1px solid var(--ink900);border-radius:2px}
.badge.grey{border:0;background:var(--ink100);color:#555}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0 8px}
.m{background:var(--ink100);padding:14px 16px;border-radius:4px}
.m.good{background:var(--greenbg)} .m.warn{background:var(--amberbg)} .m.bad{background:var(--redbg)}
.ml{font-size:12px;font-weight:700;color:var(--ink700)}
.mv{font-size:30px;font-weight:800;letter-spacing:-.03em;margin-top:2px}
.mv.red{color:var(--red)} .mv.green{color:var(--green)} .mv.amber{color:var(--amber)}
h2{font-size:19px;font-weight:800;letter-spacing:-.02em;margin:34px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--ink300)}
h3{font-size:16px;font-weight:800;letter-spacing:-.02em;margin:22px 0 8px}
h3 .sub{font-weight:600;color:var(--ink700);font-size:13px;margin-left:8px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--ink200);vertical-align:top}
th{background:var(--ink100);font-weight:800;font-size:13px;color:var(--ink800)}
td.num{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}
td.loc{color:var(--ink700);font-size:13px}
td.how{color:var(--ink800);font-size:13px}
.tag{font-size:12px;font-weight:800;padding:2px 8px;border-radius:3px;white-space:nowrap;display:inline-block}
.s-ok{background:var(--greenbg);color:var(--green)}
.s-rev{background:var(--amberbg);color:var(--amber)}
.s-err{background:var(--red);color:#fff}
.s-info{background:var(--ink100);color:#555}
.up{color:var(--red);font-weight:800} .down{color:var(--blue);font-weight:800}
.bar{display:inline-block;height:9px;border-radius:2px;vertical-align:middle;min-width:2px}
.bar.p{background:var(--red)} .bar.n{background:var(--blue)}
.barwrap{display:flex;align-items:center;gap:6px;justify-content:flex-end}
.ins{border:1px solid var(--ink200);border-left:4px solid var(--amber);background:#FFFDF9;padding:12px 14px;margin:10px 0;border-radius:3px}
.insq{font-weight:800;margin-bottom:6px;font-size:15px}
.insr{color:var(--ink800);margin:3px 0;font-size:14px}
.inse{margin:8px 0 0;padding-left:18px;color:var(--ink700);font-size:13px}
.foot{margin-top:32px;color:var(--ink700);font-size:12px;border-top:1px solid var(--ink200);padding-top:12px}
tr.hi td{background:#FFF8F7}
p.lead{font-size:15px;color:var(--ink800);margin:6px 0 12px}
details{margin-top:4px} summary{cursor:pointer;color:var(--blue);font-size:13px;font-weight:700}
details p{margin:6px 0 0;color:var(--ink800);font-size:13px}
.qcard{border:1px solid var(--ink300);border-left:4px solid var(--red);border-radius:3px;padding:12px 14px;margin:10px 0;background:#FFFCFC}
.qcard:nth-child(even){background:#fff}
.qhead{font-size:13px;color:var(--ink800);margin-bottom:6px}
.qarea{color:var(--ink700);font-size:12px}
.qq{font-size:15px;font-weight:800;margin:4px 0 6px;line-height:1.5}
.qb{font-size:13px;color:var(--ink800);font-variant-numeric:tabular-nums}
.qp{font-size:13px;color:var(--blue);margin-top:4px}
.disc{border:1px solid var(--ink300);border-left:4px solid var(--green);background:#F8FCF9;padding:12px 14px;margin:10px 0;border-radius:3px}
.disc.warn2{border-left-color:var(--red);background:var(--redbg)}
.disc p{margin:6px 0 0;font-size:14px;color:var(--ink800)}
.disc p.cov{color:var(--green);font-weight:700;font-size:13px}
td.q{font-size:13px;color:var(--blue)}
ul.links{font-size:14px;line-height:2}
ul.links a{color:var(--blue);font-weight:700;text-decoration:none;border-bottom:1px solid var(--bluebg)}
ul.links a:hover{border-bottom-color:var(--blue)}
code.copy{background:var(--bluebg);color:var(--blue);border:1px solid var(--blue);border-radius:3px;
padding:1px 7px;font-family:inherit;font-weight:800;cursor:pointer}
code.copy:hover{background:var(--blue);color:#fff}
code.copy.done{background:var(--greenbg);color:var(--green);border-color:var(--green)}
.hint{color:var(--ink700);font-size:12px;font-weight:400}
.period{margin:2px 0 14px;font-size:14px;color:var(--ink800);font-weight:700;font-variant-numeric:tabular-nums}
.period .cav{display:block;margin-top:4px;font-weight:600;font-size:13px;color:var(--red)}
.credit{margin-top:26px;padding-top:14px;border-top:1px solid var(--ink300);
font-size:12px;color:var(--ink700);line-height:1.9}
.credit a{color:var(--ink700)}
</style></head><body><div class="wrap">
<div class="top"><span class="brand">감사보고서 검토 결과<small>ARI 자동 검토 엔진</small></span>
<span class="file">${esc(company ?? "")} · ${esc(docName ?? "")}</span>
<span style="margin-left:auto"></span><span class="badge">내 PC에서 처리</span><span class="badge grey">원본 미변경</span></div>

${
  // 기수·회계기간·결산일 — 어느 기의 검토인지 밝히지 않으면 조서로 쓸 수 없다.
  fiscal
    ? `<div class="period">${esc(fiscal.label)}${
        fiscal.caveat ? `<span class="cav">${esc(fiscal.caveat)}</span>` : ""
      }</div>`
    : ""
}

${(() => {
  // 인식 진단 — 결과를 보여주기 전에 "얼마나 읽었는지"부터 밝힌다.
  // 빈 보고서를 조용히 내보내 잘못된 안심을 주는 실패를 막는다.
  const h = assessParseHealth(model);
  const gapNote =
    h.noteGaps.length > 0
      ? `<p style="color:var(--ink700);font-size:13px">주석 번호 ${h.noteGaps.join("·")}번은 원문에 없습니다 — 제출사가 번호를 건너뛴 경우가 대부분이며, 원문을 확인해 실제 누락인지 판단하십시오.</p>`
      : "";
  const facts = `<p style="color:var(--ink700);font-size:13px">인식 결과 — 재무제표 ${h.statements.join("·") || "없음"} · 계정 ${h.fsLines.toLocaleString()}개(전기 비교 ${h.withPrior.toLocaleString()}개) · 주석 ${h.notes}개 · 표 ${h.tables.toLocaleString()}개</p>`;
  if (h.level === "ok" && h.noteGaps.length === 0) {
    return `<div class="disc"><b>${esc(h.headline)}</b>${facts}</div>`;
  }
  const items = h.findings
    .map((f) => `<p><b>${esc(f.what)}</b><br><span style="color:var(--ink700)">${esc(f.impact)}</span></p>`)
    .join("");
  return `<div class="disc ${h.level === "ok" ? "" : "warn2"}"><b>${esc(h.headline)}</b>${items}${gapNote}${facts}</div>`;
})()}

<div class="metrics">
<div class="m"><div class="ml">검증 일치율</div><div class="mv green">${score}%</div></div>
<div class="m ${s.issues.review > 0 ? "warn" : ""}"><div class="ml">확인이 필요한 항목</div><div class="mv ${s.issues.review > 0 ? "amber" : ""}">${s.issues.review}건</div></div>
<div class="m ${s.mismatches > 0 ? "bad" : "good"}"><div class="ml">불일치(오류)</div><div class="mv ${s.mismatches > 0 ? "red" : "green"}">${s.mismatches}건</div></div>
<div class="m"><div class="ml">수행한 검증</div><div class="mv">${s.total}건</div></div>
</div>

<h2>1. 심리실 예상 질의 <span style="font-size:13px;font-weight:600;color:var(--ink700)">— 제출 전 준비 사항 ${queries.length}건</span></h2>
<p class="lead">유의적 변동과 재무제표 간 관계를 근거로, 심리 단계에서 제기될 가능성이 높은 질문을 정리했습니다.</p>
${
  queryCards ||
  (() => {
    const d = diagnoseQueries(model);
    return `<div class="disc warn2"><b>예상 질의를 생성하지 못했습니다</b>
<p>${esc(d.reason ?? "원인을 특정하지 못했습니다.")}</p>
<p style="color:var(--ink700);font-size:13px">인식 결과 — 재무제표 계정 ${d.fsLines}개 · 전기 비교 있는 계정 ${d.withPrior}개 · 유의적 변동 ${d.significant}개</p></div>`;
  })()
}

<h2>2. 보고기간후사건 점검 <span style="font-size:13px;font-weight:600;color:var(--ink700)">— K-IFRS 1010</span></h2>
${subsequentHtml || "<p>파싱 정보가 없어 점검을 수행하지 못했습니다.</p>"}

<h2>3. 확인이 필요한 항목</h2>
<p class="lead">아래는 오류로 단정한 것이 아니라, 감사인의 확인이 권장되는 사항입니다.</p>
<table><thead><tr><th>구분</th><th>항목</th><th>내용</th><th>위치</th></tr></thead><tbody>${issueRows || '<tr><td colspan="4">확인이 필요한 항목이 없습니다.</td></tr>'}</tbody></table>

<h2>4. 검토 질문</h2>
${insightCards || "<p>생성된 질문이 없습니다.</p>"}

<h2>5. 재무제표 정합성 · 현금 대사</h2>
<table><thead><tr><th>검증</th><th>항목</th><th>기대</th><th>실제</th><th>판정</th><th>비고</th></tr></thead><tbody>${fsRows}</tbody></table>

<h2>6. 증감분석 (당기 vs 전기)</h2>
<p class="lead">전기 대비 변동이 큰 계정을 표시했습니다. <span class="up">붉은색</span>은 증가, <span class="down">파란색</span>은 감소입니다.</p>
${varianceHtml}

<h2>7. 검토 수행 내역</h2>
<p class="lead">검토 대상 <b>${cov.items}개 항목</b>에 총 <b>${cov.checks}건</b>의 검증을 수행했으며, 그중 <b>${cov.clean}개 항목</b>은 모든 검증이 일치했습니다. 각 행의 "검증 방법"을 펼치면 무엇을 어떻게 대조했는지 확인할 수 있습니다.</p>
<table><thead><tr><th style="width:30%">항목</th><th>수행한 검증 → 결과</th><th>판정</th><th style="width:22%">위치</th></tr></thead><tbody>${coverageRows}</tbody></table>

<div class="foot">검토 대상: ${esc(company ?? "")}${fiscal ? ` · ${esc(fiscal.label)}` : ""}<br>
원본 파일 해시: ${esc(engine.dsdFileHash)} · 검토 엔진 ${esc(engine.engineVersion)} · 모든 수치는 원문에서 그대로 인용했으며 원본 파일은 변경하지 않았습니다.</div>

<div class="credit">© ${COPYRIGHT_YEAR} ${esc(AUTHOR)} · ${esc(APP_FULL_NAME)} v${APP_VERSION} (${APP_RELEASED})<br>
${esc(DISCLAIMER)}<br>
DSD 파싱·검증·보고서 생성이 모두 사용자 PC의 브라우저 안에서 수행되며, 감사 대상 자료는 외부로 전송되지 않습니다.</div>
</div>
<script>
document.addEventListener('click',function(e){
  var el=e.target.closest('code.copy'); if(!el) return;
  var t=el.getAttribute('data-copy')||el.textContent;
  var done=function(){ var o=el.textContent; el.classList.add('done'); el.textContent='복사됨: '+t;
    setTimeout(function(){el.classList.remove('done'); el.textContent=o;},1400); };
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(t).then(done,function(){}); }
  else { var ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta); ta.select();
    try{document.execCommand('copy'); done();}catch(err){} document.body.removeChild(ta); }
});
</script>
</body></html>`;
}
