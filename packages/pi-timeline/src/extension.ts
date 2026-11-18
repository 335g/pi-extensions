/**
 * pi-timeline: DSH 公式 timeline 相当の常設タスク進捗。
 *
 * - `timeline` ツール 1 本でエージェントが計画を全置換する
 * - editor 下の footer に 1 行足す（組み込み footer の pwd / token / model 行の直下）
 * - `alt+t` / `/timeline` で全タスクの画面を開く
 * - 状態は `pi.appendEntry` でセッションに保存し、再開時に復元する
 *
 * 定時報告（モデルへ割り込み送信）はしない。見たい時にキーで開く。
 */

import { FooterComponent, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { type Task, bar, elapsed, fmtDuration, glyph, lines, merge, progress, totalActive } from "./timeline.ts";

const STATE = "pi-timeline";
const TICK_MS = 1000;

/** 組み込み footer を要求する AgentSession のうち、extension から読める部分だけを持つ代役。 */
type FooterSession = ConstructorParameters<typeof FooterComponent>[0];

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
			result: Type.Optional(Type.String({ description: "Concise conclusion of the finished task, shown with it in /timeline" })),
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

/** footer に足す 1 行。狭い端末では切り詰めて、行数が増えないようにする。 */
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
		const suffix = [row.note, row.result ? `→ ${row.result}` : ""].filter((s) => s !== "").join("  ");
		return truncateToWidth(suffix ? `${styled}  ${theme.fg("dim", suffix)}` : styled, width);
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
	let footerCtx: ExtensionContext | undefined;

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

	/** 状態が変わったら footer を出し直す（空なら組み込みの footer に戻す）。 */
	const syncFooter = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (!tasks.length) {
			if (footerCtx) {
				footerCtx.ui.setFooter(undefined);
				footerCtx = undefined;
				tui = undefined;
			}
			return;
		}
		if (footerCtx) {
			refresh();
			return;
		}
		footerCtx = ctx;
		ctx.ui.setFooter((footerTui, theme, footerData) => {
			tui = footerTui;
			// FooterComponent は AgentSession を受けるが extension の ctx には無い。
			// 描画に必要な値だけを ctx から読み毎フレーム渡す。
			const session = {
				get sessionManager() {
					return ctx.sessionManager;
				},
				get model() {
					return ctx.model;
				},
				get state() {
					return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
				},
				routedModel: undefined,
				modelRuntime: { isUsingSubscription: () => false },
				getContextUsage: () => ctx.getContextUsage(),
			} as unknown as FooterSession;
			const base = new FooterComponent(session, footerData);
			return {
				render: (width: number) => [...base.render(width), ...widgetLine(tasks, Date.now(), theme, width)],
				invalidate: () => base.invalidate(),
				dispose: () => {
					base.dispose();
					if (tui === footerTui) tui = undefined;
				},
			};
		});
	};

	const save = (ctx: ExtensionContext): void => {
		pi.appendEntry(STATE, { tasks });
		syncFooter(ctx);
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
		// セッションが差し替わると footer の持ち主も変わるので、登録をやり直す。
		footerCtx = undefined;
		tui = undefined;
		syncFooter(ctx);
		refresh();
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
		if (footerCtx) footerCtx.ui.setFooter(undefined);
		footerCtx = undefined;
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
			"Publish the task plan for this work. Tasks are matched by id: a new id appends a task, an existing id " +
			"updates that task in place, and tasks you don't mention stay. Mark exactly one task active at a time so " +
			"the user sees what is running. Write tasks at the granularity of one concrete change: each task names the " +
			"file, function, or test it touches — never a phase like \"investigate\", \"implement\", or \"test\".",
		promptSnippet: "Publish a file-level plan and per-step progress to the user's timeline panel",
		promptGuidelines: [
			"Use timeline for multi-step work instead of prose checklists; the user sees it live above the prompt.",
			"Send only the tasks you are adding or changing; reuse an existing id to update it, use a fresh id for a new task.",
			"Keep exactly one task active: when you start a new task, mark the previous active task done (or blocked) in the same call.",
			"Each task is one bounded action with a concrete target (e.g. \"add parseArgs to src/cli.ts\"), not an umbrella phase.",
			"When you don't yet know the concrete steps, start with one investigation task, then add file-level steps on the next call.",
			"When a task finishes, set its status to done and put a one-line conclusion in its `result` field so /timeline shows the outcome.",
			"Use parent tasks only to group concrete children, never as stand-alone placeholders.",
		],
		parameters: schema,
		async execute(_toolCallId, params: Params, _signal, _onUpdate, ctx) {
			tasks = merge(tasks, params.tasks ?? [], Date.now());
			save(ctx);
			const { done, total } = progress(tasks);
			const running = tasks.find((t) => t.status === "active");
			const summary = `${done}/${total} done${running ? `, active: ${running.title}` : ""}`;
			const list = tasks.map((t) => `${t.id} [${t.status}] ${t.title}${t.note ? ` (${t.note})` : ""}`).join("\n");
			return { content: [{ type: "text" as const, text: `${summary}\n${list}` }], details: { tasks } };
		},
	});

	pi.registerCommand("timeline", {
		description: "Show the task timeline",
		handler: async (_args, ctx) => open(ctx),
	});

	pi.registerCommand("timeline-reset", {
		description: "Clear the task plan and remove the timeline footer line",
		handler: async (_args, ctx) => {
			tasks = [];
			save(ctx);
			if (ctx.hasUI) ctx.ui.notify("timeline を消去しました", "info");
		},
	});

	pi.registerShortcut("alt+t", {
		description: "Show the task timeline",
		handler: async (ctx) => open(ctx),
	});
}
