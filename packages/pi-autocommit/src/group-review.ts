import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommitGroup } from "./commit-prompt.js";

/** How many files of one group the preview lists before summarising. */
const MAX_PREVIEW_FILES = 8;
/** Marks a group header line in the partition editor. */
const HEADER_PREFIX = "## ";

/** Instructions shown as comments at the top of the partition editor. */
const PARTITION_HELP = [
  "# 分割の編集: ファイル行を別の「## 」ブロックの下へ移すとコミット間の割り替え、",
  "# 行を削除するとそのファイルはコミットされません（未コミットのまま残ります）。",
  "# 「## 」行を書き換えるとメッセージの編集、追加すると新しいコミットになります。",
  "# ファイルがなくなるだけのブロックは削除されます。",
  "# 問題なければそのまま保存。空で保存すると整理を中止します。",
].join("\n");

/**
 * Render one proposed group for its confirmation dialog.
 *
 * The message and the files each get their own label, and the dialog's
 * options are spelled out, because `ctx.ui.confirm()` hands its whole body to
 * pi's `ExtensionSelectorComponent`, which renders title and body as one
 * bold accent-coloured block. Styling cannot express hierarchy there, so the
 * labels and blank lines have to.
 */
export function formatGroupPreview(group: CommitGroup): string {
  const shown = group.files.slice(0, MAX_PREVIEW_FILES);
  const rest = group.files.length - shown.length;
  const files = shown.map((file) => `  ${file}`).join("\n");
  const suffix = rest > 0 ? `\n  …他 ${rest} ファイル` : "";
  const message = group.message
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : ""))
    .join("\n");
  return [
    "メッセージ",
    message,
    "",
    `ファイル (${group.files.length})`,
    `${files}${suffix}`,
    "",
    "Yes = このメッセージでコミットする",
    "No  = メッセージを書き換える（エディタが開きます）",
  ].join("\n");
}

/**
 * Render every proposed group for the gate dialog: one line per commit so the
 * shape of the whole split is visible without a scroll, then what the
 * dialog's Yes and No do.
 */
export function formatAllGroupsPreview(groups: CommitGroup[]): string {
  const lines = groups.map(
    (group, index) =>
      `  ${index + 1}) ${group.message.split("\n")[0]}\n       ${group.files.length} ファイル`,
  );
  return [
    `${groups.length} 件のコミットに分けます。`,
    "",
    ...lines,
    "",
    "Yes = 分割を編集する（エディタが開きます）",
    "No  = このまま作成する",
  ].join("\n");
}

/**
 * Render the groups as the editable partition text: a `## ` header per group
 * followed by its file paths. The union of the file lines is the staged set,
 * so deleting a line is how a file is dropped.
 *
 * ponytail: a path starting with `#` renders as a comment and parses back as
 * dropped (reported, not silent). Escape file lines if such a path shows up.
 */
export function renderPartition(groups: CommitGroup[]): string {
  const body = groups
    .map(
      (group) =>
        `${HEADER_PREFIX}${group.message.split("\n")[0]}\n${group.files.join("\n")}`,
    )
    .join("\n\n");
  return `${PARTITION_HELP}\n\n${body}\n`;
}

/** A parsed partition, or the reason it was rejected. */
type PartitionResult =
  | { groups: CommitGroup[]; error?: undefined }
  | { error: string; groups?: undefined };

/**
 * Parse partition text back into groups.
 *
 * A header whose subject matches an original group's subject keeps that
 * group's full message (body included); any other header becomes a
 * subject-only message the later message review can expand.
 *
 * Rejects a file line before any header, a path claimed twice, and a path
 * that was never staged — a typo would otherwise silently strand the real
 * file as uncommitted while committing nothing in its place.
 */
export function parsePartition(
  text: string,
  originals: CommitGroup[],
): PartitionResult {
  const known = new Set(originals.flatMap((g) => g.files));
  // ponytail: subject → message map, so two proposals sharing a subject share
  // a body. Key groups by index instead if that ever bites.
  const bodies = new Map(
    originals.map((g) => [g.message.split("\n")[0], g.message]),
  );

  const groups: CommitGroup[] = [];
  const seen = new Set<string>();
  let current: CommitGroup | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const isComment = line.startsWith("#") && !line.startsWith(HEADER_PREFIX);
    if (line.length === 0 || isComment) {
      continue;
    }
    if (line.startsWith(HEADER_PREFIX)) {
      const subject = line.slice(HEADER_PREFIX.length).trim();
      current = { message: bodies.get(subject) ?? subject, files: [] };
      groups.push(current);
      continue;
    }
    if (current === null) {
      return { error: `「## 」見出しの前にファイル行があります: ${line}` };
    }
    if (!known.has(line)) {
      return { error: `ステージされていないパスです: ${line}` };
    }
    if (seen.has(line)) {
      return { error: `ファイルが複数のコミットに割り当てられています: ${line}` };
    }
    seen.add(line);
    current.files.push(line);
  }

  // A block whose files all moved elsewhere is a deleted commit.
  return { groups: groups.filter((g) => g.files.length > 0) };
}

/**
 * Let the user edit the file partition in pi's editor, re-opening it with the
 * complaint prepended when the result does not parse.
 *
 * @returns the edited groups, or `null` when the user cancelled.
 */
async function editPartition(
  ctx: ExtensionContext,
  groups: CommitGroup[],
): Promise<CommitGroup[] | null> {
  let prefill = renderPartition(groups);
  for (;;) {
    const text = await ctx.ui.editor(
      "コミットの分割を編集（空でキャンセル → 整理を中止）",
      prefill,
    );
    if (text === undefined || text.trim().length === 0) {
      return null;
    }
    const result = parsePartition(text, groups);
    if (result.error === undefined) {
      return result.groups;
    }
    prefill = `# エラー: ${result.error}\n# 修正して保存し直してください（空でキャンセル）。\n\n${text}`;
  }
}

/**
 * Confirm each group's message, offering pi's editor to rewrite it.
 *
 * Cancelling the editor aborts the whole review: no commit is made and the
 * caller leaves the changes staged.
 *
 * @returns the (possibly edited) groups, or `null` when the user aborted.
 */
async function reviewMessages(
  ctx: ExtensionContext,
  groups: CommitGroup[],
): Promise<CommitGroup[] | null> {
  const reviewed: CommitGroup[] = [];
  for (const [index, group] of groups.entries()) {
    const title = `pi-autocommit: コミット ${index + 1}/${groups.length}`;
    const ok = await ctx.ui.confirm(title, formatGroupPreview(group));
    if (ok) {
      reviewed.push(group);
      continue;
    }

    const message = await ctx.ui.editor(
      "コミットメッセージを編集（空でキャンセル → 整理を中止）",
      group.message,
    );
    if (message === undefined || message.trim().length === 0) {
      return null;
    }
    reviewed.push({ ...group, message: message.trim() });
  }
  return reviewed;
}

/**
 * Walk the proposed groups with the user before anything is committed.
 *
 * Two steps, both skippable: a partition editor for *which files go into
 * which commit* (ADR-0014), then a per-group dialog for the message. Files
 * the user removes from the partition are not committed — `commitReviewedGroups`
 * unstages whatever the returned groups do not claim, so the coverage guard
 * still holds for every file that stays staged.
 *
 * @returns the (possibly edited) groups, or `null` when the user aborted.
 */
export async function reviewCommitGroups(
  ctx: ExtensionContext,
  groups: CommitGroup[],
): Promise<CommitGroup[] | null> {
  // Dialogs need a UI; headless runs commit the proposal as-is.
  if (ctx.mode !== "tui" || groups.length === 0) {
    return groups;
  }

  // The caller may be showing the "Reorganising…" working indicator, which
  // would otherwise sit behind the dialogs.
  ctx.ui.setWorkingVisible(false);
  try {
    const edit = await ctx.ui.confirm(
      "pi-autocommit: 提案された分割",
      formatAllGroupsPreview(groups),
    );
    const partitioned = edit ? await editPartition(ctx, groups) : groups;
    if (partitioned === null) {
      return null;
    }
    // Everything dropped: nothing to message-review, and nothing to commit.
    if (partitioned.length === 0) {
      return partitioned;
    }
    return await reviewMessages(ctx, partitioned);
  } finally {
    ctx.ui.setWorkingVisible(true);
  }
}
