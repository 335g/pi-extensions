import assert from "node:assert";
import { describe, it } from "node:test";
import type { CommitGroup } from "./commit-prompt.js";
import {
  formatAllGroupsPreview,
  formatGroupPreview,
  parsePartition,
  renderPartition,
  reviewCommitGroups,
} from "./group-review.js";

const group = (message: string, files: string[]): CommitGroup => ({
  message,
  files,
});

interface UiCalls {
  confirm: string[];
  editor: string[];
  working: boolean[];
}

/**
 * Minimal ctx stub driving the dialogs from queues: `confirmAnswers` feeds the
 * partition gate and then one entry per proposed commit, `editorAnswers` feeds
 * the partition editor and then the per-commit message editor.
 */
function makeCtx(
  mode: string,
  confirmAnswers: boolean[],
  editorAnswers: (string | undefined)[],
): [never, UiCalls] {
  const calls: UiCalls = { confirm: [], editor: [], working: [] };
  const ctx = {
    mode,
    ui: {
      confirm: async (title: string) => {
        calls.confirm.push(title);
        return confirmAnswers.shift() ?? true;
      },
      editor: async (title: string, prefill?: string) => {
        calls.editor.push(prefill ?? "");
        return editorAnswers.shift();
      },
      setWorkingVisible: (visible: boolean) => calls.working.push(visible),
    },
  };
  return [ctx as never, calls];
}

void describe("formatGroupPreview", () => {
  void it("labels the message and the files separately", () => {
    const preview = formatGroupPreview(group("feat(a): x", ["a.ts", "b.ts"]));
    assert.ok(preview.includes("メッセージ\n  feat(a): x"));
    assert.ok(preview.includes("ファイル (2)\n  a.ts\n  b.ts"));
    assert.ok(!preview.includes("他"));
  });

  void it("indents every line of a multi-line message", () => {
    const preview = formatGroupPreview(
      group("feat(a): x\n\nbecause reasons", ["a.ts"]),
    );
    assert.ok(preview.includes("  because reasons"));
  });

  void it("spells out what the dialog options do", () => {
    const preview = formatGroupPreview(group("feat(a): x", ["a.ts"]));
    assert.ok(preview.includes("Yes = このメッセージでコミットする"));
    assert.ok(preview.includes("No  = メッセージを書き換える"));
  });

  void it("summarises a file list longer than the preview limit", () => {
    const files = Array.from({ length: 11 }, (_, i) => `f${i}.ts`);
    const preview = formatGroupPreview(group("feat(a): x", files));
    assert.ok(preview.includes("f7.ts"));
    assert.ok(!preview.includes("f8.ts"));
    assert.ok(preview.includes("…他 3 ファイル"));
    assert.ok(preview.includes("ファイル (11)"));
  });
});

void describe("formatAllGroupsPreview", () => {
  void it("lists every group with its file count so the whole split is visible", () => {
    const preview = formatAllGroupsPreview([
      group("feat(a): x", ["a.ts"]),
      group("test(a): y", ["b.ts", "c.ts"]),
    ]);
    assert.ok(preview.includes("2 件のコミットに分けます。"));
    assert.ok(preview.includes("  1) feat(a): x\n       1 ファイル"));
    assert.ok(preview.includes("  2) test(a): y\n       2 ファイル"));
  });

  void it("spells out what the gate options do", () => {
    const preview = formatAllGroupsPreview([group("feat(a): x", ["a.ts"])]);
    assert.ok(preview.includes("Yes = 分割を編集する"));
    assert.ok(preview.includes("No  = このまま作成する"));
  });
});

void describe("renderPartition", () => {
  void it("writes one header block per group", () => {
    const text = renderPartition([
      group("feat(a): x", ["a.ts", "b.ts"]),
      group("test(a): y", ["c.ts"]),
    ]);
    assert.ok(text.includes("## feat(a): x\na.ts\nb.ts"));
    assert.ok(text.includes("## test(a): y\nc.ts"));
  });
});

void describe("parsePartition", () => {
  const originals = [
    group("feat(a): x\n\nbecause reasons", ["a.ts", "b.ts"]),
    group("test(a): y", ["c.ts"]),
  ];

  void it("round-trips an untouched rendering, body included", () => {
    const { groups, error } = parsePartition(
      renderPartition(originals),
      originals,
    );
    assert.strictEqual(error, undefined);
    assert.deepStrictEqual(groups, originals);
  });

  void it("moves a file to another group", () => {
    const { groups, error } = parsePartition(
      ["## feat(a): x", "a.ts", "", "## test(a): y", "b.ts", "c.ts"].join("\n"),
      originals,
    );
    assert.strictEqual(error, undefined);
    assert.deepStrictEqual(groups?.[0].files, ["a.ts"]);
    assert.deepStrictEqual(groups?.[1].files, ["b.ts", "c.ts"]);
  });

  void it("drops a file whose line was deleted", () => {
    const { groups, error } = parsePartition(
      ["## feat(a): x", "a.ts", "", "## test(a): y", "c.ts"].join("\n"),
      originals,
    );
    assert.strictEqual(error, undefined);
    assert.deepStrictEqual(
      groups?.flatMap((g) => g.files),
      ["a.ts", "c.ts"],
    );
  });

  void it("deletes a group left with no files", () => {
    const { groups, error } = parsePartition(
      ["## feat(a): x", "a.ts", "b.ts", "c.ts"].join("\n"),
      originals,
    );
    assert.strictEqual(error, undefined);
    assert.strictEqual(groups?.length, 1);
    assert.strictEqual(groups?.[0].message, "feat(a): x\n\nbecause reasons");
  });

  void it("adds a group from a new header, subject-only", () => {
    const { groups, error } = parsePartition(
      [
        "## feat(a): x",
        "a.ts",
        "",
        "## docs(a): new one",
        "b.ts",
        "",
        "## test(a): y",
        "c.ts",
      ].join("\n"),
      originals,
    );
    assert.strictEqual(error, undefined);
    assert.strictEqual(groups?.length, 3);
    assert.strictEqual(groups?.[1].message, "docs(a): new one");
    assert.deepStrictEqual(groups?.[1].files, ["b.ts"]);
  });

  void it("keeps the body only while the subject is untouched", () => {
    const { groups } = parsePartition(
      ["## feat(a): rewritten", "a.ts", "b.ts", "c.ts"].join("\n"),
      originals,
    );
    assert.strictEqual(groups?.[0].message, "feat(a): rewritten");
  });

  void it("rejects a file line before any header", () => {
    const { error } = parsePartition(
      ["a.ts", "## feat(a): x"].join("\n"),
      originals,
    );
    assert.ok(error?.includes("見出しの前"));
  });

  void it("rejects a path that was never staged", () => {
    const { error } = parsePartition(
      ["## feat(a): x", "a.ts", "b.ts", "c.ts", "typo.ts"].join("\n"),
      originals,
    );
    assert.ok(error?.includes("typo.ts"));
  });

  void it("rejects a path claimed by two groups", () => {
    const { error } = parsePartition(
      ["## feat(a): x", "a.ts", "b.ts", "## test(a): y", "c.ts", "a.ts"].join(
        "\n",
      ),
      originals,
    );
    assert.ok(error?.includes("複数のコミット"));
  });
});

void describe("reviewCommitGroups", () => {
  const groups = [group("feat(a): x", ["a.ts"]), group("test(a): y", ["b.ts"])];

  void it("returns the groups untouched in non-TUI mode", async () => {
    const [ctx, calls] = makeCtx("rpc", [], []);
    assert.deepStrictEqual(await reviewCommitGroups(ctx, groups), groups);
    assert.deepStrictEqual(calls.confirm, []);
  });

  void it("skips the partition editor when the gate is declined", async () => {
    const [ctx, calls] = makeCtx("tui", [false, true, true], []);
    assert.deepStrictEqual(await reviewCommitGroups(ctx, groups), groups);
    assert.strictEqual(calls.confirm.length, 3);
    assert.deepStrictEqual(calls.editor, []);
    assert.deepStrictEqual(calls.working, [false, true]);
  });

  void it("applies an edited partition before the message dialogs", async () => {
    const [ctx, calls] = makeCtx(
      "tui",
      [true, true, true],
      ["## feat(a): x\na.ts\nb.ts"],
    );
    const reviewed = await reviewCommitGroups(ctx, groups);
    assert.strictEqual(reviewed?.length, 1);
    assert.deepStrictEqual(reviewed?.[0].files, ["a.ts", "b.ts"]);
    // gate + the single surviving group
    assert.strictEqual(calls.confirm.length, 2);
    assert.strictEqual(calls.editor.length, 1);
  });

  void it("re-opens the partition editor when the text does not parse", async () => {
    const [ctx, calls] = makeCtx(
      "tui",
      [true, true, true],
      ["## feat(a): x\nnope.ts", "## feat(a): x\na.ts\nb.ts"],
    );
    const reviewed = await reviewCommitGroups(ctx, groups);
    assert.deepStrictEqual(reviewed?.[0].files, ["a.ts", "b.ts"]);
    assert.strictEqual(calls.editor.length, 2);
    assert.ok(calls.editor[1].includes("エラー"));
  });

  void it("aborts when the partition editor is cancelled", async () => {
    const [ctx] = makeCtx("tui", [true], [undefined]);
    assert.strictEqual(await reviewCommitGroups(ctx, groups), null);
  });

  void it("commits nothing and skips the message dialogs when all files are dropped", async () => {
    const [ctx, calls] = makeCtx("tui", [true], ["# everything gone"]);
    assert.deepStrictEqual(await reviewCommitGroups(ctx, groups), []);
    assert.strictEqual(calls.confirm.length, 1);
  });

  void it("replaces the message when the message editor returns one", async () => {
    const [ctx, calls] = makeCtx(
      "tui",
      [false, false, true],
      ["fix(a): rewritten\n"],
    );
    const reviewed = await reviewCommitGroups(ctx, groups);
    assert.strictEqual(reviewed?.[0].message, "fix(a): rewritten");
    assert.deepStrictEqual(reviewed?.[0].files, ["a.ts"]);
    assert.strictEqual(reviewed?.[1].message, "test(a): y");
    assert.strictEqual(calls.editor.length, 1);
  });

  void it("aborts when the message editor is cancelled", async () => {
    const [ctx] = makeCtx("tui", [false, false], [undefined]);
    assert.strictEqual(await reviewCommitGroups(ctx, groups), null);
  });

  void it("aborts when the message editor returns an empty message", async () => {
    const [ctx] = makeCtx("tui", [false, false], ["   "]);
    assert.strictEqual(await reviewCommitGroups(ctx, groups), null);
  });
});
