import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCommitItems,
  type CommitItem,
  type CommitPicker,
  defaultRange,
  formatOrigin,
  formatSubject,
  type PickerResult,
} from "./commit-picker.js";

// ── buildCommitItems ─────────────────────────────────────

describe("buildCommitItems", () => {
  it("parses git log output into CommitItems", () => {
    const raw = [
      "abc123\0wip(checkpoint): turn 3\0\0",
      "def456\0feat: implement X\0\0",
      "789012\0wip(checkpoint): turn 2\0session-1\0wt/task1",
    ].join("\n");

    const items = buildCommitItems(raw);
    assert.equal(items.length, 3);
    assert.equal(items[0].sha, "abc123");
    assert.equal(items[0].subject, "wip(checkpoint): turn 3");
    assert.equal(items[0].isCheckpoint, true);
    assert.equal(items[0].session, undefined);
    assert.equal(items[1].sha, "def456");
    assert.equal(items[1].subject, "feat: implement X");
    assert.equal(items[1].isCheckpoint, false);
    assert.equal(items[2].sha, "789012");
    assert.equal(items[2].subject, "wip(checkpoint): turn 2");
    assert.equal(items[2].isCheckpoint, true);
    assert.equal(items[2].session, "session-1");
    assert.equal(items[2].branch, "wt/task1");
  });

  it("parses legacy two-field log lines (session/branch absent)", () => {
    const raw = "abc123\0wip(checkpoint): turn 3";
    const items = buildCommitItems(raw);
    assert.equal(items[0].sha, "abc123");
    assert.equal(items[0].session, undefined);
    assert.equal(items[0].branch, undefined);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(buildCommitItems(""), []);
    assert.deepEqual(buildCommitItems("  "), []);
  });

  it("skips lines missing sha or subject", () => {
    const raw = ["abc123\0valid", "invalid-no-null", "\0subject-only"].join(
      "\n",
    );
    const items = buildCommitItems(raw);
    assert.equal(items.length, 1);
    assert.equal(items[0].sha, "abc123");
  });
});

// ── formatOrigin ───────────────────────────────────────────

describe("formatOrigin", () => {
  it("prefers the branch over the session id", () => {
    const item: CommitItem = {
      sha: "a",
      subject: "wip(checkpoint): turn 1",
      isCheckpoint: true,
      session: "session-abc",
      branch: "wt/task1",
    };
    assert.equal(formatOrigin(item), "wt/task1");
  });

  it("falls back to a short session id when no branch is recorded", () => {
    const item: CommitItem = {
      sha: "a",
      subject: "wip(checkpoint): turn 1",
      isCheckpoint: true,
      session: "0123456789abcdef",
    };
    assert.equal(formatOrigin(item), "01234567…");
  });

  it("returns null for non-checkpoints and unknown origins", () => {
    const regular: CommitItem = {
      sha: "a",
      subject: "feat: X",
      isCheckpoint: false,
      session: "session-abc",
    };
    assert.equal(formatOrigin(regular), null);

    const orphan: CommitItem = {
      sha: "b",
      subject: "wip(checkpoint): turn 1",
      isCheckpoint: true,
    };
    assert.equal(formatOrigin(orphan), null);
  });
});

// ── defaultRange ──────────────────────────────────────────

describe("defaultRange", () => {
  it("sets [1] at HEAD and [2] at the bottom of the contiguous checkpoint run", () => {
    const items: CommitItem[] = [
      { sha: "a", subject: "wip(checkpoint): turn 3", isCheckpoint: true },
      { sha: "b", subject: "wip(checkpoint): turn 2", isCheckpoint: true },
      { sha: "c", subject: "feat: X", isCheckpoint: false },
    ];

    const { startIndex, endIndex } = defaultRange(items);
    assert.equal(startIndex, 0); // HEAD
    assert.equal(endIndex, 1); // bottom of the run at index 1
  });

  it("stops at the first non-checkpoint, excluding scattered old checkpoints", () => {
    // Old checkpoints below previously reorganised commits must NOT be
    // included by default (they may already be pushed).
    const items: CommitItem[] = [
      { sha: "a", subject: "wip(checkpoint): turn 2", isCheckpoint: true },
      { sha: "b", subject: "wip(checkpoint): turn 1", isCheckpoint: true },
      { sha: "c", subject: "feat: X", isCheckpoint: false },
      { sha: "d", subject: "fix: Y", isCheckpoint: false },
      { sha: "e", subject: "wip(checkpoint): old turn 2", isCheckpoint: true },
      { sha: "f", subject: "wip(checkpoint): old turn 1", isCheckpoint: true },
    ];

    const { startIndex, endIndex } = defaultRange(items);
    assert.equal(startIndex, 0);
    assert.equal(endIndex, 1); // NOT 4 (old scattered checkpoint)
  });

  it("falls back to both at HEAD when no checkpoints exist", () => {
    const items: CommitItem[] = [
      { sha: "a", subject: "feat: X", isCheckpoint: false },
      { sha: "b", subject: "fix: Y", isCheckpoint: false },
    ];

    const { startIndex, endIndex } = defaultRange(items);
    assert.equal(startIndex, 0);
    assert.equal(endIndex, 0);
  });

  it("handles single checkpoint at HEAD", () => {
    const items: CommitItem[] = [
      { sha: "a", subject: "wip(checkpoint): turn 1", isCheckpoint: true },
    ];

    const { startIndex, endIndex } = defaultRange(items);
    assert.equal(startIndex, 0);
    assert.equal(endIndex, 0);
  });
});

// ── formatSubject ─────────────────────────────────────────

describe("formatSubject", () => {
  it("strips checkpoint prefix with trailing text", () => {
    assert.equal(
      formatSubject("wip(checkpoint): turn 3"),
      "wip(checkpoint) turn 3",
    );
  });

  it("strips checkpoint prefix with no trailing text", () => {
    assert.equal(formatSubject("wip(checkpoint):"), "wip(checkpoint)");
    assert.equal(formatSubject("wip(checkpoint): "), "wip(checkpoint)");
  });

  it("leaves non-checkpoint subjects unchanged", () => {
    assert.equal(formatSubject("feat: implement X"), "feat: implement X");
    assert.equal(formatSubject("fix: correct Y"), "fix: correct Y");
  });
});

// ── CommitPicker (unit, no DOM) ───────────────────────────

/**
 * A minimal theme stub so CommitPicker.render() does not crash.
 */
const stubTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
};

describe("CommitPicker", () => {
  it("initialises with given items and default markers", async () => {
    // Dynamic import to get the class.
    const mod = await import("./commit-picker.js");
    const { CommitPicker: CP } = mod as typeof mod & {
      CommitPicker: new (
        items: CommitItem[],
        defaultStart: number,
        defaultEnd: number,
        theme: typeof stubTheme,
        maxVisible?: number,
      ) => CommitPicker & {
        onConfirm?: (result: PickerResult) => void;
        onCancel?: () => void;
      };
    };

    const items: CommitItem[] = [
      { sha: "a", subject: "wip(checkpoint): turn 2", isCheckpoint: true },
      { sha: "b", subject: "wip(checkpoint): turn 1", isCheckpoint: true },
      { sha: "c", subject: "feat: X", isCheckpoint: false },
    ];

    const picker = new CP(items, 0, 1, stubTheme);
    assert.ok(picker);

    // Render should not throw.
    const lines = picker.render(60);
    assert.ok(lines.length > 0);

    // Should render all visible lines.
    const rendered = lines.join("\n");
    assert.ok(rendered.includes("▸ [2]")); // cursor at end marker
    assert.ok(rendered.includes("[1]")); // start marker

    picker.onCancel = () => {};
    picker.onConfirm = () => {};
  });
});
