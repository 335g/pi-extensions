import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Result of checking the repository state.
 */
export interface GitStatus {
  hasChanges: boolean;
  raw: string;
}

/**
 * Wrapper around git operations used by the extension.
 *
 * All commands are run via `pi.exec()` so they inherit pi's environment
 * (PATH, SSH keys, git config, etc.).
 */
export class GitOperations {
  constructor(private readonly pi: ExtensionAPI) {}

  /**
   * Get the current HEAD commit SHA.
   * Returns `null` when git is not available or HEAD cannot be resolved.
   */
  async getHead(): Promise<string | null> {
    const { stdout, code } = await this.pi.exec("git", ["rev-parse", "HEAD"]);
    if (code !== 0) {
      return null;
    }
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  }

  /**
   * Check whether the current directory is inside a git working tree.
   * Returns `true` on success, `false` if not a git repo.
   */
  async isInsideGitRepo(): Promise<boolean> {
    const { code } = await this.pi.exec("git", [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    return code === 0;
  }

  /**
   * Run `git status --short` and return whether there are uncommitted changes.
   */
  async checkStatus(): Promise<GitStatus> {
    const { stdout } = await this.pi.exec("git", ["status", "--short"]);
    const trimmed = stdout.trim();
    return { hasChanges: trimmed.length > 0, raw: trimmed };
  }

  /**
   * Stage all changes via `git add -A`.
   */
  async stageAll(): Promise<void> {
    const result = await this.pi.exec("git", ["add", "-A"]);
    if (result.code !== 0) {
      throw new Error(
        `git add -A failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }
  }

  /**
   * Stage all changes except submodule-related paths (`ignoreSubmodules`).
   *
   * Runs `git add -A`, then unstages everything that is a submodule pin from
   * the parent's perspective: gitlink entries (mode 160000 in the index —
   * covering registered submodules and absorbed embedded repositories alike)
   * and `.gitmodules`. Only paths that actually differ from HEAD after the
   * add are unstaged.
   */
  async stageAllIgnoringSubmodules(): Promise<void> {
    await this.stageAll();
    // `-z` keeps paths raw (no core.quotePath quoting, no newline splitting).
    const { stdout } = await this.pi.exec("git", ["ls-files", "-s", "-z"]);
    // `.gitmodules` may not exist; listing it in the pathspec is harmless.
    const candidates = [
      ".gitmodules",
      ...parseGitlinkPaths(stdout).map(([p]) => p),
    ];
    const { stdout: changed } = await this.pi.exec("git", [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--",
      ...candidates,
    ]);
    for (const path of changed.split("\0")) {
      // No trim: leading/trailing spaces are legal filename characters.
      if (path) {
        await this.unstageFile(path);
      }
    }
  }

  /**
   * Get the stat summary of staged changes (`git diff --cached --stat`).
   */
  async getStagedStat(): Promise<string> {
    const { stdout } = await this.pi.exec("git", [
      "-c",
      "core.quotePath=false",
      "diff",
      "--cached",
      "--stat",
    ]);
    return stdout.trim();
  }

  /**
   * Get the full diff of staged changes (`git diff --cached --submodule=log`).
   *
   * `--submodule=log` adds a summary of the commits contained in each
   * submodule (gitlink) change — e.g. `Submodule sub <old>..<new>:` followed
   * by the child commit subjects — so commit-message generation can describe
   * what actually changed inside the submodule instead of only seeing the
   * `Subproject commit` pointer bump. It is a no-op for regular files.
   */
  async getStagedDiff(pathspec?: string): Promise<string> {
    const { stdout } = await this.pi.exec("git", [
      "-c",
      "core.quotePath=false",
      "diff",
      "--cached",
      "--submodule=log",
      ...(pathspec ? ["--", pathspec] : []),
    ]);
    return stdout.trim();
  }

  /**
   * Byte size of the staged diff, measured without materialising it in the
   * extension process.
   *
   * `git diff` output is piped into `wc -c`, so only the digit string reaches
   * JavaScript. Reading the whole diff first (`getStagedDiff`) would allocate
   * one string the size of the patch — hundreds of MB for a node_modules or
   * build-artifact commit — and V8 aborts the process before a size check can
   * run. Callers use this to decide whether the diff may be read at all.
   *
   * @param pathspec When given, measures only that path (file or directory).
   * @returns `0` when the measurement fails, so callers fall back to the
   *   length check on the diff they read anyway.
   */
  async getStagedDiffSize(pathspec?: string): Promise<number> {
    const { stdout, code } = await this.pi.exec("sh", [
      "-c",
      `git -c core.quotePath=false diff --cached --submodule=log${
        pathspec ? ` -- ${shellQuote(pathspec)}` : ""
      } | wc -c`,
    ]);
    const size = Number.parseInt(stdout.trim(), 10);
    return code === 0 && Number.isFinite(size) ? size : 0;
  }

  /**
   * Get the name-status of staged changes (`git diff --cached --name-status`).
   *
   * `core.quotePath=false` keeps non-ASCII paths raw. Every consumer compares
   * these paths against commit-group file lists, which are raw, so a quoted
   * `"\346\227\245.ts"` would never match: the coverage guard would fall back
   * to a single commit and the review path would treat the file as dropped.
   */
  async getStagedNameStatus(): Promise<string> {
    const { stdout } = await this.pi.exec("git", [
      "-c",
      "core.quotePath=false",
      "diff",
      "--cached",
      "--name-status",
    ]);
    return stdout.trim();
  }

  /**
   * Check whether a merge conflict is in progress.
   * Returns `true` if the index is locked (conflict markers present, etc.)
   */
  async hasMergeConflict(): Promise<boolean> {
    // If a merge is in progress, `git diff --cached` may fail or
    // `git ls-files --unmerged` returns non-empty output.
    const { stdout } = await this.pi.exec("git", ["ls-files", "--unmerged"]);
    return stdout.trim().length > 0;
  }

  /**
   * Execute the commit with the given message.
   * Returns the raw stdout output of `git commit`.
   */
  async commit(message: string): Promise<ExecResult> {
    // Disable GPG signing for checkpoint commits: they are temporary and
    // will be reorganised later, so signing adds no value and fails when
    // gpg is not installed.
    return await this.pi.exec("git", [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      message,
    ]);
  }

  /**
   * Read a commit's subject, changed file paths (relative to its first
   * parent) and committer time (UNIX seconds). Returns `null` when `ref`
   * cannot be resolved (e.g. the commit does not exist). Renames report the
   * new path, matching the parser used for the staged diff so file sets are
   * comparable.
   */
  async getCommitSummary(
    ref: string,
  ): Promise<{ subject: string; files: string[]; committerTime: number } | null> {
    const subjectResult = await this.pi.exec("git", [
      "log",
      "-1",
      "--format=%s%x00%ct",
      ref,
    ]);
    if (subjectResult.code !== 0) return null;

    const [subject = "", committerTimeRaw = ""] = subjectResult.stdout
      .trim()
      .split("\0");
    const committerTime = Number.parseInt(committerTimeRaw, 10);
    if (!Number.isFinite(committerTime)) return null;

    const filesResult = await this.pi.exec("git", [
      "diff-tree",
      "--no-commit-id",
      "--name-status",
      "--no-renames",
      "--root",
      "-r",
      ref,
    ]);
    if (filesResult.code !== 0) return null;

    const files = filesResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const parts = line.split("\t");
        return parts[parts.length - 1] ?? "";
      })
      .filter((path) => path.length > 0);

    return { subject, files, committerTime };
  }

  /**
   * Unstage a specific file (`git restore --staged -- <file>`).
   *
   * Throws when the git command fails (non-zero exit), ensuring callers
   * (e.g. the commit pipeline) can detect the failure and abort/clean up
   * instead of silently committing unselected files.
   */
  async unstageFile(file: string): Promise<void> {
    const result = await this.pi.exec("git", [
      "restore",
      "--staged",
      "--",
      file,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `git restore --staged -- ${file} failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }
  }

  /**
   * Unstage only the given files (`git restore --staged -- <file>...`).
   *
   * Used by the review path to leave files the user dropped out of the
   * partition uncommitted instead of sweeping them into a commit.
   */
  async unstageFiles(files: string[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    const result = await this.pi.exec("git", [
      "restore",
      "--staged",
      "--",
      ...files,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `git restore --staged failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }
  }

  /**
   * Unstage all changes (`git reset HEAD --`).
   */
  async unstageAll(): Promise<void> {
    const result = await this.pi.exec("git", ["reset", "HEAD", "--"]);
    if (result.code !== 0) {
      throw new Error(
        `git reset HEAD -- failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }
  }

  /**
   * Check whether there are any uncommitted changes (staged, unstaged, or untracked).
   * Uses `git status --porcelain` for machine-parseable output.
   * Returns true if there are any changes relative to HEAD.
   */
  async checkUncommittedChanges(): Promise<boolean> {
    const { stdout } = await this.pi.exec("git", ["status", "--porcelain"]);
    return stdout.trim().length > 0;
  }

  /**
   * List submodule paths whose checked-out HEAD is a **detached orphan**:
   * it differs from the gitlink recorded in the parent index and is
   * unreachable from any ref (`git for-each-ref --contains HEAD` is empty).
   *
   * Running `git submodule update` in this state checks out the gitlink SHA
   * and discards the orphaned commits (reflog-only survival). Commits that
   * sit on a branch survive an update, so they are not reported.
   *
   * Returns an empty array when the repo has no gitlinks, submodules are in
   * sync, missing/uninitialised, or their HEAD is reachable from a ref.
   */
  async findOrphanedSubmoduleHeads(): Promise<
    Array<{ path: string; indexSha: string; headSha: string }>
  > {
    // Enumerate gitlink entries (mode 160000) from the index. This covers
    // registered submodules and absorbed embedded git repositories alike.
    // `-z` keeps paths raw so non-ASCII names survive intact.
    const { stdout } = await this.pi.exec("git", ["ls-files", "-s", "-z"]);
    const gitlinks = parseGitlinkPaths(stdout);

    const result: Array<{ path: string; indexSha: string; headSha: string }> =
      [];
    for (const [gitlinkPath, gitlinkSha] of gitlinks) {
      const { stdout: headOut, code } = await this.pi.exec("git", [
        "-C",
        gitlinkPath,
        "rev-parse",
        "HEAD",
      ]);
      if (code !== 0) {
        continue; // missing / uninitialised submodule
      }
      const headSha = headOut.trim();
      if (!headSha || headSha === gitlinkSha) {
        continue; // in sync with the parent gitlink
      }
      const { stdout: refs } = await this.pi.exec("git", [
        "-C",
        gitlinkPath,
        "for-each-ref",
        "--contains",
        "HEAD",
        "--format=%(refname:short)",
      ]);
      if (refs.trim()) {
        continue; // reachable from a branch/tag → recoverable after update
      }
      result.push({ path: gitlinkPath, indexSha: gitlinkSha, headSha });
    }
    return result;
  }

  /**
   * Count how many consecutive checkpoint commits exist at HEAD.
   *
   * Walks backwards from HEAD and stops at the first commit whose subject
   * does not start with the given marker (or, when `sessionId` is provided,
   * whose `Checkpoint-Session` trailer does not match).
   *
   * @param marker Subject prefix to match (e.g. `"wip(checkpoint):"`).
   * @param sessionId When provided, only count commits whose
   *   `Checkpoint-Session` trailer equals this value. When omitted, count
   *   every consecutive subject-matching commit (backward-compatible
   *   behaviour).
   */
  async countCheckpointCommits(
    marker: string,
    sessionId?: string,
  ): Promise<number> {
    if (sessionId === undefined) {
      // Original behaviour: subject-prefix match only.
      const { stdout, code } = await this.pi.exec("git", [
        "log",
        "--pretty=format:%s",
        "--no-decorate",
      ]);
      if (code !== 0) {
        return 0;
      }

      const subjects = stdout.split("\n");
      let count = 0;
      for (const subject of subjects) {
        if (subject.startsWith(marker)) {
          count++;
        } else {
          break;
        }
      }
      return count;
    }

    // Session-aware: match subject AND trailer.
    const { stdout, code } = await this.pi.exec("git", [
      "log",
      "--pretty=format:%H%x00%s%x00%(trailers:key=Checkpoint-Session,valueonly,separator=%x00)",
      "--no-decorate",
    ]);
    if (code !== 0) {
      return 0;
    }

    const lines = stdout.trim().split("\n");
    let count = 0;
    for (const line of lines) {
      if (!line) continue;
      const [, subject, trailerSession] = line.split("\0");
      if (subject?.startsWith(marker)) {
        if (trailerSession?.trim() === sessionId) {
          count++;
        } else {
          break; // Non-matching session stops the scan.
        }
      } else {
        break; // Non-checkpoint subject stops the scan.
      }
    }
    return count;
  }

  /**
   * Soft reset the last N commits, keeping their changes staged.
   *
   * When `HEAD~N` exists (normal case), equivalent to `git reset --soft HEAD~N`.
   * When `HEAD~N` does not exist because N >= total commits in the repo
   * (e.g. every commit is a checkpoint), uses `git update-ref -d HEAD` to
   * remove all commits while preserving staged changes.
   */
  async resetSoft(commitCount: number): Promise<void> {
    if (commitCount <= 0) {
      return;
    }

    // Check whether HEAD~N can be resolved.  When N >= total commits this
    // fails ― fall through to the orphan-HEAD path instead of throwing.
    const { code: verifyCode } = await this.pi.exec("git", [
      "rev-parse",
      "--verify",
      `HEAD~${commitCount}`,
    ]);
    if (verifyCode === 0) {
      const result = await this.pi.exec("git", [
        "reset",
        "--soft",
        `HEAD~${commitCount}`,
      ]);
      if (result.code !== 0) {
        throw new Error(
          `git reset --soft HEAD~${commitCount} failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
        );
      }
      return;
    }

    // HEAD~N does not exist: remove all commits while keeping staged changes
    // by making HEAD unborn.  Subsequent operations (git diff --cached,
    // git commit, etc.) all work correctly against an unborn HEAD.
    const result = await this.pi.exec("git", ["update-ref", "-d", "HEAD"]);
    if (result.code !== 0) {
      throw new Error(
        `git update-ref -d HEAD failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }
  }

  /**
   * Check whether the index contains any staged changes.
   * Uses `git diff --cached --quiet`: exit code 1 means there are differences,
   * 0 means the index matches HEAD.
   */
  async hasStagedChanges(): Promise<boolean> {
    const { code } = await this.pi.exec("git", ["diff", "--cached", "--quiet"]);
    return code === 1;
  }

  /**
   * Stage only the given files (`git add -- <file>...`).
   */
  async stageFiles(files: string[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    const result = await this.pi.exec("git", ["add", "--", ...files]);
    if (result.code !== 0) {
      throw new Error(
        `git add failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }
  }

  /**
   * Get the name of the current branch, or `null` when HEAD is detached or
   * git cannot resolve it. Used for the `Checkpoint-Branch` trailer.
   */
  async getCurrentBranch(): Promise<string | null> {
    const { stdout, code } = await this.pi.exec("git", [
      "branch",
      "--show-current",
    ]);
    if (code !== 0) return null;
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  }

  /**
   * Return the last N commits in `%H%x00%s` format (with session/branch
   * trailers appended after the subject), newest first.
   */
  async getRecentCommits(maxCount: number, skip = 0): Promise<string> {
    const args = ["log"];
    if (skip > 0) args.push(`--skip=${skip}`);
    args.push(
      `--max-count=${maxCount}`,
      "--pretty=format:%H%x00%s%x00%(trailers:key=Checkpoint-Session,valueonly,separator=%x00)%x00%(trailers:key=Checkpoint-Branch,valueonly,separator=%x00)",
      "--no-decorate",
    );
    const { stdout } = await this.pi.exec("git", args);
    return stdout;
  }

  /**
   * Resolve the SHA of the upstream tip (`@{upstream}`, falling back to
   * `origin/HEAD` when the branch has no upstream). Returns `null` when
   * neither ref can be resolved.
   */
  async getUpstreamTip(): Promise<string | null> {
    const candidates = ["@{upstream}", "origin/HEAD"];
    for (const ref of candidates) {
      const { stdout, code } = await this.pi.exec("git", [
        "rev-parse",
        "--verify",
        ref,
      ]);
      if (code !== 0) continue;
      const tip = stdout.trim();
      if (tip) return tip;
    }
    return null;
  }

  /**
   * Count how many commits on HEAD are not on the upstream branch
   * (`git rev-list --count <upstream>..HEAD`). On a linear history this is
   * the index of the upstream tip relative to HEAD — reorganising any range
   * whose oldest commit is at or below this index rewrites already-pushed
   * commits.
   *
   * Returns `null` when no upstream can be resolved (nothing to protect
   * against).
   */
  async getUpstreamAheadCount(): Promise<number | null> {
    const tip = await this.getUpstreamTip();
    if (!tip) return null;
    const { stdout, code } = await this.pi.exec("git", [
      "rev-list",
      "--count",
      `${tip}..HEAD`,
    ]);
    if (code !== 0) return null;
    const count = parseInt(stdout.trim(), 10);
    return Number.isFinite(count) && count >= 0 ? count : null;
  }

  /**
   * Walk backwards from HEAD and return every reachable commit whose subject
   * starts with `marker`, along with its SHA, `Checkpoint-Session` and
   * `Checkpoint-Branch` trailer values (or `null` when absent).
   *
   * Uses `%(trailers:key=...,valueonly)` so the trailer value is the empty
   * string (not `"NONE"`) when the key is missing — which becomes `null`
   * after `.trim() || null`.
   */
  async findReachableCheckpoints(marker: string): Promise<
    Array<{
      sha: string;
      subject: string;
      session: string | null;
      branch: string | null;
    }>
  > {
    const { stdout, code } = await this.pi.exec("git", [
      "log",
      "--pretty=format:%H%x00%s%x00%(trailers:key=Checkpoint-Session,valueonly,separator=%x00)%x00%(trailers:key=Checkpoint-Branch,valueonly,separator=%x00)",
      "--no-decorate",
    ]);
    if (code !== 0) return [];
    return parseCheckpointLog(stdout, marker);
  }

  /**
   * Return checkpoint commits reachable from HEAD but not from `ref` — i.e.
   * checkpoints that arrived during this run, typically via a merge of a
   * branch whose agent crashed before `agent_end` reorganisation.
   */
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
    const { stdout, code } = await this.pi.exec("git", [
      "log",
      "--pretty=format:%H%x00%s%x00%(trailers:key=Checkpoint-Session,valueonly,separator=%x00)%x00%(trailers:key=Checkpoint-Branch,valueonly,separator=%x00)",
      "--no-decorate",
      `${ref}..HEAD`,
    ]);
    if (code !== 0) return [];
    return parseCheckpointLog(stdout, marker);
  }

  /**
   * Extract the diff of a single commit (relative to its first parent) and
   * apply it to the index via `git apply --cached`.
   *
   * Used for scattered checkpoint reassembly: when target-session checkpoints
   * are interleaved with foreign checkpoints, each target commit's diff is
   * staged independently without moving HEAD.
   *
   * Returns `{ success: true }` on success, or `{ success: false, error }
   * when the apply fails (e.g. conflict).
   */
  async applyCommitDiffToIndex(
    sha: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Get the first parent of the commit.
    const { stdout: parent, code: parentCode } = await this.pi.exec("git", [
      "rev-parse",
      `${sha}^`,
    ]);
    if (parentCode !== 0 || !parent.trim()) {
      return { success: false, error: `No parent for commit ${sha}` };
    }

    const parentSha = parent.trim();

    // Pipe `git diff <parent> <sha>` into `git apply --3way --cached`.
    // --3way enables a 3-way merge fallback when the patch context doesn't
    // match exactly, which is common when applying scattered checkpoints
    // sequentially where later patches depend on earlier ones.
    const { code, stderr } = await this.pi.exec("sh", [
      "-c",
      `git diff ${parentSha} ${sha} | git apply --3way --cached`,
    ]);
    if (code !== 0) {
      return {
        success: false,
        error: stderr.trim() || `git apply --3way --cached failed for ${sha}`,
      };
    }
    return { success: true };
  }

  /**
   * Hard reset HEAD, index, and working tree to a specific commit.
   * Equivalent to `git reset --hard <sha>`.
   */
  async hardReset(sha: string): Promise<void> {
    const result = await this.pi.exec("git", ["reset", "--hard", sha]);
    if (result.code !== 0) {
      throw new Error(
        `git reset --hard ${sha} failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }
  }

  /**
   * Compute the diff between two commits and apply it to both the working
   * tree and the index via `git apply --3way --index`.
   *
   * Pipe is used so the diff is streamed rather than written to a temp file.
   */
  async applyRangeDiff(
    ancestor: string,
    descendant: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { code, stderr } = await this.pi.exec("sh", [
      "-c",
      `git diff ${ancestor} ${descendant} | git apply --3way --index`,
    ]);
    if (code !== 0) {
      return {
        success: false,
        error:
          stderr.trim() ||
          `git apply --3way --index failed for ${ancestor}..${descendant}`,
      };
    }
    return { success: true };
  }

  /**
   * Cherry-pick a single commit onto the current HEAD.
   * Returns `{ success: true }` on success, or `{ success: false, error }`
   * when the cherry-pick fails (e.g. conflict).
   */
  async cherryPick(sha: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.pi.exec("git", ["cherry-pick", sha]);
    if (result.code !== 0) {
      // Abort the cherry-pick so the repo is not left in a conflicted state.
      await this.pi.exec("git", ["cherry-pick", "--abort"]).catch(() => {});
      return {
        success: false,
        error:
          result.stderr.trim() ||
          `git cherry-pick ${sha} failed (code ${result.code})`,
      };
    }
    return { success: true };
  }
}

/**
 * Parse NUL-separated `git ls-files -s -z` output into `[path, sha]` pairs
 * for gitlink entries (file mode 160000). This covers registered submodules
 * and absorbed embedded git repositories alike, with any path spelling
 * (spaces, quotes, non-ASCII) since `-z` output is never quoted.
 */
function parseGitlinkPaths(stdout: string): Array<[string, string]> {
  const gitlinks: Array<[string, string]> = [];
  for (const entry of stdout.split("\0")) {
    const match = entry.match(/^160000 ([0-9a-f]{40}) \d+\t(.+)$/s);
    if (match) {
      gitlinks.push([match[2], match[1]]);
    }
  }
  return gitlinks;
}

/**
 * Parse the `%H%x00%s%x00%(trailers...)` log output into checkpoint entries,
 * keeping only commits whose subject starts with `marker`.
 */
function parseCheckpointLog(
  stdout: string,
  marker: string,
): Array<{
  sha: string;
  subject: string;
  session: string | null;
  branch: string | null;
}> {
  const result: Array<{
    sha: string;
    subject: string;
    session: string | null;
    branch: string | null;
  }> = [];
  const lines = stdout.trim().split("\n");
  for (const line of lines) {
    if (!line) continue;
    const [sha, subject, sessionRaw, branchRaw] = line.split("\0");
    if (subject?.startsWith(marker)) {
      result.push({
        sha,
        subject,
        session: sessionRaw?.trim() || null,
        branch: branchRaw?.trim() || null,
      });
    }
  }
  return result;
}

/**
 * Wrap a string for single-quoted use inside a `sh -c` command.
 * Single quotes are the only character a POSIX shell cannot escape inside
 * single quotes, so they are spliced in as `'\''`.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
