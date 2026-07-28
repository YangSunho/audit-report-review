// 심리실 예상 질의 — anticipate the EQCR/심리 reviewer's questions.
//
// This is the feature an engagement team actually needs in busy season: not
// "the numbers foot", but "here is what 심리 will ask, and what you should have
// ready". Each query is derived from the parsed statements + note map, so it
// cites real figures and points at the note that must support the answer.
//
// Pure & deterministic (§19). Figures are quoted from the parse (§6); the text
// is a question template, never an assertion about the client (§21).

import type { FinancialStatementLine } from "../aom/types.js";
import type { AomModel } from "../aom/builder.js";
import { buildVariance, type VarianceRow } from "./variance.js";
import { noteTitleMap, fmtWon } from "../labels.js";

export interface ReviewQuery {
  /** 재무제표 구분 (재무상태표/손익계산서/현금흐름표) or 종합. */
  area: string;
  /** 무엇에 대한 질문인지 (계정 또는 주제). */
  subject: string;
  /** 심리실이 물을 법한 질문. */
  question: string;
  /** 왜 이 질문이 나오는지 — 근거 수치. */
  basis: string;
  /** 답변 준비 시 확인해야 할 주석/자료. */
  prepare: string;
  /** high = 반드시 준비, medium = 준비 권장. */
  priority: "high" | "medium";
}

const noteRefText = (refs: string[], notes: Map<string, string>): string =>
  refs.length === 0
    ? "관련 주석 미기재 — 주석 연결 여부 확인"
    : refs
        .map((n) => {
          const t = notes.get(n);
          return t ? `주석${n}(${t})` : `주석${n}`;
        })
        .join(", ");

function pctText(r: VarianceRow): string {
  if (r.pct === undefined) return "";
  const dir = r.pct > 0 ? "증가" : "감소";
  return `${Math.abs(r.pct).toFixed(0)}% ${dir}`;
}

/** Account-specific angle a reviewer takes, keyed by keyword in the account name. */
function angleFor(account: string, up: boolean): { q: string; prep: string } | undefined {
  const a = account.replace(/\s/g, "");
  if (/현금및현금성자산/.test(a))
    return up
      ? { q: "현금 급증의 원천(영업·차입·자산처분)과 기말 잔액의 실재성을 어떻게 확인했는가", prep: "은행조회서, 기말 잔액 대사, 자금수지" }
      : { q: "현금 급감의 사용처와 유동성 위험(계속기업 가정 포함) 평가를 어떻게 수행했는가", prep: "자금수지표, 차입 약정, 유동성 위험 주석, 계속기업 검토" };
  if (/매출채권|기타채권/.test(a))
    return up
      ? { q: "채권 증가가 매출 증가에 비례하는지, 기대신용손실 충당금 설정이 충분한지 어떻게 검증했는가", prep: "연령분석표, 충당금 설정률 추이, 기말 후 회수 내역" }
      : { q: "채권 감소의 원인(회수·대손상각·팩토링 등)과 제각 처리의 적정성을 어떻게 확인했는가", prep: "회수 내역, 대손상각 승인 문서, 채권 양도 계약" };
  if (/재고자산/.test(a))
    return up
      ? { q: "재고 증가의 원인(생산 증가·판매부진)과 순실현가능가치 평가·진부화 충당금 적정성을 어떻게 확인했는가", prep: "재고 연령분석, 실사 결과, NRV 검토, 매출원가율 추이" }
      : { q: "재고 감소의 원인(판매·폐기·평가손실)과 기말 실사 결과 반영, 매출원가 대응이 적절한가", prep: "실사 조서, 폐기 승인 문서, 평가손실 산정 근거, 매출원가율 추이" };
  if (/기타유동금융자산|단기금융상품|금융자산/.test(a))
    return { q: "금융자산 분류(상각후원가·FVOCI·FVPL) 근거와 공정가치 서열체계 공시가 적절한가", prep: "약정서, 사업모형 평가, 공정가치 산정 근거, 주석 공시" };
  if (/종속기업|관계기업|지분법/.test(a))
    return { q: "지분법 평가 및 손상징후 검토를 어떻게 수행했는가, 피투자회사 재무정보의 신뢰성은 확보되었는가", prep: "피투자사 F/S, 지분법 산정표, 손상 검토 문서" };
  if (/유형자산|무형자산/.test(a))
    return up
      ? { q: "취득의 실재성과 자본화 요건 충족, 내용연수·잔존가치 추정의 합리성을 어떻게 검증했는가", prep: "취득 증빙, 자본화 판단 근거, 감가상각 재계산" }
      : { q: "처분·손상의 회계처리가 적절한지, 손상징후 검토와 회수가능액 산정 근거는 무엇인가", prep: "처분 계약·대금 수령 내역, 손상검토 문서, 회수가능액 산정" };
  if (/차입금|사채/.test(a))
    return up
      ? { q: "차입 증가의 사용처와 약정 준수(covenant), 유동·비유동 분류 및 이자비용 자본화 여부가 적절한가", prep: "약정서, covenant 검토, 만기 분석, 자금 사용처" }
      : { q: "상환 재원과 조기상환·재조정 여부, 관련 손익 인식이 적절한가", prep: "상환 증빙, 약정 변경 문서, 상환 손익 산정" };
  if (/충당부채|충당금/.test(a))
    return { q: "충당부채 인식요건 충족과 추정의 합리성을 어떻게 검증했는가", prep: "산정 근거, 과거 경험률, 법률 자문" };
  if (/매출액|수익/.test(a))
    return up
      ? { q: "수익 증가의 실재성(가공매출 위험 포함)과 인식 시점·기간귀속(cut-off)을 어떻게 검증했는가", prep: "수익인식 정책, cut-off 테스트, 매출 상세, 채권 회수 내역" }
      : { q: "매출 감소의 원인과 이에 따른 자산 손상·계속기업 가정에 미치는 영향을 어떻게 고려했는가", prep: "매출 분석, 손상검토, 계속기업 평가 문서" };
  if (/법인세/.test(a))
    return { q: "유효세율 변동 원인과 이연법인세자산 실현가능성 판단 근거는 무엇인가", prep: "세무조정계산서, 유효세율 조정표, 미래과세소득 추정" };
  if (/영업활동|현금흐름/.test(a))
    return { q: "영업활동 현금흐름과 당기순이익의 괴리 원인은 무엇이며, 이익의 질(質)에 대한 평가는 어떠한가", prep: "운전자본 변동 분석, 비현금항목 조정 명세" };
  return undefined;
}

/**
 * Build the anticipated 심리 review queries from significant movements and
 * cross-statement relationships.
 */
/**
 * Why no queries were produced — shown to the user instead of a blank section.
 * A silent "0건" is indistinguishable from "nothing to ask", which is misleading.
 */
export interface QueryDiagnosis {
  fsLines: number;
  withPrior: number;
  significant: number;
  reason?: string;
}

export function diagnoseQueries(model: AomModel): QueryDiagnosis {
  const lines = model.objects.filter(
    (o): o is FinancialStatementLine => o.objectType === "FinancialStatementLine",
  );
  const withPrior = lines.filter((l) => l.amount.prior !== undefined).length;
  const significant = buildVariance(model).reduce(
    (n, s) => n + s.rows.filter((r) => r.significant).length,
    0,
  );
  let reason: string | undefined;
  if (lines.length === 0) {
    reason =
      "재무제표 본문(재무상태표·손익계산서·현금흐름표)을 인식하지 못했습니다. " +
      "보고서의 재무제표 편집 형식이 예상과 달라 계정 금액을 읽지 못한 경우로, 이 파일을 알려주시면 대응할 수 있습니다.";
  } else if (withPrior === 0) {
    reason =
      "전기 비교 수치를 찾지 못했습니다. 예상 질의는 당기·전기 증감을 근거로 만들어지므로 비교표시가 없으면 생성되지 않습니다.";
  } else if (significant === 0) {
    reason =
      "전기 대비 유의적인 변동(증감율 30% 이상이면서 금액도 큰 항목)이 없습니다. 이 경우 예상 질의가 없는 것이 정상입니다.";
  }
  return { fsLines: lines.length, withPrior, significant, ...(reason ? { reason } : {}) };
}

export function buildReviewQueries(model: AomModel): ReviewQuery[] {
  const notes = noteTitleMap(model.objects);
  const sections = buildVariance(model);
  const out: ReviewQuery[] = [];

  for (const sec of sections) {
    for (const r of sec.rows.filter((x) => x.significant)) {
      const angle = angleFor(r.account, (r.pct ?? 0) > 0);
      const basis =
        `당기 ${fmtWon(r.current)}원 / 전기 ${fmtWon(r.prior)}원` +
        (r.delta !== undefined ? ` (증감 ${fmtWon(r.delta)}원, ${pctText(r)})` : "");
      out.push({
        area: sec.title,
        subject: r.account,
        question:
          angle?.q ??
          `${r.account}의 전기 대비 ${pctText(r)} 원인은 무엇이며, 관련 주석 공시는 충분한가`,
        basis,
        prepare: `${noteRefText(r.noteRef, notes)} · ${angle?.prep ?? "변동 원인 자료, 관련 주석"}`,
        priority: Math.abs(r.pct ?? 0) >= 50 ? "high" : "medium",
      });
    }
  }

  // ── cross-statement angles (종합 질의) ──────────────────────────────────
  const lines = model.objects.filter(
    (o): o is FinancialStatementLine => o.objectType === "FinancialStatementLine",
  );
  const find = (st: string, re: RegExp): FinancialStatementLine | undefined =>
    lines.find((l) => l.statement === st && re.test(l.account.replace(/\s/g, "")));

  const ni = find("IS", /당기순이익|당기순손익/);
  const ocf = find("CF", /영업활동/);
  if (ni && ocf && ni.amount.current.value > 0 && ocf.amount.current.value < 0) {
    out.unshift({
      area: "종합",
      subject: "이익의 질 (당기순이익 vs 영업현금흐름)",
      question:
        "당기순이익은 흑자이나 영업활동 현금흐름은 음(-)입니다. 이익의 질에 대한 평가와 수익인식·채권회수 관련 부정위험(ROMM)을 어떻게 고려했는가",
      basis: `당기순이익 ${fmtWon(ni.amount.current.value)}원 / 영업활동 현금흐름 ${fmtWon(ocf.amount.current.value)}원`,
      prepare: "운전자본 변동 분석, 수익인식 테스트, 매출채권 회수 내역, 부정위험 평가 문서",
      priority: "high",
    });
  }

  // 적자 전환 → 계속기업·자산 손상 (심리가 반드시 확인하는 지점)
  if (ni?.amount.prior && ni.amount.current.value < 0 && ni.amount.prior.value > 0) {
    out.unshift({
      area: "종합",
      subject: "적자 전환 (계속기업·손상)",
      question:
        "전기 흑자에서 당기 손실로 전환되었습니다. 계속기업 가정의 적정성과 비유동자산 손상징후 검토를 어떻게 수행했으며, 관련 공시는 충분한가",
      basis: `당기순손익 전기 ${fmtWon(ni.amount.prior.value)}원 → 당기 ${fmtWon(ni.amount.current.value)}원`,
      prepare: "계속기업 평가 문서(자금수지·차입 계획), 손상검토 조서, 계속기업 관련 주석",
      priority: "high",
    });
  }

  // 차입 급증 → 자금 사용처·약정 (현금 증감과 함께 보는 것이 핵심)
  const debt = find("BS", /^차입금|단기차입금|장기차입금|사채/);
  if (debt?.amount.prior && debt.amount.prior.value > 0) {
    const g = (debt.amount.current.value - debt.amount.prior.value) / debt.amount.prior.value;
    if (g >= 0.5) {
      out.unshift({
        area: "종합",
        subject: "차입금 급증 (자금 사용처·약정)",
        question:
          "차입금이 큰 폭으로 증가했습니다. 조달 자금의 사용처와 차입 약정(covenant) 준수 여부, 유동성 위험 공시가 적절한가",
        basis: `차입금 전기 ${fmtWon(debt.amount.prior.value)}원 → 당기 ${fmtWon(debt.amount.current.value)}원 (${Math.round(g * 100)}% 증가)`,
        prepare: "차입 약정서, covenant 준수 검토, 자금 사용 내역, 유동성 위험 주석",
        priority: "high",
      });
    }
  }

  const cash = find("BS", /현금및현금성자산/);
  const fin = find("BS", /기타유동금융자산|단기금융상품/);
  if (
    cash?.amount.prior &&
    fin?.amount.prior &&
    cash.amount.current.value < cash.amount.prior.value &&
    fin.amount.current.value > fin.amount.prior.value
  ) {
    out.unshift({
      area: "종합",
      subject: "현금 → 금융자산 재배치",
      question:
        "현금및현금성자산이 감소하고 기타유동금융자산이 증가했습니다. 자금의 이동 경위와 금융자산의 분류·측정, 현금성자산 정의 충족 여부를 어떻게 검토했는가",
      basis:
        `현금 ${fmtWon(cash.amount.prior.value)} → ${fmtWon(cash.amount.current.value)}원, ` +
        `기타유동금융자산 ${fmtWon(fin.amount.prior.value)} → ${fmtWon(fin.amount.current.value)}원`,
      prepare: "예치 약정서(만기·중도해지 조건), 현금성자산 판단 근거, 금융자산 분류 문서",
      priority: "high",
    });
  }

  return out;
}
