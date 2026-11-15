import type { CheckpointStore } from "./checkpoint-store.js";
import type { PipelineEvent, PipelineResult } from "./commit-events.js";

/**
 * Build the checkpoint commit message body: the subject plus `Checkpoint-Session`
 * and `Checkpoint-Branch` Git trailers when available. Trailers are omitted
 * entirely when neither is present so the message stays a plain subject.
 */
export function buildCheckpointMessage(
  message: string,
  sessionId?: string,
  branch?: string | null,
): string {
  const trailers: string[] = [];
  if (sessionId) trailers.push(`Checkpoint-Session: ${sessionId}`);
  if (branch) trailers.push(`Checkpoint-Branch: ${branch}`);
  if (trailers.length === 0) return message;
  return `${message}\n\n${trailers.join("\n")}`;
}

// ── Checkpoint commit ──────────────────────────────────────

/**
 * Create a lightweight checkpoint commit at `turn_end`.
 *
 * Steps:
 *   1. Verify git repository
 *   2. Check for merge conflicts
 *   3. Check for uncommitted changes
 *   4. Stage all files (`git add -A`)
 *   5. Skip when nothing became stageable (e.g. submodule-internal
 *      dirt only), instead of letting `git commit` fail
 *   6. Execute `git commit -m <message>`
 *
 * The checkpoint message (e.g. `wip(checkpoint): auto-commit at turn N`)
 * is supplied by the caller. When `sessionId` is provided, a
 * `Checkpoint-Session: <sessionId>` Git trailer is appended to the commit
 * body so the reorganiser can scope its reset to the owning session; the
 * current branch is recorded as `Checkpoint-Branch` when resolvable so
 * merged checkpoints can be traced back to their origin worktree.
 *
 * Checkpoint commits are later reorganised into logical Conventional
 * Commits at `agent_end` by the organiser.
 *
 * Error boundary: on any error, `unstageAll` runs before re-throwing.
 * Footer-status updates are the caller's responsibility.
 */
export async function runCheckpointCommit(
  store: CheckpointStore,
  message: string,
  sessionId?: string,
  options?: { ignoreSubmodules?: boolean },
): Promise<PipelineResult> {
  const events: PipelineEvent[] = [];
  let committed = false;

  try {
    // ── 1. Verify git repository ────────────────────────
    if (!(await store.isInsideGitRepo())) {
      events.push({ type: "error", message: "Not a git repository" });
      return { events, committed: false };
    }

    // ── 2. Check for merge conflict ─────────────────────
    if (await store.hasMergeConflict()) {
      events.push({
        type: "error",
        message: "Merge conflict in progress. Skipping checkpoint commit.",
      });
      return { events, committed: false };
    }

    // ── 3. Check for changes ────────────────────────────
    const status = await store.checkStatus();
    if (!status.hasChanges) {
      events.push({ type: "info", message: "No changes to checkpoint" });
      events.push({ type: "stage-changed", hasChanges: false });
      return { events, committed: false };
    }

    // ── 4. Stage all files ──────────────────────────────
    if (options?.ignoreSubmodules) {
      await store.stageAllIgnoringSubmodules();
    } else {
      await store.stageAll();
    }

    // ── 5. Skip when nothing became stageable ────────────
    // `git status` can report changes that `git add -A` cannot stage —
    // dirt inside a submodule whose gitlink is unchanged, or
    // .gitignore-hidden entries. Committing then fails with "nothing to
    // commit", which would surface a checkpoint error every turn while
    // the submodule stays dirty. Treat it as a clean skip instead.
    if (!(await store.hasStagedChanges())) {
      events.push({
        type: "info",
        message: "No stageable changes (submodule or ignored content only)",
      });
      events.push({ type: "stage-changed", hasChanges: true });
      return { events, committed: false };
    }

    // ── 6. Execute commit ───────────────────────────────
    // Append Checkpoint-Session / Checkpoint-Branch trailers when available.
    const branch = await store.getCurrentBranch();
    const commitMessage = buildCheckpointMessage(message, sessionId, branch);
    const result = await store.commit(commitMessage);
    if (result.code !== 0) {
      throw new Error(
        `Commit failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }

    committed = true;
    events.push({
      type: "committed",
      message: result.stdout.trim() || message.split("\n")[0],
    });
    events.push({ type: "stage-changed", hasChanges: false });
    return { events, committed };
  } catch (error) {
    // Error boundary: cleanup before re-throwing.
    try {
      await store.unstageAll();
    } catch {
      // Best-effort cleanup
    }
    throw error;
  }
}
