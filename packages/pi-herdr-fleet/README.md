# pi-herdr-fleet

[日本語](./README.ja.md)

An approval broker between [herdr](https://herdr.dev) panes and Pi. herdr knows which panes are
waiting on a human; `/fleet` shows that list as an overlay on the pane you are already looking at,
and answers a blocked agent without switching panes. The same command saves and restores tab
layouts, creates worktrees with the untracked development environment carried over, and forks one:
a worktree, a Pi session in it, and a task handed to that session.

Phase 3a adds `/fleet fork`. Review (3b) and the merge gate (3c) are still to come.

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
- `/fleet recipe save <name>` — store the current tab's layout
- `/fleet recipe apply <name> [--start]` — restore it as a new tab
- `/fleet recipe ls` — list the stored recipes
- `/fleet worktree create <branch> [--base <ref>] [--label <text>]` — make a worktree and carry the
  development environment into it
- `/fleet fork <branch> --task "<text>" [--base <ref>] [--scope implementation] [--no-install]
  [--no-start]` — fork a worktree, start a Pi session in it, and hand it the task

| Key | Action |
|-----|--------|
| `↑` `↓` | move the selection |
| `1`-`9` | open that row |
| `Enter` | open the selected row |
| `Esc` | close the overlay |

In the detail view:

| Key | Action |
|-----|--------|
| `Enter` | send what you typed, then Enter (`pane.send_input`) |
| `ctrl+k` | send what you typed as raw keys (`pane.send_keys`) |
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

Both routes go through the pane surface (`pane.send_input` / `pane.send_keys`), not the agent
surface. That is not a shortcut: `agent.prompt` **refuses any pane herdr reports as blocked**
(`agent_blocked`) — which is every pane this overlay can answer — and `agent.send_keys` refuses an
agent reported through `pane.report_agent` (`agent_not_ready`), which is how hooks and plugins report
state. Answering an approval dialog is intentional raw input into that pane.

Two things never happen:

- **A failure is never retried.** herdr's timeout is not proof the input never reached the agent,
  so a send that fails is reported in the overlay with its reason and the row stays in the list.
  Retrying is your decision, not the extension's.
- **The row is not removed on a successful write.** A write that succeeded is not proof the agent
  moved on. Rows disappear only when herdr reports the pane is no longer blocked.

This pane is never listed. Answering itself would deadlock.

## Recipes

A recipe is herdr's own tab layout: `/fleet recipe save dev` exports the current tab and writes the
`LayoutNode` tree to `.pi/herdr-fleet/recipes/dev.json` (relative to the directory pi runs in). The
tree is stored as-is except for `pane_id`, which is dropped because a closed pane's id is never
reused.

`/fleet recipe apply dev` builds that tree as a **new tab** in the current workspace, labelled with
the recipe name. It never replaces the tab you are in: the saved tree has no source tab id, and
replacing the current tab would kill the session that ran the command. Applying is layout only by
default, so a saved pane comes back as a plain shell in the saved `cwd`. `--start` also replays the
saved launch commands.

Recipe names are restricted to one safe filename segment (`[A-Za-z0-9][A-Za-z0-9._-]*`); a name is a
path, so `../` in one would be a write outside the project.

## Worktrees and the environment

`/fleet worktree create <branch>` calls `herdr worktree create`, then copies the untracked
development environment into the new checkout:

- Every `.env*` file in the source root (`.env`, `.env.local`, `.env.example`, `.envrc`, ...) is
  copied in. **Nothing is overwritten**: an `.env.example` that git already put in the worktree stays
  as it is.
- `direnv allow` is run for the new worktree **only if the source `.envrc` was already allowed**.
  That is checked with `direnv status --json` and `state.foundRC.allowed === 0`. Allowing an
  unallowed `.envrc` in a new location is a trust grant — it would let the worktree the extension
  just created execute code the user never approved — so it is mirrored, never introduced.
- Without direnv, or without an `.envrc` in the source, the copy happens and a warning is reported.
- A failure at any point in this step is a warning, not a failure: the worktree exists and is
  reported as created.

This exists because a worktree gets only what git tracks. Without the copy, the Pi started in a
fresh worktree dies on startup with `No API key found`.

## Forking work

```
/fleet fork feat/x --task "Add retries to the uploader"
```

Five steps, in this order:

1. A worktree on a new branch, with `.env*`/`.envrc` carried over as above.
2. **Prepare** — if the checkout has a lockfile, dependencies are installed in it. The lockfile
   picks the installer: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb`/`bun.lock` → bun,
   `package-lock.json` → npm. No lockfile means no install. The command is typed into the new
   pane's shell and herdr waits for it to finish, so the install output lands on a screen you can
   switch to instead of inside the session that asked for it. `--no-install` skips this step.
3. A pane in the worktree's workspace (`pane.split` with `--cwd <worktree>` and `--no-focus`), then
   a Pi session in it. The agent name comes from the branch, normalised to herdr's
   `[a-z][a-z0-9_-]{0,31}` and cut at 32 characters.
4. The task, as **one message**, through `pane.send_input`. Not `agent.prompt`: that refuses any
   pane herdr reports as blocked, which is the same layer of problem the approval broker hit, and
   typing a prompt into a session is pane work.
5. A notification with the worktree path, branch, workspace, pane and agent name.

`--no-start` stops after step 1: a worktree and its environment, with nothing running in it.

### The task is the whole brief

**No conversation history is passed.** The forked session gets the task text, the worktree and
branch, the constraints, and what "done" means. A discussion is not a brief: anything decided in
the session that forked it has to be written into the task, and anything left open has to be asked
again. That prompt lives in `scopes.ts`, and `review` (3b) will add a second one there.

The implementation scope tells the session to:

- work only inside this worktree, and not touch other checkouts
- commit on this branch; not create worktrees, start agents, or push
- ask instead of guessing when the task does not decide something
- finish with a commit on the branch and a short report, not a diff

A failed install is a warning rather than a failure: the worktree and the pane exist, and the
notification says what happened. Environment warnings are reported the same way.

### Why the fork waits

Two things a real pane does that the API does not read like:

- `agent.start` answers `agent_pane_busy` while the pane's shell is still being recognised — which
  is the normal case here, because the install just ran in that pane. The fork retries it.
- herdr reports the agent ready about three seconds before the agent accepts input. A prompt sent
  inside that window lands in the editor and is never submitted; the trailing Enter is simply lost.
  The fork waits for herdr to report a settled agent before sending the task.

Both were measured against herdr and Pi, and both are the reason the steps are ordered this way.

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
- The fork loop has no second half yet. Nothing reviews a fork and nothing gates a merge (3b, 3c);
  a fork is reported once and then left alone. There is no list of the worktrees you have forked.
- Neither `/fleet worktree create` nor `/fleet fork` moves your focus: the new workspace is built in
  the background.
- A recipe records one tab. There is no way to save a whole workspace, and no way to restore into
  the tab a recipe was saved from.
- `direnv` is the only environment manager recognised. A mise/asdf-style setup arrives through
  `.envrc` or not at all.

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

Recipes and the environment copy are checked against real temporary directories: that a recipe
keeps `cwd`/`env`/`command` but no `pane_id`, that `--start` decides whether commands are replayed,
that a name cannot escape the recipe directory, and — with a stubbed `direnv` — that an unallowed
source `.envrc` is never allowed in the new worktree while an allowed one is.

The fork's own pieces are checked the same way: that the lockfile and only the lockfile picks the
installer, that a checkout with no lockfile is not installed into, that `--no-install` types
nothing, that the install marker cannot match the command echo (the pane echoes what is typed, so a
literal marker would match before the install ran), that a non-zero exit is a reported failure, that
a busy pane is retried while an unfixable `agent.start` failure is not, and that the agent is waited
for before anything is typed into it. The seed and the agent name are pure functions, so the task,
the worktree and the branch are checked against the string they produce.

### Acceptance

```sh
packages/pi-herdr-fleet/acceptance.sh
```

End-to-end against a real herdr server, real panes, real direnv and a real Pi TUI. Run it from
inside a herdr pane. The broker never lists its own pane, so this needs three panes, and the script
builds them: a **subject** shell reported as `blocked` through `pane.report_agent`, an **observer**
Pi running this extension in a different pane, and the caller's pane. It then checks the
notification, the overlay listing, the question in the detail view, both answer routes (text and
raw keys), and that `Esc` closes the overlay. Only the panes it created are closed.

Reporting the subject's state instead of waiting for a real agent keeps the run deterministic: no
model has to answer, yet the whole path — socket, subscription, overlay, key delivery into the
subject's `read` — is exercised for real.

```sh
packages/pi-herdr-fleet/acceptance-fork.sh
```

End-to-end for `/fleet fork`, against the same real stack plus real git and real npm. A fork creates
real worktrees, so this script does not touch this repository: it builds its own git repository in a
temp directory, with a base commit that has no lockfile, and its own workspace for the observer Pi.
It removes every worktree, workspace, pane and direnv trust entry it created, and never reads or
closes anything else.

It checks, across four forks: that the worktree, the environment copy, the direnv trust, the
install, the pane, the Pi and the seed all happen, that the forked session actually does the task
and commits it, that a checkout without a lockfile is not installed into, that `--no-install`
ignores a lockfile, and that `--no-start` leaves a worktree with nothing running in it.

Unlike `acceptance.sh`, the last check needs a working model: the point of a fork is that the forked
session does the work. The script warns when no API key is in the environment.

There is no `tsconfig.json` in this repo, so the type check is explicit:

```sh
npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext \
  --strict --skipLibCheck --allowImportingTsExtensions --types node \
  packages/pi-herdr-fleet/index.ts
```
