# pi-extensions

[pi](https://github.com/earendil-works/pi) の拡張をまとめたリポジトリ。npm workspaces で管理し、`packages/` の下の各パッケージは `@335g/pi-<名前>` として個別に公開する。

英語版は [README.md](./README.md)。

## パッケージ

| パッケージ | 内容 |
|------------|------|
| [pi-answer](./packages/pi-answer/) | アシスタントメッセージから質問を抽出し、対話的な Q&A 画面で回答する。任意の引数で遡る数を指定できる（`/answer 2`）。 |

各パッケージの詳細は、それぞれの README を参照（[pi-answer 日本語版](./packages/pi-answer/README.ja.md)）。

## インストール

```sh
pi install npm:@335g/pi-answer
```

`pi install` はユーザ設定（`~/.pi/agent/settings.json`）に書き込む。プロジェクト設定（`.pi/settings.json`）に書き込むときは `-l` を付ける。

## 開発

- 拡張 1 つにつき `packages/` の下に 1 ディレクトリを置き、それぞれに `package.json`、`pi.extensions` のエントリ、README を用意する。
- リポジトリのルートで `npm install` を実行するとワークスペースがリンクされる。
- 公開は `npm publish -w @335g/pi-answer`。

パッケージは TypeScript（`index.ts`）のまま読み込まれるため、ビルド手順は無い。
