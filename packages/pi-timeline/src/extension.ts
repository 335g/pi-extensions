/**
 * pi-timeline: DSH 公式 timeline 相当の常設タスク進捗。
 *
 * - `timeline` ツール 1 本でエージェントが計画を全置換する
 * - editor 上に 1 行 widget（進捗バー + 実行中タスク + 経過時間）
 * - `alt+t` / `/timeline` で全タスクの画面を開く
 * - 状態は `pi.appendEntry` でセッションに保存し、再開時に復元する
 *
 * 定時報告（モデルへ割り込み送信）はしない。見たい時にキーで開く。
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { type Task, bar, elapsed, fmtDuration, glyph, lines, merge, progress, totalActive } from "./timeline.ts";

const STATE = "pi-timeline";
const WIDGET = "timeline";
const TICK_MS = 1000;

const statusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("active"),
	Type.Literal("done"),
	Type.Literal("blocked"),
]);

const schema = Type.Object({
	tasks: Type.Array(
		Type.Object({
			id: Type.String({ description: 'Stable id you reuse, e.g. "1" or "auth"' }),
			title: Type.String({ description: "Short imperative title" }),
			status: Type.Optional(statusSchema),
			parent: Type.Optional(Type.String({ description: "id of the parent task" })),
			note: Type.Optional(Type.String({ description: "Short reason, shown for blocked tasks" })),
		}),
		{ description: "The complete task list. Each call replaces the previous list." },
	),
});

type Params = Static<typeof schema>;

const COLOR: Record<string, "success" | "accent" | "muted" | "warning"> = {
	done: "success",
	active: "accent",
	pending: "muted",
	blocked: "warning",
};

/** widget は 1 行。狭い端末では切り詰めて、行数が増えないようにする。 */
function widgetLine(tasks: readonly Task[], now: number, theme: Theme, width: number): string[] {
	const { done, total } = progress(tasks);
	const running = tasks.find((t) => t.status === "active");
	const blocked = tasks.filter((t) => t.status === "blocked").length;
	const parts = [
		theme.fg("accent", "timeline"),
		theme.fg("muted", `${done}/${total}`),
		theme.fg(done === total ? "success" : "border", bar(done, total)),
	];
	if (running) parts.push(theme.fg("accent", `▶ ${running.title} ${fmtDuration(elapsed(running, now) ?? 0)}`));
	if (blocked) parts.push(theme.fg("warning", `!${blocked}`));
	if (!running && !blocked) parts.push(theme.fg("muted", done === total ? "all done" : "idle"));
	return [truncateToWidth(parts.join("  "), width)];
}

/** 全画面。ヘッダ 1 行 + 本文 + 操作ヒント 1 行。 */
function viewLines(
	tasks: readonly Task[],
	now: number,
	theme: Theme,
	width: number,
	height: number,
	offset: number,
): { lines: string[]; offset: number } {
	const { done, total } = progress(tasks);
	const percent = total === 0 ? 0 : Math.round((done / total) * 100);
	const head = [
		theme.fg("accent", theme.bold("timeline")),
		theme.fg("muted", `${done}/${total}`),
		theme.fg(done === total && total > 0 ? "success" : "border", bar(done, total, 20)),
		theme.fg("muted", `${percent}%`),
		theme.fg("muted", `合計 ${fmtDuration(totalActive(tasks, now))}`),
	].join("  ");

	const body = Math.max(1, height - 4);
	const rows = lines(tasks, now);
	const maxOffset = Math.max(0, rows.length - body);
	const start = Math.min(Math.max(0, offset), maxOffset);
	const titleWidth = Math.max(12, Math.min(60, width - 24));

	const painted = rows.slice(start, start + body).map((row) => {
		const indent = "  ".repeat(row.depth);
		const color = COLOR[row.status] ?? "muted";
		const left = `${indent}${theme.fg(color, glyph(row.status))} ${row.title}`;
		const right = row.duration ? theme.fg("dim", row.duration) : "";
		const styled = right
			? `${left}${" ".repeat(Math.max(1, titleWidth - (indent.length + row.title.length + 2)))}${right}`
			: left;
		return truncateToWidth(row.note ? `${styled}  ${theme.fg("dim", row.note)}` : styled, width);
	});

	const hint =
		rows.length > body
			? `↑↓ scroll (${start + 1}-${Math.min(rows.length, start + body)}/${rows.length}) · esc close`
			: "esc close";
	const blank = Array.from({ length: Math.max(0, body - painted.length) }, () => "");
	return {
		lines: [truncateToWidth(head, width), "", ...painted, ...blank, "", theme.fg("dim", hint)],
		offset: start,
	};
}

export default function (pi: ExtensionAPI) {
	let tasks: Task[] = [];
	let tui: TUI | undefined;
	let widgetCtx: ExtensionContext | undefined;

	const refresh = (): void => tui?.requestRender();

	/** 画面を開く。オフセットは render 側で持ち、入力で上下させる。 */
	const open = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		if (!tasks.length) {
			ctx.ui.notify("timeline は空です", "info");
			return;
		}
		let offset = 0;
		let cachedWidth = -1;
		let cachedRows = -1;
		let cached: string[] | undefined;
		const invalidate = (): void => {
			cached = undefined;
		};
		const tick = setInterval(() => {
			invalidate();
			refresh();
		}, TICK_MS);
		await ctx.ui.custom<string>((viewTui, theme, _keybindings, done) => ({
			render(width: number): string[] {
				const height = Math.max(6, viewTui.terminal.rows);
				if (cached && cachedWidth === width && cachedRows === height) return cached;
				const result = viewLines(tasks, Date.now(), theme, width, height, offset);
				offset = result.offset;
				cachedWidth = width;
				cachedRows = height;
				cached = result.lines;
				return cached;
			},
			handleInput(data: string): void {
				const step = matchesKey(data, "pageUp") || matchesKey(data, "pageDown") ? 10 : 1;
				if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
					done("");
					return;
				}
				if (matchesKey(data, "up") || matchesKey(data, "pageUp")) offset = Math.max(0, offset - step);
				else if (matchesKey(data, "down") || matchesKey(data, "pageDown")) offset += step;
				else return;
				invalidate();
				refresh();
			},
			invalidate,
			dispose() {
				clearInterval(tick);
			},
		}));
	};

	/** 状態が変わったら widget を出し直す（空なら消す）。 */
	const syncWidget = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (!tasks.length) {
			if (widgetCtx) {
				widgetCtx.ui.setWidget(WIDGET, undefined);
				widgetCtx = undefined;
				tui = undefined;
			}
			return;
		}
		if (widgetCtx) {
			refresh();
			return;
		}
		widgetCtx = ctx;
		ctx.ui.setWidget(WIDGET, (widgetTui, theme) => {
			tui = widgetTui;
			return {
				render: (width: number) => widgetLine(tasks, Date.now(), theme, width),
				invalidate: () => {},
				dispose: () => {
					if (tui === widgetTui) tui = undefined;
				},
			};
		});
	};

	const save = (ctx: ExtensionContext): void => {
		pi.appendEntry(STATE, { tasks });
		syncWidget(ctx);
	};

	/** ブランチ上の最後の保存を読み直す。分岐・再開・reload のすべてで同じ経路を通る。 */
	const restore = (ctx: ExtensionContext): void => {
		let saved: Task[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE) {
				saved = (entry.data as { tasks?: Task[] } | undefined)?.tasks ?? [];
			}
		}
		tasks = saved;
		// セッションが差し替わると widget の持ち主も変わるので、登録をやり直す（同じ key は上書き）。
		widgetCtx = undefined;
		tui = undefined;
		syncWidget(ctx);
		refresh();
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
		if (widgetCtx) widgetCtx.ui.setWidget(WIDGET, undefined);
		widgetCtx = undefined;
		tui = undefined;
	});

	const timer = setInterval(() => {
		if (tasks.some((t) => t.status === "active")) refresh();
	}, TICK_MS);
	pi.on("session_shutdown", () => clearInterval(timer));

	pi.registerTool({
		name: "timeline",
		label: "Timeline",
		description:
			"Publish the task plan for this work. Every call replaces the whole list: send the full plan each time, " +
			"changing statuses as you go (pending, active, done, blocked). Use it for work that takes several steps, " +
			"and mark exactly one task active at a time so the user sees what is running.",
		promptSnippet: "Publish the plan and per-step progress to the user's timeline panel",
		promptGuidelines: [
			"Use timeline for multi-step work instead of prose checklists; the user sees it live above the prompt.",
			"Send the full task list on every timeline call, reusing the same ids; keep exactly one task active.",
		],
		parameters: schema,
		async execute(_toolCallId, params: Params, _signal, _onUpdate, ctx) {
			tasks = merge(tasks, params.tasks ?? [], Date.now());
			save(ctx);
			const { done, total } = progress(tasks);
			const running = tasks.find((t) => t.status === "active");
			const summary = `${done}/${total} done${running ? `, active: ${running.title}` : ""}`;
			return { content: [{ type: "text" as const, text: summary }], details: { tasks } };
		},
	});

	pi.registerCommand("timeline", {
		description: "Show the task timeline",
		handler: async (_args, ctx) => open(ctx),
	});

	pi.registerShortcut("alt+t", {
		description: "Show the task timeline",
		handler: async (ctx) => open(ctx),
	});
}
