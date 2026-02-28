import { z } from "zod";

/**
 * Uncertainty Levels (Section 3.2.3)
 *
 * 0 — Verified:  Passed a mechanically checkable acceptance criterion.
 * 1 — Reviewed:  Approved and in active human-reviewed digest without concerns.
 * 2 — Proposed:  Recently approved but not yet verified against any acceptance criterion.
 * 3 — Contested: Open assumption conflict, rejected RFC, or circuit-breaker trigger.
 */
export const UncertaintyLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type UncertaintyLevel = z.infer<typeof UncertaintyLevelSchema>;

/** Enum-style constants for convenience. */
export const UncertaintyLevel = {
  Verified: 0,
  Reviewed: 1,
  Proposed: 2,
  Contested: 3,
} as const;

/**
 * Change Type (Section 3.3.2)
 *
 * mechanical    — AST-identical to base; only whitespace/comments changed.
 * behavioral    — Function bodies change without signature changes.
 * architectural — Class or function signatures change; new dependencies introduced.
 */
export const ChangeTypeSchema = z.union([
  z.literal("mechanical"),
  z.literal("behavioral"),
  z.literal("architectural"),
]);
export type ChangeType = z.infer<typeof ChangeTypeSchema>;

/**
 * Assumption declared by an agent (Sections 3.2.1, 3.3.1, 8)
 */
export const AssumptionSchema = z.object({
  id: z.string(),
  text: z.string(),
  declared_by: z.string(),
  scope: z.string(),
  shared: z.boolean(),
});
export type Assumption = z.infer<typeof AssumptionSchema>;

/**
 * Risk Signals — re-exported from standalone RiskSignals.ts
 * (Section 5.1, Check 3)
 *
 * Note: ast_change_type uses "structural" (AST vocabulary), not
 * "architectural" (proposal-level vocabulary). See RiskSignals.ts.
 */
export {
  RiskSignalsSchema,
  AstChangeTypeSchema,
} from "./RiskSignals.js";
export type {
  RiskSignals,
  AstChangeType,
} from "./RiskSignals.js";

/**
 * Classification Verification (Section 6)
 */
export const ClassificationVerificationSchema = z.object({
  agent_classification: ChangeTypeSchema,
  verifier_classification: ChangeTypeSchema,
  agreement: z.boolean(),
  stage1_override: z.boolean(),
});
export type ClassificationVerification = z.infer<typeof ClassificationVerificationSchema>;

/**
 * Dependency Scan results (Section 5.1, Check 4)
 */
export const DependencyScanSchema = z.object({
  undeclared_imports: z.array(z.string()),
  stale_declared_deps: z.array(z.string()),
  cross_scope_undeclared: z.array(z.string()),
});
export type DependencyScan = z.infer<typeof DependencyScanSchema>;
