# Allow push and other git operations; reorganise at task boundaries

Three decisions, all about the same failure: an agent loop that the user keeps
extending.

1. The git guard narrows to `git commit` and `git reset --hard`. `push`,
   `merge`, `cherry-pick`, `rebase`, `add`, `stash` and the rest are allowed
   again (ADR-0006 blocked them).
2. A `git push` is not blocked either: the loop pauses, the pending checkpoint
   run is reorganised, and the same push then proceeds. If the reorganisation
   cannot run (`picker`/`review` mode, or it fails), the push is blocked with a
   message instead.
3. Reorganisation is triggered by the boundaries that end a unit of work — a
   new instruction from the user (the `input` event), a task completion the
   agent itself reports (a one-word classification call at `turn_end`), and
   `agent_end` — not by `agent_end` alone, with a backstop at
   `BACKSTOP_REORGANISE_AT` (10) pending checkpoints for a run that never
   reaches a boundary. The reorganiser never rewrites commits at or below the
   upstream tip: it reorganises only the un-pushed prefix and leaves the rest
   in history.

## Rationale

Blocking `push` was defensible while `agent_end` was the only reorganisation
trigger: a push before `agent_end` shipped raw checkpoints. In practice the
block is what makes the extension unusable for delegated work — an agent that
finished a task in a worktree cannot publish it, and a user who asked for "push
it" gets a refusal instead. The guard was protecting history that the user
wanted on the remote more than they wanted it pretty.

Making push "reorganise first, then go through" is what the user meant by
pushing: by then the work is finished. Blocking it and asking them to push
again would be a manual retry loop for a decision the extension can make.

The real bug was the trigger, not the guard. `agent_end` marks the end of the
whole loop, which a user can postpone indefinitely by typing follow-ups; the
checkpoints then accumulate across several tasks, and a change set spanning
many tasks is split by path bucket and, past the hard caps, aborts with
everything staged for manual repair. The end of a task is a fact the extension
can observe: `input` fires with `streamingBehavior: "followUp"` when a new
instruction is queued mid-run, and with `undefined` when the user is idle. A
count threshold was the first attempt at bounding the run; a user instruction is
the actual boundary, so the threshold is gone.

The count threshold is not gone, only demoted: boundaries cannot fire inside a
run where the user never types and the agent never pushes, so a run that reaches
10 pending checkpoints is split at `turn_end` anyway. Ten is the point past
which a single reorganisation starts being a whole run rather than a task; the
count is kept in memory between reorganisations, so the backstop costs nothing
per turn.

The user instruction is not the only boundary either. A single prompt can ask
for three things, and the agent finishes item one without any event firing —
the user is not typing, nothing is pushed. The only artefact of "item one is
done" is the turn itself, so `detectTaskBoundary` asks the model one question
about it: the request, the turn's text, the files it changed, and one word
back, `BOUNDARY` or `CONTINUE`. The call is small (thousands of characters in,
one token out, on the commit-message model), runs only in `auto` mode and only
for a turn with text, and every failure — no model, provider error, unparseable
answer — is `CONTINUE`. A wrong split shows up as extra commits; a missed split
is only a larger batch, so the default must be "keep going".

The cost is one short call per mutating turn, which is why
`detectTaskBoundary` is a config key: users who'd rather pay nothing set it to
`false` and keep the user-instruction, push and backstop triggers.

`streamingBehavior: "steer"` is deliberately excluded. Steering is a
correction mid-flight — the user wants it to reach the model immediately, not
after a multi-second LLM reorganisation, and the work being corrected is
probably about to change.

The assistant context that drives the split is the buffered messages since the
last reorganisation (at most 20), so a reorganisation after a long task still
sees the task's reasoning rather than one enormous conversation summary.

## Considered options

- **Keep blocking push and tell the user to push manually.** Rejected: it
  refuses the operation the user asked the agent to perform, in a session the
  user is watching.
- **Block the push, reorganise, then let the agent retry.** Rejected: it burns
  a turn, and the retry is mechanically identical to letting the original call
  proceed after the reorganisation, which is what the `tool_call` handler does.
- **Reorganise when the pending run reaches N checkpoints, as the only
  trigger (the first implementation).** Rejected as the only trigger: N is a
  guess about task length. Five turns of one task got review-quality commits;
  five turns spanning three tasks got unrelated turns folded together. It
  survives as the backstop for runs with no boundary at all.
- **Reorganise at every `turn_end`.** Rejected: one LLM call per turn costs
  more than one call per task, and mid-task diffs are often a single
  half-finished edit where a "logical split" is meaningless.
- **Detect the boundary from keywords in the assistant text** ("done", "完了",
  "next"). Rejected: the loop is bilingual, and missing a boundary is silent
  while a false one splits history, so a classifier that can read the turn is
  worth its small cost.
- **Let the agent mark boundaries in its own output** (a sentinel line or a
  todo tool call). Rejected for now: it needs prompt or tool injection into
  every agent run, and pi ships no todo tool to hook.
- **Leave the pushed-checkpoint case to `crossesRemoteTip`.** That guard aborts
  the whole reorganisation and leaves the changes staged. It stays for the
  manual range picker, but the automatic path caps its range instead, so a
  push does not disable reorganisation for the rest of the run.
- **Widen the guard to catch `git commit --no-verify`-style bypasses.** Out of
  scope: the `bash` tool layer already sees every command; bypass variety is a
  parsing arms race, not the failure being fixed here.

## Consequences

- `commit-policy.ts` keeps `shouldBlockGitCommit`, `shouldBlockGitHardReset`
  and the new `isGitPushCommand`. `shouldBlockGitPush`,
  `blockedInterleavingVerb` and `interleavingAllowedWithoutCheckpoints` are
  deleted, so `tool_call` no longer needs to read HEAD's subject.
- `reset --hard` stays blocked: it is the one irreversible case, and it
  destroys changes made since the last checkpoint. Everything else is the
  user's call.
- A push in `picker`/`review` mode is blocked even before anything is pending,
  because those modes decide at `agent_end` and cannot decide mid-run. Users in
  those modes keep pushing from their own terminal.
- A single very long run with no user instruction and no push is still one
  reorganisation at `agent_end`, bounded only by the path-bucket split. That is
  one task's worth of changes, which is the unit a commit range should have.
- Allowing `merge`, `cherry-pick` and `rebase` re-opens the stray-checkpoint
  case from ADR-0006: a foreign commit on top of the checkpoint run stops
  `countCheckpointCommits`, so the checkpoints below it are no longer
  reorganised automatically. They are recoverable with
  `/autocommit-organise <sessionId>`. `git merge --squash` remains the
  recommended integration.
- Checkpoints pushed before any reorganisation could happen (non-`auto` mode)
  stay in history as `wip(checkpoint)` and are reported; the un-pushed suffix
  is still reorganised.
- The reorganisation now runs inside an `input` handler and inside `tool_call`.
  Both are awaited by pi, so the user's follow-up and the push are delayed by
  the LLM call that produces their commits. That delay is the price of pushing
  organised history.
- Each mutating turn costs one boundary-classification call before the loop
  continues. Users who do not want it set `detectTaskBoundary: false`; the
  other triggers stay.
- The classifier needs two inputs the extension now tracks: the request
  (`before_agent_start`, refreshed by `input`) and the turn's assistant text.
  The text is captured at `message_end` and cleared at `turn_start`, because
  `turn_end` only guarantees the turn is over — when the turn ended on a tool
  result its `message` is that result, not the assistant's words.
