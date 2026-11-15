{
  "id": "8be93ecf",
  "title": "[I1] `fixup` モード（`git commit --fixup` + autosquash）",
  "tags": [
    "idea",
    "decision"
  ],
  "status": "pending",
  "created_at": "2026-10-30T06:48:02.000Z",
  "parent": "eacdfcfd",
  "code": "I1"
}

# [I1] `fixup` モード（`git commit --fixup` + autosquash）

## 何を変えるか
`fixup` モード。checkpoint を `git commit --fixup=<sha>` で積み、autosquash 前提の運用にする。履歴を書き換えない。

## 現状（コード根拠）
checkpoint は通常コミット＋`resetSoft` で書き換える方式（`src/pipeline.ts` / `src/commit-organizer.ts`）。fixup の経路は無い。

## 実装案
`organiseEvery` とは別の `commitStrategy` として実装。checkpoint 段階で fixup 対象を選ぶ必要があり、既存の「全変更を一度 staged に戻す」モデルと噛み合わない。

## 工数・リスク
半日
- リスク: 既存設計と衝突が大きい。採用するなら別拡張として切る方が安全。

## 判断
- [ ] 採用
- [ ] 不採用
- [ ] 保留

**理由 / メモ**: 
