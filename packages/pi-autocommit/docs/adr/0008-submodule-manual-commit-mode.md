# Manual submodule mode: no recursion, detect orphaned submodule commits

Submodules are handled in **manual mode**: pi-autocommit never commits inside
a submodule. It records gitlink updates in the parent like any other changed
file, and it warns when a submodule HEAD holds commits that `git submodule
update` would silently discard.

## Motivation

A repository with submodules that has pi-autocommit enabled previously had no
viable path for submodule work:

1. **Submodule-internal changes are unstageable from the parent.** `git add -A`
   in the parent stages nothing when only the submodule working tree changed —
   the gitlink is unchanged. The turn_end checkpoint then failed with
   "nothing to commit" on every affected turn (verified against git 2.55:
   `git status --short` reports ` m sub`, `git add -A` stages nothing, and
   `git commit` exits 1).
2. **Recursive auto-commit is unsafe in the common layouts.** Committing
   inside a submodule that sits on a detached HEAD creates commits that are
   unreachable from any branch; the next `git submodule update` (not covered
   by the commit guard) checks out the gitlink SHA and orphans them
   (reflog-only survival). Submodules tracking `main`/`master` get moved by
   `update --remote`, invalidating local commits regardless of where they
   are recorded.
3. **Commit-message generation was blind.** The only mechanically working
   parent-side path — a gitlink update — fed the message generator a
   `Subproject commit <old>..<new>` pointer diff, so messages could not
   describe what actually changed inside the submodule.

## Decision

- **No recursion.** pi-autocommit does not commit inside submodules. The user
  commits submodule changes (e.g. from another terminal); the parent picks up
  the resulting gitlink update through the normal checkpoint pipeline.
- **Clean skip for submodule-only dirt.** When `git status` reports changes
  but staging produces nothing (submodule-only or ignored content), the
  turn_end checkpoint skips quietly instead of failing with a checkpoint
  error.
- **Detached-orphan detection.** At `session_start`, every included
  `turn_end`, and `agent_end`, each gitlink is compared against the
  submodule HEAD. A submodule is reported when its HEAD differs from the
  parent gitlink **and** is unreachable from any ref (`git for-each-ref
  --contains HEAD` is empty) — the state where `git submodule update`
  discards the commits. Commits on a branch are recoverable and are not
  reported. Each `path:HEAD` pair is warned at most once per session.
- **Expose submodule logs to the message generator.** The staged-diff
  material is read with `git diff --cached --submodule=log`, so gitlink
  commit messages can summarise the submodule commits that the update pins.

## Rationale

The genuine alternatives were recursion (pi-autocommit descends into
submodules, creating checkpoints and reorganised commits there) and ignoring
submodules entirely. Recursion was rejected because the danger is inherent
to submodule layouts that are detached or track a shared branch: automatic
commits there are either wiped by `update`/`update --remote` or require the
user to maintain a dedicated branch policy (a `master`/`main` blacklist) and
to push before the parent can be cloned anywhere else. Manual mode keeps the
extension simple, respects branch ownership, and the data-loss risk it cannot
remove is at least detected and surfaced.

Detection was preferred over extending the commit guard to block
`git submodule update`: a state-less block would fire on routine, harmless
updates (the update only discards commits when the gitlink does not yet
reference them, and fails outright on a dirty working tree).

## Consequences

- Submodule commit messages are written by the user, not generated.
- A detached-orphan submodule warns once per session until it is resolved
  (branch it, bump the gitlink, or discard it intentionally).
- Absorbed embedded git repositories (a directory with a `.git` absorbed as
  a gitlink by `git add -A`) are covered by the same detection, since it
  enumerates gitlink entries from the index rather than `.gitmodules`.
- If recursive auto-commit is ever wanted, it is a separate feature requiring
  its own detached-HEAD policy and a branch-based safety rule.