{
  "id": "06cbeb5c",
  "title": "[E4] `/autocommit-unstage` でstagedのまま返す",
  "tags": [
    "idea",
    "decision"
  ],
  "status": "pending",
  "created_at": "2026-10-30T06:48:02.000Z",
  "parent": "eacdfcfd",
  "code": "E4"
}

# [E4] `/autocommit-unstage` でstagedのまま返す

## 何を変えるか
`/autocommit-unstage`。checkpoint を soft reset して staged のまま返す（LLMに渡さない）。

## 現状（コード根拠）
同じ処理は `reorganiseCheckpointsManual` の途中に埋まっている（`countCheckpointCommits` → `crossesRemoteTip` → `resetSoft`）。単体では呼べない。

## 実装案
`reorganiseCheckpointsManual` から reset 部分だけを切り出して共通化し、コマンドから呼ぶ。

## 工数・リスク
60分
- リスク: ほぼ無し。E3 の実体にもなる。

## 判断
- [ ] 採用
- [ ] 不採用
- [ ] 保留

**理由 / メモ**: 
