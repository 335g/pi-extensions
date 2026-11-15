import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { GitOperations } from "./git-operations.js";

/**
 * Narrow seam used by the commit reorganiser to interact with the underlying
 * git state.
 *
 * The interface exposes only the operations the reorganiser policy actually
 * needs: repository checks, checkpoint commit inspection, soft reset, staged-material
 * reads, staging manipulation, commit execution, and range-reassembly helpers.
 * This keeps the reorganiser module deep while making the seam real with two
 * adapters: a production wrapper around {@link GitOperations} and an in-memory
 * fake for tests.
 */
export interface ReorganiserStore {
  /** Check whether the current directory is inside a git working tree. */
  isInsideGitRepo(): Promise<boolean>;

  /**
   * Count how many consecutive commits at HEAD match the given marker.
   * The reorganiser uses this to discover checkpoint commits created at
   * `turn_end`.
   *
   * @param sessionId When provided, only count commits whose
   *   `Checkpoint-Session` trailer matches (stops at the first non-matching
   *   subject or trailer).
   */
  countCheckpointCommits(marker: string, sessionId?: string): Promise<number>;

  /** Check whether there are any uncommitted changes in the working tree. */
  checkUncommittedChanges(): Promise<boolean>;

  /**
   * Soft reset the last N commits, keeping their changes staged.
   * Equivalent to `git reset --soft HEAD~N`.
   */
  resetSoft(commitCount: number): Promise<void>;

  /**
   * Read the staged materials needed for commit-message generation:
   * full diff, name-status, and stat summary.
   */
  getStagedMaterials(): Promise<{
    diff: string;
    nameStatus: string;
    stat: string;
  }>;

  /**
   * Staged paths as `git diff --cached --name-status` lines.
   *
   * Bounded by the number of files, not by their content, so it is safe to
   * read on a change set whose diff would not fit in memory.
   */
  getStagedNameStatus(): Promise<string>;

  /**
   * Staged diff, optionally limited to one pathspec (file or directory).
   * Only call with a size measured by {@link getStagedDiffSize} first.
   */
  getStagedDiff(pathspec?: string): Promise<string>;

  /**
   * Byte size of the staged diff (or of one pathspec's slice), measured
   * without reading the diff.
   *
   * Checked before {@link getStagedMaterials} so an oversized change set is
   * rejected before its full diff is materialised (which can abort the whole
   * process). `0` means the measurement failed; callers then rely on the
   * length check of the diff they read.
   */
  getStagedDiffSize(pathspec?: string): Promise<number>;

  /** Unstage all changes. */
  unstageAll(): Promise<void>;

  /**
   * Unstage only the given files, leaving them as uncommitted working-tree
   * changes. Used by the review path for files the user dropped out of the
   * proposed partition.
   */
  unstageFiles(files: string[]): Promise<void>;

  /**
   * Check whether the index contains any staged changes.
   * Returns true when there are staged differences vs HEAD.
   */
  hasStagedChanges(): Promise<boolean>;

  /** Stage only the given files. */
  stageFiles(files: string[]): Promise<void>;

  /** Stage all changes. */
  stageAll(): Promise<void>;

  /**
   * Stage all changes except submodule-related paths (gitlink updates and
   * `.gitmodules`). Used when `ignoreSubmodules` is enabled.
   */
  stageAllIgnoringSubmodules(): Promise<void>;

  /** Execute a commit with the given message. */
  commit(message: string): Promise<ExecResult>;

  /**
   * Read a commit's subject, changed files and committer time, or `null`
   * when `ref` cannot be resolved. Used to detect a "similar previous
   * commit" group for merging.
   */
  getCommitSummary(
    ref: string,
  ): Promise<{ subject: string; files: string[]; committerTime: number } | null>;

  /**
   * Return the last N commits in `%H%x00%s` format, newest first.
   *
   * @param maxCount maximum number of commits to return
   * @param skip number of commits to skip from HEAD (for pagination)
   */
  getRecentCommits(maxCount: number, skip?: number): Promise<string>;

  /**
   * Walk backwards from HEAD and return every reachable commit whose
   * subject starts with `marker`, along with its SHA and
   * `Checkpoint-Session` / `Checkpoint-Branch` trailer values (or `null`
   * when absent).
   */
  findReachableCheckpoints(marker: string): Promise<
    Array<{
      sha: string;
      subject: string;
      session: string | null;
      branch: string | null;
    }>
  >;

  /**
   * Return checkpoint commits reachable from HEAD but not from `ref` — i.e.
   * checkpoints that arrived during this run (typically via a merge of a
   * branch whose agent crashed before `agent_end`).
   */
  findCheckpointsSince(
    ref: string,
    marker: string,
  ): Promise<
    Array<{
      sha: string;
      subject: string;
      session: string | null;
      branch: string | null;
    }>
  >;

  /**
   * Extract the diff of a single commit (relative to its first parent) and
   * apply it to the index via `git apply --cached`.
   *
   * Used for scattered checkpoint reassembly. Returns `{ success: true }`
   * on success, or `{ success: false, error }` when the apply fails.
   */
  applyCommitDiffToIndex(
    sha: string,
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Hard reset HEAD, index, and working tree to a specific commit.
   */
  hardReset(sha: string): Promise<void>;

  /**
   * Compute the diff between two commits and apply it to both the working
   * tree and the index via `git apply --3way --index`.
   */
  applyRangeDiff(
    ancestor: string,
    descendant: string,
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Cherry-pick a single commit onto the current HEAD.
   */
  cherryPick(sha: string): Promise<{ success: boolean; error?: string }>;

  /**
   * Number of local-only commits vs the upstream branch (`0` when HEAD is
   * even with or behind upstream). `null` when no upstream can be resolved.
   *
   * Used as a safety guard: never rewrite commits at or below this index,
   * they already exist on the remote.
   */
  getUpstreamAheadCount(): Promise<number | null>;
}

/**
 * Production adapter: satisfies {@link ReorganiserStore} by delegating to
 * {@link GitOperations}.
 */
export class GitReorganiserStore implements ReorganiserStore {
  constructor(private readonly git: GitOperations) {}

  async isInsideGitRepo(): Promise<boolean> {
    return this.git.isInsideGitRepo();
  }

  async countCheckpointCommits(
    marker: string,
    sessionId?: string,
  ): Promise<number> {
    return this.git.countCheckpointCommits(marker, sessionId);
  }

  async checkUncommittedChanges(): Promise<boolean> {
    return this.git.checkUncommittedChanges();
  }

  async resetSoft(commitCount: number): Promise<void> {
    return this.git.resetSoft(commitCount);
  }

  async getStagedMaterials(): Promise<{
    diff: string;
    nameStatus: string;
    stat: string;
  }> {
    const [diff, nameStatus, stat] = await Promise.all([
      this.git.getStagedDiff(),
      this.git.getStagedNameStatus(),
      this.git.getStagedStat(),
    ]);
    return { diff, nameStatus, stat };
  }

  async getStagedDiffSize(pathspec?: string): Promise<number> {
    return this.git.getStagedDiffSize(pathspec);
  }

  async getStagedNameStatus(): Promise<string> {
    return this.git.getStagedNameStatus();
  }

  async getStagedDiff(pathspec?: string): Promise<string> {
    return this.git.getStagedDiff(pathspec);
  }

  async unstageAll(): Promise<void> {
    return this.git.unstageAll();
  }

  async unstageFiles(files: string[]): Promise<void> {
    return this.git.unstageFiles(files);
  }

  async hasStagedChanges(): Promise<boolean> {
    return this.git.hasStagedChanges();
  }

  async stageFiles(files: string[]): Promise<void> {
    return this.git.stageFiles(files);
  }

  async stageAll(): Promise<void> {
    return this.git.stageAll();
  }

  async stageAllIgnoringSubmodules(): Promise<void> {
    return this.git.stageAllIgnoringSubmodules();
  }

  async commit(message: string): Promise<ExecResult> {
    return this.git.commit(message);
  }

  async getCommitSummary(
    ref: string,
  ): Promise<{ subject: string; files: string[]; committerTime: number } | null> {
    return this.git.getCommitSummary(ref);
  }

  async getRecentCommits(maxCount: number, skip?: number): Promise<string> {
    return this.git.getRecentCommits(maxCount, skip);
  }

  async findReachableCheckpoints(marker: string): Promise<
    Array<{
      sha: string;
      subject: string;
      session: string | null;
      branch: string | null;
    }>
  > {
    return this.git.findReachableCheckpoints(marker);
  }

  async findCheckpointsSince(
    ref: string,
    marker: string,
  ): Promise<
    Array<{
      sha: string;
      subject: string;
      session: string | null;
      branch: string | null;
    }>
  > {
    return this.git.findCheckpointsSince(ref, marker);
  }

  async applyCommitDiffToIndex(
    sha: string,
  ): Promise<{ success: boolean; error?: string }> {
    return this.git.applyCommitDiffToIndex(sha);
  }

  async hardReset(sha: string): Promise<void> {
    return this.git.hardReset(sha);
  }

  async applyRangeDiff(
    ancestor: string,
    descendant: string,
  ): Promise<{ success: boolean; error?: string }> {
    return this.git.applyRangeDiff(ancestor, descendant);
  }

  async cherryPick(sha: string): Promise<{ success: boolean; error?: string }> {
    return this.git.cherryPick(sha);
  }

  async getUpstreamAheadCount(): Promise<number | null> {
    return this.git.getUpstreamAheadCount();
  }
}
