# pi-extensions

[pi](https://github.com/earendil-works/pi) の拡張をまとめたリポジトリ。npm workspaces で管理し、`packages/` の下の各パッケージは `@335g/pi-<名前>` として個別に公開する。

英語版は [README.md](./README.md)。

## パッケージ

| パッケージ | 内容 |
|------------|------|
| [pi-answer](./packages/pi-answer/) | アシスタントメッセージから質問を抽出し、対話的な Q&A 画面で回答する。任意の引数で遡る数を指定できる（`/answer 2`）。 |
| [pi-byetheway](./packages/pi-byetheway/) | セッションの内容を踏まえて質問できるが、やりとりを残さないスペース（`/btw`）。`ctrl+p` で明示的に本体セッションへ渡せる。 |
| [pi-herdr-fleet](./packages/pi-herdr-fleet/) | [herdr](https://herdr.dev) の pane と Pi の間の承認ブローカー。`/fleet` が人間の返答を待っている pane を並べ、いま見ている pane から答えられる。tab のレイアウトの保存・復元、`.env` / `.envrc` を引き継ぐ worktree 作成、そして worktree を fork して新しい Pi セッションにタスクを渡すことまで担う。 |

インストール方法と使い方は各パッケージの README に書く（[pi-answer 日本語版](./packages/pi-answer/README.ja.md)、[pi-byetheway 日本語版](./packages/pi-byetheway/README.ja.md)、[pi-herdr-fleet 日本語版](./packages/pi-herdr-fleet/README.ja.md)）。
