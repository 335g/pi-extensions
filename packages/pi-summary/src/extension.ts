import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, copyToClipboard } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import {
	MODE_KEYS,
	MODE_TRANSITIONS,
	type Mode,
	type Range,
	canMove,
	pageTarget,
	panelRows,
	revealOffset,
	sliceWindow,
} from "./panel.ts";
import { buildCommentPrompt, buildMinPrompt } from "./summarize.ts";
import { extractTurns, type Turn } from "./turns.ts";
import { buildWorkPrompt, extractWorkBetween } from "./work.ts";
import { type Card, type Content, cardsContent } from "./view.ts";

type Theme = { fg(key: string, text: string): string; bold(text: string): string; bg(key: string, text: string): string };
type Tui = { requestRender(): void; terminal: { rows: number } };
type View = { title: string; cards: Card[] };
type Outcome = string | { kind: "toggle" } | undefined;
type Sources = {
	view(mode: Mode): Promise<View>;
	comment(text: string): Promise<string>;
	/** 直後の作業の要約。ツール呼び出しが無ければ null。 */
	work(startId: string, endId?: string): Promise<string | null>;
};

const MODE_LABELS: Record<Mode, string> = { rallies: "会話", min: "全体要約" };
const MODE_KEYS_FOR: Record<Mode, string> = { rallies: "s", min: "m" };

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
	private readonly summaries = new Map<string, string>();
	private readonly works = new Map<string, string>();
	private mode: Mode;
	private title = "";
	private cards: Card[] = [];
	private content: Content | undefined;
	private bodyLines: string[] = [];
	private ranges: Range[] = [];
	private phase: "loading" | "ready" | "error" = "loading";
	private error = "";
	private note = "";
	private working = false;
	private closed = false;
	private showSummaries = true;
	private selected = 0;
	private offset = 0;
	private renderedWidth = -1;
	private renderedSelected = -2;

	constructor(sources: Sources, theme: Theme, tui: Tui, done: (value?: Outcome) => void, overlay: boolean) {
		this.sources = sources;
		this.theme = theme;
		this.tui = tui;
		this.done = done;
		this.overlay = overlay;
		this.border = new DynamicBorder((s: string) => theme.fg("accent", s));
		this.mode = "rallies";
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
		if (cached) {
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
		this.selected = 0;
		this.offset = 0;
		this.phase = "ready";
		this.rebuild();
	}

	/** 要約はカードの内側に持たせる。差し込みで選択位置がずれない。 */
	private decorate(cards: Card[]): Card[] {
		if (!this.showSummaries) return cards;
		return cards.map((card) => {
			if (!card.entryId) return card;
			const summary = this.summaries.get(card.entryId);
			const work = this.works.get(card.entryId);
			return summary || work ? { ...card, summary, work } : card;
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
		const rows = this.visibleRows();
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
			...filled,
			this.theme.fg("dim", ` ${name}${range}${this.hint()}`),
			this.border.render(width)[0] ?? "",
		];
	}

	private titleLine(): string {
		const title = this.phase === "loading" ? "要約中…" : this.phase === "error" ? "要約に失敗" : this.title;
		return this.theme.fg("accent", this.theme.bold(`${title}  [${MODE_LABELS[this.mode]}]`));
	}

	private hint(): string {
		const moves = MODE_TRANSITIONS[this.mode]
			.map((m) => `${MODE_KEYS_FOR[m]} ${MODE_LABELS[m]}`)
			.join(" / ");
		return `j/k 選択、l 要約、L 全要約、i 作業、I 全作業、c コピー、t 分岐、h 要約表示、z 表示切替、Ctrl-f/b ページ、Esc 閉じる｜${moves}`;
	}

	/** overlay は最下部 1 行（pi のフッタ）を残し、枠 4 行を引いた残りを本文に使う。 */
	private visibleRows(): number {
		return this.overlay ? Math.max(3, this.tui.terminal.rows - 5) : panelRows(this.tui.terminal.rows);
	}

	invalidate(): void {
		this.renderedWidth = -1;
		this.renderedSelected = -2;
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
		if (matchesKey(data, "h")) {
			this.showSummaries = !this.showSummaries;
			this.note = this.showSummaries ? "要約を表示" : "要約を隠す";
			this.rebuild();
			return this.tui.requestRender();
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
			this.selected = Math.max(0, Math.min(this.ranges.length - 1, this.selected + delta));
			this.note = "";
			this.offset = revealOffset(this.ranges[this.selected], this.offset, rows);
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

	/** 選択コメント（all なら未要約の全コメント）を箇条書きに要約して差し込む。 */
	private async summarizeComment(all: boolean): Promise<void> {
		const targets = all
			? this.cards.filter((card) => card.entryId && !this.summaries.has(card.entryId))
			: [this.selectedCard()].filter((card): card is Card => Boolean(card?.entryId));
		if (targets.length === 0) {
			this.note = all ? "未要約のコメントはありません" : "コメントを選択してください";
			return this.tui.requestRender();
		}
		if (!all && this.summaries.has(targets[0].entryId as string)) {
			this.note = "要約済み（L で未要約をまとめて）";
			return this.tui.requestRender();
		}
		const selectedId = this.content?.idAt(this.selected);
		this.working = true;
		try {
			for (const [index, card] of targets.entries()) {
				this.note = all ? `要約中 ${index + 1}/${targets.length}` : "要約中…";
				this.tui.requestRender();
				const text = await this.sources.comment(card.text);
				if (this.closed) return;
				this.summaries.set(card.entryId as string, text);
			}
			this.rebuild();
			this.restoreSelection(selectedId);
			this.note = `${targets.length} 件を要約`;
		} catch (error) {
			this.note = `要約に失敗: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.working = false;
		}
		this.tui.requestRender();
	}

	/** 選択コメントの直後の作業（all なら未要約の全箇所）を要約して差し込む。 */
	private async summarizeWork(all: boolean): Promise<void> {
		const targets = all
			? this.cards.filter((card) => card.entryId && !this.works.has(card.entryId))
			: [this.selectedCard()].filter((card): card is Card => Boolean(card?.entryId));
		if (targets.length === 0) {
			this.note = all ? "未要約の作業はありません" : "コメントを選択してください";
			return this.tui.requestRender();
		}
		if (!all && this.works.has(targets[0].entryId as string)) {
			this.note = "作業は要約済み（I で未要約をまとめて）";
			return this.tui.requestRender();
		}
		const selectedId = this.content?.idAt(this.selected);
		this.working = true;
		let done = 0;
		try {
			for (const [index, card] of targets.entries()) {
				this.note = all ? `作業を要約中 ${index + 1}/${targets.length}` : "作業を要約中…";
				this.tui.requestRender();
				const text = await this.sources.work(card.entryId as string, this.nextId(card));
				if (this.closed) return;
				if (text) {
					this.works.set(card.entryId as string, text);
					done++;
				}
			}
			this.rebuild();
			this.restoreSelection(selectedId);
			this.note = done ? `${done} 件の作業を要約` : "直後のツール実行がありません";
		} catch (error) {
			this.note = `作業要約に失敗: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.working = false;
		}
		this.tui.requestRender();
	}

	/** 要約で行が増えても、選択していたコメントに留める。 */
	private restoreSelection(entryId: string | undefined): void {
		const index = entryId ? this.cards.findIndex((card) => card.entryId === entryId) : -1;
		if (index !== -1) this.selected = index;
	}
}

const cardsText = (cards: Card[]): string => cards.map((card) => `## ${card.label}\n\n${card.text}`).join("\n\n");

const turnCards = (turns: Turn[]): Card[] =>
	turns.map((turn) => ({ role: turn.role, label: turn.role === "user" ? "ユーザー" : "AI", text: turn.text, entryId: turn.id }));

const neutralCards = (label: string, text: string): Card[] => [{ role: "neutral", label, text }];

const runPrompt = async (prompt: { systemPrompt: string; user: string }, ctx: ExtensionCommandContext): Promise<string> => {
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

const buildSources = (ctx: ExtensionCommandContext): Sources => {
	const branch = ctx.sessionManager.getBranch();
	const turns = extractTurns(branch);
	return {
		async view(mode: Mode): Promise<View> {
			if (mode === "rallies") return { title: `会話ラリー ${turns.length} 件`, cards: turnCards(turns) };
			return { title: "全体サマリー", cards: neutralCards("要約", await runPrompt(buildMinPrompt(turns), ctx)) };
		},
		comment: (text: string) => runPrompt(buildCommentPrompt(text), ctx),
		async work(startId: string, endId?: string): Promise<string | null> {
			const items = extractWorkBetween(branch, startId, endId);
			if (items.length === 0) return null;
			return runPrompt(buildWorkPrompt(items), ctx);
		},
	};
};

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
	pi.registerCommand("summary", {
		description: "会話の表示。l で選択コメント、i で直後の作業を要約（L / I で未要約をまとめて）",
		handler: async (_args, ctx) => {
			if (extractTurns(ctx.sessionManager.getBranch()).length === 0) {
				ctx.ui.notify("会話ラリーがありません", "warning");
				return;
			}
			const sources = buildSources(ctx);
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
