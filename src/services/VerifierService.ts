/**
 * VerifierService — LLM-based verifier pass (Section 6.2)
 *
 * Provides git-diff retrieval and an independent LLM classification
 * that is compared against the agent's submission. The verifier prompt
 * deliberately withholds the agent's classification to prevent anchoring.
 *
 * **ESLint note:** This service imports `node:child_process` and
 * `node:util` (neither is in the restricted-import list). It does NOT
 * import `fs` or `path`.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { QueueProposal, ChangeType, VerifierResult } from "../types/index.js";

const execFile = promisify(execFileCb);

// ── Risk ordering (lowest → highest) ─────────────────────────────

const RISK_ORDER: Record<ChangeType, number> = {
  mechanical: 0,
  behavioral: 1,
  architectural: 2,
};

const VALID_CLASSIFICATIONS = new Set<string>([
  "mechanical",
  "behavioral",
  "architectural",
]);

// ── Minimal structural interface for the output channel ──────────

/** Subset of vscode.OutputChannel consumed by this service. */
export interface OutputChannelLike {
  appendLine(value: string): void;
}

// ── Service class ────────────────────────────────────────────────

export class VerifierService {
  private readonly outputChannel: OutputChannelLike;

  constructor(outputChannel: OutputChannelLike) {
    this.outputChannel = outputChannel;
  }

  // ── Git diff ─────────────────────────────────────────────────

  /**
   * Retrieve the diff of a single file between two branches.
   *
   * Returns an empty string on any error — the caller should treat
   * an empty diff as "unknown" and default to behavioral.
   */
  async getFileDiff(
    filepath: string,
    branch: string,
    baseBranch: string,
  ): Promise<string> {
    try {
      const { stdout } = await execFile("git", [
        "diff",
        `${baseBranch}...${branch}`,
        "--",
        filepath,
      ]);
      return stdout;
    } catch (err: unknown) {
      this.outputChannel.appendLine(
        `[VerifierService] getFileDiff error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "";
    }
  }

  // ── Verifier LLM pass ───────────────────────────────────────

  /**
   * Run the independent verifier classification.
   *
   * The agent's classification is withheld from the prompt so the LLM
   * forms its own judgment (Section 6.2). After the response, the two
   * classifications are compared and any disagreement resolves to the
   * higher-risk value.
   */
  async runVerifierPass(
    proposal: QueueProposal,
    agentClassification: ChangeType,
    diff: string,
  ): Promise<VerifierResult> {
    // 1. Select a model
    const models = await vscode.lm.selectChatModels({ family: "gpt-4o" });

    if (models.length === 0) {
      return {
        verifier_classification: agentClassification,
        justification:
          "No LLM available for verification; defaulting to agent classification",
        agreement: true,
        resolved_classification: agentClassification,
      };
    }

    const model = models[0];

    // 2. Build the prompt (NO agent classification — prevent anchoring)
    const diffSection =
      diff.length > 0
        ? `## Diff\n\`\`\`\n${diff}\n\`\`\``
        : "## Diff\nNo diff was available.";

    const prompt = [
      "You are a code change classifier. Analyze the following proposal and classify the change.\n",
      diffSection,
      "\n## File Context",
      `- Path: ${proposal.path}`,
      `- Responsibilities: ${proposal.responsibilities}`,
      `- Dependencies: ${proposal.dependencies.join(", ") || "none"}`,
      "\n## Agent Rationale",
      proposal.rationale,
      "\n## Agent Reasoning Summary",
      proposal.agent_reasoning_summary || "none provided",
      '\nRespond ONLY with a valid JSON object and nothing else:',
      '{ "classification": "mechanical|behavioral|architectural", "justification": "one sentence maximum" }',
      "\nClassification definitions:",
      "- mechanical: Only whitespace, formatting, or comment changes. No functional difference.",
      "- behavioral: Function body changes without changing public API signatures.",
      "- architectural: Changes to class/function signatures, new dependencies, or structural changes.",
    ].join("\n");

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];

    // 3. Send request to LLM
    let responseText = "";
    try {
      const response = await model.sendRequest(messages, {});
      for await (const chunk of response.text) {
        responseText += chunk;
      }
    } catch (err: unknown) {
      this.outputChannel.appendLine(
        `[VerifierService] LLM request error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.buildFallbackResult(agentClassification);
    }

    // 4. Strip markdown fences
    let jsonText = responseText.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/^```(?:json)?\s*\n?/, "")
        .replace(/\n?\s*```\s*$/, "");
    }

    // 5. Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return this.buildFallbackResult(agentClassification);
    }

    // 6. Validate classification value
    const obj = parsed as Record<string, unknown>;
    const rawClassification = obj["classification"];

    if (
      typeof rawClassification !== "string" ||
      !VALID_CLASSIFICATIONS.has(rawClassification)
    ) {
      return this.buildFallbackResult(agentClassification);
    }

    const verifierClassification = rawClassification as ChangeType;
    const justification =
      typeof obj["justification"] === "string" ? obj["justification"] : "";
    const agreement = verifierClassification === agentClassification;

    return {
      verifier_classification: verifierClassification,
      justification,
      agreement,
      resolved_classification: agreement
        ? verifierClassification
        : this.resolveHigherRisk(verifierClassification, agentClassification),
    };
  }

  // ── Private helpers ─────────────────────────────────────────

  /** Return the higher-risk of two classifications. */
  private resolveHigherRisk(a: ChangeType, b: ChangeType): ChangeType {
    return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
  }

  /** Fallback result when parsing or validation fails. */
  private buildFallbackResult(agentClassification: ChangeType): VerifierResult {
    const fallback: ChangeType = "behavioral";
    return {
      verifier_classification: fallback,
      justification:
        "Verifier response unparseable; defaulting to behavioral as safe default",
      agreement: fallback === agentClassification,
      resolved_classification: this.resolveHigherRisk(
        fallback,
        agentClassification,
      ),
    };
  }
}
