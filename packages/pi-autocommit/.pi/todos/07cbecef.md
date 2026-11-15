{
  "id": "07cbecef",
  "title": "[E5] `/autocommit-recover` 全ブランチのstray checkpointを一覧",
  "tags": [
    "idea",
    "decision"
  ],
  "status": "pending",
  "created_at": "2026-10-30T06:48:02.000Z",
  "parent": "eacdfcfd",
  "code": "E5"
}

# [E5] `/autocommit-recover` 全ブランチのstray checkpointを一覧

## 何を変えるか
`/autocommit-recover`。全ブランチの stray checkpoint を列挙し、整理か破棄を選ばせる。

## 現状（コード根拠）
`findReachableCheckpoints` は HEAD から到達可能な範囲のみ（`src/git-operations.ts`）。破棄用のコマンドは無い。

## 実装案
`git log --all --grep='^wip(checkpoint):'` 相当の取得関数を追加し、一覧から選択 → 対象ブランチへ checkout して `reorganiseCheckpointsManual`、または破棄。

## 工数・リスク
半日
- リスク: 他ブランチを触るので事故りやすい。読み取り専用の一覧表示だけ先に出す段階導入が安全。

## 判断
- [ ] 採用
- [ ] 不採用
- [ ] 保留

**理由 / メモ**: 
