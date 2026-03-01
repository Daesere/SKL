import { z } from "zod";
import {
  AssumptionSchema,
  ChangeTypeSchema,
  ClassificationVerificationSchema,
  DependencyScanSchema,
  RiskSignalsSchema,
} from "./shared.js";

/**
 * Orchestrator-recorded decision rationale (Section 7.4).
 * Inline here (not imported from index.ts) to avoid circular dependency.
 */
export const RationaleRecordSchema = z.object({
  decision_type: z.enum(["implementation", "architectural"]),
  text: z.string().min(1),
  recorded_at: z.string().datetime(),
});
export type RationaleRecord = z.infer<typeof RationaleRecordSchema>;

/**
 * Queue Proposal Status
 */
export const ProposalStatusSchema = z.union([
  z.literal("pending"),
  z.literal("approved"),
  z.literal("rejected"),
  z.literal("escalated"),
  z.literal("rfc"),
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/**
 * Uncertainty Delta — indicates the change in uncertainty level.
 * Per the spec example: "+1", "-1", "+0", etc.
 */
export const UncertaintyDeltaSchema = z.string().regex(
  /^[+-]\d+$/,
  "Must be a signed integer string, e.g. '+1', '-1', '+0'",
);
export type UncertaintyDelta = z.infer<typeof UncertaintyDeltaSchema>;

/**
 * Queue Proposal Schema (Section 3.3.1)
 *
 * Pending proposals submitted by agents.
 * Each proposal is populated partly by the agent and partly by the enforcement hook.
 */
export const QueueProposalSchema = z.object({
  /** Unique proposal identifier. */
  proposal_id: z.string(),

  /** Identifier of the submitting agent. */
  agent_id: z.string(),

  /** Relative file path from repo root. */
  path: z.string(),

  /** Must match a key in scope_definitions.json. */
  semantic_scope: z.string(),

  /** Scope definition version used at submission. */
  scope_schema_version: z.string(),

  /** Agent-submitted change type (advisory; may be overridden by Stage 1). */
  change_type: ChangeTypeSchema,

  /** Plain-language description of the file's responsibility after this change. */
  responsibilities: z.string(),

  /** Direct dependencies after this change. */
  dependencies: z.array(z.string()),

  /** Invariant keys touched by this change. */
  invariants_touched: z.array(z.string()),

  /** Assumptions declared by the agent for this change. */
  assumptions: z.array(AssumptionSchema),

  /** Signed integer indicating expected uncertainty shift. */
  uncertainty_delta: UncertaintyDeltaSchema,

  /** Agent's rationale for the change. */
  rationale: z.string(),

  /** Whether the file was outside the agent's assigned file scope. */
  out_of_scope: z.boolean(),

  /** Whether the change crosses a semantic scope boundary. */
  cross_scope_flag: z.boolean(),

  /** Git branch name for this proposal. */
  branch: z.string(),

  /** AST-derived risk signals (populated by enforcement hook Check 3). */
  risk_signals: RiskSignalsSchema,

  /** Two-stage classification verification results (Section 6). */
  classification_verification: ClassificationVerificationSchema,

  /** Import scan results (populated by enforcement hook Check 4). */
  dependency_scan: DependencyScanSchema,

  /** Agent's reasoning summary (optional promotion from scratchpad). */
  agent_reasoning_summary: z.string(),

  /** Current status of the proposal. */
  status: ProposalStatusSchema,

  /** ISO 8601 datetime when the proposal was submitted. */
  submitted_at: z.string().datetime(),

  /**
   * Orchestrator-recorded decision rationale (Section 7.4).
   * Named `decision_rationale` to avoid conflict with the agent-submitted
   * `rationale: string` field above. Populated by writeRationale().
   */
  decision_rationale: RationaleRecordSchema.optional(),
});

export type QueueProposal = z.infer<typeof QueueProposalSchema>;
