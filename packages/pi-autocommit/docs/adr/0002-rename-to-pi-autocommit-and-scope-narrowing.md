# Rename `pi-git` to `pi-autocommit` and narrow scope to auto-commit only

The `pi-git` extension is renamed to `pi-autocommit` and its scope is
narrowed from "git utilities" to auto-commit only. The `/git-commit` and
`/git-status` commands are removed; the remaining surface is the
checkpoint-then-reorganise auto-commit strategy driven by the `enable`
config flag, plus the uncommitted-changes footer indicator that helps
users spot unintended files before a commit.

## Rationale

The original name `pi-git` implied general-purpose git utilities, but the
core value is specifically "you don't have to think about commit
messages." Auto-commit (checkpoint → reorganise) is the most visible
embodiment of that value, and keeping `/git-commit` and `/git-status`
diluted the package's identity. Narrowing the scope makes the package
name match what it actually does.

## Migration strategy (npm: new package + deprecate old)

A new npm package `@335g/pi-autocommit` is published. The old
`@335g/pi-git` is marked `deprecated` on npm but **not** unpublished, so
existing installs keep working and a migration note can point users to
the new package. This was chosen over two alternatives:

- **Keep the npm name, rename only the repo (major bump):** rejected
  because the package name `pi-git` would contradict the narrowed
  scope, defeating the purpose of the rename.
- **Unpublish the old package:** rejected because npm's unpublish policy
  is restrictive for already-published packages and deprecation is safer
  for any existing users (in practice the only user is the maintainer,
  but the deprecation path costs nothing and is reversible).

The GitHub repository is renamed `pi-git` → `pi-autocommit`; GitHub
keeps the old URL as a redirect.

## Consequences

- `/git-commit`, `/git-status`, and their supporting modules (args,
  confirmation, file selector, status viewer) are deleted in a
  follow-up change.
- Config file becomes `.pi/pi-autocommit.json`; `commitEveryTurn` is
  renamed to `enable` with default `true`, and `noBody` is removed. The
  old `.pi/pi-git.json` is not read (no backward-compat shim, since the
  package is pre-0.1).
- `enable` defaults to `true`: installing a package named autocommit and
  getting nothing would be surprising. The uncommitted-changes footer
  indicator stays to give users a pre-commit cue to spot unintended files
  before a checkpoint captures them.
- Scope is now explicitly git operations outside of commit-message
  generation and checkpoint/reorganise auto-commit (push, pull, branch,
  merge, rebase, log viewer, stash). A "view recent commits" feature may
  or may not be added later; it is not decided.