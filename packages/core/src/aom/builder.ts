// AOM Builder — ParsedDocument (M0 structural tree) → Audit Object Model (Doc 05).
// Deterministic, pure (§6, §19). Every object carries `source` (§20) and
// `provenance`. Semantic classification here is rule-based structural inference
// (statement/table-type by heading keywords) — no AI, no fabricated numbers (§5).
//
// M1 scope decisions (spec defaults, recorded):
//  · Only FS-context and note-context tables become FinancialStatementTable
//    objects (the auditable content: 재무제표 + 주석). Cover/TOC/opinion/외부감사
//    tables stay structural (referenced by Section only).
//  · FinancialStatementLine is emitted only for amount-bearing rows of BS/IS/CF
//    (SCE is a movement matrix — kept as a table, no per-line extraction in M1).
//  · Reference resolution here is existence-only (note number → NoteBlock).
//    Correctness (right note for the account) is a M2 Reference Review judgment.

import type {
  AomObject,
  AomDocument,
  Section,
  NoteBlock,
  FinancialStatementTable,
  FinancialStatementLine,
  Reference,
  RelationshipEdge,
  TableCell,
  TableRow,
  TableType,
  Statement,
  SourceRef,
  Provenance,
  NormalizedNumber,
} from "./types.js";
import { aomId } from "./ids.js";
import { detectStatement } from "./detect.js";
import { extractFiscalPeriod } from "./period.js";
import type {
  ParsedDocument,
  ParsedSection,
  ParsedTable,
  ParsedRow,
  ParsedBlock,
} from "../dsd/parser.js";

export const BUILDER_VERSION = "0.1.0";
export const SCHEMA_VERSION = "1.0";

export interface AomModel {
  builderVersion: string;
  schemaVersion: string;
  dsdFileHash: string;
  objects: AomObject[]; // document order (deterministic §19)
}

// ── classification rules (deterministic) ─────────────────────────────────────

/** Map a statement heading ("재 무 상 태 표") to a Statement code, else undefined. */
export function classifyStatementHeading(text: string): Statement | undefined {
  const c = text.replace(/\s/g, "");
  // 연결/별도 접두어와 구표기(대차대조표)까지 흡수 — 회사마다 표기가 다르다.
  if (c.includes("재무상태표") || c.includes("대차대조표")) return "BS";
  if (c.includes("포괄손익계산서") || c.includes("손익계산서")) return "IS";
  if (c.includes("자본변동표")) return "SCE";
  if (c.includes("현금흐름표")) return "CF";
  return undefined;
}

/** Deterministic table-type inference from header/label keywords (Doc 05 §3.1). */
export function classifyTableType(table: ParsedTable, isNote: boolean): TableType {
  let hasBase = false;
  let hasEnd = false;
  let hasMaturity = false;
  for (const r of table.rows) {
    for (const c of r.cells) {
      const t = c.text.replace(/\s/g, "");
      if (t.includes("기초")) hasBase = true;
      if (t.includes("기말")) hasEnd = true;
      if (/만기|년이내|년초과|이내|초과/.test(t)) hasMaturity = true;
    }
  }
  if (hasBase && hasEnd) return "RollForward";
  if (hasMaturity) return "Maturity";
  return isNote ? "Breakdown" : "Other";
}

/** Extract the two most recent 4-digit years from heading text → {current, prior}. */
function periodFromHeading(table: ParsedTable): { current: string; prior?: string } | undefined {
  const years = new Set<string>();
  for (const r of table.rows)
    for (const c of r.cells)
      for (const m of c.text.matchAll(/((?:19|20)\d{2})\s*년/g)) years.add(m[1]!);
  const sorted = [...years].sort().reverse();
  if (sorted.length === 0) return undefined;
  return sorted[1] ? { current: sorted[0]!, prior: sorted[1] } : { current: sorted[0]! };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function source(dsdFileHash: string, t: { xmlPath: string; page?: number; bookmark?: string }): SourceRef {
  return {
    dsdFileHash,
    xmlPath: t.xmlPath,
    ...(t.bookmark ? { bookmark: t.bookmark } : {}),
    ...(t.page !== undefined ? { page: t.page } : {}),
  };
}

function prov(semanticBy: string, confidence: Provenance["confidence"]): Provenance {
  return { extractedBy: `AomBuilder@${BUILDER_VERSION}`, semanticBy, confidence };
}

function toTableCell(c: ParsedRow["cells"][number]): TableCell {
  return {
    row: c.row,
    col: c.col,
    ...(c.rowSpan !== 1 ? { rowSpan: c.rowSpan } : {}),
    ...(c.colSpan !== 1 ? { colSpan: c.colSpan } : {}),
    ...(c.empty ? { empty: true } : {}),
    ...(c.number ? { number: c.number } : {}),
    ...(c.text ? { text: c.text } : {}),
  };
}

function toTableRows(pt: ParsedTable): TableRow[] {
  return pt.rows.map((r) => ({
    label: r.cells.find((c) => !c.empty)?.text ?? "",
    cells: r.cells.map(toTableCell),
  }));
}

function headerColumns(pt: ParsedTable): string[] {
  const head = pt.rows.find((r) => r.section === "thead");
  if (!head) return [];
  return head.cells.map((c) => c.text).filter((t) => t !== "");
}

/** Note-reference column index (header cell containing 주석), else -1. */
function noteColOf(pt: ParsedTable): number {
  const head = pt.rows.find((r) => r.section === "thead");
  if (!head) return -1;
  const cell = head.cells.find((c) => c.text.replace(/\s/g, "").includes("주석"));
  return cell ? cell.col : -1;
}

function parseNoteRefs(text: string): string[] {
  return text
    .split(/[,\s/]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

// ── builder ──────────────────────────────────────────────────────────────────

export function buildAom(parsed: ParsedDocument): AomModel {
  const dsdFileHash = parsed.dsdFileHash;
  const objects: AomObject[] = [];

  // Pre-scan note headings so FS-line references can resolve to NoteBlock ids
  // even though notes appear later in document order.
  const noteSec = findNoteSection(parsed.root);
  const noteHeadings = noteSec ? scanNoteHeadings(noteSec.blocks) : new Map<ParsedBlock, { no: string; title: string }>();
  const noteNumbers = new Set([...noteHeadings.values()].map((v) => v.no));
  const noteIdOf = (n: string): string => aomId("note", n);

  // 기수·회계기간·결산일 — 검토 결과가 어느 기의 것인지 밝히기 위해 문서 전체에서 읽는다.
  const fiscal = extractFiscalPeriod(parsed);

  // Document root.
  const doc: AomDocument = {
    id: "aom:doc",
    objectType: "Document",
    schemaVersion: SCHEMA_VERSION,
    source: source(dsdFileHash, { xmlPath: parsed.root.xmlPath, page: 1 }),
    provenance: prov("rule:structural", "high"),
    ...(parsed.docName ? { docName: parsed.docName } : {}),
    ...(parsed.company ? { company: parsed.company } : {}),
    ...(parsed.schema ? { schema: parsed.schema } : {}),
    ...(parsed.docVersion ? { docVersion: parsed.docVersion } : {}),
    extractions: parsed.extractions,
    pageCount: parsed.pageCount,
    sectionIds: [],
    ...(fiscal ? { fiscal } : {}),
  };
  objects.push(doc);

  let sectionSeq = 0;
  const ctx: BuildCtx = { dsdFileHash, objects, noteNumbers, noteHeadings, noteIdOf, period: { current: "" } };

  for (const child of parsed.root.children) {
    const sec = buildSection(child, doc.id, ctx, () => `s${++sectionSeq}`);
    doc.sectionIds.push(sec.id);
  }

  return { builderVersion: BUILDER_VERSION, schemaVersion: SCHEMA_VERSION, dsdFileHash, objects };
}

interface BuildCtx {
  dsdFileHash: string;
  objects: AomObject[];
  noteNumbers: Set<string>;
  noteHeadings: Map<ParsedBlock, { no: string; title: string }>;
  noteIdOf: (n: string) => string;
  period: { current: string; prior?: string };
}

function buildSection(
  ps: ParsedSection,
  parentId: string,
  ctx: BuildCtx,
  nextSeq: () => string,
): Section {
  const seq = nextSeq();
  const statement = ps.title ? classifyStatementHeading(ps.title) : undefined;
  const section: Section = {
    id: aomId("sec", seq, ps.title ?? ps.kind),
    objectType: "Section",
    schemaVersion: SCHEMA_VERSION,
    source: source(ctx.dsdFileHash, ps),
    provenance: prov("rule:structural", "high"),
    kind: ps.kind,
    ...(ps.title ? { title: ps.title } : {}),
    ...(statement ? { statement } : {}),
    parentId,
    childIds: [],
    tableIds: [],
  };
  ctx.objects.push(section);

  // Section titles vary by firm: "재 무 제 표", "(첨부)재무제표", "연결재무제표",
  // "재무제표에 대한 주석", "주 석" … Match on the squeezed title so spacing and
  // decoration never decide whether a whole statement gets parsed.
  const t = (ps.title ?? "").replace(/\s/g, "");
  const isFsSection = /재무제표/.test(t) && !/주석/.test(t);
  const isNoteSection = /주석/.test(t);

  let currentStatement: Statement | undefined = statement;
  let currentNote: NoteBlock | undefined;
  // Set when a statement heading table is seen — lets FS parsing proceed even if
  // the enclosing section title used unfamiliar wording.
  let fsByHeading = false;

  for (const block of ps.blocks) {
    if (block.type === "paragraph") {
      // A statement title can be a PARAGRAPH rather than a heading table — filers
      // differ ("재 무 상 태 표" as text vs. as a one-cell table). Missing this
      // left the whole FS unparsed for such reports, so check paragraphs too.
      if (!isNoteSection) {
        const headStmt = classifyStatementHeading(block.text);
        if (headStmt && block.text.replace(/\s/g, "").length <= 20) {
          currentStatement = headStmt;
          fsByHeading = true;
          continue;
        }
      }
      if (isNoteSection) {
        const note = ctx.noteHeadings.get(block);
        if (note) {
          currentNote = {
            id: ctx.noteIdOf(note.no),
            objectType: "NoteBlock",
            schemaVersion: SCHEMA_VERSION,
            source: source(ctx.dsdFileHash, block),
            provenance: prov("rule:note-heading", "high"),
            noteNo: note.no,
            title: note.title,
            tableIds: [],
          };
          ctx.objects.push(currentNote);
        }
      }
      continue;
    }
    if (block.type !== "table") continue;

    // A statement heading table opens the FS context. This also RECOVERS the
    // context when the section title was not recognised (firm-specific wording):
    // seeing "재 무 상 태 표" as a heading is itself proof we are in the FS part,
    // so the statements still parse instead of silently yielding nothing.
    {
      const headStmt = classifyStatementHeading(tableText(block));
      if (headStmt && block.columnCount <= 2) {
        currentStatement = headStmt;
        fsByHeading = true;
        const p = periodFromHeading(block);
        if (p) ctx.period = p;
        continue; // heading table itself is not an auditable object
      }
    }

    // Skip label/spacer tables (single column, e.g. "별첨 주석은 …"): not auditable.
    if (block.columnCount < 2) continue;

    // CONTENT-BASED DETECTION (primary path). Some filers print no statement
    // title at all — the data table simply follows a period table. Reading the
    // table's own account names ("자산총계", "영업활동으로 인한 현금흐름") identifies
    // the statement without depending on any heading, so parsing no longer
    // varies by filer. Heading context still applies to tables that follow.
    // Never run detection in the cover/TOC: a table of contents lists the same
    // account words ("매출액", "현금흐름표") and would be mistaken for a statement.
    if (!isNoteSection && ps.kind !== "TOC" && ps.kind !== "COVER") {
      const det = detectStatement(block);
      if (det) {
        currentStatement = det.statement;
        fsByHeading = true;
      }
      // A short period table ("제35기 2024년 1월 1일 부터 …") announces the
      // statement that follows; capture the period from it and do not emit it as
      // an auditable table.
      if (block.rows.length <= 4) {
        const p = periodFromHeading(block);
        if (p) ctx.period = p;
        continue;
      }
    }

    // Emit auditable tables (FS-context or note-context only).
    if ((isFsSection || fsByHeading) && currentStatement && !isNoteSection) {
      const table = buildFsTable(block, currentStatement, ctx, undefined);
      section.tableIds.push(table.id);
      if (currentStatement !== "SCE") buildLines(block, table, currentStatement, ctx);
    } else if (isNoteSection && currentNote) {
      const table = buildFsTable(block, "NOTE", ctx, currentNote.noteNo);
      section.tableIds.push(table.id);
      currentNote.tableIds.push(table.id);
    }
    // else: structural table (cover/opinion/…) — not emitted as an AOM object.
  }

  for (const cs of ps.children) {
    const child = buildSection(cs, section.id, ctx, nextSeq);
    section.childIds.push(child.id);
  }
  return section;
}

function buildFsTable(
  pt: ParsedTable,
  statement: Statement,
  ctx: BuildCtx,
  note: string | undefined,
): FinancialStatementTable {
  const tableType = classifyTableType(pt, statement === "NOTE");
  const table: FinancialStatementTable = {
    id: aomId("table", statement.toLowerCase(), note ?? "", pt.xmlPath),
    objectType: "FinancialStatementTable",
    schemaVersion: SCHEMA_VERSION,
    source: source(ctx.dsdFileHash, pt),
    provenance: prov("rule:structural", "high"),
    statement,
    ...(note ? { note } : {}),
    // 캡션은 **주석 표에만** 붙인다. 한 주석 안에 표가 여럿일 때 어느 표인지
    // 가리키려고 앞 문단에서 가져오는 장치이기 때문이다("22.3 …변동내역").
    //
    // 재무제표 본표(BS/IS/CF/SCE)는 제목이 곧 이름이므로 캡션이 필요 없고,
    // 붙이면 오히려 해롭다 — 본표 앞 문단은 감사보고서 본문이라서
    // "이 감사보고서의 근거가 된 감사를 실시한 업무수행이사는 …입니다" 같은
    // 문장이 재무상태표의 이름으로 표시된 사례가 있었다.
    ...(statement === "NOTE" && pt.caption ? { caption: pt.caption } : {}),
    tableType,
    period: ctx.period.prior
      ? { current: ctx.period.current, prior: ctx.period.prior }
      : { current: ctx.period.current },
    columns: headerColumns(pt),
    rows: toTableRows(pt),
  };
  ctx.objects.push(table);
  return table;
}

/** Extract amount-bearing FinancialStatementLine rows from a BS/IS/CF table. */
function buildLines(
  pt: ParsedTable,
  table: FinancialStatementTable,
  statement: Statement,
  ctx: BuildCtx,
): void {
  // A dedicated 주석 column is optional: some filers print note refs inside the
  // account name instead ("현금및현금성자산(주석4,5)"). Bailing out when the column
  // is absent silently produced ZERO statement lines for those reports, which in
  // turn emptied the variance, integrity and query sections. Fall back to col 0.
  const noteCol = noteColOf(pt);
  const amountsStart = noteCol >= 0 ? noteCol + 1 : 1;
  const maxCol = Math.max(0, ...pt.rows.flatMap((r) => r.cells.map((c) => c.col)));
  const periodCols: number[] = [];
  for (let c = amountsStart; c <= maxCol; c++) periodCols.push(c);
  const half = Math.ceil(periodCols.length / 2);
  const currentCols = periodCols.slice(0, half);
  const priorCols = periodCols.slice(half);

  const firstNumber = (r: ParsedRow, cols: number[]): NormalizedNumber | undefined => {
    for (const col of cols) {
      const cell = r.cells.find((c) => c.col === col);
      if (cell?.number) return cell.number;
    }
    return undefined;
  };

  let lineSeq = 0;
  for (const r of pt.rows) {
    if (r.section !== "tbody") continue;
    const acctCell = r.cells.find((c) => c.col === 0 && !c.empty);
    const account = acctCell?.text ?? "";
    if (account === "") continue;
    const current = firstNumber(r, currentCols);
    if (!current) continue; // structural/header row without an amount — skip (M1)
    const prior = firstNumber(r, priorCols);
    // Note refs come from the 주석 column when present, otherwise from the
    // account label itself ("매출채권(주석12,24)").
    const noteCell = noteCol >= 0 ? r.cells.find((c) => c.col === noteCol) : undefined;
    const noteRef = noteCell ? parseNoteRefs(noteCell.text) : parseNoteRefs(account);

    const line: FinancialStatementLine = {
      id: aomId("line", statement.toLowerCase(), account, String(++lineSeq)),
      objectType: "FinancialStatementLine",
      schemaVersion: SCHEMA_VERSION,
      source: source(ctx.dsdFileHash, { xmlPath: `${pt.xmlPath}#L${lineSeq}`, page: pt.page }),
      provenance: prov("rule:structural", "high"),
      statement,
      account,
      noteRef,
      amount: prior ? { current, prior } : { current },
    };
    ctx.objects.push(line);

    // Structural references (existence-resolved) + relationship edges.
    for (const n of noteRef) {
      const resolved = ctx.noteNumbers.has(n);
      const ref: Reference = {
        id: aomId("ref", line.id.replace(/^aom:/, ""), "note" + n),
        objectType: "Reference",
        schemaVersion: SCHEMA_VERSION,
        source: source(ctx.dsdFileHash, { xmlPath: line.source.xmlPath, page: pt.page }),
        provenance: prov("rule:reference", resolved ? "high" : "unresolved"),
        refKind: "note",
        from: line.id,
        toLabel: "주석" + n,
        ...(resolved ? { toResolved: ctx.noteIdOf(n) } : {}),
        status: resolved ? "resolved" : "unresolved",
        suggestedFix: null,
      };
      ctx.objects.push(ref);
      if (resolved) {
        const edge: RelationshipEdge = {
          id: aomId("edge", line.id.replace(/^aom:/, ""), "note" + n),
          objectType: "RelationshipEdge",
          schemaVersion: SCHEMA_VERSION,
          source: source(ctx.dsdFileHash, { xmlPath: line.source.xmlPath, page: pt.page }),
          provenance: prov("rule:reference", "high"),
          from: line.id,
          to: ctx.noteIdOf(n),
          relation: "references",
          basis: `${account} → 주석${n}`,
        };
        ctx.objects.push(edge);
      }
    }
  }
}

// ── note-heading detection ───────────────────────────────────────────────────

/**
 * Parse a note heading from a paragraph's FIRST LINE (headings often carry body
 * text in the same paragraph, e.g. "22. 퇴직급여\n\n당사는 …"). Returns the
 * top-level note number, whether it was written as a sub-heading ("2.2 …"), and
 * the title. Matching the first line (not the whole paragraph) is what lets long
 * text-only notes (3·22·37) be recognized.
 */
function parseNoteHeading(
  text: string,
): { topNo: number; isSub: boolean; title: string } | undefined {
  const firstLine = text.split("\n")[0]!.trim();
  if (firstLine.length > 60) return undefined; // a heading first line is short
  const m = firstLine.match(/^(\d+)((?:\.\d+)*)\.?\s+(\S.*)$/);
  if (!m) return undefined;
  return { topNo: Number(m[1]), isSub: m[2] !== "", title: m[3]!.trim() };
}

/**
 * Scan the 주석 section in document order and register one NoteBlock per
 * contiguous top-level number. A note may be introduced either by a plain
 * heading ("22. 퇴직급여") or — when the top-level heading is absent — by its
 * first sub-heading ("2.2 중요한 회계정책" ⇒ 주석 2). Contiguity (N == last+1)
 * guards against body sentences that happen to start with a number.
 * Returns a map keyed by the heading paragraph so the builder can switch context.
 */
function scanNoteHeadings(blocks: ParsedBlock[]): Map<ParsedBlock, { no: string; title: string }> {
  const map = new Map<ParsedBlock, { no: string; title: string }>();
  // Note numbers must ASCEND but need not be contiguous: filers legitimately
  // skip numbers (리클린: 1, 2, 4, 5 … — no note 3). Requiring last+1 stopped at
  // the first gap and left the report with almost no notes, which in turn broke
  // note-linked evidence everywhere. Allow gaps; still reject decreases, which
  // would mean we are re-reading list items inside a note body ("1) …").
  let last = 0;
  for (const b of blocks) {
    if (b.type !== "paragraph") continue;
    const h = parseNoteHeading(b.text);
    if (!h || h.topNo <= last) continue;
    // A sub-numbered heading ("2.2 중요한 회계정책") still OPENS note 2 when note 2
    // has not been seen yet — some filers never print a bare "2." line. Later
    // sub-headings of the same note (2.2.1 …) are skipped by the ascending rule.
    map.set(b, { no: String(h.topNo), title: h.title });
    last = h.topNo;
  }
  return map;
}

function findNoteSection(s: ParsedSection): ParsedSection | undefined {
  if (s.kind === "SECTION-2" && s.title === "주석") return s;
  for (const c of s.children) {
    const found = findNoteSection(c);
    if (found) return found;
  }
  return undefined;
}

function tableText(pt: ParsedTable): string {
  const r0 = pt.rows[0];
  return r0 ? r0.cells.map((c) => c.text).join(" ") : "";
}
