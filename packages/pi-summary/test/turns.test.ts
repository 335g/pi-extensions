import assert from "node:assert/strict";
import test from "node:test";
import { extractTurns, formatTurns } from "../src/turns.ts";

test("user/assistant の発話だけを順に残す", () => {
	const entries = [
		{ type: "message", message: { role: "system", content: "" } },
		{ type: "message", message: { role: "user", content: "こんにちは" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "やあ" }] } },
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "out" }] } },
		{ type: "model_change", provider: "x", modelId: "y" },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "結果です" }] } },
	];

	assert.deepEqual(extractTurns(entries), [
		{ role: "user", text: "こんにちは" },
		{ role: "assistant", text: "やあ" },
		{ role: "assistant", text: "結果です" },
	]);
});

test("本文が空の発話は落とし、整形は索引付きになる", () => {
	const turns = extractTurns([
		{ type: "message", message: { role: "user", content: "  " } },
		{ type: "message", message: { role: "user", content: [{ type: "image", data: "x" }] } },
	]);
	assert.deepEqual(turns, []);
	assert.equal(formatTurns([]), "");
	assert.match(formatTurns(extractTurns([{ type: "message", message: { role: "user", content: "a" } }])), /^### 1\. ユーザー\n\na$/);
});
