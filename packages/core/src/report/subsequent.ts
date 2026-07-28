// 보고기간후사건 점검 (K-IFRS 1010) — the disclosure most often missed.
//
// The app cannot know what happened outside the file, so it does NOT claim
// completeness (§5). What it CAN do deterministically:
//   1. locate the 보고기간후사건 note and read what is actually disclosed,
//   2. extract the two dates that bound the review window (보고기간말 → 감사보고서일),
//   3. classify the disclosed events by type, and
//   4. emit a targeted checklist — event types NOT mentioned, with the exact
//      DART/news search terms and window the auditor should run.
//
// This turns "did we miss a subsequent event?" from an open-ended worry into a
// bounded checklist tied to this company's own numbers.

import type { ParsedDocument, ParsedSection } from "../dsd/parser.js";

export interface EventCategory {
  key: string;
  label: string;
  /** Keywords that indicate this event type IS already disclosed. */
  markers: RegExp;
  /** What to search for in DART/news when it is not disclosed. */
  searchTerms: string[];
  /** Why it matters (K-IFRS 1010 adjusting vs non-adjusting hint). */
  why: string;
}

export const EVENT_CATEGORIES: EventCategory[] = [
  {
    key: "capital",
    label: "증자·감자·자기주식",
    markers: /유상증자|무상증자|감자|자기주식|전환사채|신주인수권/,
    searchTerms: ["유상증자 결정", "전환사채 발행", "자기주식 취득·처분"],
    why: "자본구조 변동은 비수정 사건이나 공시 대상 (1010.21)",
  },
  {
    key: "ma",
    label: "합병·분할·지분 취득/처분",
    markers: /합병|분할|영업양수|영업양도|지분\s*(취득|처분|매각)|주식양수도/,
    searchTerms: ["타법인 주식 취득·처분", "합병·분할 결정", "영업양수도"],
    why: "사업결합·처분은 비수정 사건이며 성격·재무영향 공시 필요",
  },
  {
    key: "borrowing",
    label: "차입·담보·보증",
    markers: /차입|담보|보증|근저당|질권|약정\s*체결/,
    searchTerms: ["단일판매·공급계약", "타인에 대한 채무보증 결정", "자산 담보제공"],
    why: "우발부채·유동성에 영향 (1010.21, 1037)",
  },
  {
    key: "litigation",
    label: "소송·제재·조사",
    markers: /소송|피소|제소|분쟁|과징금|제재|세무조사|압수|기소/,
    searchTerms: ["소송 등의 제기·신청", "제재 조치", "조사 착수"],
    why: "보고기간말 존재하던 상황의 증거면 수정 사건 (1010.9)",
  },
  {
    key: "impair",
    label: "손상·자산 처분",
    markers: /손상|폐기|처분\s*결정|매각\s*결정|생산\s*중단|공장\s*(폐쇄|매각)/,
    searchTerms: ["유형자산 처분 결정", "손상차손 인식", "영업 중단"],
    why: "기말 자산가치 증거면 수정 사건 (1010.9)",
  },
  {
    key: "dividend",
    label: "배당 결의",
    markers: /배당\s*(결의|선언|지급)|현금배당|주식배당/,
    searchTerms: ["현금·현물배당 결정", "주주총회 결과"],
    why: "기말 후 선언 배당은 부채 인식 불가, 공시만 (1010.12)",
  },
  {
    key: "goingconcern",
    label: "계속기업 관련 사건",
    markers: /계속기업|워크아웃|회생|파산|채무재조정|상장폐지|관리종목/,
    searchTerms: ["회생절차 개시", "관리종목 지정", "감사의견 관련"],
    why: "계속기업 가정에 영향 시 수정 사건 (1010.14)",
  },
  {
    key: "major_contract",
    label: "주요 계약·수주",
    markers: /공급계약|수주|해지|해제|계약\s*(체결|종료)/,
    searchTerms: ["단일판매·공급계약 체결", "계약 해지"],
    why: "미래 현금흐름·손상 판단에 영향",
  },
];

export interface SubsequentReview {
  /** True when a 보고기간후사건 note exists at all. */
  noteFound: boolean;
  noteNo?: string;
  /** Verbatim text of the note (for the auditor to read). */
  disclosedText: string;
  /** Period end and the end of the review window. */
  periodEnd?: string;
  auditReportDate?: string;
  /** What the window end is based on (AGM / signing date / today). */
  windowEndBasis?: "주주총회일" | "감사보고서일" | "앱 사용일(감사보고서일 미확정)";
  /** Categories the note already covers. */
  covered: EventCategory[];
  /** Categories NOT mentioned → verify externally. */
  toVerify: EventCategory[];
  /** Company name for the search query. */
  company?: string;
}

const flatten = (s: ParsedSection, out: { text: string }[] = []): { text: string }[] => {
  for (const b of s.blocks) if (b.type === "paragraph") out.push({ text: b.text });
  for (const c of s.children) flatten(c, out);
  return out;
};

/**
 * Company name as DART expects it. DART matches on the trade name only, so
 * "영풍전자 주식회사" finds nothing — the legal-form words (주식회사/(주)/㈜,
 * 유한회사, 유한책임회사 …) must be stripped, whether they lead or trail.
 */
export function searchName(company: string | undefined): string {
  if (!company) return "";
  return company
    .replace(/\(주\)|㈜|\(유\)|㈜/g, " ")
    .replace(/(주식회사|유한책임회사|유한회사|합자회사|합명회사)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** ISO-ish date from "2026년 3월 19일". */
function toDate(s: string): string {
  const m = s.match(/(20\d{2})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}` : s;
}

export function reviewSubsequentEvents(doc: ParsedDocument): SubsequentReview {
  const paras = flatten(doc.root);
  const all = paras.map((p) => p.text).join("\n");

  // Locate the note: "39. 보고기간 후 사건" style heading, then take what follows.
  const headingRe = /(\d{1,2})\.\s*보고기간\s*후\s*사건/;
  let noteNo: string | undefined;
  let disclosedText = "";
  for (const p of paras) {
    const m = p.text.match(headingRe);
    if (m) {
      noteNo = m[1];
      const at = p.text.indexOf(m[0]);
      disclosedText = p.text.slice(at + m[0].length).trim();
      break;
    }
  }
  if (!noteNo) {
    const at = all.indexOf("보고기간 후 사건");
    if (at >= 0) disclosedText = all.slice(at + 9, at + 1200).trim();
  }
  const noteFound = disclosedText.length > 0 || noteNo !== undefined;

  // Review window: 보고기간말 → 감사보고서일. Take the period end from the
  // audit-scope sentence ("…2025년 12월 31일 현재의 재무상태표…"), never from
  // accounting-policy text, which cites FUTURE effective dates ("2027년 1월 1일
  // 이후 개시하는 회계연도") and would push the window years forward.
  // Period end = the year-end the audit actually covers. Take year-ends that sit
  // in an audit-scope sentence ("…현재의 재무상태표", "…로 종료되는 보고기간") and
  // pick the latest. Plain year-ends elsewhere include future effective dates
  // from accounting-policy notes ("2026년 12월 31일 이후 개시하는…"), which would
  // push the window years ahead; the comparative year appears in the same
  // sentence, so position alone cannot decide either.
  // Anchor on the opinion paragraph ("…재무제표를 감사하였습니다. 해당 재무제표는
  // 2025년 12월 31일 현재의 재무상태표…"). Scope wording alone is not enough:
  // accounting-policy notes also say "2026년 12월 31일로 종료되는 회계연도의
  // 비교정보는…", which is a FUTURE standard's effective date, not this audit.
  const opinionAt = all.search(/재무제표를\s*감사하였습니다|감사하였습니다/);
  const scopeYearEnds: string[] = [];
  const re = /20\d{2}년\s*12월\s*31일/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(all)) !== null) {
    const after = all.slice(mm.index, mm.index + 60);
    if (!/현재의|로\s*종료|자로\s*종료|현재\s*및|기말\s*현재/.test(after)) continue;
    // Prefer dates right after the opinion sentence; ignore far-away policy text.
    const nearOpinion = opinionAt >= 0 && mm.index > opinionAt && mm.index - opinionAt < 400;
    if (nearOpinion) scopeYearEnds.push(toDate(mm[0]));
  }
  const candidatesPE = (
    scopeYearEnds.length > 0
      ? scopeYearEnds
      : [...new Set(all.match(/20\d{2}년\s*12월\s*31일/g) ?? [])].map(toDate)
  ).sort();
  const periodEnd = candidatesPE[candidatesPE.length - 1];

  // End of the review window. Priority (widest defensible window first):
  //   1) 주주총회일 — subsequent events are considered up to the AGM,
  //   2) 감사보고서일 (signing date),
  //   3) today — when the report date is blank or masked ("2026년 3월 00일",
  //      common while 심리 is still open), the auditor is reviewing NOW, so the
  //      window must run to today rather than silently stopping early.
  const dates = [...new Set(all.match(/20\d{2}년\s*\d{1,2}월\s*\d{1,2}일/g) ?? [])].map(toDate);
  const afterPeriodEnd = (d: string): boolean => {
    if (!periodEnd) return false;
    const days = (Date.parse(d) - Date.parse(periodEnd)) / 86_400_000;
    return days > 0 && days <= 365 && !/-12-31$/.test(d) && !/-01-01$/.test(d);
  };

  // 주주총회 예정일: a date appearing near 주주총회 wording.
  let agmDate: string | undefined;
  const agmCtx = all.match(/주주?\s*총회[^。\n]{0,60}/g) ?? [];
  for (const ctx of agmCtx) {
    const d = ctx.match(/20\d{2}년\s*\d{1,2}월\s*\d{1,2}일/);
    if (d && afterPeriodEnd(toDate(d[0]))) {
      agmDate = toDate(d[0]);
      break;
    }
  }

  const signing = dates.filter(afterPeriodEnd).sort();
  const signingDate = signing[signing.length - 1];

  // Masked/blank report date, e.g. "2026년 3월 00일" or "2026년 3월 일".
  const masked = /20\d{2}년\s*\d{1,2}월\s*(00|OO|○○|__|\s)일/.test(all);

  const today = new Date().toISOString().slice(0, 10);
  const windowEnd = agmDate ?? (masked || !signingDate ? today : signingDate);
  const windowEndBasis: SubsequentReview["windowEndBasis"] = agmDate
    ? "주주총회일"
    : masked || !signingDate
      ? "앱 사용일(감사보고서일 미확정)"
      : "감사보고서일";
  const auditReportDate = windowEnd;

  const covered: EventCategory[] = [];
  const toVerify: EventCategory[] = [];
  for (const c of EVENT_CATEGORIES) {
    (c.markers.test(disclosedText) ? covered : toVerify).push(c);
  }

  return {
    noteFound,
    ...(noteNo ? { noteNo } : {}),
    disclosedText: disclosedText.replace(/\s+/g, " ").trim(),
    ...(periodEnd ? { periodEnd } : {}),
    ...(auditReportDate ? { auditReportDate } : {}),
    windowEndBasis,
    covered,
    toVerify,
    ...(doc.company ? { company: doc.company } : {}),
  };
}

/** Ready-to-paste search queries for DART / news. */
export function searchQueries(r: SubsequentReview): string[] {
  const co = searchName(r.company) || "회사명";
  const win =
    r.periodEnd && r.auditReportDate ? ` (${r.periodEnd} ~ ${r.auditReportDate})` : "";
  return r.toVerify.flatMap((c) => c.searchTerms.map((t) => `${co} ${t}${win}`));
}
