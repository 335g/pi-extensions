import {
  type Api,
  completeSimple,
  type Model,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatFullMessage, generateCommitMessage } from "./commit-message.js";
import { COMMIT_TYPES } from "./commit-types.js";
import type { PiAutocommitConfig } from "./config.js";
import { resolvedLanguageName } from "./config.js";
import { parseNameStatus } from "./git-parser.js";
import {
  hasScopeMapping,
  injectScopeIntoMessage,
  resolveScope,
} from "./scope-resolver.js";

/**
 * Commit prompt module — the deep module owning prompt assembly, the LLM-call
 * adapter, response cleanup, and deterministic scope injection for commit
 * messages.
 *
 * Two interface methods:
 * - {@link completeSingleMessage} — single-commit generation, falls back to
 *   the heuristic when the LLM is unavailable.
 * - {@link completeCommitGroups} — commit-group proposition; throws on
 *   inference failure.
 *
 * Behind the seam: language switching rules, the COMMIT_TYPES reference, the
 * scope-mapping subject-format rule, the LLM adapter (statically imported by
 * default, injectable for tests), response cleanup, group parsing, scope
 * injection, and the heuristic fallback.
 */

// ── Port: the LLM adapter (ports & adapters — two adapters ⇒ real seam) ──

/**
 * Adapter for the LLM completion call.
 *
 * Production: statically imported `completeSimple` from `@earendil-works/pi-ai/compat`.
 * Tests: an in-memory fake implementing the same shape. Accepting this as an
 * optional injected dependency keeps the seam real (two adapters) while
 * letting production callers omit it for zero ceremony.
 */
export type CompleteFn = (
  model: Model<Api>,
  context: {
    systemPrompt: string;
    messages: { role: "user"; content: string; timestamp: number }[];
  },
  options?: CompleteOptions,
) => Promise<{
  content: Array<{ type: "string"; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}>;

/** Request options handed to the adapter: resolved auth plus attribution headers. */
export interface CompleteOptions {
  apiKey?: string;
  headers?: Record<string, string | null>;
}

/** Statically imported production adapter. */
const defaultComplete: CompleteFn = completeSimple as unknown as CompleteFn;

// ── Diff size limit ───────────────────────────────────────

/**
 * Largest staged diff (in characters) handed to the LLM.
 *
 * A diff above this is not a commit-sized change — vendored dependencies,
 * build artifacts, data dumps. Building a request body around it makes the
 * SDK's `JSON.stringify` allocate hundreds of MB and V8 aborts the whole
 * process (`Zone Allocation failed`) before any error handling can run, so
 * over the limit the LLM is skipped and the single-commit/heuristic path
 * takes over instead.
 */
export const MAX_LLM_DIFF_CHARS = 200_000;

/** True when the staged diff is too large to send to the LLM. */
export function diffExceedsLlmLimit(diff: string): boolean {
  return diff.length > MAX_LLM_DIFF_CHARS;
}

// ── Input types ───────────────────────────────────────────

/** Raw git materials for the single-commit path (the high-frequency caller). */
export interface SingleCommitInput {
  /** `git diff --cached` output. */
  diff: string;
  /** `git diff --cached --name-status` output. Used for scope injection and heuristic. */
  nameStatus: string;
  /** `git diff --cached --stat` output. Used by the heuristic fallback. */
  stat: string;
}

/** Raw git materials for the commit-group proposition path. */
export interface GroupsInput {
  /** `git diff --cached` output. */
  diff: string;
  /** Assistant reasoning from the agent loop (build via {@link extractAssistantContext}). */
  reasoning: string;
}

/** One logical commit produced by the reorganiser. */
export interface CommitGroup {
  /** Full Conventional Commits message (subject + optional body/footer). */
  message: string;
  /** Files that belong exclusively to this commit. */
  files: string[];
}

/**
 * Optional user review of the proposed groups, run between proposition and
 * commit. Returns the groups to commit (with edited messages and/or an edited
 * file partition), or `null` to abort: nothing is committed and the changes
 * stay staged.
 *
 * A file the returned groups do not claim is unstaged and left uncommitted by
 * {@link commitReviewedGroups}, so the coverage guard in `commitGroups` still
 * holds for every file that stays staged.
 */
export type ReviewGroupsFn = (
  groups: CommitGroup[],
) => Promise<CommitGroup[] | null>;

// ── Shared private helpers ────────────────────────────────

/** Language-aware subject instruction. */
function subjectLangInstruction(config: PiAutocommitConfig): string {
  const name = resolvedLanguageName(config);
  if (name === "Japanese") {
    return "Write the subject in Japanese (日本語). No period, 50 chars or fewer.";
  }
  if (name === "English") {
    return "English, imperative present tense, lowercase, no period, 50 chars or fewer.";
  }
  return `Write the subject in ${name}. No period, 50 chars or fewer.`;
}

/** Language-aware body instruction. */
function bodyLangInstruction(config: PiAutocommitConfig): string {
  const name = resolvedLanguageName(config);
  if (name === "Japanese") {
    return "Write the body in Japanese (日本語).";
  }
  if (name === "English") {
    return "Write the body in English.";
  }
  return `Write the body in ${name}.`;
}

/** The type reference block shared by both prompt variants. */
function typeReferenceBlock(): string[] {
  return [
    "",
    "Type reference (pick the most significant one):",
    ...Object.entries(COMMIT_TYPES).map(
      ([type, desc]) => `  ${type.padEnd(9)}— ${desc}`,
    ),
  ];
}

/**
 * Extract non-empty text blocks from a content array.
 *
 * Shared by adapter-response cleanup and assistant-context extraction.
 * Uses a structural type so it works for both the adapter's content shape
 * and the agent-loop message content shape without importing either.
 */
function extractTextBlocks(
  blocks: ReadonlyArray<unknown>,
): Array<{ type: "text"; text: string }> {
  return blocks.filter(
    (c): c is { type: "text"; text: string } =>
      typeof c === "object" &&
      c !== null &&
      (c as { type?: string }).type === "text" &&
      !!(c as { text?: string }).text,
  );
}

/** Extract text from an adapter response (filter·map·join·trim). */
function extractText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return extractTextBlocks(result.content)
    .map((c) => c.text)
    .join("\n")
    .trim();
}

/**
 * Strip common LLM artifacts from the raw response:
 * - Markdown code fences (```...```)
 * - Inline backtick wrapping
 * - "Commit message:" prefix
 * - Extra empty lines
 */
function cleanupResponse(raw: string): string {
  let text = raw;

  // Remove markdown code fences (```...```)
  text = text.replace(/^```[\s\S]*?\n/, "");
  text = text.replace(/\n```\s*$/, "");

  // Remove inline backtick wrapping around the whole message
  text = text.replace(/^`([\s\S]*)`$/, "$1");

  // Remove echoed "Commit message:" prefix
  text = text.replace(/^Commit message:\s*/i, "");

  // Collapse 3+ consecutive newlines to 2
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * Build the adapter's request options: the registry-resolved API key plus the
 * provider attribution headers pi normally attaches from its session runtime.
 *
 * pi runs its own model calls through `ModelRuntime.streamSimple` with a
 * session id and a `transformHeaders` hook that adds `x-opencode-session` and
 * `x-opencode-client: pi`. The legacy global `completeSimple` an extension can
 * reach has neither, and opencode / opencode-go answer such requests with
 * `400 MissingSessionID` — every call failing silently into the heuristic
 * fallback. Mirrors `getSessionHeaders` in the coding agent's
 * `provider-attribution`.
 *
 * `modelRegistry`/`sessionManager` are read defensively: test doubles may
 * provide neither.
 */
async function buildCompleteOptions(
  ctx: ExtensionContext,
  model: Model<Api>,
): Promise<CompleteOptions> {
  const auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(model);
  const headers: Record<string, string | null> = auth?.ok ? { ...auth.headers } : {};

  const isOpencode =
    model.provider === "opencode" ||
    model.provider === "opencode-go" ||
    (model.baseUrl ?? "").includes("opencode.ai");
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (isOpencode && sessionId) {
    headers["x-opencode-session"] = sessionId;
    headers["x-opencode-client"] = "pi";
  }

  return {
    ...(auth?.ok && auth.apiKey ? { apiKey: auth.apiKey } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/**
 * Shared adapter call: send `systemPrompt` + `userContent` with the request
 * options above and return the response text.
 *
 * `completeSimple` resolves with `stopReason: "error"` instead of rejecting on
 * a provider error, so the stop reason must be checked explicitly — otherwise a
 * failed request looks like a successful empty answer and the caller silently
 * degrades to the heuristic.
 */
async function callLlm(
  ctx: ExtensionContext,
  model: Model<Api>,
  adapter: CompleteFn,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const options = await buildCompleteOptions(ctx, model);
  const result = await adapter(
    model,
    {
      systemPrompt,
      messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
    },
    options,
  );

  if (result.stopReason === "error") {
    throw new Error(
      `LLM request failed: ${result.errorMessage || "unknown error"}`,
    );
  }

  const text = extractText(result);
  if (!text) {
    throw new Error("Empty LLM response");
  }
  return text;
}

// ── Public helper ─────────────────────────────────────────

/**
 * Send a one-shot system+user prompt through the same model resolution and
 * adapter plumbing the commit prompts use.
 *
 * Exported for the callers outside the commit-message path (task boundary
 * detection), so the opencode attribution headers and the `stopReason: "error"`
 * check are not reimplemented next to every new prompt.
 */
export async function completeText(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  systemPrompt: string,
  userContent: string,
  complete?: CompleteFn,
): Promise<string> {
  const model = await resolveModelForConfig(ctx, config);
  if (!model) {
    throw new Error("No model available");
  }
  return callLlm(ctx, model, complete ?? defaultComplete, systemPrompt, userContent);
}

/**
 * Extract assistant reasoning text from agent-loop messages.
 *
 * Uses a structural type so the module does not import pi-coding-agent types;
 * `AgentEndEvent["messages"]` satisfies this shape and can be passed through
 * without conversion. Assistant messages are joined with a `---` separator so
 * the reorganiser can see the agent's intended reasoning across turns.
 */
export function extractAssistantContext(
  messages: ReadonlyArray<unknown>,
): string {
  const parts: string[] = [];

  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown };
    if (message.role !== "assistant") {
      continue;
    }

    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = extractTextBlocks(blocks)
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (text) {
      parts.push(text);
    }
  }

  return parts.join("\n\n---\n\n");
}

// ── Interface method 2: completeCommitGroups ───────────────

/**
 * Parse an LLM response into commit groups.
 *
 * Expected format (N starts at 1):
 *
 *   === COMMIT N ===
 *   type(scope): description
 *
 *   Body line.
 *   === FILES ===
 *   path/to/file1.ts
 *   path/to/file2.ts
 *   === END ===
 */
function parseCommitGroups(text: string): CommitGroup[] {
  const groups: CommitGroup[] = [];

  const parts = text.split(/===\s*COMMIT\s*\d+\s*===/);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    if (!block) continue;

    const [messageAndFilesRaw] = block.split("=== END ===");
    if (!messageAndFilesRaw) continue;

    const [messageRaw, filesRaw] = messageAndFilesRaw.split("=== FILES ===");
    if (!messageRaw || !filesRaw) continue;

    const message = messageRaw.trim();
    const files = filesRaw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    if (message && files.length > 0) {
      groups.push({ message, files });
    }
  }

  return groups;
}

/** Build the commit-group-proposition system prompt. */
function buildGroupsSystemPrompt(config: PiAutocommitConfig): string {
  const scopeManaged = hasScopeMapping(config);

  const subjectFormat = scopeManaged
    ? "Subject format: `type: brief summary` — do NOT add a scope; the scope is applied automatically from the changed paths."
    : "Subject format: `type(scope): brief summary`";

  const rules = [
    "You are reorganising checkpoint commits into logical Conventional Commits.",
    "",
    "Rules:",
    "- Split changes into coherent groups. Each group should represent one self-contained change.",
    "- Order groups by dependency: foundational changes first, dependent changes later.",
    "- Every file must appear in exactly ONE group. No overlaps, no omissions.",
    "- If the diff is too small to split meaningfully, output a single group.",
    "",
    subjectFormat,
    `Subject: ${subjectLangInstruction(config)}`,
    `Body: describe what changed and why. ${bodyLangInstruction(config)}`,
    "Footer: add `BREAKING CHANGE: ...` when there is a breaking change.",
  ];

  rules.push(
    ...typeReferenceBlock(),
    "",
    "Output format — repeat for each group:",
    "",
    "=== COMMIT N ===",
    scopeManaged
      ? "type: description (no scope — it will be added automatically)"
      : "type(scope): description",
    "",
    "Body paragraph(s).",
    "=== FILES ===",
    "relative/path/to/file1.ts",
    "relative/path/to/file2.ts",
    "=== END ===",
    "",
    "Output ONLY the commit groups. No explanations, no markdown fences.",
  );

  return rules.join("\n");
}

/** Build the commit-group-proposition user content. */
function buildGroupsUserContent(diff: string, reasoning: string): string {
  const sections: string[] = [];

  if (reasoning) {
    sections.push("--- Agent reasoning ---");
    sections.push(reasoning);
    sections.push("");
  }

  sections.push("--- Staged changes ---");
  sections.push(diff);
  sections.push("");
  sections.push("Split the staged changes into logical Conventional Commits.");

  return sections.join("\n");
}

/**
 * Propose a split of the staged change set into logical commit groups.
 *
 * Invariants:
 * - Returns `CommitGroup[]` (maybe empty). Never null/undefined.
 * - Group count is decided by the LLM (no heuristic for groups).
 * - Staged diffs above {@link MAX_LLM_DIFF_CHARS} return `[]` without an LLM
 *   call, so the caller falls back to a single commit.
 * - When a scope mapping is configured (ADR-0003), each group's message has
 *   the scope injected deterministically from that group's files.
 * - `complete` omitted → lazily imports `completeSimple` for production.
 *
 * Error modes: throws on LLM response unparseable/empty or model
 * unavailable. The caller (reorganiser) catches and falls back to a single
 * commit via {@link completeSingleMessage} — so the silent double-LLM
 * roundtrip disappears as a consequence of depth.
 */
export async function completeCommitGroups(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  input: GroupsInput,
  complete?: CompleteFn,
): Promise<CommitGroup[]> {
  // Too large to split: return no groups so the caller commits the whole
  // change set as one commit (see MAX_LLM_DIFF_CHARS).
  if (diffExceedsLlmLimit(input.diff)) {
    return [];
  }

  const scopeManaged = hasScopeMapping(config);
  const systemPrompt = buildGroupsSystemPrompt(config);
  const userContent = buildGroupsUserContent(input.diff, input.reasoning);

  const adapter = complete ?? defaultComplete;

  const model = await resolveModelForConfig(ctx, config);
  if (!model) {
    throw new Error("No model available");
  }

  const text = await callLlm(ctx, model, adapter, systemPrompt, userContent);

  const cleaned = cleanupResponse(text);
  const groups = parseCommitGroups(cleaned);

  if (scopeManaged) {
    for (const group of groups) {
      group.message = injectScopeIntoMessage(
        group.message,
        group.files,
        config,
      );
    }
  }

  return groups;
}

// ── Interface method 1: completeSingleMessage ─────────────

/** Resolve the model to use (delegates to the existing port in llm-commit). */
async function resolveModelForConfig(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
): Promise<Model<Api> | undefined> {
  const { resolveModel } = await import("./llm-commit.js");
  return resolveModel(ctx, config);
}

/**
 * Build the single-message system prompt.
 */
function buildSingleSystemPrompt(config: PiAutocommitConfig): string {
  const scopeManaged = hasScopeMapping(config);

  const rules = [
    scopeManaged
      ? "Subject format: `type: brief summary` — do NOT add a scope; the scope is applied automatically from the changed paths."
      : "Subject format: `type(scope): brief summary`",
    `Subject: ${subjectLangInstruction(config)}`,
    `Body: list each changed file, describe what changed and why. ${bodyLangInstruction(config)}`,
    "Footer: add `BREAKING CHANGE: ...` when there is a breaking change.",
    "",
    "When a change spans multiple types, select the most significant one and",
    "describe the rest in the body.",
  ];

  return [
    "You are a commit message generator. Generate a Conventional Commits",
    "commit message for the given staged changes.",
    "",
    "--- Rules ---",
    ...rules,
    ...typeReferenceBlock(),
    "",
    scopeManaged
      ? "Scope: do not include one. The scope will be inserted automatically based on the changed paths."
      : "Scope: describe the affected area in parentheses if meaningful. There is no fixed list; infer from the changed paths.",
    "",
    "Output ONLY the commit message — no explanations, no markdown fences, no extra text.",
  ].join("\n");
}

/** Build the single-message user content from raw git materials. */
function buildSingleUserContent(diff: string): string {
  return ["--- Staged changes ---", diff, "", "Commit message:"].join("\n");
}

/** Heuristic fallback: path-determined Conventional Commits message. */
function heuristicSingleMessage(
  input: SingleCommitInput,
  config: PiAutocommitConfig,
): string {
  const fallback = generateCommitMessage(
    input.nameStatus,
    input.stat,
    input.diff,
    config,
  );
  return formatFullMessage(fallback);
}

/**
 * Generate one Conventional Commits message for a staged change set.
 *
 * Invariants:
 * - Always returns a non-empty string — never throws on LLM failure.
 * - LLM unavailable or empty response → heuristic fallback.
 * - Staged diffs above {@link MAX_LLM_DIFF_CHARS} go straight to the
 *   heuristic (no LLM call).
 * - When a scope mapping is configured (ADR-0003), the scope is injected
 *   deterministically from the changed paths after the LLM responds.
 * - `complete` omitted → lazily imports `completeSimple` for production.
 *
 * Error modes: no throw. LLM errors, empty responses, import failures all
 * fall through to the heuristic.
 */
export async function completeSingleMessage(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  input: SingleCommitInput,
  complete?: CompleteFn,
  onLlmFailure?: (reason: string) => void,
): Promise<string> {
  // Too large to send: skip the LLM roundtrip entirely.
  if (diffExceedsLlmLimit(input.diff)) {
    return heuristicSingleMessage(input, config);
  }

  const scopeManaged = hasScopeMapping(config);
  const systemPrompt = buildSingleSystemPrompt(config);
  const userContent = buildSingleUserContent(input.diff);

  const adapter = complete ?? defaultComplete;

  try {
    const model = await resolveModelForConfig(ctx, config);
    if (!model) {
      throw new Error("No model available");
    }

    const text = await callLlm(ctx, model, adapter, systemPrompt, userContent);

    const cleaned = cleanupResponse(text);
    if (scopeManaged) {
      const paths = parseNameStatus(input.nameStatus).map((e) => e.path);
      return injectScopeIntoMessage(cleaned, paths, config);
    }
    return cleaned;
  } catch (error) {
    // LLM path failed — fall through to heuristic, reporting why.
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[pi-autocommit] commit message LLM call failed (${reason}). Using the heuristic fallback.`,
    );
    onLlmFailure?.(reason);
    return heuristicSingleMessage(input, config);
  }
}
