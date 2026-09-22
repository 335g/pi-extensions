# pi-extensions

A collection of [pi](https://github.com/earendil-works/pi) extensions, kept in one npm workspaces repo. Each package
under `packages/` is published separately as `@335g/pi-<name>`.

[日本語](./README.ja.md)

## Packages

| Package | What it does |
|---------|--------------|
| [pi-answer](./packages/pi-answer/) | Extracts questions from an assistant message and answers them in an interactive Q&A TUI. Optional argument selects how far back to look (`/answer 2`). |
| [pi-byetheway](./packages/pi-byetheway/) | Side conversation space (`/btw`) that reads the session context without writing to it, plus an explicit hand-off back to the session (`ctrl+p`). |
| [pi-herdr-fleet](./packages/pi-herdr-fleet/) | Approval broker between [herdr](https://herdr.dev) panes and Pi: `/fleet` lists the panes waiting on a human and answers them from the pane you are looking at. Also saves and restores tab layouts, creates worktrees with `.env`/`.envrc` carried over, and forks a worktree with a task for a new Pi session. |

Installation and usage are documented in each package's README.
