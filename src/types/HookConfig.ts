import { z } from "zod";

/**
 * Hook Configuration Schema
 *
 * Tunable parameters for the SKL orchestrator and Git hooks.
 * Stored at .skl/hook_config.json. Absence is expected on
 * fresh repos — consumers should fall back to DEFAULT_HOOK_CONFIG.
 */
export const HookConfigSchema = z.object({
  /** SKL specification version. */
  skl_version: z.string(),

  /** Maximum number of proposals allowed in the queue. */
  queue_max: z.number().int().min(1).default(15),

  /** Circuit-breaker trip threshold before agent is halted. */
  circuit_breaker_threshold: z.number().int().min(1).default(3),

  /** Changes since last review before an informational diagnostic fires. */
  review_threshold: z.number().int().min(1).default(5),

  /** Default branch name for merge targets. */
  base_branch: z.string().default("main"),

  /** Python executable used by Git hook scripts. */
  python_executable: z.string().default("python3"),
});

export type HookConfig = z.infer<typeof HookConfigSchema>;

/** Default configuration written on first initialization. */
export const DEFAULT_HOOK_CONFIG: HookConfig = {
  skl_version: "1.4",
  queue_max: 15,
  circuit_breaker_threshold: 3,
  review_threshold: 5,
  base_branch: "main",
  python_executable: "python3",
};
