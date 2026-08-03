// Offline grounded insight provider (Doc 07 default). Pure & deterministic (§19):
// no model, no key, no network (§18). Turns a review Issue into an auditor
// question with evidence and a potential-risk note (§4.1/§4.2), quoting only
// figures already present in the ReviewResult / AOM (§6). Templated per check
// type; contains no K-IFRS interpretation (§5, no KB snippets supplied).

import type { AomObject, FinancialStatementLine, ReviewResult } from "../aom/types.js";
import { objectLabel } from "../labels.js";
import type { Insight, InsightContext, InsightEvidence, InsightProvider } from "./types.js";

function won(n: number | undefined): string | undefined {
  return n === undefined ? undefined : Math.abs(n).toLocaleString("en-US");
}

/** Figures a line/table contributes, quoted from source (§6). */
function figuresOf(o: AomObject): string[] {
  if (o.objectType === "FinancialStatementLine") {
    const l = o as FinancialStatementLine;
    const out = [won(l.amount.current.value)!];
    if (l.amount.prior) out.push(won(l.amount.prior.value)!);
    return out;
  }
  return [];
}

interface Template {
  question: string;
  rationale: string;
  potentialRisk: string;
}

/** Deterministic template selection by check type. `figs` is a pre-quoted string. */
/**
 * `finding` 은 검증이 스스로 남긴 설명(ReviewResult.note)이다. 템플릿이 없는
 * 검증에서 이것을 쓰지 않으면 "…에 대해 다음을 확인해 보십시오(628,301,606,274 /
 * 317,907,587,604)" 처럼 숫자만 던지게 되어 읽는 사람이 무엇을 확인해야 할지
 * 알 수 없다. 검증이 이미 문장으로 설명해 두었으므로 그것을 그대로 쓴다.
 */
function template(check: string, figs: string, noteLabel: string, finding: string): Template {
  switch (check) {
    case "RollForward":
      return {
        question: `${noteLabel}에서 기초금액과 증감의 합이 기말금액과 일치하지 않는 것으로 보입니다(${figs}). 증감 항목의 부호 표기나 누락 여부를 확인해 보십시오.`,
        rationale: `감소·상각을 음수로 표기했는지, 소계나 파생행이 증감에 섞였는지, 표시단위가 다른지에 따라 항등식 판정이 달라질 수 있습니다.`,
        potentialRisk: `증감 내역 누락 또는 분류 오류가 있는 경우 잔액 표시가 왜곡될 수 있어 추가 검토가 권장됩니다.`,
      };
    case "Footing":
    case "CrossFooting":
      return {
        question: `${noteLabel}에서 구성 항목의 합계가 표시 합계와 일치하지 않는 것으로 보입니다(${figs}). 합계 산정 범위와 누락 항목을 확인해 보십시오.`,
        rationale: `소계 중복 합산, 공란으로 표시된 값의 누락, 또는 표시단위 차이가 원인일 수 있습니다.`,
        potentialRisk: `합계 표시 오류가 있는 경우 관련 계정 잔액의 정합성에 영향이 있을 수 있어 추가 검토가 권장됩니다.`,
      };
    case "CashFlowPpeAcq":
      return {
        question: `현금흐름표의 유형자산 취득액과 유형자산 주석의 취득액이 상이합니다(${figs}). 비현금취득·미지급금 변동 또는 표시단위(천원/원) 차이 여부를 확인해 보십시오.`,
        rationale: `현금흐름표는 현금 유출 기준, 주석 증감표는 발생 기준이므로 비현금 취득이나 미지급 취득이 있으면 두 값이 다를 수 있습니다.`,
        potentialRisk: `비현금 취득을 반영하지 않으면 투자활동 현금흐름 표시가 왜곡될 수 있어 추가 검토가 권장됩니다.`,
      };
    case "CrossNoteDepreciation":
      return {
        question: `여러 주석 표에서 집계된 감가상각비(${figs})가 비용의 성격별 분류 및 현금흐름표 가산조정과 정합하는지 확인해 보십시오.`,
        rationale: `유형자산·투자부동산 등 자산별 감가상각비의 합이 비용 분류 및 현금흐름의 가산조정과 연결되어야 합니다.`,
        potentialRisk: `집계 범위나 표시단위가 다르면 비용·현금흐름 표시에 영향이 있을 수 있어 추가 검토가 권장됩니다.`,
      };
    case "FsTreeFooting":
      return {
        question: `${finding || noteLabel}`,
        rationale: `재무제표 본표의 계층을 재구성해 최하위 구성항목부터 소계·총계까지 대조한 결과입니다. 구성항목 누락, 소계 자리 오류, 표시단위 차이가 원인일 수 있습니다.`,
        potentialRisk: `표시된 총계는 맞더라도 구성항목이 어긋나 있으면 세부 표시가 잘못된 것이므로 원문 확인이 필요합니다.`,
      };
    case "EquityRollForward":
    case "EquityToBs":
    case "NetIncomeToEquity":
    case "ComprehensiveIncomeToEquity":
    case "DividendToCashFlow":
      return {
        question: `${finding || noteLabel}`,
        rationale: `자본변동표를 축으로 재무상태표·손익계산서·현금흐름표를 맞대어 본 결과입니다. 전기(轉記) 누락이나 표시 부호 관행 차이가 원인일 수 있습니다.`,
        potentialRisk: `재무제표 간 연계가 어긋나면 어느 한쪽의 표시가 잘못된 것이므로 확인이 권장됩니다.`,
      };
    case "ReferenceResolve":
      return {
        question: `참조 대상 주석을 해석할 수 없습니다(${figs || "대상 주석 부재"}). 참조 번호가 올바른지, 대상 주석이 존재하는지 확인해 보십시오.`,
        rationale: `참조 번호 오기 또는 주석 누락이 원인일 수 있습니다.`,
        potentialRisk: `참조 정합성이 확보되지 않으면 공시 연결성에 영향이 있을 수 있어 추가 검토가 권장됩니다.`,
      };
    default:
      return {
        // 검증이 남긴 설명이 있으면 그것이 가장 정확하다. 없을 때만 숫자로 물러난다.
        question: finding || `${noteLabel}에 대해 다음을 확인해 보십시오(${figs}).`,
        rationale: `엔진이 이상 신호를 표시했으나 기계적으로 오류를 단정할 수는 없습니다.`,
        potentialRisk: `관련 표시의 정합성에 영향이 있을 수 있어 추가 검토가 권장됩니다.`,
      };
  }
}

export class OfflineGroundedProvider implements InsightProvider {
  readonly name = "offline-grounded";

  generate(ctx: InsightContext): Insight[] {
    const issue = ctx.issue;
    const primary: ReviewResult | undefined = ctx.reviewResults[0];
    const check = primary?.check ?? issue.drilldown[0] ?? "Issue";

    // Resolve evidence objects → grounded links with quoted figures (§4, §20).
    const evidence: InsightEvidence[] = ctx.evidenceObjects.map((o) => ({
      objectId: o.id,
      label: objectLabel(o, ctx.noteTitles),
      xmlPath: o.source.xmlPath,
      ...(o.source.page !== undefined ? { page: o.source.page } : {}),
      figures: figuresOf(o),
    }));

    // Figures quoted from the ReviewResult (already computed by the engine, §6).
    const resultFigs = [won(primary?.expected), won(primary?.actual)].filter(
      (x): x is string => x !== undefined,
    );
    if (evidence.length > 0) {
      evidence[0]!.figures = [...new Set([...evidence[0]!.figures, ...resultFigs])];
    }
    const figs = resultFigs.join(" / ");
    const noteLabel = evidence[0]?.label ?? "해당 표";

    // 검증이 남긴 설명. Issue.title 은 ReviewResult.note 를 그대로 옮긴 것이다.
    const finding = (primary?.note ?? issue.title ?? "").trim();
    const t = template(check, figs, noteLabel, finding);

    // Confidence (§7): more independent evidence → higher.
    const confidence = evidence.length >= 2 ? "medium" : "low";

    return [
      {
        id: `insight:${issue.id}`,
        issueId: issue.id,
        check,
        severity: issue.severity,
        question: t.question,
        rationale: t.rationale,
        potentialRisk: t.potentialRisk,
        evidence,
        confidence,
        provider: this.name,
      },
    ];
  }
}
