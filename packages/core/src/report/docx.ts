// Render a ReportDoc to a minimal, valid .docx (OOXML). Pure & deterministic:
// fixed timestamps and store-method zip → identical bytes for identical input (§19).
// Zero external deps (consistent with @ari/core). Not a full Word writer — supports
// headings, paragraphs, bullet lists and tables, which is all the report needs.

import type { Block, ReportDoc } from "./types.js";
import { enc, xmlEscape, zipStore } from "./ooxml.js";

// ── OOXML body ───────────────────────────────────────────────────────────────

function run(text: string, opts: { bold?: boolean; size?: number } = {}): string {
  const rpr =
    opts.bold || opts.size
      ? `<w:rPr>${opts.bold ? "<w:b/>" : ""}${opts.size ? `<w:sz w:val="${opts.size}"/>` : ""}</w:rPr>`
      : "";
  return `<w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function para(inner: string): string {
  return `<w:p>${inner}</w:p>`;
}

function tableXml(headers: string[], rows: string[][]): string {
  const border =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`)
      .join('') +
    '</w:tblBorders>';
  const tblPr = `<w:tblPr><w:tblW w:w="0" w:type="auto"/>${border}</w:tblPr>`;
  const cell = (text: string, bold: boolean): string =>
    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(run(text, { bold }))}</w:tc>`;
  const tr = (cells: string[], bold: boolean): string =>
    `<w:tr>${cells.map((c) => cell(c, bold)).join("")}</w:tr>`;
  return `<w:tbl>${tblPr}${tr(headers, true)}${rows.map((r) => tr(r, false)).join("")}</w:tbl>`;
}

function blockXml(b: Block): string {
  switch (b.kind) {
    case "heading": {
      const size = b.level === 1 ? 36 : b.level === 2 ? 30 : 26; // half-points
      return para(run(b.text, { bold: true, size }));
    }
    case "paragraph":
      return para(run(b.text));
    case "list":
      return b.items.map((i) => para(run("• " + i))).join("");
    case "divider":
      return para("");
    case "table":
      return tableXml(b.headers, b.rows);
  }
}

function documentXml(doc: ReportDoc): string {
  const body = doc.blocks.map(blockXml).join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>` +
    "</w:document>"
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

const RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

export function renderDocx(doc: ReportDoc): Uint8Array {
  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: enc.encode(RELS) },
    { name: "word/document.xml", data: enc.encode(documentXml(doc)) },
  ]);
}
