import { z } from "zod";

// ── SessionBudget ────────────────────────────────────────────────

/**
 * Session Budget Schema (SPEC Section 7.5)
 *
 * Configurable limits for an orchestrator session. The session
 * runner checks these after every proposal to decide whether to
 * continue or write a handoff log.
 */
export const SessionBudgetSchema = z.object({
  /** Maximum number of proposals to review in one session. */
  max_proposals: z.number().int().min(1).default(15),

  /** Maximum wall-clock duration in minutes. */
  max_duration_minutes: z.number().int().min(1).default(90),

  /**
   * Self-uncertainty threshold. If a proposal's target
   * uncertainty_level meets or exceeds this value the
   * orchestrator escalates rather than deciding.
   */
  self_uncertainty_threshold: z.number().int().min(1).default(2),
});

export type SessionBudget = z.infer<typeof SessionBudgetSchema>;

/** Default budget used when no override is supplied. */
export const DEFAULT_SESSION_BUDGET: SessionBudget = {
  max_proposals: 15,
  max_duration_minutes: 90,
  self_uncertainty_threshold: 2,
};

// ── OrchestratorSession ──────────────────────────────────────────

/**
 * Orchestrator Session Schema (SPEC Section 7)
 *
 * Tracks live session state. Created at session start and
 * updated after each proposal is processed. Serialised into
 * the session handoff log at session end.
 */
export const OrchestratorSessionSchema = z.object({
  /** Format: session_NNN (3-digit zero-padded). */
  session_id: z.string().regex(/^session_\d{3}$/),

  /** ISO 8601 timestamp when the session started. */
  session_start: z.string().datetime(),

  /** Running count of proposals reviewed this session. */
  proposals_reviewed: z.number().int().min(0),

  /** Per-agent circuit breaker trip counts. */
  circuit_breaker_counts: z.record(z.string(), z.number().int().min(0)),

  /** Running count of consecutive uncertain decisions. */
  consecutive_uncertain: z.number().int().min(0),

  /** Proposal IDs that were escalated. */
  escalations: z.array(z.string()),

  /** RFC IDs opened during this session. */
  rfcs_opened: z.array(z.string()),

  /** Proposal IDs for which the decision was uncertain. */
  uncertain_decisions: z.array(z.string()),

  /** Agent IDs whose circuit breaker tripped. */
  circuit_breakers_triggered: z.array(z.string()),

  /** Pattern keys flagged as recurring. */
  recurring_patterns_flagged: z.array(z.string()),
});

export type OrchestratorSession = z.infer<typeof OrchestratorSessionSchema>;
