{
  "id": "8ceb7ef9",
  "title": "[H4] `splitModel` 分割用とメッセージ用で別モデル",
  "tags": [
    "idea",
    "decision"
  ],
  "status": "pending",
  "created_at": "2026-10-30T06:48:02.000Z",
  "parent": "eacdfcfd",
  "code": "H4"
}

# [H4] `splitModel` 分割用とメッセージ用で別モデル

## 何を変えるか
`splitModel` を追加し、分割（構造判断）とメッセージ生成で別モデルを使えるようにする。

## 現状（コード根拠）
`config.model` 1つだけ（`src/llm-commit.ts` の `resolveModel`）。

## 実装案
`splitModel?: string` を追加し、`completeCommitGroups` は splitModel → model → session の順で解決。

## 工数・リスク
2時間
- リスク: モデルごとに出力形式の遵守度が違う。パース失敗時の fallback が既にあるので影響は限定的。

## 判断
- [ ] 採用
- [ ] 不採用
- [ ] 保留

**理由 / メモ**: 
