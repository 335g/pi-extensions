# Interactive range-based reorganiser via commit picker popup

A TUI popup that lets the user select an arbitrary range of recent commits
(checkpoint and non-checkpoint alike) to squash into logical Conventional
Commits. The popup is available on demand via `/autocommit-organise`.

At `agent_end`, reorganisation now runs **automatically** on checkpoint
commits only — no interactive popup.

## Motivation

The original checkpoint-then-reorganise strategy assumes that only
checkpoint commits (`wip(checkpoint):`) sit at the top of HEAD, and that
reorganisation can always be a fully automatic `reset --soft` of a
consecutive checkpoint run. Two problems make this brittle:

1. **Interleaved manual commits.** The commit guard (ADR-0006) was added
   to block agent-initiated `git commit` during the loop, but it adds
   complexity and removes user agency. We want to remove the guard and
   let commits of any kind exist between checkpoints.

2. **Cross-session reorganisation.** After checkpoints are reorganised
   into logical commits, a later agent turn may need to amend those
   commits. The user should be able to select a range spanning past
   reorganised commits — not just the latest checkpoint run — and
   squash all of them together for reorganisation.

A manual range-based selection popup solves both: the user can
arbitrarily expand the squash window to include any commits, and
checkpoints within the range remain automatically pre-selected so the
common case (squash all checkpoints) is a single Enter press.

## Design

### Trigger

- **`agent_end` (auto):** runs `organizeCheckpointCommits` directly,
  which soft-resets consecutive checkpoint commits from the current
  session and reorganises them into logical Conventional Commits via
  the LLM. No popup is shown — the operation is fully automatic.
- **`/autocommit-organise` (manual):** shows the interactive commit
  picker popup (TUI) or a fallback select menu (non-TUI) that lets the
  user choose an arbitrary range of commits to reorganise.
- Auto-organise at `agent_end` is skipped when:
  - HEAD did not move during the agent run (`head-guard`).
  - There are no checkpoint commits at HEAD.

### Popup

- Centered overlay window rendered via `ctx.ui.custom()` with
  `{ overlay: true, overlayOptions: { anchor: "center" } }`.
- Lists up to 100 recent commits from HEAD in reverse chronological
  order (newest first).
- Each line shows `[1]` / `[2]` / `[ ]` markers, a `▸` cursor, and
  the commit subject.
- `wip(checkpoint):` commits are displayed with the prefix stripped to
  `wip(checkpoint)` for readability.

### Default state

- Marker `[1]` (range start, newest side) at HEAD.
- Marker `[2]` (range end, oldest side) at the bottom of the **contiguous
  `wip(checkpoint):` run at HEAD** (stops at the first non-checkpoint
  commit, so scattered historical checkpoints — which may already be
  pushed — are never included by default).
- Cursor starts at `[2]` — the user's most common action is to extend
  the range downward by moving the cursor and pressing `2` again.
- All commits between `[1]` and `[2]` (inclusive) are visually
  highlighted to show the selected range.

### Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move cursor one line. Scrolls the list when at the edge. |
| `1` | Set range start (`[1]`) at cursor position. |
| `2` | Set range end (`[2]`) at cursor position. |
| `Enter` | Confirm — close the popup and begin reorganisation of the selected range. |
| `Esc` | Cancel — close popup, leave the working tree as-is. |

### Range-based reset

When the user confirms a range `[lo, hi]` (0-based indexes from HEAD):

1. `git reset --soft HEAD~{hi + 1}` — move HEAD past the oldest selected
   commit, keeping all changes staged.
2. Feed the combined staged diff into the existing `proposeCommitGroups`
   LLM pipeline — the same logic that already splits checkpoint diffs
   into logical Conventional Commits.
3. Commit each group in order via `commitGroups`.

The range is always contiguous: no skip-selection. If the user wants to
exclude a commit, they narrow the range instead.

### Remote-tip guard

Reorganising rewrites every commit in the range (new SHAs), so a range
that reaches the upstream tip (`@{upstream}`, falling back to
`origin/HEAD`) rewrites already-pushed history and breaks the next push.
`reorganiseSelectedRange` therefore refuses any range whose oldest commit
is at or below the upstream tip, and the picker marks the upstream tip
with a `← リモート先端` boundary so the user can see where the safe
limit is.

### Auto-organise at agent_end

Rather than invoking the popup, `agent_end` directly calls
`organizeCheckpointCommits` with the current session ID. This:

1. Counts consecutive checkpoint commits at HEAD belonging to the
   current session.
2. Soft-resets them (`git reset --soft HEAD~N`).
3. Feeds the combined staged diff to the LLM to propose logical groups.
4. Commits each group as a Conventional Commit.

If the LLM fails or returns no groups, it falls back to a single
Conventional Commit for all changes.

### Error handling

- **LLM failure:** falls back to a single Conventional Commit via the
  existing `fallbackSingleCommit`.
- **User cancels (Esc in popup):** no git operations are performed. The
  user can run `/autocommit-organise` later.
- **Auto-organise error:** error events are dispatched via the pipeline
  event system and shown in the UI.

## Consequences

- The commit guard (ADR-0006) becomes redundant and should be removed in
  a follow-up change. The guard's original problem (interleaved commits
  breaking auto-reorganisation) no longer applies because the user can
  manually select the range via `/autocommit-organise`.
- At `agent_end`, reorganisation is fully automatic — no user
  interaction required. Checkpoints are always cleaned up.
- The interactive popup remains available via `/autocommit-organise` for
  users who want to reorganise a broader range (including non-checkpoint
  commits) or organise scattered checkpoints.
- A `reorganiseSelectedRange` function is added to
  `commit-organizer.ts`, sharing the `proposeCommitGroups` /
  `commitGroups` / `fallbackSingleCommit` helpers with the auto path.
