# pi-extensions

[pi](https://github.com/earendil-works/pi) の拡張をまとめたリポジトリ。npm workspaces で管理し、`packages/` の下の各パッケージは `@335g/pi-<名前>` として個別に公開する。

英語版は [README.md](./README.md)。

## インストール

npm から 1 パッケージだけ入れる:

```sh
pi install @335g/pi-summary
```

このチェックアウトの拡張をまとめて入れる:

```sh
pi install ./                       # このリポジトリの中で
pi install /path/to/pi-extensions   # どこからでも
```

チェックアウトから 1 パッケージだけ入れる:

```sh
pi install ./packages/pi-answer
```

ルートの `package.json` が `pi.extensions` に `packages/*/index.ts`、`packages/*/src/index.ts`、
`packages/*/src/extension.ts` を並べているので、リポジトリのルートを入れると各パッケージが TypeScript の
ソースのまま読み込まれる。ビルドは要らない（`pi-autocommit` 自身の manifest は `dist/index.js` を指すので、
npm から入れる場合は同梱の `dist` が使われるが、このリポジトリのチェックアウトをルートから読み込む場合は
そのパッケージで `npm run build` が必要）。

## パッケージ

| パッケージ | npm | 内容 |
|------------|-----|------|
| [pi-answer](./packages/pi-answer/) | `@335g/pi-answer` | アシスタントメッセージから質問を抽出し、対話的な Q&A 画面で回答する。任意の引数で遡る数を指定できる（`/answer 2`）。 |
| [pi-autocommit](./packages/pi-autocommit/) | `@335g/pi-autocommit` | チェックポイント方式の自動コミット。ファイルを変更したターンごとに `wip(checkpoint)` コミットを作り、タスクの区切り・push の直前・エージェントループの終了時に、未整理の分を論理的な Conventional Commits に整理する。コマンドは `/autocommit-enable`、`/autocommit-mode`、`/autocommit-organise`、`/autocommit-model`。 |
| [pi-byetheway](./packages/pi-byetheway/) | `@335g/pi-byetheway` | セッションの内容を踏まえて質問できるが、やりとりを残さないスペース（`/btw`）。`ctrl+p` で明示的に本体セッションへ渡せる。 |
| [pi-summary](./packages/pi-summary/) | `@335g/pi-summary` | `/summary` が現在のセッションのユーザーと AI の発話だけを表示し、コメントやその直後の作業をその場で要約する。 |

インストール方法と使い方は各パッケージの README に書く（[pi-autocommit 日本語版](./packages/pi-autocommit/README.ja.md)、[pi-answer 日本語版](./packages/pi-answer/README.ja.md)、[pi-byetheway 日本語版](./packages/pi-byetheway/README.ja.md)、[pi-summary](./packages/pi-summary/README.md)）。
