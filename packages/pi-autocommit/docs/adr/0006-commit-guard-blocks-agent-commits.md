# Commit guard blocks destructive and history-interleaving git commands during the agent loop

> **Superseded in part by ADR-0015.** The guard now blocks only the commit
> command and `reset --hard`; push, merge, cherry-pick and rebase are allowed,
> and the reorganiser caps its range at the upstream tip instead. The detection
> approach described below still applies to the two operations that remain
> blocked.

When `enable` is true, pi-autocommit intercepts the `tool_call` event for
the `bash` tool and blocks any command that would:

- commit or push on its own: `git commit` (including `--amend`) and `git push`;
- destroy the index and working tree: `git reset --hard`; or
- interleave a foreign commit into the checkpoint run: `git merge`
  (except `--squash`, which creates no commit), `git cherry-pick`, and
  `git rebase`. Plain `merge`/`cherry-pick` are additionally allowed
  when HEAD holds no checkpoint commits (see Rationale).

The block reason explains why the operation is blocked, how to resolve
rebases started outside pi (manually), and that the guard can be disabled
with `/autocommit-enable false`. The reason is written in the configured
commit-message language: Japanese when `lang` is Japanese, English otherwise.

## Rationale

During an agent loop the LLM occasionally commits spontaneously at a
natural task boundary ("let me commit this"). An interleaved commit
splits the checkpoint run at HEAD: `countCheckpointCommits` stops at the
first non-checkpoint subject, so checkpoints below the foreign commit
are silently dropped from automatic reorganisation. The user's concern
is that interleaved commits make the final history impossible to
reassemble cleanly.

Pushing before `agent_end` is blocked for the same reason: it ships the
raw checkpoint commits to the remote, which then diverge from the
reorganised history pi-autocommit creates afterwards.

`merge`, `cherry-pick`, and `rebase` interleave the same way: their
commits are not checkpoints, so they stop the checkpoint scan at HEAD.
`rebase` additionally rewrites the checkpoint run and can leave the repo
half-finished on conflict.

Two exceptions make worktree branch integration practical. `git merge
--squash` creates no commit — it stages the merged changes, which flow
through the normal turn_end checkpoint — so it is always allowed.
Plain `merge`/`cherry-pick` are allowed when HEAD holds no checkpoint
commits: with a clean HEAD there is no checkpoint run to strand below the
foreign commit. They remain blocked while checkpoints sit at HEAD, and
the block reason then suggests `/autocommit-organise` or `--squash`.

Merging a branch whose tip is still un-reorganised checkpoints (the
owning agent crashed before `agent_end`) brings `wip(checkpoint)` into
history permanently: the changes are in the tree, and the manual
scattered reassembly path re-applies their diffs as a no-op (nothing to
commit), so they cannot be reorganised after the fact. The `agent_end`
handler detects checkpoints from other sessions that arrived since the
agent baseline (`findCheckpointsSince`, ADR-0005 trailers) and warns;
the prevention is integrating with `--squash`.

`reset --hard` is blocked because it destroys the index and the working
tree — including changes made in the current turn that the next
turn_end checkpoint has not captured yet. This is the largest
irrecoverable data-loss risk covered by the guard. `reset --soft` and
`--mixed` are left alone: agents legitimately use them to inspect and
rewind history without touching the working tree.

## Considered options

- **A. `pre-commit` git hook.** Rejected as the primary defence: it
  requires a separate setup step outside the extension (installing a
  hook), and `git commit --no-verify` bypasses it. The extension's own
  commits also go through `pi.exec("git", ["commit", ...])`, which would
  trigger the hook unless the extension remembered `--no-verify` on every
  call — coupling the extension to its own hook.
- **B. `tool_call` interception (chosen).** The extension already runs
  inside pi and listens to events. Blocking at the `bash` tool layer
  catches the only path an agent can use to run git, while the
  extension's own `pi.exec` git calls bypass the tool layer entirely, so
  no self-block risk exists. No extra setup is needed.
- **C. System prompt / AGENTS.md instruction.** Rejected as a sole
  defence: LLMs do not reliably obey "don't commit" instructions, and
  the failure mode is silent history corruption.

## Detection

The `bash` tool's `command` string is split on `&&`, `||`, `;`, `|`, and
newlines into segments. Each segment (including any quoted substring) is
tested for a `git ... <verb>` invocation via
`/\bgit\b(?:\s+\S+)*\s+<verb>(?=\s|$)/` — the lookahead prevents matching
a verb inside a filename like `commit-message.txt`. This catches
`git -C /path <verb>`, compound commands (`git add && git commit`), and
quoted invocations (`sh -c "git push"`).

`reset --hard` is a flag variant of a safe verb, so it is detected
separately: a segment must contain both a `git ... reset` invocation and
the `--hard` flag.

The block reason is generated by `buildBlockReason(blocked, japanese)`
in `commit-policy.ts`, switching between Japanese and English based on
the configured commit-message language. Every reason ends with the note
that the guard is disabled via `/autocommit-enable false` — the guard is
inert when `enable` is false.

## Consequences

- `commit-policy.ts` owns the detection predicates
  (`shouldBlockGitCommit`, `shouldBlockGitPush`,
  `shouldBlockGitHardReset`, `blockedInterleavingVerb`,
  `interleavingAllowedWithoutCheckpoints`) and the reason
  builder, kept separate from the `bash` event handler in `index.ts` so
  it is unit-testable.
- The guard is active only while `enable` is true.
- The reorganiser is unchanged: the existing `agent_end` automatic path
  (`countCheckpointCommits`, consecutive-at-HEAD) stays as-is. Stray
  checkpoints from a crash or a rare bypass are recoverable via the
  existing manual `/autocommit-organise <sessionId>` command
  (ADR-0005) as long as they have not been merged into a branch — once
  merged, the changes are in the tree and only `--squash`-style
  prevention or a manual history rewrite can clean them up.
- `git clean -f`, `git checkout .` / `git restore`, `git branch -D` and
  other destructive-but-context-dependent commands are NOT guarded:
  they require argument parsing (path vs branch) or have legitimate
  agent-loop uses, so blocking them would harm agent investigation.
  Revisit if a concrete loss case shows up.
- The block reason is verbose on purpose: telling the LLM *why* the
  operation is managed reduces retry attempts.
