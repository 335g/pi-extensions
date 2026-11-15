# pi-extensions

A collection of [pi](https://github.com/earendil-works/pi) extensions, kept in one npm workspaces repo. Each package
under `packages/` is published separately as `@335g/pi-<name>`.

[日本語](./README.ja.md)

## Install

Install one package from npm:

```sh
pi install @335g/pi-summary
```

Install every extension in this checkout at once:

```sh
pi install ./                       # inside this repo
pi install /path/to/pi-extensions   # from anywhere
```

Or install one package from the checkout:

```sh
pi install ./packages/pi-answer
```

The root `package.json` declares `packages/*/index.ts`, `packages/*/src/index.ts` and `packages/*/src/extension.ts`
under `pi.extensions`, so the repo root loads every package from its TypeScript source. Nothing needs building.
(`pi-autocommit`'s own manifest points at its built `dist/index.js`; the npm tarball ships `dist`, but a checkout of
this repo needs `npm run build` inside that package before the root can load it.)

## Packages

| Package | npm | What it does |
|---------|-----|--------------|
| [pi-answer](./packages/pi-answer/) | `@335g/pi-answer` | Extracts questions from an assistant message and answers them in an interactive Q&A TUI. Optional argument selects how far back to look (`/answer 2`). |
| [pi-autocommit](./packages/pi-autocommit/) | `@335g/pi-autocommit` | Checkpoint-then-reorganise auto-commit: every turn that changes files becomes a `wip(checkpoint)` commit, and the pending run is reorganised into logical Conventional Commits at each task boundary, before a push, and at the end of the agent loop. Commands: `/autocommit-enable`, `/autocommit-mode`, `/autocommit-organise`, `/autocommit-model`. |
| [pi-byetheway](./packages/pi-byetheway/) | `@335g/pi-byetheway` | Side conversation space (`/btw`) that reads the session context without writing to it, plus an explicit hand-off back to the session (`ctrl+p`). |
| [pi-summary](./packages/pi-summary/) | `@335g/pi-summary` | `/summary` shows only the user/AI turns of the current session, and summarises a comment or the work that followed it in place. |
| [pi-timeline](./packages/pi-timeline/) | `@335g/pi-timeline` | DSH-style task timeline: a one-line widget above the prompt (progress bar, running task, elapsed time) fed by a single `timeline` tool, plus an `alt+t` full view. |

Installation and usage are documented in each package's README.
