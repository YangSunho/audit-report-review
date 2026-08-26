// Audit Object Model — types. Source of truth: 05_Audit_Object_Model_Spec.md
// Rule: every object carries `source` (§20). Money is integer KRW (§19).

import type { FiscalPeriod } from "./period.js";
export type { FiscalPeriod, TermPeriod } from "./period.js";

export type Confidence = "high" | "medium" | "low" | "unresolved";
export type Statement = "BS" | "IS" | "CF" | "SCE" | "NOTE";

/** §20 Traceability — mandatory on every AOM object. */
export interface SourceRef {
  dsdFileHash: string; // sha256 of original .dsd (§7 immutability proof)
  xmlPath: string; // e.g. "/contents/section[3]/table[2]"
  blockId?: string;
  bookmark?: string;
  page?: number;
}

export interface Provenance {
  extractedBy: string; // e.g. "ObjectBuilder@v0.9"
  semanticBy?: string; // "rule:kb.ppe" | "ai-assist:false"
  confidence: Confidence;
}

/** Money normalized to integer KRW. Never use float (§19). */
export interface NormalizedNumber {
  raw: string;
  value: number; // integer, won units
  unit: "KRW";
  scale: number; // original display scale: 1 | 1000 | 1_000_000
  sign: "positive" | "negative" | "zero";
  display: string;
}

export interface AomBase {
  id: string;
  objectType: string;
  schemaVersion: string; // "1.0"
  source: SourceRef;
  provenance: Provenance;
}

export type TableType =
  | "RollForward"
  | "Breakdown"
  | "Maturity"
  | "Reconciliation"
  | "Other";

export interface TableCell {
  row: number;
  col: number;
  rowSpan?: number;
  colSpan?: number;
  empty?: boolean;
  number?: NormalizedNumber;
  text?: string;
}

export interface TableRow {
  label: string;
  cells: TableCell[];
}

export interface FinancialStatementTable extends AomBase {
  objectType: "FinancialStatementTable";
  statement: Statement;
  note?: string;
  account?: string;
  /** Sub-heading that introduces this table (e.g. "22.3 …변동내역…"), so an
   *  issue can cite the exact table within a multi-table note. */
  caption?: string;
  tableType: TableType;
  period: { current: string; prior?: string };
  columns: string[];
  rows: TableRow[];
}

export interface FinancialStatementLine extends AomBase {
  objectType: "FinancialStatementLine";
  statement: Statement;
  account: string;
  noteRef: string[];
  amount: { current: NormalizedNumber; prior?: NormalizedNumber };
  parent?: string;
}

export type ReferenceKind = "note" | "table" | "figure";
export type ReferenceStatus = "resolved" | "unresolved" | "mismatch";

export interface Reference extends AomBase {
  objectType: "Reference";
  refKind: ReferenceKind;
  from: string; // aom id
  toLabel: string; // "주석11"
  toResolved?: string; // aom id when resolved
  status: ReferenceStatus;
  suggestedFix?: { from: string; to: string } | null;
}

export interface NarrativeNumber extends AomBase {
  objectType: "NarrativeNumber";
  note?: string;
  context: string;
  value: NormalizedNumber;
  linksTo: string[]; // table object ids to reconcile against
}

export type RelationKind =
  | "note_of"
  | "rolls_forward_to"
  | "depreciation_flows_to"
  | "references"
  | "reconciles_with"
  | "same_account_as"
  | "tax_effect_of";

export interface RelationshipEdge extends AomBase {
  objectType: "RelationshipEdge";
  from: string;
  to: string;
  relation: RelationKind;
  basis: string;
}

export type CheckStatus = "match" | "mismatch" | "review" | "skipped";

/** Produced by the deterministic engine (06). AI never writes this (§6). */
export interface ReviewResult extends Pick<AomBase, "id" | "objectType"> {
  objectType: "ReviewResult";
  check: string; // "TieOut" | "Footing" | ...
  targets: string[]; // aom ids
  expected?: number;
  actual?: number;
  status: CheckStatus;
  toleranceApplied: number; // won
  engineVersion: string; // §19
  sourceRefs: string[];
  note?: string; // reason when skipped/review
  /**
   * 보고서의 "항목" 열에 쓸 이름. 검증 대상이 AOM 객체 하나로 특정되지 않을 때
   * 쓴다 — 자본변동표는 표 하나 안에서 열마다 다른 항목을 대사하므로, 대상 id 로는
   * 모든 행이 "SCE 표"로만 표시되어 무엇을 검증했는지 알 수 없다.
   */
  subject?: string;
}

export type Severity = "error" | "review" | "info";

export interface Issue extends Pick<AomBase, "id" | "objectType"> {
  objectType: "Issue";
  severity: Severity;
  title: string;
  evidence: string[]; // aom ids
  reviewResults: string[];
  aiNote?: string | null; // filled only by Doc 07 layer, with evidence
  drilldown: string[]; // Issue -> Cell -> Formula -> source path
}

// ── Container objects (Doc 05 §2 registry: Document / Section / NoteBlock) ─────

export type SectionKind = "COVER" | "TOC" | "SECTION-1" | "SECTION-2" | "BODY";

/** DSD root. One Document per .dsd (Doc 05 §2). */
export interface AomDocument extends AomBase {
  objectType: "Document";
  docName?: string; // 감사보고서
  company?: string; // 표본 A
  schema?: string; // dart4.xsd
  docVersion?: string; // 6.0
  extractions: Record<string, string>; // SUMMARY EXTRACTION anchors (§ FS Integrity seed)
  pageCount: number;
  sectionIds: string[];
  /** 기수·회계기간·결산일 (제32기 · 2025.01.01~2025.12.31 · 결산일 2025.12.31). */
  fiscal?: FiscalPeriod;
}

/** Structural division: 표지/목차/감사보고서/BS/IS/CF/SCE/주석 등 (Doc 05 §2). */
export interface Section extends AomBase {
  objectType: "Section";
  kind: SectionKind;
  title?: string;
  statement?: Statement; // set when the section is a primary FS or note context
  parentId?: string;
  childIds: string[];
  tableIds: string[];
}

/** 주석 단위 블록 (Doc 05 §2). */
export interface NoteBlock extends AomBase {
  objectType: "NoteBlock";
  noteNo: string; // "11"
  title: string; // "재고자산"
  tableIds: string[];
}

export type AomObject =
  | AomDocument
  | Section
  | NoteBlock
  | FinancialStatementTable
  | FinancialStatementLine
  | Reference
  | NarrativeNumber
  | RelationshipEdge;
