# pi-herdr-fleet

[English](./README.md)

[herdr](https://herdr.dev) の pane と Pi の間の承認ブローカー。herdr はどの pane が人間の返答を
待っているかを知っている。`/fleet` はその一覧を、いま見ている pane の上に overlay で出し、pane を
切り替えずに blocked のエージェントへ答える。同じコマンドで tab のレイアウトを保存・復元し、
git 管理外の開発環境を引き継いだ worktree も作れる。さらにその worktree を fork できる。worktree を
切り、その中で Pi セッションを起動し、タスクを 1 通で渡す。fork はツール `fleet_fork` として登録される
ので、agent が自分のループから呼べる。

Phase 3a は `/fleet fork` まで。レビュー（3b）とマージゲート（3c）はこれから。

## 動作条件

herdr が管理する pane の中で、対話モードで動いているときだけ有効になる。`HERDR_ENV=1` /
`HERDR_SOCKET_PATH` / `HERDR_PANE_ID` が揃っていなければ何も登録しない。pi が TUI モードでなければ
何も起動しない。RPC や print モードには herdr が表示できる pane も、overlay を描く端末も無いため。

## インストール

```sh
pi install npm:@335g/pi-herdr-fleet
```

`pi install` はユーザ設定（`~/.pi/agent/settings.json`）に書き込む。`-l` を付けるとプロジェクト設定
（`.pi/settings.json`）に書き込む。

## 使い方

- `/fleet` — 承認待ちの pane の一覧を開く
- `ctrl+shift+a` — コマンドを打たずに同じ一覧を開く
- `/fleet view` — 全 pane のモデル・文脈・コスト・最後のユーザー発話を 1 画面に出す（`r` で再取得）
- `/fleet recipe save <name>` — 現在の tab のレイアウトを保存する
- `/fleet recipe apply <name> [--start]` — 新しい tab として復元する
- `/fleet recipe ls` — 保存済みのレシピを一覧する
- `/fleet worktree create <branch> [--base <ref>] [--label <text>]` — worktree を作り、開発環境を
  引き継ぐ
- `/fleet fork <branch> --task "<text>" [--base <ref>] [--scope implementation] [--no-install]
  [--no-start]` — worktree を fork し、その中で Pi セッションを起動し、タスクを渡す
- `/fleet review <branch> --task "<text>" [--base <ref>]` — その worktree の中で読み取り専用の
  レビュワーを起動し、diff と作者のセッションを渡す
- `/fleet status` — 記録済みの run ごとに branch / scope / 状態 / verdict を出す
- `/fleet merge <branch> [--force]` — approve 済みのブランチを main checkout にマージする
- `/fleet clean <branch> [--force]` — マージ済み run の worktree / branch / pane を消す
- `fleet_fork` ツール — 同じことを agent から呼ぶ。引数は `branch` / `task` / `base` / `scope` /
  `install` / `start`
- `fleet_review` ツール — 同じことを agent から呼ぶ。引数は `branch` / `task` / `base`
- `fleet_verdict` ツール — レビュワーが verdict を記録する。引数は `verdict` / `findings`
- `fleet_status` ツール — 同じ一覧を agent から呼ぶ。引数なし
- `fleet_merge` ツール — 同じマージを agent から呼ぶ。引数は `branch` / `force`
- `fleet_clean` ツール — 同じ後始末を agent から呼ぶ。引数は `branch` / `force`

| キー | 動作 |
|------|------|
| `↑` `↓` | 選択を動かす |
| `1`〜`9` | その行を開く |
| `Enter` | 選択中の行を開く |
| `Esc` | overlay を閉じる |

詳細画面では:

| キー | 動作 |
|------|------|
| `Enter` | 入力したテキストを送ってから Enter（`pane.send_input`） |
| `ctrl+k` | 入力した内容を生キーとして送る（`pane.send_keys`） |
| `PageUp` `PageDown` | 質問文をスクロール |
| `Esc` | 一覧へ戻る |

## 承認待ちへの答え方

承認ダイアログは文章で答えられる形とは限らない。番号付きの選択肢かもしれないし、yes/no かもしれないし、
全画面のピッカーかもしれない。そこで詳細画面からは 2 経路を用意し、どちらを使うかは入力から推測せず
こちらで選ぶ。

- **テキスト**（`Enter`）— 入力した内容を、その pane の入力欄に打ったのと同じように送る。
- **生キー**（`ctrl+k`）— 代わりにキーストロークを送る。入力は空白で区切るので、`esc 1` は `esc` の次に
  `1`、`up up enter` はメニューを辿る。入力が空なら素の `Enter` になる。確認ダイアログではこれが普通。

どちらの経路も pane 側の API（`pane.send_input` / `pane.send_keys`）を使う。agent 側は使えない。
`agent.prompt` は **herdr が blocked と報告している pane を拒否し**（`agent_blocked`）、それはこの
overlay が答えられる pane のすべてにあたる。`agent.send_keys` も `pane.report_agent` で報告された
agent を拒否する（`agent_not_ready`）。hook や plugin はその経路で状態を報告する。承認ダイアログに
答えるのは、その pane への意図的な生入力なので pane 側を使う。

次の 2 つは起きない。

- **失敗を自動で再送しない。** herdr の timeout は「入力がエージェントに届かなかった」証明ではない。
  送信に失敗したら理由を overlay に出し、その行は一覧に残す。再送するかどうかは本人が決める。
- **送信が成功しても行を消さない。** 書き込みが成功したことは、エージェントが次に進んだ証明ではない。
  行が消えるのは、herdr がその pane はもう blocked ではないと報告したときだけ。

自分自身の pane は一覧に出ない。自分に答えることはデッドロックになるため。

## レシピ

レシピは herdr の tab レイアウトそのもの。`/fleet recipe save dev` が現在の tab を export し、
`LayoutNode` の木を `.pi/herdr-fleet/recipes/dev.json` に書く（pi を起動したディレクトリ基準）。
`pane_id` だけは落とす。閉じた pane の id は再利用できないため。それ以外はそのまま保存する。

`/fleet recipe apply dev` はその木を、現在の workspace に**新しい tab** として作る。tab 名は
レシピ名。いまいる tab を置き換えることはしない。保存した木は元の tab id を持たないし、現在の tab を
置き換えるとコマンドを実行したセッション自身が死ぬ。既定ではレイアウトのみで、pane は保存された
`cwd` の素の shell として戻る。`--start` を付けると保存された起動コマンドも再現する。

レシピ名はファイル名の1セグメントに制限する（`[A-Za-z0-9][A-Za-z0-9._-]*`）。名前はパスなので、
`../` が通るとプロジェクトの外に書けてしまう。

## worktree と環境の引き継ぎ

`/fleet worktree create <branch>` は `herdr worktree create` を呼び、そのあと git 管理外の開発環境を
新しい checkout にコピーする。

- 元のルートにある `.env*`（`.env` / `.env.local` / `.env.example` / `.envrc` …）をコピーする。
  **上書きはしない。** git が既に置いた `.env.example` はそのまま残す。
- `direnv allow` は、**元の `.envrc` が既に allow されている場合のみ**新しい worktree に対して実行する。
  判定は `direnv status --json` の `state.foundRC.allowed === 0`。allow されていない `.envrc` を
  新しい場所で allow するのは信頼の付与で、拡張がたった今作った worktree に、ユーザが承認していない
  コードを実行させることになる。だから真似するだけで、新しく与えることはしない。
- direnv が無い、または元に `.envrc` が無い場合はコピーだけして警告を返す。
- 途中で失敗しても失敗にはしない。worktree は存在するので、作成は成功として報告する。

worktree には git が追跡しているものしか来ないため、このコピーが要る。無いと、切った直後に起動した
Pi が `No API key found` で即死する。

## worktree を fork する

```
/fleet fork feat/x --task "uploader にリトライを入れる"
```

同じ fork はツールとしても呼べる。**主はツール。** この拡張が担うループの主導は agent 側にあり、
コマンドだけだと fork のたびに人間が真ん中に入ることになる。コマンドは人間が直接打ちたいときのために
残していて、どちらも `fork.ts` の同じ関数を呼ぶ。手順の正しさを保つ場所は 1 つだけ。

`fleet_fork`:

| 引数 | 型 | 既定 | 内容 |
|---|---|---|---|
| `branch` | string | 必須 | 新しいブランチ名 |
| `task` | string | 必須 | 実装セッションに渡すタスク |
| `base` | string | HEAD | 分岐元 |
| `scope` | enum | `implementation` | スコープ |
| `install` | boolean | true | lockfile があれば install する |
| `start` | boolean | true | pane を作って Pi を起動する |

返すのは worktree path / branch / workspace / pane / agent 名、そして環境の警告があるときだけその警告。
ツールの結果は会話の 1 エントリになるので、長い出力は並べない。

手順はこの順で 5 つ。

1. 新しいブランチの worktree を作り、上と同じように `.env*` / `.envrc` を引き継ぐ。
2. **準備** — checkout に lockfile があれば、その中で依存を install する。installer は lockfile で
   決まる（`pnpm-lock.yaml` → pnpm、`yarn.lock` → yarn、`bun.lockb` / `bun.lock` → bun、
   `package-lock.json` → npm）。lockfile が無ければ何もしない。コマンドは新しい pane の shell に
   打ち込み、完了を herdr に待たせる。install の出力は、依頼したセッションの中ではなく、見に行ける
   画面に出る。`--no-install` で飛ばせる。
3. worktree の workspace に pane を作り（`pane.split` に `--cwd <worktree>` と `--no-focus`）、
   その中で Pi を起動する。agent 名は branch から作り、herdr の `[a-z][a-z0-9_-]{0,31}` に正規化
   して 32 文字で切る。
4. タスクを **1 通のメッセージ** として `pane.send_input` で送る。`agent.prompt` は使わない。
   herdr が blocked と報告している pane を拒否する点で承認ブローカーと同じ層の問題であり、
   セッションへのプロンプト入力は pane 側の仕事。
5. worktree path / branch / workspace / pane / agent 名を通知で返す。

`--no-start` は手順 1 で止まる。worktree と環境だけができ、その中では何も動かない。

### タスクが唯一の指示書

**会話履歴は渡さない。** fork されたセッションが受け取るのは、タスク本文、worktree と branch、
制約、そして「完了」の定義だけ。議論は指示書ではない。fork した側で決めたことはタスク本文に書き写す
必要があり、決めきれなかったことは向こうでもう一度問うしかない。このプロンプトは `scopes.ts` にあり、
スコープごとに 1 つずつ入っている。fork が使う `implementation` と、レビュワーの `review`。
`fleet_fork` の `scope` 引数に出るのは、タスクと worktree だけで組み立てられるスコープだけ。`review` は
既にある worktree から材料を集める必要があるので、専用のツールから呼ぶ。

ツールの引数の説明がそう書いてあるのはこのため。`task` を書くのは、その指示書を書くべき当のモデル。

`branch` と `task` は空文字なら弾く。ツールの呼び出し元はモデルなので、中身の無いフィールドは「引数を
書き忘れた」ときの典型的な形になる。引数がそもそも無い場合はスキーマが弾き、スキーマでは表せない空文字を
ここで弾く。

implementation スコープがセッションに伝えること:

- この worktree の中だけで作業し、他の checkout には触らない
- このブランチにコミットする。worktree の作成、agent の起動、push はしない
- タスクが決めていないことは推測せず聞く
- 終わったらコミットと短い報告だけを返す（diff は貼らない）

install の失敗は失敗ではなく警告にする。worktree と pane は存在するので、通知で何が起きたかを伝える。
環境の引き継ぎの警告も同じ扱い。

### fork が待つ理由

実の pane が、API の見た目どおりに動かない 2 点がある。

- `agent.start` は、pane の shell がまだ認識されていない間 `agent_pane_busy` を返す。ここでは install
  をその pane で実行した直後なので普通に起きる。fork はリトライする。
- herdr が agent を ready と報告してから、実際に入力を受け付けるまでに 3 秒ほどある。この間に送った
  プロンプトは入力欄に残り、送信されない。末尾の Enter が単に失われる。fork は herdr が settled な
  agent を報告するまで待ってからタスクを送る。

どちらも実の herdr と Pi で計測したもので、手順がこの順になっている理由でもある。

## fork をレビューする

```
/fleet review feat/x --task "uploader にリトライを入れる"
```

レビュワーは 2 人目の Pi セッションで、**実装 worktree の中の新しい pane** で動く。別の worktree では
ない。同じブランチを 2 つの worktree にチェックアウトすることは git が拒否する。読み取り専用だと
指示する。レビュー対象を書き換えるレビューはレビューではない。agent 名はブランチの名前に `-review`
を付けたものになる。agent 名は 1 つしか取れない。

`fleet_review`:

| 引数 | 型 | 既定 | 内容 |
|---|---|---|---|
| `branch` | string | 必須 | 実装セッションが作業したブランチ |
| `task` | string | 必須 | そのセッションに渡したタスク |
| `base` | string | main checkout の HEAD | 変更を測る起点 |

fork の仕事はできるだけ渡さないことだった（仕事はタスクだから）。レビューの仕事は逆になる。レビュワー
は worktree を持っているが、何を頼まれたのかも、作者が何を未完成だと知っていたのかも分からない。
だから seed は 4 つを運ぶ。

- worktree で実行した `git diff <base>...HEAD`。diff は 60000 文字で切り、切ったことを seed に明記
  する。半分だけを見たレビュワーは、自分で `git diff` を打つレビュワーより悪い。
- タスク本文。好みではなく指示書に対して判定させるため。
- 作者のセッション。herdr がその pane について報告するパス（`session.snapshot` の
  `agent_session.value`）から読む。抜くのは assistant の `text` パートだけ。thinking もツール呼び出しも
  取らない。後者は diff を別の経路で見たものにすぎない。
- worktree とブランチ、そして作業の制約。

セッションは数 MB になる JSONL なので、抜粋は **300 行かつ 20000 文字** で上限を付け、上限は末尾から
適用する。報告は最新のメッセージであり、直近のコミットの周辺の思考の方が冒頭より効く。読むのは
ファイルの末尾（4 MB）だけで、切った場合は seed にそう書く。最後のメッセージが作者の報告で、その前が
そこに至る道筋になる。

seed はレビューの終わりをテキスト行ではなく `fleet_verdict` ツール呼び出しに固定する。レビュワーには
`approve` か `request-changes` と、問題ごとの finding を記録するよう指示し、マージゲートが読むのは
その呼び出しだけで、散文は読まないと明記する。レビュワーは `-e <この拡張>` 付きで起動する。インスト
ール未済でも `fleet_verdict` が渡り、開発中のレビューは main checkout の古いコードではなく worktree の
コードを使う。

worktree がどの workspace にも開かれていないブランチは拒否する。レビュワーを置く場所が無い。タスクの
無いレビューも拒否する。worktree で Pi セッションがもう動いていない場合、読むセッションが無い。その
場合は「何も書かなかった作者」に見えないよう、seed にそう書く。

## verdict とマージ

fork・review・verdict はブランチごとに 1 つのファイルに記録する。

```
<main checkout>/.pi/herdr-fleet/runs/<branch>.json     # branch の `/` は `-`
```

`fleet_fork` が書き、`fleet_review` がレビュワーの pane を加え、`fleet_verdict` が verdict を加える。
生きたレビュワーのセッションではなくファイルに置くのが要点。pane は閉じられるので、pane が消えたら
開くゲートはゲートではない。

`fleet_verdict`:

| 引数 | 型 | 内容 |
|---|---|---|
| `verdict` | `approve` / `request-changes` | マージしてよいか |
| `findings` | `{ path, line?, note }[]` | 問題ごとに 1 件 |

呼べるのは、その run が記録したレビュワーの pane だけ。拡張はどの Pi セッションにも入っているので、
この検査が無いとどのセッションからでも verdict を書ける。`request-changes` の findings は、実装
セッションがまだ生きていれば `pane.send_input` で送り返す。代わりのセッションは立てない。

```
/fleet status
/fleet merge feat/x
```

`/fleet status` は run ごとに branch · scope · 状態 · verdict を 1 行で出す。状態は `working` /
`unreviewed` / `approve` / `request-changes` / `merged` / `cleaned`（ブランチが既に main checkout の
履歴に入っていれば `merged`、`/fleet clean` が worktree・branch・pane を消していれば `cleaned`）。

`/fleet merge` は main checkout で `git merge --no-edit` を実行する。verdict が `approve` でなければ
（`--force` が無ければ）拒否し、追跡ファイルが汚れていても拒否する。未追跡ファイルは止めない。run の
記録自体が `.pi/` の下にあるため。worktree は消さない。後始末は別の操作にする。

その別の操作が `/fleet clean`。run が記録した pane を閉じ、herdr の `worktree.remove` で worktree を
消し、main checkout で `git branch -d` を打つ。ブランチが main の履歴に入っていなければ `--force` が
無い限り拒否する。run 記録とセッション JSONL は消さない — 記録には `cleanedAt` が付くだけ。

どちらもツールでもある（`fleet_status` は引数なし、`fleet_merge` は `branch` と任意の `force`、
`fleet_clean` は `branch` と任意の `force`）。コマンドは、ツールと同じ `statusRuns` / `mergeRun` /
`cleanRun` を呼ぶ薄いラッパ。人間がキーボードの前にいなくてもループが閉じる — agent が fork し、
review し、merge し、そのまま後始末できる。

## 通知

新しく blocked になった pane は pi の通知を出す。切るには:

```json
// ~/.pi/agent/pi-herdr-fleet.json
{ "notify": false }
```

このファイルから読むのはこれだけ。

## 仕組み

真実は herdr 側にある。拡張は再構成できない状態を持たない。

- 一覧は `session.snapshot` から作り、`pane.agent_status_changed` で直す。想定外の動きをした pane は、
  ローカルで推測せず herdr に聞き直して解決する。
- 詳細画面の質問文は `agent.read` で読む（`detection` を先に、herdr が何も返さなければ `visible`）。
  blocked になった時点で 1 回だけ読む。
- すべての呼び出しにタイムアウトを付け、失敗（古い herdr にメソッドが無い、socket が切れた、サーバが
  遅い）は例外ではなく値として返す。overlay は理由を出すだけで、セッションは壊さない。
- 購読接続は指数バックオフで再接続する。復帰時は購読を張り直し、`session.snapshot` を読み直す。
  古いストリームから作った状態は herdr の状態で置き換わる。

## 制限

- pane の集合ごとに購読接続が 1 本要る。herdr の `pane.agent_status_changed` は `pane_id` 単位で、
  購読済みの接続に 2 つ目の `events.subscribe` を送ると接続が閉じられる。そのため pane が増えると
  接続も増える。溜め込みはしない。集合は snapshot から作り直して比較する。
- 分岐 worktree ループは閉じた。fork・review・verdict はブランチごとに記録され、`/fleet status` が
  一覧し、`/fleet merge` は `approve` の無いブランチを拒否し、`/fleet clean` がマージ済み run の
  worktree・branch・pane を消す。run 記録とセッション JSONL は消さない。記録に `cleanedAt` が付く
  だけ。
- レビュワーは `-e <この拡張>` 付きで起動する。動くのは、起動した側のコードであって、インストール
  済みのコピーではない。
- `worktree.create` は linked worktree を分岐元にできない。そのため linked worktree の中からの
  `/fleet fork` は main checkout から作られ、呼び出し元の HEAD に固定される。そこにある未コミットの
  変更は fork に入らない。ある場合は警告を出す。
- `/fleet worktree create` も `/fleet fork` もフォーカスを移さない。新しい workspace は裏で作られる。
- レシピが記録するのは 1 つの tab。workspace 全体を保存する手段は無いし、保存元の tab に復元する
  手段も無い。
- 環境マネージャは direnv しか見ていない。mise や asdf の類いは `.envrc` 経由でしか引き継がれない。

## 開発

```sh
node packages/pi-herdr-fleet/selfcheck.ts
```

一時 socket に立てた偽の herdr サーバに対して、transport とブローカーを動かす。リクエスト・エラー・
タイムアウトの縮退、購読と再接続・再同期、購読を拒否されたときにその集合を組み直すこと、自分以外の pane
だけが並ぶこと、blocked から外れたら行が消えること、最初の snapshot では通知せず snapshot の読み直しで
再通知しないこと、送信に失敗したら行が残ること、有効条件のガードを確認する。overlay も実際に描画し、
全行の幅が揃っていることと枠が閉じていることを見る。

レシピと環境のコピーは実際の一時ディレクトリで確認する。レシピが `cwd` / `env` / `command` を残して
`pane_id` を落とすこと、`--start` がコマンド再現の有無を決めること、名前がレシピのディレクトリの外に
出られないこと、そして direnv を差し替えて、allow されていない元の `.envrc` は新しい worktree でも
allow されず、allow 済みのものは引き継がれること。

fork の部品も同じように確認する。installer を決めるのが lockfile だけで、lockfile の無い checkout には
install しないこと、`--no-install` が何も打ち込まないこと、install の目印がコマンドの echo に一致
しないこと（pane は打った文字をそのまま echo するので、目印をリテラルで書くと install が走る前に一致
してしまう）、0 以外の終了が失敗として報告されること、busy な pane はリトライする一方で直らない
`agent.start` の失敗はリトライしないこと、何かを打ち込む前に agent の settled を待つこと。seed と
agent 名は純粋関数なので、タスク・worktree・branch が出来上がる文字列に入ることを見る。

ツールはツール自身の面から確認する。`branch` と `task` がスキーマで必須であること、scope の enum が
registry から来ること、空の `branch` / `task` や未知の scope が herdr に届かないこと、TUI 以外の
セッションからの呼び出しを拒否すること、失敗は throw すること（戻り値ではエラーフラグは立たない）、
結果が fork を名指ししつつきれいな環境の話はしないこと、環境の警告はモデルに届くこと。

### 受入試験

```sh
packages/pi-herdr-fleet/acceptance.sh
```

実の herdr サーバ、実の pane、実の direnv、実の Pi TUI で通す。herdr の pane の中で実行する。
ブローカーは自分の pane を一覧に出さないので pane は 3 つ要り、スクリプトがそれを作る。
`pane.report_agent` で `blocked` を報告した **subject** の shell、別 pane でこの拡張を読み込んだ
**observer** の Pi、そして呼び出し元の pane。確認するのは、通知、overlay の一覧、詳細画面の質問文、
回答の 2 経路（テキストと生キー）、`Esc` で overlay が閉じること。閉じるのは自分が作った pane だけ。

subject の状態を実エージェントではなく報告で作るので、実行は決定的になる。モデルに答えさせずに、
socket・購読・overlay・subject の `read` へのキー配送という経路全体を実際に通す。

```sh
packages/pi-herdr-fleet/acceptance-fork.sh
```

`/fleet fork` を、同じ実スタックに実の git と実の npm を足して通す。fork は本物の worktree を作るので、
このスクリプトはこのリポジトリには触らない。一時ディレクトリに自前の git リポジトリ（lockfile の無い
base commit 付き）と、observer Pi 用の自前の workspace を作る。作った worktree・workspace・pane と
direnv の trust はすべて後始末し、それ以外は読むことも閉じることもない。

fork 4 つで確認する。worktree・環境のコピー・direnv の trust・install・pane・Pi・seed がすべて起きる
こと、fork されたセッションが実際にタスクをこなしてコミットすること、lockfile の無い checkout には
install しないこと、`--no-install` が lockfile を無視すること、`--no-start` が何も動いていない worktree
を残すこと。

続けてツール経路を確認する。agent が実際に使うのはこちらで、コマンドの試験では届かない。observer の
agent に `fleet_fork` を呼ばせ、worktree、pane、observer の会話に残ったツール結果、fork 先セッションに
届いた seed を見る。そのあと拒否を 2 つ。空の `task`（ツール自身の検証が弾く）と、`task` をそもそも
渡さない呼び出し（ツールが動く前にスキーマが弾く）。どちらも worktree を残してはいけない。

`acceptance.sh` と違い、ここには動くモデルが要る。fork 先のセッションに作業させるためと、observer に
ツールを呼ばせるため。API key が環境に無ければ警告を出す。

続けて `/fleet review` を、最初の fork のブランチに対して通す。作者の worktree に 2 人目の Pi が入る。
見るのはレビュワー自身のセッションファイル — タスク、diff、verdict の形、そして作者の報告の断片。
報告は `git` では出せない唯一の材料になる。そのあとレビュワーの最後の返答が verdict で終わることを
見る。指示どおり読み取り専用だったかを、worktree が汚れていないことで確かめる。

最後に linked worktree からの fork。main checkout から worktree が作られ、linked 側にしか無いコミット
で fork 点が呼び出し元の HEAD に固定されたことを確かめる。未コミットの変更は引き継がれず、どちらも警告
として出る。

フリートビューは 3 本目の受入試験で通す。

```sh
packages/pi-herdr-fleet/acceptance-view.sh
```

状態の違う実 Pi セッションを 3 つ（idle、`sleep` の最中の working、observer 自身）と、agent のいない
shell の pane を立て、一覧・詳細・`r` の再取得を確かめる。自分自身の pane が出て印が付くこと、2MB を
超えたセッションが末尾から読まれてコストが `≥` になることも見る。実モデルに答えさせるので、
`acceptance-fork.sh` と同じく動くモデルが要る。

このリポジトリに `tsconfig.json` は無いので、型チェックは明示的に実行する:

```sh
npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext \
  --strict --skipLibCheck --allowImportingTsExtensions --types node \
  packages/pi-herdr-fleet/index.ts
```
