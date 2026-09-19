# pi-extensions

[pi](https://github.com/earendil-works/pi) の拡張をまとめたリポジトリ。npm workspaces で管理し、`packages/` の下の各パッケージは `@335g/pi-<名前>` として個別に公開する。

英語版は [README.md](./README.md)。

## パッケージ

| パッケージ | 内容 |
|------------|------|
| [pi-answer](./packages/pi-answer/) | アシスタントメッセージから質問を抽出し、対話的な Q&A 画面で回答する。任意の引数で遡る数を指定できる（`/answer 2`）。 |

インストール方法と使い方は各パッケージの README に書く（[pi-answer 日本語版](./packages/pi-answer/README.ja.md)）。
