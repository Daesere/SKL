import * as vscode from "vscode";
import type { SKLFileSystem } from "./SKLFileSystem.js";
import type {
  SessionBudget,
  OrchestratorSession,
  SessionLog,
  QueueProposal,
  HookConfig,
} from "../types/index.js";
import { DEFAULT_SESSION_BUDGET } from "../types/index.js";

/**
 * Orchestrator Service (SPEC Section 7)
 *
 * Manages the lifecycle of an orchestrator session: initialisation,
 * budget tracking, proposal review, and handoff log writing.
 *
 * Initialises from current knowledge.json plus the most recent
 * session log only — prior history is not loaded to prevent context
 * accumulation (spec Section 7.5).
 */
export class OrchestratorService {
  private readonly sklFileSystem: SKLFileSystem;
  private readonly extensionContext: vscode.ExtensionContext;
  private readonly budget: SessionBudget;

  /** Most recent session log from the prior session, or null. */
  private priorSessionLog: SessionLog | null = null;

  constructor(
    sklFileSystem: SKLFileSystem,
    context: vscode.ExtensionContext,
    budget: SessionBudget = DEFAULT_SESSION_BUDGET,
  ) {
    this.sklFileSystem = sklFileSystem;
    this.extensionContext = context;
    this.budget = budget;
  }

  // ── Session lifecycle ────────────────────────────────────────────

  /**
   * Start a new orchestrator session.
   *
   * Loads the most recent session log (if any) as the sole prior
   * context, then returns a fresh OrchestratorSession with all
   * counters at zero.
   */
  async initialize(): Promise<OrchestratorSession> {
    const sessionId = await this.sklFileSystem.getNextSessionId();
    this.priorSessionLog =
      await this.sklFileSystem.readMostRecentSessionLog();

    return {
      session_id: sessionId,
      session_start: new Date().toISOString(),
      proposals_reviewed: 0,
      circuit_breaker_counts: {},
      consecutive_uncertain: 0,
      escalations: [],
      rfcs_opened: [],
      uncertain_decisions: [],
      circuit_breakers_triggered: [],
      recurring_patterns_flagged: [],
    };
  }

  /**
   * Check whether the session should stop processing proposals.
   *
   * Returns `true` when any of the three budget limits are hit:
   *  - Proposal count reaches `max_proposals`
   *  - Wall-clock time reaches `max_duration_minutes`
   *  - Consecutive uncertain decisions reach `self_uncertainty_threshold`
   */
  isSessionBudgetExceeded(session: OrchestratorSession): boolean {
    if (session.proposals_reviewed >= this.budget.max_proposals) {
      return true;
    }

    const elapsedMs =
      Date.now() - new Date(session.session_start).getTime();
    const elapsedMinutes = elapsedMs / 60_000;
    if (elapsedMinutes >= this.budget.max_duration_minutes) {
      return true;
    }

    if (
      session.consecutive_uncertain >=
      this.budget.self_uncertainty_threshold
    ) {
      return true;
    }

    return false;
  }

  /**
   * Human-readable budget status string for display in panels.
   */
  getBudgetStatus(session: OrchestratorSession): string {
    const elapsedMinutes = Math.floor(
      (Date.now() - new Date(session.session_start).getTime()) / 60_000,
    );

    return (
      `Session ${session.session_id}: ` +
      `${session.proposals_reviewed}/${this.budget.max_proposals} proposals, ` +
      `${elapsedMinutes}m/${this.budget.max_duration_minutes}m`
    );
  }

  /**
   * End the current session by writing a handoff log.
   */
  async endSession(session: OrchestratorSession): Promise<void> {
    const log: SessionLog = {
      session_id: session.session_id,
      proposals_reviewed: session.proposals_reviewed,
      session_start: session.session_start,
      session_end: new Date().toISOString(),
      recurring_patterns_flagged: session.recurring_patterns_flagged,
      escalations: session.escalations,
      rfcs_opened: session.rfcs_opened,
      uncertain_decisions: session.uncertain_decisions,
      circuit_breakers_triggered: session.circuit_breakers_triggered,
    };

    await this.sklFileSystem.writeSessionLog(log);
  }

  // ── Read-only accessors ──────────────────────────────────────────

  /** The prior session log loaded during initialize(), or null. */
  getPriorSessionLog(): SessionLog | null {
    return this.priorSessionLog;
  }

  // ── Circuit breaker (Section 6.3) ────────────────────────────────

  /**
   * Record a classification disagreement for an agent.
   *
   * Returns a **new** session object — does not mutate the input.
   */
  recordClassificationDisagreement(
    session: OrchestratorSession,
    agentId: string,
  ): OrchestratorSession {
    const currentCount = session.circuit_breaker_counts[agentId] ?? 0;
    return {
      ...session,
      circuit_breaker_counts: {
        ...session.circuit_breaker_counts,
        [agentId]: currentCount + 1,
      },
    };
  }

  /**
   * Check whether the circuit breaker has been triggered for an agent.
   *
   * Takes HookConfig as a parameter to stay pure — no I/O.
   */
  isCircuitBreakerTriggered(
    session: OrchestratorSession,
    agentId: string,
    config: HookConfig,
  ): boolean {
    return (
      (session.circuit_breaker_counts[agentId] ?? 0) >=
      config.circuit_breaker_threshold
    );
  }

  /**
   * Append a circuit breaker triggered message for an agent.
   *
   * Returns a **new** session object. Does not duplicate entries
   * for the same agent within a session.
   */
  flagCircuitBreakerTriggered(
    session: OrchestratorSession,
    agentId: string,
    proposalId: string,
  ): OrchestratorSession {
    const alreadyFlagged = session.circuit_breakers_triggered.some(
      (entry) => entry.startsWith(`${agentId} circuit breaker`),
    );
    if (alreadyFlagged) {
      return session;
    }
    return {
      ...session,
      circuit_breakers_triggered: [
        ...session.circuit_breakers_triggered,
        `${agentId} circuit breaker triggered at ${proposalId}`,
      ],
    };
  }

  // ── Stubs — implemented in later substages ───────────────────────

  /* eslint-disable @typescript-eslint/no-unused-vars */

  // TODO: implemented in substage 3.7
  async reviewProposal(
    _session: OrchestratorSession,
    _proposal: QueueProposal,
  ): Promise<{ decision: string; rationale: string }> {
    throw new Error("Not implemented — substage 3.7");
  }

  // TODO: implemented in substage 3.8
  async runSession(_session: OrchestratorSession): Promise<void> {
    throw new Error("Not implemented — substage 3.8");
  }

  // TODO: implemented in substage 3.8
  async runTaskAssignment(
    _session: OrchestratorSession,
  ): Promise<string> {
    throw new Error("Not implemented — substage 3.8");
  }

  // TODO: implemented in substage 3.7
  async mergeBranch(
    _branchName: string,
  ): Promise<{ success: boolean; merge_conflict: boolean }> {
    throw new Error("Not implemented — substage 3.7");
  }

  // TODO: implemented in substage 3.7
  async generateDecisionRationale(
    _proposal: QueueProposal,
    _decision: string,
  ): Promise<string> {
    throw new Error("Not implemented — substage 3.7");
  }

  /* eslint-enable @typescript-eslint/no-unused-vars */
}
