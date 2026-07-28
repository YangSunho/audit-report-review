// AI Insight layer (Doc 07). Default = offline grounded, deterministic (§18/§19).
export type {
  Insight,
  InsightEvidence,
  InsightProvider,
  InsightContext,
  InsightConfidence,
  InsightPolicy,
} from "./types.js";
export { DEFAULT_POLICY } from "./types.js";
export { OfflineGroundedProvider } from "./offline.js";
export { validateInsight, type GuardrailResult } from "./guardrails.js";
export {
  generateInsights,
  selectInsightProvider,
  OFFLINE_PROVIDER,
  type InsightInput,
  type InsightOptions,
} from "./generate.js";
export {
  toEvidenceBundle,
  llmAvailable,
  type AsyncInsightProvider,
  type LlmConfig,
} from "./llm.js";
