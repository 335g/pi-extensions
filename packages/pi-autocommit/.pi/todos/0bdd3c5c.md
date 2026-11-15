{
  "id": "0bdd3c5c",
  "title": "[B1] `organiseEvery: \"turn\"` でターン単位整理",
  "tags": [
    "idea",
    "decision"
  ],
  "status": "pending",
  "created_at": "2026-10-30T06:48:02.000Z",
  "parent": "eacdfcfd",
  "code": "B1"
}

# [B1] `organiseEvery: "turn"` でターン単位整理

## 何を変えるか
`organiseEvery: "turn" | "agent_end"` を追加。毎ターン checkpoint を整理し、1ターン＝1〜2コミットで履歴を積む。

## 現状（コード根拠）
整理は `agent_end` の1回だけ（`src/index.ts`）。commitEveryTurn は ADR-0001 で `enable` に吸収された経緯がある（`.pi/todos/3046976f.md`）。

## 実装案
`turn_end` の checkpoint 成功直後に `organizeCheckpointCommits` を呼び、`agent_end` は skip。`mergeSimilarPrevious` との相互作用（毎ターン前回と統合し続ける）を決める必要。

## 工数・リスク
半日
- リスク: LLM呼び出し回数がターン数に比例してコスト増。`mergeSimilarPrevious` が毎回走ると履歴が伸びない。

## 判断
- [ ] 採用
- [ ] 不採用
- [ ] 保留

**理由 / メモ**: 
