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
