# Commit review dialog as a third organise mode

`picker` (ADR-0012) gives control over *which* commits are reorganised. It says
nothing about *what comes out*: the LLM proposes a split and messages, and they
are committed without a look. When the proposal is wrong the only recourse is
the reflog. We decided to add a review step as a third mode rather than a flag
on `picker`, so control stays a single ladder — `auto` ⊂ `picker` ⊂ `review`.

The dialog is deliberately built from primitives pi already provides:
`ctx.ui.confirm()` per proposed group, and `ctx.ui.editor()` prefilled with the
proposed message when the group is rejected. No custom TUI component, no key
handling, no scrolling, and the editor handles multi-line messages and IME
input the way the rest of pi does. Rejecting and then cancelling the editor
aborts the whole reorganisation.

Only messages are editable. `commitGroups` enforces a coverage guard — every
staged file must be claimed by exactly one group, or the run falls back to a
single commit — so dropping a group or moving a file between groups would need
the guard rewritten and a story for the files left behind. Rewording covers the
common complaint; when the split itself is wrong, aborting leaves every change
staged, which is the same recoverable state the oversized-diff abort already
uses. The range picker's slow path additionally restores the pre-operation HEAD,
because it has already dismantled commits by then.

The review callback is injected into `reorganiseSelectedRange` the same way the
LLM adapter (`complete`) already is, so the organiser stays free of UI and the
dialog is testable against a stub `ctx.ui`.

## Considered Options

- **A custom popup listing all groups with inline editing** — rejected: it
  needs cursor handling, scrolling, and a text editor that survives Japanese
  input, all of which `ctx.ui.editor()` already does. Worth revisiting only if
  one dialog per commit proves too slow for large splits.
- **Allowing groups to be dropped** — rejected: it breaks the coverage guard,
  and the dropped files would silently stay uncommitted until the next
  checkpoint sweeps them into an unrelated commit.
- **Making review a boolean alongside `picker`** — rejected: two overlapping
  switches for one ladder, and `review: true, organiseMode: "auto"` would need
  a defined meaning.
- **Editing messages after the fact (`git commit --amend` style command)** —
  rejected: the commits already exist by then, so a mistake is in the history
  the user has to clean up, which is the friction this extension exists to
  remove.

## Consequences

- `review` costs one dialog per proposed commit, so a run that splits into four
  commits asks four times. That is the mode the user opts into, and `Enter`
  accepts a good proposal.
- Aborting leaves the tree staged rather than checkpointed, so the next
  `turn_end` will fold those changes into a new checkpoint. Nothing is lost.
- The organiser gained one optional parameter and one sentinel error
  (`ReviewAbortedError`) so a cancellation is reported as a cancellation, not
  as a failure, on both reorganisation paths.
