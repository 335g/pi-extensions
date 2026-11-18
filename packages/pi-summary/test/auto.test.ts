import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AUTO, parseAutoConfig, shouldRefreshMin } from "../src/auto.ts";

test("有効な設定を読む", () => {
	const auto = parseAutoConfig(`{ "auto": { "enabled": true, "minRallies": 8, "growth": 2 } }`);
	assert.deepEqual(auto, { enabled: true, minRallies: 8, growth: 2 });
});

test("壊れた JSON や不正値は既定（無効）に落とす", () => {
	assert.deepEqual(parseAutoConfig(""), DEFAULT_AUTO);
	assert.deepEqual(parseAutoConfig("{"), DEFAULT_AUTO);
	assert.deepEqual(parseAutoConfig(`{ "auto": { "enabled": "yes", "minRallies": 0, "growth": -1 } }`), DEFAULT_AUTO);
	assert.deepEqual(parseAutoConfig(`{ "auto": { "enabled": true, "minRallies": 1.9 } }`), {
		enabled: true,
		minRallies: 1,
		growth: DEFAULT_AUTO.growth,
	});
});

test("閾値と成長で発火を判定する", () => {
	const auto = { enabled: true, minRallies: 6, growth: 3 };
	assert.equal(shouldRefreshMin({ min: undefined }, 5, auto), false); // 閾値未満
	assert.equal(shouldRefreshMin({ min: undefined }, 6, auto), true); // 初回
	assert.equal(shouldRefreshMin({ min: "a", minRallies: 6 }, 8, auto), false); // 成長不足
	assert.equal(shouldRefreshMin({ min: "a", minRallies: 6 }, 9, auto), true); // growth 分成長
	assert.equal(shouldRefreshMin({ min: "a" }, 9, auto), true); // 旧データ（minRallies なし）
	assert.equal(shouldRefreshMin({ min: "a", minRallies: 6 }, 9, { ...auto, enabled: false }), false); // 無効
});
