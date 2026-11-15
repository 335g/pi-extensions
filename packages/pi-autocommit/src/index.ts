import {
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { GitCheckpointStore } from "./checkpoint-store.js";
import type { PipelineEvent } from "./commit-events.js";
import { extractAssistantContext } from "./commit-prompt.js";
import type { ReviewGroupsFn } from "./commit-prompt.js";
import {
  CHECKPOINT_COMMIT_MARKER,
  organizeCheckpointCommits,
  reorganiseCheckpointsManual,
  reorganiseSelectedRange,
} from "./commit-organizer.js";
import {
  buildCommitItems,
  type CommitItem,
  showCommitPicker,
} from "./commit-picker.js";
import {
  BACKSTOP_REORGANISE_AT,
  buildBlockReason,
  isGitPushCommand,
  shouldBlockGitCommit,
  shouldBlockGitHardReset,
  shouldCreateCheckpointCommit,
  shouldReorganiseAtBackstop,
  shouldSkipReorganisation,
} from "./commit-policy.js";
import {
  initSessionEnable,
  isJapanese,
  isOrganiseMode,
  isSessionEnabled,
  loadConfig,
  ORGANISE_MODES,
  type OrganiseMode,
  type PiAutocommitConfig,
  saveEnable,
  saveModel,
  saveOrganiseMode,
  setSessionEnable,
} from "./config.js";
import { GitOperations } from "./git-operations.js";
import { reviewCommitGroups } from "./group-review.js";
import { validateModelString } from "./llm-commit.js";
import { CLEAR_VALUE, showModelPopup } from "./model-popup.js";
import { GitPickerStore, type PickerStore } from "./picker-store.js";
import { runCheckpointCommit } from "./pipeline.js";
import {
  GitReorganiserStore,
  type ReorganiserStore,
} from "./reorganiser-store.js";
import { StatusIndicator } from "./status-indicator.js";
import { detectTaskBoundary } from "./task-boundary.js";

/**
 * Dispatch pipeline events to the UI.
 *
 * Shared by checkpoint commits (`turn_end`) and the reorganiser (`agent_end`).
 */
async function handlePipelineEvents(
  ctx: ExtensionContext,
  statusIndicator: StatusIndicator,
  events: PipelineEvent[],
): Promise<void> {
  for (const event of events) {
    switch (event.type) {
      case "info":
        ctx.ui.notify(event.message, "info");
        break;
      case "error":
        ctx.ui.notify(event.message, "error");
        break;
      case "committed":
        ctx.ui.notify(event.message, "info");
        break;
      case "organised":
        ctx.ui.notify(
          `Organise complete: ${event.checkpointCount} checkpoint(s) reorganised into ${event.commitCount} commit(s).`,
          "info",
        );
        break;
      case "fallback":
        ctx.ui.notify(event.message, "warning");
        break;
      case "merged":
        ctx.ui.notify(event.message, "info");
        break;
      case "stage-changed":
        await statusIndicator.updateFooter();
        break;
    }
  }
}

/**
 * Run an async function while showing the organise progress indicator
 * in the TUI working loader row.
 *
 * The indicator is hidden and the working message is restored in the
 * finally block so success and error paths alike clean up the UI.
 */
async function runWithOrganiseProgress<T>(
  ctx: ExtensionContext,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Show a working indicator in the TUI footer during reorganisation.
  // Completion feedback comes from handlePipelineEvents (organised event).
  ctx.ui.setWorkingMessage(label);
  ctx.ui.setWorkingVisible(true);
  try {
    return await fn();
  } finally {
    ctx.ui.setWorkingVisible(false);
    ctx.ui.setWorkingMessage();
  }
}

/**
 * Show the commit picker popup and reorganise the selected range.
 *
 * Used by `/autocommit-organise` and `agent_end`.
 * In TUI mode, shows the picker; in non-TUI mode, auto-reorganises via the
 * manual reorganise path (`reorganiseCheckpointsManual`).
 *
 * @param emptyMessage Optional message shown when no recent commits are found.
 */
async function maybeRunInteractiveReorganise(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  event: AgentEndEvent,
  statusIndicator: StatusIndicator,
  pickerStore: PickerStore,
  reorganiserStore: ReorganiserStore,
  emptyMessage?: string,
): Promise<void> {
  const raw = await pickerStore.getRecentCommits(config.commitPickerMaxCommits);
  const items = buildCommitItems(raw);
  const remoteTipSha = await pickerStore.getUpstreamTip();

  if (items.length === 0) {
    if (emptyMessage) {
      ctx.ui.notify(emptyMessage, "info");
    }
    await statusIndicator.updateFooter();
    return;
  }

  if (ctx.mode === "tui") {
    const loadMore = async (count: number): Promise<CommitItem[]> => {
      const raw = await pickerStore.getRecentCommits(10, count);
      return buildCommitItems(raw);
    };

    const range = await showCommitPicker(ctx, items, loadMore, remoteTipSha);
    if (range !== null) {
      // `review` mode lets the user edit the file partition and each
      // proposed message before anything is written; the other modes commit
      // the proposal as-is.
      const review: ReviewGroupsFn | undefined =
        config.organiseMode === "review"
          ? (groups) => reviewCommitGroups(ctx, groups)
          : undefined;
      const result = await runWithOrganiseProgress(
        ctx,
        "⏳ Reorganising checkpoint commits...",
        () =>
          reorganiseSelectedRange(
            ctx,
            config,
            event,
            reorganiserStore,
            range,
            undefined,
            review,
          ),
      );
      await handlePipelineEvents(ctx, statusIndicator, result.events);
    } else {
      ctx.ui.notify(
        "pi-autocommit: 整理をキャンセルしました。「/autocommit-organise」で後から整理できます",
        "info",
      );
    }
  } else {
    const result = await runWithOrganiseProgress(
      ctx,
      "⏳ Reorganising checkpoint commits...",
      () => reorganiseCheckpointsManual(ctx, config, reorganiserStore),
    );
    await handlePipelineEvents(ctx, statusIndicator, result.events);
  }
}

/** Assistant messages kept as commit-message context. */
const MID_RUN_CONTEXT_MESSAGES = 20;

/**
 * Submodule paths (and the orphaned HEAD they pointed at) that were already
 * reported this session, so the same danger is not re-notified on every
 * turn. A new orphaned commit (different head SHA) for the same path is
 * reported again.
 */
const warnedSubmoduleOrphans = new Set<string>();

/**
 * Warn about submodule HEADs that point at commits unreachable from any
 * branch and not referenced by the parent gitlink — running
 * `git submodule update` would discard them. Best-effort: never breaks the
 * agent loop on detection errors.
 *
 * When `ignoringSubmodules` is true (the `ignoreSubmodules` flag is on), the
 * notice uses an informational tone (pin drift is expected, not an error)
 * and callers show it at `session_start` only.
 */
async function warnOrphanedSubmoduleHeads(
  ctx: ExtensionContext,
  git: GitOperations,
  japanese: boolean,
  ignoringSubmodules = false,
): Promise<void> {
  try {
    const orphans = await git.findOrphanedSubmoduleHeads();
    for (const orphan of orphans) {
      const key = `${orphan.path}:${orphan.headSha}`;
      if (warnedSubmoduleOrphans.has(key)) {
        continue;
      }
      warnedSubmoduleOrphans.add(key);
      const message = japanese
        ? ignoringSubmodules
          ? `pi-autocommit: submodule "${orphan.path}" のコミットが親の gitlink より進んでいます（ignoreSubmodules が有効のため親には記録されません）。
` +
            `ただし HEAD がどのブランチからも到達不能です。git submodule update を実行するとこれらのコミットは消失するので、submodule 内でブランチにコミットを置いてください。`
          : `pi-autocommit: submodule "${orphan.path}" の HEAD が親の gitlink と乖離し、どのブランチからも到達不能なコミットを指しています。
` +
            `git submodule update を実行するとこのコミットは消失します。親の gitlink を更新するか、submodule 内でブランチにコミットを置いてください。`
        : ignoringSubmodules
          ? `pi-autocommit: submodule "${orphan.path}" has commits ahead of the parent gitlink (not recorded in the parent because ignoreSubmodules is enabled).
` +
            `Its HEAD is unreachable from any branch though; running git submodule update would discard those commits. Move them onto a branch in the submodule.`
          : `pi-autocommit: submodule "${orphan.path}" HEAD points at commits unreachable from any branch and not referenced by the parent gitlink.
` +
            `Running git submodule update would discard them. Bump the parent gitlink or move the commits onto a branch in the submodule.`;
      ctx.ui.notify(message, ignoringSubmodules ? "info" : "warning");
    }
  } catch {
    // Best-effort: ignore detection errors.
  }
}

/**
 * Result of a boundary-driven reorganisation.
 *
 * `nothing` and `failed` must stay distinct: a push with no pending
 * checkpoints is allowed to go through, a push whose reorganisation failed is
 * blocked.
 */
type OrganiseOutcome = "nothing" | "organised" | "failed";

/**
 * Reorganise the pending checkpoint run now.
 *
 * Called at the boundaries that end a unit of work: a new instruction from the
 * user (`input`), a task completion detected at `turn_end`, a push, and
 * `agent_end`.
 *
 * The buffered assistant messages stand in for the `agent_end` message list:
 * they are the reasoning behind the changes being reorganised.
 */
async function organisePendingCheckpoints(
  ctx: ExtensionContext,
  git: GitOperations,
  config: PiAutocommitConfig,
  sessionId: string | null,
  messages: TurnEndEvent["message"][],
): Promise<OrganiseOutcome> {
  if (sessionId === null) {
    return "nothing";
  }
  const pending = await git.countCheckpointCommits(
    CHECKPOINT_COMMIT_MARKER,
    sessionId,
  );
  if (pending === 0) {
    return "nothing";
  }

  const statusIndicator = new StatusIndicator(git, ctx);
  const result = await runWithOrganiseProgress(
    ctx,
    "⏳ チェックポイントを整理中...",
    () =>
      organizeCheckpointCommits(
        ctx,
        config,
        { type: "agent_end", messages },
        new GitReorganiserStore(git),
        undefined,
        sessionId,
      ),
  );
  await handlePipelineEvents(ctx, statusIndicator, result.events);
  return result.organised ? "organised" : "failed";
}

/**
 * pi-autocommit extension
 *
 * Automatically commits changes inside pi using a checkpoint-then-reorganise
 * strategy so the user does not have to write commit messages.
 *
 * - `turn_end`: create a lightweight checkpoint commit when a turn mutated
 *   files.
 * - `agent_end`: soft-reset the checkpoint commits and reorganise them into
 *   logical Conventional Commits via the LLM.
 *
 * A footer indicator shows whether the working tree has uncommitted changes,
 * so the user can spot unintended files before a checkpoint captures them.
 */
export default function (pi: ExtensionAPI) {
  // Captured from session_start so getArgumentCompletions (which has no
  // ctx) can access the model registry.
  let cachedModelRegistry: ExtensionContext["modelRegistry"] | undefined;
  // HEAD commit SHA captured at agent_start. Used at agent_end to decide
  // whether the agent run produced any commits.
  let agentBaselineHead: string | null = null;
  // Assistant messages since the last reorganisation, used as commit-message
  // context.
  let recentAssistantMessages: TurnEndEvent["message"][] = [];
  // Checkpoints made since the last successful reorganisation. An in-memory
  // count keeps the turn backstop free of a `git log` on every turn; drift
  // (a failed reorganisation, another session writing here) only moves the
  // trigger by a few turns, and the reorganiser recounts before acting.
  let pendingSinceOrganise = 0;
  // The request the run is working through: the initial prompt or the latest
  // user instruction. The task-boundary check needs it to tell "finished item
  // 1 of 3" from "still on item 1".
  let currentRequest = "";
  // Text of the most recent assistant message. Captured at `message_end`
  // because `turn_end` only guarantees the turn is over, not which message
  // ended it (it can be a tool result).
  let lastAssistantText = "";

  /** Reorganise the pending run and clear the context when it worked. */
  const reorganisePending = async (
    ctx: ExtensionContext,
  ): Promise<OrganiseOutcome> => {
    const outcome = await organisePendingCheckpoints(
      ctx,
      git,
      loadConfig(ctx.cwd),
      ctx.sessionManager.getSessionId(),
      recentAssistantMessages,
    );
    if (outcome === "organised") {
      recentAssistantMessages = [];
      pendingSinceOrganise = 0;
    }
    return outcome;
  };
  const git = new GitOperations(pi);

  // ───────────────────────────────────────────────────────
  // /autocommit-enable [true|false]
  // ───────────────────────────────────────────────────────

  pi.registerCommand("autocommit-enable", {
    description:
      "Toggle auto-commit enable (true|false). No arg shows current state.",
    handler: async (args, ctx) => {
      const trimmed = args?.trim().toLowerCase();

      if (trimmed === "") {
        ctx.ui.notify(
          `pi-autocommit: enable = ${isSessionEnabled(ctx.cwd)}`,
          "info",
        );
        return;
      }

      if (trimmed !== "true" && trimmed !== "false") {
        ctx.ui.notify("Usage: /autocommit-enable <true|false>", "error");
        return;
      }

      const enable = trimmed === "true";
      saveEnable(ctx.cwd, enable);
      // Affects this session only; other running sessions keep their snapshot.
      setSessionEnable(enable);
      ctx.ui.notify(`pi-autocommit: enable = ${enable}`, "info");
    },
  });

  // ───────────────────────────────────────────────────────
  // /autocommit-mode [auto|picker]
  // ───────────────────────────────────────────────────────

  /** One-line description of each mode, shown in notifications. */
  const MODE_HINT: Record<OrganiseMode, string> = {
    auto: "agent_end で無対話に整理",
    picker: "agent_end でコミット範囲を選ぶ",
    review: "範囲選択 + コミット前に分割とメッセージを編集",
  };

  pi.registerCommand("autocommit-mode", {
    description:
      "Set the agent_end organise mode (auto|picker|review). No arg cycles to the next mode.",
    getArgumentCompletions: (): AutocompleteItem[] =>
      ORGANISE_MODES.map((mode) => ({
        value: mode,
        label: mode,
        description: MODE_HINT[mode],
      })),
    handler: async (args, ctx) => {
      const config = loadConfig(ctx.cwd);
      const statusIndicator = new StatusIndicator(git, ctx);
      const trimmed = args?.trim().toLowerCase();

      let mode: OrganiseMode;
      if (trimmed === "") {
        const index = ORGANISE_MODES.indexOf(config.organiseMode);
        mode = ORGANISE_MODES[(index + 1) % ORGANISE_MODES.length];
      } else if (isOrganiseMode(trimmed)) {
        mode = trimmed;
      } else {
        ctx.ui.notify(
          `Usage: /autocommit-mode <${ORGANISE_MODES.join("|")}>`,
          "error",
        );
        return;
      }

      saveOrganiseMode(ctx.cwd, mode);
      await statusIndicator.updateFooter();
      ctx.ui.notify(
        `pi-autocommit: organiseMode = ${mode}（${MODE_HINT[mode]}）`,
        "info",
      );
    },
  });

  // ───────────────────────────────────────────────────────
  // /autocommit-model [provider/modelId | clear]
  // ───────────────────────────────────────────────────────

  /**
   * Persist the model chosen from the popup, sharing the notify logic
   * between the TUI overlay and the non-TUI fallback.
   */
  function applyModelChoice(
    ctx: ExtensionContext,
    choice: string | null,
  ): void {
    if (choice === null) {
      return; // cancelled
    }

    if (choice === CLEAR_VALUE) {
      saveModel(ctx.cwd, undefined);
      ctx.ui.notify("pi-autocommit: model = session model", "info");
      return;
    }

    saveModel(ctx.cwd, choice);
    ctx.ui.notify(`pi-autocommit: model = ${choice}`, "info");
  }

  pi.registerCommand("autocommit-model", {
    description:
      'Set the LLM model for commit message generation (provider/modelId). No arg shows a selector popup. Pass "clear" to fall back to the session model.',
    getArgumentCompletions: (
      argumentPrefix: string,
    ): AutocompleteItem[] | null => {
      if (!cachedModelRegistry) {
        return null;
      }

      const items: AutocompleteItem[] = [
        {
          value: "clear",
          label: "clear (use session model)",
          description:
            "Clear the model setting, fall back to the session model.",
        },
      ];

      for (const model of cachedModelRegistry.getAvailable()) {
        const value = `${model.provider}/${model.id}`;
        items.push({
          value,
          label: value,
          description: model.name,
        });
      }

      const prefix = argumentPrefix.toLowerCase();
      const filtered = items.filter(
        (item) =>
          item.value.toLowerCase().startsWith(prefix) ||
          item.label.toLowerCase().includes(prefix),
      );
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const config = loadConfig(ctx.cwd);
      const trimmed = args?.trim();

      // No argument — show the popup (requires UI).
      if (trimmed === "") {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            "pi-autocommit: UI not available. Use /autocommit-model <provider/modelId> or /autocommit-model clear.",
            "error",
          );
          return;
        }
        const choice = await showModelPopup(ctx, config.model);
        applyModelChoice(ctx, choice);
        return;
      }

      // "clear" — fall back to the session model.
      if (trimmed.toLowerCase() === "clear") {
        saveModel(ctx.cwd, undefined);
        ctx.ui.notify(`pi-autocommit: model = session model`, "info");
        return;
      }

      // Direct provider/modelId — validate before saving.
      const result = validateModelString(ctx, trimmed);
      if (result.ok) {
        saveModel(ctx.cwd, trimmed);
        ctx.ui.notify(`pi-autocommit: model = ${trimmed}`, "info");
        return;
      }

      // Validation failed — notify and fall back to the popup.
      ctx.ui.notify(`pi-autocommit: ${result.reason}`, "error");
      if (ctx.hasUI) {
        const choice = await showModelPopup(ctx, config.model);
        applyModelChoice(ctx, choice);
      }
    },
  });

  // ───────────────────────────────────────────────────────
  // /autocommit-organise [sessionId?]
  // ───────────────────────────────────────────────────────

  pi.registerCommand("autocommit-organise", {
    description:
      "Reorganise checkpoint commits. No arg: all checkpoints. " +
      "With a session filter, reorganise only that session's checkpoints " +
      "(including scattered ones).",
    handler: async (args, ctx) => {
      const statusIndicator = new StatusIndicator(git, ctx);
      const config = loadConfig(ctx.cwd);
      const trimmed = args?.trim();

      // No argument: show interactive commit picker popup.
      if (trimmed === "") {
        const pickerStore = new GitPickerStore(git);
        const reorganiserStore = new GitReorganiserStore(git);
        const event = { type: "agent_end", messages: [] } as AgentEndEvent;
        await maybeRunInteractiveReorganise(
          ctx,
          config,
          event,
          statusIndicator,
          pickerStore,
          reorganiserStore,
          "pi-autocommit: コミットが見つかりません",
        );
        await statusIndicator.updateFooter();
        return;
      }

      // Session ID provided directly as argument.
      const reorganiserStore = new GitReorganiserStore(git);
      const result = await runWithOrganiseProgress(
        ctx,
        "⏳ Reorganising checkpoint commits...",
        () =>
          reorganiseCheckpointsManual(ctx, config, reorganiserStore, trimmed),
      );
      await handlePipelineEvents(ctx, statusIndicator, result.events);
      await statusIndicator.updateFooter();
    },
    getArgumentCompletions: async (
      _argumentPrefix: string,
    ): Promise<AutocompleteItem[] | null> => {
      try {
        const commits = await git.findReachableCheckpoints(
          CHECKPOINT_COMMIT_MARKER,
        );
        const sessions = [
          ...new Set(
            commits
              .map((w) => w.session)
              .filter((s): s is string => s !== null),
          ),
        ];
        return sessions.map((s) => {
          // Label the origin branch when the session's checkpoints carry one
          // (e.g. a delegated worktree branch) so the cryptic session id is
          // recognisable.
          const branch = commits.find((c) => c.session === s)?.branch;
          return {
            value: s,
            label: branch ? `${branch} · ${s}` : s,
            description: "Reorganise only this session's checkpoint commits",
          };
        });
      } catch {
        return null;
      }
    },
  });

  // ───────────────────────────────────────────────────────
  // Show uncommitted changes indicator in footer
  // ───────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    cachedModelRegistry = ctx.modelRegistry;
    // Snapshot `enable` once: later file writes from other sessions must not
    // switch this session on or off mid-run.
    initSessionEnable(ctx.cwd);
    const statusIndicator = new StatusIndicator(git, ctx);
    await statusIndicator.updateFooter();

    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const config = loadConfig(ctx.cwd);

      // Submodule warning: catches detached-orphan submodule commits that
      // appeared while no pi session was watching (another terminal).
      await warnOrphanedSubmoduleHeads(
        ctx,
        git,
        isJapanese(config),
        config.ignoreSubmodules,
      );

      // Own-session crash leftovers at HEAD (session-aware so a resumed
      // session only claims its own checkpoints). These are reorganisable
      // via the manual command.
      const checkpointCount = sessionId
        ? await git.countCheckpointCommits(CHECKPOINT_COMMIT_MARKER, sessionId)
        : await git.countCheckpointCommits(CHECKPOINT_COMMIT_MARKER);
      if (checkpointCount > 0) {
        ctx.ui.notify(
          `pi-autocommit: 未整理のチェックポイントが残っています。/autocommit-organise で整理できます`,
          "warning",
        );
      }

      // Foreign-session checkpoints in the un-pushed range: checkpoints
      // merged in from another session's branch (e.g. a delegated worktree
      // agent that crashed before agent_end). These cannot be reorganised
      // after the merge — surface them so the user can decide.
      if (sessionId) {
        const upstreamTip = await git.getUpstreamTip();
        if (upstreamTip) {
          const merged = await git.findCheckpointsSince(
            upstreamTip,
            CHECKPOINT_COMMIT_MARKER,
          );
          const foreign = merged.filter(
            (c) => c.session !== null && c.session !== sessionId,
          );
          if (foreign.length > 0) {
            const origin = foreign[0].branch
              ? `（由来: ${foreign[0].branch}）`
              : "";
            ctx.ui.notify(
              `pi-autocommit: マージによって他セッションの未整理チェックポイントが ${foreign.length} 件取り込まれています${origin}（履歴に wip(checkpoint) が残ります）。ブランチ統合時は \`git merge --squash\` を使うと回避できます。`,
              "warning",
            );
          }
        }
      }
    } catch {
      // Best-effort: ignore errors during startup check.
    }
  });

  // ───────────────────────────────────────────────────────
  // Track what the run is working on: the request and, per turn, the
  // assistant text. Both feed the task-boundary check.
  // ───────────────────────────────────────────────────────

  pi.on("before_agent_start", async (event, _ctx) => {
    currentRequest = event.prompt;
  });

  pi.on("turn_start", async (_event, _ctx) => {
    lastAssistantText = "";
  });

  // Track the assistant text per turn: it is the classifier input and the
  // commit-message context, and `turn_end` does not carry the assistant
  // message when the turn ended on a tool result.
  pi.on("message_end", async (event, _ctx) => {
    if ((event.message as { role?: string }).role !== "assistant") {
      return;
    }
    lastAssistantText = extractAssistantContext([event.message]);
    if (!lastAssistantText) {
      return;
    }
    recentAssistantMessages.push(event.message);
    while (recentAssistantMessages.length > MID_RUN_CONTEXT_MESSAGES) {
      recentAssistantMessages.shift();
    }
  });

  // ───────────────────────────────────────────────────────
  // Capture baseline HEAD at the start of each agent run
  // ───────────────────────────────────────────────────────

  pi.on("agent_start", async (_event, _ctx) => {
    // Reset per-run baseline. If HEAD cannot be read, leave it as null so
    // agent_end falls back to its normal behaviour.
    agentBaselineHead = await git.getHead();
  });

  // ───────────────────────────────────────────────────────
  // Task boundary: a new instruction means the previous unit of work is done,
  // so the pending checkpoint run is reorganised before it starts.
  // ───────────────────────────────────────────────────────

  pi.on("input", async (event, ctx) => {
    // Steering is a correction mid-flight; the user wants it to land now, not
    // after a multi-second reorganisation.
    if (event.streamingBehavior === "steer") {
      return;
    }
    if (!isSessionEnabled(ctx.cwd)) {
      return;
    }

    currentRequest = event.text;

    if (loadConfig(ctx.cwd).organiseMode !== "auto") {
      return; // picker/review must not open a popup inside a run
    }

    await reorganisePending(ctx);
  });

  // ───────────────────────────────────────────────────────
  // Git guard: block only the two operations pi-autocommit cannot coexist
  // with — an agent commit (it splits the checkpoint run) and `reset --hard`
  // (it discards the working tree). A push is not blocked: the loop pauses to
  // reorganise the pending run and then lets the push through, so the remote
  // never receives `wip(checkpoint)` history.
  // ───────────────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) {
      return;
    }

    const config = loadConfig(ctx.cwd);
    if (!isSessionEnabled(ctx.cwd)) {
      return;
    }

    const command = event.input.command;

    if (isGitPushCommand(command)) {
      // Only `auto` can reorganise without asking; the other modes leave the
      // decision to the picker at agent_end, so the push has to wait.
      // A push is safe once the run is organised; `nothing` means there was
      // nothing to organise, `failed` means the remote would receive
      // `wip(checkpoint)` history.
      const outcome =
        config.organiseMode === "auto"
          ? await reorganisePending(ctx)
          : "failed";
      if (outcome !== "failed") {
        return;
      }
      return {
        block: true,
        reason: buildBlockReason("push", isJapanese(config)),
      };
    }

    const blocked = shouldBlockGitCommit(command)
      ? "commit"
      : shouldBlockGitHardReset(command)
        ? "reset --hard"
        : null;

    if (blocked === null) {
      return;
    }

    return {
      block: true,
      reason: buildBlockReason(blocked, isJapanese(config)),
    };
  });

  // ───────────────────────────────────────────────────────
  // Auto-commit on turn_end (checkpoint commits)
  // ───────────────────────────────────────────────────────

  pi.on("turn_end", async (event, ctx) => {
    const statusIndicator = new StatusIndicator(git, ctx);
    const config = loadConfig(ctx.cwd);

    if (!isSessionEnabled(ctx.cwd)) {
      return;
    }

    // Submodule warning: surfaces detached-orphan submodule commits
    // (see B3) as soon as they exist, before an update can discard them.
    // With `ignoreSubmodules`, pin drift is expected — the informational
    // variant is shown at session_start only, not every turn.
    if (!config.ignoreSubmodules) {
      await warnOrphanedSubmoduleHeads(ctx, git, isJapanese(config));
    }

    if (!shouldCreateCheckpointCommit(event.toolResults)) {
      return;
    }

    const checkpointStore = new GitCheckpointStore(git);

    if (!(await checkpointStore.isInsideGitRepo())) {
      return;
    }

    if (!(await checkpointStore.checkStatus()).hasChanges) {
      return;
    }

    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const result = await runCheckpointCommit(
        checkpointStore,
        `wip(checkpoint): auto-commit at turn ${event.turnIndex + 1}`,
        sessionId,
        { ignoreSubmodules: config.ignoreSubmodules },
      );

      await handlePipelineEvents(ctx, statusIndicator, result.events);

      pendingSinceOrganise++;

      // One prompt can ask for several things; only the agent knows when one
      // of them is finished, so a small call decides it here.
      if (config.organiseMode === "auto" && config.detectTaskBoundary) {
        const summary = await git.getCommitSummary("HEAD");
        if (
          await detectTaskBoundary(ctx, config, {
            request: currentRequest,
            turnText: lastAssistantText,
            changedFiles: summary?.files ?? [],
          })
        ) {
          await reorganisePending(ctx);
        }
      }

      // A run that reaches no boundary at all is still split by the backstop.
      if (
        shouldReorganiseAtBackstop(pendingSinceOrganise, config.organiseMode)
      ) {
        await reorganisePending(ctx);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-autocommit: checkpoint error — ${message}`, "error");
      await statusIndicator.updateFooter();
    }
  });

  // ───────────────────────────────────────────────────────
  // Auto-commit on agent_end (reorganise checkpoints)
  // ───────────────────────────────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    const statusIndicator = new StatusIndicator(git, ctx);
    const config = loadConfig(ctx.cwd);

    if (!isSessionEnabled(ctx.cwd)) {
      await statusIndicator.updateFooter();
      return;
    }

    try {
      const reorganiserStore = new GitReorganiserStore(git);

      // Skip reorganisation when HEAD has not moved since agent_start.
      // This means the agent run produced no commits, so there is nothing
      // to reorganise.
      const currentHead = await git.getHead();
      if (shouldSkipReorganisation(agentBaselineHead, currentHead)) {
        await statusIndicator.updateFooter();
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();

      // `picker` and `review` hand the range decision to the user: the
      // popup's default already covers the checkpoint run at HEAD, and
      // extending it downward is the manual form of what
      // `mergeSimilarPrevious` does by itself. `review` then offers the
      // partition editor and confirms each proposed commit before it is
      // written. Cancelling leaves the
      // checkpoints in history for /autocommit-organise.
      if (config.organiseMode !== "auto") {
        await maybeRunInteractiveReorganise(
          ctx,
          config,
          event,
          statusIndicator,
          new GitPickerStore(git),
          reorganiserStore,
        );
      } else {
        // Auto-organise checkpoint commits directly (no interactive popup).
        const result = await runWithOrganiseProgress(
          ctx,
          "⏳ チェックポイントを整理中...",
          () =>
            organizeCheckpointCommits(
              ctx,
              config,
              event,
              reorganiserStore,
              undefined,
              sessionId,
            ),
        );
        await handlePipelineEvents(ctx, statusIndicator, result.events);
        if (result.organised) {
          pendingSinceOrganise = 0;
          recentAssistantMessages = [];
        }
      }

      // Detect checkpoint commits from other sessions that entered via a
      // merge during this run (e.g. a delegated worktree branch whose agent
      // crashed before agent_end). Their changes are already in the tree and
      // the scattered manual path cannot re-apply them, so they stay in
      // history as wip(checkpoint) — surface them so the user can decide
      // (leave it, or re-integrate with --squash next time).
      if (agentBaselineHead !== null && sessionId !== null) {
        try {
          const merged = await reorganiserStore.findCheckpointsSince(
            agentBaselineHead,
            CHECKPOINT_COMMIT_MARKER,
          );
          const foreign = merged.filter((c) => c.session !== sessionId);
          if (foreign.length > 0) {
            const origin = foreign[0].branch
              ? `（由来: ${foreign[0].branch}）`
              : "";
            ctx.ui.notify(
              `pi-autocommit: マージによって他セッションの未整理チェックポイントが ${foreign.length} 件取り込まれました${origin}（履歴に wip(checkpoint) が残ります）。` +
                "ブランチ統合時は `git merge --squash` を使うと回避できます。",
              "warning",
            );
          }
        } catch {
          // Best-effort: ignore detection errors.
        }
      }

      // Submodule warning: detached-orphan submodule commits that arrived
      // during this run (e.g. via a delegated worktree or another
      // terminal) are surfaced before the session ends. With
      // `ignoreSubmodules`, shown at session_start only.
      if (!config.ignoreSubmodules) {
        await warnOrphanedSubmoduleHeads(ctx, git, isJapanese(config));
      }

      await statusIndicator.updateFooter();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-autocommit: error — ${message}`, "error");
      await statusIndicator.updateFooter();
    }
  });
}
