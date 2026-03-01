// Barrel export for all SKL v1.4 types and schemas

// Shared enums, sub-schemas, and primitives
export {
  UncertaintyLevelSchema,
  UncertaintyLevel,
  ChangeTypeSchema,
  AssumptionSchema,
  ClassificationVerificationSchema,
  DependencyScanSchema,
} from "./shared.js";
export type {
  ChangeType,
  Assumption,
  ClassificationVerification,
  DependencyScan,
} from "./shared.js";

// RiskSignals (standalone — Section 5.1)
export {
  RiskSignalsSchema,
  AstChangeTypeSchema,
} from "./RiskSignals.js";
export type {
  RiskSignals,
  AstChangeType,
} from "./RiskSignals.js";

// StateRecord
export { StateRecordSchema } from "./StateRecord.js";
export type { StateRecord } from "./StateRecord.js";

// QueueProposal
export {
  QueueProposalSchema,
  ProposalStatusSchema,
  UncertaintyDeltaSchema,
} from "./QueueProposal.js";
export type {
  QueueProposal,
  ProposalStatus,
  UncertaintyDelta,
} from "./QueueProposal.js";

// ScopeDefinition
export {
  ScopeDefinitionSchema,
  ScopeEntrySchema,
} from "./ScopeDefinition.js";
export type {
  ScopeDefinition,
  ScopeEntry,
} from "./ScopeDefinition.js";

// KnowledgeFile
export {
  KnowledgeFileSchema,
  InvariantsSchema,
} from "./KnowledgeFile.js";
export type {
  KnowledgeFile,
  Invariants,
} from "./KnowledgeFile.js";

// RFC (Section 9.2)
export {
  RfcSchema,
  RfcOptionSchema,
  RfcStatusSchema,
} from "./RFC.js";
export type {
  Rfc,
  RfcOption,
  RfcStatus,
} from "./RFC.js";

// ADR (Section 9.5)
export { AdrSchema } from "./ADR.js";
export type { Adr } from "./ADR.js";

// SessionLog (Section 7.5.1)
export { SessionLogSchema } from "./SessionLog.js";
export type { SessionLog } from "./SessionLog.js";

// AgentContext
export { AgentContextSchema } from "./AgentContext.js";
export type { AgentContext } from "./AgentContext.js";

// HookConfig
export { HookConfigSchema, DEFAULT_HOOK_CONFIG } from "./HookConfig.js";
export type { HookConfig } from "./HookConfig.js";

// OrchestratorSession (Section 7)
export {
  SessionBudgetSchema,
  DEFAULT_SESSION_BUDGET,
  OrchestratorSessionSchema,
} from "./OrchestratorSession.js";
export type {
  SessionBudget,
  OrchestratorSession,
} from "./OrchestratorSession.js";

// ClassificationResult (Section 6.1)
import { z } from "zod";
import { ChangeTypeSchema } from "./shared.js";

export const ClassificationResultSchema = z.object({
  resolved_change_type: ChangeTypeSchema,
  stage1_override: z.boolean(),
  override_reason: z.string().nullable(),
});
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

// VerifierResult (Section 6.2)
export const VerifierResultSchema = z.object({
  verifier_classification: ChangeTypeSchema,
  justification: z.string(),
  agreement: z.boolean(),
  resolved_classification: ChangeTypeSchema,
});
export type VerifierResult = z.infer<typeof VerifierResultSchema>;
