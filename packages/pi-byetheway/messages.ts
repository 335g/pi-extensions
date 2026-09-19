/**
 * Projection of session messages into what a btw request can carry.
 *
 * A btw request sends no tool definitions, so tool calls and results have to be
 * flattened to text and consecutive same-role messages merged; providers reject
 * tool blocks that reference missing tools, and some reject the repetition.
 *
 * Type-only imports, so `node messages.ts` runs the self-check below directly.
 */

import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";

export type Turn = { question: string; answer: string };

/**
 * Whether the turn says anything in prose. Assistant turns that do not exist
 * only to carry tool calls, and their calls are dropped with the marker.
 */
function hasProse(message: Message): boolean {
	const content = message.content;
	if (typeof content === "string") return content.trim().length > 0;
	return content.some((block) => block.type === "text" && block.text.trim().length > 0);
}

export function sanitize(messages: Message[]): Message[] {
	const out: Message[] = [];
	for (const message of messages) {
		// Keeping these would leave a `[bash]` line per tool call in the record,
		// which reads as an example of the assistant answering with a tool call.
		if (message.role === "assistant" && !hasProse(message)) continue;
		const text = textOf(message);
		if (!text) continue;
		const role = message.role === "assistant" ? "assistant" : "user";
		const last = out[out.length - 1];
		// Tool round trips collapse into the surrounding turns, so repeats are normal here.
		if (last && last.role === role) {
			last.content = [...asText(last.content), { type: "text", text }];
			continue;
		}
		out.push(
			role === "assistant"
				? { ...(message as AssistantMessage), content: [{ type: "text", text }] }
				: { role: "user", content: [{ type: "text", text }], timestamp: message.timestamp },
		);
	}
	return out;
}

function asText(content: Message["content"]): { type: "text"; text: string }[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.filter((block) => block.type === "text");
}

/**
 * Text view of one message: images dropped, thinking dropped, tool calls and
 * results labelled. Tool-call-only assistant turns keep a marker so each tool
 * result stays attached to the turn that produced it.
 */
export function textOf(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content.trim();
	const parts: string[] = [];
	let hasImage = false;
	for (const block of content) {
		if (block.type === "text") parts.push(block.text.trim());
		else if (block.type === "image") hasImage = true;
		else if (block.type === "toolCall" && message.role === "assistant") parts.push(`[${block.name}]`);
	}
	const text = parts.filter(Boolean).join("\n\n");
	if (message.role === "toolResult") return `[${message.toolName} の出力]\n${text || "なし"}`;
	if (message.role === "assistant") return text;
	if (hasImage) return [text, "(画像は省略)"].filter(Boolean).join("\n");
	return text;
}

/** History turns in the btw space were never produced by a provider request. */
export function assistantTurn(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }] } as unknown as Message;
}

export function userTurn(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

export function transcriptOf(turns: Turn[]): string {
	return turns.map((turn, index) => `Q${index + 1}: ${turn.question}\nA${index + 1}: ${turn.answer}`).join("\n\n");
}

/**
 * Whether a reply is usable. An answer that is nothing but a tool marker means
 * the model tried to call a tool it was not offered, and the turn is a dead end.
 */
export function hasAnswer(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.length > 0 && !/^\[[a-z_][a-z0-9_-]{0,30}( の出力)?\]$/.test(trimmed);
}

// ---------------------------------------------------------------- self-check

export function demo(): void {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image", data: "x", mimeType: "image/png" }], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 2,
		},
		{ role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 3 },
		{ role: "user", content: "second", timestamp: 4 },
		{
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			timestamp: 5,
		},
	] as unknown as Message[];

	const out = sanitize(messages);
	if (out.length !== 2) throw new Error(`expected 2 messages, got ${out.length}`);
	const roles = out.map((message) => message.role).join(",");
	if (roles !== "user,assistant") throw new Error(`unexpected roles: ${roles}`);

	const first = JSON.stringify(out[0].content);
	for (const needle of ["hello", "(画像は省略)", "[read の出力]", "file contents", "second"]) {
		if (!first.includes(needle)) throw new Error(`first message is missing ${needle}: ${first}`);
	}
	// The call-only turn is dropped, so its marker must not survive as a line of its own.
	if (first.includes("[read]")) throw new Error("a tool marker from a call-only turn survived");
	if (JSON.stringify(out[1].content) !== JSON.stringify([{ type: "text", text: "answer" }])) {
		throw new Error(`unexpected assistant content: ${JSON.stringify(out[1].content)}`);
	}
	// Metadata carried by the original assistant message must survive the rewrite.
	if ((out[1] as unknown as { model?: string }).model !== "m") throw new Error("assistant metadata was dropped");

	// A turn with prose keeps its tool markers, so the calls stay attached to it.
	const mixed = sanitize([
		{
			role: "assistant",
			content: [
				{ type: "text", text: "調べます" },
				{ type: "toolCall", id: "1", name: "bash", arguments: {} },
			],
			timestamp: 1,
		} as unknown as Message,
	]);
	if (!JSON.stringify(mixed[0].content).includes("[bash]")) throw new Error("a mixed turn lost its tool marker");

	if (textOf({ role: "assistant", content: [{ type: "text", text: "  " }] } as unknown as Message) !== "") {
		throw new Error("blank assistant turns must be dropped");
	}
	if (sanitize([{ role: "assistant", content: [{ type: "text", text: " " }], timestamp: 1 } as unknown as Message]).length !== 0) {
		throw new Error("a turn with no readable text must be dropped");
	}
	if (transcriptOf([{ question: "q", answer: "a" }]) !== "Q1: q\nA1: a") throw new Error("bad transcript");

	if (!hasAnswer("ふつうの回答")) throw new Error("prose must count as an answer");
	if (hasAnswer("   ")) throw new Error("blank must not count as an answer");
	for (const marker of ["[bash]", "[read の出力]", "  [grep-search]  "]) {
		if (hasAnswer(marker)) throw new Error(`${marker} must not count as an answer`);
	}
	for (const prose of ["[重要] ここが問題です", "[bash] と思われる"]) {
		if (!hasAnswer(prose)) throw new Error(`${prose} must count as an answer`);
	}
}
