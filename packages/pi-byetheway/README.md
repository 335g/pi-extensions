# pi-byetheway

[日本語](./README.ja.md)

A side conversation space that reads the session context and never writes to it.
Run `/btw` mid-session, ask about what you have done so far, and close it without
leaving a trace in the session or in the agent's context. When you *do* want the
conclusion to survive, `ctrl+p` reformats the exchange into one message and sends
that to the main session.

## Install

```sh
pi install npm:@335g/pi-byetheway
```

`pi install` writes to the user settings (`~/.pi/agent/settings.json`). Add `-l` to write to the project settings
(`.pi/settings.json`) instead.

## Usage

- `/btw` — open the space
- `alt+b` — resume a space you stashed with `Esc`

Keys:

| Key | Action |
|-----|--------|
| `Enter` | send the question |
| `Shift+Enter` | newline |
| `Esc` | stash the space and return to the main editor (state is kept) |
| `ctrl+d` | close and discard (asks first when there is anything to lose) |
| `ctrl+p` | hand the exchange to the main session (see below) |
| `ctrl+u`, `PageUp`, `PageDown`, `Up`/`Down` on an empty input | scroll the history |

While a question is in flight the answer streams in. You can keep typing; `Enter` is ignored until it finishes.
A failed question is put back into the input so you do not retype it.

## Handing the exchange to the session (`ctrl+p`)

The point of the space is that nothing leaks into the main session by accident, so the hand-off is explicit:

1. `ctrl+p` asks for a focus.
2. `1`-`4` insert a preset (`Conclusion and evidence`, `Decision and reason`, `Open questions`, `Rejected options`).
   You can edit the text or type any other focus instead. Empty means the default focus.
3. `Enter` rewrites the whole exchange into one message and shows it.
4. The preview is editable. `Enter` sends it as a user turn; `Esc` goes back; `ctrl+r` reformats.

`5` skips the rewrite and previews the raw transcript, which is the escape hatch for when the rewrite misses.
The rewrite prompt says: write in the first person, keep attribution for the other side's proposals
("an alternative was ..."), and output only the message body. Attribution matters — without it the main agent
reads someone else's suggestion as your own decision.

## What is and is not sent

- Nothing is written to the session file. There are no `appendEntry` calls and no messages.
- The main agent's context is untouched until you press `Enter` in the preview.
- The btw request carries the messages the main agent would have sent (the session branch with compaction applied),
  plus the exchange so far. It carries **no tool definitions**, so tool calls and results are flattened to text:
  a tool call becomes `(read を実行)`, a result becomes `(read の出力) ...`. Images are replaced with `(画像は省略)`.
- Because that prefix is identical to the main session's, providers with prefix caching usually charge the
  context at the cached rate. A long uncompacted session still means a large request per turn.

## Limitations

- The btw agent cannot read files or run commands; it only reasons over the session context. Read-only tools
  (`read`, `grep`, `find`, `ls`) are the planned next step.
- The context is a snapshot taken when `/btw` opens. Work done in the main session after that is not included.
  Reopening the space after a stash keeps the same snapshot.
- A stashed space is dropped when the session is replaced.

## Development

```sh
node packages/pi-byetheway/selfcheck.ts
```

Runs both self-checks: the context projection (tool-call and tool-result flattening, image dropping,
same-role merging, assistant metadata preservation) and the pi-facing surface (registered command/
shortcut/event, and that the private `ModelRuntime.stream` keeps its receiver).
