import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GitOperations } from "./git-operations.js";

function makePi(result: ExecResult): ExtensionAPI {
  return {
    exec: async (command: string, args?: string[]) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["rev-parse", "HEAD"]);
      return result;
    },
  } as unknown as ExtensionAPI;
}

describe("GitOperations.getHead", () => {
  it("returns the trimmed HEAD SHA on success", async () => {
    const git = new GitOperations(
      makePi({ code: 0, stdout: "abc123def456\n", stderr: "", killed: false }),
    );
    const head = await git.getHead();
    assert.equal(head, "abc123def456");
  });

  it("returns null when git rev-parse fails", async () => {
    const git = new GitOperations(
      makePi({
        code: 1,
        stdout: "",
        stderr: "fatal: not a git repository",
        killed: false,
      }),
    );
    const head = await git.getHead();
    assert.equal(head, null);
  });

  it("returns null when stdout is empty", async () => {
    const git = new GitOperations(
      makePi({ code: 0, stdout: "", stderr: "", killed: false }),
    );
    const head = await git.getHead();
    assert.equal(head, null);
  });
});

describe("GitOperations.resetSoft", () => {
  it("does nothing when commitCount is 0", async () => {
    let called = false;
    const git = new GitOperations({
      exec: async () => {
        called = true;
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);
    await git.resetSoft(0);
    assert.equal(called, false, "should not call git when count is 0");
  });

  it("does nothing when commitCount is negative", async () => {
    let called = false;
    const git = new GitOperations({
      exec: async () => {
        called = true;
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);
    await git.resetSoft(-3);
    assert.equal(called, false, "should not call git when count is negative");
  });

  it("uses git reset --soft HEAD~N when HEAD~N exists", async () => {
    const calls: Array<{ args?: string[] }> = [];
    const git = new GitOperations({
      exec: async (_cmd: string, args?: string[]) => {
        calls.push({ args });
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);

    await git.resetSoft(3);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ["rev-parse", "--verify", "HEAD~3"]);
    assert.deepEqual(calls[1].args, ["reset", "--soft", "HEAD~3"]);
  });

  it("uses git update-ref -d HEAD when HEAD~N does not exist", async () => {
    const calls: Array<{ args?: string[] }> = [];
    const git = new GitOperations({
      exec: async (_cmd: string, args?: string[]) => {
        calls.push({ args });
        if (args?.[0] === "rev-parse") {
          return {
            code: 128,
            stdout: "",
            stderr: "fatal: ambiguous argument",
            killed: false,
          };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);

    await git.resetSoft(5);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ["rev-parse", "--verify", "HEAD~5"]);
    assert.deepEqual(calls[1].args, ["update-ref", "-d", "HEAD"]);
  });

  it("throws on reset --soft failure even when HEAD~N exists", async () => {
    const git = new GitOperations({
      exec: async (_cmd: string, args?: string[]) => {
        if (args?.[0] === "rev-parse") {
          return { code: 0, stdout: "abc123", stderr: "", killed: false };
        }
        return {
          code: 1,
          stdout: "",
          stderr: "fatal: something went wrong",
          killed: false,
        };
      },
    } as unknown as ExtensionAPI);

    await assert.rejects(
      () => git.resetSoft(2),
      /git reset --soft HEAD~2 failed/,
    );
  });

  it("throws on update-ref failure", async () => {
    const git = new GitOperations({
      exec: async (_cmd: string, args?: string[]) => {
        if (args?.[0] === "rev-parse") {
          return {
            code: 128,
            stdout: "",
            stderr: "fatal: ambiguous argument",
            killed: false,
          };
        }
        return {
          code: 1,
          stdout: "",
          stderr: "fatal: could not update ref",
          killed: false,
        };
      },
    } as unknown as ExtensionAPI);

    await assert.rejects(
      () => git.resetSoft(5),
      /git update-ref -d HEAD failed/,
    );
  });
});

describe("GitOperations.findCheckpointsSince", () => {
  const marker = "wip(checkpoint):";
  const output = [
    "deadbeef\u0000wip(checkpoint): auto-commit at turn 2\u0000session-2\u0000wt/task1",
    "cafebabe\u0000feat: regular commit\u0000\u0000",
    "12345678\u0000wip(checkpoint): auto-commit at turn 1\u0000session-1\u0000",
  ].join("\n");

  it("returns only marker-matching commits in the range", async () => {
    const git = new GitOperations({
      exec: async (_cmd: string, args?: string[]) => {
        assert.deepEqual(args, [
          "log",
          "--pretty=format:%H%x00%s%x00%(trailers:key=Checkpoint-Session,valueonly,separator=%x00)%x00%(trailers:key=Checkpoint-Branch,valueonly,separator=%x00)",
          "--no-decorate",
          "abc123..HEAD",
        ]);
        return { code: 0, stdout: output + "\n", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);

    const found = await git.findCheckpointsSince("abc123", marker);
    assert.equal(found.length, 2);
    assert.deepEqual(found[0], {
      sha: "deadbeef",
      subject: "wip(checkpoint): auto-commit at turn 2",
      session: "session-2",
      branch: "wt/task1",
    });
    assert.deepEqual(found[1], {
      sha: "12345678",
      subject: "wip(checkpoint): auto-commit at turn 1",
      session: "session-1",
      branch: null,
    });
  });

  it("returns [] when git fails", async () => {
    const git = new GitOperations({
      exec: async () => ({
        code: 128,
        stdout: "",
        stderr: "fatal",
        killed: false,
      }),
    } as unknown as ExtensionAPI);
    const found = await git.findCheckpointsSince("abc123", marker);
    assert.deepEqual(found, []);
  });

  it("treats missing trailers as null", async () => {
    const git = new GitOperations({
      exec: async () => ({
        code: 0,
        stdout: "deadbeef\u0000wip(checkpoint): turn\u0000\u0000\n",
        stderr: "",
        killed: false,
      }),
    } as unknown as ExtensionAPI);
    const found = await git.findCheckpointsSince("abc123", marker);
    assert.equal(found[0].session, null);
    assert.equal(found[0].branch, null);
  });
});

describe("GitOperations.getStagedDiff", () => {
  it("passes --submodule=log so submodule commit logs reach the LLM", async () => {
    const git = new GitOperations({
      exec: async (_cmd: string, args?: string[]) => {
        assert.deepEqual(args, [
          "-c",
          "core.quotePath=false",
          "diff",
          "--cached",
          "--submodule=log",
        ]);
        return {
          code: 0,
          stdout:
            "diff --git a/sub b/sub\nSubmodule sub 1111..2222:\n  > feat: add widget\n",
          stderr: "",
          killed: false,
        };
      },
    } as unknown as ExtensionAPI);
    const diff = await git.getStagedDiff();
    assert.match(diff, /Submodule sub 1111\.\.2222:/);
  });
});

describe("GitOperations.findOrphanedSubmoduleHeads", () => {
  // `git ls-files -s -z` output: NUL-terminated records, raw paths.
  const gitlink = "160000 aaaa1111bbbb2222cccc3333dddd4444eeee5555 0\tsub\0";
  const regular =
    "100644 1234567890abcdef1234567890abcdef12345678 0\tfile.txt\0";

  function makePi(
    lsOutput: string,
    subStates: Record<
      string,
      { head?: string; refs?: string; code?: number } | undefined
    > = {},
  ): ExtensionAPI {
    return {
      exec: async (_cmd: string, args?: string[]) => {
        if (args?.[0] === "ls-files") {
          return { code: 0, stdout: lsOutput, stderr: "", killed: false };
        }
        if (args?.[0] === "-C") {
          const state = subStates[args[1]];
          if (args[2] === "rev-parse") {
            if (!state || state.code !== undefined) {
              return {
                code: state?.code ?? 128,
                stdout: "",
                stderr: "fatal",
                killed: false,
              };
            }
            return {
              code: 0,
              stdout: state.head + "\n",
              stderr: "",
              killed: false,
            };
          }
          if (args[2] === "for-each-ref") {
            return {
              code: 0,
              stdout: state?.refs ?? "",
              stderr: "",
              killed: false,
            };
          }
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI;
  }

  it("returns [] when the index has no gitlinks", async () => {
    const git = new GitOperations(makePi(regular));
    assert.deepEqual(await git.findOrphanedSubmoduleHeads(), []);
  });

  it("returns [] when the submodule HEAD matches the gitlink", async () => {
    const git = new GitOperations(
      makePi(gitlink, {
        sub: { head: "aaaa1111bbbb2222cccc3333dddd4444eeee5555" },
      }),
    );
    assert.deepEqual(await git.findOrphanedSubmoduleHeads(), []);
  });

  it("returns [] when HEAD differs but is reachable from a branch", async () => {
    const git = new GitOperations(
      makePi(gitlink, { sub: { head: "bbbb2222...", refs: "feature/x" } }),
    );
    assert.deepEqual(await git.findOrphanedSubmoduleHeads(), []);
  });

  it("reports the path when HEAD is a detached orphan", async () => {
    const git = new GitOperations(
      makePi(gitlink, { sub: { head: "cccc3333", refs: "" } }),
    );
    const found = await git.findOrphanedSubmoduleHeads();
    assert.equal(found.length, 1);
    assert.deepEqual(found[0], {
      path: "sub",
      indexSha: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
      headSha: "cccc3333",
    });
  });

  it("skips missing or uninitialised submodule directories", async () => {
    const git = new GitOperations(makePi(gitlink, { sub: { code: 128 } }));
    assert.deepEqual(await git.findOrphanedSubmoduleHeads(), []);
  });
});

describe("GitOperations.getCurrentBranch", () => {
  it("returns the trimmed branch name", async () => {
    const git = new GitOperations({
      exec: async (_cmd: string, args?: string[]) => {
        assert.deepEqual(args, ["branch", "--show-current"]);
        return { code: 0, stdout: "wt/task1\n", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);
    assert.equal(await git.getCurrentBranch(), "wt/task1");
  });

  it("returns null on detached HEAD or failure", async () => {
    const git = new GitOperations({
      exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    } as unknown as ExtensionAPI);
    assert.equal(await git.getCurrentBranch(), null);

    const failing = new GitOperations({
      exec: async () => ({
        code: 128,
        stdout: "",
        stderr: "fatal",
        killed: false,
      }),
    } as unknown as ExtensionAPI);
    assert.equal(await failing.getCurrentBranch(), null);
  });
});

describe("GitOperations staged materials keep paths raw", () => {
  /**
   * Every consumer compares these paths against commit-group file lists,
   * which are raw. A quoted `"\346\227\245.ts"` never matches, so the coverage
   * guard would fall back to a single commit and the review path would treat
   * the file as dropped.
   */
  async function argsOf(
    call: (git: GitOperations) => Promise<unknown>,
  ): Promise<string[]> {
    let captured: string[] = [];
    const git = new GitOperations({
      exec: async (_command: string, args?: string[]) => {
        captured = args ?? [];
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);
    await call(git);
    return captured;
  }

  const cases = [
    ["getStagedNameStatus", (g: GitOperations) => g.getStagedNameStatus()],
    ["getStagedDiff", (g: GitOperations) => g.getStagedDiff()],
    ["getStagedDiff:pathspec", (g: GitOperations) => g.getStagedDiff("src")],
    ["getStagedStat", (g: GitOperations) => g.getStagedStat()],
  ] as const;

  for (const [name, call] of cases) {
    it(`${name} disables core.quotePath`, async () => {
      const args = await argsOf(call);
      assert.deepEqual(args.slice(0, 2), ["-c", "core.quotePath=false"]);
    });
  }
});

describe("GitOperations.getStagedDiffSize", () => {
  /**
   * The size must be measured by git itself: reading the diff into a string
   * is what aborts the process on a huge index, so the check has to happen
   * without it.
   */
  async function sizeWith(result: ExecResult): Promise<{
    size: number;
    command: string;
    args: string[];
  }> {
    let command = "";
    let args: string[] = [];
    const git = new GitOperations({
      exec: async (cmd: string, a?: string[]) => {
        command = cmd;
        args = a ?? [];
        return result;
      },
    } as unknown as ExtensionAPI);
    return { size: await git.getStagedDiffSize(), command, args };
  }

  it("pipes the staged diff into wc -c", async () => {
    const { size, command, args } = await sizeWith({
      code: 0,
      stdout: "123456\n",
      stderr: "",
      killed: false,
    });

    assert.equal(size, 123456);
    assert.equal(command, "sh");
    assert.equal(args[0], "-c");
    assert.match(args[1], /git .*diff --cached --submodule=log \| wc -c/);
  });

  it("returns 0 when the measurement fails", async () => {
    const { size } = await sizeWith({
      code: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
      killed: false,
    });
    assert.equal(size, 0);
  });

  it("quotes the pathspec inside the shell command", async () => {
    let capturedCommand = "";
    let capturedArgs: string[] = [];
    const git = new GitOperations({
      exec: async (cmd: string, a?: string[]) => {
        capturedCommand = cmd;
        capturedArgs = a ?? [];
        return { code: 0, stdout: "1\n", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);

    await git.getStagedDiffSize("docs/it's here.md");
    assert.equal(capturedCommand, "sh");
    assert.ok(
      capturedArgs[1].includes("-- 'docs/it'\\''s here.md'"),
      capturedArgs[1],
    );
  });

  it("returns 0 when the output is not a number", async () => {
    const { size } = await sizeWith({
      code: 0,
      stdout: "oops\n",
      stderr: "",
      killed: false,
    });
    assert.equal(size, 0);
  });
});
