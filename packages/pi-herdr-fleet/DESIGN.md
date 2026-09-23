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
| 3b | `review` — レビュースコープの文脈パッケージ（差分 + 作者セッション）（実装済み） |
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
   - **Enter は再送する。** 本文を送ったあとの Enter は、長い paste を取り込んでいる最中だと落ちて seed が
     editor に残る。agent が working / blocked / done になるまで Enter を送り直す（最大 5 回）
5. worktree path / branch / pane id / agent 名を返す。worktree ごとの状態一覧は 3c の
   `/fleet status` で作る（3a では一覧を持たない）

### fork を linked worktree からも使えるようにする（実装済み）

現状 `worktree.create` は cwd が linked worktree だと `linked_worktree_source` で拒否する。
fork は main checkout の workspace からしか使えず、fork の入れ子ができない。

候補:

1. **main worktree に解決してから呼ぶ。（採用）** `git worktree list --porcelain` の先頭が main worktree。
   cwd が linked worktree のときだけ `worktree.create` の cwd をそこに差し替える
   - `base` は呼び出し元の checkout で `git rev-parse` して sha に固定する。固定しないと fork 点が
     main checkout の HEAD に移る
   - 呼び出し元に未コミットの変更がある場合、それは fork に入らない。警告を出す
   - 環境のコピー元は呼び出し元の checkout のまま。fork が引き継ぐのは自分が動いている環境であって、
     main checkout の環境ではない
2. 拒否したままにする。（不要になった）

### スコープ registry (`scopes.ts`)

```
Scope = {
  id: string
  purpose: string
  forkable: boolean               // fleet_fork の scope 引数に載るか
  seed(input: ForkInput): string   // 新しいセッションに送る 1 通
  deliverable: string
}
```

registry は「文脈パッケージの registry」。各エントリは対応する入口（`fleet_fork` / `fleet_review`）を
`forkable` で宣言する。`review` は差分を必要とするので fork からは組み立てられず、`fleet_review` から
だけ使える。

`implementation`（3a）:

- タスク本文、worktree の path と branch、制約、完了条件
- **会話履歴は渡さない。** 実装に必要なのはタスクと制約であって、main の議論の経緯ではない
- 完了したらコミットし、報告だけを返すよう指示する

`review`（3b）:

- `git diff <base>...HEAD` を worktree で実行した結果
- 実装セッションに渡したタスク本文
- 実装セッションの最終アシスタントメッセージ（報告）
- **作者の Pi セッション JSONL を `agent_session.value` のパスから読む。** assistant の **text パートだけ**を
  抜き、上限を付けて渡す。diff だけでは出せない情報
  - thinking は入れない。token 量を支配する上に、探索して捨てた筋であって作者が立った結論ではない。
    作者が説明として書いた text を読む
  - 上限は **300 行かつ 20000 文字**（両方、末尾から適用）。one-line のツール結果が多いセッションと長文の
    セッションで当たる天井が違うため両方要る。20000 文字 ≒ 5k tokens で diff の隣に置ける大きさ
  - 読むのはファイルの末尾 **4MB** だけ（全体をメモリに載せない。先頭の切れた行は捨てる）
  - diff は **60000 文字**で切り、切ったことを seed に明記する（レビュワーは自分で `git diff` を打てる）
- 出力を verdict 形式に固定する（3c で `fleet_verdict` ツールに差し替える）

**レビューは実装 worktree の中の新しい pane で行う。** 同じ branch を 2 つ目の worktree にチェックアウト
することは git が拒否する（既に他の worktree がチェックアウトしている）。レビュワーには読み取り専用を
指示する。隔離が必要になったら detached な 2 つ目の worktree を検討する。

`/fleet review <branch>` とツール `fleet_review` を出す。fork と同じく**ツールが主、コマンドは薄い
ラッパ**。`branch` と `task` は必須。

`base` の既定は main checkout の HEAD。`git diff <base>...HEAD` は merge-base からの差分なので、
fork 後に main が進んでも fork 点のままになる。ただし**入れ子 fork では明示が必要**（共通祖先が親
ブランチの分岐点まで戻るため、親ブランチの変更まで混ざる）。fork が使った base を記録するのは 3c で
worktree ごとの状態を持つときに行う。

スコープを増やすときはこの registry に足すだけ。

### verdict とマージゲート（3c）

**verdict はテキスト規約ではなくツール呼び出しにする。** 3a で fork が第一級のツールになったので、
同じ仕組みを使う方が決定性が高く、JSONL から `VERDICT:` 行を探すパースも要らない。

#### 実行記録（3c で初めて永続する状態を持つ）

`<main checkout>/.pi/herdr-fleet/runs/<branch>.json`（branch の `/` は `-` に置換）。fork / review が
書き、`fleet_verdict` が更新する。

```
{
  branch, base, path, workspaceId, paneId, agentName, scope, task, createdAt, mergedAt?,
  reviewer?: { paneId, agentName, sessionPath },
  verdict?: { verdict, findings, at }
}
```

**なぜセッション JSONL の読み直しで済ませないか。** verdict を生きたレビュワーのセッションにしか
置かないと、**pane を閉じるだけでゲートが黙って外れる**。ゲートの完全性はファイルに置く。
`base` もここに記録する（fork が使った base を review が既定に使えるようになるため。入れ子 fork で
必要になる）。

#### `fleet_verdict` ツール

| 引数 | 型 | 内容 |
|---|---|---|
| `verdict` | enum | `approve` / `request-changes` |
| `findings` | array | `{ path, line?, note }` の配列 |

- **呼び出し元の pane がその run の記録した reviewer pane でなければ拒否する。** 拡張は全セッションに
  入っているので、この検査が無いとどのセッションからでも verdict を書ける
- 書き込むと同時に Pi の custom entry としても記録する。**entry はレビュワー自身のセッション木に入る。**
  拡張から別のセッションへ entry を書く手段が無いため。main が読むのは実行記録のファイルであって
  entry ではない（entry はレビュワー側の記録として残す）
- レビュワーが verdict を返さずに終わった場合、run は「未レビュー」のまま

#### レビュワーの起動

`fleet_review` はレビュワーを `agent.start ... -- -e <この拡張の入口>` で起動する。

- `-e` で自分の入口を明示する理由は 2 つ。インストールされていなくても `fleet_verdict` が渡ること、
  そして**開発中はインストール済みのパスが main checkout の古いコードを指す**ため（worktree のコードを
  レビュワーに使わせたい）
- 入口のパスは `import.meta.url` から取る
- `-ne` は付けない。レビュワーにも普段の拡張を効かせる

#### `fleet_status` ツールと `/fleet status`

run ごとに branch / scope / 状態 / verdict を出す。状態は 作業中 / 未レビュー / approve /
request-changes / マージ済み。**ツールが主、コマンドは薄いラッパ**で、どちらも `statusRuns(run, main)`
が返す同じ行を読む。違うのは言葉だけで、コマンドは `strings()` で日本語にする。引数は無い。

マージ済みかどうかは記録のフィールドではなく main checkout の履歴に聞く（`git merge-base
--is-ancestor`）。手で merge された branch も「マージ済み」と出る。

#### `fleet_merge` ツールと `/fleet merge <branch> [--force]`

**ツールが主、コマンドは薄いラッパ**で、どちらも `mergeRun(run, request)` を呼ぶ。引数は `branch`
（必須）と `force`（任意、既定 false）。

- `verdict.verdict === "approve"` でなければ拒否する。`force: true` / `--force` で上書きできる。
  `force` が上書きするのは approve の欠如だけで、下の汚れは上書きしない
- main checkout の**追跡**ファイルが汚れていれば拒否する（`git status --porcelain --untracked-files=no`）。
  実行記録自体が main checkout の `.pi/` の下にあるので、未追跡を汚れとして扱うとゲートが自分の状態で
  永久に閉じる。未追跡ファイルとの衝突は `git merge` 自身が拒否する
- `git merge <branch>` を main checkout で実行する。`--ff-only` は使わない（必要なら merge commit を
  作る。`--no-edit`）
- マージ後も run の記録は残し、worktree は消さない。後始末は別の操作にする

ツールの説明には、マージが approve を前提とすること、`force` の意味、worktree が残ることを書く。

#### `fleet_clean` ツールと `/fleet clean <branch> [--force]`

マージは worktree を残すので、その後始末が要る。**ツールが主、コマンドは薄いラッパ**で、どちらも
`cleanRun(client, run, request)` を呼ぶ。引数は `branch`（必須）と `force`（任意、既定 false）。

対象は run 記録にあるものだけ。記録が無ければ何も消さず拒否する（worktree と pane を引く手が
記録しか無く、branch だけ消すと worktree が宙に浮く）。

1. **pane** — `paneId` と `reviewer.paneId` を `pane.close` で閉じる。**自分自身の pane は閉じない**
   （閉じる側のセッションそのもの）。
2. **worktree** — `worktree.remove` に記録の `workspaceId` を渡す。`force: true` は herdr のもので、
   ゲートの `force` とは別。マージ済みの worktree にも `node_modules` と `.env` が残っているため。
3. **branch** — main checkout で `git branch -d`（`force` なら `-D`）。
4. 記録に `cleanedAt` を書く。

pane を先に閉じるのは順序の都合: `worktree.remove` は workspace ごと閉じるので、後から pane を閉じると
必ず「無かった」ように見え、正常な後始末が警告だらけになる。

- **マージ済みのときだけ実行する。** 判定は記録の `mergedAt`、または
  `git merge-base --is-ancestor <branch> HEAD`。`force: true` / `--force` で上書きできる
- **run 記録もセッション JSONL も消さない。** 記録は「あの worktree はなぜ捨てたのか」を後から引く
  ための資産で、セッションは `session_search` が索引する。消すと監査ログ（§6）が書きっぱなしになる。
  記録には `cleanedAt` を足すだけにする
- 既に消えている worktree / branch / pane はエラーにしない。冪等にしたいので、`cleanedAt` が付いた
  記録はマージ判定をやり直さない（2 回目の clean が 1 回目が作った状態で失敗しないように）
- 既に消えているものは警告として返す（エラーではない）。正常な 1 回目の後始末は警告を出さない

ツールの説明には、マージ済みが前提であること、`force` の意味、記録を消さないことを書く。

#### レビュワー名の一意化と、起動失敗時の pane の後始末

同じ branch を 2 回レビューする経路（差し戻し→再レビュー）で実際に踏んだ穴。

- レビュワーの agent 名は `<branch>-review` で固定だった。herdr の agent 名は一度きりなので、
  2 回目の `agent.start` が `agent name ... is already used` で失敗する。**レビューのたびに一意な名前に
  する**: `session.snapshot` が返す生きた agent 名を見て、`-review`、`-review-2`、`-review-3` … と採番する。
  名前は herdr の `[a-z][a-z0-9_-]{0,31}` に収める（`agentName` の切り詰めに任せる）。記録の
  `reviewer.agentName` は最新のレビュワーを指すよう上書きする
- その失敗のとき、`fleet_review` は自分が作った pane を 1 枚残していた。**`agent.start` が失敗したら、
  自分が作った pane を `pane.close` で閉じてからエラーを返す。** 残しても誰も使わないし、閉じる責任は
  作った側にしか無い

採番は snapshot を読むだけなのでロックではない。同時に 2 つのレビューが同じ名前を選べば、負けた側が
`agent_name_taken` で失敗し、自分の pane を閉じる。

#### 差し戻し

`request-changes` の findings を実装セッションに送り返す経路を作る。実装セッションが生きていれば
`pane.send_input` で送る。死んでいれば `/fleet fork` で新しいセッションを立てる。3c では前者だけ。

### 決めきれていない点

1. `npm install` を fork がやるか、seed の指示に含めるか → **決着: fork がやる。** 逃げ道は
   `install: false`
2. 実装スコープに会話履歴を一切渡さない方針でよいか → **決着: 渡さない。** brief は完全に書く
3. verdict の形式を固定してよいか → **決着: テキスト規約をやめ、`fleet_verdict` ツールにする**

## 6. 監査ログ (`audit.ts`)

herdr は履歴を持たない。pane が blocked になった、worktree が作られ、そして後で捨てられた — そういう
出来事は次のものが来た瞬間に消える。「あの worktree はなぜ捨てたのか」を半年後に引く材料が残らない。

Pi のセッションには JSONL が残り、`session_search` がそれを索引する。herdr のイベントを起きた瞬間に
entry として書いておけば、fleet の過去が後から検索できる。

- 購読は**既存のブローカーの 1 本**に相乗りする。pane 単位の状態イベントは pane 一覧を持っている
  接続でしか届かず、その一覧を持っているのはブローカーだから。ブローカーは受けたイベントをそのまま
  監査ログに渡し、書くかどうかを決めるのは監査ログ
- 購読型は herdr の schema の名前に合わせて `worktree.created` / `worktree.removed` /
  `workspace.created` / `workspace.closed` を足す。`pane.agent_status_changed` と
  `pane.created` / `pane.closed` は既存のまま
- entry の `customType` は `herdr-event`。LLM の文脈には入らない。`pi.registerEntryRenderer` が
  1 行に畳む（`worktree created feat/x`、`w6:p1 blocked (claude)`）。展開すると JSON が出る
- 記録は拡張が有効なときだけ（§1 の有効条件のガードのまま）
- 購読型を増やしたぶん、その型を知らない古い herdr では集合が丸ごと拒否されうる。ブローカーは拒否
  されたら snapshot から集合を組み直して一度だけ再試行し、同じ集合が再び拒否されたら止める（無限に
  再試行しない）。herdr 0.9.0 は 4 つとも知っているので、この経路は実測していない

### ノイズの抑制

- 高頻度イベントは購読しない。`pane.output_changed` には購読型が無く、`pane.scroll_changed` /
  `layout.updated` は購読しても entry にしない（`pane.output_matched` は一致したときだけ発火する
  別物）。`describe()` は届いても entry にしない
- 同じ pane の同じ状態が連続したら書かない。herdr は再接続後に状態を再通知する。ログは遷移の列で
  あって、読み直しの列ではない
- 拡張自身の pane は書かない。そのセッションのターンは会話にすでに残っている
- `pane.created` / `pane.closed` / `tab.*` は購読しても entry にしない。pane の出入りは頻度が高く、
  herdr 側の一覧を見れば足りる

### 記録する出来事

| イベント | entry の `summary` |
|---|---|
| `worktree.created` | `worktree created <branch>` |
| `worktree.removed` | `worktree removed <branch>`（`forced` なら ` (forced)` が付く） |
| `workspace.created` | `workspace created <label> (<workspace_id>)` |
| `workspace.closed` | `workspace closed <workspace_id>` |
| `pane.agent_status_changed` | `<pane_id> <status> (<agent>)` |

entry は `summary` のほかに `event` / `at` / `pane_id` / `workspace_id` / `branch` / `path` /
`agent` / `agent_status` / `forced` を持つ。`summary` は人が読む 1 行であると同時に、JSONL を素の
テキストで検索したときに引っかかる文字列でもある。

### 検証

- `describe()` が schema の両方の綴り（pane 単位は点付き、ライフサイクルはアンダースコア）を同じ
  種類に正規化し、高頻度イベントを entry にしないこと → `selfcheck.ts`
- 購読型に高頻度のものが入らず、schema の名前だけが入ること → `selfcheck.ts`（型の一覧を検査）と両方
  の acceptance（herdr は知らない型を含む集合を丸ごと拒否するので、イベントが届くこと自体が集合が
  通ったことの証拠になる）
- 同じ pane の同じ状態が 1 つの entry になり、状態を離れて戻ったら 2 つになること → `selfcheck.ts` と
  `acceptance.sh`（実 pane で `pane.report_agent` を打ち直す）
- worktree の作成と削除が実 pane で entry になること → `acceptance-fork.sh`

## テストの方針

3 層に分ける。**実 pane で確かめられることは acceptance に置き、fake は fake でしか作れないものに限る。**

| ファイル | 行数 | 役割 |
|---|---|---|
| `selfcheck.ts` | 1223 | fake herdr サーバに対する、fake でしか作れない検査 |
| `acceptance-lib.sh` | 199 | 2 つの acceptance が共有する harness |
| `acceptance.sh` | 210 | Phase 1/2 の実 pane 受入試験（約 30 秒） |
| `acceptance-fork.sh` | 1027 | Phase 3a/3b/3c の実 pane 受入試験（数分） |

実装（`fork.ts` 216 行 + `review.ts` 471 行 + `runs.ts` 414 行）に対して試験は大きい。リポジトリの慣例
（`pi-byetheway/selfcheck.ts` 74 行）からは外れている。穴を見つけているので無駄ではないが、
増分ごとに selfcheck +150 行 / acceptance +250 行が積み上がるペースは持続しない。増分を足すときの
判断は 3 つ。

**置き場所。** 実 pane で確かめられることは acceptance に置く。fake に残すのは fake でしか作れない
ものだけ。

- transport の異常系（malformed / timeout / 接続断 / error 応答）
- 購読の再接続と resync、refused
- herdr が無い・古いときの縮退
- herdr に届く前の拒否（schema、引数検証）
- 純粋なロジック（seed の組み立て、抜粋の予算、レシピの木、lockfile→installer、branch→agent 名、
  実行記録の読み書き、verdict の検証）

実 pane の試験が既に覆っている経路を fake で重ねて検証しない。検査を落とすときは、どの実 pane の
検査がその挙動を覆うのかを確かめてから落とす。行数は目標ではない。数を減らすために被覆を落とさない。

**fake を実挙動より親切にしない。** fake は実 herdr のソケットに当てて測った挙動に合わせる。fake が
herdr より多くを返すと偽の正しさが生まれ、fake だけが通って実 pane で壊れる。2 度起きた。

- `Outcome.code` を足す前、`agent.start` のリトライ判定は「エラーメッセージに `agent_pane_busy` が
  含まれるか」だった。fake は code を返すのに herdr のエラー本文に code は含まれず、実 pane では
  リトライが一度も発火しなかった
- fake の `agent.wait` は実在しない `agent_settled` を返していた。呼び出し側がその型で分岐すれば
  fake だけが通る

**共有。** 両方の acceptance が使うものは `acceptance-lib.sh` に置く。カウンタと検査、pane ヘルパ、
observer Pi の起動、作った pane / workspace / worktree を記録して trap で消す後始末、失敗時に観測した
画面の出力。**入口は 2 つのまま。** Phase 1/2 だけを 30 秒で回せる速さを残す。

## ファイル構成

```
packages/pi-herdr-fleet/
  index.ts             拡張の入口、コマンドとショートカットの登録
  herdr-client.ts      socket 接続、購読、縮退
  approvals.ts         ①
  recipes.ts           レシピ
  worktree.ts          worktree 作成と環境の引き継ぎ
  scopes.ts            Phase 3 のスコープ registry（seed の組み立て）
  runs.ts              実行記録、status / merge の実装とツール、マージゲート
  fork.ts              ツール `fleet_fork` とコマンド `/fleet fork` の共通実装
  review.ts            ツール `fleet_review` とコマンド `/fleet review` の共通実装
  clean.ts             ツール `fleet_clean` とコマンド `/fleet clean` の共通実装
  selfcheck.ts         fake herdr サーバに対する、fake でしか作れない検査
  acceptance-lib.sh    2 つの acceptance が共有する harness
  acceptance.sh        Phase 1/2 の実 pane 受入試験
  acceptance-fork.sh   Phase 3a/3b/3c の実 pane 受入試験
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
- `fleet_merge` も `/fleet merge` も `pi.exec` で `git merge` を実行する。`pi-autocommit` のガードは
  agent の **bash ツール呼び出し**を覗いているので、この経路は素通りする。人間が打ったコマンドとしては
  通ってよいとも言えるが、いまはツールから agent も同じ経路を打てるので、**止める場所はゲート（approve
  と clean な main checkout）だけ**になる。暗黙の依存なのでここに書き残す

Phase 3 の検証（増分ごとに追記する）:

- `fork` が worktree・環境・pane・Pi を作り、seed が届いて実装セッションが作業を始めること
  → `acceptance-fork.sh`（30 passed / 0 failed、3a 完了時）
- `--no-install` と lockfile 無しのときに install を飛ばすこと → `acceptance-fork.sh`
- `--no-start` で pane を作らず worktree だけ作ること → `acceptance-fork.sh`
- `fleet_fork` をツールとして agent が呼べること、引数不足が拒否されること
  → `acceptance-fork.sh` 7〜8 節（実 pane の observer に呼ばせて確認）
- `review` の seed に diff・タスク本文・作者セッションから抜いた推論が入ること、上限が効くこと
  → `acceptance-fork.sh` 9 節と、実セッション 2.1MB を `readAuthorSession` に通した確認
- linked worktree からの fork が、fork 点を呼び出し元の HEAD に固定して未コミット変更を警告すること
  → `acceptance-fork.sh` 10 節
- `fleet_status` が実 pane の agent から呼べて run の一覧を返し、`fleet_merge` が approve なしで拒否
  され、approve 後に通ってスクラッチの main checkout に本当にマージすること
  → `acceptance-fork.sh` 16 節（ツール経路。コマンド経路は 11〜13 節）
- `fleet_clean` が未マージの run を拒否し、`force` で通り、worktree・branch・pane が消えて run 記録と
  セッション JSONL が残ること、2 回目もエラーにならないこと
  → `acceptance-fork.sh` 17 節（コマンド経路）と 18 節（ツール経路、`is-ancestor` のフォールバック）。
  fake 側の分岐は `selfcheck.ts`
- 同じ branch に `fleet_review` を 2 回呼んで通ること、名前が `-review-2` に進むこと
  → `acceptance-fork.sh` 19 節。`agent.start` 失敗時に pane を閉じることは `selfcheck.ts`
- **未検証**: 60000 文字を超える実 diff の切り詰め。4MB を超える実セッション。実 pane での
  `agent.start` 失敗（名前衝突は snapshot を見て避けるので、`selfcheck.ts` の fake でしか踏んでいない）
