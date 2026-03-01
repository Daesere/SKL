/**
 * RFCService — RFC trigger detection (Section 9.1)
 *
 * All functions in this file are pure — no I/O, no LLM calls.
 * detectRFCTrigger evaluates five deterministic conditions in
 * priority order and returns the first reason that matches.
 *
 * Note: "invariant_ambiguity_resolution" is defined in RFCTriggerReason
 * but is NOT returned by this function. It is surfaced by the LLM
 * decision step (substage 3.7) when the orchestrator cannot resolve
 * an invariant reference.
 */

import type {
  QueueProposal,
  KnowledgeFile,
  AssumptionConflictResult,
  RFCTriggerReason,
} from "../types/index.js";

/** Keywords that indicate a modification to an invariant (heuristic). */
const MODIFICATION_KEYWORDS = [
  "change",
  "update",
  "modify",
  "replace",
  "remove",
  "delete",
  "migrate",
];

/**
 * Detect whether a proposal should trigger an RFC.
 *
 * Checks five conditions in order; returns the first match or null.
 * The caller must pass the post-Stage-1-override change_type via proposal
 * (i.e. the proposal should have its change_type updated before calling).
 */
export function detectRFCTrigger(
  proposal: QueueProposal,
  knowledge: KnowledgeFile,
  assumptionConflict: AssumptionConflictResult,
): RFCTriggerReason | null {

  // Rule 1: Architectural change type → always triggers RFC
  if (proposal.change_type === "architectural") {
    return "architectural_change_type";
  }

  // Rule 2: Invariant touched AND responsibilities mention a modification keyword.
  // Heuristic: keyword match will produce false positives. Tunable.
  if (proposal.invariants_touched.length > 0) {
    const responsibilitiesLower = proposal.responsibilities.toLowerCase();
    const hasModificationKeyword = MODIFICATION_KEYWORDS.some((kw) =>
      responsibilitiesLower.includes(kw),
    );
    if (hasModificationKeyword) {
      return "invariant_modification_required";
    }
  }

  // Rule 3: New external dependency — not in State records and not in tech_stack.
  if (proposal.dependencies.length > 0) {
    const knownPaths = new Set(knowledge.state.map((r) => r.path));
    const techStackEntries = knowledge.invariants.tech_stack;

    for (const dep of proposal.dependencies) {
      const inState = knownPaths.has(dep);
      const inTechStack = techStackEntries.some((entry) =>
        entry.toLowerCase().includes(dep.toLowerCase()) ||
        dep.toLowerCase().includes(entry.toLowerCase()),
      );
      if (!inState && !inTechStack) {
        return "new_external_dependency";
      }
    }
  }

  // Rule 4: High-fan-in interface change — both signals must be true simultaneously.
  if (
    proposal.risk_signals.high_fan_in_module_modified &&
    proposal.risk_signals.public_api_signature_changed
  ) {
    return "high_fan_in_interface_change";
  }

  // Rule 5: Shared assumption conflict surfaced by earlier detection step.
  if (assumptionConflict.has_conflict) {
    return "shared_assumption_conflict";
  }

  return null;
}
