import assert from "node:assert/strict";
import { test } from "node:test";
import { boxWidth, canMove, modeForKey, pageTarget, panelRows, revealOffset, scrollWithin, sliceWindow, toggleShow } from "../src/panel.ts";

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

test("吹き出しの幅は端末幅に従い、100 桁で頭打ち", () => {
	assert.equal(boxWidth(120), 100);
	assert.equal(boxWidth(60), 60);
	assert.equal(boxWidth(6), 10);
});

test("選択した会話が見える位置まで offset を寄せる", () => {
	assert.equal(revealOffset({ start: 30, end: 40 }, 0, 24), 17);
	assert.equal(revealOffset({ start: 0, end: 5 }, 10, 24), 0);
	assert.equal(revealOffset({ start: 20, end: 23 }, 0, 24), 0);
	assert.equal(revealOffset({ start: 0, end: 29 }, 0, 24), 0);
	assert.equal(revealOffset(undefined, 7, 24), 7);
});

test("窓より高い会話は移動方向の端に寄せる", () => {
	assert.equal(revealOffset({ start: 10, end: 49 }, 0, 24), 10);
	assert.equal(revealOffset({ start: 10, end: 49 }, 0, 24, -1), 26);
});

test("窓より高い会話の中をずらして下端まで見せる", () => {
	const range = { start: 10, end: 49 };
	assert.equal(scrollWithin(range, 10, 24, 1), 26);
	assert.equal(scrollWithin(range, 26, 24, 1), 26);
	assert.equal(scrollWithin({ start: 10, end: 79 }, 10, 24, 1), 33);
	assert.equal(scrollWithin({ start: 10, end: 79 }, 33, 24, -1), 10);
});

test("窓に収まる会話では中のスクロールをしない", () => {
	assert.equal(scrollWithin({ start: 10, end: 15 }, 3, 24, 1), 3);
	assert.equal(scrollWithin(undefined, 3, 24, 1), 3);
});

test("ページ送りは画面外に出る最初の会話を選ぶ", () => {
	const ranges = [
		{ start: 0, end: 4 },
		{ start: 6, end: 10 },
		{ start: 12, end: 16 },
		{ start: 18, end: 22 },
		{ start: 24, end: 28 },
	];
	assert.equal(pageTarget(ranges, 0, 17, 1), 3);
	assert.equal(pageTarget(ranges, 0, 10, 1), 2);
	assert.equal(pageTarget(ranges, 25, 10, 1), 4);
});

test("戻るページ送りは画面より上で最後の会話を選ぶ", () => {
	const ranges = [
		{ start: 0, end: 4 },
		{ start: 6, end: 10 },
		{ start: 12, end: 16 },
	];
	assert.equal(pageTarget(ranges, 12, 10, -1), 1);
	assert.equal(pageTarget(ranges, 0, 10, -1), 0);
});

test("表示は本文・要約・作業を個別に切り替え、最後の 1 種は消せない", () => {
	const all = { text: true, summary: true, work: true };
	assert.deepEqual(toggleShow(all, "text"), { text: false, summary: true, work: true });
	assert.deepEqual(toggleShow(toggleShow(all, "summary"), "summary"), all);
	const only = { text: false, summary: true, work: false };
	assert.deepEqual(toggleShow(only, "summary"), only);
	assert.deepEqual(toggleShow(only, "work"), { text: false, summary: true, work: true });
});

test("モード遷移は表の範囲だけ", () => {
	assert.equal(canMove("rallies", "min"), true);
	assert.equal(canMove("min", "rallies"), true);
	assert.equal(modeForKey("m"), "min");
	assert.equal(modeForKey("s"), "rallies");
	assert.equal(modeForKey("l"), undefined);
	assert.equal(modeForKey("x"), undefined);
});
