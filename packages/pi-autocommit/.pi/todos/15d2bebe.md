{
  "id": "15d2bebe",
  "title": "[F3] フッターにcheckpoint数と使用モデル",
  "tags": [
    "idea",
    "decision"
  ],
  "status": "pending",
  "created_at": "2026-10-30T06:48:02.000Z",
  "parent": "eacdfcfd",
  "code": "F3"
}

# [F3] フッターにcheckpoint数と使用モデル

## 何を変えるか
フッターに checkpoint 数と使用モデルを出す。

## 現状（コード根拠）
`StatusIndicator` は `pi-autocommit-mode` と `pi-autocommit-uncommitted` の2キーだけ（`src/status-indicator.ts`）。

## 実装案
キーを2つ追加し、`updateFooter()` で `countCheckpointCommits` と `config.model ?? "session"` を設定。更新は `turn_end` / `agent_end` のみ。

## 工数・リスク
1.5時間
- リスク: 毎ターン git 呼び出しが増える（footer 更新のたび）。

## 判断
- [ ] 採用
- [ ] 不採用
- [ ] 保留

**理由 / メモ**: 
