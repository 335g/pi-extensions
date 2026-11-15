{
  "id": "9cd5d1da",
  "title": "[A2] プロンプト内トリガー `@no-commit` でそのターンだけスキップ",
  "tags": [
    "idea",
    "decision"
  ],
  "status": "pending",
  "created_at": "2026-10-30T06:48:02.000Z",
  "parent": "eacdfcfd",
  "code": "A2"
}

# [A2] プロンプト内トリガー `@no-commit` でそのターンだけスキップ

## 何を変えるか
ユーザメッセージに `@no-commit` を含めたターンだけ checkpoint を作らない。プロンプト単位の制御。

## 現状（コード根拠）
`turn_end` は `event.toolResults` しか見ない（`src/index.ts`、`shouldCreateCheckpointCommit`）。`TurnEndEvent` に messages が含まれるかは未確認（`node_modules/@earendil-works/pi-coding-agent` の型を要確認）。

## 実装案
`shouldCreateCheckpointCommit(toolResults, skip?)` にフラグを足し、`event.messages` の user テキストに `@no-commit` が含まれるかで渡す。型に messages が無ければ A1 に統合。

## 工数・リスク
60分（型確認次第）
- リスク: プロンプト本文にたまたま含まれた文字列で誤発火する。

## 判断
- [ ] 採用
- [ ] 不採用
- [ ] 保留

**理由 / メモ**: 
