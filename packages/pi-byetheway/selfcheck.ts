/**
 * Self-check for the parts that only exist next to pi: the registered surface
 * and the private-runtime access. `node selfcheck.ts`
 */

import extension, { runtimeStream } from "./index.ts";
import { demo } from "./messages.ts";

demo();

const commands: string[] = [];
const shortcuts: string[] = [];
const events: string[] = [];
const pi = {
	registerCommand: (name: string) => commands.push(name),
	registerShortcut: (key: string) => shortcuts.push(key),
	on: (event: string) => events.push(event),
} as never;

extension(pi);
if (commands.join() !== "btw") throw new Error(`unexpected commands: ${commands}`);
if (shortcuts.join() !== "alt+b") throw new Error(`unexpected shortcuts: ${shortcuts}`);
if (events.join() !== "session_start") throw new Error(`unexpected events: ${events}`);

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
