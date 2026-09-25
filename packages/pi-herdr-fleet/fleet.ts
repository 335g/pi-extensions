/**
 * fleet: the semantic fleet view.
 *
 * herdr's sidebar knows a pane's state — idle, working, blocked, done — and
 * nothing else. Pi's session JSONL knows what the state cannot say: which model,
 * how much context, how much money, what was asked last, what tool is running.
 * This module joins the two, so the answer to "what is every other pane doing"
 * is on one screen without switching panes.
 *
 * Unlike the approval broker, this view includes the calling pane. The broker
 * excludes itself because answering your own approval makes no sense; this is a
 * tool for seeing the whole fleet, and the whole fleet includes you. The row is
 * marked instead.
 *
 * One snapshot is taken when the overlay opens and again on `r`. Live following
 * is deliberately absent: it would mean a second subscription and a re-read of
 * every session on every event, which is not worth it for a view a human asks
 * for on demand.
 */

import { type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Key,
	type TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { type Strings } from "./approvals.ts";
import { type AgentStatus, type HerdrClient, type Outcome, err, ok } from "./herdr-client.ts";
import { readSessionSummary, type SessionSummary } from "./session.ts";

/**
 * The context-window lookup, narrowed to the one call this module makes.
 *
 * `ctx.modelRegistry` satisfies it; a test does not have to build a registry to
 * answer the only question asked of it.
 */
export interface ModelLookup {
	find(provider: string, modelId: string): { contextWindow?: number } | undefined;
}

export interface FleetRequest {
	/** Where `worktree.list` is asked from: the calling session's checkout. */
	cwd: string;
	/** The calling pane, marked as self and never excluded. */
	selfPaneId: string;
	models?: ModelLookup;
	/** Injectable so a test can force the tail cap. */
	tailBytes?: number;
	maxLines?: number;
}

export interface FleetRow {
	paneId: string;
	workspaceId: string;
	/** True for the pane the view is drawn in. */
	self: boolean;
	status: AgentStatus;
	agent?: string;
	name?: string;
	/** The Pi session JSONL herdr knows for the pane, when it knows one. */
	sessionPath?: string;
	/** What the session's tail held, or why it could not be read. */
	session?: SessionSummary;
	sessionError?: string;
	cwd?: string;
	/** The branch of the worktree the pane's cwd is in, when it is in one. */
	branch?: string;
	/** From the model registry, when the model is known there. */
	contextWindow?: number;
}

/**
 * Every pane herdr reports, with what its Pi session says.
 *
 * A pane without an `agent_session` is a row too — a shell, or an agent herdr
 * cannot name a session for — and says so rather than disappearing. The snapshot
 * is the only required call: a worktree list that fails costs the branch line,
 * not the view.
 */
export async function gatherFleet(client: HerdrClient, request: FleetRequest): Promise<Outcome<FleetRow[]>> {
	const snapshot = await client.snapshot();
	if (!snapshot.ok) return err(snapshot.error);

	const worktrees = await worktreeBranches(client, request.cwd);
	const rows: FleetRow[] = snapshot.value.panes.map((pane) => {
		const agent = snapshot.value.agents.find((candidate) => candidate.pane_id === pane.pane_id);
		const sessionPath =
			typeof agent?.agent_session?.value === "string" && agent.agent_session.value !== ""
				? agent.agent_session.value
				: undefined;
		const row: FleetRow = {
			paneId: pane.pane_id,
			workspaceId: pane.workspace_id,
			self: pane.pane_id === request.selfPaneId,
			status: agent?.agent_status ?? "unknown",
			agent: agent?.agent ?? undefined,
			name: agent?.name ?? undefined,
			sessionPath,
			cwd: agent?.cwd ?? undefined,
			branch: branchFor(agent?.cwd ?? undefined, worktrees),
		};
		if (!sessionPath) return row;

		try {
			row.session = readSessionSummary(sessionPath, request.tailBytes, request.maxLines);
		} catch (error) {
			row.sessionError = error instanceof Error ? error.message : String(error);
			return row;
		}
		// herdr's cwd is authoritative when it has one; the session's own is the
		// fallback, because it is what the pane was started in.
		if (!row.cwd) row.cwd = row.session.cwd;
		if (!row.branch) row.branch = branchFor(row.cwd, worktrees);
		if (request.models && row.session.provider && row.session.modelId) {
			row.contextWindow = request.models.find(row.session.provider, row.session.modelId)?.contextWindow;
		}
		return row;
	});

	// Self first, then a stable order. The list is the point, so the row that is
	// easiest to find should not move between refreshes.
	rows.sort((left, right) => {
		if (left.self !== right.self) return left.self ? -1 : 1;
		const byWorkspace = left.workspaceId.localeCompare(right.workspaceId);
		return byWorkspace !== 0 ? byWorkspace : left.paneId.localeCompare(right.paneId);
	});
	return ok(rows);
}

interface WorktreeBranch {
	path: string;
	branch: string;
}

/** `worktree.list` for the calling checkout, or none when it cannot answer. */
async function worktreeBranches(client: HerdrClient, cwd: string): Promise<WorktreeBranch[]> {
	const listed = await client.request("worktree.list", { cwd });
	if (!listed.ok) return [];
	const worktrees: any[] = Array.isArray(listed.value?.worktrees) ? listed.value.worktrees : [];
	return worktrees
		.filter((worktree) => typeof worktree?.path === "string" && typeof worktree?.branch === "string")
		.map((worktree) => ({ path: worktree.path as string, branch: worktree.branch as string }));
}

/** The branch of the longest worktree path that contains `cwd`. */
function branchFor(cwd: string | undefined, worktrees: WorktreeBranch[]): string | undefined {
	if (!cwd) return undefined;
	let best: WorktreeBranch | undefined;
	for (const worktree of worktrees) {
		const prefix = worktree.path.endsWith("/") ? worktree.path : `${worktree.path}/`;
		if (cwd !== worktree.path && !cwd.startsWith(prefix)) continue;
		if (!best || worktree.path.length > best.path.length) best = worktree;
	}
	return best?.branch;
}

// ---------------------------------------------------------------- formatting

/** `1234` -> `1.2k`, `1234567` -> `1.2M`. */
export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	// Round to the shown precision before choosing the unit: 999,950 must read
	// 1.0M, not 1000.0k, or a context near a 1M window looks over the limit.
	const thousands = Number((tokens / 1_000).toFixed(1));
	if (thousands < 1_000) return `${thousands.toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** A dollar amount, with the `≥` that marks a lower bound. */
export function formatCost(cost: number, approximate: boolean): string {
	const amount = cost === 0 ? "$0" : cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
	return approximate ? `≥${amount}` : amount;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The model as `provider/model`, or undefined when the session named neither. */
function modelName(session: SessionSummary | undefined): string | undefined {
	if (!session?.provider || !session.modelId) return undefined;
	return `${session.provider}/${session.modelId}`;
}

// ------------------------------------------------------------------ overlay

type Mode = "list" | "detail";

export class FleetViewOverlay implements Component, Focusable {
	private readonly client: HerdrClient;
	private readonly t: Strings;
	private readonly request: FleetRequest;
	private tui!: TUI;
	private theme!: Theme;
	private done!: () => void;
	private rows: FleetRow[] = [];
	private mode: Mode = "list";
	private selected = 0;
	private scroll = 0;
	/**
	 * The body width the last render actually used, so scrolling counts the same
	 * wrapped lines that were drawn. The overlay is 90% of the terminal, so the
	 * terminal's own width would overestimate it and leave the detail's top
	 * unreachable.
	 */
	private bodyWidth = 24;
	private pending = false;
	private loaded = false;
	private error: string | undefined;
	private focusedState = false;

	constructor(client: HerdrClient, t: Strings, request: FleetRequest) {
		this.client = client;
		this.t = t;
		this.request = request;
	}

	get focused(): boolean {
		return this.focusedState;
	}

	set focused(value: boolean) {
		this.focusedState = value;
	}

	attach(tui: TUI, theme: Theme, done: () => void): void {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.focused = true;
		void this.refresh();
	}

	/** One snapshot, one pass over every session's tail. `r` calls this again. */
	async refresh(): Promise<void> {
		this.pending = true;
		this.error = undefined;
		this.tui.requestRender();
		const gathered = await gatherFleet(this.client, this.request);
		this.pending = false;
		this.loaded = true;
		if (gathered.ok) {
			this.rows = gathered.value;
			this.selected = this.rows.length === 0 ? 0 : Math.min(this.selected, this.rows.length - 1);
		} else {
			this.error = gathered.error;
		}
		this.tui.requestRender();
	}

	private current(): FleetRow | undefined {
		return this.rows[this.selected];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			if (this.mode === "detail") {
				this.mode = "list";
				this.scroll = 0;
				this.tui.requestRender();
				return;
			}
			this.done();
			return;
		}
		// `r` refreshes from either mode: the reason to press it is usually that
		// the row you are looking at is stale, which is when you are reading it.
		if (data === "r") {
			void this.refresh();
			return;
		}
		if (this.pending) return;
		if (this.mode === "list") this.handleListInput(data);
		else this.handleDetailInput(data);
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, Key.down)) {
			this.selected = Math.min(Math.max(0, this.rows.length - 1), this.selected + 1);
		} else if (/^[1-9]$/.test(data)) {
			const index = Number(data) - 1;
			if (index >= this.rows.length) return;
			this.selected = index;
			this.mode = "detail";
			this.scroll = 0;
		} else if (matchesKey(data, Key.enter)) {
			if (this.rows.length === 0) return;
			this.mode = "detail";
			this.scroll = 0;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, Key.pageUp)) {
			this.scrollBy(Math.max(3, this.bodyHeight() - 2));
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(-Math.max(3, this.bodyHeight() - 2));
			return;
		}
	}

	private scrollBy(lines: number): void {
		const total = this.detailLines(this.bodyWidth).length;
		const max = Math.max(0, total - this.bodyHeight());
		this.scroll = Math.min(max, Math.max(0, this.scroll + lines));
		this.tui.requestRender();
	}

	// ------------------------------------------------------------ render

	render(width: number): string[] {
		const inner = Math.max(24, width - 2);
		this.bodyWidth = inner - 4;
		this.selected = this.rows.length === 0 ? 0 : Math.min(this.selected, this.rows.length - 1);

		const header = [
			this.theme.bold(this.theme.fg("accent", this.t.viewTitle)),
			this.theme.fg("dim", this.t.viewCount(this.rows.length)),
			this.pending ? this.theme.fg("warning", this.t.viewLoading) : undefined,
		]
			.filter((part): part is string => part !== undefined)
			.join(this.theme.fg("dim", " · "));

		const body = (this.mode === "detail" ? this.detailLines(this.bodyWidth) : this.listLines(this.bodyWidth)).map((line) =>
			truncateToWidth(line, this.bodyWidth),
		);
		const bodyHeight = this.bodyHeight();
		const maxScroll = Math.max(0, body.length - bodyHeight);
		let start: number;
		if (this.mode === "detail") {
			if (this.scroll > maxScroll) this.scroll = maxScroll;
			start = Math.max(0, body.length - bodyHeight - this.scroll);
		} else {
			// The window follows the selection. The list can be longer than a short
			// pane, and the first row is the calling pane: it must not scroll off
			// while it is selected, or it can never be selected back into view.
			start = Math.max(0, Math.min(this.selected - bodyHeight + 1, maxScroll));
		}

		const lines: string[] = [this.rule(inner, "╭", "╮")];
		lines.push(this.frame(`  ${truncateToWidth(header, inner - 4)}`, inner));
		lines.push(this.rule(inner, "├", "┤"));
		const visible = body.slice(start, start + bodyHeight);
		for (const line of visible) lines.push(this.frame(`  ${line}`, inner));
		for (let index = visible.length; index < bodyHeight; index += 1) lines.push(this.frame("", inner));
		if (start > 0) lines.push(this.frame(`  ${this.theme.fg("warning", this.t.above(start))}`, inner));

		if (this.error) {
			for (const line of wrapTextWithAnsi(this.theme.fg("error", this.t.viewError(this.error)), inner - 4)) {
				lines.push(this.frame(`  ${line}`, inner));
			}
		}
		const keys = this.mode === "detail" ? this.t.viewDetailKeys : this.t.viewListKeys;
		lines.push(this.frame(`  ${truncateToWidth(this.theme.fg("dim", keys), inner - 4)}`, inner));
		lines.push(this.rule(inner, "╰", "╯"));
		return lines;
	}

	private listLines(width: number): string[] {
		if (!this.loaded) return [this.theme.fg("dim", this.t.viewLoading)];
		if (this.rows.length === 0) return [this.theme.fg("dim", this.t.viewEmpty)];
		return this.rows.map((row, index) => {
			const marker = index === this.selected ? this.theme.fg("accent", ">") : " ";
			return truncateToWidth(`${marker} ${this.rowLine(row)}`, width);
		});
	}

	/** One pane, one line: the pane id, then the last user message, then the name
	 * and the state. The message comes before them because it is the one column
	 * that says what the pane is doing, and a narrow pane cuts the row from the
	 * right; the pane id already carries the identity, so a name is only added
	 * when there is one. The numbers are detail-only. */
	private rowLine(row: FleetRow): string {
		const parts: string[] = [this.theme.fg("dim", row.paneId)];
		if (row.self) parts.push(this.theme.fg("accent", `[${this.t.viewSelf}]`));
		if (row.sessionError) {
			parts.push(this.theme.fg("error", this.t.viewUnreadable));
		} else if (!row.sessionPath) {
			parts.push(this.theme.fg("dim", this.t.viewNoSession));
		} else if (row.session?.lastUser) {
			parts.push(oneLine(row.session.lastUser));
		}
		const label = row.name ?? row.agent;
		if (label) parts.push(this.theme.bold(label));
		parts.push(this.theme.fg(row.status === "blocked" ? "warning" : "muted", row.status));
		return parts.join(this.theme.fg("dim", " · "));
	}

	private detailLines(width: number): string[] {
		const row = this.current();
		if (!row) return [];
		const t = this.t;
		const header: string[] = [this.theme.fg("dim", row.paneId)];
		if (row.self) header.push(this.theme.fg("accent", `[${t.viewSelf}]`));
		const label = row.name ?? row.agent;
		if (label) header.push(this.theme.bold(label));
		header.push(this.theme.fg(row.status === "blocked" ? "warning" : "muted", row.status));
		const lines: string[] = [header.join(" · "), ""];
		const field = (label: string, value: string | undefined) => {
			if (value === undefined || value === "") return;
			lines.push(this.theme.fg("dim", `${label}: `) + value);
		};

		field(t.viewModel, modelName(row.session));
		if (typeof row.session?.contextTokens === "number") {
			const percent = row.contextWindow
				? ` (${Math.round((row.session.contextTokens / row.contextWindow) * 100)}% ${t.viewOf} ${formatTokens(row.contextWindow)})`
				: "";
			field(t.viewContext, `${formatTokens(row.session.contextTokens)}${percent}`);
		}
		if (row.session) field(t.viewCost, formatCost(row.session.cost, row.session.truncated));
		field(t.viewCwd, row.cwd);
		field(t.viewBranch, row.branch);
		field(t.viewRunningTool, row.session?.runningTool);
		lines.push("");

		field(t.viewLastUser, row.session?.lastUser ? oneLine(row.session.lastUser) : undefined);
		lines.push("");
		if (row.sessionError) {
			lines.push(this.theme.fg("error", t.viewError(row.sessionError)));
		} else if (!row.sessionPath) {
			lines.push(this.theme.fg("dim", t.viewNoSession));
		} else if (row.session?.lastAssistant) {
			lines.push(this.theme.fg("dim", `${t.viewLastAssistant}:`));
			lines.push(...wrapTextWithAnsi(row.session.lastAssistant, width));
		}
		if (row.session?.truncated) {
			lines.push("");
			lines.push(this.theme.fg("warning", t.viewApprox));
		}
		return lines;
	}

	private bodyHeight(): number {
		return Math.max(3, this.height() - 6);
	}

	private height(): number {
		// The caller caps the overlay at 85% of the terminal, so rendering more than
		// that lets the TUI clip the footer off a short pane — and the body height
		// below would then be larger than what is actually on screen, so the
		// selection would scroll out of view.
		const max = Math.max(9, Math.floor(this.tui.terminal.rows * 0.85));
		const wanted = this.mode === "detail" ? max : Math.min(max, 8 + this.rows.length);
		return Math.max(9, wanted);
	}

	private rule(width: number, left: string, right: string): string {
		return this.theme.fg("borderMuted", left + "─".repeat(Math.max(0, width)) + right);
	}

	private frame(line: string, width: number): string {
		const border = this.theme.fg("borderMuted", "│");
		return border + line + " ".repeat(Math.max(0, width - visibleWidth(line))) + border;
	}
}
