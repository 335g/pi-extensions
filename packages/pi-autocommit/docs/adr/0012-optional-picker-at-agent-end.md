# Optional picker at agent_end via an organise mode

ADR-0007 made `agent_end` fully automatic and ADR-0010 rejected an interactive
confirmation outright ("a popup every `agent_end` would defeat the
zero-interaction design"). Both decisions assumed one user with one preference.
In practice the preference changes during a day: most runs should stay silent,
but a run whose commits you intend to shape — a refactor you want squashed into
the previous one, a mixed bag you want split differently — is exactly when
stopping to choose the range is worth more than the interruption. We decided to
make the popup a mode rather than a default.

`organiseMode` is `auto` (the default, unchanged behaviour) or `picker`
(`agent_end` stops on the existing commit picker before reorganising). It is
persisted in `.pi/pi-autocommit.json`, switched by `/autocommit-mode` (an
argument sets it, no argument cycles), and mirrored in the footer next to the
uncommitted-changes cue so the current behaviour is visible without reading the
config.

`picker` reuses the picker and `reorganiseSelectedRange` that
`/autocommit-organise` already drives; nothing new is rendered and no new git
path is added. `/autocommit-organise` keeps showing the picker in every mode,
because there the popup is the thing that was asked for.

In `picker` mode the automatic downward merge of ADR-0010/0011 does not run:
the picker's default range is the checkpoint run at HEAD and extending it with
`1` / `2` is the manual form of the same decision. Two mechanisms drawing the
same range would only compete. Cancelling with `Esc` leaves the checkpoints in
history, which `/autocommit-organise` can pick up later — the run is not lost.

## Considered Options

- **Always show the picker** — rejected: it is the ADR-0007/0010 objection, and
  it taxes every run to help a few.
- **Per-run flag instead of a persisted mode** (e.g. a keybinding that arms the
  next `agent_end`) — rejected as the first step: it needs new keybinding
  plumbing and nothing to show the armed state, while a persisted mode reuses
  the config, the slash command and the footer that already exist. Worth
  revisiting if switching modes turns out to be too coarse.
- **A boolean `interactiveAtAgentEnd`** — rejected in favour of a string enum:
  the next step (reviewing the proposed groups before they are committed) is a
  third level of the same ladder, and an enum grows where a boolean would need
  a second, overlapping flag.
- **Running `mergeSimilarPrevious` on top of the picked range** — rejected: the
  range the user drew is the answer, and silently widening it again would
  defeat the point of picking.

## Consequences

- `agent_end` can now block on user input. Only in `picker` mode, only in the
  TUI; the non-TUI path keeps falling back to the automatic reorganise.
- The footer carries a second status element, so the mode is discoverable
  without documentation.
- ADR-0007's "no popup at `agent_end`" and ADR-0010's rejection of interactive
  confirmation hold only for the default mode.
