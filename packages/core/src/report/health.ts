// Parse health — "이 파일을 얼마나 읽어냈는가"를 사용자에게 먼저 알린다.
//
// WHY THIS EXISTS: 지금까지 회사가 바뀔 때마다 앱이 조용히 빈 보고서를 냈다.
// 사용자 입장에서 "검토할 것이 없음"과 "읽지 못함"이 구분되지 않았고, 그 결과
// 잘못된 안심(false assurance)을 준다 — 감사 도구로서 가장 위험한 실패 양식이다.
// 따라서 인식 결과를 정량화해 상단에 먼저 표시하고, 부족하면 무엇이 제한되는지
// 명시한다. §5(근거 없는 단정 금지)·§21(표현 규율)의 UI 측 대응이다.

import type {
  AomObject,
  FinancialStatementLine,
  FinancialStatementTable,
  NoteBlock,
  Statement,
} from "../aom/types.js";
import type { AomModel } from "../aom/builder.js";

export type HealthLevel = "ok" | "partial" | "failed";

export interface HealthFinding {
  /** 무엇이 부족한가 */
  what: string;
  /** 그래서 어떤 기능이 제한되는가 */
  impact: string;
}

export interface ParseHealth {
  level: HealthLevel;
  notes: number;
  /** 원문에 번호가 없는 주석 (제출사가 번호를 건너뛴 경우가 대부분) */
  noteGaps: number[];
  fsLines: number;
  withPrior: number;
  statements: Statement[];
  tables: number;
  findings: HealthFinding[];
  /** 한 줄 요약 — 배너 제목으로 쓴다 */
  headline: string;
}

const isLine = (o: AomObject): o is FinancialStatementLine =>
  o.objectType === "FinancialStatementLine";
const isTable = (o: AomObject): o is FinancialStatementTable =>
  o.objectType === "FinancialStatementTable";
const isNote = (o: AomObject): o is NoteBlock => o.objectType === "NoteBlock";

/** 주석 번호 수열에서 빠진 번호. 제출사가 실제로 건너뛴 경우도 포함되므로 경고가 아닌 정보다. */
function noteGapsOf(notes: NoteBlock[]): number[] {
  const nos = notes
    .map((n) => Number(n.noteNo))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (nos.length === 0) return [];
  const max = nos[nos.length - 1]!;
  const have = new Set(nos);
  const gaps: number[] = [];
  for (let i = 1; i < max; i++) if (!have.has(i)) gaps.push(i);
  return gaps;
}

export function assessParseHealth(model: AomModel): ParseHealth {
  const lines = model.objects.filter(isLine);
  const tables = model.objects.filter(isTable);
  const notes = model.objects.filter(isNote);
  const withPrior = lines.filter((l) => l.amount.prior !== undefined).length;
  const statements = Array.from(new Set(lines.map((l) => l.statement))).sort();

  const findings: HealthFinding[] = [];
  // 가장 나쁜 등급이 이긴다 — partial 이 하나라도 있으면 ok 로 되돌아가지 않는다.
  const RANK: Record<HealthLevel, number> = { ok: 0, partial: 1, failed: 2 };
  // 객체에 담는 이유: 클로저 안의 대입은 TS 흐름 분석이 추적하지 않아
  // 지역 let 은 "ok" 로 좁혀진 채 남는다.
  const state: { level: HealthLevel } = { level: "ok" };
  const degrade = (to: HealthLevel): void => {
    if (RANK[to] > RANK[state.level]) state.level = to;
  };

  if (lines.length === 0) {
    degrade("failed");
    findings.push({
      what: "재무제표 본문(재무상태표·손익계산서 등)의 계정 금액을 하나도 읽지 못했습니다.",
      impact: "정합성 검증·증감분석·예상 질의를 수행할 수 없습니다. 이 파일을 알려주시면 대응합니다.",
    });
  } else {
    if (!statements.includes("BS")) {
      degrade("partial");
      findings.push({
        what: "재무상태표를 인식하지 못했습니다.",
        impact: "자산=부채+자본 항등식과 현금 대사를 수행할 수 없습니다.",
      });
    }
    if (!statements.includes("IS")) {
      degrade("partial");
      findings.push({
        what: "손익계산서를 인식하지 못했습니다.",
        impact: "손익 증감분석과 관련 예상 질의가 생성되지 않습니다.",
      });
    }
    if (!statements.includes("CF")) {
      degrade("partial");
      findings.push({
        what: "현금흐름표를 인식하지 못했습니다.",
        impact: "기말현금 대사(CF↔BS)와 현금흐름 관련 검증이 제외됩니다.",
      });
    }
    if (withPrior < 5) {
      degrade("partial");
      findings.push({
        what: `전기 비교 수치가 ${withPrior.toLocaleString()}개만 인식되었습니다.`,
        impact: "증감분석과 예상 질의는 당기·전기 대비를 근거로 하므로 범위가 제한됩니다.",
      });
    }
  }

  if (notes.length === 0) {
    degrade("failed");
    findings.push({
      what: "주석을 하나도 인식하지 못했습니다.",
      impact: "주석 내부의 합계·롤포워드·참조 검증이 전혀 수행되지 않습니다.",
    });
  } else if (notes.length < 5) {
    degrade("partial");
    findings.push({
      what: `주석이 ${notes.length}개만 인식되었습니다 (통상 15개 이상).`,
      impact: "주석 검증 범위가 좁아 누락된 오류가 있을 수 있습니다.",
    });
  }

  const noteGaps = noteGapsOf(notes);
  const level = state.level;
  const headline =
    level === "failed"
      ? "이 보고서를 충분히 읽지 못했습니다 — 아래 결과는 불완전합니다"
      : level === "partial"
        ? "일부만 인식했습니다 — 아래 결과는 인식된 범위에 한정됩니다"
        : `보고서 전체를 인식했습니다 — 재무제표 ${statements.length}종 · 계정 ${lines.length.toLocaleString()}개 · 주석 ${notes.length}개`;

  return {
    level,
    notes: notes.length,
    noteGaps,
    fsLines: lines.length,
    withPrior,
    statements,
    tables: tables.length,
    findings,
    headline,
  };
}
