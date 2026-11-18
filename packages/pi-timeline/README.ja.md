# pi-timeline

エージェントの作業計画を、editor の上に 1 行で出し続ける pi extension。DSH の公式 timeline プラグイン相当の最小版。

```
timeline  3/7  ████░░░░░░  ▶ widget を書く 1m20s  !1
```

`alt+t`（または `/timeline`）でタスク一覧の全画面を開く。

## Install

```sh
pi install @335g/pi-timeline
```

## 何が出るか

- 進捗バー、完了数、実行中タスクと経過時間、ブロック中の件数（1 行）
- `alt+t` / `/timeline` で開く一覧: 親子のタスクツリー、状態、所要時間、メモ、合計作業時間
- 開いている間だけ 1 秒ごとに再描画する（閉じているときは何もしない）

## `timeline` ツール

モデルは `timeline` ツールで計画を**毎回全置換**して出す。id を再利用すれば所要時間は引き継がれる。

```json
{ "tasks": [
  { "id": "1", "title": "プランを立てる", "status": "done" },
  { "id": "2", "title": "widget を書く", "status": "active" },
  { "id": "2.1", "title": "描画を切り詰める", "parent": "2" },
  { "id": "3", "title": "テストを走らせる", "status": "blocked", "note": "typecheck 待ち" }
] }
```

- `status`: `pending`（既定）/ `active` / `done` / `blocked`
- 状態が `active` になった時刻と `done` になった時刻だけを記録する。所要時間はその差分。
- 空 id・空 title・重複 id は捨てる。存在しない親は根に戻す。

## 状態と保存

計画は `pi.appendEntry("pi-timeline", ...)` でセッションの JSONL に保存する。セッション再開・分岐・`/reload` で復元する（ブランチ上の最新を使う）。

`/timeline-reset` で計画と footer の行を手動で消去する（空の状態を保存するので復元されない）。

## キー

| キー | 動作 |
|---|---|
| `alt+t` | timeline を開く |
| `esc` / `q` / `ctrl+c` | 閉じる |
| `↑` `↓` / `pageUp` `pageDown` | スクロール |

## 制約

- 常設ペインは無い。組み込み footer の下に 1 行足すだけなので、詳細はショートカットで開く前提。
- 定時報告（モデルへの割り込み送信）はしない。見たいときに開く方がトークンを使わない。
- サブエージェントの進捗は別途。親の timeline には手で行を足す。

## 開発

```sh
npm test           # src/timeline.ts のロジック
node selfcheck.ts  # 拡張の配線（stub API で tool / footer 1 行 / 全画面 / 復元）
```
