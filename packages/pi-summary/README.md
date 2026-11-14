# pi-summary

Pi 拡張。現在のセッションの**ユーザーと AI の発話だけ**を抜き出して表示する。tool call、tool 実行結果、system メッセージは出さない。情報量の違う 5 コマンド。

| コマンド | 内容 | LLM 呼び出し |
|---|---|---|
| `/summary` | 全ラリーをそのまま | なし |
| `/summary-1` | 直近の 1 ラリーだけをそのまま | なし |
| `/summary-low` | 各ラリーを 2〜3 行に縮める | 1 回 |
| `/summary-min` | 全体を 10〜20 行に要約（目的 / 決まったこと / 未解決 / 次にやること） | 1 回 |
| `/summary-internal` | 直近のリクエストで AI が実行したツール呼び出しを要約（やったこと / 触ったファイル / 結果 / 注意点） | 1 回 |

`/summary-low`、`/summary-min`、`/summary-internal` はセッションの現在のモデル (`ctx.model`) を使う。

## インストール

```bash
pi install /Users/335g/Dev/pi-summary
# または
pi install git:github.com/335g/pi-summary
```

反映は `/reload`。

## 使い方

セッション中にコマンドを打つ。

- スクロール: `j` / `k`、`↑` / `↓`、`PgUp` / `PgDn`、マウスホイール
- 閉じる: `Enter` / `Esc` / `q`
- 非 TUI モード (`--mode rpc` など) では標準出力に Markdown を書く

## 開発

```bash
npm test                      # 抽出とプロンプト生成のロジック
pi -e ./src/extension.ts       # 単発で試す
```

| ファイル | 役割 |
|---|---|
| `src/extension.ts` | 3 コマンドの登録、TUI オーバーレイ、LLM 呼び出し |
| `src/turns.ts` | セッションエントリ → user/assistant の発話だけ |
| `src/summarize.ts` | ラリー分割と要約プロンプト |
| `src/work.ts` | 直近ラリーのツール呼び出しと結果を抽出し、作業サマリーのプロンプトを作る |

## ライセンス

MIT。詳細は [LICENSE](./LICENSE)。
