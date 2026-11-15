import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkPrompt, extractWorkBetween } from "../src/work.ts";

const entries = [
	{ id: "e1", type: "message", message: { role: "user", content: "古い依頼" } },
	{ id: "e2", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command: "rm x" } }] } },
	{ id: "e3", type: "message", message: { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "古い結果" }], isError: false } },
	{ id: "e4", type: "message", message: { role: "user", content: "新しい依頼" } },
	{ id: "e5", type: "message", message: { role: "assistant", content: [{ type: "text", text: "やります" }, { type: "toolCall", id: "b", name: "edit", arguments: { path: "src/a.ts" } }] } },
	{ id: "e6", type: "message", message: { role: "toolResult", toolCallId: "b", content: [{ type: "text", text: "ok" }], isError: false } },
	{ id: "e7", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "npm test" } }] } },
	{ id: "e8", type: "message", message: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "1 failed" }], isError: true } },
];

test("指定した 2 つの発話の間のツール呼び出しだけを結果と対にする", () => {
	const expected = [
		{ tool: "edit", args: '{"path":"src/a.ts"}', result: "ok", isError: false },
		{ tool: "bash", args: '{"command":"npm test"}', result: "1 failed", isError: true },
	];
	assert.deepEqual(extractWorkBetween(entries, "e4", "e7"), expected);
	assert.deepEqual(extractWorkBetween(entries, "e7", "e4"), expected);
});

test("範囲外のツール呼び出しは含めない", () => {
	assert.deepEqual(extractWorkBetween(entries, "e1", "e2"), [{ tool: "bash", args: '{"command":"rm x"}', result: "古い結果", isError: false }]);
	assert.deepEqual(extractWorkBetween(entries, "e4", "e8").map((item) => item.tool), ["edit", "bash"]);
});

test("id が見つからなければ空を返す", () => {
	assert.deepEqual(extractWorkBetween(entries, "nope", "e4"), []);
	assert.deepEqual(extractWorkBetween(entries, "e4", "e4"), []);
});

test("長い引数は切り、プロンプトにツール名とエラー印を入れる", () => {
	const long = extractWorkBetween(
		[
			{ id: "x1", type: "message", message: { role: "user", content: "x" } },
			{ id: "x2", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "d", name: "write", arguments: { content: "a".repeat(500) } }] } },
		],
		"x1",
		"x2",
	);
	assert.ok(long[0].args.length < 320);
	assert.match(buildWorkPrompt(long).user, /\[1\] write/);

	const { user } = buildWorkPrompt(extractWorkBetween(entries, "e4", "e8"));
	assert.match(user, /→ 1 failed \[エラー\]/);
	assert.match(user, /箇条書き/);
});
