/**
 * audit: herdr's lifecycle as Pi session entries.
 *
 * herdr keeps no history. A pane that became blocked, a worktree that was made
 * and later thrown away — each is gone the moment the next one arrives, and a
 * month later "why did we abandon that worktree?" has nothing left to answer it.
 *
 * Pi's session JSONL, on the other hand, stays, and `session_search` indexes it.
 * Writing herdr's events down as they happen is what makes the fleet's past
 * findable afterwards.
 *
 * The entries carry `customType: "herdr-event"` and never enter the model's
 * context; they exist to be read back by a human or by search.
 *
 * Noise is the whole risk of a log like this, so it is cut four ways: only the
 * events worth finding are subscribed to (the broker owns the one subscription),
 * `describe` refuses the rest a second time, a repeated state for one pane is
 * dropped — herdr re-announces a status after a reconnect, and this is a history
 * of transitions, not of re-reads — and a pane is only written by the session
 * that created its workspace, because herdr's stream reaches every Pi session in
 * it and the log of one repo's fleet must not land in all the others.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { HerdrEvent } from "./herdr-client.ts";

/** The `customType` of every entry this module writes. */
export const AUDIT_CUSTOM_TYPE = "herdr-event";

/**
 * One entry's `data`. `summary` is the line the renderer shows and the string a
 * literal search finds, so it carries the whole point of the entry.
 */
export interface AuditData {
	/** herdr's event kind, as the schema spells it: `worktree_created`, ... */
	event: string;
	summary: string;
	at: string;
	pane_id?: string;
	workspace_id?: string;
	agent?: string;
	agent_status?: string;
	branch?: string;
	path?: string;
	forced?: boolean;
}

export type EntryAppender = (customType: string, data: AuditData) => void;

function text(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * What one event is worth, or `undefined` when it is not worth an entry.
 *
 * herdr spells the envelope's `event` two ways: the pane-scoped subscriptions
 * push the dotted name (`pane.agent_status_changed`) while the lifecycle events
 * push the schema's underscored kind (`worktree_created`). Normalizing first
 * means neither spelling can slip past the switch.
 */
export function describe(event: HerdrEvent): AuditData | undefined {
	const data: Record<string, any> = event.data ?? {};
	const name = event.event.replace(/\./g, "_");
	const at = new Date().toISOString();
	const worktree = data.worktree ?? {};
	const branch = text(worktree.branch);
	const path = text(worktree.path);
	const workspace = data.workspace ?? {};
	const workspaceId = text(workspace.workspace_id) ?? text(data.workspace_id) ?? text(worktree.open_workspace_id);

	switch (name) {
		case "worktree_created":
			return { event: name, at, summary: `worktree created ${branch ?? path ?? "?"}`, branch, path, workspace_id: workspaceId };
		case "worktree_removed": {
			const forced = data.forced === true;
			return {
				event: name,
				at,
				summary: `worktree removed ${branch ?? path ?? "?"}${forced ? " (forced)" : ""}`,
				branch,
				path,
				workspace_id: workspaceId,
				forced,
			};
		}
		case "workspace_created": {
			const id = text(workspace.workspace_id);
			const label = text(workspace.label) ?? id ?? "?";
			return { event: name, at, summary: `workspace created ${label} (${id ?? "?"})`, workspace_id: id, path: text(workspace.worktree?.checkout_path) };
		}
		case "workspace_closed":
			return { event: name, at, summary: `workspace closed ${workspaceId ?? "?"}`, workspace_id: workspaceId };
		case "pane_agent_status_changed": {
			const paneId = text(data.pane_id);
			const status = text(data.agent_status);
			if (!paneId || !status) return undefined;
			const agent = text(data.display_agent) ?? text(data.agent);
			return {
				event: name,
				at,
				summary: `${paneId} ${status}${agent ? ` (${agent})` : ""}`,
				pane_id: paneId,
				workspace_id: text(data.workspace_id),
				agent,
				agent_status: status,
			};
		}
		// `pane_output_changed`, `pane_scroll_changed`, `layout_updated`, the tab
		// and pane inventory events: high-frequency, or already on screen. None of
		// them is subscribed to; this is the second refusal.
		default:
			return undefined;
	}
}

/** Turns the events the broker forwards into entries, one per real transition. */
export class AuditLog {
	private readonly append: EntryAppender;
	private readonly selfPaneId: string;
	/**
	 * The workspaces whose panes are this session's news: its own, and the ones
	 * it owns. herdr's event stream is global — every Pi session in it sees every
	 * pane's transitions — so without this the log of repo A lands in every
	 * session on the machine.
	 */
	private readonly owned = new Set<string>();
	/** The last state written per pane. */
	private readonly lastStatus = new Map<string, string>();

	constructor(append: EntryAppender, selfPaneId: string, selfWorkspaceId?: string) {
		this.append = append;
		this.selfPaneId = selfPaneId;
		if (selfWorkspaceId) this.owned.add(selfWorkspaceId);
	}

	/**
	 * Claim a workspace this session created (a fork, a reviewer's worktree), so
	 * its panes are logged here rather than in an unrelated session. Called after
	 * the worktree call returned, because the workspace id only exists then.
	 */
	own(workspaceId: string): void {
		if (workspaceId !== "") this.owned.add(workspaceId);
	}

	/** One event in, at most one entry out. */
	record(event: HerdrEvent): void {
		const entry = describe(event);
		if (!entry) return;
		if (entry.pane_id !== undefined) {
			// This extension's own pane is the session doing the logging; its turns
			// are already in the transcript.
			if (entry.pane_id === this.selfPaneId) return;
			// A pane in a workspace this session did not create is another session's
			// news, and writing it here is the noise this filter exists to stop.
			if (entry.workspace_id === undefined || !this.owned.has(entry.workspace_id)) return;
			const status = entry.agent_status ?? "";
			if (this.lastStatus.get(entry.pane_id) === status) return;
			this.lastStatus.set(entry.pane_id, status);
		}
		this.append(AUDIT_CUSTOM_TYPE, entry);
	}
}

/** Fold an audit entry into the one line that says what happened. */
export function registerAuditRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<AuditData>(AUDIT_CUSTOM_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		const line = `${theme.fg("dim", "[herdr]")} ${data?.summary ?? "event"}`;
		if (!expanded) return new Text(line, 0, 0);
		return new Text(`${line}\n${theme.fg("dim", JSON.stringify(data, null, 2))}`, 0, 0);
	});
}
