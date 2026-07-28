// Audit report layer (MVP ⑫). Pure, deterministic render of engine results.
export { buildAuditReport } from "./build.js";
export { renderMarkdown } from "./markdown.js";
export { renderDocx } from "./docx.js";
export { renderXlsx, buildAuditWorkbook, type Workbook, type Sheet } from "./xlsx.js";
export { renderHtmlDashboard } from "./html.js";
export { assessParseHealth, type ParseHealth, type HealthLevel } from "./health.js";
export { REPORT_VERSION, type ReportDoc, type Block } from "./types.js";
