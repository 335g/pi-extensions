# pi-herdr-fleet

[English](./README.md)

[herdr](https://herdr.dev) の pane と Pi の間の承認ブローカー。herdr はどの pane が人間の返答を
待っているかを知っている。`/fleet` はその一覧を、いま見ている pane の上に overlay で出し、pane を
切り替えずに blocked のエージェントへ答える。

Phase 1 は herdr クライアント層と承認ブローカーまで。レイアウトのレシピと分岐 worktree ループは
後のフェーズ。

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
- レシピ（`/fleet recipe ...`、Phase 2）と分岐 worktree ループ（Phase 3）は未実装。
- `/fleet` はまだ引数を取らない。

## 開発

```sh
node packages/pi-herdr-fleet/selfcheck.ts
```

一時 socket に立てた偽の herdr サーバに対して、transport とブローカーを動かす。リクエスト・エラー・
タイムアウトの縮退、購読と再接続・再同期、購読を拒否されたときにその集合を組み直すこと、自分以外の pane
だけが並ぶこと、blocked から外れたら行が消えること、最初の snapshot では通知せず snapshot の読み直しで
再通知しないこと、送信に失敗したら行が残ること、有効条件のガードを確認する。overlay も実際に描画し、
全行の幅が揃っていることと枠が閉じていることを見る。

このリポジトリに `tsconfig.json` は無いので、型チェックは明示的に実行する:

```sh
npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext \
  --strict --skipLibCheck --allowImportingTsExtensions --types node \
  packages/pi-herdr-fleet/index.ts
```
