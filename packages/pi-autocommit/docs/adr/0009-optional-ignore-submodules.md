# Optional `ignoreSubmodules`: keep submodule pins out of auto-commits

ADR-0008 made the parent record gitlink updates "like any other changed file".
Users whose workflow advances submodules outside pi-autocommit asked for the
opposite default: commits piling up inside a submodule should never create
parent-side auto-commits — pi-autocommit tracks only the parent repository.
We decided to keep ADR-0008's behaviour as the default but add an opt-in
`ignoreSubmodules` flag that excludes gitlink updates and `.gitmodules`
changes from checkpoint staging and from reorganisation, leaving pin updates
to manual commits.

Detection is based on mode 160000 index entries rather than parsing
`.gitmodules`, so absorbed embedded git repositories are covered by the same
rule with no extra machinery: "anything the parent sees as a gitlink is out
of scope". The detached-orphan warning from ADR-0008 stays active regardless
of the flag, because data-loss detection is independent of whether we commit;
with the flag on it is demoted to an informational notice shown at session
start only, since pin drift is then expected rather than exceptional.

## Considered Options

- **Generic path-exclusion config (`ignorePaths` globs)** — rejected: a gitlink
  is a directory-shaped index entry, not a file, so globs alone cannot express
  the exclusion and a mode-160000 special case would be needed anyway.
- **Always ignore submodules** — rejected: users who delegate submodule work
  through worktrees rely on the parent recording pin bumps automatically.
- **Hide ignored drift from the uncommitted-changes indicator** — rejected:
  a permanently dirty tree is the truthful signal that pin updates are
  unrecorded.

## Consequences

- With the flag on, submodule-only turns skip cleanly (no commit), matching
  the existing submodule-internal-dirt skip.
- Users must bump pins themselves; the footer indicator shows the pending
  drift until they do.
