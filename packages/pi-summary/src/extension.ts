import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, copyToClipboard } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	MODE_KEYS,
	MODE_TRANSITIONS,
	type Mode,
	type Range,
	canMove,
	pageTarget,
	panelRows,
	revealOffset,
	scrollWithin,
	sliceWindow,
	toggleShow,
	type Show,
} from "./panel.ts";
import { helpLines, helpWidth } from "./help.ts";
import { buildAdoptPrompt, buildHandoffPrompt, buildHandoffText, buildHandoffUpdatePrompt, computeCoverage, insertBullet, parseAdopt, parseHandoff, stripSources, type Handoff } from "./handoff.ts";
import { buildCommentPrompt, buildMinPrompt, groupRallies } from "./summarize.ts";
import { DEFAULT_AUTO, parseAutoConfig, shouldRefreshHandoff, shouldRefreshMin, type AutoConfig } from "./auto.ts";
import { HANDOFF_ID, MIN_ID, STORE, type DeferredItem, type Saved, type Store, readStore } from "./store.ts";
import { extractTurns, type Turn } from "./turns.ts";
import { buildWorkPrompt, extractWorkBetween } from "./work.ts";
import { type Card, type Content, cardsContent } from "./view.ts";

type Theme = { fg(key: string, text: string): string; bold(text: string): string; bg(key: string, text: string): string };
type Tui = {
	requestRender(): void;
	terminal: { rows: number; columns?: number };
	showOverlay(component: Component, options?: { anchor?: string; width?: string | number; maxHeight?: number; margin?: number }): { hide(): void };
};
type Component = { render(width: number): string[]; invalidate(): void; handleInput(data: string): void };
type View = { title: string; cards: Card[]; handoff?: Handoff };
type Outcome = string | { kind: "toggle" } | undefined;
type Sources = {
	view(mode: Mode): Promise<View>;
	/** 保留項目を引き継ぎ書向けに再要約する。 */
	adopt(item: DeferredItem): Promise<{ section: string; bullet: string }>;
	/** 引き継ぎ書の全文をエディタで編集する。中止時は undefined。 */
	edit(text: string): Promise<string | undefined>;
	/** このセッションに保存済みの要約。再開時もここから引く。 */
	store: Store;
	save(data: Saved): void;
	/** 保存済み要約をブランチから読み直す（背景要約の完了後）。 */
	reloadStore(): void;
	/** 保存が起きるたびの通知。戻り値は解除関数。 */
	onStoreUpdate(callback: () => void): () => void;
	/** コメント要約をバックグラウンドで開始する。 */
	summarizeComments(targets: { entryId: string; text: string }[]): void;
	/** 作業要約をバックグラウンドで開始する。 */
	summarizeWorks(targets: { entryId: string; startId: string; endId?: string }[]): void;
};

type ShowKind = keyof Show;
const SHOW_KEYS: Record<string, ShowKind> = { b: "text", h: "summary", w: "work" };
const SHOW_LABELS: Record<ShowKind, string> = { text: "本文", summary: "要約", work: "作業" };

const MODE_LABELS: Record<Mode, string> = { rallies: "会話", min: "全体要約", handoff: "引き継ぎ" };
const MODE_KEYS_FOR: Record<Mode, string> = { rallies: "s", min: "m", handoff: "s" };

/**
 * エディタ領域に差し込む下部パネル（overlay にしない）。
 * 高さは render が返す行数で決まるので、本文は自分で切り出して上限を守る。
 * 要約はモードではなく、表示中の一覧へカードとして差し込む。
 */
class SummaryPanel {
	private readonly sources: Sources;
	private theme: Theme;
	private tui: Tui;
	private done: (value?: Outcome) => void;
	private overlay: boolean;
	private border: DynamicBorder;
	private readonly cache = new Map<Mode, View>();
	private mode: Mode;
	private title = "";
	private cards: Card[] = [];
	private handoff: Handoff | undefined;
	private content: Content | undefined;
	private bodyLines: string[] = [];
	private ranges: Range[] = [];
	private phase: "loading" | "ready" | "error" = "loading";
	private error = "";
	private note = "";
	private working = false;
	private closed = false;
	private show: Show = { text: true, summary: true, work: true };
	private help: { hide(): void } | undefined;
	private selected = 0;
	private offset = 0;
	private renderedWidth = -1;
	private renderedSelected = -2;
	private unsubStore: (() => void) | undefined;

	constructor(sources: Sources, theme: Theme, tui: Tui, done: (value?: Outcome) => void, overlay: boolean) {
		this.sources = sources;
		this.theme = theme;
		this.tui = tui;
		this.done = done;
		this.overlay = overlay;
		this.border = new DynamicBorder((s: string) => theme.fg("accent", s));
		this.mode = "rallies";
		this.unsubStore = sources.onStoreUpdate(() => {
			this.sources.reloadStore();
			if (this.closed) return;
			if (this.mode === "min") {
				this.cache.delete("min");
				void this.load("min");
				return;
			}
			if (this.phase === "ready") {
				this.rebuild();
				this.tui.requestRender();
			}
		});
		void this.load(this.mode);
	}

	/** 表示方法（overlay / 下部パネル）を切り替えて開き直すときに、新しい環境を結び付ける。 */
	attach(theme: Theme, tui: Tui, done: (value?: Outcome) => void, overlay: boolean): void {
		this.theme = theme;
		this.tui = tui;
		this.done = done;
		this.overlay = overlay;
		this.border = new DynamicBorder((s: string) => theme.fg("accent", s));
		this.renderedWidth = -1;
		this.closed = false;
	}

	private async load(mode: Mode): Promise<void> {
		this.mode = mode;
		this.note = "";
		const cached = this.cache.get(mode);
		// 会話は coverage マーカーが最新の引き継ぎ状態を映すため、毎回作り直す。
		if (cached && mode !== "rallies") {
			this.apply(cached);
			return this.tui.requestRender();
		}
		this.phase = "loading";
		this.tui.requestRender();
		try {
			const view = await this.sources.view(mode);
			this.cache.set(mode, view);
			this.apply(view);
		} catch (error) {
			this.phase = "error";
			this.error = error instanceof Error ? error.message : String(error);
		}
		this.tui.requestRender();
	}

	private apply(view: View): void {
		this.title = view.title;
		this.cards = view.cards;
		this.handoff = view.handoff;
		this.selected = 0;
		this.offset = 0;
		this.phase = "ready";
		this.rebuild();
	}

	/** 要約はカードの内側に持たせる。差し込みで選択位置がずれない。 */
	private decorate(cards: Card[]): Card[] {
		const { summaries, works } = this.sources.store;
		return cards.map((card) => {
			if (!card.entryId) return card;
			const summary = summaries.get(card.entryId);
			const work = works.get(card.entryId);
			// 本文を隠しても、要約も作業も無いカードは本文だけ出す。
			const text = this.show.text || (!summary && !work) ? card.text : "";
			const nextSummary = this.show.summary ? summary : undefined;
			const nextWork = this.show.work ? work : undefined;
			if (text === card.text && nextSummary === summary && nextWork === work) return card;
			return { ...card, text, summary: nextSummary, work: nextWork };
		});
	}

	private rebuild(): void {
		this.content = cardsContent(this.decorate(this.cards), this.theme);
		this.renderedWidth = -1;
	}

	render(width: number): string[] {
		if (this.content && this.phase === "ready" && (width !== this.renderedWidth || this.selected !== this.renderedSelected)) {
			const rendered = this.content.render(width, this.selected);
			this.bodyLines = rendered.lines;
			this.ranges = rendered.ranges;
			this.renderedWidth = width;
			this.renderedSelected = this.selected;
		}
		const header = this.mode === "handoff" ? this.coverageHeader(width) : [];
		const rows = Math.max(1, this.visibleRows() - header.length);
		const win = this.phase === "ready" ? sliceWindow(this.bodyLines, this.offset, rows) : { lines: [], offset: this.offset };
		this.offset = win.offset;
		const body =
			this.phase === "error"
				? [this.theme.fg("error", ` ${this.error}`)]
				: this.phase === "loading"
					? [this.theme.fg("dim", " モデルが要約しています…")]
					: win.lines;
		// 全画面は本文が短くても高さを埋める。埋めないと下に元の画面が見える。
		const filled = this.overlay ? [...body, ...Array.from({ length: Math.max(0, rows - body.length) }, () => "")] : body;
		const name = this.phase === "ready" && this.ranges.length ? `${this.note || "選択"} ${this.selected + 1}/${this.ranges.length}  ` : "";
		const range = this.bodyLines.length ? `${win.offset + 1}-${win.offset + win.lines.length}/${this.bodyLines.length}  ` : "";
		return [
			this.border.render(width)[0] ?? "",
			` ${this.titleLine()}`,
			...header,
			...filled,
			this.theme.fg("dim", ` ${name}${range}${this.hint()}`),
			this.border.render(width)[0] ?? "",
		];
	}

	/** 本文 / 要約 / 作業を個別に切り替える。残り 1 種だけなら消さない。 */
	private toggle(kind: ShowKind): void {
		const next = toggleShow(this.show, kind);
		if (next === this.show) {
			this.note = "表示は 1 種類必要です";
			return this.tui.requestRender();
		}
		this.show = next;
		this.note = `表示: ${(Object.keys(SHOW_LABELS) as ShowKind[])
			.filter((k) => next[k])
			.map((k) => SHOW_LABELS[k])
			.join(" / ")}`;
		this.rebuild();
		this.tui.requestRender();
	}

	/** キー一覧を自前の overlay で重ねる。パネルは閉じないので下のコメントが消えない。 */
	private toggleHelp(): void {
		if (this.help) {
			this.help.hide();
			this.help = undefined;
			return this.tui.requestRender();
		}
		this.help = this.tui.showOverlay(new HelpOverlay(this.theme, helpWidth(this.tui.terminal.columns), () => this.toggleHelp()), {
			anchor: "center",
			width: helpWidth(this.tui.terminal.columns),
			maxHeight: helpLines(this.theme, helpWidth(this.tui.terminal.columns)).length,
			margin: 1,
		});
	}

	private titleLine(): string {
		const title = this.phase === "loading" ? "要約中…" : this.phase === "error" ? "要約に失敗" : this.title;
		return this.theme.fg("accent", this.theme.bold(`${title}  [${MODE_LABELS[this.mode]}]`));
	}

	private hint(): string {
		if (this.mode === "handoff") return "a 採用、d 却下、e 編集、c コピー、s 会話、? キー一覧、Esc 閉じる";
		const moves = MODE_TRANSITIONS[this.mode]
			.map((m) => `${MODE_KEYS_FOR[m]} ${MODE_LABELS[m]}`)
			.join(" / ");
		return `j/k 選択、l/L 要約、i/I 作業、? キー一覧、Esc 閉じる｜${moves}`;
	}

	/** overlay は最下部 1 行（pi のフッタ）を残し、枠 4 行を引いた残りを本文に使う。 */
	private visibleRows(): number {
		return this.overlay ? Math.max(3, this.tui.terminal.rows - 5) : panelRows(this.tui.terminal.rows);
	}

	invalidate(): void {
		this.renderedWidth = -1;
		this.renderedSelected = -2;
	}

	dispose(): void {
		this.closed = true;
		this.unsubStore?.();
		this.unsubStore = undefined;
	}

	/** 選択中のコメント。要約カードの上では undefined。 */
	private selectedCard(): Card | undefined {
		const id = this.content?.idAt(this.selected);
		return id ? this.cards.find((card) => card.entryId === id) : undefined;
	}

	/** 選択コメントの次に来るコメントの entry id。 */
	private nextId(card: Card): string | undefined {
		const index = this.cards.indexOf(card);
		return this.cards.slice(index + 1).find((c) => c.entryId)?.entryId;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) {
			this.closed = true;
			return this.done();
		}
		// 全画面の切替は要約中でも効かせる。
		if (matchesKey(data, "z")) {
			this.closed = true;
			return this.done({ kind: "toggle" });
		}
		if (data === "?") return this.toggleHelp();
		for (const [key, kind] of Object.entries(SHOW_KEYS)) {
			if (matchesKey(data, key)) return this.toggle(kind);
		}
		if (this.working) return;
		for (const [key, target] of Object.entries(MODE_KEYS)) {
			if (!matchesKey(data, key)) continue;
			if (this.phase === "loading") return;
			if (!canMove(this.mode, target)) {
				this.note = "この画面からは移動できません";
				return this.tui.requestRender();
			}
			return void this.load(target);
		}
		if (this.mode === "handoff") {
			if (matchesKey(data, "a") || matchesKey(data, "d")) return void this.actOnRetained(matchesKey(data, "a"));
			if (matchesKey(data, "e")) return void this.editHandoff();
			if (matchesKey(data, "c")) return void this.copyHandoff();
		}
		if (matchesKey(data, "l") || matchesKey(data, "shift+l") || matchesKey(data, "i") || matchesKey(data, "shift+i")) {
			if (this.phase !== "ready") return;
			if (this.mode !== "rallies") {
				this.note = "s で会話に戻る";
				return this.tui.requestRender();
			}
			const all = matchesKey(data, "shift+l") || matchesKey(data, "shift+i");
			const work = matchesKey(data, "i") || matchesKey(data, "shift+i");
			return void (work ? this.summarizeWork(all) : this.summarizeComment(all));
		}
		if (matchesKey(data, "t")) {
			if (this.mode !== "rallies") {
				this.note = "会話で分岐できます";
				return this.tui.requestRender();
			}
			const id = this.content?.idAt(this.selected);
			if (!id) {
				this.note = "分岐不可";
				return this.tui.requestRender();
			}
			return this.done(id);
		}
		if (matchesKey(data, "c")) {
			const text = this.content?.textAt(this.selected);
			if (!text) return;
			this.note = "コピー";
			copyToClipboard(text).catch(() => {
				this.note = "コピー失敗";
				this.tui.requestRender();
			});
			return this.tui.requestRender();
		}
		const rows = this.visibleRows();
		if (matchesKey(data, "down") || matchesKey(data, "j") || matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.ranges.length === 0) return;
			const delta = matchesKey(data, "down") || matchesKey(data, "j") ? 1 : -1;
			const next = Math.max(0, Math.min(this.ranges.length - 1, this.selected + delta));
			// 選択が変わらない（末尾でさらに下、など）ときは会話の中をずらす。
			this.offset =
				next === this.selected
					? scrollWithin(this.ranges[next], this.offset, rows, delta)
					: revealOffset(this.ranges[next], this.offset, rows, delta);
			this.selected = next;
			this.note = "";
			return this.tui.requestRender();
		}
		const forward = matchesKey(data, "pagedown") || matchesKey(data, "ctrl+f");
		const back = matchesKey(data, "pageup") || matchesKey(data, "ctrl+b");
		if (!forward && !back) return;
		const target = pageTarget(this.ranges, this.offset, rows, forward ? 1 : -1);
		if (target < 0) return;
		this.selected = target;
		this.note = "";
		this.offset = this.ranges[target].start;
		this.tui.requestRender();
	}

	/** 選択コメント（all なら未要約の全コメント）の要約をバックグラウンドで開始する。 */
	private summarizeComment(all: boolean): void {
		const { summaries } = this.sources.store;
		const targets = all
			? this.cards.filter((card) => card.entryId && !summaries.has(card.entryId))
			: [this.selectedCard()].filter((card): card is Card => Boolean(card?.entryId));
		if (targets.length === 0) {
			this.note = all ? "未要約のコメントはありません" : "コメントを選択してください";
			return this.tui.requestRender();
		}
		if (!all && summaries.has(targets[0].entryId as string)) {
			this.note = "要約済み（L で未要約をまとめて）";
			return this.tui.requestRender();
		}
		this.note = all ? `未要約 ${targets.length} 件をバックグラウンドで要約` : "バックグラウンドで要約中…";
		this.tui.requestRender();
		this.sources.summarizeComments(targets.map((card) => ({ entryId: card.entryId as string, text: card.text })));
	}

	/** 選択コメントの直後の作業（all なら未要約の全箇所）の要約をバックグラウンドで開始する。 */
	private summarizeWork(all: boolean): void {
		const { works } = this.sources.store;
		const targets = all
			? this.cards.filter((card) => card.entryId && !works.has(card.entryId))
			: [this.selectedCard()].filter((card): card is Card => Boolean(card?.entryId));
		if (targets.length === 0) {
			this.note = all ? "未要約の作業はありません" : "コメントを選択してください";
			return this.tui.requestRender();
		}
		if (!all && works.has(targets[0].entryId as string)) {
			this.note = "作業は要約済み（I で未要約をまとめて）";
			return this.tui.requestRender();
		}
		this.note = all ? `未要約 ${targets.length} 件の作業をバックグラウンドで要約` : "作業をバックグラウンドで要約中…";
		this.tui.requestRender();
		this.sources.summarizeWorks(
			targets.map((card) => ({ entryId: card.entryId as string, startId: card.entryId as string, endId: this.nextId(card) })),
		);
	}

	private coverageHeader(width: number): string[] {
		if (!this.handoff) return [];
		const marks: Record<string, [string, string]> = {
			adopted: ["accent", "■"],
			deferred: ["accent", "◐"],
			dropped: ["dim", "□"],
		};
		const cells: string[] = [];
		for (let i = 1; i <= this.handoff.rallyCount; i++) {
			const [color, ch] = marks[this.handoff.coverage.get(i) ?? "dropped"];
			cells.push(this.theme.fg(color, ch));
		}
		const bar = truncateToWidth(` ${cells.join("")}`, width);
		const legend = truncateToWidth(
			` ${this.theme.fg("accent", "■採用済み")} ${this.theme.fg("accent", "◐保留")} ${this.theme.fg("dim", "□未採用")}`,
			width,
		);
		return [bar, legend];
	}

	/** 選択中の保留項目の index（保留項目でなければ -1）。 */
	private retainedIndex(card: Card | undefined): number {
		if (!card?.entryId?.startsWith("retained:")) return -1;
		return Number(card.entryId.slice("retained:".length));
	}

	private actOnRetained(adopt: boolean): void {
		const index = this.retainedIndex(this.selectedCard());
		if (index < 0) {
			this.note = "保留項目を選択してください";
			return this.tui.requestRender();
		}
		void (adopt ? this.adoptRetained(index) : this.dismissRetained(index));
	}

	private applyHandoff(handoff: Handoff, selected: number): void {
		const view = handoffView(handoff);
		this.cache.set("handoff", view);
		this.apply(view);
		this.selected = Math.min(selected, this.cards.length - 1);
	}

	private async adoptRetained(index: number): Promise<void> {
		const handoff = this.handoff;
		if (!handoff) return;
		const item = handoff.deferred[index];
		if (!item) return;
		const selected = this.selected;
		this.working = true;
		try {
			const { section, bullet } = await this.sources.adopt(item);
			if (this.closed) return;
			const bulletWithSource = `${bullet}（出典: ラリー${item.sources.join(",")}）`;
			const text = insertBullet(handoff.text, section, bulletWithSource);
			const deferred = handoff.deferred.filter((_, i) => i !== index);
			this.sources.store.handoff = text;
			this.sources.store.deferred = deferred;
			this.sources.save({ entryId: HANDOFF_ID, handoff: text, deferred });
			this.applyHandoff(
				{ text, deferred, coverage: computeCoverage(handoff.rallyCount, text, deferred), rallyCount: handoff.rallyCount },
				selected,
			);
			this.note = "保留項目を採用しました";
		} catch (error) {
			this.note = `採用に失敗: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.working = false;
		}
		this.tui.requestRender();
	}

	private dismissRetained(index: number): void {
		const handoff = this.handoff;
		if (!handoff) return;
		const deferred = handoff.deferred.filter((_, i) => i !== index);
		this.sources.store.deferred = deferred;
		this.sources.save({ entryId: HANDOFF_ID, handoff: handoff.text, deferred });
		this.applyHandoff(
			{ ...handoff, deferred, coverage: computeCoverage(handoff.rallyCount, handoff.text, deferred) },
			this.selected,
		);
		this.note = "保留項目を却下しました";
		this.tui.requestRender();
	}

	private async editHandoff(): Promise<void> {
		const handoff = this.handoff;
		if (!handoff) return;
		this.working = true;
		try {
			const text = await this.sources.edit(handoff.text);
			if (this.closed) return;
			if (text === undefined || text === handoff.text) {
				this.note = "編集を中止しました";
				return;
			}
			this.sources.store.handoff = text;
			this.sources.save({ entryId: HANDOFF_ID, handoff: text, deferred: handoff.deferred });
			this.applyHandoff(
				{ ...handoff, text, coverage: computeCoverage(handoff.rallyCount, text, handoff.deferred) },
				this.selected,
			);
			this.note = "引き継ぎ書を編集しました";
		} catch (error) {
			this.note = `編集に失敗: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.working = false;
		}
		this.tui.requestRender();
	}

	private copyHandoff(): void {
		if (!this.handoff) return;
		copyToClipboard(buildHandoffText(stripSources(this.handoff.text))).then(
			() => {
				this.note = "引き継ぎプロンプトをコピーしました";
				this.tui.requestRender();
			},
			() => {
				this.note = "コピーに失敗しました";
				this.tui.requestRender();
			},
		);
	}
}

const cardsText = (cards: Card[]): string => cards.map((card) => `## ${card.label}\n\n${card.text}`).join("\n\n");

/** 各 turn が属するラリー番号（1 始まり）。 */
const turnRallyIndex = (turns: Turn[]): number[] => {
	const indices: number[] = [];
	let rally = 0;
	for (const turn of turns) {
		if (turn.role === "user" || rally === 0) rally++;
		indices.push(rally);
	}
	return indices;
};

const turnCards = (turns: Turn[], coverage?: Handoff["coverage"]): Card[] => {
	const indices = turnRallyIndex(turns);
	return turns.map((turn, i) => ({
		role: turn.role,
		label: turn.role === "user" ? "ユーザー" : "AI",
		text: turn.text,
		entryId: turn.id,
		coverage: coverage?.get(indices[i]),
	}));
};

const neutralCards = (label: string, text: string): Card[] => [{ role: "neutral", label, text }];

const handoffView = (handoff: Handoff): View => ({
	title: `引き継ぎ ${handoff.rallyCount} ラリー`,
	handoff,
	cards: [
		{ role: "neutral", label: "引き継ぎ書", text: handoff.text, entryId: "handoff" },
		...handoff.deferred.map((item, index) => ({
			role: "neutral" as const,
			label: `保留 ${index + 1}`,
			text: `**${item.summary}**\n理由: ${item.reason}\n出典: ラリー${item.sources.join(",")}`,
			entryId: `retained:${index}`,
		})),
	],
});

const runPrompt = async (prompt: { systemPrompt: string; user: string }, ctx: ExtensionContext): Promise<string> => {
	const model = ctx.model;
	if (!model) throw new Error("モデルが選択されていません");
	ctx.ui.setStatus("pi-summary", "要約中…");
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: prompt.systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: prompt.user }], timestamp: Date.now() }],
			},
			{ cacheRetention: "none", sessionId: crypto.randomUUID() },
		);
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
		if (!text) throw new Error("要約が空でした");
		return text;
	} finally {
		ctx.ui.setStatus("pi-summary", undefined);
	}
};

const buildSources = (
	ctx: ExtensionCommandContext,
	save: (data: Saved) => void,
	background: {
		refreshMin: (ctx: ExtensionContext) => Promise<void>;
		summarizeComments: (ctx: ExtensionContext, targets: { entryId: string; text: string }[]) => Promise<void>;
		summarizeWorks: (ctx: ExtensionContext, targets: { entryId: string; startId: string; endId?: string }[]) => Promise<void>;
		onStoreUpdate: (callback: () => void) => () => void;
	},
): Sources => {
	const branch = ctx.sessionManager.getBranch();
	const turns = extractTurns(branch);
	const rallyCount = groupRallies(turns).length;
	const store = readStore(branch);
	const reloadStore = (): void => {
		const fresh = readStore(branch);
		store.summaries = fresh.summaries;
		store.works = fresh.works;
		store.handoff = fresh.handoff;
		store.deferred = fresh.deferred;
		store.handoffRallies = fresh.handoffRallies;
		store.min = fresh.min;
		store.minRallies = fresh.minRallies;
	};
	return {
		store,
		save,
		reloadStore,
		onStoreUpdate: background.onStoreUpdate,
		summarizeComments: (targets) => void background.summarizeComments(ctx, targets),
		summarizeWorks: (targets) => void background.summarizeWorks(ctx, targets),
		async view(mode: Mode): Promise<View> {
			if (mode === "rallies") {
				const coverage = store.handoff ? computeCoverage(rallyCount, store.handoff, store.deferred) : undefined;
				return { title: `会話ラリー ${rallyCount} 件`, cards: turnCards(turns, coverage) };
			}
			if (mode === "min") {
				if (store.min) return { title: "全体サマリー", cards: neutralCards("要約", store.min) };
				void background.refreshMin(ctx);
				return { title: "全体サマリー", cards: neutralCards("要約", "要約中…（完了すると自動更新されます）") };
			}
			if (store.handoff) {
				return handoffView({
					text: store.handoff,
					deferred: store.deferred,
					coverage: computeCoverage(rallyCount, store.handoff, store.deferred),
					rallyCount,
				});
			}
			const raw = await runPrompt(buildHandoffPrompt(turns), ctx);
			const handoff = parseHandoff(raw, rallyCount);
			store.handoff = handoff.text;
			store.deferred = handoff.deferred;
			store.handoffRallies = rallyCount;
			save({ entryId: HANDOFF_ID, handoff: handoff.text, deferred: handoff.deferred, handoffRallies: rallyCount });
			return handoffView(handoff);
		},
		adopt: async (item: DeferredItem) => parseAdopt(await runPrompt(buildAdoptPrompt(item, turns), ctx), item.summary),
		edit: (text: string) => ctx.ui.editor("引き継ぎ書を編集", text),
	};
};

/** `?` の一覧。パネルの上に重ねるので、下のコメントは消えない。 */
class HelpOverlay implements Component {
	private theme: Theme;
	private readonly width: number;
	private readonly close: () => void;

	constructor(theme: Theme, width: number, close: () => void) {
		this.theme = theme;
		this.width = width;
		this.close = close;
	}

	render(): string[] {
		return helpLines(this.theme, this.width);
	}

	invalidate(): void {}

	handleInput(): void {
		this.close();
	}
}

/** `t` で選ばれた会話から分岐する（/tree で「before」を選ぶのと同じ）。 */
const branchTo = async (entryId: string | undefined, ctx: ExtensionCommandContext) => {
	if (!entryId) return;
	try {
		await ctx.navigateTree(entryId);
	} catch (error) {
		ctx.ui.notify(`分岐に失敗: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
};

export default function (pi: ExtensionAPI) {
	let auto: AutoConfig = { ...DEFAULT_AUTO };
	const storeListeners = new Set<() => void>();
	const pendingSummaries = new Set<string>();
	const pendingWorks = new Set<string>();
	let minRunning = false;
	let handoffRunning = false;

	const notifyStore = (): void => {
		for (const callback of [...storeListeners]) callback();
	};

	const onStoreUpdate = (callback: () => void): (() => void) => {
		storeListeners.add(callback);
		return () => {
			storeListeners.delete(callback);
		};
	};

	const refreshMin = async (ctx: ExtensionContext): Promise<void> => {
		if (minRunning) return;
		minRunning = true;
		try {
			const branch = ctx.sessionManager.getBranch();
			const turns = extractTurns(branch);
			const rallyCount = groupRallies(turns).length;
			if (rallyCount === 0) return;
			const text = await runPrompt(buildMinPrompt(turns), ctx);
			pi.appendEntry(STORE, { entryId: MIN_ID, min: text, minRallies: rallyCount });
			notifyStore();
			ctx.ui.notify("全体要約を更新しました", "info");
		} catch (error) {
			ctx.ui.notify(`全体要約に失敗: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			minRunning = false;
		}
	};

	const refreshHandoff = async (ctx: ExtensionContext): Promise<void> => {
		if (handoffRunning) return;
		handoffRunning = true;
		try {
			const branch = ctx.sessionManager.getBranch();
			const turns = extractTurns(branch);
			const rallyCount = groupRallies(turns).length;
			if (rallyCount === 0) return;
			const store = readStore(branch);
			const processed = store.handoffRallies ?? 0;
			const raw = processed > 0 && store.handoff
				? await runPrompt(buildHandoffUpdatePrompt({ text: store.handoff, deferred: store.deferred }, processed, turns), ctx)
				: await runPrompt(buildHandoffPrompt(turns), ctx);
			const handoff = parseHandoff(raw, rallyCount);
			pi.appendEntry(STORE, { entryId: HANDOFF_ID, handoff: handoff.text, deferred: handoff.deferred, handoffRallies: rallyCount });
			notifyStore();
			ctx.ui.notify("引き継ぎ書を更新しました", "info");
		} catch (error) {
			ctx.ui.notify(`引き継ぎ書の更新に失敗: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			handoffRunning = false;
		}
	};

	const summarizeComments = async (ctx: ExtensionContext, targets: { entryId: string; text: string }[]): Promise<void> => {
		let done = 0;
		let failed = 0;
		for (const target of targets) {
			if (pendingSummaries.has(target.entryId)) continue;
			pendingSummaries.add(target.entryId);
			try {
				const text = await runPrompt(buildCommentPrompt(target.text), ctx);
				pi.appendEntry(STORE, { entryId: target.entryId, summary: text });
				notifyStore();
				done++;
			} catch {
				failed++;
			} finally {
				pendingSummaries.delete(target.entryId);
			}
		}
		if (failed && !done) ctx.ui.notify("コメント要約に失敗", "error");
		else if (done) ctx.ui.notify(failed ? `${done} 件を要約（${failed} 件失敗）` : `${done} 件を要約`, failed ? "warning" : "info");
	};

	const summarizeWorks = async (ctx: ExtensionContext, targets: { entryId: string; startId: string; endId?: string }[]): Promise<void> => {
		let done = 0;
		let failed = 0;
		let empty = 0;
		for (const target of targets) {
			if (pendingWorks.has(target.entryId)) continue;
			pendingWorks.add(target.entryId);
			try {
				const items = extractWorkBetween(ctx.sessionManager.getBranch(), target.startId, target.endId);
				if (items.length === 0) {
					empty++;
					continue;
				}
				const text = await runPrompt(buildWorkPrompt(items), ctx);
				pi.appendEntry(STORE, { entryId: target.entryId, work: text });
				notifyStore();
				done++;
			} catch {
				failed++;
			} finally {
				pendingWorks.delete(target.entryId);
			}
		}
		if (failed && !done) ctx.ui.notify("作業要約に失敗", "error");
		else if (done) ctx.ui.notify(failed ? `${done} 件の作業を要約（${failed} 件失敗）` : `${done} 件の作業を要約`, failed ? "warning" : "info");
		else if (empty) ctx.ui.notify("直後のツール実行がありません", "info");
	};

	pi.registerCommand("summary-comments", {
		description: "未要約の全コメントをバックグラウンドで要約する",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const store = readStore(branch);
			const targets = extractTurns(branch)
				.filter((turn) => turn.id && !store.summaries.has(turn.id))
				.map((turn) => ({ entryId: turn.id as string, text: turn.text }));
			if (targets.length === 0) {
				ctx.ui.notify("未要約のコメントはありません", "info");
				return;
			}
			ctx.ui.notify(`${targets.length} 件のコメント要約を開始`, "info");
			void summarizeComments(ctx, targets);
		},
	});

	pi.registerCommand("summary-works", {
		description: "未要約の全作業をバックグラウンドで要約する",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const store = readStore(branch);
			const turns = extractTurns(branch);
			const targets: { entryId: string; startId: string; endId?: string }[] = [];
			for (let i = 0; i < turns.length; i++) {
				const turn = turns[i];
				if (!turn.id || store.works.has(turn.id)) continue;
				const endId = turns.slice(i + 1).find((next) => next.id)?.id;
				targets.push({ entryId: turn.id, startId: turn.id, endId });
			}
			if (targets.length === 0) {
				ctx.ui.notify("未要約の作業はありません", "info");
				return;
			}
			ctx.ui.notify(`${targets.length} 件の作業要約を開始`, "info");
			void summarizeWorks(ctx, targets);
		},
	});

	pi.registerCommand("summary-overall", {
		description: "セッション全体をバックグラウンドで要約する（/summary の m 相当）",
		handler: async (_args, ctx) => {
			if (extractTurns(ctx.sessionManager.getBranch()).length === 0) {
				ctx.ui.notify("会話ラリーがありません", "warning");
				return;
			}
			ctx.ui.notify("全体要約を開始", "info");
			void refreshMin(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		let raw = "";
		try {
			raw = readFileSync(join(ctx.cwd, ".pi", "pi-summary.json"), "utf8");
		} catch {
			// 設定ファイルが無ければ既定（無効）
		}
		auto = parseAutoConfig(raw);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const rallyCount = groupRallies(extractTurns(branch)).length;
		const store = readStore(branch);
		if (shouldRefreshMin(store, rallyCount, auto)) void refreshMin(ctx);
		if (shouldRefreshHandoff(store, rallyCount, auto)) void refreshHandoff(ctx);
	});

	pi.registerCommand("summary", {
		description: "会話の表示。l で選択コメント、i で直後の作業を要約（L / I で未要約をまとめて）",
		handler: async (_args, ctx) => {
			if (extractTurns(ctx.sessionManager.getBranch()).length === 0) {
				ctx.ui.notify("会話ラリーがありません", "warning");
				return;
			}
			const sources = buildSources(ctx, (data) => pi.appendEntry(STORE, data), { refreshMin, summarizeComments, summarizeWorks, onStoreUpdate });
			if (ctx.mode !== "tui") {
				process.stdout.write(`${cardsText((await sources.view("rallies")).cards)}\n`);
				return;
			}
			// 既定は overlay で全画面。`z` は同じパネルを下部パネルとして開き直す。
			let overlay = true;
			let panel: SummaryPanel | undefined;
			let tuiRef: Tui | undefined;
			for (;;) {
				const outcome = await ctx.ui.custom<Outcome>((tui, theme, _keybindings, done) => {
					tuiRef = tui as Tui;
					if (panel) {
						panel.attach(theme as Theme, tui as Tui, (value) => done(value), overlay);
						return panel;
					}
					panel = new SummaryPanel(sources, theme as Theme, tui as Tui, (value) => done(value), overlay);
					return panel;
				}, overlay ? { overlay: true, overlayOptions: () => ({ anchor: "top-left", width: "100%", maxHeight: Math.max(5, (tuiRef?.terminal.rows ?? 40) - 1), margin: 0 }) } : {});
				if (outcome && typeof outcome === "object" && outcome.kind === "toggle") {
					overlay = !overlay;
					continue;
				}
				// `t` で選んだ会話の entry id を返し、呼び出し側が /tree 相当の分岐を行う。
				await branchTo(outcome as string | undefined, ctx);
				break;
			}
		},
	});
}
