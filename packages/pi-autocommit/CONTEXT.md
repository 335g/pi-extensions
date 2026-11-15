# pi-autocommit

Vocabulary for the pi-autocommit extension, which automatically commits changes inside pi using a checkpoint-then-reorganise strategy so the user does not have to write commit messages.

## Committing

**Commit guard**
A safety measure that blocks two agent-initiated git commands during the agent loop when `enable` is true: the commit command (incl. `--amend`) and `reset --hard`. It intercepts the `bash` tool via the `tool_call` event. A commit would interleave a foreign commit into the checkpoint run at HEAD and stop the reorganiser's checkpoint scan there; `reset --hard` would destroy the index and working tree, including changes the current turn made after the last checkpoint. Everything else — push, merge, cherry-pick, rebase, add, stash, fetch — is allowed: the agent needs those to do real work. A push is not blocked but paused for a reorganisation first (see Push-first reorganisation); pushed history is protected by the upstream cap. The block reason follows the configured commit-message language (Japanese when `lang` is Japanese, English otherwise) and notes that the guard is lifted via `/autocommit-enable false`. When `enable` is false, the guard is inert and the agent may use git freely.
_Avoid_: commit blocker, commit firewall

**Task boundary**
A point where a unit of work ends and the pending checkpoint run is reorganised: a new instruction from the user (the `input` event, including one queued while the agent is still running), a turn the agent itself reports as finishing a requested item (see Task completion check), and `agent_end`. Mid-flight steering (`streamingBehavior: "steer"`) is not a boundary — the user wants the correction to land immediately. `turn_end` only buffers the assistant message as commit-message context; a run that never reaches a boundary is split by the turn backstop. See ADR-0015.
_Avoid_: mid-run reorganisation, batch size

**Task completion check**
The one-word classification call made at `turn_end` by `detectTaskBoundary`: the user request, the turn's text and the files it changed go in; `BOUNDARY` (the turn finished a self-contained piece of the request, including a finished numbered item) or `CONTINUE` comes back. Only an explicit `BOUNDARY` splits, and every failure — no model, provider error, unparseable answer, a turn with no text — is `CONTINUE`. Runs only in `organiseMode: "auto"`; disabled with `detectTaskBoundary: false`.
_Avoid_: boundary classifier, semantic trigger

**Turn backstop**
The reorganisation forced at `turn_end` when `BACKSTOP_REORGANISE_AT` (10) checkpoints have accumulated since the last one, because no boundary (`input`, push, `agent_end`) arrived. The count lives in memory and is reset by a successful reorganisation. `picker`/`review` skip it, as they skip the other mid-run passes. See ADR-0015.
_Avoid_: batch trigger

**Upstream cap**
The rule that a reorganisation never rewrites commits at or below the upstream tip. When the checkpoint run extends past it (a push from another terminal), only the un-pushed prefix is reorganised and the older pushed checkpoints stay in history as `wip(checkpoint)`; a notice reports how many were left alone. See ADR-0015.
_Avoid_: remote-tip abort

**Push-first reorganisation**
The handling of a push while checkpoint commits are pending: the `tool_call` handler pauses the loop, reorganises the run through the normal automatic path, and then lets the same command through. In `picker`/`review` mode, or when the reorganisation fails, the push is blocked instead. See ADR-0015.
_Avoid_: push guard, push retry

**Auto-commit**
Committing changes automatically without interactive confirmation, driven by the `enable` configuration.
_Avoid_: background commit, silent commit

**Session enable snapshot**
The `enable` value captured once at `session_start` and kept in memory for that session. `/autocommit-enable` still writes `.pi/pi-autocommit.json` (so later sessions read the new value) but only changes the current session's snapshot, so a toggle in one session never enables or disables another running session.
_Avoid_: global enable, shared flag

**Checkpoint commit**
A lightweight, temporary commit created during an agent loop to capture the state after a single turn. Checkpoint commits are later reorganised into final commits.
_Avoid_: WIP commit, scratch commit

**Checkpoint session**
The pi session that owns a checkpoint commit. Recorded as a `Checkpoint-Session: <sessionId>` Git trailer on each checkpoint commit so that the reorganiser can limit its scope to the current session when multiple sessions share history.
_Avoid_: session id (ambiguous), commit owner

**Checkpoint branch**
The origin branch of a checkpoint commit, recorded as a `Checkpoint-Branch: <branch>` Git trailer (the worktree branch the checkpoint was created on). Lets merged checkpoints be traced back to the delegated worktree that produced them; shown in the commit picker and `/autocommit-organise` session completions.
_Avoid_: origin, source branch

**Stray checkpoint**
A checkpoint commit left un-reorganised in the branch, typically because its owning session crashed before `agent_end`. The manual `/autocommit-organise` command lets a later session reorganise stray checkpoints by selecting a checkpoint session from a popup.

**Merged checkpoint**
A stray checkpoint from another session that entered the branch via a merge (e.g. a delegated worktree agent crashed before `agent_end` and its branch was merged as-is). Its changes are already in the tree and it cannot be reassembled by the manual scattered path (re-applying the diff is a no-op), so it stays in history as `wip(checkpoint)`. Detected at `session_start` (foreign-session checkpoints in the un-pushed range vs the upstream tip) and `agent_end` (`findCheckpointsSince` baseline..HEAD, filtered to foreign sessions); the prevention is integrating with `git merge --squash`.
_Avoid_: leak, foreign checkpoint

**Commit pipeline**
The sequence of steps that stages files, generates a commit message, and executes the commit. Used by auto-commit.
_Avoid_: commit flow, commit handler

**Commit reorganiser**
The component that analyses checkpoint commits at the end of an agent loop and splits them into logical, well-described Conventional Commits.
_Avoid_: commit splitter, commit cleaner

**Similar previous commit group merge**
Extending `agent_end` reorganisation past the checkpoint run and into the *previous commit group* directly below it — contiguous commits no more than 10 seconds apart in committer time, which is how the multiple logical commits one `agent_end` produced appear. When any member of that group is a Conventional Commit whose changed-file set mostly overlaps a group proposed for the checkpoint run (Jaccard similarity — shared ÷ union — of at least 0.5) and whose `type(scope)` matches it, and no member is pushed, the checkpoint run and the whole group are soft-reset together and the combined diff is re-organised from scratch. A pushed group is never rewritten; it is left intact and a notice is shown. Controlled by `mergeSimilarPrevious` (default `true`).
_Avoid_: auto-amend, commit folding

**Commit strategy**
The checkpoint-then-reorganise strategy: lightweight checkpoint commits are created during the agent loop and reorganised into logical Conventional Commits at `agent_end`.
_Avoid_: commit mode, commit timing

**Agent baseline HEAD**
The HEAD commit SHA captured at `agent_start`. At `agent_end`, pi-autocommit compares the current HEAD against this baseline; if they are identical, the commit reorganiser (and the TUI commit picker popup) is skipped because the agent run produced no commits.
_Avoid_: initial HEAD, session HEAD, starting HEAD

## Commit message generation

**Commit prompt module**
The deep module that owns prompt assembly, the LLM-call adapter, response cleanup,
and deterministic scope injection for commit messages. Has two interface methods
(one for single-commit generation falling back to the heuristic, one for commit-group
proposition that throws on inference failure). Replaces the duplicated prompt logic
that previously lived inline in the single-commit and reorganiser paths.
_Avoid_: prompt builder, LLM wrapper

**Commit message model**
The LLM model used to generate commit messages. Specified in `config.model` in `"provider/modelId"` format. When omitted, the session's current model (the one driving the conversation) is used as a fallback.
_Avoid_: commit model, LLM model

**Scope mapping**
A user-defined mapping from changed file paths to a fixed Conventional Commits scope, specified in `.pi/pi-autocommit.json` under `scope`. When present, the commit scope is determined by a deterministic path-matching module rather than the LLM, so the scope stays stable across reorganised commits.
_Avoid_: scope config, scope rules

**Commit message language**
The language of generated commit messages, resolved by priority: the `lang` config when set, otherwise auto-detected from the user's messages, otherwise English. The language name is passed to the LLM prompt; the heuristic fallback only supports Japanese and English.
_Avoid_: locale, i18n

**Language auto-detection**
Resolving the commit message language from the user's messages when `lang` is unset, by inspecting character scripts (kana → Japanese, hangul → Korean, han → Chinese, Cyrillic → Russian). Only user messages are considered; Latin-script conversations are undetectable and fall back to English.
_Avoid_: language detection (this is scoped to commit messages)

## Manual operations

**Manual organise command**
A slash command (`/autocommit-organise`) that reorganises checkpoint commits on demand. With no argument it reorganises all checkpoint commits at HEAD; when a checkpoint session is chosen from a popup, it reorganises only that session's checkpoints, including scattered stray checkpoints.
_Avoid_: organize command, manual commit, /organize

## Interactive reorganisation

**Commit picker**
A popup that lists recent commits and lets the user select a range to squash and reorganise. `wip(checkpoint):` commits are auto-selected (`[1]` at HEAD, `[2]` at the last checkpoint). The user can extend the range to include non-checkpoint commits by moving the cursor and pressing `1` / `2`. Shown at `agent_end` when the organise mode is `picker`, and always by `/autocommit-organise`.

**Organise mode**
How much control `agent_end` hands over before checkpoints are reorganised, as a ladder: `auto` (the default) reorganises the checkpoint run silently, `picker` stops on the commit picker so the range is chosen by hand, `review` adds the partition editor and the commit review dialog on top of the picker. Persisted as `organiseMode`, switched by `/autocommit-mode` (no argument cycles), and mirrored in the footer. `picker` and `review` are the manual form of what `mergeSimilarPrevious` decides on its own, so the automatic downward merge does not run in those modes — the user draws the range instead.
_Avoid_: interactive mode, confirm mode

**Commit review dialog**
The per-commit confirmation `review` mode runs between proposition and commit: each proposed group is shown with its message and files, confirming keeps it, and rejecting opens pi's multi-line editor prefilled with the proposed message. Cancelling the editor aborts the whole reorganisation — no commit is made, the soft reset is left in place with every change staged (the same state the oversized-diff abort uses), and in the range picker's slow path the pre-operation HEAD is restored. It is preceded by a gate dialog asking whether to edit the split, whose body lists every proposed group at once; declining it goes straight to the per-commit dialogs.
_Avoid_: commit preview, message approval

**Partition editor**
The `ctx.ui.editor()` buffer the review gate opens when the user wants to change *which files go into which commit*: one `## subject` header per proposed group followed by its file paths. Moving a line under another header reassigns the file, deleting a line leaves that file uncommitted, and editing or adding a header changes the split; an untouched buffer round-trips to the original proposal. A header whose subject still matches a proposal keeps that group's body, any other header becomes a subject-only message the per-commit dialog can expand. Parsing is validated against the staged set — an unknown path, a path claimed twice, or a file line above any header re-opens the editor with the complaint prepended instead of committing a partition the user did not write. A header left with no files is a deleted commit.
_Avoid_: split editor, file assignment UI

**Dropped file**
A staged file the reviewed groups no longer claim, because its line was deleted in the partition editor. `commitReviewedGroups` unstages it before `commitGroups` runs, so the coverage guard still sees every remaining staged file claimed exactly once, and the paths are named in a notice. It survives as an uncommitted working-tree change, which the next `turn_end` checkpoint will sweep into an unrelated commit unless the user deletes or reverts it first.
_Avoid_: excluded file, unstaged leftover

**Range-based reset**
`git reset --soft HEAD~{N}` where N is the depth of the oldest selected commit from HEAD. All changes in the selected range become staged and are fed to the reorganiser's LLM pipeline for splitting into logical Conventional Commits.
_Avoid_: interactive squash, range squash

**Organise progress indicator**
A TUI element shown while the commit reorganiser is running, indicating that reorganisation is in progress. It is dismissed when the reorganiser finishes or when an error occurs, at which point a completion or error message replaces it.
_Avoid_: spinner, loading icon, organise loader

## Status

**Uncommitted-changes indicator**
A footer element that shows whether the working tree has uncommitted changes. Its purpose is to give the user a pre-commit cue to spot unintended files before a checkpoint commit captures them.
_Avoid_: status badge, dirty flag

**Organise-mode indicator**
A footer element that shows the active organise mode (`[auto]` / `[picker]` / `[review]`) while auto-commit is enabled, and nothing when it is disabled — the mode only means something while checkpoints are being made. Read from the config on every update so a `/autocommit-mode` switch is visible immediately.
_Avoid_: mode badge, footer mode

## Submodules

**Gitlink**
The parent repository's index entry for a submodule (file mode 160000). It pins the checked-out commit of the submodule by SHA. A submodule's own working-tree changes are not visible in the parent's index; only a changed gitlink (a `Subproject commit` pointer diff) can be recorded by the parent.
_Avoid_: submodule pointer, submodule reference

**Submodule-internal change**
A change inside a submodule's working tree that the parent repository cannot stage: the gitlink is unchanged, so `git add -A` in the parent stages nothing. The only parent-side record of such a change is a gitlink update, which requires the submodule to have been committed first (manually).
_Avoid_: nested change, submodule edit

**Detached-orphan submodule commit**
A commit on a submodule's HEAD that differs from the parent gitlink and is unreachable from any branch or tag. Running `git submodule update` checks out the gitlink SHA and leaves the orphaned commits reachable only via the reflog, effectively discarding them. pi-autocommit detects this state and warns; commits on a real branch survive an update and are not reported.
_Avoid_: lost commit, dangling submodule commit

**Manual submodule mode**
The baseline approach to submodules: pi-autocommit never commits inside a submodule. The user commits changes inside submodules (e.g. from another terminal); by default the parent records the resulting gitlink updates and warns about detached-orphan submodule commits. Recursive auto-commit into submodules is deliberately out of scope (see ADR-0008).
_Avoid_: recursive mode, submodule auto-commit

**Ignored submodule change**
A parent-side diff that `ignoreSubmodules` keeps out of auto-commits: a gitlink update (mode 160000 index entry, covering absorbed embedded repositories too) or a `.gitmodules` change. It is never staged by checkpoints or the reorganiser; the pin update stays visible as an uncommitted change until the user records it manually. Detached-orphan detection still applies to it, surfaced as an informational session-start notice (see ADR-0009).
_Avoid_: skipped submodule diff, hidden submodule change
