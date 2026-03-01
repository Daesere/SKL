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
  DecisionType,
  ClassificationResult,
  StateConflictResult,
  RFCTriggerReason,
} from "../types/index.js";
import { DEFAULT_SESSION_BUDGET } from "../types/index.js";
import {
  isUncertaintyLevel3,
  detectStateConflict,
  detectAssumptionConflict,
} from "./ConflictDetectionService.js";
import {
  applyStage1Overrides,
  needsVerifierPass,
  isEligibleForAutoApproval,
} from "./ClassificationService.js";
import {
  writeRationale,
  createStateEntry,
  updateStateEntry,
  deriveStateId,
} from "./StateWriterService.js";
import { detectRFCTrigger, generateRFC } from "./RFCService.js";
import { VerifierService } from "./VerifierService.js";
import type { OutputChannelLike } from "./VerifierService.js";

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
  private readonly outputChannel: OutputChannelLike;

  /** Most recent session log from the prior session, or null. */
  private priorSessionLog: SessionLog | null = null;

  constructor(
    sklFileSystem: SKLFileSystem,
    context: vscode.ExtensionContext,
    budget: SessionBudget = DEFAULT_SESSION_BUDGET,
    verifierService?: VerifierServiceLike,
    outputChannel?: OutputChannelLike,
  ) {
    this.sklFileSystem = sklFileSystem;
    this.extensionContext = context;
    this.budget = budget;
    this.verifierService = verifierService ?? new VerifierService({ appendLine: () => {} });
    this.outputChannel = outputChannel ?? { appendLine: () => {} };
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

    // STEP 5 — Assumption conflict detection
    const otherPending = updatedKnowledge.queue.filter(
      (p) => p.status === "pending" && p.proposal_id !== currentProposal.proposal_id,
    );
    const assumptionConflict = await detectAssumptionConflict(
      currentProposal,
      otherPending,
      this.outputChannel,
    );

    // STEP 6 — State conflict detection
    const stateConflict = detectStateConflict(currentProposal, updatedKnowledge.state);

    // STEP 7 — RFC trigger detection
    const proposalWithResolvedType: QueueProposal = {
      ...currentProposal,
      change_type: resolvedClassification,
    };
    const rfcTrigger = detectRFCTrigger(
      proposalWithResolvedType,
      updatedKnowledge,
      assumptionConflict,
    );
    if (rfcTrigger !== null) {
      const rfc = await generateRFC(
        proposalWithResolvedType,
        rfcTrigger,
        assumptionConflict,
        updatedKnowledge,
        this.sklFileSystem,
      );
      updatedSession = {
        ...updatedSession,
        rfcs_opened: [...updatedSession.rfcs_opened, rfc.id],
      };
      const rfcRationaleText = await this.generateDecisionRationale(
        currentProposal,
        "rfc",
        stage1Result,
        stateConflict,
        rfcTrigger,
        circuitBreakerActive,
        hasCrossScopeDeps,
        resolvedClassification,
      );
      updatedKnowledge = writeRationale(
        currentProposal.proposal_id,
        "rfc",
        rfcRationaleText,
        "architectural",
        updatedKnowledge,
      );
      return {
        result: {
          proposal_id: currentProposal.proposal_id,
          decision: "rfc",
          rationale: rfcRationaleText,
          rfc_id: rfc.id,
          state_updated: false,
          branch_merged: false,
          merge_conflict: false,
        },
        updatedKnowledge,
        updatedSession,
      };
    }

    // STEP 8 — Final decision
    let decision: DecisionType;
    if (stateConflict.has_conflict) {
      decision = "reject";
    } else if (
      isEligibleForAutoApproval(currentProposal, stage1Result) &&
      !assumptionConflict.has_conflict &&
      !hasCrossScopeDeps &&
      !circuitBreakerActive
    ) {
      decision = "auto_approve";
    } else {
      decision = "approve";
    }

    // decisionType: "architectural" when architectural classification; RFC/escalate already
    // returned early, so their conditions are provably false at this point.
    const decisionType: "implementation" | "architectural" =
      resolvedClassification === "architectural" ? "architectural" : "implementation";

    const rationaleText = await this.generateDecisionRationale(
      currentProposal,
      decision,
      stage1Result,
      stateConflict,
      rfcTrigger,
      circuitBreakerActive,
      hasCrossScopeDeps,
      resolvedClassification,
    );

    updatedKnowledge = writeRationale(
      currentProposal.proposal_id,
      decision,
      rationaleText,
      decisionType,
      updatedKnowledge,
    );

    let stateUpdated = false;
    if (decision === "approve" || decision === "auto_approve") {
      const stateId = deriveStateId(currentProposal.path);
      const existingRecord = updatedKnowledge.state.find((r) => r.id === stateId);
      if (existingRecord !== undefined) {
        updatedKnowledge = updateStateEntry(
          currentProposal,
          existingRecord,
          scopeDefinitions,
          updatedKnowledge,
        );
      } else {
        updatedKnowledge = createStateEntry(
          currentProposal,
          scopeDefinitions,
          updatedKnowledge,
        );
      }
      stateUpdated = true;
    }

    return {
      result: {
        proposal_id: currentProposal.proposal_id,
        decision,
        rationale: rationaleText,
        rfc_id: null,
        state_updated: stateUpdated,
        branch_merged: false,
        merge_conflict: false,
      },
      updatedKnowledge,
      updatedSession,
    };
  }

  // ── generateDecisionRationale — Section 7.3 rationale generation ————————

  /**
   * Generate a human-readable rationale paragraph for the decision.
   *
   * auto_approve: immediate template (no LLM call).
   * All other decisions: LLM call via vscode.lm.selectChatModels.
   * LLM unavailable: template fallback — does not throw.
   */
  private async generateDecisionRationale(
    proposal: QueueProposal,
    decision: DecisionType,
    stage1Result: ClassificationResult,
    stateConflict: StateConflictResult,
    rfcTrigger: RFCTriggerReason | null,
    circuitBreakerActive: boolean,
    hasCrossScopeDeps: boolean,
    resolvedClassification: ChangeType,
  ): Promise<string> {
    if (decision === "auto_approve") {
      return (
        "Auto-approved: AST confirms mechanical-only change with no risk signals, " +
        "no assumption conflicts, and no cross-scope dependencies."
      );
    }

    const fallback =
      `${decision} decision for ${proposal.proposal_id}. ` +
      `Classification: ${resolvedClassification}` +
      `${
        stage1Result.stage1_override
          ? ` (overridden from ${proposal.change_type})`
          : ""
      }` +
      ". LLM unavailable for detailed rationale.";

    const models = await vscode.lm.selectChatModels({ family: "gpt-4o" });
    if (models.length === 0) {
      return fallback;
    }

    const model = models[0];

    const riskSignalParts: string[] = [];
    if (proposal.risk_signals.touched_auth_or_permission_patterns) {
      riskSignalParts.push("touched_auth_or_permission_patterns");
    }
    if (proposal.risk_signals.public_api_signature_changed) {
      riskSignalParts.push("public_api_signature_changed");
    }
    if (proposal.risk_signals.invariant_referenced_file_modified) {
      riskSignalParts.push("invariant_referenced_file_modified");
    }
    if (proposal.risk_signals.high_fan_in_module_modified) {
      riskSignalParts.push("high_fan_in_module_modified");
    }

    const classificationNote = stage1Result.stage1_override
      ? `Stage 1 overrode agent classification from ${proposal.change_type} to ` +
        `${resolvedClassification} (reason: ${stage1Result.override_reason ?? "none"}).`
      : `Classification: ${resolvedClassification} (agreed with agent).`;

    const contextParts: string[] = [
      `Decision: ${decision.toUpperCase()} for proposal ${proposal.proposal_id} on ${proposal.path}.`,
      classificationNote,
      riskSignalParts.length > 0
        ? `Active risk signals: ${riskSignalParts.join(", ")}.`
        : "No active risk signals.",
    ];

    if (circuitBreakerActive) {
      contextParts.push(`Circuit breaker is ACTIVE for agent ${proposal.agent_id}.`);
    }
    if (hasCrossScopeDeps) {
      contextParts.push("Cross-scope undeclared dependencies detected.");
    }
    if (decision === "reject" && stateConflict.conflicting_record !== null) {
      contextParts.push(
        `The conflicting State record is ${stateConflict.conflicting_record.id} ` +
          `owned by ${stateConflict.conflicting_record.owner}. ` +
          `The proposing agent must coordinate with the owning agent and ` +
          `re-scope the change before resubmitting.`,
      );
    }
    if (decision === "rfc" && rfcTrigger !== null) {
      contextParts.push(
        `RFC trigger: ${rfcTrigger}. An RFC has been opened requiring a human ` +
          `architectural decision before this proposal can proceed.`,
      );
    }

    const prompt = [
      contextParts.join(" "),
      "",
      "Write one paragraph of plain text (no JSON, no markdown) explaining this decision to the proposing agent.",
    ].join("\n");

    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
      );
      let text = "";
      for await (const chunk of response.text) {
        text += chunk;
      }
      return text.trim() || fallback;
    } catch {
      return fallback;
    }
  }

  // ── Stubs — implemented in later substages ─────────────────────────────────────────────

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
}
