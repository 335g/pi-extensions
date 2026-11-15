# Checkpoint commits carry a `Checkpoint-Session:` trailer

Every checkpoint commit created at `turn_end` includes a Git trailer
`Checkpoint-Session: <sessionId>` in its body, where `<sessionId>` is
`ctx.sessionManager.getSessionId()`. The subject stays
`wip(checkpoint): ...` for backward compatibility with
`WIP_COMMIT_MARKER`. At `agent_end`, the reorganiser only treats
trailer-matching commits as its own and leaves others untouched.

## Considered options

- **A. Embed the id in the subject line** (e.g.
  `wip(checkpoint, s=abc): ...`). Rejected: pollutes `git log --oneline`,
  changes `WIP_COMMIT_MARKER`'s shape, and breaks the human-readable
  subject.
- **B. In-memory random nonce per pi process.** Rejected for crash
  recovery: the nonce dies with the process, so checkpoints left by a
  crashed session can never be matched after restart. A pi session id
  survives across resume, so reorganising orphaned checkpoints on the
  next run of the same session works.
- **C. Git trailer `Checkpoint-Session: <sessionId>` (chosen).** Keeps
  the stable subject prefix, uses a native Git mechanism queryable via
  `git log --pretty=%H%(trailers:key=Checkpoint-Session,valueonly)`,
  and ties checkpoint identity to pi's session model.
- **D. Out-of-band metadata (branch ref, sidecar file).** Rejected: the
  commit log would no longer be self-describing and the metadata would
  not travel with normal git operations.

## Consequences

- `runCheckpointCommit` must accept a session id and write a trailer;
  the commit body format becomes `wip(checkpoint): auto-commit at turn N\n\nCheckpoint-Session: <id>`.
- Checkpoint commits additionally record a `Checkpoint-Branch: <branch>`
  trailer (the worktree branch the checkpoint was created on) so merged
  checkpoints can be traced back to the delegated worktree that produced
  them. The commit picker and `/autocommit-organise` session completions
  display this branch instead of the raw session id.
- `countWipCommits` is replaced by a session-aware scan: collect
  consecutive `wip(checkpoint):` commits whose trailer matches the
  current session id. Non-matching commits terminate the run and are
  not reset.
- For stray checkpoints from a crashed/different session, the manual
  `/autocommit-organise` command lets the user pick a session id from a
  popup and reorganise only that session's commits.
- Scattered (non-contiguous) matching commits are reassembled by
  applying each commit's `git diff <parent> <commit>` to the index via
  `git apply --cached`; on apply conflict the run aborts and asks the
  user to resolve manually rather than risk corrupting history.
- The `wip(checkpoint):` subject prefix and `WIP_COMMIT_MARKER` stay
  stable, so existing logs and tooling are unaffected.