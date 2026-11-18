import assert from "node:assert/strict";
import { test } from "node:test";
import { bar, elapsed, fmtDuration, glyph, lines, merge, progress, totalActive } from "../src/timeline.ts";

test("merge keeps ids, drops duplicates and empty entries", () => {
	const tasks = merge(
		[],
		[
			{ id: "1", title: "plan", status: "done" },
			{ id: "1", title: "duplicate" },
			{ id: "", title: "no id" },
			{ id: "2", title: "  " },
		],
		1000,
	);
	assert.deepEqual(
		tasks.map((t) => t.id),
		["1"],
	);
	assert.equal(tasks[0].status, "done");
});

test("merge stamps times only when a task starts or finishes", () => {
	const first = merge([], [{ id: "1", title: "plan", status: "active" }], 1000);
	assert.equal(first[0].startedAt, 1000);
	assert.equal(first[0].endedAt, undefined);

	const second = merge(first, [{ id: "1", title: "plan", status: "done" }], 5000);
	assert.equal(second[0].startedAt, 1000, "startedAt survives an update");
	assert.equal(second[0].endedAt, 5000);

	const third = merge(second, [{ id: "1", title: "plan", status: "done" }], 9000);
	assert.equal(third[0].endedAt, 5000, "endedAt is not re-stamped");
	assert.equal(elapsed(third[0], 9000), 4000);
});

test("merge stops the clock when a running task is blocked", () => {
	const running = merge([], [{ id: "1", title: "plan", status: "active" }], 1000);
	const blocked = merge(running, [{ id: "1", title: "plan", status: "blocked" }], 5000);
	assert.equal(blocked[0].startedAt, undefined);
	assert.equal(elapsed(blocked[0], 9000), undefined);
	assert.equal(totalActive(blocked, 9000), 0);
});

test("merge drops a parent that is missing and keeps a cycle visible", () => {
	const orphan = merge([], [{ id: "a", title: "child", parent: "gone" }], 0);
	assert.equal(orphan[0].parent, undefined);

	const cycle = merge([], [
		{ id: "a", title: "a", parent: "b" },
		{ id: "b", title: "b", parent: "a" },
	], 0);
	assert.deepEqual(
		lines(cycle, 0).map((l) => l.id),
		["a", "b"],
	);
});

test("merge appends new ids and keeps tasks not mentioned", () => {
	const first = merge([], [
		{ id: "1", title: "a", status: "done" },
		{ id: "2", title: "b", status: "active" },
	], 0);
	const second = merge(first, [{ id: "3", title: "c" }], 5000);
	assert.deepEqual(
		second.map((t) => t.id),
		["1", "2", "3"],
	);
	assert.equal(second[0].status, "done");
	assert.equal(second[1].status, "active");
	assert.equal(second[2].status, "pending");

	const third = merge(second, [{ id: "2", title: "b", status: "done" }], 9000);
	assert.deepEqual(
		third.map((t) => t.id),
		["1", "2", "3"],
	);
	assert.equal(third[1].status, "done");
	assert.equal(third[1].startedAt, 0, "update keeps the original start");
	assert.equal(third[1].endedAt, 9000);
});

test("merge keeps a new task's parent that was not re-sent", () => {
	const first = merge([], [{ id: "1", title: "root" }], 0);
	const second = merge(first, [{ id: "2", title: "child", parent: "1" }], 0);
	assert.equal(second[1].parent, "1");
});

test("merge carries a result across updates", () => {
	const done = merge([], [{ id: "1", title: "a", status: "done", result: "fixed" }], 0);
	assert.equal(done[0].result, "fixed");

	const updated = merge(done, [{ id: "1", title: "a", status: "done" }], 1000);
	assert.equal(updated[0].result, "fixed", "result survives an update without re-sending it");
});

test("lines puts children under their parent, depth first", () => {
	const tasks = merge([], [
		{ id: "1", title: "root" },
		{ id: "1.1", title: "child", parent: "1" },
		{ id: "1.1.1", title: "grandchild", parent: "1.1" },
		{ id: "2", title: "other" },
	], 0);
	assert.deepEqual(
		lines(tasks, 0).map((l) => [l.id, l.depth]),
		[
			["1", 0],
			["1.1", 1],
			["1.1.1", 2],
			["2", 0],
		],
	);
});

test("progress, bar and durations", () => {
	const tasks = merge([], [
		{ id: "1", title: "a", status: "done" },
		{ id: "2", title: "b", status: "active" },
		{ id: "3", title: "c" },
		{ id: "4", title: "d", status: "blocked" },
	], 0);
	assert.deepEqual(progress(tasks), { done: 1, total: 4 });
	assert.equal(bar(1, 4, 8), "██░░░░░░");
	assert.equal(bar(0, 0, 4), "░░░░");
	assert.equal(bar(4, 4, 4), "████");

	assert.equal(fmtDuration(0), "0s");
	assert.equal(fmtDuration(59_400), "59s");
	assert.equal(fmtDuration(125_000), "2m05s");
	assert.equal(fmtDuration(3_930_000), "1h05m");
});

test("totalActive adds only tasks that started", () => {
	const started = merge([], [
		{ id: "1", title: "a", status: "active" },
		{ id: "2", title: "b" },
	], 0);
	const done = merge(started, [{ id: "1", title: "a", status: "done" }], 10_000);
	assert.equal(elapsed(done[0], 20_000), 10_000);
	assert.equal(totalActive(done, 20_000), 10_000, "pending tasks contribute nothing");
});

test("glyph is distinct per status", () => {
	const seen = new Set(["pending", "active", "done", "blocked"].map((s) => glyph(s as never)));
	assert.equal(seen.size, 4);
});
