import assert from "node:assert/strict";
import { test } from "node:test";
import { HANDOFF_ID, MIN_ID, readStore, type DeferredItem } from "../src/store.ts";

test("保存済みの要約と作業を entryId で引ける", () => {
	const store = readStore([
		{ type: "message" },
		{ type: "custom", customType: "pi-summary", data: { entryId: "a", summary: "要約A" } },
		{ type: "custom", customType: "pi-summary", data: { entryId: "a", work: "作業A" } },
		{ type: "custom", customType: "pi-summary", data: { entryId: "b", summary: "要約B" } },
	]);
	assert.equal(store.summaries.get("a"), "要約A");
	assert.equal(store.works.get("a"), "作業A");
	assert.equal(store.summaries.get("b"), "要約B");
	assert.equal(store.works.has("b"), false);
});

test("同じ entryId の後の保存が勝ち、他の customType は無視する", () => {
	const store = readStore([
		{ type: "custom", customType: "pi-summary", data: { entryId: "a", summary: "古い" } },
		{ type: "custom", customType: "pi-summary", data: { entryId: "a", summary: "新しい" } },
		{ type: "custom", customType: "pi-timeline", data: { entryId: "b", summary: "他人" } },
		{ type: "custom", customType: "pi-summary", data: {} },
		{ type: "custom", customType: "pi-summary" },
	]);
	assert.equal(store.summaries.get("a"), "新しい");
	assert.equal(store.summaries.has("b"), false);
	assert.equal(store.summaries.size, 1);
});

test("引き継ぎ書と保留リストをセッションから読む", () => {
	const deferred: DeferredItem[] = [{ summary: "s", reason: "r", sources: [3] }];
	const store = readStore([
		{ type: "custom", customType: "pi-summary", data: { entryId: HANDOFF_ID, handoff: "## 状況\n- a", deferred } },
		{ type: "custom", customType: "pi-summary", data: { entryId: "a", summary: "要約A" } },
	]);
	assert.equal(store.handoff, "## 状況\n- a");
	assert.deepEqual(store.deferred, deferred);
	assert.equal(store.summaries.get("a"), "要約A");
});

test("全体要約（min）とそのラリー数を読み戻す", () => {
	const store = readStore([
		{ type: "custom", customType: "pi-summary", data: { entryId: MIN_ID, min: "全体要約A", minRallies: 6 } },
		{ type: "custom", customType: "pi-summary", data: { entryId: MIN_ID, min: "全体要約B", minRallies: 9 } },
	]);
	assert.equal(store.min, "全体要約B");
	assert.equal(store.minRallies, 9);
});

test("後の保存の handoff が勝ち、保留リストが無ければ空", () => {
	const store = readStore([
		{ type: "custom", customType: "pi-summary", data: { entryId: HANDOFF_ID, handoff: "古い" } },
		{ type: "custom", customType: "pi-summary", data: { entryId: HANDOFF_ID, handoff: "新しい" } },
	]);
	assert.equal(store.handoff, "新しい");
	assert.deepEqual(store.deferred, []);
});
