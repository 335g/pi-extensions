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
| 1 | herdr クライアント層、① 承認ブローカー（main にマージ済み） |
| 2 | レシピ（layout の保存・復元）、worktree と環境の引き継ぎ（main にマージ済み） |
| 3（このブランチ） | 分岐 worktree ループ。3a `fork` / 3b `review` / 3c verdict とマージゲート |

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

## 5. Phase 3 — 分岐 worktree ループ

目的: main セッションから「作業を別の worktree に分岐させ、実装させ、レビューし、マージする」を
Pi のコマンドで回す。分岐するのはリポジトリだけでなく**会話の文脈**で、スコープごとに渡す量を変える。

| 増分 | 内容 |
|---|---|
| 3a | `fork` — worktree 作成 + 準備 + pane/Pi 起動 + 実装スコープの seed |
| 3b | `review` — レビュースコープの文脈パッケージ（差分 + 作者セッション） |
| 3c | verdict のパースとマージゲート |

### 3a: fork — ツール `fleet_fork` とコマンド `/fleet fork`

**主はツール。** ループの主導は agent 側にあり、コマンドだけだと fork のたびに人間が打つことになる。
コマンドは同じ実装を呼ぶ薄いラッパとして残す（人間が直接打ちたいときのため）。

ツール `fleet_fork`:

| 引数 | 型 | 既定 | 内容 |
|---|---|---|---|
| `branch` | string | 必須 | 新しいブランチ名 |
| `task` | string | 必須 | 実装セッションに渡すタスク |
| `base` | string | HEAD | 分岐元 |
| `scope` | enum | `implementation` | スコープ |
| `install` | boolean | true | lockfile があれば install する |
| `start` | boolean | true | pane を作って Pi を起動する |

戻り値は worktree path / branch / pane id / agent 名。env の引き継ぎ結果は警告があるときだけ含める。
ツールの結果は会話の 1 エントリとして残るので、長い出力を並べない。

**install の既定は true。** ツール経路では agent の tool call が install の間ブロックするが、軽い npm
プロジェクトで実測 1〜2 秒なので既定のままでよい。遅いリポジトリ用の逃げ道は `install: false` で、
これはツールの説明に書いて agent が選べるようにする。install には 10 分のタイムアウトを付ける。
第三のモード（先に Pi を起動して seed で install させる）は作らない。

コマンド:

```
/fleet fork <branch> --task "<text>" [--base <ref>] [--scope implementation] [--no-install] [--no-start]
```

手順（ツールとコマンドで共通。`fork.ts` に置く）:

1. `createWorktree`（§4）で worktree と環境を作る
2. **準備** — worktree に lockfile があれば install する
   - lockfile で判定: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb` / `bun.lock` → bun,
     `package-lock.json` → npm
   - 新しい pane の shell で実行し、`pane wait-output` で完了を待つ。main の Pi はブロックしない
   - `--no-install` で飛ばせる。lockfile が無ければ何もしない
3. **pane と Pi** — `pane.split`（`--cwd <worktree>`、`--no-focus`）→ `agent.start`（kind pi）
   - agent 名は branch から作る。`[a-z][a-z0-9_-]{0,31}` に正規化し、32 文字で切る
4. **seed** — スコープの seed を 1 通のプロンプトとして `pane.send_input` で送る
   - `agent.prompt` は使わない。herdr が blocked と報告している pane を拒否するのと同じ層の話で、
     pane 側が正しい（§2 参照）
5. worktree path / branch / pane id / agent 名を返す。worktree ごとの状態一覧は 3c の
   `/fleet status` で作る（3a では一覧を持たない）

### fork を linked worktree からも使えるようにする（緩和策の検討）

現状 `worktree.create` は cwd が linked worktree だと `linked_worktree_source` で拒否する。
fork は main checkout の workspace からしか使えず、fork の入れ子ができない。

候補:

1. **main worktree に解決してから呼ぶ。** `git worktree list --porcelain` の先頭が main worktree。
   cwd が linked worktree なら、main の path を `worktree.create` の `cwd` に渡す
   - `--base` を明示しないと fork 点が main checkout の HEAD に移る。呼び出し元の HEAD を ref として
     渡す必要がある
   - 呼び出し元に未コミットの変更がある場合、それは fork に入らない。警告を出す
2. **拒否したままにする。** main セッションだけが fork する構成では成立している。
   エラーに「main checkout から実行すること」を明記する

1 を試し、素直にいかなければ 2 を受け入れる。

### スコープ registry (`scopes.ts`)

```
Scope = {
  id: string
  purpose: string
  seed(input: ForkInput): string   // 新しいセッションに送る 1 通
  deliverable: string
}
```

`implementation`（3a）:

- タスク本文、worktree の path と branch、制約、完了条件
- **会話履歴は渡さない。** 実装に必要なのはタスクと制約であって、main の議論の経緯ではない
- 完了したらコミットし、報告だけを返すよう指示する

`review`（3b）:

- `git diff <base>...HEAD` を worktree で実行した結果
- 実装セッションに渡したタスク本文
- 実装セッションの最終アシスタントメッセージ（報告）
- **作者の Pi セッション JSONL を `agent_session.value` のパスから読む。** assistant のテキストを抜き、
  上限を付けて渡す。diff だけでは出せない情報
- 出力を verdict 形式に固定する（3c で `fleet_verdict` ツールに差し替える）

**レビューは実装 worktree の中の新しい pane で行う。** 同じ branch を 2 つ目の worktree にチェックアウト
することは git が拒否する（既に他の worktree がチェックアウトしている）。レビュワーには読み取り専用を
指示する。隔離が必要になったら detached な 2 つ目の worktree を検討する。

`/fleet review <branch>` とツール `fleet_review` を出す。fork と同じく**ツールが主、コマンドは薄い
ラッパ**。

スコープを増やすときはこの registry に足すだけ。

### verdict とマージゲート（3c）

**verdict はテキスト規約ではなくツール呼び出しにする。** 3a で fork が第一級のツールになったので、
同じ仕組みを使う方が決定性が高く、JSONL から `VERDICT:` 行を探すパースも要らない。

レビュワーに `fleet_verdict` ツールを渡す:

| 引数 | 型 | 内容 |
|---|---|---|
| `verdict` | enum | `approve` / `request-changes` |
| `findings` | array | `{ path, line?, note }` の配列 |

- ツール呼び出しはレビュワーのセッション JSONL に残るので、main はそこから読む
- `/fleet status` が worktree ごとに 未レビュー / approve / request-changes を出す
- `/fleet merge <branch>` は approve が無ければ拒否する。`--force` で上書きできる
- verdict は Pi の custom entry としても記録し、main の会話ツリーに残す
- `request-changes` の findings をそのまま実装セッションに送り返せるようにする（差し戻しの経路）

### 決めきれていない点（実装前に確認したい）

1. `npm install` を fork がやるか、seed の指示に含めるか。上は「fork がやる」で書いたが、install が
   遅いリポジトリでは待たされる
2. 実装スコープに会話履歴を一切渡さない方針でよいか。main で決めた設計判断はタスク本文に書き写す
   必要がある
3. verdict の形式を固定してよいか。自由記述を拡張が LLM で要約する案もあるが、決定性を優先した

## テストの方針

**Phase 3 をマージする前に整理する。** 現状:

| ファイル | 行数 | 役割 |
|---|---|---|
| `selfcheck.ts` | 711 | fake herdr サーバに対するロジック検証 |
| `acceptance.sh` | 194 | Phase 1/2 の実 pane 受入試験 |
| `acceptance-fork.sh` | 467 | Phase 3a の実 pane 受入試験 |

実装（`fork.ts` 175 行）より試験が大きい。リポジトリの慣例（`pi-byetheway/selfcheck.ts` 74 行）
からは大きく外れている。穴を見つけているので無駄ではないが、増分ごとに selfcheck +150 行 /
acceptance +200 行が積み上がるペースは持続しない。

整理の方向:

- 2 つの acceptance スクリプトを 1 つにし、共通の harness（pane 作成、observer 起動、検査、後始末）を
  共有する。同じ処理が両方に重複している
- selfcheck は「fake サーバでしか検証できないもの」に絞る。実 pane で検証済みの経路を fake でも
  重ねて検証していないか見る
- 目標は行数ではなく**重複の除去**。数を減らすために被覆を落とさない

## ファイル構成

```
packages/pi-herdr-fleet/
  index.ts          拡張の入口、コマンドとショートカットの登録
  herdr-client.ts   socket 接続、購読、縮退
  approvals.ts      ①
  recipes.ts        レシピ
  worktree.ts       worktree 作成と環境の引き継ぎ
  scopes.ts         Phase 3 のスコープ registry（seed の組み立て）
  fork.ts           ツール `fleet_fork` とコマンド `/fleet fork` の共通実装
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
- `worktree.create` は cwd が linked worktree だと `linked_worktree_source` で拒否する。`/fleet fork` は
  main checkout の workspace から使う必要がある。fork の入れ子はできない
- `pane.split` は対象 pane を明示しないと**フォーカス中の pane** を分割する。別 workspace に pane が
  生えるので、fork は worktree workspace の root pane を明示する
- install 直後の `agent.start` は `agent_pane_busy` になる（実測 3/3）。リトライと settled 待ちが必要。
  herdr のエラー本文に code が含まれないため、`Outcome` に code を持たせないとリトライ判定ができない

Phase 3 の検証（増分ごとに追記する）:

- `fork` が worktree・環境・pane・Pi を作り、seed が届いて実装セッションが作業を始めること
  → `acceptance-fork.sh`（30 passed / 0 failed、3a 完了時）
- `--no-install` と lockfile 無しのときに install を飛ばすこと → `acceptance-fork.sh`
- `--no-start` で pane を作らず worktree だけ作ること → `acceptance-fork.sh`
- `fleet_fork` をツールとして agent が呼べること、引数不足が拒否されること
  → `acceptance-fork.sh` 7〜8 節（実 pane の observer に呼ばせて確認）
