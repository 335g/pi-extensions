/**
 * Self-check for the parts that only exist next to pi: the registered surface
 * and the private-runtime access. `node selfcheck.ts`
 */

import extension, { runtimeStream } from "./index.ts";
import { demo } from "./messages.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

demo();

const commands: string[] = [];
const shortcuts: string[] = [];
const events: string[] = [];
let handler: ((args: unknown, ctx: unknown) => Promise<void>) | undefined;
const pi = {
	registerCommand: (name: string, options: { handler: typeof handler }) => {
		commands.push(name);
		handler = options.handler;
	},
	registerShortcut: (key: string) => shortcuts.push(key),
	on: (event: string) => events.push(event),
} as never;

extension(pi);
if (commands.join() !== "btw") throw new Error(`unexpected commands: ${commands}`);
// No shortcut is registered: `alt+b` collides with the built-in editor binding for cursorWordLeft.
if (shortcuts.length > 0) throw new Error(`unexpected shortcuts: ${shortcuts}`);
if (events.join() !== "session_start") throw new Error(`unexpected events: ${events}`);

// Layout: the panel draws its own box, so a line of a different width breaks the
// side borders. Renders the real component through a stubbed TUI/theme.
const rows = 40;
const columns = 100;
let panel: { render(width: number): string[] } | undefined;
await handler!(undefined, {
	mode: "tui",
	model: { id: "m", provider: "p", baseUrl: "https://example.invalid" },
	getSystemPrompt: () => "system",
	modelRegistry: {},
	sessionManager: { getSessionId: () => "session", buildContextEntries: () => [] },
	isIdle: () => true,
	ui: {
		notify: () => {},
		custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: unknown) => typeof panel) => {
			const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, dim: (text: string) => text };
			panel = factory({ terminal: { rows, columns }, requestRender: () => {} }, theme, {}, () => {});
			return { action: "close" };
		},
	},
});
const panelLines = panel!.render(columns);
const widths = new Set(panelLines.map((line) => visibleWidth(line)));
if (widths.size !== 1 || !widths.has(columns)) throw new Error(`panel lines are not ${columns} wide: ${[...widths]}`);
if (panelLines.length > rows) throw new Error(`panel is taller than the terminal: ${panelLines.length}`);
if (!panelLines[0]!.startsWith("╭") || !panelLines.at(-1)!.endsWith("╯")) {
	throw new Error("panel box is not closed with rounded corners");
}

// `ModelRuntime.stream` reaches for `this.prepareRequest`; extracting the method
// would drop the receiver and fail with "cannot read properties of undefined".
const registry = {
	runtime: {
		marker: 42,
		stream(this: { marker: number }) {
			return this.marker;
		},
	},
};
const stream = runtimeStream(registry) as unknown as () => number;
if (stream() !== 42) throw new Error("runtimeStream dropped the runtime receiver");
if (runtimeStream({}) !== undefined) throw new Error("runtimeStream must return undefined without a runtime");

console.log("pi-byetheway: ok");
