import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt, groupRallies } from "../src/summarize.ts";

const turns = [
	{ role: "user" as const, text: "質問1" },
	{ role: "assistant" as const, text: "回答1" },
	{ role: "assistant" as const, text: "回答1の続き" },
	{ role: "user" as const, text: "質問2" },
	{ role: "assistant" as const, text: "回答2" },
];

test("ラリーは user 発話で区切られ、連続する AI 発話はまとまる", () => {
	assert.deepEqual(groupRallies(turns), [
		{ user: ["質問1"], assistant: ["回答1", "回答1の続き"] },
		{ user: ["質問2"], assistant: ["回答2"] },
	]);
});

test("low はラリー数と 2〜3 行指定、min は 10〜20 行指定を含む", () => {
	const low = buildPrompt("low", turns);
	const min = buildPrompt("min", turns);
	assert.match(low.user, /2 個の会話ラリー/);
	assert.match(low.user, /2〜3 行/);
	assert.match(min.user, /10〜20 行/);
	assert.match(min.user, /次にやること/);
	for (const prompt of [low, min]) {
		assert.match(prompt.user, /\[1\] ユーザー:\n質問1/);
		assert.match(prompt.user, /回答2/);
	}
});
