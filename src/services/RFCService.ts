/**
 * RFCService — RFC trigger detection, generation, and deadline monitoring
 *   (Section 9.1–9.2, 9.4)
 *
 * detectRFCTrigger: pure function — no I/O, no LLM calls.
 * generateRFC: LLM-backed function that builds an RFC from a proposal,
 *   validates the LLM output with Zod, retries once on failure,
 *   and atomically writes the result via SKLFileSystem.
 * checkRFCDeadlines: reads all open RFCs and returns those whose
 *   human_response_deadline has passed.
 *
 * Note: "invariant_ambiguity_resolution" is defined in RFCTriggerReason
 * but is NOT returned by detectRFCTrigger. It is set by the LLM decision
 * step when the orchestrator cannot resolve an invariant reference.
 */

import { z } from "zod";
import * as vscode from "vscode";
import { RfcOptionSchema } from "../types/index.js";
import type {
  QueueProposal,
  KnowledgeFile,
  AssumptionConflictResult,
  RFCTriggerReason,
  Rfc,
} from "../types/index.js";
import type { SKLFileSystem } from "./SKLFileSystem.js";

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

// ── RFC generation (Section 9.2) ──────────────────────────────────────────

/**
 * Zod schema used to validate the LLM's JSON response.
 * All seven fields are required — matching the prompt instruction.
 */
const LlmRfcResponseSchema = z.object({
  decision_required: z.string(),
  context: z.string(),
  option_a: RfcOptionSchema,
  option_b: RfcOptionSchema,
  option_c: RfcOptionSchema,
  orchestrator_recommendation: z.string(),
  orchestrator_rationale: z.string(),
});
type LlmRfcResponse = z.infer<typeof LlmRfcResponseSchema>;

/** Model handle inferred from vscode API — keeps the type DRY. */
type LmModel = Awaited<ReturnType<typeof vscode.lm.selectChatModels>>[0];

/** Plain-English descriptions of each RFC trigger reason (for prompt context). */
const TRIGGER_DESCRIPTIONS: Record<RFCTriggerReason, string> = {
  architectural_change_type:
    "This proposal changes function/class signatures, introduces new dependencies, " +
    "or restructures modules. Architectural changes require human pre-clearance before any branch merge.",
  invariant_modification_required:
    "This proposal appears to modify behaviour tied to a project invariant. " +
    "Invariants are immutable unless changed via RFC with explicit human approval.",
  new_external_dependency:
    "This proposal introduces a dependency not tracked in the State records or tech_stack invariants. " +
    "Human validation is required before the dependency is accepted.",
  high_fan_in_interface_change:
    "This proposal changes the public API signature of a module depended on by many downstream consumers. " +
    "Breakage risk is elevated and human pre-clearance is required.",
  invariant_ambiguity_resolution:
    "The orchestrator cannot resolve which invariant interpretation is correct for this proposal " +
    "and requires an explicit human decision.",
  shared_assumption_conflict:
    "Two concurrent proposals declare contradictory shared assumptions. " +
    "A human must decide which assumption is authoritative before either proposal can merge.",
};

// ── Private helpers ───────────────────────────────────────────────────────

function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?\s*```\s*$/, "");
  }
  return cleaned;
}

function formatZodErrors(error: z.ZodError): string {
  return error.issues
    .map((e) => `${(e.path as (string | number)[]).join(".") || "<root>"}: ${e.message}`)
    .join("; ");
}

async function invokeModel(model: LmModel, prompt: string): Promise<string> {
  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  const response = await model.sendRequest(messages, {});
  let text = "";
  for await (const chunk of response.text) {
    text += chunk;
  }
  return text;
}

async function callLlmWithRetry(
  model: LmModel,
  prompt: string,
): Promise<LlmRfcResponse> {
  // First attempt
  const rawFirst = await invokeModel(model, prompt);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownFences(rawFirst));
  } catch {
    parsed = null;
  }
  const firstResult = LlmRfcResponseSchema.safeParse(parsed);
  if (firstResult.success) return firstResult.data;

  // Retry: append Zod errors to the prompt
  const errorSummary = formatZodErrors(firstResult.error);
  const retryPrompt =
    `${prompt}\n\nYour previous response failed validation with these errors: ` +
    `${errorSummary}. Correct and try again.`;

  const rawSecond = await invokeModel(model, retryPrompt);
  let parsedSecond: unknown;
  try {
    parsedSecond = JSON.parse(stripMarkdownFences(rawSecond));
  } catch {
    parsedSecond = null;
  }
  const secondResult = LlmRfcResponseSchema.safeParse(parsedSecond);
  if (secondResult.success) return secondResult.data;

  throw new Error(
    `RFC generation failed after retry: ${formatZodErrors(secondResult.error)}`,
  );
}

function buildRfcPrompt(
  proposal: QueueProposal,
  triggerReason: RFCTriggerReason,
  assumptionConflict: AssumptionConflictResult | null,
  knowledge: KnowledgeFile,
): string {
  const relevantRecords = knowledge.state.filter(
    (r) => r.path === proposal.path || proposal.dependencies.includes(r.path),
  );

  const sections: string[] = [
    "You are an SKL Orchestrator generating an RFC to obtain a human architectural decision.",
    `\n## Trigger Reason\n${TRIGGER_DESCRIPTIONS[triggerReason]}`,
    "\n## Proposal",
    `- Path: ${proposal.path}`,
    `- Change Type: ${proposal.change_type}`,
    `- Responsibilities: ${proposal.responsibilities}`,
    `- Rationale: ${proposal.rationale}`,
    `- Assumptions: ${
      proposal.assumptions.length > 0
        ? proposal.assumptions.map((a) => `${a.id}: "${a.text}"`).join("; ")
        : "none"
    }`,
    "\n## Relevant State Records",
    relevantRecords.length > 0
      ? relevantRecords
          .map((r) => `- ${r.path} (${r.semantic_scope}): ${r.responsibilities}`)
          .join("\n")
      : "- none",
    "\n## Current Invariants",
    `- tech_stack: ${knowledge.invariants.tech_stack.join(", ")}`,
    `- auth_model: ${knowledge.invariants.auth_model}`,
    `- data_storage: ${knowledge.invariants.data_storage}`,
    `- security_patterns: ${knowledge.invariants.security_patterns.join(", ")}`,
  ];

  if (triggerReason === "shared_assumption_conflict" && assumptionConflict?.has_conflict) {
    const textA = assumptionConflict.assumption_a?.text ?? "(unknown)";
    const textB = assumptionConflict.assumption_b?.text ?? "(unknown)";
    sections.push(
      "\n## Conflicting Assumptions",
      `- Assumption A: "${textA}"`,
      `- Assumption B: "${textB}"`,
      "\nIMPORTANT: option_a MUST be \"Promote assumption to Invariant\" and " +
        "option_b MUST be \"Identify which assumption is wrong and require " +
        "correction before either proposal merges\".",
    );
  }

  sections.push(
    "\nRespond ONLY with a JSON object matching this exact shape:",
    JSON.stringify({
      decision_required: "string",
      context: "string",
      option_a: { description: "string", consequences: "string" },
      option_b: { description: "string", consequences: "string" },
      option_c: { description: "string", consequences: "string" },
      orchestrator_recommendation: "option_a|option_b|option_c",
      orchestrator_rationale: "string",
    }),
  );

  return sections.join("\n");
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Generate an RFC document for a proposal that triggered the RFC gate.
 *
 * Steps:
 *  1. Assign an ID based on how many RFCs already exist.
 *  2. Build a prompt including proposal context, relevant State records,
 *     invariants, and (for shared_assumption_conflict) both assumption texts.
 *  3. Call the LLM and validate with Zod — retry once on failure.
 *  4. Assemble the full RFC object (human fields left unset).
 *  5. Write via SKLFileSystem and return.
 */
export async function generateRFC(
  proposal: QueueProposal,
  triggerReason: RFCTriggerReason,
  assumptionConflict: AssumptionConflictResult | null,
  knowledge: KnowledgeFile,
  sklFileSystem: SKLFileSystem,
): Promise<Rfc> {
  // Step 1: Assign RFC ID
  const existingIds = await sklFileSystem.listRFCs();
  const rfcId = `RFC_${String(existingIds.length + 1).padStart(3, "0")}`;

  // Step 2: Select LLM model
  const models = await vscode.lm.selectChatModels({ family: "gpt-4o" });
  if (models.length === 0) {
    throw new Error("RFC generation failed: no LLM models available");
  }
  const model = models[0];

  // Step 3: Build prompt, call LLM, validate, retry if needed
  const prompt = buildRfcPrompt(proposal, triggerReason, assumptionConflict, knowledge);
  const llmResponse = await callLlmWithRetry(model, prompt);

  // Step 4: Assemble full RFC object (human fields left unset)
  const now = new Date();
  const rfc: Rfc = {
    id: rfcId,
    status: "open",
    created_at: now.toISOString(),
    triggering_proposal: proposal.proposal_id,
    decision_required: llmResponse.decision_required,
    context: llmResponse.context,
    option_a: llmResponse.option_a,
    option_b: llmResponse.option_b,
    option_c: llmResponse.option_c,
    orchestrator_recommendation: llmResponse.orchestrator_recommendation,
    orchestrator_rationale: llmResponse.orchestrator_rationale,
    acceptance_criteria: [],
    merge_blocked_until_criteria_pass: true,
    human_response_deadline: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };

  // Step 5: Write and return
  await sklFileSystem.writeRFC(rfc);
  return rfc;
}

// ── RFC deadline monitoring (Section 9.4) ──────────────────────────────────

/**
 * Return all open RFCs whose human_response_deadline has passed.
 *
 * Never throws — silently skips any RFC that cannot be read.
 * Call site should treat the result as an error-severity block:
 * no new agent work may start in the affected scope until resolved.
 */
export async function checkRFCDeadlines(
  sklFileSystem: SKLFileSystem,
): Promise<Rfc[]> {
  let ids: string[];
  try {
    ids = await sklFileSystem.listRFCs();
  } catch {
    return [];
  }

  const now = new Date();
  const expired: Rfc[] = [];

  for (const id of ids) {
    let rfc: Rfc;
    try {
      rfc = await sklFileSystem.readRFC(id);
    } catch {
      continue; // skip unreadable / invalid RFC files
    }
    if (
      rfc.status === "open" &&
      rfc.human_response_deadline !== undefined &&
      new Date(rfc.human_response_deadline) < now
    ) {
      expired.push(rfc);
    }
  }

  return expired;
}
