import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkPrompt, extractLastWork } from "../src/work.ts";

const entries = [
	{ type: "message", message: { role: "user", content: "古い依頼" } },
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command: "rm x" } }] } },
	{ type: "message", message: { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "古い結果" }], isError: false } },
	{ type: "message", message: { role: "user", content: "新しい依頼" } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "やります" }, { type: "toolCall", id: "b", name: "edit", arguments: { path: "src/a.ts" } }] } },
	{ type: "message", message: { role: "toolResult", toolCallId: "b", content: [{ type: "text", text: "ok" }], isError: false } },
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "npm test" } }] } },
	{ type: "message", message: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "1 failed" }], isError: true } },
];

test("直前のユーザー発話以降のツール呼び出しだけを結果と対にする", () => {
	assert.deepEqual(extractLastWork(entries), [
		{ tool: "edit", args: '{"path":"src/a.ts"}', result: "ok", isError: false },
		{ tool: "bash", args: '{"command":"npm test"}', result: "1 failed", isError: true },
	]);
});

test("長い引数は切り、プロンプトにツール名とエラー印を入れる", () => {
	const long = extractLastWork([
		{ type: "message", message: { role: "user", content: "x" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "d", name: "write", arguments: { content: "a".repeat(500) } }] } },
	]);
	assert.ok(long[0].args.length < 320);
	assert.match(buildWorkPrompt(long).user, /\[1\] write/);

	const { user } = buildWorkPrompt(extractLastWork(entries));
	assert.match(user, /→ 1 failed \[エラー\]/);
	assert.match(user, /触ったファイル/);
});
