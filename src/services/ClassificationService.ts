/**
 * ClassificationService — Stage 1 Deterministic Overrides (Section 6.1)
 *
 * Pure functions only, no class. Applies deterministic rules to
 * reclassify proposals before any LLM-based Stage 2 verification.
 * Rules fire in order and short-circuit on first match.
 */

import type { QueueProposal, ClassificationResult } from "../types/index.js";

/**
 * Apply Stage 1 deterministic override rules to a proposal.
 *
 * Rules (evaluated in order, first match wins):
 *   1. mechanical_only === true  → mechanical (absolute precedence)
 *   2. Agent said "mechanical" but risk signals present → behavioral
 *   3. Agent said "mechanical" but cross_scope_flag → behavioral
 *   4. Default: trust the agent-submitted change_type
 */
export function applyStage1Overrides(proposal: QueueProposal): ClassificationResult {
  const { risk_signals, cross_scope_flag, change_type } = proposal;

  // Rule 1: AST confirms mechanical-only — absolute precedence
  if (risk_signals.mechanical_only) {
    return {
      resolved_change_type: "mechanical",
      stage1_override: true,
      override_reason: "AST confirms mechanical-only change",
    };
  }

  // Rules 2-3 only apply when the agent submitted "mechanical"
  if (change_type === "mechanical") {
    // Rule 2: Risk signals contradict mechanical classification
    const presentSignals: string[] = [];
    if (risk_signals.touched_auth_or_permission_patterns) {
      presentSignals.push("touched_auth_or_permission_patterns");
    }
    if (risk_signals.public_api_signature_changed) {
      presentSignals.push("public_api_signature_changed");
    }
    if (risk_signals.invariant_referenced_file_modified) {
      presentSignals.push("invariant_referenced_file_modified");
    }

    if (presentSignals.length > 0) {
      return {
        resolved_change_type: "behavioral",
        stage1_override: true,
        override_reason: `Agent classified as mechanical but risk signals present: ${presentSignals.join(", ")}`,
      };
    }

    // Rule 3: Cross-scope modification cannot be mechanical
    if (cross_scope_flag) {
      return {
        resolved_change_type: "behavioral",
        stage1_override: true,
        override_reason: "Cross-scope modification cannot be mechanical",
      };
    }
  }

  // Rule 4: Default — trust agent classification
  return {
    resolved_change_type: change_type,
    stage1_override: false,
    override_reason: null,
  };
}

/**
 * Returns true if the proposal must receive individual orchestrator review.
 *
 * Any single true condition triggers mandatory review (OR logic).
 * See Section 7.3.
 */
export function requiresMandatoryIndividualReview(
  proposal: QueueProposal,
  result: ClassificationResult,
): boolean {
  return (
    proposal.risk_signals.touched_auth_or_permission_patterns ||
    proposal.risk_signals.public_api_signature_changed ||
    proposal.risk_signals.invariant_referenced_file_modified ||
    proposal.cross_scope_flag ||
    result.stage1_override
  );
}

/**
 * Returns true only when every auto-approval precondition is satisfied.
 *
 * All eight conditions must hold simultaneously (strict AND).
 * Kept independent from requiresMandatoryIndividualReview so each
 * can evolve separately. See Section 7.3.
 */
export function isEligibleForAutoApproval(
  proposal: QueueProposal,
  result: ClassificationResult,
): boolean {
  if (result.resolved_change_type !== "mechanical") return false;
  if (!proposal.risk_signals.mechanical_only) return false;
  if (proposal.risk_signals.touched_auth_or_permission_patterns) return false;
  if (proposal.risk_signals.public_api_signature_changed) return false;
  if (proposal.risk_signals.invariant_referenced_file_modified) return false;
  if (proposal.risk_signals.high_fan_in_module_modified) return false;
  if (proposal.cross_scope_flag) return false;

  // Assumptions: empty array is fine; otherwise every assumption must be non-shared
  if (proposal.assumptions.length > 0 && proposal.assumptions.some((a) => a.shared)) {
    return false;
  }

  return true;
}

/**
 * Returns true if the proposal needs an LLM verifier pass (Stage 2).
 *
 * Stage 1 not firing is the definition of ambiguous — the verifier
 * runs only when the deterministic rules could not resolve it.
 * See Section 6.3.
 */
export function needsVerifierPass(
  _proposal: QueueProposal,
  stage1Result: ClassificationResult,
): boolean {
  return !stage1Result.stage1_override;
}
