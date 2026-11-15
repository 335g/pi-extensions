import assert from "node:assert/strict";
import test from "node:test";
import { buildCommentPrompt, buildMinPrompt, groupRallies } from "../src/summarize.ts";

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

test("全体要約はラリー数と 10〜20 行指定、ログ全体を含む", () => {
	const prompt = buildMinPrompt(turns);
	assert.match(prompt.user, /2 個の会話ラリー/);
	assert.match(prompt.user, /10〜20 行/);
	assert.match(prompt.user, /次にやること/);
	assert.match(prompt.user, /\[1\] ユーザー:\n質問1/);
	assert.match(prompt.user, /回答2/);
});

test("コメント要約は箇条書きを指示し、対象の本文だけを渡す", () => {
	const prompt = buildCommentPrompt("本文です");
	assert.match(prompt.user, /箇条書き/);
	assert.match(prompt.user, /<text>\n本文です\n<\/text>/);
	assert.doesNotMatch(prompt.user, /10〜20 行/);
});
