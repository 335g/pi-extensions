# pi-extensions

A collection of [pi](https://github.com/earendil-works/pi) extensions, kept in one npm workspaces repo. Each package
under `packages/` is published separately as `@335g/pi-<name>`.

[日本語](./README.ja.md)

## Install

Install every extension in this checkout at once:

```sh
pi install ./                       # inside this repo
pi install /path/to/pi-extensions   # from anywhere
```

Or install one package:

```sh
pi install ./packages/pi-answer
```

The root `package.json` declares `packages/*/index.ts`, `packages/*/src/index.ts` and `packages/*/src/extension.ts`
under `pi.extensions`, so the repo root loads every package from its TypeScript source. Nothing needs building.
(`pi-autocommit`'s own manifest points at its built `dist/index.js`, so installing that package alone still needs
`npm run build`.)

## Packages

| Package | What it does |
|---------|--------------|
| [pi-answer](./packages/pi-answer/) | Extracts questions from an assistant message and answers them in an interactive Q&A TUI. Optional argument selects how far back to look (`/answer 2`). |
| [pi-byetheway](./packages/pi-byetheway/) | Side conversation space (`/btw`) that reads the session context without writing to it, plus an explicit hand-off back to the session (`ctrl+p`). |
| [pi-herdr-fleet](./packages/pi-herdr-fleet/) | Approval broker between [herdr](https://herdr.dev) panes and Pi: `/fleet` lists the panes waiting on a human and answers them from the pane you are looking at. Also saves and restores tab layouts, creates worktrees with `.env`/`.envrc` carried over, and forks a worktree with a task for a new Pi session. |

Installation and usage are documented in each package's README.
