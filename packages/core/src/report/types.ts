// Audit Report document model (MVP ⑫, Doc 04 §8 SC-06). A presentation-neutral
// block tree rendered to Markdown or DOCX. Pure & deterministic (§19).

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "divider" };

export interface ReportDoc {
  title: string;
  blocks: Block[];
}

export const REPORT_VERSION = "0.1.0";
