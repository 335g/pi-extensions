/**
 * Wiring self-check: `node selfcheck.ts` (in this directory).
 *
 * Drives the extension with a stub ExtensionAPI so the tool, the widget, the
 * full view and the restore path are exercised without a model or a terminal.
 */

import assert from "node:assert/strict";
import { Value } from "typebox/value";
import extension from "./src/extension.ts";

type Any = (...args: any[]) => any;

const handlers = new Map<string, Any[]>();
const tools = new Map<string, any>();
const commands = new Map<string, Any>();
const shortcuts = new Map<string, Any>();
const entries: unknown[] = [];

const pi = {
	on: (event: string, handler: Any) => {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	},
	registerTool: (tool: any) => void tools.set(tool.name, tool),
	registerCommand: (name: string, options: { handler: Any }) => void commands.set(name, options.handler),
	registerShortcut: (key: string, options: { handler: Any }) => void shortcuts.set(key, options.handler),
	appendEntry: (customType: string, data: unknown) => void entries.push({ customType, data }),
} as never;

const theme = {
	fg: (_c: string, text: string) => text,
	bg: (_c: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
} as never;

let widgetFactory: Any | undefined;
let widgetCleared = false;
let viewFactory: Any | undefined;

const ui = {
	setWidget: (_key: string, content: unknown) => {
		if (content === undefined) {
			widgetCleared = true;
			widgetFactory = undefined;
			return;
		}
		widgetFactory = content;
	},
	notify: (message: string) => console.log(`notify: ${message}`),
	custom: (factory: Any) =>
		new Promise((resolve) => {
			viewFactory = () => factory({ requestRender: () => {}, terminal: { rows: 20 } }, theme, undefined, resolve);
		}),
};

const ctx = {
	hasUI: true,
	mode: "tui",
	ui,
	sessionManager: {
		getBranch: () => entries.map((e: any) => ({ type: "custom", customType: e.customType, data: e.data })),
	},
} as never;

const fire = async (event: string): Promise<void> => {
	for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
};

const width = (lines: string[], max: number): void => {
	for (const line of lines) assert.ok(line.length <= max, `line too wide (${line.length} > ${max}): ${line}`);
};

extension(pi);

assert.ok(tools.has("timeline"), "timeline tool registered");
assert.ok(commands.has("timeline"), "/timeline command registered");
assert.ok(shortcuts.has("alt+t"), "alt+t shortcut registered");
assert.ok(handlers.has("session_start"), "session_start handler registered");

// 空の状態では widget を出さない
await fire("session_start");
assert.equal(widgetFactory, undefined, "no widget before the first plan");
await commands.get("timeline")?.("", ctx);
assert.equal(viewFactory, undefined, "view stays closed when the timeline is empty");

const tool = tools.get("timeline");

// ツール経由で計画を出し、widget が描画される
const result = await tool.execute(
	"call-1",
	{ tasks: [{ id: "1", title: "plan", status: "done" }, { id: "2", title: "build", status: "active" }] },
	undefined,
	undefined,
	ctx,
);
assert.equal(result.content[0].text.startsWith("1/2 done"), true, result.content[0].text);
assert.equal(entries.length, 1, "state persisted as a custom entry");
assert.ok(widgetFactory, "widget registered once tasks exist");

// ツールのスキーマが意図どおり（status は 4 値のみ通す）
const schema = tools.get("timeline").parameters;
const ok = (tasks: unknown) => Value.Check(schema, { tasks });
assert.equal(ok([{ id: "1", title: "a", status: "active", parent: "0", note: "n" }]), true);
assert.equal(ok([{ id: "1", title: "a", status: "wip" }]), false, "unknown status rejected");
assert.equal(ok([{ title: "a" }]), false, "id is required");

const widget = widgetFactory({ requestRender: () => {}, terminal: { rows: 40 } }, theme);
width(widget.render(120), 120);
width(widget.render(40), 40);
const line = widget.render(120).join("\n");
assert.match(line, /timeline/);
assert.match(line, /1\/2/);
assert.match(line, /build/);
widget.dispose();

// 保存済みエントリから復元する（再起動と同じ経路）
widgetFactory = undefined;
await fire("session_start");
assert.ok(widgetFactory, "state restored from the session branch");

// 全画面: ヘッダ・子タスクのインデント・ノート・スクロール
await tool.execute(
	"call-2",
	{
		tasks: [
			{ id: "1", title: "plan", status: "done" },
			{ id: "1.1", title: "child", parent: "1" },
			{ id: "2", title: "build", status: "active", note: "wiring widget" },
			{ id: "3", title: "test", status: "blocked" },
		],
	},
	undefined,
	undefined,
	ctx,
);
const opening = commands.get("timeline")?.("", ctx);
await Promise.resolve();
const view = viewFactory();
width(view.render(80), 80);
const first = view.render(80);
const text = first.join("\n");
assert.match(text, /timeline/);
assert.match(text, /1\/4/);
assert.ok(first.some((l: string) => l.includes("child") && l.startsWith("  ")), "child task is indented");
assert.match(text, /wiring widget/, "note is shown");
view.handleInput("down");
width(view.render(80), 80);
view.handleInput("q");
view.dispose(); // pi は custom() 完了時に dispose する
await opening;
assert.equal(typeof shortcuts.get("alt+t"), "function", "shortcut handler registered");

// 空の計画で widget を消す
await tool.execute("call-3", { tasks: [] }, undefined, undefined, ctx);
assert.equal(widgetCleared, true, "widget cleared when the plan is empty");

// 終了時に掃除される
await fire("session_shutdown");
console.log("selfcheck: ok");
