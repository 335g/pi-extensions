# pi-herdr-fleet

[日本語](./README.ja.md)

An approval broker between [herdr](https://herdr.dev) panes and Pi. herdr knows which panes are
waiting on a human; `/fleet` shows that list as an overlay on the pane you are already looking at,
and answers a blocked agent without switching panes.

Phase 1 covers the herdr client and the approval broker. Layout recipes and the fork/worktree loop
are later phases.

## Requirements

The extension only exists inside a herdr-managed pane, in interactive mode. If `HERDR_ENV=1`,
`HERDR_SOCKET_PATH` and `HERDR_PANE_ID` are not all set, it registers nothing at all; if pi is not
in TUI mode it starts nothing, because RPC and print modes have no pane herdr can display and no
terminal to draw an overlay in.

## Install

```sh
pi install npm:@335g/pi-herdr-fleet
```

`pi install` writes to the user settings (`~/.pi/agent/settings.json`). Add `-l` to write to the
project settings (`.pi/settings.json`) instead.

## Usage

- `/fleet` — open the list of panes waiting on approval
- `ctrl+shift+a` — the same list, without typing a command

| Key | Action |
|-----|--------|
| `↑` `↓` | move the selection |
| `1`-`9` | open that row |
| `Enter` | open the selected row |
| `Esc` | close the overlay |

In the detail view:

| Key | Action |
|-----|--------|
| `Enter` | send what you typed as a prompt (`agent.prompt`) |
| `ctrl+k` | send what you typed as raw keys (`agent.send_keys`) |
| `PageUp` `PageDown` | scroll the question |
| `Esc` | back to the list |

## Answering a blocked pane

An approval dialog is usually not a question you can answer with a sentence: it may be a numbered
list, a yes/no, or a full-screen picker. So there are two routes out of the detail view, and which
one you take is your choice rather than a guess the extension makes from your text.

- **Text** (`Enter`) submits what you typed, the way the pane's own input would.
- **Raw keys** (`ctrl+k`) writes keystrokes instead. The input is split on whitespace, so
  `esc 1` sends `esc` then `1`, `up up enter` walks a menu, and an empty input is a bare `Enter`
  — the common case for a confirmation dialog.

Two things never happen:

- **A failure is never retried.** herdr's timeout is not proof the input never reached the agent,
  so a send that fails is reported in the overlay with its reason and the row stays in the list.
  Retrying is your decision, not the extension's.
- **The row is not removed on a successful write.** A write that succeeded is not proof the agent
  moved on. Rows disappear only when herdr reports the pane is no longer blocked.

This pane is never listed. Answering itself would deadlock.

## Notifications

A pane that newly becomes blocked raises a pi notification. To turn that off:

```json
// ~/.pi/agent/pi-herdr-fleet.json
{ "notify": false }
```

Nothing else in the file is read.

## How it works

herdr is the source of truth. The extension holds no state it cannot rebuild:

- The list is built from `session.snapshot` and corrected by `pane.agent_status_changed`. A pane
  that behaves unexpectedly is resolved by asking herdr again, not by guessing locally.
- The question shown in the detail view is read with `agent.read` (`detection` first, `visible`
  when herdr returns nothing), once, when the pane becomes blocked.
- Every request has a timeout, and every failure — a missing method on an older herdr, a closed
  socket, a slow server — comes back as a value rather than an exception. The overlay shows the
  reason instead of breaking the session.
- The event stream reconnects with exponential backoff. On recovery it resubscribes and re-reads
  `session.snapshot`, so a state the extension derived from the old stream is replaced by herdr's.

## Limitations

- One subscription connection is needed per pane set. herdr scopes `pane.agent_status_changed` to a
  single `pane_id` and rejects a second `events.subscribe` on an already-subscribed connection, so
  a new pane means a new connection. Nothing is accumulated: the set is re-derived from the
  snapshot and compared.
- Recipes (`/fleet recipe ...`, Phase 2) and the fork/worktree loop (Phase 3) are not implemented.
- `/fleet` takes no arguments yet.

## Development

```sh
node packages/pi-herdr-fleet/selfcheck.ts
```

Runs the transport and the broker against a fake herdr server on a temporary socket: the
request/error/timeout degradation paths, subscription and reconnect/resync, that a refused
subscription set is rebuilt instead of retried forever, that only other panes are listed, that
leaving `blocked` drops a row, that the first snapshot does not notify and a re-snapshot does not
re-announce, that a failed send keeps the row, and the registration guard.
It also renders the overlay and checks that every line has the same width and the box is closed.

There is no `tsconfig.json` in this repo, so the type check is explicit:

```sh
npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext \
  --strict --skipLibCheck --allowImportingTsExtensions --types node \
  packages/pi-herdr-fleet/index.ts
```
