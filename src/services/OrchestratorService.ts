import * as vscode from "vscode";
import type { SKLFileSystem } from "./SKLFileSystem.js";
import type {
  SessionBudget,
  OrchestratorSession,
  SessionLog,
  QueueProposal,
  HookConfig,
  KnowledgeFile,
  ScopeDefinition,
  ChangeType,
  VerifierResult,
  ProposalReviewResult,
} from "../types/index.js";
import { DEFAULT_SESSION_BUDGET } from "../types/index.js";
import { isUncertaintyLevel3 } from "./ConflictDetectionService.js";
import { applyStage1Overrides, needsVerifierPass } from "./ClassificationService.js";
import { writeRationale } from "./StateWriterService.js";
import { VerifierService } from "./VerifierService.js";

/**
 * Minimal interface for the LLM verifier pass — satisfied by VerifierService
 * and by plain mock objects in tests.
 */
export interface VerifierServiceLike {
  getFileDiff(filepath: string, branch: string, baseBranch: string): Promise<string>;
  runVerifierPass(
    proposal: QueueProposal,
    agentClassification: ChangeType,
    diff: string,
  ): Promise<VerifierResult>;
}

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
  private readonly verifierService: VerifierServiceLike;

  /** Most recent session log from the prior session, or null. */
  private priorSessionLog: SessionLog | null = null;

  constructor(
    sklFileSystem: SKLFileSystem,
    context: vscode.ExtensionContext,
    budget: SessionBudget = DEFAULT_SESSION_BUDGET,
    verifierService?: VerifierServiceLike,
  ) {
    this.sklFileSystem = sklFileSystem;
    this.extensionContext = context;
    this.budget = budget;
    this.verifierService = verifierService ?? new VerifierService({ appendLine: () => {} });
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

  /**
   * Review a single proposal and return the decision together with
   * updated session and knowledge state.
   *
   * The 8-step review order is mandatory (SPEC Section 7.2). Steps 5–8
   * are implemented in substage 3.8; this implementation covers 0–4.
   */
  async reviewProposal(
    proposal: QueueProposal,
    session: OrchestratorSession,
    knowledge: KnowledgeFile,
    scopeDefinitions: ScopeDefinition,
    hookConfig: HookConfig,
  ): Promise<{
    result: ProposalReviewResult;
    updatedKnowledge: KnowledgeFile;
    updatedSession: OrchestratorSession;
  }> {
    let currentProposal = proposal;
    let updatedSession = session;
    let updatedKnowledge = knowledge;

    // STEP 0 — Escalation pre-check
    if (isUncertaintyLevel3(currentProposal, knowledge.state)) {
      const rationaleText =
        `Proposal ${currentProposal.proposal_id} automatically escalated: target module ` +
        `${currentProposal.path} is at uncertainty_level 3 (Contested). Human must explicitly ` +
        `reduce uncertainty before this proposal can be reviewed.`;
      updatedKnowledge = writeRationale(
        currentProposal.proposal_id,
        "escalate",
        rationaleText,
        "architectural",
        knowledge,
      );
      updatedSession = {
        ...session,
        escalations: [
          ...session.escalations,
          `${currentProposal.proposal_id} escalated: uncertainty level 3 on ${currentProposal.path}`,
        ],
      };
      return {
        result: {
          proposal_id: currentProposal.proposal_id,
          decision: "escalate",
          rationale: rationaleText,
          rfc_id: null,
          state_updated: false,
          branch_merged: false,
          merge_conflict: false,
        },
        updatedKnowledge,
        updatedSession,
      };
    }

    // STEP 1 — Stage 1 deterministic classification overrides
    const stage1Result = applyStage1Overrides(currentProposal);
    currentProposal = {
      ...currentProposal,
      classification_verification: {
        ...currentProposal.classification_verification,
        stage1_override: stage1Result.stage1_override,
      },
    };

    // STEP 2 — Verifier pass (conditional)
    let verifierResult: VerifierResult | undefined;
    if (needsVerifierPass(currentProposal, stage1Result)) {
      const diff = await this.verifierService.getFileDiff(
        currentProposal.path,
        currentProposal.branch,
        hookConfig.base_branch,
      );
      verifierResult = await this.verifierService.runVerifierPass(
        currentProposal,
        stage1Result.resolved_change_type,
        diff,
      );
      currentProposal = {
        ...currentProposal,
        classification_verification: {
          ...currentProposal.classification_verification,
          agent_classification: currentProposal.change_type,
          verifier_classification: verifierResult.verifier_classification,
          agreement: verifierResult.agreement,
        },
      };
      if (!verifierResult.agreement) {
        updatedSession = this.recordClassificationDisagreement(
          updatedSession,
          currentProposal.agent_id,
        );
        if (this.isCircuitBreakerTriggered(updatedSession, currentProposal.agent_id, hookConfig)) {
          updatedSession = this.flagCircuitBreakerTriggered(
            updatedSession,
            currentProposal.agent_id,
            currentProposal.proposal_id,
          );
        }
      }
    }

    const resolvedClassification =
      verifierResult?.resolved_classification ?? stage1Result.resolved_change_type;

    // STEP 3 — Circuit breaker check
    const circuitBreakerActive = this.isCircuitBreakerTriggered(
      updatedSession,
      currentProposal.agent_id,
      hookConfig,
    );

    // STEP 4 — Dependency scan review
    const hasCrossScopeDeps: boolean =
      currentProposal.dependency_scan.cross_scope_undeclared.length > 0;

    // TODO: steps 5-8 implemented in next prompt
    void resolvedClassification;
    void circuitBreakerActive;
    void hasCrossScopeDeps;
    void scopeDefinitions;
    return {
      result: {
        proposal_id: currentProposal.proposal_id,
        decision: "approve",
        rationale: "TODO: decision logic (steps 5–8) not yet implemented",
        rfc_id: null,
        state_updated: false,
        branch_merged: false,
        merge_conflict: false,
      },
      updatedKnowledge,
      updatedSession,
    };
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
