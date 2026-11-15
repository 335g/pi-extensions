import type { GitOperations } from "./git-operations.js";

/**
 * Narrow seam used by the commit picker to read commit history.
 *
 * The interface exposes only the operations the picker UI actually needs:
 * HEAD resolution and recent commit listing. This keeps the picker module
 * deep while making the seam real with two adapters: a production wrapper
 * around {@link GitOperations} and an in-memory fake for tests.
 */
export interface PickerStore {
  /** Get the current HEAD commit SHA, or `null` when it cannot be resolved. */
  getHead(): Promise<string | null>;

  /**
   * Return the last N commits in `%H%x00%s` format, newest first.
   *
   * @param maxCount maximum number of commits to return
   * @param skip number of commits to skip from HEAD (for pagination)
   */
  getRecentCommits(maxCount: number, skip?: number): Promise<string>;

  /**
   * SHA of the upstream tip (`@{upstream}`, falling back to `origin/HEAD`),
   * or `null` when no upstream can be resolved.
   */
  getUpstreamTip(): Promise<string | null>;
}

/**
 * Production adapter: satisfies {@link PickerStore} by delegating to
 * {@link GitOperations}.
 */
export class GitPickerStore implements PickerStore {
  constructor(private readonly git: GitOperations) {}

  async getHead(): Promise<string | null> {
    return this.git.getHead();
  }

  async getRecentCommits(maxCount: number, skip?: number): Promise<string> {
    return this.git.getRecentCommits(maxCount, skip);
  }

  async getUpstreamTip(): Promise<string | null> {
    return this.git.getUpstreamTip();
  }
}
