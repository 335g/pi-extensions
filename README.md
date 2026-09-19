# pi-extensions

A collection of [pi](https://github.com/earendil-works/pi) extensions, kept in one npm workspaces repo. Each package
under `packages/` is published separately as `@335g/pi-<name>`.

[日本語](./README.ja.md)

## Packages

| Package | What it does |
|---------|--------------|
| [pi-answer](./packages/pi-answer/) | Extracts questions from an assistant message and answers them in an interactive Q&A TUI. Optional argument selects how far back to look (`/answer 2`). |

## Install

```sh
pi install npm:@335g/pi-answer
```

`pi install` writes to the user settings (`~/.pi/agent/settings.json`). Add `-l` to write to the project settings
(`.pi/settings.json`) instead.

## Development

- One directory per extension under `packages/`, each with its own `package.json`, `pi.extensions` entry, and README.
- `npm install` at the repo root links the workspaces.
- Publish with `npm publish -w @335g/pi-answer`.

Packages are loaded straight from TypeScript (`index.ts`), so there is no build step.
