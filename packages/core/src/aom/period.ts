// 기수·대상기간 추출 — "제32기 2025.01.01 ~ 2025.12.31 · 결산일 2025.12.31".
//
// WHY THIS EXISTS: 검토 결과에 회사명만 있고 **어느 기의 어느 기간**인지가 없었다.
// 감사조서로 쓰려면 대상기간 표시가 필수이며, 증감분석의 % 도 당기·전기의 기간
// 길이가 같아야 의미가 있다(반기·사업연도 변경 시 그렇지 않다).
//
// 추출 근거는 제출사가 재무제표 머리글에 반드시 쓰는 세 형태다:
//   "제32기 2025년 1월 1일부터 2025년 12월 31일까지"   → 회계기간
//   "제32기말 2025년 12월 31일 현재"                   → 결산일
//   "감사대상 사업연도 2025년 01월 01일 부터 …"        → 감사보고서 본문의 보조 근거
// 표현이 제출사마다 달라(제11 (당)기 / 제 29(당) 기 / 제14기) 공백과 (당)(전) 표기를
// 흡수하는 하나의 정규식으로 읽는다.

import type { ParsedDocument, ParsedSection } from "../dsd/parser.js";

export interface TermPeriod {
  /** 기수 (32, 11 …) */
  term?: number;
  /** 회계기간 시작·종료 (YYYY-MM-DD) */
  start?: string;
  end?: string;
  /** 결산일 (YYYY-MM-DD) — "…현재" 로 표기된 날짜 */
  balanceDate?: string;
}

export interface FiscalPeriod {
  current: TermPeriod;
  prior?: TermPeriod;
  /** 당기 회계기간 개월 수 (12 = 사업연도, 6 = 반기 …) */
  months?: number;
  priorMonths?: number;
  /** 사람이 읽는 한 줄: "제32기 · 2025.01.01 ~ 2025.12.31 · 결산일 2025.12.31" */
  label: string;
  /** 기간 길이가 통상과 다르면 그 사실 (증감분석 해석에 영향) */
  caveat?: string;
}

const D = (y: string, m: string, d: string): string =>
  `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;

/** "제 11 (당)기" · "제29기말" · "제 14 기" 를 모두 흡수하는 기수 표기. */
const TERM = String.raw`제\s*(\d{1,3})\s*(?:\(\s*[당전]\s*\))?\s*기\s*(?:\(\s*[당전]\s*\))?\s*(?:말)?`;
const YMD = String.raw`((?:19|20)\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일`;

const RE_RANGE = new RegExp(`${TERM}\\s*${YMD}\\s*부\\s*터\\s*${YMD}\\s*까\\s*지`, "g");
const RE_ASOF = new RegExp(`${TERM}\\s*${YMD}\\s*현\\s*재`, "g");
// 감사보고서 본문의 보조 근거 — 기수 표기가 없는 대신 당기 사업연도를 명시한다.
const RE_AUDIT_YEAR = new RegExp(
  `감\\s*사\\s*대\\s*상\\s*사\\s*업\\s*연\\s*도\\s*${YMD}\\s*부\\s*터\\s*${YMD}\\s*까\\s*지`,
);

/** 문서의 모든 텍스트를 한 줄씩 흘려보낸다 (표 셀 포함). */
function* textLines(section: ParsedSection): Generator<string> {
  for (const b of section.blocks) {
    if (b.type === "paragraph") {
      for (const line of b.text.split("\n")) yield line;
    } else if (b.type === "table") {
      for (const r of b.rows) for (const c of r.cells) yield c.text;
    }
    // pagebreak 등 텍스트가 없는 블록은 건너뛴다.
  }
  for (const c of section.children) yield* textLines(c);
}

function monthsBetween(start: string, end: string): number | undefined {
  const a = new Date(start);
  const b = new Date(end);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return undefined;
  const m =
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + (b.getDate() >= a.getDate() - 1 ? 1 : 0);
  return m > 0 && m <= 36 ? m : undefined;
}

const dot = (iso: string | undefined): string => (iso ? iso.replace(/-/g, ".") : "");

export function extractFiscalPeriod(parsed: ParsedDocument): FiscalPeriod | undefined {
  const byTerm = new Map<number, TermPeriod>();
  const put = (term: number, patch: Partial<TermPeriod>): void => {
    const cur = byTerm.get(term) ?? { term };
    byTerm.set(term, { ...cur, ...patch });
  };

  let auditYear: { start: string; end: string } | undefined;

  for (const raw of textLines(parsed.root)) {
    // 셀 안에서 줄바꿈·다중 공백이 섞여 나오므로 한 칸으로 정규화한 뒤 훑는다.
    const line = raw.replace(/\s+/g, " ");
    if (line.length > 200) continue;

    RE_RANGE.lastIndex = 0;
    for (const m of line.matchAll(RE_RANGE)) {
      put(Number(m[1]), { start: D(m[2]!, m[3]!, m[4]!), end: D(m[5]!, m[6]!, m[7]!) });
    }
    RE_ASOF.lastIndex = 0;
    for (const m of line.matchAll(RE_ASOF)) {
      put(Number(m[1]), { balanceDate: D(m[2]!, m[3]!, m[4]!) });
    }
    if (!auditYear) {
      const m = RE_AUDIT_YEAR.exec(line);
      if (m) auditYear = { start: D(m[1]!, m[2]!, m[3]!), end: D(m[4]!, m[5]!, m[6]!) };
    }
  }

  const terms = [...byTerm.keys()].sort((a, b) => b - a);
  let current: TermPeriod | undefined = terms[0] !== undefined ? byTerm.get(terms[0]) : undefined;
  const prior = terms[1] !== undefined ? byTerm.get(terms[1]) : undefined;

  // 기수 표기를 전혀 찾지 못했을 때만 감사보고서 본문의 사업연도로 대체한다.
  if (!current && auditYear) current = { start: auditYear.start, end: auditYear.end };
  if (!current) return undefined;
  if (!current.start && auditYear) {
    current = { ...current, start: auditYear.start, end: auditYear.end };
  }

  const months = current.start && current.end ? monthsBetween(current.start, current.end) : undefined;
  const priorMonths = prior?.start && prior.end ? monthsBetween(prior.start, prior.end) : undefined;

  const parts: string[] = [];
  if (current.term !== undefined) parts.push(`제${current.term}기`);
  if (current.start && current.end) parts.push(`${dot(current.start)} ~ ${dot(current.end)}`);
  if (current.balanceDate) parts.push(`결산일 ${dot(current.balanceDate)} 현재`);
  else if (current.end) parts.push(`결산일 ${dot(current.end)} 현재`);

  let caveat: string | undefined;
  if (months !== undefined && months !== 12) {
    caveat = `당기 회계기간은 ${months}개월입니다 — 12개월 사업연도가 아니므로 증감분석의 증감율 해석에 유의하십시오.`;
  }
  if (months !== undefined && priorMonths !== undefined && months !== priorMonths) {
    caveat = `당기 ${months}개월 · 전기 ${priorMonths}개월로 기간 길이가 다릅니다 — 전기 대비 증감율을 그대로 비교할 수 없습니다.`;
  }

  return {
    current,
    ...(prior ? { prior } : {}),
    ...(months !== undefined ? { months } : {}),
    ...(priorMonths !== undefined ? { priorMonths } : {}),
    label: parts.join(" · "),
    ...(caveat ? { caveat } : {}),
  };
}
