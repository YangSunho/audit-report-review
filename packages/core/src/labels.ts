// Shared human-facing labels for reports/dashboard/insights. Makes every row
// self-explanatory: which note/account it refers to, and check names in Korean.
// Pure, presentation-only (§6 — no computation).

import type { AomObject, ReviewResult } from "./aom/types.js";

/**
 * Thousands-separated amount for display, negatives in parentheses.
 * Every figure that reaches a human MUST go through this — auditors read
 * grouped digits, and raw integers are unreadable at 12 digits.
 */
export function fmtWon(n: number | undefined): string {
  if (n === undefined) return "-";
  const abs = Math.abs(n).toLocaleString("en-US");
  return n < 0 ? `(${abs})` : abs;
}

/** Signed difference for notes: "Δ(1,234)" reads better than "Δ-1234". */
export function fmtDelta(n: number): string {
  return fmtWon(n);
}

/** noteNo → note title, e.g. "8" → "매출채권 및 기타채권". */
export function noteTitleMap(objects: AomObject[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of objects) if (o.objectType === "NoteBlock") m.set(o.noteNo, o.title);
  return m;
}

/**
 * Condense a table caption into a locator: keep the sub-heading number (22.3)
 * and the subject, dropping boilerplate ("…는 다음과 같습니다").
 */
export function captionLabel(caption: string | undefined, noteNo?: string): string {
  if (!caption) return "";
  let s = caption.trim().replace(/\s+/g, " ");
  // Drop a leading repetition of the note heading ("30. 법인세 30.1 …" → "30.1 …")
  // so the label doesn't read "주석30. 법인세 — 30. 법인세 30.1 …".
  if (noteNo) {
    const re = new RegExp(`^${noteNo}\\.\\s*[^\\d]{0,20}?(?=${noteNo}\\.\\d)`, "u");
    s = s.replace(re, "").trim();
    s = s.replace(new RegExp(`^${noteNo}\\.\\s+`, "u"), "").trim();
  }
  // A caption is the sentence introducing the table; drop trailing boilerplate
  // and any footnote text ("(주1) …") that follows it.
  s = s.split(/\(주\s*\d/u)[0]!.trim();
  s = s.replace(/은|는\s*다음과\s*같습니다\.?$/u, "").trim();
  s = s.replace(/(다음과\s*같습니다|다음과\s*같음)\.?$/u, "").trim();
  s = s.replace(/[은는이가]$/u, "").trim();
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}

/** Human label for an AOM object, including the note title when available. */
export function objectLabel(o: AomObject, notes: Map<string, string>): string {
  switch (o.objectType) {
    case "FinancialStatementLine":
      return `${o.account} [${o.statement}]`;
    case "FinancialStatementTable": {
      const sub = captionLabel(o.caption, o.note);
      if (o.note) {
        const t = notes.get(o.note);
        const base = t ? `주석${o.note}. ${t}` : `주석${o.note}`;
        return sub ? `${base} — ${sub}` : `${base} 표`;
      }
      return sub ? `${o.statement} — ${sub}` : `${o.statement} 표`;
    }
    case "NoteBlock":
      return `주석${o.noteNo}. ${o.title}`;
    case "Reference": {
      // "참조 주석1" tells the reader nothing — say what note 1 is, and where
      // the reference sits (which statement line points at it).
      const no = o.toLabel.replace(/[^\d]/g, "");
      const title = no ? notes.get(no) : undefined;
      return title ? `${o.toLabel}. ${title} 참조` : `${o.toLabel} 참조`;
    }
    case "NarrativeNumber":
      return o.note ? `주석${o.note} 서술` : "서술";
    default:
      return o.objectType;
  }
}

/**
 * Human-readable location: where in the REPORT this sits, not an XML path.
 * "주석13. 유형자산 · 13.1 …변동내역 (p.24)" beats "/DOCUMENT/BODY/…/TABLE[44]".
 */
export function humanLocation(o: AomObject, notes: Map<string, string>): string {
  const page = o.source.page !== undefined ? ` (p.${o.source.page})` : "";
  return `${objectLabel(o, notes)}${page}`;
}

/** Korean names for engine check codes (§ user-facing clarity). */
export const CHECK_KO: Record<string, string> = {
  FsBalance: "대차평균 (자산총계 = 부채와자본총계)",
  FsBalanceComponents: "대차평균 (자산총계 = 부채총계 + 자본총계)",
  FsTreeFooting: "구성항목 합계 (계층 전수)",
  FsAnchor: "요약수치 대사",
  EquityRollForward: "자본변동 대사 (기초+변동=기말)",
  EquityToBs: "자본변동표 ↔ 재무상태표",
  NetIncomeToEquity: "당기순이익 전기 (손익 → 자본)",
  ComprehensiveIncomeToEquity: "총포괄손익 대사 (손익 ↔ 자본)",
  DividendToCashFlow: "배당금 대사 (자본 ↔ 현금흐름)",
  CashTieOut: "현금 대사 (기말현금)",
  CashFlowRollForward: "현금흐름 증감 정합",
  CashFlowPpeAcq: "유형자산 취득 대사",
  CrossNoteDepreciation: "감가상각비 주석 대사",
  Footing: "세로 합계 (Footing)",
  CrossFooting: "가로 합계 (Cross-footing)",
  RollForward: "증감 정합 (Roll-forward)",
  ReferenceResolve: "참조 확인",
};

export function checkKo(check: string): string {
  return CHECK_KO[check] ?? check;
}

/** Subject ("항목") a ReviewResult is about — the target account/note, else a
 * per-check default (§ user-facing clarity). */
export function resultSubject(
  r: ReviewResult,
  index: Map<string, AomObject>,
  notes: Map<string, string>,
): string {
  // 검증이 스스로 밝힌 대상이 가장 정확하다 (자본변동표의 열 등).
  if (r.subject) return r.subject;
  const first = r.targets[0];
  const t = first ? index.get(first) : undefined;
  if (t) return objectLabel(t, notes);
  if (r.check.startsWith("Cash")) return "현금흐름표";
  if (r.check.startsWith("Fs")) return "재무제표";
  return "";
}
