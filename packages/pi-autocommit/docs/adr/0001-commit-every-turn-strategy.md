# Auto-commit strategy: `turn_end` checkpoints with `agent_end` reorganisation

The auto-commit feature uses a checkpoint-then-reorganise strategy:
checkpoint commits are created at each file-mutating `turn_end`, and
at `agent_end` they are soft-reset and reorganised into logical
Conventional Commits by the LLM.

Previously there was also a simpler `agent_end` trigger that committed
all changes once per agent loop without checkpoints. That mode has
been removed; the checkpoint strategy is the only available behaviour
when `enable` is true.

## Rationale

A single agent request can produce many changes across multiple turns
(for example, a goal command). Committing only at `agent_end` without
checkpoints risks losing intermediate state if the loop is interrupted,
while committing blindly at every `turn_end` produces noisy history.
Checkpoints give safety and recovery, and the final reorganisation step
lets an LLM split the combined diff into coherent commits using the
assistant's own reasoning as context.

## Consequences

- `enable` is a boolean (default `true`): enables the checkpoint strategy.
  (Formerly `commitEveryTurn`; renamed in the `pi-git` → `pi-autocommit`
  rename — see ADR 0002.)
- Checkpoint commits use `wip(checkpoint):` message prefix as a marker.
  The reorganiser looks for that prefix when deciding how far to
  `git reset --soft`.
- The reorganiser calls the LLM via `completeSimple` so the prompt is
  not visible in the conversation history.
- If LLM reorganisation fails, the extension falls back to a single
  Conventional Commit containing all checkpointed changes.
