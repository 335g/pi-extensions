# Plan: Move UI notifications out of the commit pipeline

> **2026-07-10 note**: This plan is a historical record from the `pi-git` era. The extension was later renamed (`pi-git` → `pi-autocommit`) and narrowed to auto-commit only (`/git-commit`, `/git-status` removed). See ADR 0002.

> **2026-07-05 update**: This plan was completed. After completion,
> `/git-review` command and `agent_end` standalone commit mode were
> removed. The pipeline now only serves `/git-commit` and checkpoint
> auto-commit. The `reviewer.ts` module has been deleted.

Candidate 1 from architecture review. Deepen the commit pipeline module
by removing embedded `ctx.ui.notify` / `ctx.ui.setStatus` calls.

## Current state

`ctx.ui.*` UI calls are scattered across business-logic modules:

| File | Line | Call |
|---|---|---|
| `src/pipeline.ts` | 162 | `ctx.ui.notify("Not a git repository", "error")` |
| `src/pipeline.ts` | 168 | `ctx.ui.notify("Merge conflict...", "error")` |
| `src/pipeline.ts` | 178 | `ctx.ui.notify("No changes to commit", "info")` |
| `src/pipeline.ts` | 226 | `ctx.ui.notify("Commit cancelled..." / "No files selected...", "info")` |
| `src/pipeline.ts` | 269 | `ctx.ui.notify("Generating commit message via LLM...", "info")` |
| `src/pipeline.ts` | 286 | `ctx.ui.notify("Commit cancelled.", "info")` |
| `src/pipeline.ts` | 300 | `ctx.ui.notify("[DRY RUN]...", "info")` |
| `src/pipeline.ts` | 315 | `ctx.ui.notify("Committed successfully:...", "info")` |
| `src/pipeline.ts` | 142-154 | `ctx.ui.setStatus(...)` in `updateFooter` + error boundary |
| `src/commit-organizer.ts` | 73 | `ctx.ui.notify("Organised...", "info")` |
| `src/commit-organizer.ts` | 85 | `ctx.ui.notify("commitEveryTurn: reorganisation failed —...", "error")` |
| `src/commit-organizer.ts` | 333 | `ctx.ui.notify("Reorganisation fell back...", "info")` |
| `src/commit-organizer.ts` | 342-358 | `updateFooterStatus` duplicates pipeline's `updateFooter` |

These are 13+ direct UI calls plus two copies of the footer-status helper.

## Target state

```
pipeline.ts / commit-organizer.ts          index.ts
┌────────────────────────────────┐          ┌────────────────────┐
│  return structured events      │          │                    │
│  (no ctx.ui.* calls)           │  events  │  presenter()       │
│                                │ ────────→│  ctx.ui.notify()   │
│                                │          │  ctx.ui.setStatus()│
└────────────────────────────────┘          └────────────────────┘
```

- `runCommitPipeline` returns a `PipelineResult` carrying any events (or
  throws on fatal errors).
- `organizeWipCommits` returns a similar `OrganizerResult`.
- A thin `CommitPresenter` (or inline function in index.ts) maps those
  results to UI calls.
- Real-time progress (e.g. "Generating…" before LLM call) uses an optional
  `onProgress` callback so UX feedback stays immediate.
- Footer-status invariants are extracted into a shared `StatusIndicator` module
  used by index.ts on both success and error paths.
- Error boundary cleanup (unstageAll) stays in the pipeline. Footer status
  is updated by index.ts's catch blocks, not by events lost on throw.

## Steps

### Step 1 — Define event / result / callback types

New file `src/commit-events.ts`:

```typescript
export type PipelineEvent =
  | { type: "info"; message: string }
  | { type: "error"; message: string }
  | { type: "dry-run"; message: string }
  | { type: "committed"; message: string }
  | { type: "cancelled"; reason: string }
  | { type: "generating" }          // for progress callback only
  | { type: "stage-changed"; hasChanges?: boolean };  // footer status changed

export interface PipelineResult {
  events: PipelineEvent[];
  /** true when the commit was actually executed */
  committed: boolean;
}

/**
 * Optional callbacks for real-time progress during pipeline execution.
 * These fire synchronously within the pipeline so the caller can update
 * the UI *before* an async step completes (e.g. LLM generation).
 */
export interface PipelineCallbacks {
  onProgress?: (event: PipelineEvent) => void;
}
```

For the organizer:

```typescript
export type OrganizerEvent =
  | { type: "info"; message: string }
  | { type: "error"; message: string }
  | { type: "organised"; checkpointCount: number; commitCount: number }
  | { type: "fallback"; message: string }
  | { type: "stage-changed"; hasChanges?: boolean };

export interface OrganizerResult {
  events: OrganizerEvent[];
  organised: boolean;
}
```

Note: PipelineEvent and OrganizerEvent are intentionally separate types.
The presenter in index.ts handles them with two switch statements;
a shared supertype would add abstraction without reducing duplication.

### Step 2 — Collect events in pipeline.ts, remove ctx.ui.*

Replace each `ctx.ui.notify(...)` with `events.push({ type: ..., message: ... })`.

The special case at line 269 — `ctx.ui.notify("Generating commit message via LLM...")` —
is a *progress indicator* that fires before an async LLM call. An events-array
cannot express this because it becomes available only after the function returns.
Use the `onProgress` callback instead:

```typescript
if (callbacks?.onProgress) {
  callbacks.onProgress({ type: "generating" });
}
fullMessage = await generateCommitMessageWithLLM(...);
```

Keep error-boundary cleanup (unstageAll) in the pipeline. The `updateFooter`
closure in pipeline.ts is removed entirely — footer status is handled by
index.ts catch blocks (see Step 5), not by events that would be lost on throw.

Events for footer status changes are still emitted for the non-throw paths:

```typescript
events.push({ type: "stage-changed", hasChanges });
```

Pipeline returns `PipelineResult { events, committed }` at every normal exit
point (early return, success, cancellation). The error boundary runs cleanup
(unstageAll) and re-throws; no events are appended there.

### Step 3 — Collect events in commit-organizer.ts

Same pattern: replace `ctx.ui.notify(...)` with `events.push(...)`.

`updateFooterStatus` becomes `events.push({ type: "stage-changed", hasChanges })`.

The error catch block uses `events.push({ type: "error", message })` instead
of `ctx.ui.notify(...)`. Footer-update-on-throw is handled by index.ts's
catch block (same pattern as pipeline).

#### `fallbackSingleCommit` event plumbing

`fallbackSingleCommit(pi, ctx, config, git)` currently calls
`ctx.ui.notify(...)` internally. After the refactor, it has no access to the
events array. Solution: accept `events: OrganizerEvent[]` as a parameter:

```typescript
async function fallbackSingleCommit(
  pi: PiClient,
  ctx: ExtensionContext,
  config: Config,
  git: GitOperations,
  events: OrganizerEvent[],
): Promise<void> {
  // ...
  events.push({ type: "fallback", message: "Reorganisation fell back to a single commit" });
}
```

Both call sites (try-block and catch-block inside `organizeWipCommits`) pass
their local `events` array.

### Step 4 — Shared StatusIndicator

Extract `updateFooterStatus` into `src/status-indicator.ts`:

```typescript
export class StatusIndicator {
  constructor(private git: GitOperations, private ctx: ExtensionContext) {}
  async updateFooter(): Promise<void> { /* existing logic */ }
}
```

Used by index.ts (the presenter) when it receives `stage-changed` events
OR catches an error from pipeline/organizer. Pipeline and organizer never
import `StatusIndicator`.

### Step 5 — Presenter in index.ts

Each handler wraps its pipeline/organizer call and maps events to UI.
The presenter has two responsibilities:
1. **Real-time**: pass a `PipelineCallbacks` object with `onProgress` to the pipeline.
2. **Post-hoc**: iterate over `result.events` after the pipeline returns.
3. **Error path**: call `statusIndicator.updateFooter()` in catch blocks.

Pattern for `/git-commit` handler:

```typescript
const statusIndicator = new StatusIndicator(git, ctx);

try {
  const result = await runCommitPipeline(pi, ctx, config, {
    ...opts,
    callbacks: {
      onProgress: (event) => {
        // Real-time progress before async steps complete
        if (event.type === "generating") {
          ctx.ui.notify("Generating commit message via LLM...", "info");
        }
      },
    },
  });

  // Post-hoc event playback
  for (const event of result.events) {
    switch (event.type) {
      case "info":        ctx.ui.notify(event.message, "info"); break;
      case "error":       ctx.ui.notify(event.message, "error"); break;
      case "dry-run":     ctx.ui.notify(event.message, "info"); break;
      case "committed":   ctx.ui.notify(event.message, "info"); break;
      case "cancelled":   ctx.ui.notify(event.message, "info"); break;
      case "stage-changed": await statusIndicator.updateFooter(); break;
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`git-commit error: ${message}`, "error");
  await statusIndicator.updateFooter();  // ← catch-block invariant
}
```

Pattern for `agent_end` handler (calls `organizeWipCommits`):

```typescript
try {
  const result = await organizeWipCommits(pi, ctx, config, event);
  for (const event of result.events) {
    switch (event.type) {
      case "info":      ctx.ui.notify(event.message, "info"); break;
      case "error":     ctx.ui.notify(event.message, "error"); break;
      case "organised": ctx.ui.notify(`Organised ${event.checkpointCount} checkpoint(s) into ${event.commitCount} commit(s).`, "info"); break;
      case "fallback":  ctx.ui.notify(event.message, "warning"); break;
      case "stage-changed": await statusIndicator.updateFooter(); break;
    }
  }
  await statusIndicator.updateFooter();  // ← ensure footer updated after success
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`commitEveryTurn: ${message}`, "error");
  await statusIndicator.updateFooter();
}
```

#### `turn_end` handler pattern (calls `runCommitPipeline` with `inlineMessage`)

```typescript
// turn_end sets inlineMessage so no onProgress needed
try {
  const result = await runCommitPipeline(pi, ctx, config, opts);
  // Same event loop as /git-commit, but no "generating" event
  for (const event of result.events) {
    switch (event.type) {
      case "info":        ctx.ui.notify(event.message, "info"); break;
      case "error":       ctx.ui.notify(event.message, "error"); break;
      case "dry-run":     ctx.ui.notify(event.message, "info"); break;
      case "committed":   ctx.ui.notify(event.message, "info"); break;
      case "cancelled":   ctx.ui.notify(event.message, "info"); break;
      case "stage-changed": await statusIndicator.updateFooter(); break;
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`Automatic commit error: ${message}`, "error");
  await statusIndicator.updateFooter();
}
```

#### `git-review` handler pattern

The `/git-review` handler intercepts `ReviewSendToAgentError` and
`ReviewCancelledError` before the generic catch. After refactor, both
branches must call `statusIndicator.updateFooter()` since `unstageAll`
(now the only cleanup in the error boundary) has already run:

```typescript
try {
  // ... review flow that calls the pipeline ...
  for (const event of result.events) {
    switch (event.type) {
      // ... same event loop ...
    }
  }
} catch (error) {
  if (error instanceof ReviewSendToAgentError) {
    ctx.ui.notify("Review sent to agent.", "info");
    await statusIndicator.updateFooter();  // ← must update footer
    return;
  }
  if (error instanceof ReviewCancelledError) {
    await statusIndicator.updateFooter();  // ← must update footer
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`Review error: ${message}`, "error");
  await statusIndicator.updateFooter();
}
```



#### Safety: `onProgress` callback throw guard

The pipeline should wrap the `onProgress` callback in a try-catch to prevent
a misbehaving callback from aborting the pipeline:

```typescript
// In pipeline.ts, inside the LLM branch:
try {
  callbacks?.onProgress?.({ type: "generating" });
} catch {
  // Swallow callback errors — the pipeline must not be interrupted by a
  // misbehaving presenter callback. The presenter is responsible for
  // handling its own errors.
}
fullMessage = await generateCommitMessageWithLLM(...);
```

This is a defensive measure: the pipeline never awaits the callback and
doesn't depend on its result, but it should still protect itself from
synchronous throw.

### Step 6 — Update tests

- `src/pipeline.test.ts` new: verify `PipelineResult.events` content for
  each path (success, cancellation, no changes, merge conflict, dry-run).
- `src/pipeline.test.ts` new: verify `PipelineCallbacks.onProgress` is
  invoked before the LLM call when `callbacks` is provided, and not invoked
  when `inlineMessage` is set.
- `src/commit-organizer.test.ts` new: verify `OrganizerResult.events`.
- `src/status-indicator.test.ts` new: verify footer update calls.
- Existing tests (reviewer, git-parser, commit-decider, config) are unchanged.

### Files changed

| File | Change |
|---|---|
| `src/commit-events.ts` | **New** — event/result types |
| `src/pipeline.ts` | Remove ctx.ui.*, collect events, add `callbacks` to options, return PipelineResult |
| `src/commit-organizer.ts` | Remove ctx.ui.*, collect events, return OrganizerResult |
| `src/status-indicator.ts` | **New** — shared footer-status updater |
| `src/index.ts` | Present events to UI, use StatusIndicator |
| Various test files | New tests for event content |

### Files unchanged

`src/reviewer.ts` — its UI calls (ctx.ui.notify + ctx.ui.select) are part of
the review-flow control, not the pipeline. Those are legitimately interactive
and stay.

`src/confirmation.ts` — its UI calls are the confirmation loop contract;
the pipeline's `onMessageGenerated` hook calls them.

`src/file-selector.ts` — the file selection UI is a presentation concern by
nature; the pipeline calls `selectFiles` as a seam. Not touched.

`src/llm-commit.ts`, `src/commit-message.ts`, `src/git-operations.ts`,
`src/args.ts`, `src/git-parser.ts`, `src/commit-types.ts`,
`src/commit-decider.ts`, `src/status-viewer.ts`, `src/config.ts` — no changes.

## Open questions

1. **Should pipeline still accept `ctx` (for file-selector and hooks)?**  
   Yes — `ctx` is still needed for `selectFiles` (which calls `ctx.ui.custom`)
   and for hook implementations. The change only removes *pipeline's own*
   direct UI calls; dependencies that need ctx still receive it.

2. **Combined callbacks + return value?**  
   Events array for post-hoc assertions and deterministic ordering.
   Optional `onProgress` callback for real-time progress before async steps
   complete. The callback is a *fire-and-forget notification* — the pipeline
   never awaits it and doesn't depend on its result. This avoids the async
   overhead of a full callback-per-step approach while preserving UX.

3. **Does the error boundary need `updateFooter`?**  
   No — after the refactor, footer status is the caller's responsibility.
   The error boundary runs unstageAll cleanup and re-throws; `updateFooter`
   happens in each caller's catch block (index.ts). This is safe because
   every pipeline caller already has a catch block that notifies errors.

4. **How does `organizeWipCommits`'s fallback (which calls
   `generateCommitMessageWithLLM` → may throw) interact?**  
   The current error boundary in `organizeWipCommits` already nests
   `fallbackSingleCommit` in an inner try-catch. That stays; the inner
   catch emits `events.push({ type: "error", message })` instead of
   `ctx.ui.notify(...)`.

5. **Is the `onProgress` callback throw-safe?**  
   Added a defensive try-catch in pipeline.ts (Step 5). The presenter
   is responsible for its own error handling.

6. **Does `git-review`'s specific error branches need footer updates?**  
   Yes — added to Step 5. These are `ReviewSendToAgentError` and
   `ReviewCancelledError` intercepts that `return` early before the
   generic catch block.
