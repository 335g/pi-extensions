import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { GitOperations } from "./git-operations.js";

/**
 * Narrow seam used by the commit reorganiser to interact with the underlying
 * git state.
 *
 * The interface exposes only the operations the reorganiser policy actually
 * needs: repository checks, checkpoint commit inspection, soft reset, staged-material
 * reads, staging manipulation, and commit execution. This keeps the
 * reorganiser module deep (the policy is hidden) while making the seam real
 * with two adapters: a production wrapper around {@link GitOperations} and an
 * in-memory fake for tests.
 */
export interface CommitStore {
  /** Check whether the current directory is inside a git working tree. */
  isInsideGitRepo(): Promise<boolean>;

  /**
   * Get the current HEAD commit SHA, or `null` when it cannot be resolved.
   */
  getHead(): Promise<string | null>;

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

  /** Unstage all changes. */
  unstageAll(): Promise<void>;

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
   * Return the last N commits in `%H%x00%s` format, newest first.
   *
   * @param maxCount maximum number of commits to return
   * @param skip number of commits to skip from HEAD (for pagination)
   */
  getRecentCommits(maxCount: number, skip?: number): Promise<string>;

  /**
   * Walk backwards from HEAD and return every reachable commit whose
   * subject starts with `marker`, along with its SHA and
   * `Checkpoint-Session` trailer value (or `null` when absent).
   */
  findReachableCheckpoints(
    marker: string,
  ): Promise<Array<{ sha: string; subject: string; session: string | null }>>;

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
}

/**
 * Information about a single reachable checkpoint commit, returned by
 * {@link CommitStore.findReachableCheckpoints}.
 */
export interface ReachableCheckpoint {
  sha: string;
  subject: string;
  session: string | null;
}

/**
 * Production adapter: satisfies {@link CommitStore} by delegating to
 * {@link GitOperations}.
 */
export class GitCommitStore implements CommitStore {
  constructor(private readonly git: GitOperations) {}

  async isInsideGitRepo(): Promise<boolean> {
    return this.git.isInsideGitRepo();
  }

  async getHead(): Promise<string | null> {
    return this.git.getHead();
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

  async unstageAll(): Promise<void> {
    return this.git.unstageAll();
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

  async getRecentCommits(maxCount: number, skip?: number): Promise<string> {
    return this.git.getRecentCommits(maxCount, skip);
  }

  async findReachableCheckpoints(
    marker: string,
  ): Promise<Array<{ sha: string; subject: string; session: string | null }>> {
    return this.git.findReachableCheckpoints(marker);
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
}
