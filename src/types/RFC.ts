import { z } from "zod";

/**
 * RFC Option — a proposed resolution path (Section 9.2)
 */
export const RfcOptionSchema = z.object({
  /** Description of the proposed approach. */
  description: z.string(),

  /** Expected consequences if this option is chosen. */
  consequences: z.string(),
});
export type RfcOption = z.infer<typeof RfcOptionSchema>;

/**
 * RFC Status
 */
export const RfcStatusSchema = z.union([
  z.literal("open"),
  z.literal("resolved"),
  z.literal("rejected"),
]);
export type RfcStatus = z.infer<typeof RfcStatusSchema>;

/**
 * Draft acceptance criterion — Orchestrator-generated, human-editable.
 * status is always "pending" when created; validated as a literal.
 */
export const DraftAcceptanceCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  check_type: z.string(),
  check_reference: z.string(),
  rationale: z.string(),
  status: z.literal("pending"),
});
export type DraftAcceptanceCriterion = z.infer<typeof DraftAcceptanceCriterionSchema>;

/**
 * Per-option effort/risk/alignment ranking produced by the Orchestrator.
 */
export const OptionRankingSchema = z.object({
  option: z.enum(["option_a", "option_b", "option_c"]),
  effort_score: z.number().min(0).max(10),
  risk_score: z.number().min(0).max(10),
  invariant_alignment_score: z.number().min(0).max(10),
  composite_score: z.number(),
  recommended: z.boolean(),
  ranking_rationale: z.string(),
});
export type OptionRanking = z.infer<typeof OptionRankingSchema>;

/**
 * RFC Schema (Section 9.2)
 *
 * Architectural decisions require human pre-clearance before the implementing
 * branch is merged. An RFC captures the decision context, options, and
 * resolution including mechanically checkable acceptance criteria.
 */
export const RfcSchema = z.object({
  /** Unique RFC identifier. */
  id: z.string(),

  /** Current status of the RFC. */
  status: RfcStatusSchema,

  /** ISO 8601 datetime when the RFC was created. */
  created_at: z.string().datetime(),

  /** Proposal ID that triggered this RFC. */
  triggering_proposal: z.string(),

  /** The architectural question requiring a human decision. */
  decision_required: z.string(),

  /** Background context for the decision. */
  context: z.string(),

  /** First resolution option. */
  option_a: RfcOptionSchema,

  /** Second resolution option. */
  option_b: RfcOptionSchema,

  /** Optional third resolution option. */
  option_c: RfcOptionSchema.optional(),

  /** Orchestrator's recommended option key (e.g. "option_b"). */
  orchestrator_recommendation: z.string().optional(),

  /** Orchestrator's written rationale for the recommendation. */
  orchestrator_rationale: z.string().optional(),

  /** Chosen resolution option key (populated on resolution). */
  resolution: z.string().optional(),

  /** Human operator's rationale for the resolution. */
  human_rationale: z.string().optional(),

  /** Optional list of acceptance criteria descriptions (Section 9.3). */
  acceptance_criteria: z.array(z.string()).optional(),

  /** Hard merge gate — branch cannot merge until all criteria pass. */
  merge_blocked_until_criteria_pass: z.boolean().optional(),

  /** ISO 8601 deadline for human response (default: 24h from creation). */
  human_response_deadline: z.string().datetime().optional(),

  /** ADR ID if the resolution was promoted to an Architecture Decision Record. */
  promoted_to_adr: z.string().optional(),

  /** Orchestrator-drafted acceptance criteria (optional, read-only to human). */
  draft_acceptance_criteria: z.array(DraftAcceptanceCriterionSchema).optional(),

  /** Per-option effort/risk/alignment scores from the Orchestrator (optional). */
  option_rankings: z.array(OptionRankingSchema).optional(),

  /** First-person rationale draft for the human operator (optional). */
  recommended_human_rationale: z.string().optional(),
});

export type Rfc = z.infer<typeof RfcSchema>;
