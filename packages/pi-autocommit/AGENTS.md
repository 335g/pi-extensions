# pi-autocommit

The skill suite is configured in AGENTS.md so any agent or skill reading this repo sees the right default behaviour.

## Agent skills

### Issue tracker

Issues live as GitHub issues, tracked via the `gh` CLI. External PRs are not treated as a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles use their default names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (one `CONTEXT.md` at the repo root). See `docs/agents/domain.md`.
