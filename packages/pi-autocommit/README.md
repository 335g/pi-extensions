# @335g/pi-autocommit

[![npm version](https://img.shields.io/npm/v/@335g/pi-autocommit.svg)](https://www.npmjs.com/package/@335g/pi-autocommit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension that automatically commits your changes so you never have to write a commit message. It uses a **checkpoint-then-reorganise** strategy: lightweight checkpoint commits are created at the end of each turn that mutates files, then at the end of the agent loop they are soft-reset and reorganised into logical [Conventional Commits](https://www.conventionalcommits.org/) by the LLM.

> **Migrated from `@335g/pi-git`?** See [Migration](#migration-from-335gpi-git) below. The `/git-commit` and `/git-status` commands were removed; auto-commit is now the sole feature.

## Features

- **Automatic checkpoints** — commits changes at the end of every turn that mutates files, so intermediate state is never lost.
- **LLM-powered reorganisation** — checkpoints are soft-reset and split into coherent Conventional Commits at each task boundary (a new instruction, a push, `agent_end`), using the assistant's own reasoning as context.
- **Heuristic fallback** — when the LLM is unavailable, a single Conventional Commit is produced from diff analysis.
- **Interactive range selection** — `organiseMode: "picker"` stops `agent_end` on the commit picker so you choose which commits get reorganised, instead of the extension deciding.
- **Commit review** — `organiseMode: "review"` goes one step further and lets you edit the proposed split before anything is written: move files between commits, drop a file out of the commit set, and rewrite each message in pi's editor.
- **Uncommitted-changes footer indicator** — a footer cue shows whether the working tree has changes, so you can spot unintended files *before* a checkpoint captures them. The active organise mode sits next to it.
- **Non-ASCII path support** — staged paths are read with `core.quotePath=false`, so Japanese or Chinese filenames match the proposed commit groups instead of tripping the coverage guard into a single fallback commit.
- **Language support** — commit messages follow the conversation's language automatically (English, Japanese, Korean, Chinese, Russian by script), or a fixed language of your choice via `lang`.
- **Merge conflict detection** — skips committing when a merge is in progress.

## Installation

```bash
pi install @335g/pi-autocommit
```

Or add it to your pi package config:

```json
{
  "packages": {
    "@335g/pi-autocommit": "latest"
  }
}
```

## Slash commands

| Command | Action |
|---|---|
| `/autocommit-enable [true\|false]` | Toggle auto-commit. No argument shows the current state. |
| `/autocommit-mode [auto\|picker\|review]` | Set the `agent_end` organise mode. No argument cycles to the next mode. |
| `/autocommit-model [provider/modelId \| clear]` | Set the LLM model for commit messages. No argument opens a selector popup; `clear` falls back to the session model. |
| `/autocommit-organise [sessionId]` | Reorganise checkpoint commits. No argument shows the commit picker; a session id reorganises only that session's checkpoints. |

## How it works

Auto-commit is **disabled by default**. Enable it by setting `"enable": true` in `.pi/pi-autocommit.json` or running `/autocommit-enable true`; the extension then:

The `enable` value is read once at session start and kept in memory for that session. `/autocommit-enable` still writes the file (so new sessions pick it up), but it does not change sessions that are already running — useful when one session should only investigate while another is editing.

1. **`turn_end`** — After each turn that ran a file-mutating tool (`write`, `edit`, `bash`), if the working tree has changes, it stages everything (`git add -A`) and creates a checkpoint commit:
   ```
   wip(checkpoint): auto-commit at turn N
   ```
2. **Task boundaries** — At the two points where a unit of work ends, the pending checkpoint run is reorganised: when the user sends a new instruction (the `input` event, including a follow-up queued while the agent is still running) and at `agent_end`. Soft-reset, LLM split into logical Conventional Commits, one commit per group. A loop kept alive by follow-ups therefore reorganises per task instead of accumulating one change set across all of them. Mid-flight steering (`streamingBehavior: "steer"`) is skipped so the correction lands immediately. With `organiseMode: "picker"` the `agent_end` pass stops on the commit picker first, and `"review"` additionally lets you edit the file partition and confirm each proposed commit message; both modes skip the mid-run passes so no popup opens inside a run.

A run that never reaches a boundary — one long prompt, no push, no follow-up — is still split: every 10 pending checkpoints the run is reorganised at `turn_end`, so a 40-turn run produces four coherent batches instead of one change set too large to split.

### Task boundaries

A single prompt can ask for several things ("add X, fix Y, update the docs"), and the agent never stops between them. The one piece of evidence that item one is finished is the agent's own turn, so `detectTaskBoundary` sends a short classification call at every `turn_end`: the user's request, the turn's text, and the files that turn changed. It answers `BOUNDARY` when the turn finished a self-contained piece of the request (a finished numbered item counts) and `CONTINUE` when it is still implementing, debugging or exploring the same piece.

On `BOUNDARY` the pending checkpoint run is reorganised immediately, so the three-item prompt produces three batches instead of one. The call is deliberately cheap — one word out, a few thousand characters in, using the commit-message model — and a failure or an unparseable answer means `CONTINUE`, so a broken classifier never splits history by itself. Set `detectTaskBoundary: false` to turn it off.

The footer indicator (`[has changes]`) reminds you when there are uncommitted changes — check it before writing your next prompt to catch unintended files. The footer also shows the active organise mode (`[auto]` / `[picker]`) while auto-commit is enabled.

While enabled, the guard blocks exactly two agent-initiated commands in the `bash` tool: the commit command (including `--amend`) and `git reset --hard`. A commit would interleave a foreign commit into the checkpoint run; `reset --hard` would destroy the index and working tree, including changes the current turn made after the last checkpoint. Everything else — **merge, cherry-pick, rebase, add, stash, fetch** — is allowed, so an agent can integrate a worktree branch.

**A push reorganises first, then goes through.** When the agent runs a push while checkpoint commits are pending, pi-autocommit pauses it, reorganises the run into Conventional Commits, and then lets the same push proceed — the remote never receives `wip(checkpoint)` history. In `picker`/`review` mode (or if the reorganisation fails) the push is blocked with a message instead, because those modes decide at `agent_end` and cannot decide inside a run.

Pushed history is protected on the other side too: a reorganisation never rewrites commits at or below the upstream tip. If a checkpoint run somehow extends past it (a push from another terminal), only the un-pushed part is reorganised, a notice reports how many pushed checkpoints were left alone, and those stay in history as `wip(checkpoint)`.

If a merge, cherry-pick or rebase puts a foreign commit on top of the checkpoint run, those checkpoints are no longer reorganised automatically — `countCheckpointCommits` stops at the foreign commit. Recover them with `/autocommit-organise <sessionId>`. `git merge --squash` remains the cleanest way to integrate a worktree branch whose tip may hold un-reorganised checkpoints.

If a merge does pull in un-reorganised checkpoint commits from another session (the other agent crashed), both `session_start` and `agent_end` report them — the changes are already in the tree, but the `wip(checkpoint)` entries stay in history, so re-integrate with `--squash` next time. The reported checkpoints carry the origin worktree branch (`Checkpoint-Branch` trailer), which is also shown in the commit picker and the `/autocommit-organise` session completions so you can tell which delegated branch each checkpoint came from.

The block reason follows the configured commit-message language (Japanese when `lang` is Japanese, otherwise English) and notes that the guard can be disabled with `/autocommit-enable false`. When disabled, the agent is free to use git on its own.

This runs silently in the background by default. Notifications appear for progress and errors, and no interactive confirmation is required unless `organiseMode` is `"picker"`.

## Configuration

Create `.pi/pi-autocommit.json` in your project root:

```json
{
  "lang": "ja",
  "enable": true,
  "model": "anthropic/claude-sonnet-4"
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `lang` | string | `"auto"` | Commit message language. `"auto"` (default) detects it from the conversation (Japanese, Korean, Chinese, Russian by script); Latin-script conversations fall back to English. Any other value — a code (`"ja"`, `"ko"`) or a language name in any language (`"Korean"`, `"한국어"`) — fixes that language |
| `enable` | boolean | `false` | Whether auto-commit is active |
| `model` | string | — | LLM model for commit message generation, in `"provider/modelId"` format (e.g. `"anthropic/claude-sonnet-4"`). When omitted, the session's current model is used. |
| `scope` | object | — | Path-to-scope mapping that fixes the Conventional Commits scope deterministically. When set, the LLM no longer infers the scope; it is resolved from the changed file paths instead. See [Scope mapping](#scope-mapping) below. |
| `ignoreSubmodules` | boolean | `false` | Keep submodule-related parent-side changes out of auto-commits: gitlink updates (mode 160000 index entries, including absorbed embedded repositories) and `.gitmodules`. Checkpoint commits and the reorganiser never record these paths, so pin updates are left to you. Detached-orphan detection stays active as an informational notice at session start. See [Submodules](#submodules) below. |
| `organiseMode` | string | `"auto"` | How much control `agent_end` gives you: `"auto"` reorganises silently, `"picker"` shows the commit picker first so you choose the range, `"review"` also lets you edit the split and confirms every proposed commit message. Switch it with `/autocommit-mode`; the active mode is shown in the footer. See [Organise mode](#organise-mode) below. |
| `mergeSimilarPrevious` | boolean | `true` | When reorganisation finds a commit in the group directly below the checkpoint run (contiguous commits no more than 10 seconds apart in committer time) that mostly touches the same files (Jaccard overlap ≥ 0.5) with the same Conventional Commit `type`/`scope`, the checkpoint run and that whole group are re-consolidated together. Pushed groups are never rewritten; a notice is shown instead. See [Merging into a similar previous commit group](#merging-into-a-similar-previous-commit-group) below. |
| `detectTaskBoundary` | boolean | `true` | Whether a short model call decides, at every `turn_end`, that the turn just ended completed one piece of the request (`BOUNDARY`) or is still mid-task (`CONTINUE`). On `BOUNDARY` the pending checkpoints are reorganised at once, so a prompt asking for three things produces three commit batches. Costs one small call per mutating turn and only runs in `organiseMode: "auto"`. Set `false` to fall back to user instructions, pushes, `agent_end` and the 10-checkpoint backstop. See [Task boundaries](#task-boundaries) below. |

The `lang` resolution priority: the configured value when set (a fixed language wins over detection), else auto-detection from the conversation's user messages, else English. Auto-detection inspects character scripts; the heuristic fallback (used when the LLM is unavailable) only writes Japanese or English.

### Organise mode

`organiseMode` decides how much control you get when checkpoints are reorganised:

| Mode | `agent_end` behaviour |
|------|----------------------|
| `auto` (default) | Reorganises the checkpoint run silently. `mergeSimilarPrevious` extends the range downward on its own when the previous commit group is similar. |
| `picker` | Shows the commit picker first. The default range is the checkpoint run at HEAD; extend it with `1` / `2` to pull in earlier commits. `Esc` cancels and leaves the checkpoints for `/autocommit-organise`. |
| `review` | The picker, then a gate that lists every proposed commit at once and asks whether to edit the split. Yes opens the **partition editor** below; no goes straight to one dialog per proposed commit, where confirming keeps the message and rejecting rewrites it in pi's multi-line editor. Cancelling any editor aborts the whole reorganisation: nothing is committed and the changes stay staged. |

#### Partition editor

Answering yes at the gate opens an editor buffer holding the whole proposal as text:

```
## feat(organiser): 分割の編集を追加
src/group-review.ts
src/reorganiser-helpers.ts

## test(organiser): 分割編集のテスト
src/group-review.test.ts
```

- **Move a file line under another `## ` header** — the file goes into that commit instead.
- **Delete a file line** — that file is left out of the commits and stays uncommitted; the dropped paths are named in a notice afterwards.
- **Edit a `## ` header** — rewrites that commit's subject. A header left with no files deletes the commit.
- **Add a `## ` header** — splits files into a new commit.

Saving the buffer untouched commits the proposal as-is. A path that was never staged, a path claimed by two commits, or a file line above any header is rejected and the editor re-opens with the reason at the top, so a typo cannot commit a split you did not write. Bodies are kept for headers whose subject is unchanged; the per-commit dialog that follows can still rewrite any message.

The modes are a ladder — each one adds a step rather than replacing one.

Switch it at any time — the setting is persisted to `.pi/pi-autocommit.json` and the footer updates immediately:

```
/autocommit-mode picker    # choose the range at agent_end
/autocommit-mode review    # …and edit the split and messages first
/autocommit-mode auto      # reorganise silently
/autocommit-mode           # cycle to the next mode
```

`/autocommit-organise` always shows the picker, whatever the mode is — you asked for it explicitly.

### Disabling auto-commit

```json
{
  "enable": false
}
```

Outside a git repository, the extension does nothing regardless of config.

### Scope mapping

By default, the commit scope is inferred by the LLM from the changed file paths. When you want the scope to stay fixed — for example, while working on a feature, or when a sub-project lives under a specific directory — set `scope` to a path-to-scope mapping:

```json
{
  "scope": {
    "packages/frontend/**": "frontend",
    "packages/backend/**": "backend",
    "**": "app"
  }
}
```

Keys are [picomatch](https://github.com/micromatch/picomatch) globs evaluated against the changed file paths. When a commit touches files that all resolve to the **same** scope, that scope is used; if files resolve to **different** scopes (or none match), the scope is omitted (`type: subject`). The most specific (longest literal) glob wins on conflict.

Once `scope` is set, the LLM is instructed to write `type: subject` (no scope) and the scope is injected deterministically — so the scope never drifts. When `scope` is unset, the previous LLM-driven behaviour is preserved.

The `**` glob is a handy way to set a single fixed scope for the whole repo:

```json
{ "scope": { "**": "auth" } }
```

### Submodules

By default (manual submodule mode), pi-autocommit never commits inside a submodule. The user commits there; the parent records the resulting gitlink update like any other changed file, and detached-orphan submodule commits are warned about.

When your workflow keeps submodule pin updates out of pi-autocommit's hands entirely, enable:

```json
{ "ignoreSubmodules": true }
```

Checkpoint commits and reorganisation then never record gitlink updates or `.gitmodules` changes — commits piling up inside a submodule produce no parent-side auto-commits. The pin drift stays visible as an uncommitted change in the footer indicator; commit it manually when you want to move the pin. Detection of detached-orphan submodule commits stays active, shown as an informational notice at session start.

### Merging into a similar previous commit group

At `agent_end`, the commits directly below the checkpoint run form a *previous commit group*: contiguous commits no more than 10 seconds apart in committer time, which is how the multiple logical commits one `agent_end` produced appear. When any member of that group satisfies all of the following, the checkpoint run and the whole group are soft-reset together and the combined diff is fed to the reorganiser again:

1. Its changed-file set mostly overlaps a group proposed for the checkpoint run — Jaccard similarity (`shared ÷ union`) of at least `0.5`, so one extra file next to the files it covers still merges while an unrelated change does not.
2. Its `type(scope)` matches that group's (a missing scope on either side degrades to a type-only match).
3. No member of the group is pushed (none exists on the upstream branch).

This re-consolidates rather than amending, because the right message for the combined diff can differ from either side's. So when the previous reorganisation produced `feat(cli)` and `test(cli)` and the current agent run touches the same files, they are re-split with the current changes.

When condition 3 fails — the group is already on the remote — history is left untouched: only the checkpoint commits are reorganised as usual and a notice reports that no merge happened.

To disable the behaviour:

```json
{ "mergeSimilarPrevious": false }
```

## Commit Message Convention

Generated messages follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
type(scope): subject

body

footer
```

### Types

| Type       | Description                                         |
|------------|-----------------------------------------------------|
| `feat`     | New feature, command, option, or API                |
| `fix`      | Bug fix or correction of unintended behavior        |
| `refactor` | Code structure improvement without behavior change  |
| `chore`    | Build config, dependencies, CI, repository setup    |
| `docs`     | Documentation-only changes                          |
| `test`     | Adding or modifying tests                           |
| `style`    | Code formatting (no behavioral impact)              |
| `perf`     | Performance improvements                            |

## Migration from `@335g/pi-git`

`@335g/pi-git` has been renamed and narrowed in scope to become `@335g/pi-autocommit`:

- The `/git-commit` and `/git-status` commands **were removed**. Use `!git commit` / `!git status` in pi for manual operations.
- The config file moved from `.pi/pi-git.json` to **`.pi/pi-autocommit.json`**. The old file is **not** read.
- `commitEveryTurn` was renamed to **`enable`** and now defaults to **`true`** (installing an autocommit package and getting nothing would be surprising).
- `noBody` was removed — commit messages now always include a body.

To migrate:

```bash
pi uninstall @335g/pi-git
pi install @335g/pi-autocommit
```

Then rename your config and adjust keys:

```json
// .pi/pi-autocommit.json
{
  "lang": "ja",
  "enable": true
}
```

The old `@335g/pi-git` package is marked `deprecated` on npm but remains installable.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

## Requirements

- [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) (peer dependency)
- [pi-ai](https://github.com/earendil-works/pi-ai) (peer dependency)
- [pi-tui](https://github.com/earendil-works/pi-tui) (optional peer dependency — enables the footer status indicator)


## License

MIT © Yoshiki Kudo
