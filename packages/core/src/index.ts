// @ari/core — deterministic core (parsing · AOM · review). No UI/network deps.
// See CLAUDE.md and 03/05/06 specs.

export * from "./aom/types.js";
export * from "./engine/types.js";
export * as mechanical from "./engine/mechanical.js";
export * as dsd from "./dsd/parser.js";
export * as aom from "./aom/builder.js";
export { validateAom, type ValidationIssue } from "./aom/schema.js";
export { runEngine, type EngineReport } from "./engine/run.js";
export { checkReferences } from "./engine/reference.js";
export { checkFsIntegrity } from "./engine/integrity.js";
export { checkRelational, checkCashFlow, checkCrossNoteDepreciation } from "./engine/relational.js";
export { RULES, severityFor } from "./engine/rules.js";
export * as report from "./report/index.js";
export * as insight from "./insight/index.js";
export * as brand from "./brand.js";

export const CORE_VERSION = "0.0.0";
