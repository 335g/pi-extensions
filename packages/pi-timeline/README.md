# pi-timeline

Keeps the agent's task plan on one line above the prompt, and opens the full list on `alt+t`. A minimal take on DSH's official timeline plugin.

```
timeline  3/7  ████░░░░░░  ▶ write widget 1m20s  !1
```

## Install

```sh
pi install @335g/pi-timeline
```

## What you see

- One line: progress bar, done/total, the running task with elapsed time, how many tasks are blocked.
- `alt+t` (or `/timeline`): a full screen with the task tree, statuses, durations, notes and total active time.
- The screen repaints once a second only while it is open; nothing ticks in the background.

## The `timeline` tool

The model publishes the plan with one tool, **replacing the whole list** on every call. Reusing an id keeps its timings.

```json
{ "tasks": [
  { "id": "1", "title": "Plan the change", "status": "done" },
  { "id": "2", "title": "Write the widget", "status": "active" },
  { "id": "2.1", "title": "Truncate the lines", "parent": "2" },
  { "id": "3", "title": "Run the tests", "status": "blocked", "note": "waiting on typecheck" }
] }
```

- `status`: `pending` (default), `active`, `done`, `blocked`.
- Only the moment a task becomes `active` and the moment it becomes `done` are stored; the duration is the difference.
- Empty ids, empty titles and duplicate ids are dropped. A parent that does not exist is treated as a root.

## State and persistence

The plan is stored with `pi.appendEntry("pi-timeline", ...)` in the session JSONL, and restored from the latest entry on the current branch after a resume, a fork or `/reload`.

## Keys

| Key | Action |
|---|---|
| `alt+t` | Open the timeline |
| `esc` / `q` / `ctrl+c` | Close |
| `↑` `↓` / `pageUp` `pageDown` | Scroll |

## Limits

- There is no persistent pane. It adds one row below Pi's built-in footer, so detail lives behind the shortcut.
- No periodic reports: nothing is injected into the model. Open the view when you want it.
- Subagent progress is not tracked. Add a row for it by hand.

## Development

```sh
npm test           # logic in src/timeline.ts
node selfcheck.ts  # wiring: tool, footer row, full view, restore (stub API)
```
