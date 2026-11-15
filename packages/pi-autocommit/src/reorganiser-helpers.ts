import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PipelineEvent } from "./commit-events.js";
import type { CommitGroup, ReviewGroupsFn } from "./commit-prompt.js";
import {
  type CompleteFn,
  completeSingleMessage,
  MAX_LLM_DIFF_CHARS,
} from "./commit-prompt.js";
import type { PiAutocommitConfig } from "./config.js";
import type { ReorganiserStore } from "./reorganiser-store.js";

/**
 * Thrown when the user rejects the proposed groups. Carries no damage of its
 * own — callers that already moved HEAD restore it, callers that only
 * soft-reset leave the changes staged.
 */
export class ReviewAbortedError extends Error {
  constructor() {
    super("提案されたコミットをキャンセルしました");
    this.name = "ReviewAbortedError";
  }
}

/**
 * Let the user review the proposed groups, then commit them.
 *
 * Without a `review` callback this is exactly {@link commitGroups}. With one,
 * a `null` result aborts: the staged changes are left untouched and
 * {@link ReviewAbortedError} is thrown so the caller can undo whatever it had
 * already done to HEAD.
 *
 * Files the reviewed groups no longer claim are unstaged before committing,
 * so they stay uncommitted working-tree changes instead of tripping the
 * coverage guard and collapsing the run into a single fallback commit. They
 * are reported, because a silently dropped file is how a change goes missing.
 *
 * @returns The number of commits executed.
 */
export async function commitReviewedGroups(
  store: ReorganiserStore,
  groups: CommitGroup[],
  events: PipelineEvent[],
  review?: ReviewGroupsFn,
): Promise<number> {
  if (!review) {
    return commitGroups(store, groups, events);
  }

  const reviewed = await review(groups);
  if (reviewed === null) {
    throw new ReviewAbortedError();
  }

  const nameStatus = await store.getStagedNameStatus();
  const covered = new Set(reviewed.flatMap((g) => g.files));
  const dropped = parseNameStatusPaths(nameStatus).filter(
    (path) => !covered.has(path),
  );
  if (dropped.length > 0) {
    await store.unstageFiles(dropped);
    events.push({
      type: "info",
      message:
        `pi-autocommit: ${dropped.length} ファイルをコミットから外しました（未コミットのまま残ります）: ` +
        `${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? ", ..." : ""}`,
    });
  }

  return commitGroups(store, reviewed, events);
}

/**
 * Stage and commit each logical group in order.
 *
 * Skips groups with no staged changes. Throws when a commit fails so the
 * caller can catch and run the fallback path.
 *
 * Also throws when the groups do not cover every staged file: the prompt
 * contract is "every file in exactly one group, no omissions", so a group
 * partition that drops a file would otherwise leave that change silently
 * uncommitted. Throwing routes the caller into the fallback single-commit
 * path, which stages and commits everything remaining.
 *
 * @returns The number of commits actually executed.
 */
export async function commitGroups(
  store: ReorganiserStore,
  groups: CommitGroup[],
  events: PipelineEvent[],
): Promise<number> {
  // Capture the full staged file set before group staging mutates the index.
  // Name-status is enough and stays small even when the diff does not.
  const nameStatus = await store.getStagedNameStatus();
  const stagedPaths = parseNameStatusPaths(nameStatus);

  let commitCount = 0;
  for (const group of groups) {
    await store.unstageAll();
    await store.stageFiles(group.files);

    // Skip groups with no staged changes (e.g. duplicate files already committed).
    if (!(await store.hasStagedChanges())) {
      events.push({
        type: "info",
        message: `Skipped empty commit group: ${group.message.split("\n")[0]}`,
      });
      continue;
    }

    commitCount++;
    const result = await store.commit(group.message);
    if (result.code !== 0) {
      const detail =
        result.stderr.trim() || result.stdout.trim() || "Unknown error";
      throw new Error(`Commit failed (code ${result.code}): ${detail}`);
    }
  }

  // Coverage guard: every staged file must be claimed by at least one group.
  const covered = new Set(groups.flatMap((g) => g.files));
  const missing = stagedPaths.filter((p) => !covered.has(p));
  if (missing.length > 0) {
    throw new Error(
      `Commit groups do not cover ${missing.length} staged file(s): ` +
        `${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}. ` +
        "Falling back to a single commit.",
    );
  }

  return commitCount;
}

/**
 * Extract the path referenced by one `--name-status` line.
 * Rename lines carry three tab-separated fields (status, old path, new path);
 * the new path is the one a commit group would reference.
 */
export function nameStatusLinePath(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("\t");
  return (parts.length >= 3 ? parts[2] : parts[1]) ?? null;
}

/** Parse `git diff --cached --name-status` output into the staged paths. */
export function parseNameStatusPaths(nameStatus: string): string[] {
  const paths: string[] = [];
  for (const line of nameStatus.split("\n")) {
    const path = nameStatusLinePath(line);
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * Fall back to a single Conventional Commit for all staged changes.
 *
 * One call to {@link completeSingleMessage} absorbs the LLM path and the
 * heuristic path alike — so the reorganiser's fallback no longer triggers a
 * second silent LLM roundtrip. When the staged diff is too large for the LLM
 * (see {@link MAX_LLM_DIFF_CHARS}) the emitted warning says so, since the
 * lost split quality is otherwise unexplained.
 */
export async function fallbackSingleCommit(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  store: ReorganiserStore,
  events: PipelineEvent[],
  complete?: CompleteFn,
): Promise<void> {
  // An oversized diff is replaced by its name-status manifest: reading it
  // would allocate the string that crashes the process, and the manifest still
  // lets the LLM name the commit.
  const oversized = (await store.getStagedDiffSize()) > MAX_LLM_DIFF_CHARS;
  let diff: string;
  let nameStatus: string;
  let stat: string;
  if (oversized) {
    nameStatus = await store.getStagedNameStatus();
    diff = nameStatus;
    stat = "";
  } else {
    ({ diff, nameStatus, stat } = await store.getStagedMaterials());
  }

  let llmFailure: string | undefined;
  const message = await completeSingleMessage(
    ctx,
    config,
    { diff, nameStatus, stat },
    complete,
    (reason) => {
      llmFailure = reason;
    },
  );

  const result = await store.commit(message);
  if (result.code !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || "Unknown error";
    throw new Error(`Fallback commit failed (code ${result.code}): ${detail}`);
  }

  const subject = message.split("\n")[0];
  events.push({
    type: "fallback",
    message: oversized
      ? `Staged diff is too large for the LLM split (> ${MAX_LLM_DIFF_CHARS} bytes) — ` +
        `the commit message was built from the file list. Fell back to a single commit:\n${subject}`
      : `Reorganisation fell back to a single commit${
          llmFailure ? ` (LLM call failed — ${llmFailure})` : ""
        }:\n${subject}`,
  });
}
