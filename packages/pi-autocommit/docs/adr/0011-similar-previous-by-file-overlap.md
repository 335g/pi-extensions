# Relax "similar previous commit" from file-set equality to overlap

ADR-0010 defined similarity as an *exactly equal* changed-file set. In practice
a later run almost never touches precisely the same files: it adds the test for
the code the previous run wrote, or one more file in the same module. Exact
equality therefore missed the case the merge exists for, and the branch
accumulated near-duplicate commits anyway. We decided to score similarity
instead of testing equality.

The score is the Jaccard similarity of the two changed-file sets —
`|a ∩ b| / |a ∪ b|` — and a member matches at `>= 0.5`. Half is the point where
"the same work with one file added" still merges (`{b.ts}` vs
`{b.ts, b.test.ts}`) while an unrelated change does not (`{a,b,c}` vs `{a,d,e}`
scores 0.2). The `type(scope)` match and the push guard from ADR-0010 are
unchanged, so overlap only widens which unpushed commits may be re-consolidated.

## Considered Options

- **Keep exact equality and let the user squash by hand** — rejected: the
  hand path (`/autocommit-organise`) already exists and is exactly the friction
  ADR-0010 was written to remove.
- **Subset test (either side contained in the other)** — rejected: it merges
  `{a}` into `{a, b, c, d}` — one shared file out of four — which is a much
  weaker signal than half the files.
- **LLM decides similarity** — rejected for the same reason as in ADR-0010:
  non-deterministic, and an extra roundtrip for a signal the file sets already
  carry.
- **Configurable threshold** — deferred: the constant
  `PREVIOUS_GROUP_MIN_FILE_OVERLAP` is exported and covered by tests. Promote
  it to config when real use shows 0.5 is wrong in either direction.

## Consequences

- A run that continues the previous run's work collapses into it, which is the
  intended behaviour and the common case.
- Some merges are now wrong: two commits that happen to share half their files
  but mean different things get re-consolidated. The damage is bounded — the
  rewrite touches unpushed history only, the reorganiser re-splits the combined
  diff from scratch, and `ORIG_HEAD` plus the reflog keep the previous state.
- Merging costs a second LLM pass whenever it triggers, so a looser match means
  that pass runs more often.
