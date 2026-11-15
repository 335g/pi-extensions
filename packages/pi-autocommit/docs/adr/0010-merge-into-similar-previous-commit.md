# Merge reorganisation into a similar previous commit group

The checkpoint-then-reorganise strategy only ever rewrites the checkpoint run
at HEAD. When an agent works on a feature across several runs, the previous
run's reorganised commits (`feat(cli): ...`, `test(cli): ...`) sit directly
below the new checkpoint run, and the same files get near-duplicate commits.
We decided to extend `agent_end` reorganisation downward — into the *previous
commit group* — when that group is similar, and to re-consolidate rather than
amend.

A previous commit group is the contiguous run of commits directly below the
checkpoint run whose consecutive committer times are no more than 10 seconds
apart. One `agent_end` emits its logical commits back to back, so 10 seconds
captures a batch while stopping at commits from an earlier run. At most 20
commits are absorbed.

"Similar" is deterministic: after the checkpoint-only diff is split into
groups, a proposed group matches the previous group when some member has an
exactly equal changed-file set and a matching Conventional `type(scope)` (a
missing scope on either side degrades to a type-only match). The whole
previous group is then soft-reset together with the checkpoint run and the
combined diff is fed to the reorganiser again, producing fresh commits. This
second pass is the point: the right message for the merged changes can differ
from either side's, so amending one commit's message would be wrong.

Pushing is the one condition that cannot be decided locally. The group is
compared against `@{upstream}` (falling back to `origin/HEAD`) via the
existing `getUpstreamAheadCount` guard: when any member exists on the remote
the group is left untouched, only the checkpoints are reorganised, and a
notice says why. No force-push path is offered.

## Considered Options

- **Only the single commit directly below the run** — rejected: one
  `agent_end` can produce several commits, and the match may be against any of
  them, not just the newest.
- **`git commit --amend` into the matching commit** — rejected: the combined
  diff may deserve a different type or message than either side, which an
  amend cannot express.
- **LLM decides similarity** — rejected: the decision becomes
  non-deterministic and costs an extra roundtrip, while the file-set and
  `type(scope)` signals already capture the intended case.
- **Force-push published history to merge anyway** — rejected: rewriting
  pushed commits is the exact hazard the upstream guard exists to prevent.
- **Require an interactive confirmation** — rejected: the operation is
  guarded, narrow, and reversible via the reflog; a popup every `agent_end`
  would defeat the zero-interaction design.

## Consequences

- A feature touched again in a later run collapses into a coherent set of
  commits instead of accumulating near-duplicate ones.
- Merging costs a second LLM pass (one to match, one to re-split); the
  non-merge path is unchanged.
- The merge is skipped whenever no checkpoint group matches the previous
  group, or the group is pushed; the checkpoint-only reorganisation then
  proceeds as before.
- `mergeSimilarPrevious` (default `true`) turns the behaviour off without
  touching the push guard.
