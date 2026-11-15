import assert from "node:assert/strict";
import { type ExecFileSyncOptions, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GitCheckpointStore } from "./checkpoint-store.js";
import { GitOperations } from "./git-operations.js";
import { runCheckpointCommit } from "./pipeline.js";

/**
 * Real-git integration tests for submodule handling, porting the adversarial
 * scenarios verified against a scratch repo (B1: checkpoint skips
 * submodule-only dirt, B3: detached-orphan detection and the `git submodule
 * update` data loss it warns about, B6: `--submodule=log` diff material).
 *
 * Requires `git` on PATH. Each test builds its own scratch repo pair under a
 * unique tmpdir and removes it afterwards.
 */
function git(
  cwd: string,
  args: string[],
): { stdout: string; stderr: string; code: number } {
  const options: ExecFileSyncOptions = {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  };
  try {
    const stdout = execFileSync("git", args, options).toString();
    return { stdout: stdout.trim(), stderr: "", code: 0 };
  } catch (error) {
    const err = error as {
      status?: number;
      stderr?: Buffer;
      stdout?: Buffer;
    };
    return {
      stdout: (err.stdout?.toString() ?? "").trim(),
      stderr: (err.stderr?.toString() ?? "").trim(),
      code: err.status ?? 1,
    };
  }
}

function makePi(cwd: string): ExtensionAPI {
  return {
    exec: async (_command: string, args?: string[]): Promise<ExecResult> => {
      const result = git(cwd, [
        "-c",
        "protocol.file.allow=always",
        ...(args ?? []),
      ]);
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        killed: false,
      };
    },
  } as unknown as ExtensionAPI;
}

interface Fixture {
  root: string;
  subDir: string;
}

function setup(subName = "sub"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-autocommit-sub-"));
  const subSrc = mkdtempSync(join(tmpdir(), "pi-autocommit-subsrc-"));
  const subDir = join(root, subName);

  git(subSrc, ["init", "-q", "-b", "main"]);
  writeFileSync(join(subSrc, "file.txt"), "hello\n");
  git(subSrc, ["add", "file.txt"]);
  git(subSrc, ["commit", "-q", "-m", "sub: initial"]);

  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "top.txt"), "top\n");
  git(root, ["add", "top.txt"]);
  git(root, ["commit", "-q", "-m", "initial"]);
  const added = git(root, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    subSrc,
    subName,
  ]);
  assert.equal(added.code, 0, `submodule add failed: ${added.stderr}`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "add submodule"]);
  return { root, subDir };
}

function cleanup(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

describe("submodule integration (real git)", () => {
  it("B1: submodule-only working-tree changes are skipped cleanly by the checkpoint", async () => {
    const fixture = setup();
    try {
      // Dirty tracked file inside the submodule; the parent gitlink is unchanged.
      writeFileSync(join(fixture.subDir, "file.txt"), "hello\nmodified\n");

      const store = new GitCheckpointStore(
        new GitOperations(makePi(fixture.root)),
      );
      const result = await runCheckpointCommit(
        store,
        "wip(checkpoint): auto-commit at turn 1",
        "session-1",
      );

      assert.equal(
        result.committed,
        false,
        "must not commit submodule-only dirt",
      );
      assert.ok(
        result.events.some(
          (e) => e.type === "info" && /no stageable changes/i.test(e.message),
        ),
        "reports a clean skip (previously this threw a checkpoint error)",
      );
      const count = git(fixture.root, ["rev-list", "--count", "HEAD"]).stdout;
      assert.equal(count, "2", "no extra parent commits");
    } finally {
      cleanup(fixture);
    }
  });

  it("B3: detached-orphan submodule commits are detected and then lost to submodule update", async () => {
    const fixture = setup();
    try {
      const ops = new GitOperations(makePi(fixture.root));

      // Commit inside the submodule on a detached HEAD, parent gitlink unchanged.
      git(fixture.subDir, ["checkout", "-q", "--detach"]);
      writeFileSync(join(fixture.subDir, "wip.txt"), "wip\n");
      git(fixture.subDir, ["add", "wip.txt"]);
      git(fixture.subDir, ["commit", "-q", "-m", "wip(checkpoint): turn 1"]);
      const orphanSha = git(fixture.subDir, ["rev-parse", "HEAD"]).stdout;

      const orphans = await ops.findOrphanedSubmoduleHeads();
      assert.equal(orphans.length, 1);
      assert.equal(orphans[0].path, "sub");
      assert.equal(orphans[0].headSha, orphanSha);

      // The danger is real: `git submodule update` discards the orphan.
      const updated = git(fixture.root, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
      ]);
      assert.equal(updated.code, 0, updated.stderr);
      const after = git(fixture.subDir, ["rev-parse", "HEAD"]).stdout;
      assert.notEqual(after, orphanSha, "orphaned commit was checked away");
      assert.deepEqual(await ops.findOrphanedSubmoduleHeads(), []);
    } finally {
      cleanup(fixture);
    }
  });

  it("B3: the same commits on a branch are not reported and survive submodule update", async () => {
    const fixture = setup();
    try {
      const ops = new GitOperations(makePi(fixture.root));

      git(fixture.subDir, ["checkout", "-q", "-b", "feature/x"]);
      writeFileSync(join(fixture.subDir, "feature.txt"), "work\n");
      git(fixture.subDir, ["add", "feature.txt"]);
      git(fixture.subDir, ["commit", "-q", "-m", "feat: branch work"]);
      const branchSha = git(fixture.subDir, ["rev-parse", "HEAD"]).stdout;

      assert.deepEqual(
        await ops.findOrphanedSubmoduleHeads(),
        [],
        "reachable from a branch → recoverable, no warning",
      );

      git(fixture.root, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
      ]);
      assert.equal(
        git(fixture.subDir, ["rev-parse", "feature/x"]).stdout,
        branchSha,
        "branch commit survives the update",
      );
      assert.deepEqual(await ops.findOrphanedSubmoduleHeads(), []);
    } finally {
      cleanup(fixture);
    }
  });

  it("B6: the gitlink diff material exposes the submodule commit log", async () => {
    const fixture = setup();
    try {
      const ops = new GitOperations(makePi(fixture.root));

      git(fixture.subDir, ["checkout", "-q", "-b", "feature/add-widget"]);
      writeFileSync(join(fixture.subDir, "widget.txt"), "widget\n");
      git(fixture.subDir, ["add", "widget.txt"]);
      git(fixture.subDir, ["commit", "-q", "-m", "feat: add the widget"]);

      await ops.stageFiles(["sub"]);
      const diff = await ops.getStagedDiff();

      assert.match(diff, /Submodule sub .+\.\./);
      assert.match(
        diff,
        /add the widget/,
        "child commit subject reaches the LLM",
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("ignoreSubmodules: a submodule-side commit does not create a parent checkpoint", async () => {
    const fixture = setup();
    try {
      // Commits pile up inside the submodule (on a branch, so nothing is lost).
      git(fixture.subDir, ["checkout", "-q", "-b", "feature/x"]);
      writeFileSync(join(fixture.subDir, "work.txt"), "work\n");
      git(fixture.subDir, ["add", "work.txt"]);
      git(fixture.subDir, ["commit", "-q", "-m", "feat: work"]);

      const store = new GitCheckpointStore(
        new GitOperations(makePi(fixture.root)),
      );
      const result = await runCheckpointCommit(
        store,
        "wip(checkpoint): auto-commit at turn 1",
        "session-1",
        { ignoreSubmodules: true },
      );

      assert.equal(
        result.committed,
        false,
        "no parent commit for pin drift only",
      );
      const count = git(fixture.root, ["rev-list", "--count", "HEAD"]).stdout;
      assert.equal(count, "2", "parent history unchanged");
      // The pin drift stays visible in the working tree instead of being swept in.
      assert.match(
        git(fixture.root, ["status", "--short"]).stdout,
        /^ ?M sub/m,
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("ignoreSubmodules: parent files are committed while the gitlink bump is left out", async () => {
    const fixture = setup();
    try {
      git(fixture.subDir, ["checkout", "-q", "-b", "feature/x"]);
      writeFileSync(join(fixture.subDir, "work.txt"), "work\n");
      git(fixture.subDir, ["add", "work.txt"]);
      git(fixture.subDir, ["commit", "-q", "-m", "feat: work"]);
      writeFileSync(join(fixture.root, "top.txt"), "changed\n");

      const store = new GitCheckpointStore(
        new GitOperations(makePi(fixture.root)),
      );
      const result = await runCheckpointCommit(
        store,
        "wip(checkpoint): auto-commit at turn 1",
        "session-1",
        { ignoreSubmodules: true },
      );

      assert.equal(result.committed, true, "parent file change is committed");
      const committed = git(fixture.root, [
        "show",
        "--name-only",
        "--format=",
        "HEAD",
      ]).stdout;
      assert.match(committed, /top\.txt/);
      assert.doesNotMatch(committed, /^sub$/m, "gitlink not recorded");
      assert.doesNotMatch(committed, /\.gitmodules/);
    } finally {
      cleanup(fixture);
    }
  });

  it("ignoreSubmodules: non-ASCII submodule path is unstaged (core.quotePath regression)", async () => {
    const fixture = setup("ニホンゴサブ");
    try {
      git(join(fixture.root, "ニホンゴサブ"), [
        "checkout",
        "-q",
        "-b",
        "feature/x",
      ]);
      writeFileSync(join(fixture.root, "ニホンゴサブ", "work.txt"), "work\n");
      git(join(fixture.root, "ニホンゴサブ"), ["add", "work.txt"]);
      git(join(fixture.root, "ニホンゴサブ"), [
        "commit",
        "-q",
        "-m",
        "feat: work",
      ]);

      const store = new GitCheckpointStore(
        new GitOperations(makePi(fixture.root)),
      );
      const result = await runCheckpointCommit(
        store,
        "wip(checkpoint): auto-commit at turn 1",
        "session-1",
        { ignoreSubmodules: true },
      );

      assert.equal(
        result.committed,
        false,
        "quoted gitlink path must not sneak into a commit",
      );
      const status = git(fixture.root, [
        "-c",
        "core.quotePath=false",
        "status",
        "--short",
      ]).stdout;
      assert.match(
        status,
        /ニホンゴサブ/,
        "pin drift stays visible in the working tree",
      );
    } finally {
      cleanup(fixture);
    }
  });
});
