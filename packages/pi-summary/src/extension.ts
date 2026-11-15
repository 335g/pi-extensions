import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, copyToClipboard } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { type SummaryLevel, buildPrompt, groupRallies, parseLowSummary } from "./summarize.ts";
import { type Range, pageTarget, panelRows, revealOffset, sliceWindow } from "./panel.ts";
import { extractTurns, type Turn } from "./turns.ts";
import { buildWorkPrompt, extractLastWork } from "./work.ts";
import { type Card, type Content, cardsContent } from "./view.ts";

type Theme = { fg(key: string, text: string): string; bold(text: string): string; bg(key: string, text: string): string };
type Tui = { requestRender(): void; terminal: { rows: number } };

/**
 * エディタ領域に差し込む下部パネル（overlay にしない）。
 * 高さは render が返す行数で決まるので、本文は自分で切り出して上限を守る。
 */
class SummaryPanel {
	private readonly title: string;
	private readonly content: Content;
	private readonly border: DynamicBorder;
	private readonly tui: Tui;
	private readonly theme: Theme;
	private readonly done: (value?: string) => void;
	private lines: string[] = [];
	private ranges: Range[] = [];
	private renderedWidth = -1;
	private renderedSelected = -2;
	private selected = 0;
	private offset = 0;
	private note = "";

	constructor(title: string, content: Content, theme: Theme, tui: Tui, done: (value?: string) => void) {
		this.title = theme.fg("accent", theme.bold(title));
		this.content = content;
		this.border = new DynamicBorder((s: string) => theme.fg("accent", s));
		this.theme = theme;
		this.tui = tui;
		this.done = done;
	}

	render(width: number): string[] {
		if (width !== this.renderedWidth || this.selected !== this.renderedSelected) {
			const rendered = this.content.render(width, this.selected);
			this.lines = rendered.lines;
			this.ranges = rendered.ranges;
			this.renderedWidth = width;
			this.renderedSelected = this.selected;
		}
		const win = sliceWindow(this.lines, this.offset, panelRows(this.tui.terminal.rows));
		this.offset = win.offset;
		const bar = this.border.render(width)[0] ?? "";
		const name = this.selected >= 0 ? `${this.note || "選択"} ${this.selected + 1}/${this.ranges.length}  ` : "";
		const range = this.lines.length ? `${win.offset + 1}-${win.offset + win.lines.length}/${this.lines.length}  ` : "";
		return [
			bar,
			` ${this.title}`,
			...win.lines,
			this.theme.fg("dim", ` ${name}${range}j/k 選択、c コピー、t 分岐、Ctrl-f/b ページ、Enter/Esc/q 閉じる`),
			bar,
		];
	}

	invalidate(): void {
		this.renderedWidth = -1;
		this.renderedSelected = -2;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) return this.done();
		if (matchesKey(data, "t")) {
			const id = this.content.idAt(this.selected);
			if (!id) {
				this.note = "分岐不可";
				return this.tui.requestRender();
			}
			return this.done(id);
		}
		if (matchesKey(data, "c")) {
			const text = this.content.textAt(this.selected);
			if (!text) return;
			this.note = "コピー";
			copyToClipboard(text).catch(() => {
				this.note = "コピー失敗";
				this.tui.requestRender();
			});
			return this.tui.requestRender();
		}
		const rows = panelRows(this.tui.terminal.rows);
		if (matchesKey(data, "down") || matchesKey(data, "j") || matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.ranges.length === 0) return;
			const delta = matchesKey(data, "down") || matchesKey(data, "j") ? 1 : -1;
			// 未選択からは 1 押し目で先頭を選ぶ。
			this.selected = this.selected < 0 ? 0 : Math.max(0, Math.min(this.ranges.length - 1, this.selected + delta));
			this.note = "";
			this.offset = revealOffset(this.ranges[this.selected], this.offset, rows);
			return this.tui.requestRender();
		}
		const forward = matchesKey(data, "pagedown") || matchesKey(data, "ctrl+f");
		const back = matchesKey(data, "pageup") || matchesKey(data, "ctrl+b");
		if (!forward && !back) return;
		const target = pageTarget(this.ranges, this.offset, rows, forward ? 1 : -1);
		if (target < 0) return;
		// ページ送り先の会話を選び、その先頭を画面の先頭に置く。
		this.selected = target;
		this.note = "";
		this.offset = this.ranges[target].start;
		this.tui.requestRender();
	}
}

const cardsText = (cards: Card[]): string => cards.map((card) => `## ${card.label}\n\n${card.text}`).join("\n\n");

const present = async (title: string, cards: Card[], ctx: ExtensionCommandContext) => {
	if (ctx.mode !== "tui") {
		process.stdout.write(`${cardsText(cards)}\n`);
		return;
	}
	// 非 overlay: チャットの下、エディタ領域に出す（/model の選択画面と同じ）。
	// `t` で選んだ会話の entry id を返し、呼び出し側が /tree 相当の分岐を行う。
	return ctx.ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) =>
			new SummaryPanel(title, cardsContent(cards, theme), theme as Theme, tui as Tui, (value) => done(value)),
		{},
	);
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

const turnCards = (turns: Turn[]): Card[] =>
	turns.map((turn) => ({ role: turn.role, label: turn.role === "user" ? "ユーザー" : "AI", text: turn.text, entryId: turn.id }));

const neutralCards = (label: string, text: string): Card[] => [{ role: "neutral", label, text }];

/** 要約出力をユーザー/AI の吹き出しに割る。読めなければ 1 枚の枠にまとめる。 */
const lowCards = (text: string): Card[] => {
	const lines = parseLowSummary(text);
	if (lines.length === 0) return neutralCards("要約", text);
	return lines.map((line) => ({
		role: line.role,
		label: line.topic ? `${line.role === "user" ? "ユーザー" : "AI"} · ${line.topic}` : line.role === "user" ? "ユーザー" : "AI",
		text: line.text,
	}));
};

const complete = async (
	prompt: { systemPrompt: string; user: string },
	title: string,
	ctx: ExtensionCommandContext,
	toCards: (text: string) => Card[],
) => {
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("モデルが選択されていません", "error");
		return;
	}
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
		if (!text) {
			ctx.ui.notify("要約が空でした", "warning");
			return;
		}
		await present(title, toCards(text), ctx);
	} catch (error) {
		ctx.ui.notify(`要約に失敗: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		ctx.ui.setStatus("pi-summary", undefined);
	}
};

const summarize = (level: SummaryLevel, turns: Turn[], ctx: ExtensionCommandContext) =>
	complete(
		buildPrompt(level, turns),
		level === "low" ? "会話ラリー（要約）" : "全体サマリー",
		ctx,
		level === "low" ? lowCards : (text) => neutralCards("要約", text),
	);

export default function (pi: ExtensionAPI) {
	pi.registerCommand("summary", {
		description: "このセッションのユーザー/AI の会話ラリーをそのまま表示",
		handler: async (_args, ctx) => {
			const turns = extractTurns(ctx.sessionManager.getBranch());
			if (turns.length === 0) {
				ctx.ui.notify("会話ラリーがありません", "warning");
				return;
			}
			await branchTo(await present(`会話ラリー ${turns.length} 件`, turnCards(turns), ctx), ctx);
		},
	});

	pi.registerCommand("summary-1", {
		description: "直近の 1 ラリー（ユーザーの発話とそれへの AI の応答）だけを表示",
		handler: async (_args, ctx) => {
			const last = groupRallies(extractTurns(ctx.sessionManager.getBranch())).at(-1);
			if (!last) {
				ctx.ui.notify("会話ラリーがありません", "warning");
				return;
			}
			const turns: Turn[] = [
				...last.user.map((text) => ({ role: "user" as const, text })),
				...last.assistant.map((text) => ({ role: "assistant" as const, text })),
			];
			await branchTo(await present("直近の 1 ラリー", turnCards(turns), ctx), ctx);
		},
	});

	pi.registerCommand("summary-low", {
		description: "各会話ラリーを AI で 2〜3 行に縮めて表示",
		handler: async (_args, ctx) => {
			const turns = extractTurns(ctx.sessionManager.getBranch());
			if (turns.length === 0) {
				ctx.ui.notify("会話ラリーがありません", "warning");
				return;
			}
			await summarize("low", turns, ctx);
		},
	});

	pi.registerCommand("summary-internal", {
		description: "直近のリクエストで AI が実行した作業を要約して表示",
		handler: async (_args, ctx) => {
			const items = extractLastWork(ctx.sessionManager.getBranch());
			if (items.length === 0) {
				ctx.ui.notify("直近のツール実行がありません", "warning");
				return;
			}
			await complete(buildWorkPrompt(items), `AI の作業（${items.length} ツール呼び出し）`, ctx, (text) =>
				neutralCards("作業サマリー", text),
			);
		},
	});

	pi.registerCommand("summary-min", {
		description: "セッション全体を AI で 10〜20 行に要約して表示",
		handler: async (_args, ctx) => {
			const turns = extractTurns(ctx.sessionManager.getBranch());
			if (turns.length === 0) {
				ctx.ui.notify("会話ラリーがありません", "warning");
				return;
			}
			await summarize("min", turns, ctx);
		},
	});
}
