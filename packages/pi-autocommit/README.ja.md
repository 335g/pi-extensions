# @335g/pi-autocommit

[![npm version](https://img.shields.io/npm/v/@335g/pi-autocommit.svg)](https://www.npmjs.com/package/@335g/pi-autocommit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) の拡張機能です。
ユーザがコミットメッセージを書かなくて済むように、変更を自動でコミットします。
**checkpoint-then-reorganise** 戦略を採用しており、ファイルを変更する各ターンの終わりに軽量な checkpoint コミットを作成し、エージェントループ終了時にそれらを soft reset して LLM が論理的な [Conventional Commits](https://www.conventionalcommits.org/) に再構成します。

> **`@335g/pi-git` から移行した方へ**：下記の [移行ガイド](#335gpi-git-からの移行) を参照してください。`/git-commit` と `/git-status` コマンドは削除され、自動コミットのみが機能となりました。

## 特徴

- **自動チェックポイント** — ファイルを変更するターン終了ごとにコミットを作成するため、途中経過が失われることはありません。
- **LLM による再構成** — エージェントループ終了時に checkpoint を soft reset し、アシスタント自身の推論をコンテキストとして論理的な Conventional Commits に分割します。
- **ヒューリスティックフォールバック** — LLM が利用できない場合は差分解析から単一の Conventional Commit を生成します。
- **対話的な範囲選択** — `organiseMode: "picker"` にすると `agent_end` がコミットピッカーで止まり、どれを整理するかを拡張機能ではなく自分で選べます。
- **コミット分割の編集** — `organiseMode: "review"` はさらに一歩進み、コミット前に提案された分割そのものを編集できます。ファイルを別のコミットへ移す、コミット対象から外す、各メッセージを pi のエディタで書き換える、がいずれもコミット前に済みます。
- **未コミット変更のフッター表示** — ワーキングツリーに変更があるかをフッターに表示し、checkpoint に取り込まれる前に意図しないファイルに気づけるようにします。隣には現在の整理モードも表示されます。
- **言語対応** — コミットメッセージを会話の言語に自動追従（文字種で判定: 英語・日本語・韓国語・中国語・ロシア語）。`lang` で固定言語も指定可能。
- **マージコンフリクト検出** — マージ競合中はコミットをスキップします。

## インストール

```bash
pi install @335g/pi-autocommit
```

または pi のパッケージ設定に追加:

```json
{
  "packages": {
    "@335g/pi-autocommit": "latest"
  }
}
```

## 仕組み

自動コミットは**デフォルトでは無効**です。`.pi/pi-autocommit.json` で `"enable": true` を設定するか `/autocommit-enable true` を実行すると有効化されます。

`enable` はセッション開始時に一度だけ読み込まれ、そのセッションの間はメモリ上の値が使われます。`/autocommit-enable` はファイルにも書き込む（新しいセッションはその値で開始する）ものの、すでに動いている他のセッションの状態は変えません。調査だけしたいセッションと編集するセッションを同時に動かすときに使えます。

有効化されると、拡張機能は次を行います。

1. **`turn_end`** — ファイルを変更するツール（`write`, `edit`, `bash`）を実行したターンの終了後、ワーキングツリーに変更があればすべてステージ（`git add -A`）し、checkpoint コミットを作成します:
   ```
   wip(checkpoint): auto-commit at turn N
   ```
2. **区切りのタイミング** — ひとまとまりの作業が終わる 2 つの時点で、未整理のチェックポイントを整理します: ユーザーが新しい指示を送ったとき（`input` イベント。実行中にキューされた追加指示も含む）と `agent_end`。soft reset → LLM で論理的な Conventional Commits に分割 → グループごとにコミット。追加指示でループが長引いても、タスクごとに整理されるので全タスク分が 1 つの巨大な差分になりません。実行中の軌道修正（`streamingBehavior: "steer"`）では発動しません（修正をすぐモデルに届けるため）。`organiseMode: "picker"` では `agent_end` の整理がコミットピッカーで止まり、`"review"` では加えてファイルの分割を編集させ各メッセージを確定前に確認させます。この 2 つのモードでは途中のポップアップを避けるため、実行中の整理は行いません。

境界が一度も来ない実行（1 つの長いプロンプト、push なし、追加指示なし）も分割します: 未整理が 10 件に達するたびに `turn_end` で整理するため、40 ターンの実行は 1 つの巨大な差分ではなく 4 つのまとまったバッチになります。

### タスク境界

1 つのプロンプトで複数の作業を頼むことがあります（「X を追加、Y を修正、docs を更新」）。エージェントはその間で止まりません。1 項目目が終わったという証拠はエージェント自身のターンだけなので、`detectTaskBoundary` は毎 `turn_end` で短い分類呼び出しを行います: ユーザーの依頼、そのターンのテキスト、そのターンで変更したファイル。依頼のまとまった 1 項目を終えた（番号付き項目を終えた場合を含む）なら `BOUNDARY`、同じ項目をまだ実装・デバッグ・調査中なら `CONTINUE` と答えます。

`BOUNDARY` のときは未整理チェックポイントをその場で整理するため、3 項目のプロンプトは 1 つのバッチではなく 3 つのバッチになります。呼び出しは意図的に小さく（出力は 1 単語、入力は数千文字、モデルはコミットメッセージ用を共用）、失敗や解釈不能な応答は `CONTINUE` として扱うので、分類が壊れても勝手に履歴を分割しません。`detectTaskBoundary: false` で無効化できます。

フッター表示（`[has changes]`）は未コミット変更の有無を知らせます。次のプロンプトを書く前に確認すれば、意図しないファイルの混入に気づけます。自動コミットが有効な間、フッターには整理モード（`[auto]` / `[picker]`）も併せて表示されます。

有効な間、ガードがブロックするのは `bash` ツールからの 2 操作だけです: コミットコマンド（`--amend` 含む）と `git reset --hard`。コミットは checkpoint の列に別のコミットを割り込ませるため、`reset --hard` はインデックスとワーキングツリー（直前の checkpoint 以降の変更を含む）を破棄するためです。それ以外 — **merge・cherry-pick・rebase・add・stash・fetch** — はすべて許可され、エージェントはワークツリーブランチを統合したりできます。

**push は先に整理してから通します。** 未整理の checkpoint がある状態でエージェントが push を実行すると、pi-autocommit はそれを一旦止め、Conventional Commits に整理してから同じ push を通します。リモートに `wip(checkpoint)` が届くことはありません。`picker` / `review` モードのとき、または整理に失敗したときは push をブロックして案内します（これらのモードは `agent_end` で人が決める前提で、実行中には判断できないため）。

push 済みの履歴は反対側でも守ります。整理は upstream 先端以前のコミットを書き換えません。別端末からの push などで checkpoint の列が upstream 先端をまたいでいる場合、未 push の部分だけを整理し、取り残した push 済み checkpoint の件数を通知します。それらは `wip(checkpoint)` として履歴に残ります。

merge・cherry-pick・rebase で checkpoint の列の上に別のコミットが乗ると、その checkpoint は自動整理の対象外になります（`countCheckpointCommits` が別コミットで止まるため）。`/autocommit-organise <sessionId>` で整理し直せます。branch tip に未整理 checkpoint が残りうるワークツリーブランチの統合には、引き続き `git merge --squash` が最も安全です。

もしマージで他セッションの未整理 checkpoint を取り込んでしまった場合（相手エージェントのクラッシュなど）は `session_start` と `agent_end` の両方で警告されます — 変更自体はツリーに入っていますが `wip(checkpoint)` が履歴に残るため、次回は `--squash` で統合してください。取り込まれた checkpoint には由来のワークツリーブランチが `Checkpoint-Branch` trailer として記録され、コミットピッカーや `/autocommit-organise` のセッション補完にも表示されるので、どの委譲ブランチ由来か判別できます。

ブロック理由は設定されたコミットメッセージ言語（日本語設定時は日本語、それ以外は英語）で表示され、`/autocommit-enable false` で解除できる旨も含まれます。無効な間は、エージェントは自由に git を操作できます。

デフォルトではバックグラウンドで動作し、進捗やエラーは UI に通知されますが、対話的な確認は不要です。`organiseMode` が `"picker"` のときだけ `agent_end` で確認が入ります。

## 設定

プロジェクトルートに `.pi/pi-autocommit.json` を作成:

```json
{
  "lang": "ja",
  "enable": true,
  "model": "anthropic/claude-sonnet-4"
}
```

| キー | 型 | デフォルト | 説明 |
|-----|------|---------|-------------|
| `lang` | string | `"auto"` | コミットメッセージの言語。`"auto"`（デフォルト）は会話から判定（文字種で日本語・韓国語・中国語・ロシア語を検出。ラテン文字の会話は英語にフォールバック）。その他の値 — コード（`"ja"`、`"ko"`）または任意の言語名（`"Korean"`、`"한국어"`）— で言語を固定 |
| `enable` | boolean | `false` | 自動コミットを有効にするか |
| `model` | string | — | コミットメッセージ生成に使用する LLM モデルを `"provider/modelId"` 形式で指定（例: `"anthropic/claude-sonnet-4"`）。省略時はセッションの現在のモデルを使用 |
| `scope` | object | — | パスから scope へのマッピング。Conventional Commits の scope を決定論的に固定します。設定すると LLM は scope を推論せず、変更ファイルパスから解決されます。下記の [スコープマッピング](#スコープマッピング) を参照 |
| `ignoreSubmodules` | boolean | `false` | submodule 関連の親リポジトリ側の差分（gitlink 更新（mode 160000 エントリ。吸収された埋め込みリポジトリを含む）と `.gitmodules`）を自動コミットの対象外にします。checkpoint コミットも再編成もこれらのパスを記録しないため、ピン更新はユーザーの手動コミットに委ねられます。孤児コミット検出はセッション開始時の案内表示として継続します。下記の [Submodule](#submodule) を参照 |
| `organiseMode` | string | `"auto"` | `agent_end` でどれだけ制御を渡すか。`"auto"` は無対話に整理し、`"picker"` は先にコミットピッカーを表示して範囲を手で選ばせ、`"review"` はさらにファイルの分割を編集させ、各コミットメッセージを確定前に確認させます。`/autocommit-mode` で切り替えでき、現在のモードはフッターに出ます。下記の [整理モード](#整理モード) を参照 |
| `mergeSimilarPrevious` | boolean | `true` | チェックポイント整理時、その直下の「直前コミット群」（committer 時刻が 10 秒以内で連続する一連のコミット）のいずれかが「ほぼ同じファイルに触れている」（Jaccard 係数 ≥ 0.5）かつ「同じ Conventional Commit の type/scope」のとき、その群ごと巻き込んで再度まとめ直します。push 済みの群は書き換えず、通知のみ行います。下記の [類似コミット群への統合](#類似コミット群への統合) を参照 |
| `detectTaskBoundary` | boolean | `true` | 毎 `turn_end` で短いモデル呼び出しを行い、そのターンが依頼の 1 項目を完了した（`BOUNDARY`）か、まだ途中（`CONTINUE`）かを判定します。`BOUNDARY` ならその場で未整理チェックポイントを整理するため、3 つ頼んだプロンプトは 3 つのバッチになります。ファイルを変更したターンごとに 1 回の小さな呼び出しで、`organiseMode: "auto"` のときのみ動作します。`false` にすると、ユーザー指示・push・`agent_end`・10 件バックストップだけになります。下記の [タスク境界](#タスク境界) を参照 |

`lang` の解決優先度: 設定値がある場合はそれが最優先（固定言語は検出より優先）、なければ会話のユーザーメッセージから自動判定、それもできなければ英語。自動判定は文字種を検査します。ヒューリスティックフォールバック（LLM が利用できない場合）は日本語または英語のみで生成します。

### 整理モード

`organiseMode` は checkpoint を整理するときに渡す制御の量を決めます。

| モード | `agent_end` の挙動 |
|------|----------------------|
| `auto`（デフォルト） | checkpoint の列を無対話に整理します。`mergeSimilarPrevious` が有効なら、直前コミット群が似ているときに範囲を自動で下へ広げます。 |
| `picker` | 先にコミットピッカーを表示します。既定の範囲は HEAD の checkpoint 列で、`1` / `2` で広げて以前のコミットも巻き込めます。`Esc` でキャンセルすると checkpoint は履歴に残り、`/autocommit-organise` で後から整理できます。 |
| `review` | ピッカーのあと、提案された全コミットを一度に示し、分割を編集するかを問うダイアログを出します。編集するなら下記の**分割エディタ**が開き、しないならコミットごとの確認に進みます。コミットごとの確認では、確定すればそのメッセージでコミットし、拒否すると pi の複数行エディタで書き換えられます。いずれのエディタをキャンセルしても整理全体を中止し、コミットは作らず変更は staged のまま残します。 |

#### 分割エディタ

ゲートで編集を選ぶと、提案全体をテキストで示すエディタが開きます。

```
## feat(organiser): 分割の編集を追加
src/group-review.ts
src/reorganiser-helpers.ts

## test(organiser): 分割編集のテスト
src/group-review.test.ts
```

- **ファイル行を別の「`## `」の下へ移す** — そのファイルは移し先のコミットに入ります。
- **ファイル行を削除する** — そのファイルはコミットされず未コミットのまま残ります。外したパスはあとから通知に一覧されます。
- **「`## `」行を書き換える** — そのコミットの subject を書き換えます。ファイルがなくなったブロックはコミットごと削除されます。
- **「`## `」行を追加する** — ファイルを新しいコミットに分けます。

何も変えずに保存すれば提案どおりにコミットされます。ステージされていないパス、二つのコミットに割り当てられたパス、見出しより前にあるファイル行はいずれも拒否され、理由を先頭に付けたエディタが開き直します。書き間違えた分割がコミットされることはありません。body は subject を変えなかったコミットだけ引き継がれます。続くコミットごとの確認で、どのメッセージも書き換えられます。

モードは階段です。それぞれ一段階ずつ対話を増やし、前の段の挙動を置き換えません。

いつでも切り替えられます。設定は `.pi/pi-autocommit.json` に保存され、フッター表示もすぐ更新されます。

```
/autocommit-mode picker    # agent_end で範囲を選ぶ
/autocommit-mode review    # …加えて分割とコミットメッセージも編集する
/autocommit-mode auto      # 無対話に整理する
/autocommit-mode           # 次のモードへ巡回
```

`/autocommit-organise` はモードに関係なく常にピッカーを表示します（明示的に実行した操作だからです）。

### 自動コミットを無効化する

```json
{
  "enable": false
}
```

git リポジトリ外では設定に関わらず何もしません。

### スコープマッピング

デフォルトでは、コミットの scope は LLM が変更ファイルパスから推論します。機能開発中やサブプロジェクトが特定ディレクトリ以下にある場合など、scope を固定したい時は `scope` にパス→scope のマッピングを設定します:

```json
{
  "scope": {
    "packages/frontend/**": "frontend",
    "packages/backend/**": "backend",
    "**": "app"
  }
}
```

キーは [picomatch](https://github.com/micromatch/picomatch) の glob で、変更ファイルパスに対して評価されます。1コミット内の全ファイルが **同じ scope** に解決された時その scope が採用され、**異なる scope** に解決された時（またはどれにもマッチしない時）は scope が省略されます（`type: subject`）。複数マッチした時は最も具体的な（リテラルが長い）glob が優先されます。

`scope` を設定すると LLM には `type: subject`（scope なし）で書くよう指示し、scope は決定論モジュールが注入します — これにより scope がブレることがありません。`scope` 未設定時は従来通り LLM が推論する挙動が維持されます。

`**` glob を使えば、リポジトリ全体を単一の scope に固定できます:

```json
{ "scope": { "**": "auth" } }
```

### Submodule

デフォルト（手動 submodule モード）では、pi-autocommit が submodule 内部でコミットすることはありません。ユーザーが submodule 内でコミットし、親リポジトリは結果として生じる gitlink 更新を他の変更ファイルと同様に記録します。到達不能な孤児コミットに対しては警告が出ます。

submodule のピン更新を pi-autocommit に一切任せたくないワークフローでは、次を有効にしてください:

```json
{ "ignoreSubmodules": true }
```

checkpoint コミットも再編成も gitlink 更新や `.gitmodules` の変更を記録しなくなります — submodule 側でコミットが積まれても、親リポジトリには自動コミットが作られません。ピンの乖離はフッターインジケータに未コミット変更として表示され続けるので、ピンを進めたいときに手動でコミットしてください。孤児コミットの検出はセッション開始時の案内表示として継続します。

### 類似コミット群への統合

`agent_end` の整理時、チェックポイント列の直下にあるコミット群（committer 時刻が 10 秒以内で連続する範囲。1回の `agent_end` が複数コミットに整理した結果を想定）を調べ、どれか1つが次の条件をすべて満たすと、チェックポイントとそのコミット群をまとめて `reset --soft` し、結合した差分を再度 LLM に投入して整理し直します:

1. 変更ファイル集合が、チェックポイント側の整理結果（LLM が提案したグループ）と大きく重なっている — Jaccard 係数（共通 ÷ 和集合）が `0.5` 以上。カバー対象のファイルの隣にテストファイルが1つ増えた程度なら統合され、無関係な変更は統合されません
2. そのグループの `type(scope)` が一致する（どちらかに scope がなければ type のみで判定）
3. コミット群のいずれも未 push（upstream 上に存在しない）

`--amend` ではなく再度まとめ直すのは、結合後の差分に対して適切なコミットメッセージが元のどちらとも異なりうるためです。たとえば前回の整理で `feat(cli)` と `test(cli)` ができており、今回のエージェント実行が同じファイルを変更した場合、それらは現在の差分に合わせて再分割・再生成されます。

条件3を満たさない場合 — 対象コミット群が既に push 済みの場合 — は履歴を書き換えず、チェックポイントのみを通常どおり整理し、統合しなかった旨を通知します。

この挙動を無効化するには:

```json
{ "mergeSimilarPrevious": false }
```

## コミットメッセージ規約

生成されるメッセージは [Conventional Commits](https://www.conventionalcommits.org/) 仕様に従います:

```
type(scope): subject

body

footer
```

### タイプ一覧

| タイプ      | 説明                               |
|------------|-----------------------------------|
| `feat`     | 新機能、コマンド、オプション、API     |
| `fix`      | バグ修正、意図しない動作の修正        |
| `refactor` | 振る舞いを変えないコード構造の改善     |
| `chore`    | ビルド設定、依存関係、CI、リポジトリ設定 |
| `docs`     | ドキュメントのみの変更               |
| `test`     | テストの追加・修正                   |
| `style`    | コードフォーマット（振る舞いに影響なし）|
| `perf`     | パフォーマンス改善                   |

## `@335g/pi-git` からの移行

`@335g/pi-git` は `@335g/pi-autocommit` にリネームされ、スコープを自動コミットに絞りました。

- `/git-commit` と `/git-status` コマンドは**削除されました**。手動操作には pi の `!git commit` / `!git status` を使用してください。
- 設定ファイルは `.pi/pi-git.json` から **`.pi/pi-autocommit.json`** に移動しました。古いファイルは**読み込まれません**。
- `commitEveryTurn` は **`enable`** にリネームされ、デフォルトは **`true`** になりました（autocommit パッケージを入れて何も起きないのは不自然だからです）。
- `noBody` は削除されました。コミットメッセージは常にボディを含みます。

移行手順:

```bash
pi uninstall @335g/pi-git
pi install @335g/pi-autocommit
```

設定ファイルをリネームし、キーを調整してください:

```json
// .pi/pi-autocommit.json
{
  "lang": "ja",
  "enable": true
}
```

旧 `@335g/pi-git` パッケージは npm で `deprecated` 扱いになりますが、インストール自体は可能です。

## 開発

```bash
# 依存関係のインストール
npm install

# ビルド
npm run build

# テスト実行
npm test
```

## 必要条件

- [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)（ピア依存関係）
- [pi-ai](https://github.com/earendil-works/pi-ai)（ピア依存関係）
- [pi-tui](https://github.com/earendil-works/pi-tui)（オプションのピア依存関係 – フッターステータス表示を有効化）


## ライセンス

MIT © Yoshiki Kudo
