// Audit-friendly .xlsx export (MVP ②). Pure & deterministic (§19), zero external
// deps — hand-rolled SpreadsheetML (same OOXML/ZIP approach as docx.ts). The
// workbook only QUOTES engine/parser output; it never computes figures (§6).
// Numbers are written as real numeric cells (integer KRW) so auditors can compute.

import type { AomObject, FinancialStatementLine, NoteBlock, Statement } from "../aom/types.js";
import type { AomModel } from "../aom/builder.js";
import type { EngineReport } from "../engine/run.js";
import { objectLabel, noteTitleMap } from "../labels.js";
import { buildCoverage } from "./coverage.js";
import { buildVariance } from "./variance.js";
import { buildReviewQueries } from "./queries.js";
import { reviewSubsequentEvents } from "./subsequent.js";
import type { ParsedDocument } from "../dsd/parser.js";
import { enc, xmlEscape, zipStore, type Entry } from "./ooxml.js";

export type XCell = string | number | { v: string | number; bold?: boolean };
export interface Sheet {
  name: string;
  rows: XCell[][];
}
export interface Workbook {
  sheets: Sheet[];
}

// ── SpreadsheetML rendering ──────────────────────────────────────────────────

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// style ids (see STYLES): 0 default · 1 bold · 2 number(#,##0) · 3 bold number
function cellXml(c: XCell, ref: string): string {
  const v = typeof c === "object" ? c.v : c;
  const bold = typeof c === "object" ? !!c.bold : false;
  if (typeof v === "number" && Number.isFinite(v)) {
    return `<c r="${ref}" s="${bold ? 3 : 2}"><v>${v}</v></c>`;
  }
  return `<c r="${ref}" s="${bold ? 1 : 0}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(v))}</t></is></c>`;
}

/** Display width of a value in Excel "characters" (CJK counts double). */
function displayWidth(c: XCell): number {
  const v = typeof c === "object" ? c.v : c;
  const s =
    typeof v === "number" && Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : String(v);
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(ch) ? 2 : 1;
  return w;
}

/**
 * Column widths sized to content — without them Excel shows "#####" for every
 * number, which makes the workbook look broken. Capped so a long sentence does
 * not push the sheet off-screen (the cell still holds the full text).
 */
function colsXml(sheet: Sheet): string {
  const widths: number[] = [];
  for (const row of sheet.rows) {
    row.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(c));
    });
  }
  if (widths.length === 0) return "";
  const cols = widths
    .map((w, i) => {
      const width = Math.min(Math.max(w + 3, 9), 60); // padding, floor, cap
      return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
    })
    .join("");
  return `<cols>${cols}</cols>`;
}

function sheetXml(sheet: Sheet): string {
  const rows = sheet.rows
    .map((row, ri) => {
      const cells = row.map((c, ci) => cellXml(c, colName(ci) + (ri + 1))).join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    // Freeze the header row so long sheets stay readable while scrolling.
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    colsXml(sheet) +
    `<sheetData>${rows}</sheetData></worksheet>`
  );
}

function sanitizeName(name: string, used: Set<string>): string {
  let n = name.replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Sheet";
  let i = 2;
  const base = n;
  while (used.has(n)) n = `${base.slice(0, 28)}_${i++}`;
  used.add(n);
  return n;
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>";

function contentTypes(sheetCount: number): string {
  const overrides = Array.from({ length: sheetCount }, (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    overrides +
    "</Types>"
  );
}

function workbookXml(names: string[]): string {
  const sheets = names
    .map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets}</sheets></workbook>`
  );
}

function workbookRels(sheetCount: number): string {
  const sheetRels = Array.from({ length: sheetCount }, (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join("");
  const stylesRel = `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheetRels +
    stylesRel +
    "</Relationships>"
  );
}

/** Render a Workbook to .xlsx bytes. Deterministic for identical input (§19). */
export function renderXlsx(book: Workbook): Uint8Array {
  const used = new Set<string>();
  const names = book.sheets.map((s) => sanitizeName(s.name, used));
  const entries: Entry[] = [
    { name: "[Content_Types].xml", data: enc.encode(contentTypes(book.sheets.length)) },
    { name: "_rels/.rels", data: enc.encode(ROOT_RELS) },
    { name: "xl/workbook.xml", data: enc.encode(workbookXml(names)) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(workbookRels(book.sheets.length)) },
    { name: "xl/styles.xml", data: enc.encode(STYLES) },
    ...book.sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc.encode(sheetXml(s)),
    })),
  ];
  return zipStore(entries);
}

// ── audit workbook assembly (MVP ②) ─────────────────────────────────────────

const SEVERITY_KO: Record<string, string> = { error: "오류", review: "검토 권장", info: "참고" };
const STATUS_KO: Record<string, string> = {
  match: "일치",
  mismatch: "불일치",
  review: "검토 권장",
  skipped: "해당 없음",
};

function fsSheet(
  title: string,
  st: Statement,
  lines: FinancialStatementLine[],
): Sheet | undefined {
  const rows = lines.filter((l) => l.statement === st);
  if (rows.length === 0) return undefined;
  const header: XCell[] = [
    { v: "계정", bold: true },
    { v: "당기", bold: true },
    { v: "전기", bold: true },
    { v: "관련주석", bold: true },
  ];
  const body: XCell[][] = rows.map((l) => [
    l.account,
    l.amount.current.value,
    l.amount.prior?.value ?? "",
    l.noteRef.join(", "),
  ]);
  return { name: title, rows: [header, ...body] };
}

/**
 * Build the audit-friendly workbook from the AOM + engine report.
 * Sheets: 요약 · BS · IS · CF · SCE · 주석 · 이슈 · 검토질문 · 참조.
 */
export function buildAuditWorkbook(
  model: AomModel,
  engine: EngineReport,
  parsed?: ParsedDocument,
): Workbook {
  const objects = model.objects;
  const index = new Map<string, AomObject>(objects.map((o) => [o.id, o]));
  const noteTitles = noteTitleMap(objects);
  const itemOf = (id: string | undefined): string =>
    id && index.has(id) ? objectLabel(index.get(id)!, noteTitles) : "";
  const doc = objects.find((o) => o.objectType === "Document");
  const lines = objects.filter(
    (o): o is FinancialStatementLine => o.objectType === "FinancialStatementLine",
  );
  const notes = objects.filter((o): o is NoteBlock => o.objectType === "NoteBlock");
  const s = engine.summary;
  const at = (id: string | undefined): string => {
    if (!id) return "";
    const o = index.get(id);
    if (!o) return "";
    return `${o.source.xmlPath}${o.source.page !== undefined ? ` · p.${o.source.page}` : ""}`;
  };

  const sheets: Sheet[] = [];

  // 요약
  sheets.push({
    name: "요약",
    rows: [
      [{ v: "항목", bold: true }, { v: "값", bold: true }],
      ["회사", doc && "company" in doc ? (doc.company ?? "") : ""],
      ["문서", doc && "docName" in doc ? (doc.docName ?? "") : ""],
      // 기수·회계기간·결산일 — 엑셀만 떼어 조서에 붙여도 대상이 특정되도록 한다.
      ["기수·대상기간", doc && "fiscal" in doc ? (doc.fiscal?.label ?? "") : ""],
      ...(doc && "fiscal" in doc && doc.fiscal?.caveat
        ? [["유의", doc.fiscal.caveat] as (string | number)[]]
        : []),
      ["원본 해시(§7)", engine.dsdFileHash],
      ["엔진 버전(§19)", engine.engineVersion],
      ["", ""],
      [{ v: "판정", bold: true }, { v: "건수", bold: true }],
      ["일치", s.byStatus["match"] ?? 0],
      ["검토 권장", s.byStatus["review"] ?? 0],
      ["불일치(오탐 지표)", s.mismatches],
      ["해당 없음", s.byStatus["skipped"] ?? 0],
    ],
  });

  // 재무제표
  for (const [title, st] of [
    ["BS", "BS"],
    ["IS", "IS"],
    ["CF", "CF"],
    ["SCE", "SCE"],
  ] as [string, Statement][]) {
    const sh = fsSheet(title, st, lines);
    if (sh) sheets.push(sh);
  }

  // 주석
  sheets.push({
    name: "주석",
    rows: [
      [{ v: "번호", bold: true }, { v: "제목", bold: true }, { v: "표수", bold: true }],
      ...notes.map((n): XCell[] => [n.noteNo, n.title, n.tableIds.length]),
    ],
  });

  // 이슈
  sheets.push({
    name: "이슈",
    rows: [
      [
        { v: "구분", bold: true },
        { v: "항목", bold: true },
        { v: "제목", bold: true },
        { v: "근거", bold: true },
        { v: "위치(xmlPath)", bold: true },
      ],
      ...engine.issues.map((iss): XCell[] => [
        SEVERITY_KO[iss.severity] ?? iss.severity,
        itemOf(iss.evidence[0]),
        iss.title,
        iss.evidence[0] ? at(iss.evidence[0]).replace(/ · p\.\d+$/, "") : "",
        iss.drilldown[iss.drilldown.length - 1] ?? "",
      ]),
    ],
  });

  // 검토질문 (Insight, Doc 07)
  sheets.push({
    name: "검토질문",
    rows: [
      [
        { v: "구분", bold: true },
        { v: "질문", bold: true },
        { v: "판단 근거", bold: true },
        { v: "잠재 위험", bold: true },
        { v: "근거", bold: true },
      ],
      ...engine.insights.map((ins): XCell[] => [
        SEVERITY_KO[ins.severity] ?? ins.severity,
        ins.question,
        ins.rationale,
        ins.potentialRisk,
        ins.evidence[0]?.label ?? "",
      ]),
    ],
  });

  // 참조
  const refs = objects.filter((o) => o.objectType === "Reference");
  sheets.push({
    name: "참조",
    rows: [
      [
        { v: "대상", bold: true },
        { v: "상태", bold: true },
        { v: "권장수정", bold: true },
        { v: "위치(xmlPath)", bold: true },
      ],
      ...refs.map((r): XCell[] => {
        const ref = r as Extract<AomObject, { objectType: "Reference" }>;
        return [
          ref.toLabel,
          STATUS_KO[ref.status] ?? ref.status,
          ref.suggestedFix ? `${ref.suggestedFix.from}→${ref.suggestedFix.to}` : "",
          ref.source.xmlPath,
        ];
      }),
    ],
  });

  // 보고기간후사건 점검 (K-IFRS 1010)
  if (parsed) {
    const se = reviewSubsequentEvents(parsed);
    sheets.push({
      name: "보고기간후사건",
      rows: [
        [{ v: "구분", bold: true }, { v: "내용", bold: true }],
        ["검토 대상 기간", `${se.periodEnd ?? "?"} ~ ${se.auditReportDate ?? "?"}`],
        ["주석 발견", se.noteFound ? `주석${se.noteNo ?? ""}` : "미발견 — 주석 누락 여부 확인"],
        ["기재 내용", se.disclosedText.slice(0, 800)],
        ["기재 확인 유형", se.covered.map((c) => c.label).join(", ") || "없음"],
        ["", ""],
        [
          { v: "외부 확인 필요 유형", bold: true },
          { v: "왜 중요한가", bold: true },
          { v: "DART·뉴스 검색어", bold: true },
        ],
        ...se.toVerify.map((c): XCell[] => [c.label, c.why, c.searchTerms.join(" / ")]),
      ],
    });
  }

  // 심리실 예상 질의 — 제출 전 준비 사항
  sheets.push({
    name: "심리예상질의",
    rows: [
      [
        { v: "우선순위", bold: true },
        { v: "구분", bold: true },
        { v: "대상", bold: true },
        { v: "예상 질의", bold: true },
        { v: "근거", bold: true },
        { v: "준비 자료", bold: true },
      ],
      ...buildReviewQueries(model).map((q): XCell[] => [
        q.priority === "high" ? "필수 준비" : "준비 권장",
        q.area,
        q.subject,
        `${q.question}?`,
        q.basis,
        q.prepare,
      ]),
    ],
  });

  // 증감분석 — 당기/전기 변동과 유의적 항목
  for (const sec of buildVariance(model)) {
    sheets.push({
      name: `증감_${sec.title}`,
      rows: [
        [
          { v: "계정", bold: true },
          { v: "당기", bold: true },
          { v: "전기", bold: true },
          { v: "증감액", bold: true },
          { v: "증감율(%)", bold: true },
          { v: "유의성", bold: true },
          { v: "관련주석", bold: true },
        ],
        ...sec.rows.map((r): XCell[] => [
          r.account,
          r.current,
          r.prior ?? "",
          r.delta ?? "",
          r.pct === undefined ? "" : Number(r.pct.toFixed(1)),
          r.significant ? (r.reason ?? "유의") : "",
          r.noteRef.join(", "),
        ]),
      ],
    });
  }

  // 검토 수행 내역 — 무엇을 검증했고 결과가 무엇인지 (감사조서 증빙)
  sheets.push({
    name: "검토수행내역",
    rows: [
      [
        { v: "항목", bold: true },
        { v: "수행한 검증 → 결과", bold: true },
        { v: "검증 방법 / 사유", bold: true },
        { v: "판정", bold: true },
        { v: "검증건수", bold: true },
        { v: "위치", bold: true },
      ],
      ...buildCoverage(model, engine).map((c): XCell[] => [
        c.item,
        c.summary,
        [...c.methods, ...c.reasons.map((r) => `사유: ${r}`)].join(" / "),
        c.worst === "match" ? "일치" : c.worst === "mismatch" ? "불일치" : c.worst === "review" ? "확인 필요" : "판정 불가",
        c.total,
        c.location,
      ]),
    ],
  });

  return { sheets };
}
