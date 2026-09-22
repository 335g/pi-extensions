/**
 * approvals: the approval broker.
 *
 * herdr already knows which panes are waiting on a human (`agent_status ===
 * "blocked"`). This module keeps that list, fetches the question each blocked
 * pane is asking, and answers it from an overlay on the pane the human is
 * actually looking at.
 *
 * herdr stays the source of truth: the list is built from `session.snapshot`
 * and corrected by `pane.agent_status_changed`. Nothing is remembered across a
 * reconnect, and a failed answer is never retried — herdr's timeout is not
 * proof the input never arrived.
 */

import { type Theme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	type TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import {
	type AgentStatus,
	type HerdrClient,
	type Outcome,
	type Snapshot,
	type SubscribeEvent,
	type SubscriptionHandle,
	err,
} from "./herdr-client.ts";

export interface BlockedPane {
	pane_id: string;
	workspace_id: string;
	agent?: string | null;
	name?: string | null;
	state_labels?: Record<string, string>;
	/** What the pane is asking, read once when it became blocked. */
	question?: string;
}

/** Events that change the pane set, and so the subscription set. */
const LIFECYCLE_EVENTS = ["pane.created", "pane.closed"];

export class ApprovalBroker {
	private readonly client: HerdrClient;
	private readonly onNewBlocked: (entry: BlockedPane) => void;
	private readonly blocked = new Map<string, BlockedPane>();
	private handle: SubscriptionHandle | undefined;
	private coveredPanes = "";
	/** New-blocked notifications only make sense once the first snapshot landed. */
	private primed = false;
	private stopped = true;
	private lastError: string | undefined;
	private onChange: (() => void) | undefined;

	constructor(client: HerdrClient, onNewBlocked: (entry: BlockedPane) => void) {
		this.client = client;
		this.onNewBlocked = onNewBlocked;
	}

	entries(): BlockedPane[] {
		return [...this.blocked.values()];
	}

	/** The last transport or herdr failure worth showing the user. */
	error(): string | undefined {
		return this.lastError;
	}

	setOnChange(onChange: (() => void) | undefined): void {
		this.onChange = onChange;
	}

	async start(): Promise<void> {
		this.stopped = false;
		await this.refresh();
		this.primed = true;
	}

	stop(): void {
		this.stopped = true;
		this.handle?.close();
		this.handle = undefined;
		this.coveredPanes = "";
		this.blocked.clear();
		this.primed = false;
		this.lastError = undefined;
	}

	async sendText(paneId: string, text: string): Promise<Outcome<void>> {
		const result = await this.client.paneSendInput(paneId, text);
		this.lastError = result.ok ? undefined : result.error;
		return result;
	}

	async sendKeys(paneId: string, keys: string[]): Promise<Outcome<void>> {
		if (keys.length === 0) return err("no keys to send");
		const result = await this.client.paneSendKeys(paneId, keys);
		this.lastError = result.ok ? undefined : result.error;
		return result;
	}

	/** Rebuild the pane set and the blocked list from herdr's own state. */
	private async refresh(): Promise<void> {
		if (this.stopped) return;
		const snapshot = await this.client.snapshot();
		if (!snapshot.ok) {
			this.lastError = snapshot.error;
			this.notifyChange();
			return;
		}
		this.lastError = undefined;
		this.apply(snapshot.value);
		this.notifyChange();
		this.resubscribe(snapshot.value);
	}

	private apply(snapshot: Snapshot): void {
		const self = this.client.selfPaneId();
		const previous = new Map(this.blocked);
		this.blocked.clear();
		for (const agent of snapshot.agents) {
			if (agent.pane_id === self || agent.agent_status !== "blocked") continue;
			this.setBlocked(
				{
					pane_id: agent.pane_id,
					workspace_id: agent.workspace_id,
					agent: agent.agent ?? agent.display_agent,
					name: agent.name,
					state_labels: agent.state_labels,
					// The snapshot does not carry the question; keep one already read.
					question: previous.get(agent.pane_id)?.question,
				},
				previous.has(agent.pane_id),
			);
		}
		// A pane that left the list was answered or died; either way it is done here.
		for (const paneId of previous.keys()) {
			if (!this.blocked.has(paneId)) this.clearBlocked(paneId);
		}
	}

	/** The single place a row appears, so a notification cannot be missed by a routing bug. */
	private setBlocked(entry: BlockedPane, wasKnown: boolean): void {
		this.blocked.set(entry.pane_id, entry);
		this.notifyChange();
		if (entry.question === undefined) void this.loadQuestion(entry.pane_id);
		// The first snapshot is not news.
		if (!wasKnown && this.primed) this.onNewBlocked(entry);
	}

	private clearBlocked(paneId: string): void {
		if (this.blocked.delete(paneId)) this.notifyChange();
	}

	/** The subscription set is fixed per connection, so a changed pane set is a new connection. */
	private resubscribe(snapshot: Snapshot): void {
		const paneIds = snapshot.panes.map((pane) => pane.pane_id);
		const covered = paneIds.join(",");
		if (this.handle && covered === this.coveredPanes) return;
		this.coveredPanes = covered;
		this.handle?.close();
		this.handle = this.client.subscribe(
			[
				...LIFECYCLE_EVENTS.map((type) => ({ type })),
				...paneIds.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
			],
			(event) => this.onSubscribeEvent(event),
		);
	}

	private onSubscribeEvent(event: SubscribeEvent): void {
		if (this.stopped) return;
		if (event.kind === "resync") {
			// The stream was rebuilt: trust herdr over anything derived from the old one.
			if (event.reason === "refused") {
				// The set that failed is the one in `coveredPanes`; dropping it makes
				// the resubscribe below open a fresh set from the new snapshot.
				this.handle?.close();
				this.handle = undefined;
				this.coveredPanes = "";
			}
			if (event.snapshot.ok) {
				this.lastError = undefined;
				this.apply(event.snapshot.value);
				this.resubscribe(event.snapshot.value);
			} else {
				this.lastError = event.snapshot.error;
			}
			this.notifyChange();
			return;
		}

		const { event: name, data } = event.event;
		if (name === "pane.agent_status_changed") {
			this.onStatusChanged(data);
			return;
		}
		// Lifecycle events arrive as `pane.created` or the schema's underscored
		// `pane_created`; both land here. The pane inventory and its state live in
		// herdr anyway, so one snapshot is the cheapest correct answer, and a
		// dropped event costs nothing but that snapshot.
		if ((name === "pane.closed" || name === "pane_closed") && typeof data.pane_id === "string") {
			this.clearBlocked(data.pane_id);
		}
		void this.refresh();
	}

	private onStatusChanged(data: Record<string, any>): void {
		const paneId = data.pane_id;
		if (typeof paneId !== "string" || paneId === this.client.selfPaneId()) return;
		if (data.agent_status !== "blocked") {
			this.clearBlocked(paneId);
			return;
		}
		this.setBlocked(
			{
				pane_id: paneId,
				workspace_id: typeof data.workspace_id === "string" ? data.workspace_id : "",
				agent: data.display_agent ?? data.agent ?? undefined,
				state_labels: data.state_labels,
			},
			this.blocked.has(paneId),
		);
	}

	private async loadQuestion(paneId: string): Promise<void> {
		// `detection` is herdr's own reading of the prompt UI; it is empty for an
		// agent herdr cannot classify, so the rendered viewport is the fallback.
		let read = await this.client.agentRead(paneId, "detection");
		if (read.ok && read.value.trim() === "") read = await this.client.agentRead(paneId, "visible");
		this.lastError = read.ok ? undefined : read.error;
		const entry = this.blocked.get(paneId);
		if (!entry) return;
		if (read.ok) entry.question = read.value.trim();
		this.notifyChange();
	}

	private notifyChange(): void {
		this.onChange?.();
	}
}

// ---------------------------------------------------------------- strings

export interface Strings {
	title: string;
	count(count: number): string;
	empty: string;
	above(lines: number): string;
	listKeys: string;
	detailKeys: string;
	answer: string;
	answerHint: string;
	noResend: string;
	sent: string;
	sending: string;
	noQuestion: string;
	blockedNotification(who: string): string;
	unknownSubcommand(name: string): string;
	state(entry: BlockedPane): string;
	recipeUsage: string;
	recipeSaving(name: string): string;
	recipeSaved(name: string, panes: number, path: string): string;
	recipeApplied(name: string, panes: number): string;
	recipeNone: string;
	recipeList(recipes: { name: string; panes: number }[]): string;
	worktreeUsage: string;
	worktreeCreating(branch: string): string;
	worktreeCreated(branch: string, path: string, workspaceId: string, env: string): string;
	worktreeWarningPrefix: string;
	forkUsage: string;
	forkUnknownScope(id: string, known: string): string;
	forkCreating(branch: string): string;
	forkCreated(branch: string, path: string, workspaceId: string, state: string): string;
	forkNoStart: string;
	forkRunning(paneId: string, agent: string, prepare: string): string;
	forkFailed(path: string, error: string): string;
	forkSeedFailed(path: string, error: string): string;
	forkNoInstall: string;
	forkInstalled(command: string): string;
	forkInstallFailed(command: string, error: string): string;
}

const JA: Strings = {
	title: "fleet",
	count: (count) => `承認待ち ${count} 件`,
	empty: "承認待ちの pane はありません",
	above: (lines) => `↑ ${lines} 行`,
	listKeys: "↑↓ 選択 · Enter 開く · Esc 閉じる",
	detailKeys: "Enter テキスト送信 · ctrl+k 生キー送信 · PgUp/PgDn · Esc 戻る",
	answer: "回答",
	answerHint: "テキスト、または生キー（esc / 1 / up …）",
	noResend: "失敗しても自動では再送しません",
	sent: "送信しました",
	sending: "送信中…",
	noQuestion: "（質問文を取得中…）",
	blockedNotification: (who) => `${who} が承認待ちです`,
	unknownSubcommand: (name) => `不明なサブコマンド: ${name}`,
	state: (entry) => entry.state_labels?.blocked ?? "blocked",
	recipeUsage: "使い方: /fleet recipe save <name> | apply <name> [--start] | ls",
	recipeSaving: (name) => `レシピ ${name} を保存中…`,
	recipeSaved: (name, panes, path) => `レシピ ${name} を保存しました（${panes} pane · ${path}）`,
	recipeApplied: (name, panes) => `レシピ ${name} を新しい tab に適用しました（${panes} pane）`,
	recipeNone: "レシピはまだありません",
	recipeList: (recipes) => `レシピ: ${recipes.map((recipe) => `${recipe.name} (${recipe.panes})`).join(", ")}`,
	worktreeUsage: "使い方: /fleet worktree create <branch> [--base <ref>] [--label <text>]",
	worktreeCreating: (branch) => `worktree ${branch} を作成中…`,
	worktreeCreated: (branch, path, workspaceId, env) => `worktree ${branch} を作成しました（${workspaceId} · ${path}）— ${env}`,
	worktreeWarningPrefix: "worktree の環境:",
	forkUsage: '使い方: /fleet fork <branch> --task "<text>" [--base <ref>] [--scope implementation] [--no-install] [--no-start]',
	forkUnknownScope: (id, known) => `不明なスコープ: ${id}（使えるのは ${known}）`,
	forkCreating: (branch) => `fork ${branch} を準備中…`,
	forkCreated: (branch, path, workspaceId, state) => `fork ${branch}（${workspaceId} · ${path}）— ${state}`,
	forkNoStart: "--no-start のため pane も agent も作成していません",
	forkRunning: (paneId, agent, prepare) => `pane ${paneId} · agent ${agent} · ${prepare}`,
	forkFailed: (path, error) => `worktree ${path} は作成済みですが起動に失敗しました: ${error}`,
	forkSeedFailed: (path, error) => `worktree ${path} の agent は起動しましたが seed を送れませんでした: ${error}`,
	forkNoInstall: "install なし（lockfile が無いか --no-install）",
	forkInstalled: (command) => `${command} 完了`,
	forkInstallFailed: (command, error) => `${command} 失敗（${error}）`,
};

const EN: Strings = {
	title: "fleet",
	count: (count) => `${count} waiting`,
	empty: "No pane is waiting for approval",
	above: (lines) => `↑ ${lines} lines`,
	listKeys: "↑↓ select · Enter open · Esc close",
	detailKeys: "Enter send text · ctrl+k send keys · PgUp/PgDn · Esc back",
	answer: "Answer",
	answerHint: "text, or raw keys (esc / 1 / up ...)",
	noResend: "A failure is never retried automatically",
	sent: "Sent",
	sending: "Sending...",
	noQuestion: "(reading the question...)",
	blockedNotification: (who) => `${who} is waiting for approval`,
	unknownSubcommand: (name) => `Unknown subcommand: ${name}`,
	state: (entry) => entry.state_labels?.blocked ?? "blocked",
	recipeUsage: "Usage: /fleet recipe save <name> | apply <name> [--start] | ls",
	recipeSaving: (name) => `Saving recipe ${name}...`,
	recipeSaved: (name, panes, path) => `Saved recipe ${name} (${panes} panes · ${path})`,
	recipeApplied: (name, panes) => `Applied recipe ${name} as a new tab (${panes} panes)`,
	recipeNone: "No recipes yet",
	recipeList: (recipes) => `Recipes: ${recipes.map((recipe) => `${recipe.name} (${recipe.panes})`).join(", ")}`,
	worktreeUsage: "Usage: /fleet worktree create <branch> [--base <ref>] [--label <text>]",
	worktreeCreating: (branch) => `Creating worktree ${branch}...`,
	worktreeCreated: (branch, path, workspaceId, env) => `Created worktree ${branch} (${workspaceId} · ${path}) — ${env}`,
	worktreeWarningPrefix: "worktree environment:",
	forkUsage: 'Usage: /fleet fork <branch> --task "<text>" [--base <ref>] [--scope implementation] [--no-install] [--no-start]',
	forkUnknownScope: (id, known) => `Unknown scope: ${id} (available: ${known})`,
	forkCreating: (branch) => `Preparing fork ${branch}...`,
	forkCreated: (branch, path, workspaceId, state) => `Forked ${branch} (${workspaceId} · ${path}) — ${state}`,
	forkNoStart: "--no-start: no pane and no agent were created",
	forkRunning: (paneId, agent, prepare) => `pane ${paneId} · agent ${agent} · ${prepare}`,
	forkFailed: (path, error) => `worktree ${path} exists, but starting it failed: ${error}`,
	forkSeedFailed: (path, error) => `the agent in ${path} started, but the seed was not delivered: ${error}`,
	forkNoInstall: "no install (no lockfile, or --no-install)",
	forkInstalled: (command) => `${command} finished`,
	forkInstallFailed: (command, error) => `${command} failed (${error})`,
};

export function strings(): Strings {
	const locale = process.env.LC_ALL ?? process.env.LANG ?? "";
	return /^ja/i.test(locale) ? JA : EN;
}

// ---------------------------------------------------------------- overlay

type Mode = "list" | "detail";

function label(entry: BlockedPane, t: Strings): string {
	return entry.name ?? entry.agent ?? entry.pane_id;
}

export class FleetOverlay implements Component, Focusable {
	private readonly broker: ApprovalBroker;
	private readonly t: Strings;
	private tui!: TUI;
	private theme!: Theme;
	private done!: () => void;
	private editor: Editor | undefined;
	private mode: Mode = "list";
	private selected = 0;
	private scroll = 0;
	private pending = false;
	private error: string | undefined;
	private status: string | undefined;
	private focusedState = false;
	private editorHeight = 3;

	constructor(broker: ApprovalBroker, t: Strings) {
		this.broker = broker;
		this.t = t;
	}

	get focused(): boolean {
		return this.focusedState;
	}

	// IME preedit follows the inner editor, so it has to own the focus flag.
	set focused(value: boolean) {
		this.focusedState = value;
		if (this.editor) this.editor.focused = value && this.mode === "detail";
	}

	attach(tui: TUI, theme: Theme, done: () => void): void {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		if (!this.editor) {
			const editorTheme: EditorTheme = {
				borderColor: (text) => this.theme.fg("borderMuted", text),
				selectList: getSelectListTheme(),
			};
			this.editor = new Editor(tui, editorTheme, { paddingX: 1 });
			this.editor.disableSubmit = true;
			this.editor.onChange = () => this.tui.requestRender();
		}
		this.focused = true;
	}

	private current(): BlockedPane | undefined {
		return this.broker.entries()[this.selected];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			if (this.mode === "detail") {
				this.mode = "list";
				this.error = undefined;
				this.scroll = 0;
				this.focused = true;
				this.tui.requestRender();
				return;
			}
			this.done();
			return;
		}
		if (this.pending) return;
		if (this.mode === "list") this.handleListInput(data);
		else this.handleDetailInput(data);
	}

	private handleListInput(data: string): void {
		const entries = this.broker.entries();
		if (matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, Key.down)) {
			this.selected = Math.min(Math.max(0, entries.length - 1), this.selected + 1);
		} else if (/^[1-9]$/.test(data)) {
			const index = Number(data) - 1;
			if (index >= entries.length) return;
			this.selected = index;
			this.openDetail();
		} else if (matchesKey(data, Key.enter)) {
			if (entries.length === 0) return;
			this.openDetail();
		} else {
			return;
		}
		this.tui.requestRender();
	}

	private openDetail(): void {
		this.mode = "detail";
		this.scroll = 0;
		this.error = undefined;
		this.status = undefined;
		this.editor?.setText("");
		this.focused = true;
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
		if (matchesKey(data, Key.ctrl("k"))) {
			void this.send("keys");
			return;
		}
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			void this.send("text");
			return;
		}
		this.editor?.handleInput(data);
		this.tui.requestRender();
	}

	private scrollBy(lines: number): void {
		const total = this.questionLines(this.contentWidth()).length;
		const max = Math.max(0, total - this.bodyHeight());
		this.scroll = Math.min(max, Math.max(0, this.scroll + lines));
		this.tui.requestRender();
	}

	private async send(route: "keys" | "text"): Promise<void> {
		const entry = this.current();
		if (!entry) {
			this.mode = "list";
			this.tui.requestRender();
			return;
		}
		const input = (this.editor?.getText() ?? "").trim();
		if (route === "text" && input === "") return;
		// An empty ctrl+k is a bare Enter, which is what most approval dialogs want.
		const keys = input === "" ? ["enter"] : input.split(/\s+/);

		this.pending = true;
		this.error = undefined;
		this.status = this.t.sending;
		this.tui.requestRender();

		const result =
			route === "keys" ? await this.broker.sendKeys(entry.pane_id, keys) : await this.broker.sendText(entry.pane_id, input);

		this.pending = false;
		if (result.ok) {
			// The row stays until herdr reports the new status: a write that
			// succeeded is not proof the agent moved on.
			this.status = this.t.sent;
			this.mode = "list";
			this.editor?.setText("");
			this.focused = true;
		} else {
			this.status = undefined;
			this.error = result.error;
		}
		this.tui.requestRender();
	}

	// ------------------------------------------------------------ render

	render(width: number): string[] {
		const inner = Math.max(24, width - 2);
		const entries = this.broker.entries();
		this.selected = entries.length === 0 ? 0 : Math.min(this.selected, entries.length - 1);

		const header = [
			this.theme.bold(this.theme.fg("accent", this.t.title)),
			this.theme.fg("dim", this.t.count(entries.length)),
		].join(this.theme.fg("dim", " · "));

		const body = this.mode === "detail" ? this.questionLines(inner - 4) : this.listLines(entries, inner - 4);
		const bodyHeight = this.bodyHeight();
		const maxScroll = Math.max(0, body.length - bodyHeight);
		if (this.scroll > maxScroll) this.scroll = maxScroll;
		const start = Math.max(0, body.length - bodyHeight - this.scroll);

		const lines: string[] = [this.rule(inner, "╭", "╮")];
		lines.push(this.frame(`  ${truncateToWidth(header, inner - 4)}`, inner));
		lines.push(this.rule(inner, "├", "┤"));
		const visible = body.slice(start, start + bodyHeight);
		for (const line of visible) lines.push(this.frame(`  ${line}`, inner));
		for (let i = visible.length; i < bodyHeight; i++) lines.push(this.frame("", inner));

		if (this.mode === "detail") {
			const hint = this.theme.fg("dim", `${this.t.answer}: ${this.t.answerHint}`);
			lines.push(this.frame(`  ${truncateToWidth(hint, inner - 4)}`, inner));
			const editorLines = this.editor?.render(inner - 2) ?? [];
			this.editorHeight = Math.max(1, editorLines.length);
			for (const line of editorLines) lines.push(this.frame(` ${line}`, inner));
		}

		if (start > 0) lines.push(this.frame(`  ${this.theme.fg("warning", this.t.above(start))}`, inner));
		const notice = this.error
			? this.theme.fg("error", this.error)
			: this.status
				? this.theme.fg(this.status === this.t.sent ? "success" : "muted", this.status)
				: this.broker.error()
					? this.theme.fg("warning", this.broker.error()!)
					: undefined;
		for (const line of notice ? wrapTextWithAnsi(notice, inner - 4) : []) lines.push(this.frame(`  ${line}`, inner));

		const keys = this.mode === "detail" && !this.error ? `${this.t.detailKeys} · ${this.t.noResend}` : this.mode === "detail" ? this.t.detailKeys : this.t.listKeys;
		lines.push(this.frame(`  ${truncateToWidth(this.theme.fg("dim", keys), inner - 4)}`, inner));
		lines.push(this.rule(inner, "╰", "╯"));
		return lines;
	}

	private listLines(entries: BlockedPane[], width: number): string[] {
		if (entries.length === 0) return [this.theme.fg("dim", this.t.empty)];
		return entries.map((entry, index) => {
			const marker = index === this.selected ? this.theme.fg("accent", ">") : " ";
			const parts = [
				this.theme.fg("dim", `${entry.workspace_id} `),
				this.theme.bold(label(entry, this.t)),
				this.theme.fg("dim", ` ${entry.pane_id}`),
				this.theme.fg("warning", ` ${this.t.state(entry)}`),
			].join("");
			return truncateToWidth(`${marker} ${parts}`, width);
		});
	}

	private questionLines(width: number): string[] {
		const entry = this.current();
		if (!entry) return [];
		return [
			this.theme.fg("dim", `${label(entry, this.t)} · ${entry.pane_id}`),
			"",
			...wrapTextWithAnsi(entry.question ?? this.t.noQuestion, width),
		];
	}

	private bodyHeight(): number {
		const chrome = this.mode === "detail" ? this.editorHeight + 7 : 6;
		return Math.max(3, this.height() - chrome);
	}

	private height(): number {
		const rows = this.mode === "detail" ? Math.floor(this.tui.terminal.rows * 0.7) : Math.min(16, 8 + this.broker.entries().length);
		return Math.max(10, rows);
	}

	private contentWidth(): number {
		return Math.max(24, this.tui.terminal.columns - 6);
	}

	private rule(width: number, left: string, right: string): string {
		return this.theme.fg("borderMuted", left + "─".repeat(Math.max(0, width)) + right);
	}

	private frame(line: string, width: number): string {
		const border = this.theme.fg("borderMuted", "│");
		return border + line + " ".repeat(Math.max(0, width - visibleWidth(line))) + border;
	}
}
