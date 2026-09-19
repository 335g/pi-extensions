# pi-answer

[日本語](./README.ja.md)

Extract questions from the last assistant message and answer them in an interactive Q&A TUI.

Port of [mitsuhiko/agent-stuff `answer.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/answer.ts).

## Usage

- `/answer` — extract questions from the last assistant message
- `/answer 2` — extract from the assistant message before that (`3`, `4`, ... go further back)
- `ctrl+.` — same as `/answer`

Flow: questions are extracted with the configured extraction model (the session model by default), shown one at a time in
a box, followed by a free-space step for notes, then reviewed as a whole, then submitted as one message that triggers a
turn.

Keys:

- Answering: `Tab`/`Enter` next, `Shift+Tab` prev, `Shift+Enter` newline, `1`-`9` insert an option, `Ctrl+X` exclude
the question, `Esc` cancel
- Review: `Enter`/`y` submit, `Esc`/`n` back to the first question, `l` to the last question
- Cancel dialog: `Enter`/`y` discard, `Esc`/`n` keep editing. The dialog only appears when something has been entered;
with empty answers `Esc` discards immediately.

The extraction model may attach `options` (2-4 short answers) to a question. They are listed under it and inserted at the
cursor with `1`-`9`, but only while the answer is empty, so digits stay typeable and you can append an annotation after
picking one (`はい` -> `はい、ただし本番のみ`). `Ctrl+X` drops the question; it is not added to the message and the
remaining questions are renumbered.

## Configuration

`pi-answer.json`, read on every `/answer`, so no restart is needed. A project file overrides the global one key by key,
and is only read for trusted projects (`ctx.isProjectTrusted()`):

| Location | Scope |
|----------|-------|
| `~/.pi/agent/pi-answer.json` | global |
| `.pi/pi-answer.json` | project |

```json
{ "lang": "ja_JP.UTF-8", "model": "anthropic/claude-haiku-4-5" }
```

- `lang` — locale in the same format as `LANG` (e.g. `ja_JP.UTF-8`); only the language prefix matters. Unset: `LC_ALL`,
  then `LANG`.
- `model` — extraction model as `provider/modelId` or bare `modelId`. Unset: the session model. If it matches no
  available model, a warning is shown and the session model is used.

Submitted text is a numbered markdown block (`### Q1: ...` / `Context: ...` / `Answer: ...`), followed by a
`### Notes` section when the free-space step has text. Unanswered questions are omitted from the message, so a gap in
the numbering means "skipped". If nothing was answered and no notes were written, nothing is sent
(`No answers to submit`). The review screen is that message verbatim — the same string is rendered and sent, with no
truncation and no placeholder lines.

The wrapper forwards TUI focus to the inner editor so the editor emits `CURSOR_MARKER`. That keeps the IME preedit
(unconverted Japanese input) on the answer line instead of at the bottom of the box.
