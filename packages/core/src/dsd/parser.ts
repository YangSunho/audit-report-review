// DSD container + XML parsing. Spec: 03_DSD_Intelligence_Engine_Spec.md §2–§3.
// §7: original is read-only; extract into a temp dir only; record & verify hash.
//
// VERIFIED container (표본 A (2025 감사보고서)): .dsd is a ZIP containing
//   contents.xml (utf-8, body), meta.xml (schema=dart4.xsd, docver 6.0), *.jpg.
// VERIFIED contents.xml vocabulary (DART dart4):
//   DOCUMENT > DOCUMENT-HEADER > SUMMARY(EXTRACTION[ACODE]) > BODY
//   sections: SECTION-1/2, TITLE, TOC, COVER; text: P, SPAN
//   tables (HTML-like): TABLE, TABLE-GROUP, COLGROUP, COL, THEAD, TBODY, TR, TH, TD, TE, TU
//   pages: PGBRK   references/notes: LIBRARY, LIBRARYLIST, INSERTION, COMMENT
//   images: IMG, IMAGE, IMG-CAPTION, FILENAME
//
// M0 scope (Doc 03 §7 DoD): unzip + hash-immutability, parse contents.xml into a
// Section/Paragraph/Table/Cell tree with bookmarks + page breaks, preserving cell
// spans and empty cells (§11). Semantic/AOM mapping is M1+.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import type { NormalizedNumber } from "../aom/types.js";
import { readZip, type ZipEntry } from "./zip.js";
import {
  parseXml,
  textOf,
  childElements,
  firstDescendant,
  type XmlElement,
} from "./xml.js";

/** Parser output version — stamped on results for reproducibility (§19). */
export const PARSER_VERSION = "0.1.0";

// ── openDsd ──────────────────────────────────────────────────────────────────

export interface DsdEntryInfo {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
}

export interface DsdOpenResult {
  dsdFileHash: string; // sha256 of original bytes (§7 / §20)
  entries: string[]; // internal file names (contents.xml, meta.xml, ...)
  entryInfos: DsdEntryInfo[];
  tempDir: string; // read-only extraction location
  contentsXml: string; // decoded body XML (utf-8)
  metaXml: string | null; // meta.xml if present
}

const CONTENTS = "contents.xml";
const META = "meta.xml";

function sha256(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

/**
 * Open a .dsd from bytes already in memory — no filesystem, no Node APIs beyond
 * hashing. Used by the browser build, where the user's file never leaves the
 * page and there is nothing to extract to disk (§7 holds trivially: we only read
 * a copy the browser handed us).
 *
 * @param bytes  the .dsd file contents
 * @param hash   precomputed "sha256:…" (the browser supplies it via WebCrypto)
 */
export function openDsdBytes(bytes: Uint8Array, hash: string): DsdOpenResult {
  const zipEntries: ZipEntry[] = readZip(bytes);
  const entries = zipEntries.map((e) => e.name);
  const entryInfos: DsdEntryInfo[] = zipEntries.map((e) => ({
    name: e.name,
    method: e.method,
    compressedSize: e.compressedSize,
    uncompressedSize: e.uncompressedSize,
  }));

  const contentsEntry = zipEntries.find((e) => e.name === CONTENTS);
  if (!contentsEntry) {
    throw new Error(`invalid .dsd: ${CONTENTS} not found (entries: ${entries.join(", ")})`);
  }
  const contentsXml = new TextDecoder("utf-8").decode(contentsEntry.data);
  const metaEntry = zipEntries.find((e) => e.name === META);
  const metaXml = metaEntry ? new TextDecoder("utf-8").decode(metaEntry.data) : null;

  return { dsdFileHash: hash, entries, entryInfos, tempDir: "(in-memory)", contentsXml, metaXml };
}

/**
 * Open a .dsd (zip) without mutating the original (§7).
 * Computes the original hash, unzips to a fresh temp dir (files marked
 * read-only), lists entries, and locates contents.xml. Re-reads the original
 * afterward and asserts the hash is unchanged — proof of immutability for the run.
 */
export async function openDsd(path: string): Promise<DsdOpenResult> {
  const original = readFileSync(path);
  const dsdFileHash = sha256(original);

  const zipEntries: ZipEntry[] = readZip(original);
  const entries = zipEntries.map((e) => e.name);
  const entryInfos: DsdEntryInfo[] = zipEntries.map((e) => ({
    name: e.name,
    method: e.method,
    compressedSize: e.compressedSize,
    uncompressedSize: e.uncompressedSize,
  }));

  // Extract to a session temp dir (read-only). Never write back to the original.
  const tempDir = mkdtempSync(join(tmpdir(), "ari-dsd-"));
  for (const e of zipEntries) {
    const dest = join(tempDir, e.name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, e.data);
    try {
      chmodSync(dest, 0o444); // read-only extraction (best effort on Windows)
    } catch {
      /* platform may not honor mode; extraction is still session-temp */
    }
  }

  const contentsEntry = zipEntries.find((e) => e.name === CONTENTS);
  if (!contentsEntry) {
    throw new Error(`invalid .dsd: ${CONTENTS} not found (entries: ${entries.join(", ")})`);
  }
  const contentsXml = new TextDecoder("utf-8").decode(contentsEntry.data);
  const metaEntry = zipEntries.find((e) => e.name === META);
  const metaXml = metaEntry ? new TextDecoder("utf-8").decode(metaEntry.data) : null;

  // §7: verify the original file was not mutated during processing.
  const afterHash = sha256(readFileSync(path));
  if (afterHash !== dsdFileHash) {
    throw new Error("§7 violation: original .dsd changed during openDsd");
  }

  return { dsdFileHash, entries, entryInfos, tempDir, contentsXml, metaXml };
}

// ── parseContents domain model (M0 structural tree) ──────────────────────────

export type SectionKind = "COVER" | "TOC" | "SECTION-1" | "SECTION-2" | "BODY";

export interface ParsedCell {
  tag: "TD" | "TH" | "TU" | "TE";
  row: number; // logical grid row (0-based), after span expansion
  col: number; // logical grid col (0-based), after span expansion
  rowSpan: number;
  colSpan: number;
  text: string;
  empty: boolean;
  bookmark?: string; // USERMARK on the cell
  align?: string;
  number?: NormalizedNumber; // set when the cell holds a formatted amount
}

export interface ParsedRow {
  section: "thead" | "tbody";
  height?: number;
  cells: ParsedCell[];
}

export interface ParsedTable {
  type: "table";
  xmlPath: string;
  page: number; // 1-based page index (from preceding PGBRK count)
  aclass?: string;
  width?: number;
  bookmark?: string;
  /** Sub-heading paragraph immediately preceding the table, e.g.
   *  "22.3 당기 및 전기의 순확정급여부채의 변동내역은 다음과 같습니다."
   *  A note holds many tables; this pins WHICH one an issue refers to. */
  caption?: string;
  scale: number; // amount display scale in this table: 1 | 1000 | 1_000_000
  columnCount: number; // from COLGROUP/COL
  rows: ParsedRow[];
}

export interface ParsedParagraph {
  type: "paragraph";
  xmlPath: string;
  page: number;
  text: string;
  bookmark?: string;
}

export interface ParsedPageBreak {
  type: "pagebreak";
  xmlPath: string;
  page: number; // page number that ends at this break
}

export type ParsedBlock = ParsedParagraph | ParsedTable | ParsedPageBreak;

export interface ParsedSection {
  kind: SectionKind;
  xmlPath: string;
  title?: string;
  titleEng?: string;
  assocNote?: string; // AASSOCNOTE — note-boundary anchor
  tocId?: string; // ATOCID
  bookmark?: string;
  blocks: ParsedBlock[];
  children: ParsedSection[];
}

export interface ParsedStats {
  sections: number;
  tables: number;
  rows: number;
  cells: number;
  emptyCells: number;
  pageBreaks: number;
  bookmarks: number;
  numbers: number;
}

export interface ParsedDocument {
  parserVersion: string;
  dsdFileHash: string;
  schema?: string; // from meta.xml GENERATOR (dart4.xsd)
  docVersion?: string; // DOCUMENT-INFO docver
  docName?: string; // 감사보고서
  company?: string; // 표본 A
  formulaVersion?: string; // 6.0
  extractions: Record<string, string>; // SUMMARY EXTRACTION ACODE -> value
  pageCount: number; // total pages (pageBreaks + 1)
  root: ParsedSection; // BODY section holding the tree
  stats: ParsedStats;
}

// ── number normalization ─────────────────────────────────────────────────────

// M0 heuristic: treat a cell as a formatted amount only when it uses thousands
// separators (all real FS amounts in the sample do). This avoids misreading note
// references ("6,7,35") or small counts ("35") as amounts. Refined in M2.
// A displayed amount: optional sign/paren, then either comma-grouped digits
// (1,234) or a plain integer (106). Plain integers matter: in 천원 notes small
// movements (설정 106, 환입 (120)) are written without a comma — requiring a
// comma group silently dropped them and produced false roll-forward diffs.
// Bare 0/1-digit tokens that are really table markers ("-", "1") are excluded
// by requiring at least one digit and rejecting the empty/dash-only case.
const AMOUNT_RE = /^[(△▲\-−]?\d{1,3}(?:,\d{3})*\)?$|^[(△▲\-−]?\d+\)?$/;

/** Parse a display scale hint like "(단위 : 원)" / "(단위: 천원)" → 1 | 1000 | 1_000_000. */
export function detectScale(text: string): number {
  if (/단위/.test(text)) {
    if (/백만\s*원/.test(text)) return 1_000_000;
    if (/천\s*원/.test(text)) return 1_000;
  }
  return 1;
}

/**
 * Normalize a formatted Korean amount to integer KRW (§19: never float).
 * Returns undefined when the text is not a recognized amount.
 */
export function normalizeAmount(raw: string, scale = 1): NormalizedNumber | undefined {
  const trimmed = raw.trim();
  if (!AMOUNT_RE.test(trimmed)) return undefined;
  const negative =
    trimmed.startsWith("(") ||
    trimmed.startsWith("△") ||
    trimmed.startsWith("▲") ||
    trimmed.startsWith("-") ||
    trimmed.startsWith("−");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits === "") return undefined;
  const magnitude = Number(digits) * scale; // integer × integer → exact integer
  const signed = negative ? -magnitude : magnitude;
  const sign: NormalizedNumber["sign"] =
    magnitude === 0 ? "zero" : negative ? "negative" : "positive";
  return {
    raw: trimmed,
    value: signed,
    unit: "KRW",
    scale,
    sign,
    display: trimmed,
  };
}

// ── contents.xml → tree ──────────────────────────────────────────────────────

/** Normalize cell/paragraph text: decode soft breaks, collapse ideographic space. */
function cleanText(s: string): string {
  return s
    .replace(/&cr;/g, "\n") // DART soft line-break marker (&amp;cr; → &cr;)
    .replace(/　/g, " ") // ideographic space used as filler
    .replace(/ /g, " ") // non-breaking space
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const SECTION_TAGS = new Set(["COVER", "TOC", "SECTION-1", "SECTION-2"]);
const CELL_TAGS = new Set(["TD", "TH", "TU", "TE"]);

function attrNum(el: XmlElement, name: string): number | undefined {
  const v = el.attrs[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface WalkCtx {
  page: number; // current 1-based page
  stats: ParsedStats;
  inheritedScale: number; // 단위 hint carried from section/paragraph context
  lastCaption: string | undefined; // most recent sub-heading paragraph ("22.3 …")
}

/** Build the logical grid for a TABLE, expanding row/col spans (HTML table model). */
function parseTable(tableEl: XmlElement, xmlPath: string, ctx: WalkCtx): ParsedTable {
  const colgroup = firstDescendant(tableEl, "COLGROUP");
  const columnCount = colgroup ? childElements(colgroup, "COL").length : 0;

  // Display scale: the table's own 단위 hint wins; otherwise inherit the most
  // recent hint from the enclosing section/paragraph context. Audit notes often
  // declare "(단위: 천원)" once above the table, not inside each table, so
  // table-local detection alone under-normalizes ~40% of note tables (§ Q2).
  const own = detectScale(textOf(tableEl));
  const scale = own !== 1 ? own : ctx.inheritedScale;
  if (own !== 1) ctx.inheritedScale = own;

  // Attach the preceding sub-heading so each table is locatable. The caption is
  // consumed only by a table that actually carries figures — DSD often emits a
  // tiny caption/unit table ("(단위: 천원)") between the heading and the data
  // table, which must not swallow the heading.
  const caption = ctx.lastCaption;

  const rows: ParsedRow[] = [];
  // occupancy[row][col] — columns already claimed by a span from an earlier cell.
  const occupied: boolean[][] = [];
  const ensure = (r: number): boolean[] => (occupied[r] ??= []);

  const rowContainers: { section: "thead" | "tbody"; tr: XmlElement }[] = [];
  for (const thead of childElements(tableEl, "THEAD"))
    for (const tr of childElements(thead, "TR"))
      rowContainers.push({ section: "thead", tr });
  for (const tbody of childElements(tableEl, "TBODY"))
    for (const tr of childElements(tbody, "TR"))
      rowContainers.push({ section: "tbody", tr });
  // Some tables place TR directly under TABLE (no THEAD/TBODY).
  for (const tr of childElements(tableEl, "TR"))
    rowContainers.push({ section: "tbody", tr });

  let rowIdx = 0;
  for (const { section, tr } of rowContainers) {
    const cells: ParsedCell[] = [];
    let col = 0;
    const occ = ensure(rowIdx);
    for (const cellEl of tr.children) {
      if (cellEl.type !== "element" || !CELL_TAGS.has(cellEl.name)) continue;
      // Skip columns already covered by a rowspan from above.
      while (occ[col]) col++;

      const colSpan = attrNum(cellEl, "COLSPAN") ?? 1;
      const rowSpan = attrNum(cellEl, "ROWSPAN") ?? 1;
      const text = cleanText(textOf(cellEl));
      const empty = text === "";
      const bookmark = cellEl.attrs["USERMARK"]?.trim() || undefined;
      const align = cellEl.attrs["ALIGN"];
      const number = empty ? undefined : normalizeAmount(text, scale);

      cells.push({
        tag: cellEl.name as ParsedCell["tag"],
        row: rowIdx,
        col,
        rowSpan,
        colSpan,
        text,
        empty,
        ...(bookmark ? { bookmark } : {}),
        ...(align ? { align } : {}),
        ...(number ? { number } : {}),
      });

      // Mark occupancy for the span rectangle.
      for (let r = 0; r < rowSpan; r++) {
        const orow = ensure(rowIdx + r);
        for (let c = 0; c < colSpan; c++) orow[col + c] = true;
      }
      col += colSpan;

      ctx.stats.cells++;
      if (empty) ctx.stats.emptyCells++;
      if (bookmark) ctx.stats.bookmarks++;
      if (number) ctx.stats.numbers++;
    }
    const height = attrNum(tr, "HEIGHT");
    rows.push({ section, ...(height !== undefined ? { height } : {}), cells });
    ctx.stats.rows++;
    rowIdx++;
  }

  ctx.stats.tables++;
  const tableBookmark = tableEl.attrs["USERMARK"]?.trim() || undefined;
  if (tableBookmark) ctx.stats.bookmarks++;
  const width = attrNum(tableEl, "WIDTH");

  // Only a table with figures claims the caption (see above).
  const hasFigures = rows.some((r) => r.cells.some((c) => c.number !== undefined));
  if (hasFigures) ctx.lastCaption = undefined;

  return {
    type: "table",
    xmlPath,
    page: ctx.page,
    ...(tableEl.attrs["ACLASS"] ? { aclass: tableEl.attrs["ACLASS"] } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(tableBookmark ? { bookmark: tableBookmark } : {}),
    ...(hasFigures && caption ? { caption } : {}),
    scale,
    columnCount,
    rows,
  };
}

/** Recursively walk a section-like element, collecting blocks and child sections. */
function walkSection(
  el: XmlElement,
  kind: SectionKind,
  xmlPath: string,
  ctx: WalkCtx,
): ParsedSection {
  const bookmark = el.attrs["USERMARK"]?.trim() || undefined;
  const section: ParsedSection = {
    kind,
    xmlPath,
    ...(bookmark ? { bookmark } : {}),
    blocks: [],
    children: [],
  };
  ctx.stats.sections++;

  // Per-tag sibling index for xml_path (§20 traceability).
  const counts: Record<string, number> = {};
  const idx = (name: string): number => (counts[name] = (counts[name] ?? 0) + 1);

  for (const child of el.children) {
    if (child.type !== "element") continue;
    const name = child.name;
    const cPath = `${xmlPath}/${name}[${idx(name)}]`;

    if (name === "TITLE" || name === "COVER-TITLE") {
      if (section.title === undefined) {
        section.title = cleanText(textOf(child));
        if (child.attrs["ENG"]) section.titleEng = child.attrs["ENG"];
        if (child.attrs["AASSOCNOTE"]) section.assocNote = child.attrs["AASSOCNOTE"];
        if (child.attrs["ATOCID"]) section.tocId = child.attrs["ATOCID"];
      }
      continue;
    }
    if (SECTION_TAGS.has(name)) {
      section.children.push(walkSection(child, name as SectionKind, cPath, ctx));
      continue;
    }
    if (name === "PGBRK") {
      section.blocks.push({ type: "pagebreak", xmlPath: cPath, page: ctx.page });
      ctx.stats.pageBreaks++;
      ctx.page++;
      continue;
    }
    if (name === "TABLE" || name === "TABLE-GROUP") {
      // TABLE-GROUP wraps one or more TABLE elements; flatten to tables.
      if (name === "TABLE-GROUP") {
        let ti = 0;
        for (const t of childElements(child, "TABLE")) {
          section.blocks.push(parseTable(t, `${cPath}/TABLE[${++ti}]`, ctx));
        }
      } else {
        section.blocks.push(parseTable(child, cPath, ctx));
      }
      continue;
    }
    if (name === "P" || name === "SPAN") {
      const text = cleanText(textOf(child));
      const ps = detectScale(text); // "(단위: 천원)" above a table → inherit
      if (ps !== 1) ctx.inheritedScale = ps;
      // Remember a narrative sub-heading so the next table can cite it. A unit
      // hint line "(단위: 천원)" is not a caption.
      const t = text.trim();
      if (t.length >= 6 && !/^\(?\s*단위/.test(t)) ctx.lastCaption = t;
      const pBookmark = child.attrs["USERMARK"]?.trim() || undefined;
      if (text !== "" || pBookmark) {
        section.blocks.push({
          type: "paragraph",
          xmlPath: cPath,
          page: ctx.page,
          text,
          ...(pBookmark ? { bookmark: pBookmark } : {}),
        });
        if (pBookmark) ctx.stats.bookmarks++;
      }
      continue;
    }
    // INSERTION/LIBRARY/COMMENT and other wrappers: recurse for nested
    // tables/paragraphs but do not create a section for them.
    if (childElements(child).length > 0) {
      const nested = walkSection(child, kind, cPath, ctx);
      section.blocks.push(...nested.blocks);
      section.children.push(...nested.children);
      ctx.stats.sections--; // undo the count; this wasn't a real section
    }
  }

  return section;
}

/**
 * Parse contents.xml into a section/paragraph/table/cell tree with bookmarks,
 * page breaks, and span-preserving cells. Pure transform of the decoded XML (§19).
 */
export async function parseContents(open: DsdOpenResult): Promise<ParsedDocument> {
  return parseContentsSync(open);
}

/** Synchronous, pure core of parseContents (easier to unit-test). */
export function parseContentsSync(open: DsdOpenResult): ParsedDocument {
  const doc = parseXml(open.contentsXml);
  const header = firstDescendant(doc, "DOCUMENT-HEADER");
  const body = firstDescendant(doc, "BODY");
  if (!body) throw new Error("contents.xml: <BODY> not found");

  const extractions: Record<string, string> = {};
  const summary = header ? firstDescendant(header, "SUMMARY") : undefined;
  if (summary) {
    for (const ex of childElements(summary, "EXTRACTION")) {
      const code = ex.attrs["ACODE"];
      if (code) extractions[code] = textOf(ex).trim();
    }
  }

  const stats: ParsedStats = {
    sections: 0,
    tables: 0,
    rows: 0,
    cells: 0,
    emptyCells: 0,
    pageBreaks: 0,
    bookmarks: 0,
    numbers: 0,
  };
  const ctx: WalkCtx = { page: 1, stats, inheritedScale: 1, lastCaption: undefined };
  const root = walkSection(body, "BODY", "/DOCUMENT/BODY", ctx);

  // Meta from meta.xml (schema/docver) if available.
  let schema: string | undefined;
  let docVersion: string | undefined;
  if (open.metaXml) {
    try {
      const meta = parseXml(open.metaXml);
      schema = firstDescendant(meta, "GENERATOR")?.attrs["schema"];
      docVersion = firstDescendant(meta, "DOCUMENT-INFO")?.attrs["docver"];
    } catch {
      /* meta is optional; ignore parse issues */
    }
  }

  const docNameEl = header ? firstDescendant(header, "DOCUMENT-NAME") : undefined;
  const companyEl = header ? firstDescendant(header, "COMPANY-NAME") : undefined;
  const formulaEl = header ? firstDescendant(header, "FORMULA-VERSION") : undefined;

  return {
    parserVersion: PARSER_VERSION,
    dsdFileHash: open.dsdFileHash,
    ...(schema ? { schema } : {}),
    ...(docVersion ? { docVersion } : {}),
    ...(docNameEl ? { docName: textOf(docNameEl).trim() } : {}),
    ...(companyEl ? { company: textOf(companyEl).trim() } : {}),
    ...(formulaEl ? { formulaVersion: textOf(formulaEl).trim() } : {}),
    extractions,
    pageCount: stats.pageBreaks + 1,
    root,
    stats,
  };
}
