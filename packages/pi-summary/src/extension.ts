import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { type SummaryLevel, buildPrompt, groupRallies } from "./summarize.ts";
import { panelRows, sliceWindow } from "./panel.ts";
import { extractTurns, formatTurns } from "./turns.ts";
import { buildWorkPrompt, extractLastWork } from "./work.ts";

type Theme = { fg(key: string, text: string): string; bold(text: string): string; bg(key: string, text: string): string };
type Tui = { requestRender(): void; terminal: { rows: number } };

/**
 * エディタ領域に差し込む下部パネル（overlay にしない）。
 * 高さは render が返す行数で決まるので、本文は自分で切り出して上限を守る。
 */
class SummaryPanel {
	private readonly title: string;
	private readonly body: Markdown;
	private readonly border: DynamicBorder;
	private readonly tui: Tui;
	private readonly theme: Theme;
	private readonly done: () => void;
	private lines: string[] = [];
	private renderedWidth = -1;
	private offset = 0;

	constructor(title: string, body: string, theme: Theme, tui: Tui, done: () => void) {
		this.title = theme.fg("accent", theme.bold(title));
		this.body = new Markdown(body, 1, 1, getMarkdownTheme());
		this.border = new DynamicBorder((s: string) => theme.fg("accent", s));
		this.theme = theme;
		this.tui = tui;
		this.done = done;
	}

	render(width: number): string[] {
		if (width !== this.renderedWidth) {
			this.lines = this.body.render(width);
			this.renderedWidth = width;
		}
		const win = sliceWindow(this.lines, this.offset, panelRows(this.tui.terminal.rows));
		this.offset = win.offset;
		const bar = this.border.render(width)[0] ?? "";
		const range = this.lines.length ? `${win.offset + 1}-${win.offset + win.lines.length}/${this.lines.length}` : "";
		const rows = [
			bar,
			` ${this.title}`,
			...win.lines,
			this.theme.fg("dim", ` ${range}  j/k・↑/↓・PgUp/PgDn でスクロール、Enter/Esc/q で閉じる`),
			bar,
		];
		// チャットと地続きに見えないよう、行全体を背景色で塗る。
		return rows.map((row) => this.theme.bg("customMessageBg", row + " ".repeat(Math.max(0, width - visibleWidth(row)))));
	}

	invalidate(): void {
		this.renderedWidth = -1;
		this.body.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) return this.done();
		const page = Math.max(1, panelRows(this.tui.terminal.rows) - 1);
		const step = matchesKey(data, "pageup")
			? -page
			: matchesKey(data, "pagedown")
				? page
				: matchesKey(data, "up") || matchesKey(data, "k")
					? -1
					: matchesKey(data, "down") || matchesKey(data, "j")
						? 1
						: 0;
		if (!step) return;
		this.offset += step;
		this.tui.requestRender();
	}
}

const present = async (title: string, body: string, ctx: ExtensionCommandContext) => {
	if (ctx.mode !== "tui") {
		process.stdout.write(`${body}\n`);
		return;
	}
	// 非 overlay: チャットの下、エディタ領域に出す（/model の選択画面と同じ）。
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new SummaryPanel(title, body, theme as Theme, tui as Tui, done), {});
};

const complete = async (prompt: { systemPrompt: string; user: string }, title: string, ctx: ExtensionCommandContext) => {
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
		await present(title, text, ctx);
	} catch (error) {
		ctx.ui.notify(`要約に失敗: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		ctx.ui.setStatus("pi-summary", undefined);
	}
};

const summarize = (level: SummaryLevel, turns: ReturnType<typeof extractTurns>, ctx: ExtensionCommandContext) =>
	complete(buildPrompt(level, turns), level === "low" ? "会話ラリー（要約）" : "全体サマリー", ctx);

export default function (pi: ExtensionAPI) {
	pi.registerCommand("summary", {
		description: "このセッションのユーザー/AI の会話ラリーをそのまま表示",
		handler: async (_args, ctx) => {
			const turns = extractTurns(ctx.sessionManager.getBranch());
			if (turns.length === 0) {
				ctx.ui.notify("会話ラリーがありません", "warning");
				return;
			}
			await present(`会話ラリー ${turns.length} 件`, formatTurns(turns), ctx);
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
			const turns = [
				...last.user.map((text) => ({ role: "user" as const, text })),
				...last.assistant.map((text) => ({ role: "assistant" as const, text })),
			];
			await present("直近の 1 ラリー", formatTurns(turns), ctx);
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
			await complete(buildWorkPrompt(items), `AI の作業（${items.length} ツール呼び出し）`, ctx);
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
