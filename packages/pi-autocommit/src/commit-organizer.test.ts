import assert from "node:assert";
import { describe, it } from "node:test";
import type {
  AgentEndEvent,
  ExecResult,
} from "@earendil-works/pi-coding-agent";
import {
  bucketByTopLevelPath,
  CHECKPOINT_COMMIT_MARKER,
  fileSetOverlap,
  organizeCheckpointCommits,
  reorganiseCheckpointsManual,
  reorganiseSelectedRange,
} from "./commit-organizer.js";
import {
  type CompleteFn,
  completeCommitGroups,
  MAX_LLM_DIFF_CHARS,
} from "./commit-prompt.js";
import type { PiAutocommitConfig } from "./config.js";
import type { ReorganiserStore } from "./reorganiser-store.js";

/** Minimal model stub for fake adapters. */
const stubModel = { id: "test-model" } as unknown as Parameters<CompleteFn>[0];

function fakeCompleteReturning(text: string): CompleteFn {
  return async () =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
    }) as never;
}

function makeCtx(model: unknown) {
  return {
    model,
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    },
  } as never;
}

function config(over: Partial<PiAutocommitConfig> = {}): PiAutocommitConfig {
  return {
    lang: "en",
    enable: true,
    commitPickerMaxCommits: 30,
    ignoreSubmodules: false,
    mergeSimilarPrevious: false,
    organiseMode: "auto",
  detectTaskBoundary: false,
    ...over,
  };
}

void describe("completeCommitGroups parsing", () => {
  void it("returns an empty array when the LLM returns empty groups", async () => {
    const complete = fakeCompleteReturning("");
    await assert.rejects(
      completeCommitGroups(
        makeCtx(stubModel),
        config(),
        { diff: "diff", reasoning: "" },
        complete,
      ),
      /Empty LLM response/,
    );
  });

  void it("parses a single commit group", async () => {
    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login

Implement login with JWT.
=== FILES ===
src/auth/login.ts
src/auth/types.ts
=== END ===
`.trim();
    const complete = fakeCompleteReturning(input);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      config(),
      { diff: "diff", reasoning: "" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat(auth): add JWT login\n\nImplement login with JWT.",
        files: ["src/auth/login.ts", "src/auth/types.ts"],
      },
    ]);
  });

  void it("parses multiple commit groups", async () => {
    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login

Implement login.
=== FILES ===
src/auth/login.ts
=== END ===
=== COMMIT 2 ===
refactor(db): extract query builder

Move query logic.
=== FILES ===
src/db/query.ts
=== END ===
`.trim();
    const complete = fakeCompleteReturning(input);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      config(),
      { diff: "diff", reasoning: "" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat(auth): add JWT login\n\nImplement login.",
        files: ["src/auth/login.ts"],
      },
      {
        message: "refactor(db): extract query builder\n\nMove query logic.",
        files: ["src/db/query.ts"],
      },
    ]);
  });

  void it("ignores blocks without a files section", async () => {
    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
src/auth/login.ts
=== END ===
=== COMMIT 2 ===
invalid commit without files
=== END ===
`.trim();
    const complete = fakeCompleteReturning(input);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      config(),
      { diff: "diff", reasoning: "" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat(auth): add JWT login",
        files: ["src/auth/login.ts"],
      },
    ]);
  });

  void it("ignores empty file lines and comments", async () => {
    const input = `
=== COMMIT 1 ===
chore(deps): update lockfile
=== FILES ===

# this is a comment
package-lock.json

=== END ===
`.trim();
    const complete = fakeCompleteReturning(input);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      config(),
      { diff: "diff", reasoning: "" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "chore(deps): update lockfile",
        files: ["package-lock.json"],
      },
    ]);
  });
});

// ── In-memory ReorganiserStore for tests ────────────────────────

/**
 * Description of one checkpoint commit in the in-memory store.
 *
 * `session` may be set to simulate the `Checkpoint-Session` trailer;
 * `branch` simulates the `Checkpoint-Branch` trailer.
 */
interface CheckpointCommit {
  message: string;
  files: string[];
  session?: string | null;
  branch?: string | null;
  /** Committer time (UNIX seconds) used for previous-group boundaries. */
  committerTime?: number;
}

/**
 * In-memory ReorganiserStore for testing the reorganiser policy without a real git
 * repository. Tracks staged files and committed messages so tests can assert
 * on the sequence of operations and the final state.
 */
class InMemoryReorganiserStore implements ReorganiserStore {
  public commits: string[] = [];
  public stagedFiles: string[] = [];
  public operations: string[] = [];

  constructor(
    private readonly options: {
      insideRepo?: boolean;
      /** Ordered from HEAD (index 0) backward. */
      checkpointCommits?: CheckpointCommit[];
      /**
       * File paths that are considered "already committed" — staging them
       * produces no staged changes (simulates duplicate files across groups).
       */
      alreadyCommitted?: string[];
      /**
       * Override the default commit return value. When set, every call to
       * `commit()` returns this instead of the default success response.
       */
      commitResult?: ExecResult;
      /**
       * Per-bucket byte sizes returned by `getStagedDiffSize(pathspec)`.
       * `0` means "unknown" (the fake's default), which makes the proposer
       * read that bucket's diff instead of its manifest.
       */
      bucketSizes?: Record<string, number>;
      /**
       * Value returned by `getUpstreamAheadCount()` (default `null` =
       * no upstream configured).
       */
      upstreamAheadCount?: number | null;
      /** When set, `cherryPick()` returns this failure. */
      cherryPickError?: string;
      /**
       * When true, `getStagedDiffSize()` reports a size just above the LLM cap
       * so the reorganisation splits the change set by path bucket without
       * reading any diff.
       */
      oversizedDiff?: boolean;
      /**
       * When true, `getStagedDiffSize()` reports a size above the hard cap so
       * the reorganisation must abort without committing.
       */
      hugeDiff?: boolean;
    } = {},
  ) {
    // Normalise session to null when absent.
    for (const w of this.options.checkpointCommits ?? []) {
      if (w.session === undefined) w.session = null;
    }
  }

  async isInsideGitRepo(): Promise<boolean> {
    this.operations.push("isInsideGitRepo");
    return this.options.insideRepo ?? true;
  }

  async countCheckpointCommits(
    marker: string,
    sessionId?: string,
  ): Promise<number> {
    this.operations.push(
      `countCheckpointCommits:${marker}${sessionId !== undefined ? `:${sessionId}` : ""}`,
    );
    const commits = this.options.checkpointCommits ?? [];
    let count = 0;
    for (const commit of commits) {
      if (!commit.message.startsWith(marker)) break;
      if (sessionId !== undefined) {
        if (commit.session === sessionId) {
          count++;
        } else {
          break; // Non-matching session stops the scan.
        }
      } else {
        count++;
      }
    }
    return count;
  }

  async checkUncommittedChanges(): Promise<boolean> {
    this.operations.push("checkUncommittedChanges");
    return this.stagedFiles.length > 0;
  }

  async resetSoft(commitCount: number): Promise<void> {
    this.operations.push(`resetSoft:${commitCount}`);
    const commits = this.options.checkpointCommits ?? [];
    const removed = commits.splice(0, commitCount);
    for (const commit of removed) {
      for (const file of commit.files) {
        if (!this.stagedFiles.includes(file)) {
          this.stagedFiles.push(file);
        }
      }
    }
  }

  async getStagedMaterials(): Promise<{
    diff: string;
    nameStatus: string;
    stat: string;
  }> {
    this.operations.push("getStagedMaterials");
    const nameStatus = this.stagedFiles.map((file) => `M\t${file}`).join("\n");
    return {
      diff: this.options.oversizedDiff
        ? "x".repeat(MAX_LLM_DIFF_CHARS + 1)
        : this.stagedFiles
            .map((file) => `diff --git a/${file} b/${file}`)
            .join("\n"),
      nameStatus,
      stat: this.stagedFiles.map((file) => `${file} | 1 +`).join("\n"),
    };
  }

  async getStagedNameStatus(): Promise<string> {
    this.operations.push("getStagedNameStatus");
    return this.stagedFiles.map((file) => `M\t${file}`).join("\n");
  }

  async getStagedDiff(pathspec?: string): Promise<string> {
    this.operations.push(`getStagedDiff${pathspec ? `:${pathspec}` : ""}`);
    return this.bucket(pathspec)
      .map((file) => `diff --git a/${file} b/${file}`)
      .join("\n");
  }

  async getStagedDiffSize(pathspec?: string): Promise<number> {
    this.operations.push(`getStagedDiffSize${pathspec ? `:${pathspec}` : ""}`);
    const sized = pathspec ? this.options.bucketSizes?.[pathspec] : undefined;
    if (sized !== undefined) return sized;
    if (this.options.hugeDiff) return MAX_LLM_DIFF_CHARS * 200;
    if (this.options.oversizedDiff) return MAX_LLM_DIFF_CHARS + 1;
    return 0;
  }

  /** Staged files under one top-level path bucket. */
  private bucket(pathspec?: string): string[] {
    if (!pathspec) return this.stagedFiles;
    return this.stagedFiles.filter(
      (file) => file === pathspec || file.startsWith(`${pathspec}/`),
    );
  }

  async unstageAll(): Promise<void> {
    this.operations.push("unstageAll");
    this.stagedFiles = [];
  }

  async unstageFiles(files: string[]): Promise<void> {
    this.operations.push(`unstageFiles:${files.join(",")}`);
    this.stagedFiles = this.stagedFiles.filter((f) => !files.includes(f));
  }

  async hasStagedChanges(): Promise<boolean> {
    this.operations.push("hasStagedChanges");
    return this.stagedFiles.length > 0;
  }

  async stageFiles(files: string[]): Promise<void> {
    this.operations.push(`stageFiles:${files.join(",")}`);
    const committed = this.options.alreadyCommitted ?? [];
    this.stagedFiles = files.filter((f) => !committed.includes(f));
  }

  async stageAll(): Promise<void> {
    this.operations.push("stageAll");
  }

  async stageAllIgnoringSubmodules(): Promise<void> {
    this.operations.push("stageAllIgnoringSubmodules");
  }

  async commit(message: string): Promise<ExecResult> {
    this.operations.push(`commit:${message.split("\n")[0]}`);
    this.commits.push(message);
    this.stagedFiles = [];
    return (
      this.options.commitResult ?? {
        code: 0,
        stdout: "",
        stderr: "",
        killed: false,
      }
    );
  }

  async getCommitSummary(
    ref: string,
  ): Promise<{ subject: string; files: string[]; committerTime: number } | null> {
    this.operations.push(`getCommitSummary:${ref}`);
    const match = /^HEAD~(\d+)$/.exec(ref);
    if (!match) return null;
    const commit = this.options.checkpointCommits?.[Number(match[1])];
    if (!commit) return null;
    return {
      subject: commit.message,
      files: commit.files,
      committerTime: commit.committerTime ?? 0,
    };
  }

  async getRecentCommits(maxCount: number, _skip?: number): Promise<string> {
    this.operations.push(`getRecentCommits:${maxCount}`);
    const commits = this.options.checkpointCommits ?? [];
    return commits
      .slice(0, maxCount)
      .map((c, i) => `sha-${i}\0${c.message}`)
      .join("\n");
  }

  async findReachableCheckpoints(marker: string): Promise<
    Array<{
      sha: string;
      subject: string;
      session: string | null;
      branch: string | null;
    }>
  > {
    this.operations.push(`findReachableCheckpoints:${marker}`);
    const commits = this.options.checkpointCommits ?? [];
    return commits.map((c, i) => ({
      sha: `sha-${i}`,
      subject: c.message,
      session: c.session ?? null,
      branch: c.branch ?? null,
    }));
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
    this.operations.push(`findCheckpointsSince:${ref}:${marker}`);
    const commits = this.options.checkpointCommits ?? [];
    return commits.map((c, i) => ({
      sha: `sha-${i}`,
      subject: c.message,
      session: c.session ?? null,
      branch: c.branch ?? null,
    }));
  }

  async applyCommitDiffToIndex(
    sha: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.operations.push(`applyCommitDiffToIndex:${sha}`);
    const [, indexStr] = sha.split("-");
    const index = parseInt(indexStr, 10);
    const commit = this.options.checkpointCommits?.[index];
    if (commit) {
      for (const file of commit.files) {
        if (!this.stagedFiles.includes(file)) {
          this.stagedFiles.push(file);
        }
      }
    }
    return { success: true };
  }

  async hardReset(_sha: string): Promise<void> {
    this.operations.push(`hardReset:${_sha}`);
    this.stagedFiles = [];
  }

  async applyRangeDiff(
    ancestor: string,
    descendant: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.operations.push(`applyRangeDiff:${ancestor}..${descendant}`);
    if (this.stagedFiles.length === 0 && this.options.checkpointCommits) {
      // Stage only the files inside the range, mirroring `git apply --index`
      // of the range diff. SHAs are "sha-<index>" (0 = HEAD): descendant is
      // the range start (index lo), ancestor is before the range (hi+1).
      const lo = parseInt(descendant.replace("sha-", ""), 10);
      const hiExclusive = parseInt(ancestor.replace("sha-", ""), 10);
      if (
        Number.isFinite(lo) &&
        Number.isFinite(hiExclusive) &&
        lo < hiExclusive
      ) {
        for (const commit of this.options.checkpointCommits.slice(
          lo,
          hiExclusive,
        )) {
          for (const file of commit.files) {
            if (!this.stagedFiles.includes(file)) {
              this.stagedFiles.push(file);
            }
          }
        }
      }
    }
    return { success: true };
  }

  async cherryPick(
    _sha: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.operations.push(`cherryPick:${_sha}`);
    if (this.options.cherryPickError) {
      return { success: false, error: this.options.cherryPickError };
    }
    return { success: true };
  }

  async getUpstreamAheadCount(): Promise<number | null> {
    this.operations.push("getUpstreamAheadCount");
    return this.options.upstreamAheadCount ?? null;
  }
}

function makeEvent(): AgentEndEvent {
  return { messages: [] } as unknown as AgentEndEvent;
}

// ── organizeCheckpointCommits (agent_end) ─────────────────────────

/** LLM stub that returns one canned response per call, in order. */
function fakeCompleteSequence(texts: string[]): {
  complete: CompleteFn;
  prompts: string[];
} {
  const prompts: string[] = [];
  let index = 0;
  const complete: CompleteFn = async (_model, context) => {
    prompts.push(context.messages.map((m) => m.content).join("\n"));
    const text = texts[Math.min(index, texts.length - 1)];
    index++;
    return {
      role: "assistant",
      content: [{ type: "text", text }],
    } as never;
  };
  return { complete, prompts };
}

void describe("bucketByTopLevelPath", () => {
  void it("groups by the first path segment and keeps first-seen order", () => {
    const buckets = bucketByTopLevelPath([
      "src/a.ts",
      "docs/readme.md",
      "src/nested/b.ts",
      "package.json",
    ]);

    assert.deepStrictEqual([...buckets], [
      ["src", ["src/a.ts", "src/nested/b.ts"]],
      ["docs", ["docs/readme.md"]],
      ["package.json", ["package.json"]],
    ]);
  });
});

void describe("chunked proposal for oversized staged diffs", () => {
  /**
   * Over the LLM byte budget the change set is split by top-level path: each
   * bucket is measured on its own, sent as a diff when it fits and as a
   * name-status manifest when it does not. The whole diff is never read.
   */
  void it("sends each bucket separately, as a diff or as a manifest", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts", "src/b.ts", "docs/guide.md"],
        },
      ],
      // Whole-tree diff is over the budget …
      oversizedDiff: true,
      // … but `src` fits once measured on its own, so it gets a real diff.
      bucketSizes: { src: 120 },
    });

    const { complete, prompts } = fakeCompleteSequence([
      "=== COMMIT 1 ===\nfeat(src): add a and b\n=== FILES ===\nsrc/a.ts\nsrc/b.ts\n=== END ===",
      "=== COMMIT 1 ===\ndocs: add guide\n=== FILES ===\ndocs/guide.md\n=== END ===",
    ]);

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      complete,
    );

    assert.strictEqual(result.organised, true);
    assert.deepStrictEqual(store.commits, [
      "feat(src): add a and b",
      "docs: add guide",
    ]);
    assert.strictEqual(prompts.length, 2);
    // `src` bucket: real diff content.
    assert.ok(prompts[0].includes("diff --git a/src/a.ts"));
    // `docs` bucket: manifest only, no diff for it was read.
    assert.ok(prompts[1].includes("M\tdocs/guide.md"));
    assert.ok(!prompts[1].includes("diff --git"));
    // The memory guarantee: the whole diff is never materialised.
    assert.ok(!store.operations.includes("getStagedMaterials"));
  });

  void it("folds to a single manifest pass when there are too many buckets", async () => {
    const files = Array.from({ length: 13 }, (_, i) => `dir${i}/file.ts`);
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files },
      ],
      oversizedDiff: true,
    });

    const { complete, prompts } = fakeCompleteSequence([
      `=== COMMIT 1 ===\nchore: bulk update\n=== FILES ===\n${files.join("\n")}\n=== END ===`,
    ]);

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      complete,
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(prompts.length, 1);
    assert.ok(prompts[0].includes("M\tdir0/file.ts"));
    assert.ok(prompts[0].includes("M\tdir12/file.ts"));
    assert.deepStrictEqual(store.commits, ["chore: bulk update"]);
  });
});

void describe("organizeCheckpointCommits", () => {
  void it("returns no-op when not inside a git repo", async () => {
    const store = new InMemoryReorganiserStore({ insideRepo: false });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(""),
    );

    assert.strictEqual(result.organised, false);
    assert.deepStrictEqual(store.operations, ["isInsideGitRepo"]);
  });

  void it("returns no-op when there are no checkpoint commits", async () => {
    const store = new InMemoryReorganiserStore({ checkpointCommits: [] });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(""),
    );

    assert.strictEqual(result.organised, false);
    assert.strictEqual(
      result.events.some((e) => e.type === "stage-changed" && !e.hasChanges),
      true,
    );
    assert.deepStrictEqual(store.operations, [
      "isInsideGitRepo",
      `countCheckpointCommits:${CHECKPOINT_COMMIT_MARKER}`,
      "checkUncommittedChanges",
    ]);
  });

  void it("skips reorganisation when every checkpoint is already pushed", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts"],
        },
      ],
      upstreamAheadCount: 0,
    });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(""),
    );

    assert.strictEqual(result.organised, false);
    assert.deepStrictEqual(store.commits, []);
    assert.ok(!store.operations.some((op) => op.startsWith("resetSoft")));
    assert.ok(
      result.events.some(
        (e) => e.type === "info" && e.message.includes("push 済み"),
      ),
    );
  });

  void it("reorganises only the un-pushed checkpoints", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/new.ts"],
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/old.ts"],
        },
      ],
      upstreamAheadCount: 1,
    });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(
        "=== COMMIT 1 ===\nfeat(src): add new\n=== FILES ===\nsrc/new.ts\n=== END ===",
      ),
    );

    assert.strictEqual(result.organised, true);
    assert.deepStrictEqual(store.commits, ["feat(src): add new"]);
    assert.ok(store.operations.includes("resetSoft:1"));
    assert.ok(!store.operations.includes("resetSoft:2"));
    assert.ok(
      result.events.some(
        (e) => e.type === "info" && e.message.includes("push 済み"),
      ),
    );
  });

  void it("reorganises a single checkpoint commit into one logical group", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/auth/login.ts", "src/auth/types.ts"],
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login

Implement login with JWT.
=== FILES ===
src/auth/login.ts
src/auth/types.ts
=== END ===
`.trim();

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(
      result.events.some(
        (e) =>
          e.type === "organised" &&
          e.checkpointCount === 1 &&
          e.commitCount === 1,
      ),
      true,
    );
    assert.strictEqual(store.commits.length, 1);
    assert.ok(store.commits[0]?.startsWith("feat(auth):"));
    assert.deepStrictEqual(store.stagedFiles, []);
  });

  void it("aborts without committing when the staged diff is too large for the LLM", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["src/a.ts"] },
      ],
      hugeDiff: true,
    });
    let llmCalls = 0;
    const complete: CompleteFn = async () => {
      llmCalls++;
      throw new Error("must not be called");
    };

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      complete,
    );

    assert.strictEqual(result.organised, false);
    assert.strictEqual(llmCalls, 0);
    assert.deepStrictEqual(store.commits, []);
    // The soft reset stays: the checkpoint changes are left staged for the
    // user to commit by hand.
    assert.deepStrictEqual(store.stagedFiles, ["src/a.ts"]);
    assert.ok(!store.operations.includes("unstageAll"));
    // The size is measured before the diff is read, so the oversized diff
    // never lands in memory.
    assert.ok(store.operations.includes("getStagedDiffSize"));
    assert.ok(!store.operations.includes("getStagedMaterials"));
    assert.ok(
      result.events.some(
        (e) => e.type === "error" && e.message.includes("大きすぎる"),
      ),
    );
  });

  void it("reorganises multiple checkpoint commits into multiple logical groups", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/db/query.ts"],
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/auth/login.ts"],
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
src/auth/login.ts
=== END ===
=== COMMIT 2 ===
refactor(db): extract query builder
=== FILES ===
src/db/query.ts
=== END ===
`.trim();

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(
      result.events.some(
        (e) =>
          e.type === "organised" &&
          e.checkpointCount === 2 &&
          e.commitCount === 2,
      ),
      true,
    );
    assert.strictEqual(store.commits.length, 2);
    assert.ok(store.commits[0]?.startsWith("feat(auth):"));
    assert.ok(store.commits[1]?.startsWith("refactor(db):"));
  });

  void it("falls back to a single commit when group proposition fails", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/auth/login.ts"],
        },
      ],
    });

    const emptyComplete: CompleteFn = async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "" }],
      }) as never;

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      emptyComplete,
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(
      result.events.some((e) => e.type === "fallback"),
      true,
    );
    assert.strictEqual(store.commits.length, 1);
    assert.ok(store.operations.includes("stageAll"));
  });

  void it("stages each group independently and leaves the index clean", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts", "src/b.ts"],
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat(a): change a
=== FILES ===
src/a.ts
=== END ===
=== COMMIT 2 ===
feat(b): change b
=== FILES ===
src/b.ts
=== END ===
`.trim();

    await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
    );

    const stageOps = store.operations.filter((op) =>
      op.startsWith("stageFiles"),
    );
    assert.deepStrictEqual(stageOps, [
      "stageFiles:src/a.ts",
      "stageFiles:src/b.ts",
    ]);
    assert.deepStrictEqual(store.stagedFiles, []);
  });

  void it("includes stdout in error message when stderr is empty", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts"],
        },
      ],
      // commit fails with code 1, empty stderr, but stdout has the actual message.
      commitResult: {
        code: 1,
        stdout: "nothing to commit, working tree clean",
        stderr: "",
        killed: false,
      },
    });

    const input = `
=== COMMIT 1 ===
feat(a): change a
=== FILES ===
src/a.ts
=== END ===
`.trim();

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
    );

    // Both the group commit and the fallback commit fail, so reorganisation
    // itself fails — but the error message should contain stdout content
    // rather than "Unknown error".
    assert.strictEqual(result.organised, false);
    const errorEvent = result.events.find((e) => e.type === "error");
    assert.ok(errorEvent, "Expected an error event");
    assert.ok(
      errorEvent.message.includes("nothing to commit, working tree clean"),
      `Error message should include stdout content, got: ${errorEvent.message}`,
    );
    assert.ok(
      !errorEvent.message.includes("Unknown error"),
      "Error message should not contain 'Unknown error'",
    );
  });

  void it("skips empty commit groups during reorganisation", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts", "src/b.ts"],
        },
      ],
      // "src/a.ts" is already committed — staging it produces no changes.
      alreadyCommitted: ["src/a.ts"],
    });

    const input = `
=== COMMIT 1 ===
feat(a): change a
=== FILES ===
src/a.ts
=== END ===
=== COMMIT 2 ===
feat(b): change b
=== FILES ===
src/b.ts
=== END ===
`.trim();

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
    );

    assert.strictEqual(result.organised, true);

    // Info event about the skipped group.
    const infoEvent = result.events.find(
      (e) =>
        e.type === "info" && e.message.startsWith("Skipped empty commit group"),
    );
    assert.ok(
      infoEvent,
      "Expected an info event about skipped empty commit group",
    );

    // Only the second group was committed.
    assert.strictEqual(store.commits.length, 1);
    assert.ok(store.commits[0]?.startsWith("feat(b):"));

    // commitCount reflects actual commits (1), not groups.length (2).
    const organisedEvent = result.events.find((e) => e.type === "organised");
    assert.ok(organisedEvent, "Expected an organised event");
    assert.strictEqual(organisedEvent.commitCount, 1);

    // And we verified hasStagedChanges was called.
    assert.ok(store.operations.includes("hasStagedChanges"));
  });

  void it("falls back to a single commit when the groups drop a staged file", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/kept.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/dropped.ts"],
          session: "session-a",
        },
      ],
    });

    // The groups cover only src/kept.ts — src/dropped.ts is omitted.
    const input = `
=== COMMIT 1 ===
feat(kept): kept
=== FILES ===
src/kept.ts
=== END ===
`.trim();

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
      "session-a",
    );

    assert.strictEqual(result.organised, true);
    // The covered group is committed and the dropped file is swept into a
    // fallback commit — nothing is left uncommitted.
    assert.ok(
      result.events.some(
        (e) => e.type === "fallback" && e.message.includes("single commit"),
      ),
      "Expected a fallback event for the omitted file",
    );
    assert.strictEqual(store.commits.length, 2);
    assert.ok(store.commits.some((c) => c.startsWith("feat(kept):")));
    // The fallback path re-stages everything (git add -A) before committing.
    assert.ok(store.operations.includes("stageAll"));
  });

  // ── Session-aware agent_end tests ────────────────────────

  void it("with targetSessionId: reorganises only matching consecutive checkpoints", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        // HEAD: turns are added in order, newest first.
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/db/query.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/auth/login.ts"],
          session: "session-a",
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
src/auth/login.ts
=== END ===
=== COMMIT 2 ===
refactor(db): extract query builder
=== FILES ===
src/db/query.ts
=== END ===
`.trim();

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
      "session-a",
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(
      result.events.some(
        (e) =>
          e.type === "organised" &&
          e.checkpointCount === 2 &&
          e.commitCount === 2,
      ),
      true,
    );
    assert.strictEqual(store.commits.length, 2);
  });

  void it("with targetSessionId: stops at foreign session checkpoint", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        // HEAD: this session's checkpoint on top.
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 3`,
          files: ["src/own.ts"],
          session: "session-a",
        },
        // But the next one belongs to another session → stop.
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/foreign.ts"],
          session: "session-b",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/own-old.ts"],
          session: "session-a",
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat(own): own change
=== FILES ===
src/own.ts
=== END ===
`.trim();

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
      "session-a",
    );

    // Only 1 commit reorganised (the top session-a commit).
    assert.strictEqual(result.organised, true);
    assert.strictEqual(
      result.events.some(
        (e) =>
          e.type === "organised" &&
          e.checkpointCount === 1 &&
          e.commitCount === 1,
      ),
      true,
    );
    assert.strictEqual(store.commits.length, 1);
  });

  void it("with targetSessionId: returns no-op when no matching checkpoints at HEAD", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} foreign`,
          files: ["src/x.ts"],
          session: "session-b",
        },
      ],
    });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(""),
      "session-a",
    );

    assert.strictEqual(result.organised, false);
    // marker ends with `:`, sep is `:`, so double-colon is expected.
    assert.ok(
      store.operations.includes(
        "countCheckpointCommits:wip(checkpoint)::session-a",
      ),
    );
  });

  void it("backward-compat: no targetSessionId counts all consecutive checkpoints", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/b.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts"],
          session: "session-b",
        },
      ],
    });

    // Without targetSessionId, both are counted regardless of trailer.
    const input = `
=== COMMIT 1 ===
feat(b): b
=== FILES ===
src/b.ts
src/a.ts
=== END ===
`.trim();

    // Only 1 commit groups proposed for 2 consecutive checkpoints.
    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(
      result.events.some(
        (e) =>
          e.type === "organised" &&
          e.checkpointCount === 2 &&
          e.commitCount === 1,
      ),
      true,
    );
  });
});

// ── reorganiseCheckpointsManual ───────────────────────────────────

void describe("reorganiseCheckpointsManual", () => {
  void it("aborts without committing when the staged diff is too large (scattered path)", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: "feat: regular commit on top",
          files: ["src/top.ts"],
          session: null,
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/b.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts"],
          session: "session-a",
        },
      ],
      hugeDiff: true,
    });

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
      undefined,
      fakeCompleteReturning("ignored"),
    );

    assert.strictEqual(result.organised, false);
    assert.deepStrictEqual(store.commits, []);
    // Scattered path never moved HEAD: the applied checkpoints stay staged
    // (oldest applied first, so src/a.ts precedes src/b.ts).
    assert.deepStrictEqual(store.stagedFiles, ["src/a.ts", "src/b.ts"]);
    assert.ok(!store.operations.includes("unstageAll"));
    assert.ok(
      result.events.some(
        (e) => e.type === "error" && e.message.includes("大きすぎる"),
      ),
    );
  });

  void it("returns no-op when not inside a git repo", async () => {
    const store = new InMemoryReorganiserStore({ insideRepo: false });

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
    );

    assert.strictEqual(result.organised, false);
    assert.deepStrictEqual(store.operations, ["isInsideGitRepo"]);
  });

  void it("returns no-op when there are no checkpoint commits", async () => {
    const store = new InMemoryReorganiserStore({ checkpointCommits: [] });

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
    );

    assert.strictEqual(result.organised, false);
    assert.ok(
      store.operations.includes("findReachableCheckpoints:wip(checkpoint):"),
    );
  });

  void it("no targetSessionId: reorganises all consecutive checkpoints", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/b.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts"],
          session: "session-a",
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat(a+b): combined
=== FILES ===
src/a.ts
src/b.ts
=== END ===
`.trim();

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
      undefined,
      fakeCompleteReturning(input),
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(store.commits.length, 1);
    assert.ok(
      store.operations.includes("countCheckpointCommits:wip(checkpoint):"),
    );
    assert.ok(
      result.events.some(
        (e) =>
          e.type === "organised" &&
          e.checkpointCount === 2 &&
          e.commitCount === 1,
      ),
    );
  });

  void it("no targetSessionId: reorganises scattered checkpoints behind regular commits", async () => {
    // HEAD is a regular commit; checkpoints are deeper in history.
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: "feat: regular commit on top",
          files: ["src/top.ts"],
          session: null,
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/b.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts"],
          session: "session-a",
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat(a+b): combined
=== FILES ===
src/a.ts
src/b.ts
=== END ===
`.trim();

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
      undefined,
      fakeCompleteReturning(input),
    );

    // BUG: currently returns organised=false because countCheckpointCommits returns 0
    // when HEAD is not a checkpoint. Should handle scattered checkpoints.
    assert.strictEqual(result.organised, true);
    assert.strictEqual(store.commits.length, 1);
    // Should use applyCommitDiffToIndex (scattered path), not resetSoft.
    assert.ok(store.operations.includes("applyCommitDiffToIndex:sha-2"));
    assert.ok(store.operations.includes("applyCommitDiffToIndex:sha-1"));
    assert.ok(!store.operations.some((op) => op.startsWith("resetSoft")));
  });

  void it("with targetSessionId contiguous: reset-soft path", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/b.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts"],
          session: "session-a",
        },
      ],
    });

    const inputContiguous = `
=== COMMIT 1 ===
feat: combined
=== FILES ===
src/a.ts
src/b.ts
=== END ===
`.trim();

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
      "session-a",
      fakeCompleteReturning(inputContiguous),
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(store.commits.length, 1);
    // Should use resetSoft (contiguous path).
    assert.ok(store.operations.includes("resetSoft:2"));
  });

  void it("with targetSessionId scattered: apply-commit-diff path", async () => {
    // Scattered: HEAD belongs to session-b, session-a checkpoints are below.
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        // HEAD (index 0) belongs to the OTHER session.
        {
          message: `${CHECKPOINT_COMMIT_MARKER} other`,
          files: ["src/other.ts"],
          session: "session-b",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} own2`,
          files: ["src/own2.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} own1`,
          files: ["src/own1.ts"],
          session: "session-a",
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat: scattered
=== FILES ===
src/own1.ts
src/own2.ts
=== END ===
`.trim();

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
      "session-a",
      fakeCompleteReturning(input),
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(store.commits.length, 1);
    // Scattered path: applyCommitDiffToIndex for each matching checkpoint (oldest first).
    // sha-1 = own1 (oldest), sha-2 = own2.
    assert.ok(store.operations.includes("applyCommitDiffToIndex:sha-2"));
    assert.ok(store.operations.includes("applyCommitDiffToIndex:sha-1"));
    // Should NOT use resetSoft (not contiguous).
    assert.ok(!store.operations.some((op) => op.startsWith("resetSoft")));
  });

  void it("with targetSessionId: returns no-op when no matching checkpoints exist", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/x.ts"],
          session: "session-b",
        },
      ],
    });

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
      "session-a",
      fakeCompleteReturning(""),
    );

    assert.strictEqual(result.organised, false);
    assert.ok(
      result.events.some(
        (e) =>
          e.type === "info" &&
          e.message.includes(
            "No checkpoint commits found for session session-a",
          ),
      ),
    );
  });
});

// ── reorganiseSelectedRange (interactive picker range) ─────────────

void describe("reorganiseSelectedRange", () => {
  const groupInput = `
=== COMMIT 1 ===
feat(auth): add JWT login

Implement login with JWT.
=== FILES ===
src/auth/login.ts
=== END ===
`.trim();

  void it("fast path: aborts without committing when the staged diff is too large", async () => {
    const store = new InMemoryReorganiserStore({
      upstreamAheadCount: 5,
      checkpointCommits: [
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 2`, files: ["a.ts"] },
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["b.ts"] },
        { message: "feat: X", files: ["c.ts"] },
      ],
      hugeDiff: true,
    });

    const result = await reorganiseSelectedRange(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      { startIndex: 0, endIndex: 1 },
      fakeCompleteReturning("ignored"),
    );

    assert.strictEqual(result.organised, false);
    assert.deepStrictEqual(store.commits, []);
    assert.ok(store.operations.includes("resetSoft:2"));
    assert.deepStrictEqual(store.stagedFiles, ["a.ts", "b.ts"]);
  });

  void it("slow path: aborts without committing when the staged diff is too large", async () => {
    const store = new InMemoryReorganiserStore({
      upstreamAheadCount: 9,
      checkpointCommits: [
        { message: "feat: top", files: ["top.ts"] },
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 2`, files: ["a.ts"] },
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["b.ts"] },
        { message: "feat: base", files: ["base.ts"] },
      ],
      hugeDiff: true,
    });

    const result = await reorganiseSelectedRange(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      { startIndex: 1, endIndex: 2 },
      fakeCompleteReturning("ignored"),
    );

    assert.strictEqual(result.organised, false);
    assert.deepStrictEqual(store.commits, []);
    // Restored to the original HEAD (sha-0): nothing left dismantled.
    const resets = store.operations.filter((op) =>
      op.startsWith("hardReset:"),
    );
    assert.strictEqual(resets[resets.length - 1], "hardReset:sha-0");
  });

  void it("fast path: reorganises the selected range from HEAD", async () => {
    const store = new InMemoryReorganiserStore({
      upstreamAheadCount: 5, // remote tip is far below the selection
      checkpointCommits: [
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 2`, files: ["a.ts"] },
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["b.ts"] },
        { message: "feat: X", files: ["c.ts"] },
      ],
    });

    const result = await reorganiseSelectedRange(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      { startIndex: 0, endIndex: 1 },
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
a.ts
b.ts
=== END ===
`.trim(),
      ),
    );

    assert.strictEqual(result.organised, true);
    assert.ok(store.operations.includes("resetSoft:2"));
    assert.strictEqual(store.commits.length, 1);
  });

  void it("review: commits the edited message", async () => {
    const store = new InMemoryReorganiserStore({
      upstreamAheadCount: 5,
      checkpointCommits: [
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["a.ts"] },
      ],
    });

    const result = await reorganiseSelectedRange(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      { startIndex: 0, endIndex: 0 },
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
a.ts
=== END ===
`.trim(),
      ),
      async (groups) => groups.map((g) => ({ ...g, message: "fix(auth): x" })),
    );

    assert.strictEqual(result.organised, true);
    assert.deepStrictEqual(store.commits, ["fix(auth): x"]);
  });

  void it("review: aborts without committing and leaves the changes staged", async () => {
    const store = new InMemoryReorganiserStore({
      upstreamAheadCount: 5,
      checkpointCommits: [
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["a.ts"] },
      ],
    });

    const result = await reorganiseSelectedRange(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      { startIndex: 0, endIndex: 0 },
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
a.ts
=== END ===
`.trim(),
      ),
      async () => null,
    );

    assert.strictEqual(result.organised, false);
    assert.deepStrictEqual(store.commits, []);
    assert.deepStrictEqual(store.stagedFiles, ["a.ts"]);
    assert.ok(
      result.events.some(
        (e) => e.type === "info" && e.message.includes("キャンセル"),
      ),
    );
    assert.ok(
      !result.events.some((e) => e.type === "error"),
      "a cancelled review is not an error",
    );
  });

  void it("review: unstages files dropped from the partition and commits the rest", async () => {
    const store = new InMemoryReorganiserStore({
      upstreamAheadCount: 5,
      checkpointCommits: [
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["a.ts"] },
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 2`, files: ["b.ts"] },
      ],
    });

    const result = await reorganiseSelectedRange(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      { startIndex: 0, endIndex: 1 },
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
a.ts
=== END ===
=== COMMIT 2 ===
chore: scratch file
=== FILES ===
b.ts
=== END ===
`.trim(),
      ),
      // The user deleted b.ts from the partition.
      async (groups) => groups.filter((g) => !g.files.includes("b.ts")),
    );

    assert.strictEqual(result.organised, true);
    assert.deepStrictEqual(store.commits, ["feat(auth): add JWT login"]);
    assert.ok(store.operations.includes("unstageFiles:b.ts"));
    assert.deepStrictEqual(store.stagedFiles, []);
    assert.ok(
      result.events.some(
        (e) => e.type === "info" && e.message.includes("b.ts"),
      ),
      "the dropped file is reported, not silently left behind",
    );
  });

  void it("review: commits nothing when every file is dropped", async () => {
    const store = new InMemoryReorganiserStore({
      upstreamAheadCount: 5,
      checkpointCommits: [
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["a.ts"] },
      ],
    });

    const result = await reorganiseSelectedRange(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      { startIndex: 0, endIndex: 0 },
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
a.ts
=== END ===
`.trim(),
      ),
      async () => [],
    );

    assert.deepStrictEqual(store.commits, []);
    assert.ok(store.operations.includes("unstageFiles:a.ts"));
    assert.deepStrictEqual(store.stagedFiles, []);
    assert.ok(
      !result.events.some((e) => e.type === "error"),
      "dropping everything is a choice, not a failure",
    );
  });

  void it("fast path: blocks when the range reaches the remote tip", async () => {
    const store = new InMemoryReorganiserStore({
      upstreamAheadCount: 2, // remote tip is at index 2
      checkpointCommits: [
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 3`, files: ["a.ts"] },
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 2`, files: ["b.ts"] },
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["c.ts"] },
      ],
    });

    const result = await reorganiseSelectedRange(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      { startIndex: 0, endIndex: 2 }, // hi(2) >= aheadCount(2) → includes pushed commit
      fakeCompleteReturning(groupInput),
    );

    assert.strictEqual(result.organised, false);
    assert.ok(
      result.events.some(
        (e) => e.type === "error" && e.message.includes("リモート先端"),
      ),
    );
    assert.ok(!store.operations.some((op) => op.startsWith("resetSoft")));
  });

  void it("slow path: preserves above-range commits via cherry-pick", async () => {
    const store = new InMemoryReorganiserStore({
      upstreamAheadCount: 5,
      checkpointCommits: [
        { message: "feat: above", files: ["above.ts"] }, // index 0 (kept)
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 2`, files: ["a.ts"] }, // 1
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["b.ts"] }, // 2
        { message: "feat: below", files: ["below.ts"] }, // 3
        { message: "feat: below2", files: ["below2.ts"] }, // 4 (beforeSHA)
      ],
    });

    const result = await reorganiseSelectedRange(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      { startIndex: 1, endIndex: 3 },
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
a.ts
b.ts
below.ts
=== END ===
`.trim(),
      ),
    );

    assert.strictEqual(result.organised, true);
    const ops = store.operations;
    // Reset to before the range (parent of index 3 = sha-4).
    assert.ok(ops.includes("hardReset:sha-4"));
    assert.ok(ops.some((op) => op.startsWith("applyRangeDiff:")));
    // Above-range commit (index 0) restored oldest-first via cherry-pick.
    assert.ok(ops.some((op) => op === "cherryPick:sha-0"));
  });

  void it("slow path: blocks when the range reaches the remote tip", async () => {
    const store = new InMemoryReorganiserStore({
      upstreamAheadCount: 2,
      checkpointCommits: [
        { message: "feat: above", files: ["above.ts"] },
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 2`, files: ["a.ts"] },
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["b.ts"] },
        { message: "feat: below", files: ["below.ts"] },
      ],
    });

    const result = await reorganiseSelectedRange(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      { startIndex: 1, endIndex: 3 }, // hi(3) >= aheadCount(2) → includes pushed commit
      fakeCompleteReturning(groupInput),
    );

    assert.strictEqual(result.organised, false);
    assert.ok(
      result.events.some(
        (e) => e.type === "error" && e.message.includes("リモート先端"),
      ),
    );
    assert.ok(!store.operations.some((op) => op.startsWith("hardReset")));
  });

  void it("slow path: aborts on a dirty working tree before hardReset", async () => {
    const store = new InMemoryReorganiserStore({
      upstreamAheadCount: 5,
      checkpointCommits: [
        { message: "feat: above", files: ["above.ts"] },
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["a.ts"] },
        { message: "feat: below", files: ["below.ts"] },
        { message: "feat: below2", files: ["below2.ts"] },
      ],
    });
    store.stagedFiles.push("dirty.ts"); // uncommitted change

    const result = await reorganiseSelectedRange(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      { startIndex: 1, endIndex: 2 },
      fakeCompleteReturning(groupInput),
    );

    assert.strictEqual(result.organised, false);
    assert.ok(
      result.events.some(
        (e) => e.type === "error" && e.message.includes("未コミットの変更"),
      ),
    );
    assert.ok(!store.operations.some((op) => op.startsWith("hardReset")));
  });

  void it("slow path: restores the original HEAD when a cherry-pick fails", async () => {
    const store = new InMemoryReorganiserStore({
      upstreamAheadCount: 5,
      cherryPickError: "conflict",
      checkpointCommits: [
        { message: "feat: above", files: ["above.ts"] }, // index 0 (kept)
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 2`, files: ["a.ts"] }, // 1
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["b.ts"] }, // 2
        { message: "feat: below", files: ["below.ts"] }, // 3
        { message: "feat: below2", files: ["below2.ts"] }, // 4 (beforeSHA)
      ],
    });

    const result = await reorganiseSelectedRange(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      { startIndex: 1, endIndex: 3 },
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
a.ts
b.ts
below.ts
=== END ===
`.trim(),
      ),
    );

    assert.strictEqual(result.organised, false);
    assert.ok(
      result.events.some(
        (e) =>
          e.type === "error" && e.message.includes("操作前の状態に復元済み"),
      ),
    );
    // Final hardReset targets the original HEAD (sha-0) — full restore.
    const resets = store.operations.filter((op) => op.startsWith("hardReset:"));
    assert.strictEqual(resets[resets.length - 1], "hardReset:sha-0");
  });
});


// ── mergeSimilarPrevious (agent_end) ──────────────────────────────

void describe("fileSetOverlap", () => {
  void it("scores intersection over union", () => {
    assert.strictEqual(fileSetOverlap(["a"], ["a"]), 1);
    assert.strictEqual(fileSetOverlap(["a"], ["a", "b"]), 0.5);
    assert.strictEqual(fileSetOverlap(["a", "b"], ["b", "a"]), 1);
    assert.strictEqual(fileSetOverlap(["a", "b", "c"], ["a", "d", "e"]), 0.2);
    assert.strictEqual(fileSetOverlap(["a"], ["b"]), 0);
    assert.strictEqual(fileSetOverlap([], []), 1);
  });
});

void describe("organizeCheckpointCommits mergeSimilarPrevious", () => {
  const checkpoint = (files: string[]) => ({
    message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
    files,
  });
  const previous = (
    message: string,
    files: string[],
    committerTime = 0,
  ) => ({ message, files, committerTime });

  void it("re-consolidates the checkpoint run with a similar previous commit", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        checkpoint(["src/auth/login.ts"]),
        previous("feat(auth): add JWT login", ["src/auth/login.ts"]),
      ],
    });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config({ mergeSimilarPrevious: true }),
      makeEvent(),
      store,
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
src/auth/login.ts
=== END ===
`.trim(),
      ),
    );

    assert.strictEqual(result.organised, true);
    assert.ok(
      result.events.some((e) => e.type === "merged"),
      "expected a merged event",
    );
    assert.ok(
      result.events.some(
        (e) =>
          e.type === "organised" &&
          e.checkpointCount === 1 &&
          e.commitCount === 1,
      ),
      "the checkpoint run is reorganised into one commit",
    );
    assert.deepStrictEqual(store.stagedFiles, []);
  });

  void it("matches a non-tip group member and absorbs the whole group", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        checkpoint(["src/b.ts"]),
        previous("test(b): cover b", ["src/b.test.ts"], 100),
        previous("feat(b): add b", ["src/b.ts"], 99),
        previous("chore: earlier unrelated", ["package.json"], 40),
      ],
    });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config({ mergeSimilarPrevious: true }),
      makeEvent(),
      store,
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(b): add b
=== FILES ===
src/b.ts
=== END ===
=== COMMIT 2 ===
test(b): cover b
=== FILES ===
src/b.test.ts
=== END ===
`.trim(),
      ),
    );

    // The 10s gap stops at "chore"; the group is the test+feat pair, so the
    // extended range is the checkpoint plus those two commits.
    assert.ok(store.operations.includes("resetSoft:2"));
    assert.ok(
      result.events.some(
        (e) =>
          e.type === "organised" &&
          e.checkpointCount === 1 &&
          e.commitCount === 2,
      ),
    );
    assert.ok(result.events.some((e) => e.type === "merged"));
  });

  void it("does not absorb a commit separated by more than 10 seconds", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        checkpoint(["src/b.ts"]),
        previous("chore: unrelated", ["src/x.ts"], 100),
        previous("feat(b): add b", ["src/b.ts"], 80),
      ],
    });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config({ mergeSimilarPrevious: true }),
      makeEvent(),
      store,
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(b): add b
=== FILES ===
src/b.ts
=== END ===
`.trim(),
      ),
    );

    assert.ok(!result.events.some((e) => e.type === "merged"));
    assert.strictEqual(
      store.operations.filter((op) => op.startsWith("resetSoft:")).length,
      1,
    );
  });

  void it("does not merge when the conventional type differs", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        checkpoint(["src/b.ts"]),
        previous("fix(b): correct b", ["src/b.ts"]),
      ],
    });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config({ mergeSimilarPrevious: true }),
      makeEvent(),
      store,
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(b): add b
=== FILES ===
src/b.ts
=== END ===
`.trim(),
      ),
    );

    assert.ok(!result.events.some((e) => e.type === "merged"));
    assert.strictEqual(
      store.operations.filter((op) => op.startsWith("resetSoft:")).length,
      1,
    );
  });

  void it("merges when the file sets mostly overlap", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        checkpoint(["src/b.ts"]),
        previous("feat(b): add b", ["src/b.ts", "src/b.test.ts"]),
      ],
    });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config({ mergeSimilarPrevious: true }),
      makeEvent(),
      store,
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(b): add b
=== FILES ===
src/b.ts
=== END ===
`.trim(),
      ),
    );

    assert.ok(result.events.some((e) => e.type === "merged"));
    assert.strictEqual(
      store.operations.filter((op) => op.startsWith("resetSoft:")).length,
      2,
      "the checkpoint reset plus the extended reset over the previous group",
    );
  });

  void it("does not merge when the file sets are unrelated", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        checkpoint(["src/b.ts"]),
        previous("feat(b): add b", ["src/x.ts", "src/y.ts"]),
      ],
    });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config({ mergeSimilarPrevious: true }),
      makeEvent(),
      store,
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(b): add b
=== FILES ===
src/b.ts
=== END ===
`.trim(),
      ),
    );

    assert.ok(!result.events.some((e) => e.type === "merged"));
  });

  void it("does not merge a pushed previous commit group and notifies instead", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        checkpoint(["src/b.ts"]),
        previous("feat(b): add b", ["src/b.ts"]),
      ],
      upstreamAheadCount: 1,
    });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config({ mergeSimilarPrevious: true }),
      makeEvent(),
      store,
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(b): add b
=== FILES ===
src/b.ts
=== END ===
`.trim(),
      ),
    );

    assert.ok(!result.events.some((e) => e.type === "merged"));
    assert.strictEqual(
      store.operations.filter((op) => op.startsWith("resetSoft:")).length,
      1,
    );
    assert.ok(
      result.events.some(
        (e) => e.type === "info" && e.message.includes("push 済み"),
      ),
    );
  });

  void it("skips previous-group detection when disabled", async () => {
    const store = new InMemoryReorganiserStore({
      checkpointCommits: [
        checkpoint(["src/b.ts"]),
        previous("feat(b): add b", ["src/b.ts"]),
      ],
    });

    await organizeCheckpointCommits(
      makeCtx(stubModel),
      config({ mergeSimilarPrevious: false }),
      makeEvent(),
      store,
      fakeCompleteReturning(
        `
=== COMMIT 1 ===
feat(b): add b
=== FILES ===
src/b.ts
=== END ===
`.trim(),
      ),
    );

    assert.ok(
      !store.operations.some((op) => op.startsWith("getCommitSummary:")),
    );
  });
});
