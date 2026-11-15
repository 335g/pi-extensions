# One worktree per concurrent session

When running multiple pi sessions concurrently in the same repository,
each session must operate on its own git worktree (`git worktree add`).
pi-autocommit does not create or manage worktrees — this is a user
convention — but it assumes HEAD isolation when deciding which
checkpoint commits to reorganise.

## Considered options

- **A. Shared working directory, shared HEAD (previous behaviour).**
  Multiple pi processes against the same branch. Rejected: the shared
  index makes `git add` collide, and `countWipCommits` (which walks
  consecutive `wip(checkpoint):` subjects from HEAD) silently merges
  another session's checkpoints into the wrong reorganisation.
- **B. Extension auto-creates a worktree per session.** Rejected: worktree
  lifecycle (creation, branch naming, teardown, ref churn) is heavier
  than the extension's responsibility and couples tightly to pi's session
  model. The cost outweighs the convenience.
- **C. User-managed worktrees, one per concurrent session (chosen).**
  Users run `git worktree add` themselves before launching parallel pi
  sessions. The extension documents the convention via this ADR and
  relies on HEAD isolation. A session-id trailer (ADR-0005) remains in
  place as a safety net for the one case worktree isolation cannot cover
  — a crashed session's un-reorganised checkpoints later surfacing in
  another session via rebase/merge.

## Consequences

- `countWipCommits` + `reset --soft HEAD~N` stays valid for the normal
  case because another session's checkpoints cannot appear in this
  worktree's HEAD.
- A residual failure mode remains: an un-reorganised checkpoint from a
  crashed session can be pulled in if its branch is shared and later
  rebased/merged into another worktree. This is handled by the
  session-id trailer (ADR-0005) and the manual `/autocommit-organise`
  command, not by worktree policy alone.
- No extension code manages worktrees; the convention lives in
  documentation only.