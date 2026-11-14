import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { type SummaryLevel, buildPrompt, groupRallies } from "./summarize.ts";
import { extractTurns, formatTurns } from "./turns.ts";
import { buildWorkPrompt, extractLastWork } from "./work.ts";

type Theme = { fg(key: string, text: string): string; bold(text: string): string };
type Tui = { requestRender(): void };

/** VStack のまま TUI に渡す。ラップすると layout が降りず ScrollView の高さが 0 になる。 */
class MarkdownOverlay extends VStack {
	private readonly view: ScrollView;
	private readonly tui: Tui;
	private readonly done: () => void;

	constructor(title: string, body: string, theme: Theme, tui: Tui, done: () => void) {
		const view = new ScrollView(new Markdown(body, 1, 1, getMarkdownTheme()), { scrollbar: "auto" });
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		super([
			{ component: border, basis: 1 },
			{ component: new Text(theme.fg("accent", theme.bold(title)), 1, 0), basis: 1 },
			{ component: view, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: new Text(theme.fg("dim", "j/k または ↑/↓ でスクロール、Enter/Esc で閉じる"), 1, 0), basis: 1 },
			{ component: border, basis: 1 },
		]);
		this.view = view;
		this.tui = tui;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) return this.done();
		const step = matchesKey(data, "pageup") ? -10 : matchesKey(data, "pagedown") ? 10 : 0;
		if (step) this.view.scrollBy(step);
		else if (matchesKey(data, "up") || matchesKey(data, "k")) this.view.scrollBy(-1);
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.view.scrollBy(1);
		else return;
		this.tui.requestRender();
	}
}

const present = async (title: string, body: string, ctx: ExtensionCommandContext) => {
	if (ctx.mode !== "tui") {
		process.stdout.write(`${body}\n`);
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new MarkdownOverlay(title, body, theme as Theme, tui, done), {
		overlay: true,
		overlayOptions: { width: "90%", maxHeight: "90%", margin: 1 },
	});
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
