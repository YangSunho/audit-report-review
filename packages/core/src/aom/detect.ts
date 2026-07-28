// Content-based statement detection.
//
// WHY THIS EXISTS: statement headings are not reliable. Across real filings the
// title "재 무 상 태 표" may be a table, a paragraph, or absent entirely — filers
// differ, and every heading-based rule broke on the next company. Account names,
// however, are dictated by K-IFRS presentation and are stable:
//
//   BS  자산·부채·자본 totals, 유동/비유동 sections
//   IS  매출액·매출원가·영업이익·당기순이익
//   CF  영업/투자/재무활동 현금흐름
//   SCE 자본금·자본잉여금·이익잉여금 columns with 기초/기말 rows
//
// So we read what the table CONTAINS instead of guessing from what precedes it.

import type { Statement } from "./types.js";
import type { ParsedTable } from "../dsd/parser.js";

/** Row labels of a table, squeezed for matching. */
function labelsOf(table: ParsedTable): string[] {
  return table.rows
    .map((r) => r.cells.find((c) => c.col === 0)?.text ?? "")
    .map((t) => t.replace(/\s/g, ""))
    .filter(Boolean);
}

/** All cell text of a table, squeezed (for header-based hints like SCE columns). */
function allTextOf(table: ParsedTable): string {
  return table.rows
    .flatMap((r) => r.cells.map((c) => c.text ?? ""))
    .join(" ")
    .replace(/\s/g, "");
}

interface Signal {
  statement: Statement;
  /** Each hit adds to the score; the statement with the highest score wins. */
  markers: RegExp[];
  /** A single strong marker is enough on its own. */
  decisive: RegExp[];
}

const SIGNALS: Signal[] = [
  {
    statement: "BS",
    markers: [/유동자산/, /비유동자산/, /유동부채/, /비유동부채/, /자본금/, /이익잉여금/, /^자산$/, /^부채$/],
    decisive: [/자산총계|자산총액/, /부채와자본총계|부채및자본총계/],
  },
  {
    statement: "IS",
    markers: [/매출원가/, /매출총이익/, /판매비와관리비/, /영업이익|영업손실/, /법인세비용/, /주당순?이익|주당손익/],
    decisive: [/당기순이익|당기순손실|당기순손익/, /총포괄손익|포괄손익/],
  },
  {
    statement: "CF",
    markers: [/투자활동/, /재무활동/, /현금및현금성자산의?증가|현금의증가/, /기초의?현금|기초현금/, /기말의?현금|기말현금/],
    decisive: [/영업활동으?로?인?한?현금흐름|영업활동현금흐름/],
  },
  {
    statement: "SCE",
    markers: [/자본잉여금/, /기타포괄손익누계액|기타자본구성요소/, /배당금지급/, /전기초|당기초/, /전기말|당기말/],
    decisive: [/자본총계.*기초|기초.*자본총계/],
  },
];

export interface StatementDetection {
  statement: Statement;
  /** How many markers matched — higher means safer. */
  score: number;
}

/**
 * Identify which primary statement a table represents, from its own content.
 * Returns undefined when the evidence is too thin (note tables, cover blocks…),
 * so callers never mislabel an ordinary note table as a statement.
 */
export function detectStatement(table: ParsedTable): StatementDetection | undefined {
  // A primary statement is a tall table of accounts; notes and cover blocks are short.
  if (table.rows.length < 8) return undefined;
  const labels = labelsOf(table);
  if (labels.length < 6) return undefined;
  const joined = labels.join(" ");
  const all = allTextOf(table);

  // SCE first: a statement of changes in equity mentions 당기순손익 too, but it is
  // recognisable by its row labels being DATES (2024년 1월 1일(전기초)) and by the
  // equity component columns. Checking it before IS avoids that misread.
  const dateRows = labels.filter((l) => /^20\d{2}[년.]/.test(l)).length;
  const equityCols = /자본금|자본잉여금|이익잉여금|기타포괄손익누계액|자본조정/.test(all);
  if (dateRows >= 2 && equityCols) return { statement: "SCE", score: 10 };

  let best: StatementDetection | undefined;
  for (const sig of SIGNALS) {
    const decisive = sig.decisive.some((re) => re.test(joined) || re.test(all));
    const hits = sig.markers.filter((re) => re.test(joined)).length;
    const score = hits + (decisive ? 5 : 0);
    // Require either a decisive marker or several corroborating ones.
    if ((decisive || hits >= 3) && (best === undefined || score > best.score)) {
      best = { statement: sig.statement, score };
    }
  }
  return best;
}
