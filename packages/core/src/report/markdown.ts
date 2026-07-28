// Render a ReportDoc to GitHub-flavored Markdown. Pure, deterministic (§19).

import type { Block, ReportDoc } from "./types.js";

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderBlock(b: Block): string {
  switch (b.kind) {
    case "heading":
      return `${"#".repeat(b.level)} ${b.text}`;
    case "paragraph":
      return b.text;
    case "list":
      return b.items.map((i) => `- ${i}`).join("\n");
    case "divider":
      return "---";
    case "table": {
      const head = `| ${b.headers.map(escapeCell).join(" | ")} |`;
      const sep = `| ${b.headers.map(() => "---").join(" | ")} |`;
      const rows = b.rows.map((r) => `| ${r.map(escapeCell).join(" | ")} |`);
      return [head, sep, ...rows].join("\n");
    }
  }
}

export function renderMarkdown(doc: ReportDoc): string {
  return doc.blocks.map(renderBlock).join("\n\n") + "\n";
}
