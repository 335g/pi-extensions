import assert from "node:assert/strict";
import { test } from "node:test";
import { panelRows, sliceWindow } from "../src/panel.ts";

test("本文の上限は端末の 60% で、最低 3 行", () => {
	assert.equal(panelRows(40), 24);
	assert.equal(panelRows(10), 6);
	assert.equal(panelRows(0), 3);
});

test("offset は 0 から最終ページに丸められる", () => {
	const lines = Array.from({ length: 50 }, (_, i) => `${i}`);
	assert.deepEqual(sliceWindow(lines, 0, 10), { lines: lines.slice(0, 10), offset: 0 });
	assert.deepEqual(sliceWindow(lines, 45, 10), { lines: lines.slice(40), offset: 40 });
	assert.deepEqual(sliceWindow(lines, -3, 10), { lines: lines.slice(0, 10), offset: 0 });
});

test("内容が上限より短いときは全体を返す", () => {
	const lines = ["a", "b"];
	assert.deepEqual(sliceWindow(lines, 0, 10), { lines, offset: 0 });
});
