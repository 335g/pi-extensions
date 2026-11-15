import assert from "node:assert";
import { describe, it } from "node:test";
import {
  BACKSTOP_REORGANISE_AT,
  buildBlockReason,
  isGitPushCommand,
  shouldBlockGitCommit,
  shouldBlockGitHardReset,
  shouldCreateCheckpointCommit,
  shouldReorganiseAtBackstop,
  shouldSkipReorganisation,
} from "./commit-policy.js";

function makeToolResult(toolName: string) {
  return {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName,
    content: [{ type: "text" as const, text: "ok" }],
    isError: false,
    timestamp: Date.now(),
  };
}

void describe("shouldCreateCheckpointCommit", () => {
  void it("returns false for empty tool results", () => {
    assert.strictEqual(shouldCreateCheckpointCommit([]), false);
  });

  void it("returns false for read-only tools", () => {
    assert.strictEqual(
      shouldCreateCheckpointCommit([
        makeToolResult("read"),
        makeToolResult("grep"),
        makeToolResult("find"),
        makeToolResult("ls"),
      ]),
      false,
    );
  });

  void it("returns true for write tool", () => {
    assert.strictEqual(
      shouldCreateCheckpointCommit([makeToolResult("write")]),
      true,
    );
  });

  void it("returns true for edit tool", () => {
    assert.strictEqual(
      shouldCreateCheckpointCommit([makeToolResult("edit")]),
      true,
    );
  });

  void it("returns true for bash tool", () => {
    assert.strictEqual(
      shouldCreateCheckpointCommit([makeToolResult("bash")]),
      true,
    );
  });

  void it("returns true when any tool is potentially mutating", () => {
    assert.strictEqual(
      shouldCreateCheckpointCommit([
        makeToolResult("read"),
        makeToolResult("edit"),
        makeToolResult("grep"),
      ]),
      true,
    );
  });
});

void describe("shouldBlockGitCommit", () => {
  void it("returns false for empty string", () => {
    assert.strictEqual(shouldBlockGitCommit(""), false);
  });

  void it("returns false for unrelated commands", () => {
    assert.strictEqual(shouldBlockGitCommit("git status"), false);
    assert.strictEqual(shouldBlockGitCommit("git add -A"), false);
    assert.strictEqual(shouldBlockGitCommit("git reset --soft HEAD~1"), false);
    assert.strictEqual(shouldBlockGitCommit("git stash"), false);
    assert.strictEqual(shouldBlockGitCommit("ls -la"), false);
    assert.strictEqual(shouldBlockGitCommit("npm test"), false);
  });

  void it("detects basic git commit", () => {
    assert.strictEqual(
      shouldBlockGitCommit('git commit -m "feat: add thing"'),
      true,
    );
  });

  void it("detects git commit --amend", () => {
    assert.strictEqual(
      shouldBlockGitCommit('git commit --amend -m "fixed"'),
      true,
    );
  });

  void it("detects git commit --no-verify", () => {
    assert.strictEqual(
      shouldBlockGitCommit('git commit --no-verify -m "x"'),
      true,
    );
  });

  void it("detects git with global options before commit", () => {
    assert.strictEqual(
      shouldBlockGitCommit("git -C /some/path commit -m msg"),
      true,
    );
  });

  void it("detects git commit after && separator", () => {
    assert.strictEqual(
      shouldBlockGitCommit('git add -A && git commit -m "feat: x"'),
      true,
    );
  });

  void it("detects git commit after ; separator", () => {
    assert.strictEqual(
      shouldBlockGitCommit('git add foo; git commit -m "y"'),
      true,
    );
  });

  void it("detects git commit after || separator", () => {
    assert.strictEqual(
      shouldBlockGitCommit('false || git commit -m "z"'),
      true,
    );
  });

  void it("detects git commit after pipe separator", () => {
    assert.strictEqual(
      shouldBlockGitCommit('echo hi | git commit -m "piped"'),
      true,
    );
  });

  void it("detects git commit on a new line", () => {
    assert.strictEqual(
      shouldBlockGitCommit('git add -A\ngit commit -m "newline"'),
      true,
    );
  });

  void it("detects git commit nested in sh -c quotes", () => {
    assert.strictEqual(
      shouldBlockGitCommit('sh -c "git commit -m \\"nested\\""'),
      true,
    );
  });

  void it("does not false-positive on git add containing the word commit", () => {
    assert.strictEqual(
      shouldBlockGitCommit("git add commit-message.txt"),
      false,
    );
  });

  void it("does not false-positive on a file named git-commit", () => {
    // `git commit` requires whitespace between `git` and `commit`.
    assert.strictEqual(shouldBlockGitCommit("./git-commit"), false);
    assert.strictEqual(shouldBlockGitCommit("git-commit"), false);
  });

  void it("does not false-positive on git log --grep=commit", () => {
    assert.strictEqual(shouldBlockGitCommit("git log --grep=commit"), false);
  });

  void it("detects when only one segment of many is a commit", () => {
    assert.strictEqual(
      shouldBlockGitCommit(
        "npm run build\ngit status\ngit add dist\ngit commit -m release",
      ),
      true,
    );
  });
});

void describe("shouldBlockGitHardReset", () => {
  void it("detects git reset --hard", () => {
    assert.strictEqual(shouldBlockGitHardReset("git reset --hard"), true);
  });

  void it("detects git reset --hard HEAD~1", () => {
    assert.strictEqual(
      shouldBlockGitHardReset("git reset --hard HEAD~1"),
      true,
    );
  });

  void it("detects git reset --hard with global options", () => {
    assert.strictEqual(
      shouldBlockGitHardReset("git -C /path reset --hard"),
      true,
    );
  });

  void it("detects git reset --hard in a compound command", () => {
    assert.strictEqual(
      shouldBlockGitHardReset("git add -A && git reset --hard"),
      true,
    );
  });

  void it("detects git reset --hard on a new line", () => {
    assert.strictEqual(
      shouldBlockGitHardReset("git reset --hard\ngit status"),
      true,
    );
  });

  void it("allows git reset --soft", () => {
    assert.strictEqual(
      shouldBlockGitHardReset("git reset --soft HEAD~1"),
      false,
    );
  });

  void it("allows git reset --mixed", () => {
    assert.strictEqual(
      shouldBlockGitHardReset("git reset --mixed HEAD~1"),
      false,
    );
  });

  void it("allows plain git reset", () => {
    assert.strictEqual(shouldBlockGitHardReset("git reset HEAD~1"), false);
  });
});

void describe("buildBlockReason", () => {
  void it("mentions the disable command in Japanese", () => {
    const reason = buildBlockReason("commit", true);
    assert.ok(reason.includes("commit"));
    assert.ok(reason.includes("/autocommit-enable false"));
  });

  void it("mentions the disable command in English", () => {
    const reason = buildBlockReason("commit", false);
    assert.ok(reason.includes("commit"));
    assert.ok(reason.includes("/autocommit-enable false"));
  });

  void it("reset --hard reason explains the destructive nature", () => {
    const ja = buildBlockReason("reset --hard", true);
    assert.ok(ja.includes("作業ツリー"));
    const en = buildBlockReason("reset --hard", false);
    assert.ok(en.includes("working tree"));
  });

});

void describe("shouldSkipReorganisation", () => {
  void it("skips when both hashes are identical", () => {
    assert.strictEqual(shouldSkipReorganisation("abc123", "abc123"), true);
  });

  void it("does not skip when hashes differ", () => {
    assert.strictEqual(shouldSkipReorganisation("abc123", "def456"), false);
  });

  void it("does not skip when the baseline is null", () => {
    assert.strictEqual(shouldSkipReorganisation(null, "abc123"), false);
  });

  void it("does not skip when the current head is null", () => {
    assert.strictEqual(shouldSkipReorganisation("abc123", null), false);
  });

  void it("does not skip when both are null", () => {
    assert.strictEqual(shouldSkipReorganisation(null, null), false);
  });
});

void describe("shouldReorganiseAtBackstop", () => {
  void it("fires in auto mode once the pending run reaches the cap", () => {
    assert.strictEqual(BACKSTOP_REORGANISE_AT, 10);
    assert.strictEqual(
      shouldReorganiseAtBackstop(BACKSTOP_REORGANISE_AT, "auto"),
      true,
    );
    assert.strictEqual(
      shouldReorganiseAtBackstop(BACKSTOP_REORGANISE_AT - 1, "auto"),
      false,
    );
  });

  void it("never interrupts picker or review mode", () => {
    assert.strictEqual(shouldReorganiseAtBackstop(99, "picker"), false);
    assert.strictEqual(shouldReorganiseAtBackstop(99, "review"), false);
  });
});

void describe("isGitPushCommand", () => {
  void it("returns false for unrelated commands", () => {
    for (const command of [
      "",
      "git status",
      "git fetch",
      "git pull",
      "git add -A",
      "ls -la",
      "git log --grep=push",
      "./git-push",
      "git pushup",
    ]) {
      assert.strictEqual(isGitPushCommand(command), false);
    }
  });

  void it("detects push with refspec, flags and global options", () => {
    for (const command of [
      "git push",
      "git push origin main",
      "git push --force-with-lease origin main",
      "git push origin --delete feature-branch",
      "git -C /some/path push origin main",
      "npm run build && git push origin main",
      "git add -A\ngit push origin main",
      'sh -c "git push origin main"',
    ]) {
      assert.strictEqual(isGitPushCommand(command), true);
    }
  });
});

void describe("guard scope", () => {
  void it("allows push, merge, cherry-pick and rebase", () => {
    for (const command of [
      "git push origin main",
      "git merge wt/task1",
      "git cherry-pick abc123",
      "git rebase main",
    ]) {
      assert.strictEqual(shouldBlockGitCommit(command), false);
      assert.strictEqual(shouldBlockGitHardReset(command), false);
    }
  });
});
