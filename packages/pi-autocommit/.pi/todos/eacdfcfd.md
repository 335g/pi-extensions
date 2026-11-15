{
  "id": "eacdfcfd",
  "title": "[親] pi-autocommit リッチ化: 44項目の採用判断",
  "tags": [
    "idea",
    "decision",
    "parent"
  ],
  "status": "pending",
  "created_at": "2026-10-30T06:48:02.000Z",
  "children": [
    "A1",
    "A2",
    "A3",
    "A4",
    "A5",
    "B1",
    "B2",
    "B3",
    "B4",
    "B5",
    "C1",
    "C2",
    "C3",
    "C4",
    "C5",
    "D1",
    "D2",
    "D3",
    "D4",
    "D5",
    "E1",
    "E2",
    "E3",
    "E4",
    "E5",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "G1",
    "G2",
    "G3",
    "G4",
    "H1",
    "H2",
    "H3",
    "H4",
    "I1",
    "I2",
    "I3",
    "I4",
    "I5"
  ]
}

# 親TODO: pi-autocommit リッチ化 44項目の採用判断

目的: 拡張機能をリッチにする候補44件それぞれについて「採用 / 不採用 / 保留」を決め、その結果をここから一覧できる状態にする。

## 進捗

- 判断済み: 0 / 44
- 採用: 0 / 不採用: 0 / 保留: 0

## 進め方

1. 下の表から項目を1つ選び、リンク先の子TODOを開く。
2. 子TODOの「## 判断」で 採用 / 不採用 / 保留 のどれか1つにチェックを入れ、「理由 / メモ」を1行書く。
3. 戻ってきて、この表の「判断」を 済 に、「決定」を 採用 / 不採用 / 保留 に更新する。
4. 判断済みカウンタを1つ増やす。

「保留」は条件を必ず書く（例: 保留（実測でhookが遅いと分かったら採用））。

## A. 停止・一時オフ（5件 / 判断済み 0）

| コード | 項目 | 判断 | 決定 |
|---|---|---|---|
| A1 | [`/autocommit-pause` Nターン限定の停止](9bd5d047.md) | 未 | - |
| A2 | [プロンプト内トリガー `@no-commit` でそのターンだけスキップ](9cd5d1da.md) | 未 | - |
| A3 | [コミットガードの個別スイッチ（commit/push/merge/resetHard）](9dd5d36d.md) | 未 | - |
| A4 | [HEADにcheckpointが無ければ `git push` を許可](96d5c868.md) | 未 | - |
| A5 | [pushされるまで自動でオフに戻す](97d5c9fb.md) | 未 | - |

## B. コミット粒度（5件 / 判断済み 0）

| コード | 項目 | 判断 | 決定 |
|---|---|---|---|
| B1 | [`organiseEvery: "turn"` でターン単位整理](0bdd3c5c.md) | 未 | - |
| B2 | [`maxCommitsPerRun` で1回の整理のコミット数に上限](0edd4115.md) | 未 | - |
| B3 | [`split: "paths"` LLMなしの決定的分割](0ddd3f82.md) | 未 | - |
| B4 | [`groupBy: "scope"|"dir"|"type"` の決定的分割](08dd37a3.md) | 未 | - |
| B5 | [`singleCommit` 常に1コミット](07dd3610.md) | 未 | - |

## C. メッセージ・コミットオプション（5件 / 判断済み 0）

| コード | 項目 | 判断 | 決定 |
|---|---|---|---|
| C1 | [トレーラー・テンプレート設定](87da2df9.md) | 未 | - |
| C2 | [整理コミットだけ GPG 署名する `signCommits`](84da2940.md) | 未 | - |
| C3 | [checkpointは `--no-verify`、整理コミットだけhookを通す](85da2ad3.md) | 未 | - |
| C4 | [`extraTypes` でConventional Commitsのtypeを拡張](8ada32b2.md) | 未 | - |
| C5 | [`subjectMaxLength` / `bodyStyle` の調整](8bda3445.md) | 未 | - |

## D. ステージ対象の制御（安全性）（5件 / 判断済み 0）

| コード | 項目 | 判断 | 決定 |
|---|---|---|---|
| D1 | [`exclude` / `include` globs でステージ対象を制御](07ce2b86.md) | 未 | - |
| D2 | [ステージ前の警告（生成物・大きいバイナリ・lockfile）](06ce29f3.md) | 未 | - |
| D3 | [detached HEAD でのcheckpoint作成を警告](05ce2860.md) | 未 | - |
| D4 | [secretスキャン（opt-in）でコミットをブロック](0cce3365.md) | 未 | - |
| D5 | [1ターンの変更量上限でスキップ](0bce31d2.md) | 未 | - |

## E. 取り消し・復旧・手動移行（5件 / 判断済み 0）

| コード | 項目 | 判断 | 決定 |
|---|---|---|---|
| E1 | [`/autocommit-undo` で整理前に戻す](03cbe6a3.md) | 未 | - |
| E2 | [破壊操作前の自動バックアップタグ](04cbe836.md) | 未 | - |
| E3 | [`/autocommit-eject` で手動rebaseに引き渡す](05cbe9c9.md) | 未 | - |
| E4 | [`/autocommit-unstage` でstagedのまま返す](06cbeb5c.md) | 未 | - |
| E5 | [`/autocommit-recover` 全ブランチのstray checkpointを一覧](07cbecef.md) | 未 | - |

## F. 観測・UX（6件 / 判断済み 0）

| コード | 項目 | 判断 | 決定 |
|---|---|---|---|
| F1 | [`/autocommit-status` の1画面サマリ](13d2bb98.md) | 未 | - |
| F2 | [`/autocommit-config` 設定の対話編集](16d2c051.md) | 未 | - |
| F3 | [フッターにcheckpoint数と使用モデル](15d2bebe.md) | 未 | - |
| F4 | [commit pickerにdiffプレビュー](18d2c377.md) | 未 | - |
| F5 | [UI文言の英語化（日本語直書きの解消）](17d2c1e4.md) | 未 | - |
| F6 | [整理結果の履歴と `/autocommit-log`](1ad2c69d.md) | 未 | - |

## G. 設定の階層・チーム運用（4件 / 判断済み 0）

| コード | 項目 | 判断 | 決定 |
|---|---|---|---|
| G1 | [グローバル設定 + プロジェクト上書き](0fd076b5.md) | 未 | - |
| G2 | [`PI_AUTOCOMMIT_*` 環境変数オーバーライド](0cd071fc.md) | 未 | - |
| G3 | [`.pi/pi-autocommit.local.json`（個人設定）](0dd0738f.md) | 未 | - |
| G4 | [monorepoのscope自動導出（workspaces）](0ad06ed6.md) | 未 | - |

## H. コスト・品質（4件 / 判断済み 0）

| コード | 項目 | 判断 | 決定 |
|---|---|---|---|
| H1 | [`mergeSimilarPrevious` の二重LLM呼び出しを1回に](8feb83b2.md) | 未 | - |
| H2 | [docs/testのみの変更はLLMスキップ](8eeb821f.md) | 未 | - |
| H3 | [`minDiffChars` で小さい差分はLLMスキップ](8deb808c.md) | 未 | - |
| H4 | [`splitModel` 分割用とメッセージ用で別モデル](8ceb7ef9.md) | 未 | - |

## I. pi-autocommitを使わない／他ツール併用（5件 / 判断済み 0）

| コード | 項目 | 判断 | 決定 |
|---|---|---|---|
| I1 | [`fixup` モード（`git commit --fixup` + autosquash）](8be93ecf.md) | 未 | - |
| I2 | [stashベースの代替パイプライン（HEADを書き換えない）](8ce94062.md) | 未 | - |
| I3 | [ガードのallowlist（外部ツール併用）](8de941f5.md) | 未 | - |
| I4 | [commitlint連携（整理コミットだけlint）](86e936f0.md) | 未 | - |
| I5 | [jj (jujutsu) サポート](87e93883.md) | 未 | - |

## 決定ログ

採用が決まった項目をここに追記する（子TODOの理由を1行で要約）。

- （まだ無し）
