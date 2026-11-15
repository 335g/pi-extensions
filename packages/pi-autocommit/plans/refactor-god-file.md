# リファクタリング計画: God File の分割と重複除去 (v6)

> **2026-07-10 note**: この計画は `pi-git` 時代の歴史的記録です。その後リネーム（`pi-git` → `pi-autocommit`）とスコープ縮小（`/git-commit`, `/git-status` 削除）が行われました。詳細は ADR 0002 を参照。

> **2026-07-05 更新**: この計画の完了後に以下の変更が行われました。
> - `/git-review` コマンド（crit レビューフロー全体）を削除
> - `agent_end` 単発コミットモード（`trigger: "agent_end"`）を削除
> - `commitEveryTurn` は `turn_end` checkpoint + reorganise 戦略のみに単純化
> - `src/reviewer.ts` / `src/reviewer.test.ts` を削除
> - `src/config.ts` の `ResolvedCommitEveryTurnConfig` から `trigger` フィールドを削除
> - 削除された分、index.ts はさらに短縮されました

## 概要

`src/index.ts` (約686行→短縮済み) に `/commit`・`/review`・`agent_end` auto-commit の3つのフローが重複して実装されていた。共通パイプラインを抽出し、責務ごとにファイル分割する。

---

## 現状の問題

### `src/index.ts` に3つの重複フロー

```
index.ts
├── /commit ハンドラ        ← ステージ → ファイル選択 → LLM生成 → 確認 → commit
├── /review ハンドラ        ← ステージ → ファイル選択 → crit → LLM生成 → 確認 → commit
└── agent_end auto-commit   ← ステージ → LLM生成 → commit（確認なし）
```

各フローが以下のロジックを個別に実装:
- Gitリポジトリチェック
- マージコンフリクトチェック
- Stage all
- ファイル選択（/commit と /review で同一）
- 非選択ファイルの unstage
- LLMコミットメッセージ生成
- 確認ループ（/commit と /review でほぼ同一）
- commit実行
- フッターステータス更新

---

## 計画

### Step 1: `src/pipeline.ts` — コミットパイプライン

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiGitConfig } from "./config.js";
import { GitOperations } from "./git-operations.js";
import { selectFiles, type FileDetail } from "./file-selector.js";
import { generateCommitMessageWithLLM } from "./llm-commit.js";
import { parseNameStatus } from "./git-parser.js";
import type { MessageAction } from "./confirmation.js";

// ── 型定義 ───────────────────────────────────────────────

/** pipeline の状態を hook に渡すコンテキスト */
export interface PipelineContext {
  pi: ExtensionAPI;
  selectedFiles: string[];
  fileDetails: Map<string, FileDetail> | undefined;
  stagedDiff: string;
  stagedStat: string;
  stagedNameStatus: string;
}

export interface CommitPipelineHooks {
  /**
   * stage + file selection 後に呼ばれる。
   * - crit review などを差し込む
   * - PipelineContext で選択ファイルの diff/stat にアクセス可能
   * - options ミュータブル参照を受け取るので、llmExtraContext などを
   *   書き換えて pipeline 後続ステップにデータを渡せる
   * - エラーを throw → pipeline が catch し cleanup + 呼び出し側に再 throw
   */
  onBeforeGenerate?: (
    ctx: PipelineContext,
    options: CommitPipelineOptions,
  ) => Promise<void>;

  /**
   * LLM メッセージ生成後に呼ばれる。確認ループを実装する。
   * undefined → commit を実行する（agent_end auto-commit 用）
   */
  onMessageGenerated?: (message: string) => Promise<MessageAction>;

  /** commit 実行後に呼ばれる。将来の拡張用。 */
  postCommit?: () => Promise<void>;
}

export interface CommitPipelineOptions {
  hooks?: CommitPipelineHooks;

  /** 指定時は LLM 生成をスキップし、このメッセージで commit */
  inlineMessage?: string;

  /**
   * dry-run: commit をスキップし、メッセージのみ表示。
   * pipeline は commit 実行をスキップするが、他の全ステップは
   * 通常通り実行される。dry-run 時も unstageAll は行わない
   * （現在の動作を維持）。
   */
  dryRun?: boolean;

  /**
   * ファイル選択UIをスキップする（agent_end auto-commit 用）。
   * true → 全ステージファイルをそのまま使う。
   */
  skipFileSelection?: boolean;

  /**
   * selectFiles の確認ボタンラベル。
   * "/commit" → "commit", "/review" → "review"
   * 未指定時はデフォルト値 "confirm" が使われる。
   */
  confirmLabel?: string;

  /**
   * LLM commit message 生成時に追加コンテキストとして渡す文字列。
   * crit のレビューコメント（reviewContext）を伝達するために使う。
   *
   * 通常は onBeforeGenerate フック内で options.llmExtraContext を
   * 直接書き換えて設定する。
   *
   * NOTE: inlineMessage が指定されている場合、LLM 生成がスキップ
   * されるためこの値は無視される。
   */
  llmExtraContext?: string;
}

// ── パイプライン関数 ─────────────────────────────────────

/**
 * コミットパイプラインを実行する。
 *
 * フロー:
 *   1. Gitリポジトリチェック
 *   2. マージコンフリクトチェック
 *   3. 変更有無チェック
 *   4. Stage all
 *   5. ファイル選択
 *      - skipFileSelection=true → 全ファイルをそのまま使用
 *      - skipFileSelection=false → selectFiles() を表示
 *      - selectFiles → null: キャンセル → unstageAll + footer + return
 *      - selectFiles → []: 0ファイル  → unstageAll + footer + return
 *   6. 非選択ファイルの unstage
 *   7. Staged diff/stat/nameStatus を収集 → PipelineContext 構築
 *   8. hooks.onBeforeGenerate?.(ctx, options)
 *      - crit review などを実行（エラー時 throw → pipeline が catch し cleanup + 再 throw）
 *   9. コミットメッセージ決定:
 *      inlineMessage あり → そのまま利用
 *      inlineMessage なし → LLM で生成（失敗時は heuristic fallback）
 *   10. hooks.onMessageGenerated?.(message)
 *       - cancel → unstageAll + footer + return
 *       - それ以外 → 続行
 *       undefined → 即 commit（agent_end 用）
 *   11. Commit 実行（dryRun 時はスキップ）
 *       - 非ゼロ終了コード → throw（pipeline の error boundary が cleanup + 再 throw）
 *   12. hooks.postCommit?.()
 *   13. フッターステータス更新
 *
 * エラーバウンダリ: 全体を try/catch/finally でラップ。
 * 異常時は unstageAll + フッター更新を保証する。
 * フックが throw / 非ゼロ終了コード検出時は cleanup → 呼び出し側に再 throw。
 * 呼び出し側は try/catch でエラー通知を行う。
 *
 * dryRun 時は commit をスキップ、unstageAll は行わない。
 */
export async function runCommitPipeline(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: PiGitConfig,
  options?: CommitPipelineOptions,
): Promise<void>
```

### Step 2: `src/confirmation.ts` — 確認ループ

```typescript
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * 確認ループの戻り値。
 * 曖昧さを排除した discriminated union。
 * - commit : そのまま commit 実行
 * - edit   : 編集後のメッセージで commit
 * - cancel : 中断（pipeline が cleanup）
 */
export type MessageAction =
  | { action: "commit" }
  | { action: "edit"; message: string }
  | { action: "cancel" };

/**
 * dryRun → メッセージ表示のみ（{ action: "commit" } を返す。pipeline 側で commit はスキップ）
 * TUI   → widget 表示 → select (Y/N/Edit) → 結果を返す
 * 非TUI → notify → { action: "commit" }
 */
export async function confirmCommitMessage(
  ctx: ExtensionContext,
  message: string,
  widgetId: string,
  dryRun?: boolean,
): Promise<MessageAction>
```

### Step 3: `src/args.ts` — 引数パース

```typescript
export interface ParsedCommitArgs {
  dryRun: boolean;
  inlineMessage: string;
}

/**
 * rawArgs から --dry-run とインラインメッセージを抽出する純粋関数。
 *
 * Examples:
 *   parseCommitArgs("")                → { dryRun: false, inlineMessage: "" }
 *   parseCommitArgs("fix typo")        → { dryRun: false, inlineMessage: "fix typo" }
 *   parseCommitArgs("--dry-run")       → { dryRun: true,  inlineMessage: "" }
 *   parseCommitArgs("--dry-run fix")   → { dryRun: true,  inlineMessage: "fix" }
 */
export function parseCommitArgs(raw: string): ParsedCommitArgs
```

### Step 4: `src/index.ts` — ハンドラのみに純化

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { runCommitPipeline } from "./pipeline.js";
import { parseCommitArgs } from "./args.js";
import { confirmCommitMessage } from "./confirmation.js";
import { GitOperations } from "./git-operations.js";
import { checkCritAvailable, runCritReview } from "./reviewer.js";

export default function (pi: ExtensionAPI) {
  // ── Footer status ────────────────────────────────────────
  async function updateFooterStatus(ctx: ExtensionContext) { /* 変更なし */ }

  // ── /commit ──────────────────────────────────────────────
  pi.registerCommand("commit", {
    description: "Stage all changes and generate a Conventional Commits message",
    handler: async (args, ctx) => {
      const { dryRun, inlineMessage } = parseCommitArgs(args?.trim() ?? "");
      const config = loadConfig(ctx.cwd);
      try {
        await runCommitPipeline(pi, ctx, config, {
          inlineMessage,
          dryRun,
          confirmLabel: "commit",
          hooks: {
            onMessageGenerated: async (msg) =>
              inlineMessage
                ? { action: "commit" }
                : confirmCommitMessage(ctx, msg, "pi-git-commit", dryRun),
          },
        });
      } catch (err) {
        ctx.ui.notify(
          `Commit error: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  // ── /review ──────────────────────────────────────────────
  pi.registerCommand("review", {
    description: "Stage, review with crit, generate commit message, and commit",
    handler: async (args, ctx) => {
      const { dryRun } = parseCommitArgs(args?.trim() ?? "");
      const config = loadConfig(ctx.cwd);
      try {
        await checkCritAvailable(pi);
        await runCommitPipeline(pi, ctx, config, {
          dryRun,
          confirmLabel: "review",
          hooks: {
            onBeforeGenerate: async (pipelineCtx, opts) => {
              // ── Per-file entries を構築 ──────────────────
              const fileEntries = pipelineCtx.selectedFiles
                .map((path) => {
                  const detail = pipelineCtx.fileDetails?.get(path);
                  return detail
                    ? { path, additions: detail.additions, deletions: detail.deletions }
                    : null;
                })
                .filter((e): e is NonNullable<typeof e> => e != null);

              // ── crit review を実行 ────────────────────────
              const result = await runCritReview(
                pipelineCtx.pi,
                pipelineCtx.stagedDiff,
                fileEntries,
              );

              // ── Unresolved comments の処理 ────────────────
              const unresolvedComments = result.comments.filter((c) => !c.resolved);
              let reviewContext: string | undefined;

              if (unresolvedComments.length > 0) {
                const commentSummary = unresolvedComments
                  .map((c) => {
                    const location = c.file
                      ? `${c.file}${c.quote ? `: "${c.quote}"` : ""}`
                      : "";
                    return location ? `${location}: ${c.body}` : c.body;
                  })
                  .join("\n");

                ctx.ui.notify(
                  `Unresolved review comments:\n${commentSummary}`,
                  "warning",
                );

                if (ctx.hasUI) {
                  const choice = await ctx.ui.select(
                    "Review has unresolved comments. Continue with commit?",
                    [
                      "Yes — include comments in commit message context",
                      "No — cancel and fix issues first",
                    ],
                  );
                  if (choice !== "Yes — include comments in commit message context") {
                    // throw → pipeline の error boundary が cleanup + 再 throw
                    throw new Error("Review cancelled by user — fix issues first.");
                  }
                }

                reviewContext = commentSummary;
              }

              // ── LLM コンテキストを設定 ──────────────────
              if (reviewContext) {
                opts.llmExtraContext = reviewContext;
              }
            },
            onMessageGenerated: async (msg) =>
              confirmCommitMessage(ctx, msg, "pi-git-review-msg", dryRun),
          },
        });
      } catch (err) {
        // "Review cancelled by user" はエラーではなく通知として表示
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("cancelled")) {
          ctx.ui.notify(msg, "info");
        } else {
          ctx.ui.notify(`Review error: ${msg}`, "error");
        }
      }
    },
  });

  // ── Footer indicator ─────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => { await updateFooterStatus(ctx); });

  // ── Auto-commit on agent_end ─────────────────────────────
  pi.on("agent_end", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (!config.commitEveryTurn) {
      await updateFooterStatus(ctx);
      return;
    }
    try {
      await runCommitPipeline(pi, ctx, config, {
        skipFileSelection: true,
        // hooks なし → onMessageGenerated undefined → 確認なしで即 commit
      });
    } catch (err) {
      ctx.ui.notify(
        `commitEveryTurn: error — ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  });
}
```

---

## 変更ファイル一覧

| ファイル | 変更内容 | 行数想定 |
|----------|---------|---------|
| `src/index.ts` | 登録＋薄いハンドラのみに削減 | ~686行 → ~150行 |
| **`src/pipeline.ts`** | **新規**: `PipelineContext`, `CommitPipelineHooks`, `CommitPipelineOptions`, `runCommitPipeline` | ~120行 |
| **`src/confirmation.ts`** | **新規**: `MessageAction`, `confirmCommitMessage` | ~60行 |
| **`src/args.ts`** | **新規**: `parseCommitArgs`, `ParsedCommitArgs` | ~25行 |
| **`src/git-parser.ts`** | **新規**: `ParsedNameStatus`, `parseNameStatus`（`commit-message.ts` から抽出） | ~25行 |
| **`src/git-parser.test.ts`** | **新規**: `parseNameStatus` の11テストケース | ~110行 |
| `src/commit-message.ts` | `CommitType`/`determineType`/`determineScope` を internal 化、`parseNameStatus` を `git-parser.ts` に移動 |
| `src/llm-commit.ts` | （変更なし） |
| `src/git-operations.ts` | （変更なし） |
| `src/reviewer.ts` | （変更なし） — `runCritReview` を `PipelineContext.pi` 経由で直接呼ぶ |
| `src/file-selector.ts` | （変更なし） |
| `src/config.ts` | （変更なし） |

---

## テスト追加

| ファイル | テストケース |
|---------|-------------|
| `src/args.test.ts` | 空文字, `--dry-run`, インラインメッセージのみ, `--dry-run fix typo`, `--dry-run` のみ |
| `src/confirmation.test.ts` | TUI confirm/edit/cancel, 非TUI 即 commit, dryRun 表示のみ |
| `src/pipeline.test.ts` | ステップ順序, hook error → cleanup + rethrow, commit 非ゼロ終了コード → throw, inlineMessage スキップ, dryRun スキップ, skipFileSelection, empty/null selection, confirmLabel 伝達, 非TUI, LLM→heuristic fallback, エラーバウンダリの unstageAll 保証 |
| `src/git-operations.test.ts` | exec 結果のパース（pi.exec を inject 可能にした場合） |

---

## 非機能要件

- **振る舞いの完全保存**: 既存の全フローを変更しない
  - インラインメッセージ → staging/file selection 実行、確認ループスキップ
  - dry-run → commit スキップ（unstage しない）
  - agent_end → ファイル選択なし、確認なし、`commitEveryTurn:` プレフィックス維持
  - `/commit` 確認ラベル "Cancel and retry" → "Cancel" に変更（機能に影響なし）
  - `/review` unresolved comments → ユーザー確認 → commit メッセージコンテキストに反映
- **段階的リファクタリング**: 新規ファイルを先に作り、最後に index.ts から切り替える
- **エラー時の安全性**: pipeline の error boundary が常に unstageAll + footer 更新を保証。呼び出し側が try/catch でユーザー通知を行う

---

## リスクと対策

| リスク | 対策 |
|--------|------|
| Per-file detail 収集タイミング | pipeline 内で file selection 直後に収集し `PipelineContext` に格納 |
| インラインメッセージ + 確認ループ | インラインメッセージ時は `onMessageGenerated` 内で `{ action: "commit" }` を即返す |
| crit → LLM コンテキスト伝達 | `PipelineContext.pi` + `options` ミュータブル参照で実現 |
| Hook エラーの呼び出し側伝搬 | pipeline → cleanup + 再 throw → 呼び出し側 try/catch → notify + return |
| `/review` unresolved comments 喪失 | `onBeforeGenerate` 内で unresolved filter + ユーザー確認 + キャンセル時 throw で pipeline に伝搬 |
| `confirmLabel` の差異 | `CommitPipelineOptions.confirmLabel` で渡す |
| `selectedFiles` 空/キャンセル | pipeline 内で早期 return + cleanup |
| Commit 非ゼロ終了コード | pipeline step 11 で `result.code !== 0` 検出時 throw → error boundary → cleanup + 再 throw |
| dry-run の unstage 有無 | 現在の動作に合わせ、dry-run 時は unstage しない |
| `MessageAction` の所在 | `confirmation.ts` で定義し `pipeline.ts` が import |
