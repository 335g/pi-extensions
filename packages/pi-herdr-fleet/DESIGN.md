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
| 2 | レシピ（layout の保存・復元）、worktree と環境の引き継ぎ |
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
- `agentRead(target, source, lines)` / `paneSendInput(paneId, text, keys)` / `paneSendKeys(paneId, keys)`
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
4. 回答は 2 経路。どちらも **pane API** を使う（理由は下）
   - 生キー（`1` / `enter` / `esc` / `up` …）→ `pane.send_keys`
   - テキスト → `pane.send_input`（テキスト + Enter を 1 回の順序ある送信として）
5. `blocked` 以外に遷移したら一覧から除く
6. 自分自身の pane（`HERDR_PANE_ID`）は除外する

### なぜ agent API ではなく pane API か

実 pane の受入試験（`acceptance.sh`）で判明した。当初の設計は `agent.send_keys` と
`agent.prompt` を使うとしていたが、**どちらもこの用途では herdr に拒否される**。

- `agent.prompt` は herdr が blocked と報告している pane を `agent_blocked` で拒否する。
  これはこの overlay が答えられる pane の**すべて**にあたるので、原理的に使えない
- `agent.send_keys` は `pane.report_agent` で報告された agent を `agent_not_ready` で拒否する。
  hook や plugin はその経路で状態を報告するので、一覧に載る pane はまさにこれにあたる
- `pane.send_input` / `pane.send_keys` にはどちらの検査も無く、空白も保って順序どおり届く

承認ダイアログに答えるのは「その pane への意図的な生入力」なので pane 側が正しい層。
`agent.read` は報告された pane でも通るので agent 側のままにしている。

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

## 4. worktree と環境の引き継ぎ (`worktree.ts`)

worktree には git 管理外の開発環境が来ない。`.env` も `.envrc` も gitignore されているので、
新しく切った worktree で Pi を起動すると `No API key found` で即死する（実際に踏んだ）。

`createWorktree({ cwd, branch, label, base })`:

1. `herdr worktree create` を呼び、返ってきた `checkout_path` と `workspace_id` を返す
2. `propagateEnv(checkoutPath, cwd)` を実行する
3. 結果（コピーしたファイル、direnv の状態）を返す

`propagateEnv(worktreePath, sourceRoot)`:

- `sourceRoot` から `.env*` と `.envrc` をコピーする。既に存在するファイルは上書きしない
- `.envrc` をコピーした場合のみ `direnv allow <worktreePath>` を実行する
- **元の `.envrc` が既に allow されている場合に限る。** `direnv status --json` の
  `state.foundRC.allowed` が `0`（allow 済み）のときだけ実行する。`1` は未許可、`2` は `direnv deny`
  による明示的な拒否（実測で確認済み）。0 以外は allow しない。
  allow されていない `.envrc` を新しい場所で allow することは信頼の付与であり、
  拡張が勝手にやってはいけない
- direnv が無い、または `.envrc` が無い場合はコピーだけして警告を返す
- 失敗しても worktree の作成自体は成功として扱い、警告として報告する

公開は `/fleet worktree create <branch>` から。③ の fork も同じ関数を使う。

`.env` の次に来る同じ問題: 新しい worktree には `node_modules` が無い。`npm install` を fork が
面倒を見るか、seed の指示に含めるかは Phase 3 で決める。

## 5. ③ のデータモデル（実装は Phase 3）

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
  worktree.ts       worktree 作成と環境の引き継ぎ
  selfcheck.ts      fake herdr サーバに対するロジックの検証
  acceptance.sh     実 pane の受入試験
  README.md
  README.ja.md
  package.json
```

`.gitignore` は許可制なので `!packages/pi-herdr-fleet/**` を追加する（追加済み）。

## 検証

- `HERDR_ENV` の無い環境で拡張が無害に終了すること
- blocked の検知 → overlay → 回答送信の実 pane での通し確認 → `acceptance.sh`（実施済み）
- socket を切って再接続と再同期が動くこと
- `.env` と `.envrc` を持つリポジトリで worktree を切り、環境変数が引き継がれること
- 元の `.envrc` が allow されていない場合、新しい worktree で allow しないこと
- `tsc --noEmit` が通ること

実 pane の受入試験は `packages/pi-herdr-fleet/acceptance.sh`。subject（`report-agent` で
blocked にした shell）・observer（この拡張を読み込んだ Pi）・呼び出し元の 3 pane を作り、
通知、overlay の一覧、質問文、回答の 2 経路を通す。自分が作った pane だけ閉じる。

## 既知の制約と開発時の注意

- `/reload` で拡張の新しいコードが反映されない（jiti のモジュールキャッシュと思われる）。
  実装を直したら observer の pane を立て直して確認する
- observer は `-ne` で隔離する。他の拡張が `ctrl+shift+a` を取ると試験が壊れる
- `report-agent` で合成した subject では、`agent.read --source detection` は承認 UI の本文ではなく
  直近のスクロールバック全体を返す。実エージェントなら herdr の detection がダイアログ本文を返す。
  合成 subject の性質なのでコードは合わせていない。詳細画面が冗長に感じたら末尾 N 行に切る改善がある
- 通知の確認は Pi のトーストが `recent-unwrapped` に残ることに依存している。試験の中で唯一
  タイミングに依存する検査。失敗したら `herdr pane wait-output` に切り替える
- 実エージェントの承認 UI に対する `pane.send_input` は未検証（subject は合成した blocked）
