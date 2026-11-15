import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCheckpointMessage } from "./pipeline.js";

describe("buildCheckpointMessage", () => {
  const msg = "wip(checkpoint): auto-commit at turn 3";

  it("returns the plain message when nothing is available", () => {
    assert.equal(buildCheckpointMessage(msg), msg);
  });

  it("appends only the session trailer when no branch is available", () => {
    assert.equal(
      buildCheckpointMessage(msg, "session-abc"),
      `${msg}\n\nCheckpoint-Session: session-abc`,
    );
  });

  it("appends session and branch trailers together", () => {
    assert.equal(
      buildCheckpointMessage(msg, "session-abc", "wt/task1"),
      `${msg}\n\nCheckpoint-Session: session-abc\nCheckpoint-Branch: wt/task1`,
    );
  });

  it("appends only the branch trailer when no session is available", () => {
    assert.equal(
      buildCheckpointMessage(msg, undefined, "wt/task1"),
      `${msg}\n\nCheckpoint-Branch: wt/task1`,
    );
  });

  it("skips empty branch and empty session", () => {
    assert.equal(
      buildCheckpointMessage(msg, "session-abc", ""),
      `${msg}\n\nCheckpoint-Session: session-abc`,
    );
    assert.equal(
      buildCheckpointMessage(msg, "", "wt/task1"),
      `${msg}\n\nCheckpoint-Branch: wt/task1`,
    );
  });
});

import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { CheckpointStore } from "./checkpoint-store.js";
import { runCheckpointCommit } from "./pipeline.js";

function fakeStore(overrides: Partial<CheckpointStore> = {}): {
  store: CheckpointStore;
  commitCalls: string[];
} {
  const commitCalls: string[] = [];
  const store: CheckpointStore = {
    isInsideGitRepo: async () => true,
    hasMergeConflict: async () => false,
    checkStatus: async () => ({ hasChanges: true, raw: " m sub" }),
    stageAll: async () => {},
    stageAllIgnoringSubmodules: async () => {},
    hasStagedChanges: async () => true,
    commit: async (message: string): Promise<ExecResult> => {
      commitCalls.push(message);
      return {
        code: 0,
        stdout: "[main abc123] wip(checkpoint)",
        stderr: "",
        killed: false,
      };
    },
    getCurrentBranch: async () => "main",
    unstageAll: async () => {},
    ...overrides,
  } as CheckpointStore;
  return { store, commitCalls };
}

describe("runCheckpointCommit", () => {
  const message = "wip(checkpoint): auto-commit at turn 1";

  it("skips silently when nothing is stageable (submodule-only dirt)", async () => {
    const { store, commitCalls } = fakeStore({
      hasStagedChanges: async () => false,
    });
    const result = await runCheckpointCommit(store, message, "session-1");
    assert.equal(result.committed, false);
    assert.equal(commitCalls.length, 0, "must not attempt a commit");
    assert.ok(
      result.events.some(
        (e) => e.type === "info" && /no stageable changes/i.test(e.message),
      ),
      "should report a clean skip instead of throwing",
    );
  });

  it("commits when staging produced changes", async () => {
    const { store, commitCalls } = fakeStore();
    const result = await runCheckpointCommit(store, message, "session-1");
    assert.equal(result.committed, true);
    assert.equal(commitCalls.length, 1);
    assert.equal(
      commitCalls[0],
      `${message}\n\nCheckpoint-Session: session-1\nCheckpoint-Branch: main`,
    );
  });

  it("unstages and rethrows when the commit itself fails", async () => {
    let unstageCalls = 0;
    const { store } = fakeStore({
      commit: async () => ({
        code: 1,
        stdout: "",
        stderr: "nothing to commit",
        killed: false,
      }),
      unstageAll: async () => {
        unstageCalls++;
      },
    });
    await assert.rejects(
      () => runCheckpointCommit(store, message),
      /Commit failed/,
    );
    assert.equal(unstageCalls, 1);
  });

  it("routes staging through stageAllIgnoringSubmodules when ignoreSubmodules is set", async () => {
    const { store } = fakeStore({});
    let ignoredStagingUsed = false;
    (store as CheckpointStore).stageAllIgnoringSubmodules = async () => {
      ignoredStagingUsed = true;
    };
    const result = await runCheckpointCommit(store, message, undefined, {
      ignoreSubmodules: true,
    });
    assert.equal(result.committed, true);
    assert.ok(ignoredStagingUsed, "submodule-excluding staging path was used");
  });
});
