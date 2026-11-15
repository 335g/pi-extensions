import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { OrganiseMode } from "./config.js";

/**
 * Number of un-reorganised checkpoint commits that forces a reorganisation at
 * `turn_end`, regardless of task boundaries.
 *
 * Boundaries (`input`, push, `agent_end`) are the normal trigger. A single
 * prompt that runs dozens of tool turns without any of them would otherwise
 * accumulate one change set for the whole run, so this caps the pending window.
 */
export const BACKSTOP_REORGANISE_AT = 10;

/**
 * Whether the turn backstop should reorganise now.
 *
 * `picker` and `review` cannot decide without the user, so they keep the single
 * `agent_end` pass.
 */
export function shouldReorganiseAtBackstop(
  pendingCheckpoints: number,
  organiseMode: OrganiseMode,
): boolean {
  return (
    organiseMode === "auto" && pendingCheckpoints >= BACKSTOP_REORGANISE_AT
  );
}

/**
 * Detect a `git ... push` invocation inside a shell command.
 *
 * A push is not blocked, but it suspends the agent loop to reorganise the
 * pending checkpoint run first: pushing before reorganisation ships
 * `wip(checkpoint)` history to the remote and makes the reorganiser skip it
 * later.
 *
 * @returns `true` when any segment contains a `git ... push` invocation.
 */
export function isGitPushCommand(command: string): boolean {
  return shouldBlockGitVerb(command, "push");
}

/**
 * Tools that may have changed files in the working tree.
 *
 * Read-only tools (`read`, `grep`, `find`, `ls`) are intentionally excluded.
 * `bash` is included because many file mutations happen through shell commands
 * (`sed`, `make`, `npm install`, ...). The final authority is `git status`, so
 * a non-mutating `bash` command simply results in no checkpoint commit.
 */
const POTENTIALLY_MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

/**
 * Decide whether the turn just performed a file mutation worth checkpointing.
 *
 * This is a fast heuristic. It checks `toolResults` to see whether any tool
 * that may mutate files was invoked. Callers should still verify with
 * `git status` that the working tree actually changed before creating a checkpoint
 * commit.
 *
 * @param toolResults - Tool results emitted in `turn_end`.
 */
export function shouldCreateCheckpointCommit(
  toolResults: ToolResultMessage[],
): boolean {
  if (!toolResults || toolResults.length === 0) {
    return false;
  }
  return toolResults.some((r) => POTENTIALLY_MUTATING_TOOLS.has(r.toolName));
}

/**
 * Git guard — blocks agent-initiated `git commit` and `git reset --hard`
 * during the agent loop.
 *
 * When `enable` is true, pi-autocommit owns commits via the
 * checkpoint-then-reorganise strategy. An agent committing on its own
 * interleaves a foreign commit into the checkpoint run at HEAD, which
 * makes reorganisation skip everything below it. `reset --hard` is the one
 * irrecoverable case: it discards the working tree, including changes the
 * current turn made after the last checkpoint.
 *
 * Everything else — `push`, `merge`, `cherry-pick`, `rebase`, `add`,
 * `stash`, `fetch` — is allowed, because the agent needs those to do real
 * work. Pushed history is protected on the other side: the reorganiser caps
 * its range at the upstream tip, so it never rewrites pushed checkpoints.
 */

/**
 * Split a shell command string into segments that could each be a
 * distinct command, then test each segment for a `git ... <verb>`
 * invocation.
 *
 * Splits on `&&`, `||`, `;`, `|`, and newlines — the shell operators
 * that separate commands. Quoted substrings are *not* unescaped: the
 * segment retains its quotes, so `sh -c "git commit"` stays inside one
 * segment and the `git commit` inside the quotes is detected.
 *
 * Within each segment, the pattern `/\bgit\b(?:\s+\S+)*\s+<verb>/`
 * matches `git` followed by zero or more global options (e.g.
 * `-C /path`) followed by `<verb>`. This catches:
 *
 * - `git commit -m "..."` / `git -C /path commit`
 * - `sh -c "git commit"` (quotes stay in the segment)
 *
 * @returns `true` when any segment contains a `git ... <verb>` invocation.
 */
function shouldBlockGitVerb(command: string, verb: string): boolean {
  if (!command) {
    return false;
  }

  // Split on shell command separators: &&, ||, ;, |, and newlines.
  // A literal `|` inside quotes would wrongly split, but the resulting
  // segments still contain `git commit` if present, so a false split
  // cannot cause a false negative — only a redundant check.
  const segments = command.split(/&&|\|\||;|\||\n/);

  // `git` optionally followed by global options, then the verb as a
  // standalone word (followed by whitespace or end of segment). The
  // lookahead `(?=\s|$)` prevents matching a verb inside a filename
  // like `commit-message.txt`.
  const pattern = new RegExp(`\\bgit\\b(?:\\s+\\S+)*\\s+${verb}(?=\\s|$)`);

  return segments.some((segment) => pattern.test(segment));
}

/**
 * Detect a `git ... commit` invocation inside a shell command.
 *
 * @returns `true` when any segment contains a `git ... commit` invocation.
 */
export function shouldBlockGitCommit(command: string): boolean {
  return shouldBlockGitVerb(command, "commit");
}

/**
 * Detect a `git ... reset --hard` invocation inside a shell command.
 *
 * `git reset --soft` / `--mixed` (the default) only move HEAD and staging and
 * are left alone — agents legitimately use them to inspect and rewind history.
 * `--hard` additionally destroys the working tree, which can wipe changes made
 * in the current turn before the next checkpoint captures them.
 *
 * @returns `true` when any segment contains a `git ... reset` invocation and a
 *   `--hard` flag.
 */
export function shouldBlockGitHardReset(command: string): boolean {
  if (!command) {
    return false;
  }

  const segments = command.split(/&&|\|\||;|\||\n/);
  const resetPattern = /\bgit\b(?:\s+\S+)*\s+reset(?=\s|$)/;
  return segments.some(
    (segment) => resetPattern.test(segment) && /--hard\b/.test(segment),
  );
}

/** The git operations the guard can block. */
export type BlockedGitOperation = "commit" | "reset --hard" | "push";

/** Footer note appended to every block reason. */
const DISABLE_NOTE_JA =
  "無効化するには `/autocommit-enable false` を実行してください。";
const DISABLE_NOTE_EN =
  "To disable this guard, run `/autocommit-enable false`.";

/**
 * Build the user-facing block reason for a blocked git operation.
 *
 * Explains why the operation is blocked and how to disable the guard
 * (`/autocommit-enable false`). Written in Japanese when `japanese` is true,
 * English otherwise. When `enable` is false the guard is inert and neither
 * operation is blocked.
 */
export function buildBlockReason(
  blocked: BlockedGitOperation,
  japanese: boolean,
): string {
  if (japanese) {
    switch (blocked) {
      case "push":
        return (
          "pi-autocommit: 未整理のチェックポイントを整理できなかったため push をブロックしました。" +
          "`/autocommit-organise` で整理してから、もう一度 push してください。" +
          DISABLE_NOTE_JA
        );
      case "reset --hard":
        return (
          "pi-autocommit: エージェントループ中の `git reset --hard` はインデックスと作業ツリーを破棄するためブロックされました。" +
          "履歴を戻すには `git reset --soft` を、変更を捨てる必要がある場合は turn_end のチェックポイントに任せてください。" +
          DISABLE_NOTE_JA
        );
      default:
        return (
          "pi-autocommit がコミット履歴を管理しているため、エージェントループ中の `git commit` はブロックされました。" +
          "turn_end でチェックポイントコミットが自動作成され、一定件数ごとと agent_end で論理的な Conventional Commits に整理されます。" +
          "手動でコミットする必要はありません。push や merge などの他の git 操作は許可されています。" +
          DISABLE_NOTE_JA
        );
    }
  }

  switch (blocked) {
    case "push":
      return (
        "pi-autocommit: the push was blocked because the pending checkpoint commits could not be reorganised. " +
        "Run `/autocommit-organise`, then push again. " +
        DISABLE_NOTE_EN
      );
    case "reset --hard":
      return (
        "pi-autocommit: `git reset --hard` is blocked during the agent loop because it destroys the index and the working tree. " +
        "To rewind history use `git reset --soft`; to discard changes, rely on the turn_end checkpoint. " +
        DISABLE_NOTE_EN
      );
    default:
      return (
        "pi-autocommit manages the commit history, so `git commit` is blocked during the agent loop. " +
        "Checkpoint commits are created at turn_end and reorganised into logical Conventional Commits whenever a task boundary arrives. " +
        "There is no need to commit manually. Other git operations such as push and merge are allowed. " +
        DISABLE_NOTE_EN
      );
  }
}

/**
 * Decide whether the commit reorganiser should be skipped at `agent_end`.
 *
 * Returns `true` when the HEAD commit captured at `agent_start` matches the
 * current HEAD. This means the agent run produced no commits, so there is
 * nothing to reorganise.
 *
 * A `null` baseline (e.g., HEAD could not be read at `agent_start`) is treated
 * as "unknown", so the reorganiser proceeds with its normal behaviour rather
 * than risk silently skipping a real reorganisation.
 */
export function shouldSkipReorganisation(
  baselineHead: string | null,
  currentHead: string | null,
): boolean {
  if (baselineHead === null || currentHead === null) {
    return false;
  }
  return baselineHead === currentHead;
}
