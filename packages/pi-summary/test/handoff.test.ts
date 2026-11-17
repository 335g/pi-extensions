import assert from "node:assert/strict";
import test from "node:test";
import {
	buildAdoptPrompt,
	buildHandoffPrompt,
	buildHandoffText,
	computeCoverage,
	insertBullet,
	parseAdopt,
	parseHandoff,
	parseSources,
	serializeRallies,
	stripSources,
} from "../src/handoff.ts";

const turns = [
	{ role: "user" as const, text: "質問1" },
	{ role: "assistant" as const, text: "回答1" },
	{ role: "user" as const, text: "質問2" },
	{ role: "assistant" as const, text: "回答2" },
	{ role: "user" as const, text: "質問3" },
	{ role: "assistant" as const, text: "回答3" },
];

test("ラリーを番号付きで直列化する", () => {
	const s = serializeRallies(turns);
	assert.match(s, /\[ラリー1\]\nユーザー:\n質問1\nAI:\n回答1/);
	assert.match(s, /\[ラリー3\]\nユーザー:\n質問3\nAI:\n回答3/);
});

test("引き継ぎプロンプトは 5 節・保留の形式・出典マーカーを指示する", () => {
	const p = buildHandoffPrompt(turns);
	assert.match(p.user, /3 個の会話ラリー/);
	assert.match(p.user, /## 保留/);
	assert.match(p.user, /出典: ラリーN/);
	assert.match(p.user, /要約: \.\.\./);
	assert.match(p.user, /\[ラリー1\]/);
});

test("引き継ぎ書と保留リストを分け、coverage を計算する", () => {
	const raw = ["## 状況", "- 進行中（出典: ラリー1）", "", "## 決まったこと", "- 方針A（出典: ラリー2）", "", "## 保留", "- ラリー3 | 要約: 方針Bも検討 | 理由: 却下済み"].join("\n");
	const h = parseHandoff(raw, 3);
	assert.equal(h.rallyCount, 3);
	assert.match(h.text, /## 状況/);
	assert.doesNotMatch(h.text, /## 保留/);
	assert.deepEqual(h.deferred, [{ summary: "方針Bも検討", reason: "却下済み", sources: [3] }]);
	assert.equal(h.coverage.get(1), "adopted");
	assert.equal(h.coverage.get(2), "adopted");
	assert.equal(h.coverage.get(3), "deferred");
});

test("引き継ぎ書と保留の両方に出たラリーは adopted が勝つ", () => {
	const h = parseHandoff("## 状況\n- x（出典: ラリー2）\n\n## 保留\n- ラリー2 | 要約: y | 理由: z", 2);
	assert.equal(h.coverage.get(2), "adopted");
	assert.equal(h.coverage.get(1), "dropped");
});

test("出典マーカーを除去する", () => {
	assert.equal(stripSources("- 進行中（出典: ラリー1,2）"), "- 進行中");
	assert.deepEqual(parseSources("- a（出典: ラリー1,2）- b（出典: ラリー3）"), [1, 2, 3]);
});

test("節の末尾に箇条書きを足す", () => {
	const text = "## 状況\n- a\n\n## 注意\n- b";
	assert.equal(insertBullet(text, "状況", "- c"), "## 状況\n- a\n- c\n## 注意\n- b");
});

test("節が無ければ末尾に節ごと追加する", () => {
	assert.equal(insertBullet("## 状況\n- a", "未解決", "- x"), "## 状況\n- a\n\n## 未解決\n- x");
});

test("採用結果の節と文を読み取る", () => {
	assert.deepEqual(parseAdopt("節: 注意\n文: - テスト未作成", "fallback"), { section: "注意", bullet: "- テスト未作成" });
	assert.deepEqual(parseAdopt("ぐちゃぐちゃ", "fallback"), { section: "注意", bullet: "- fallback" });
});

test("採用プロンプトは元のラリーだけを渡す", () => {
	const p = buildAdoptPrompt({ summary: "s", reason: "r", sources: [2] }, turns);
	assert.match(p.user, /\[ラリー2\]\nユーザー:\n質問2/);
	assert.doesNotMatch(p.user, /質問1/);
	assert.match(p.user, /節: </);
});

test("引き継ぎプロンプトの形に包む", () => {
	const out = buildHandoffText("## 状況\n- a");
	assert.match(out, /^以下は前のセッションからの引き継ぎです/);
	assert.match(out, /## 状況\n- a/);
});

test("coverage は未引用のラリーを dropped にする", () => {
	const c = computeCoverage(3, "## 状況\n- a（出典: ラリー1）", [{ summary: "s", reason: "r", sources: [2] }]);
	assert.equal(c.get(1), "adopted");
	assert.equal(c.get(2), "deferred");
	assert.equal(c.get(3), "dropped");
});
