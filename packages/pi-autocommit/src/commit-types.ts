/**
 * Conventional Commits types with descriptions.
 *
 * Single source of truth for all commit type domain knowledge.
 * Both the heuristic (`commit-message.ts`) and LLM (`llm-commit.ts`) paths
 * derive their type information from here.
 */
export const COMMIT_TYPES = {
  feat: "New feature, new command/option/API",
  fix: "Bug fix, correction of unintended behavior",
  refactor: "Improve code structure without behavior change",
  chore: "Build config, dependencies, CI, repository setup",
  docs: "Documentation-only (README, SKILL.md, comments)",
  test: "Adding or modifying tests",
  style: "Code formatting (no behavioral impact)",
  perf: "Performance improvements",
} as const;

/**
 * Union type derived from `COMMIT_TYPES` keys.
 */
export type CommitType = keyof typeof COMMIT_TYPES;
