# pi-herdr-fleet

[English](./README.md)

[herdr](https://herdr.dev) の pane と Pi の間の承認ブローカー。herdr はどの pane が人間の返答を
待っているかを知っている。`/fleet` はその一覧を、いま見ている pane の上に overlay で出し、pane を
切り替えずに blocked のエージェントへ答える。同じコマンドで tab のレイアウトを保存・復元し、
git 管理外の開発環境を引き継いだ worktree も作れる。

Phase 2 は herdr クライアント層、承認ブローカー、レシピ、worktree 作成まで。分岐 worktree ループが
次のフェーズ。

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
- `/fleet recipe save <name>` — 現在の tab のレイアウトを保存する
- `/fleet recipe apply <name> [--start]` — 新しい tab として復元する
- `/fleet recipe ls` — 保存済みのレシピを一覧する
- `/fleet worktree create <branch> [--base <ref>] [--label <text>]` — worktree を作り、開発環境を
  引き継ぐ

| キー | 動作 |
|------|------|
| `↑` `↓` | 選択を動かす |
| `1`〜`9` | その行を開く |
| `Enter` | 選択中の行を開く |
| `Esc` | overlay を閉じる |

詳細画面では:

| キー | 動作 |
|------|------|
| `Enter` | 入力したテキストを送る（`agent.prompt`） |
| `ctrl+k` | 入力した内容を生キーとして送る（`agent.send_keys`） |
| `PageUp` `PageDown` | 質問文をスクロール |
| `Esc` | 一覧へ戻る |

## 承認待ちへの答え方

承認ダイアログは文章で答えられる形とは限らない。番号付きの選択肢かもしれないし、yes/no かもしれないし、
全画面のピッカーかもしれない。そこで詳細画面からは 2 経路を用意し、どちらを使うかは入力から推測せず
こちらで選ぶ。

- **テキスト**（`Enter`）— 入力した内容を、その pane の入力欄に打ったのと同じように送る。
- **生キー**（`ctrl+k`）— 代わりにキーストロークを送る。入力は空白で区切るので、`esc 1` は `esc` の次に
  `1`、`up up enter` はメニューを辿る。入力が空なら素の `Enter` になる。確認ダイアログではこれが普通。

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
- 分岐 worktree ループ（Phase 3）は未実装。`/fleet worktree create` は worktree を作って環境を
  引き継ぐだけで、そこで何かを起動することはせず、workspace にフォーカスも移さない。
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

このリポジトリに `tsconfig.json` は無いので、型チェックは明示的に実行する:

```sh
npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext \
  --strict --skipLibCheck --allowImportingTsExtensions --types node \
  packages/pi-herdr-fleet/index.ts
```
