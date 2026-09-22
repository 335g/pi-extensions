# pi-herdr-fleet — 設計

## 目的

herdr の pane/workspace トポロジと Pi のセッション意味論を繋ぐ。

- herdr の CLI は端末を操作できるが、Pi の会話には何も差し込めない
- Pi は会話と描画を持っているが、端末を持たない
- 両方を持つのが Pi 拡張だけ

差別化の源泉は 4 つ。

1. `session.snapshot` が pane ごとの Pi セッション JSONL パス (`agent_session.value`) を返す。他人の pane の意味が読める
2. `events.subscribe` がある。ポーリング不要の常駐購読
3. Pi 拡張は自分のループに注入できる (`sendMessage` / overlay / widget / カスタム tool)
4. 描画できる場所が「人間がタイプしているその画面」

## このブランチのスコープ

| Phase | 内容 |
|---|---|
| 1（最初のコミット） | herdr クライアント層、① 承認ブローカー |
| 2 | レシピ（layout の保存・復元） |
| 3（次ブランチ） | ③ 分岐 worktree ループ |

## 非目標

- herdr サイドバーの再実装
- agent 状態報告の再発明（herdr 純正 integration が担当済み）
- worktree jump（`@ogulcancelik/pi-herdr-worktree-jump` が担当済み）
- RPC / print モード対応。PTY を持たないので `ctx.mode !== "tui"` では何も登録せず終了する

## 依存

追加なし。`node:net` と `node:fs` のみ。herdr 純正 integration も同じ方針を取っている。

## 1. herdr クライアント層 (`herdr-client.ts`)

transport は `HERDR_SOCKET_PATH` の unix socket（Windows は `\\.\pipe\<path>`）。改行区切り JSON で
`{id, method, params}` を送り、`{id, result}` または `{id, error}` を受け取る。

有効条件は `HERDR_ENV === "1"` かつ `HERDR_SOCKET_PATH` かつ `HERDR_PANE_ID` かつ `ctx.mode === "tui"`。
満たさなければ拡張は何も登録しない。

公開する API は薄いラッパのみ。

- `request(method, params, timeoutMs)` — 単発要求
- `subscribe(types, onEvent)` — `events.subscribe` の常駐接続
- `snapshot()` — `session.snapshot`
- `agentRead(target, source, lines)` / `agentSendKeys(target, keys)` / `agentPrompt(target, text)`
- `selfPaneId()` — `HERDR_PANE_ID`

原則:

- すべての呼び出しにタイムアウトを付ける。失敗は例外にせず縮退し、Pi を壊さない
- サーバ側にメソッドが無い場合（バージョン差）も同じ経路で縮退する
- 購読接続は切れたら指数バックオフで再接続し、復帰時に `snapshot()` で状態を再同期する
- Pi 側に状態を持ち込まない。真実は herdr 側にある

## 2. ① 承認ブローカー (`approvals.ts`)

`pane_agent_status_changed` を購読し、`agent_status === "blocked"` を拾う。

1. blocked になった pane を一覧に追加する（`pane_id` / `workspace_id` / agent 名 / `state_labels`）
2. 質問文を `agent.read`（`source: "detection"`、空なら `"visible"`）で取得して保持する
3. overlay で一覧表示。選択すると本文と回答入力が出る
4. 回答は 2 経路
   - 生キー（`1` / `enter` / `esc` / `up` …）→ `agent.send_keys`
   - テキスト → `agent.prompt`
5. `blocked` 以外に遷移したら一覧から除く
6. 自分自身の pane（`HERDR_PANE_ID`）は除外する

UI:

- `/fleet` で overlay を開く
- `ctrl+shift+a` でも開く（組み込みキーバインドと衝突しないことは確認済み）
- 新規 blocked で通知を出す。設定で切れるようにする

失敗時:

- 送信に失敗したら理由を overlay に出し、一覧からは消さない
- **自動で再送しない。** herdr 側の timeout は「未達」の証明ではない

## 3. レシピ (`recipes.ts`)

`layout.export` は `LayoutNode` の木を返す。`pane` ノードは `cwd` / `env` / `command` / `label` を持つ。
`layout.apply` は `root` にその木を取る。

- 保存先は `<repo>/.pi/herdr-fleet/recipes/<name>.json`
- `/fleet recipe save <name>` / `/fleet recipe apply <name>` / `/fleet recipe ls`
- `pane_id` は保存時に落とす（再利用できない）
- 起動コマンドまで再現するかは `apply --start` で分ける。既定はレイアウトのみ

## 4. ③ のデータモデル（実装は Phase 3）

作業スコープごとに「新しい pane へ渡す文脈の量」を変える。会話全体は渡さない。

```
Scope = {
  id: "implementation" | "review"
  purpose: string
  buildContext(session, task): Message[]
  deliverable: "diff" | "verdict"
}
```

- `implementation` — タスク記述、制約、対象リポジトリの状態。会話の履歴は要らない
- `review` — 差分、意図、受け入れ条件、作者の推論の要約。作者の Pi セッションを
  `agent_session.value` のパスから直接読んで要約を作る。diff だけでは出せない情報
- スコープを増やすときはこの registry に足すだけ

## ファイル構成

```
packages/pi-herdr-fleet/
  index.ts          拡張の入口、コマンドとショートカットの登録
  herdr-client.ts   socket 接続、購読、縮退
  approvals.ts      ①
  recipes.ts        レシピ
  README.md
  README.ja.md
  package.json
```

`.gitignore` は許可制なので `!packages/pi-herdr-fleet/**` を追加する（追加済み）。

## 検証

- `HERDR_ENV` の無い環境で拡張が無害に終了すること
- blocked の検知 → overlay → 回答送信を、テスト用 pane を 1 つ立てて確認する
- socket を切って再接続と再同期が動くこと
- `tsc --noEmit` が通ること
