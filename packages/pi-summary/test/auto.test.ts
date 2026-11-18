import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AUTO, parseAutoConfig, shouldRefreshHandoff, shouldRefreshMin } from "../src/auto.ts";

test("有効な設定を読む", () => {
	const auto = parseAutoConfig(`{ "auto": { "enabled": true, "minRallies": 8, "growth": 2, "handoff": true } }`);
	assert.deepEqual(auto, { enabled: true, minRallies: 8, growth: 2, handoff: true });
});

test("壊れた JSON や不正値は既定（無効）に落とす", () => {
	assert.deepEqual(parseAutoConfig(""), DEFAULT_AUTO);
	assert.deepEqual(parseAutoConfig("{"), DEFAULT_AUTO);
	assert.deepEqual(parseAutoConfig(`{ "auto": { "enabled": "yes", "minRallies": 0, "growth": -1 } }`), DEFAULT_AUTO);
	assert.deepEqual(parseAutoConfig(`{ "auto": { "enabled": true, "minRallies": 1.9 } }`), {
		enabled: true,
		minRallies: 1,
		growth: DEFAULT_AUTO.growth,
		handoff: false,
	});
});

test("閾値と成長で min の発火を判定する", () => {
	const auto = { enabled: true, minRallies: 6, growth: 3, handoff: false };
	assert.equal(shouldRefreshMin({ min: undefined }, 5, auto), false); // 閾値未満
	assert.equal(shouldRefreshMin({ min: undefined }, 6, auto), true); // 初回
	assert.equal(shouldRefreshMin({ min: "a", minRallies: 6 }, 8, auto), false); // 成長不足
	assert.equal(shouldRefreshMin({ min: "a", minRallies: 6 }, 9, auto), true); // growth 分成長
	assert.equal(shouldRefreshMin({ min: "a" }, 9, auto), true); // 旧データ（minRallies なし）
	assert.equal(shouldRefreshMin({ min: "a", minRallies: 6 }, 9, { ...auto, enabled: false }), false); // 無効
});

test("引き継ぎ書の増分更新は handoff 有効時のみ発火する", () => {
	const auto = { enabled: true, minRallies: 6, growth: 3, handoff: true };
	assert.equal(shouldRefreshHandoff({}, 5, auto), false); // 閾値未満
	assert.equal(shouldRefreshHandoff({}, 6, auto), true); // 初回
	assert.equal(shouldRefreshHandoff({ handoff: "x", handoffRallies: 6 }, 8, auto), false); // 成長不足
	assert.equal(shouldRefreshHandoff({ handoff: "x", handoffRallies: 6 }, 9, auto), true); // growth 分成長
	assert.equal(shouldRefreshHandoff({ handoff: "x" }, 9, auto), true); // 旧データ（handoffRallies なし）
	assert.equal(shouldRefreshHandoff({ handoff: "x", handoffRallies: 6 }, 9, { ...auto, handoff: false }), false); // handoff 無効
	assert.equal(shouldRefreshHandoff({ handoff: "x", handoffRallies: 6 }, 9, { ...auto, enabled: false }), false); // 全体無効
});
