# Partition editing in review mode

`review` (ADR-0013) hands over the range and the message, but not the split:
every staged file has to land in exactly one proposed commit, and a wrong
partition can only be escaped by aborting and committing by hand. That is the
one failure the extension exists to remove, so the review step gains a
partition editor. The flow becomes picker → *partition* → message, still one
ladder and still no new config key or mode.

The editor is `ctx.ui.editor()` prefilled with the whole proposal as text —
one `## subject` header per commit followed by its file paths — rather than a
custom popup, for the reason ADR-0013 gave: no cursor handling, no scrolling,
and IME input that already works for Japanese commit messages. Editing the
partition is three gestures in that text: move a file line under another header
to reassign it, delete a line to leave that file uncommitted, edit or add a
header to change the split. An untouched buffer round-trips to the original
proposal, so accepting costs one save.

The coverage guard in `commitGroups` is not weakened. A file the reviewed
groups no longer claim is unstaged *before* the guard runs, so the guard still
sees every remaining staged file claimed exactly once and a typo cannot
collapse the run into a fallback single commit. Dropping is inferred from the
difference rather than carried as a second return value, which keeps
`ReviewGroupsFn`'s signature unchanged; the price is that an accidentally
deleted line is indistinguishable from a deliberate drop. That is made loud
instead of prevented: the dropped paths are named in a notice, and the footer
indicator keeps showing `[has changes]` until they are dealt with. Deleting a
line is the drop gesture because the alternative — an explicit marker — adds
syntax and a second way to be wrong.

Parsing is validated against the staged set before anything is committed: an
unknown path, a path claimed twice, or a file line above any header re-opens
the editor with the complaint prepended instead of committing a partition the
user did not write. A header left with no files is a deleted commit. A header
whose subject still matches an original keeps that group's body; any other
header becomes a subject-only message the following message review can expand.

A gate dialog (`分割を編集しますか？`) sits in front of the editor so the
common case — a good proposal — stays one `Enter` away, and its body lists
every group at once, which the per-commit dialogs never did.

## Considered Options

- **A custom TUI popup with a cursor over the file list** — rejected for now:
  `commit-picker.ts` shows it costs a few hundred lines of key and scroll
  handling to reach what `ctx.ui.editor()` already provides, and it would still
  need the message editor for multi-line bodies. Worth revisiting only if
  hand-editing text proves unwieldy for splits over ~30 files.
- **Returning dropped files explicitly from `ReviewGroupsFn`** — rejected: it
  changes a signature two organiser paths share, and the difference against the
  staged set already answers the question.
- **Letting a drop trip the existing coverage guard** — rejected: the guard's
  remedy is a fallback single commit, which would commit the very file the user
  removed.
- **Folding message editing into the partition editor** — rejected: bodies are
  multi-line, and any line-based syntax for them collides with file paths. The
  existing per-commit editor keeps body editing and IME handling as they are.

## Consequences

- `review` now costs one extra `Enter` on a good proposal (the gate), in
  exchange for seeing the whole split at once.
- A dropped file survives as an uncommitted change, so the next `turn_end`
  checkpoint will sweep it into an unrelated commit unless the user deletes or
  reverts it first. That is the same exposure the abort path already has, and
  the notice names the files.
- `ReorganiserStore` gained `unstageFiles`, backed by the batch form of the
  `git restore --staged --` call the submodule path already used per file.
- ADR-0013's "allowing groups to be dropped" rejection is superseded for the
  review path only: the reason that held — dropped files silently staying
  uncommitted — is now answered by unstaging them deliberately and reporting
  them, not by forbidding the drop.
