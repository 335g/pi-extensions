/** DSH の公式 timeline 相当の最小モデル。ツール入力は毎回全置換で受け取り、時刻だけ引き継ぐ。 */

export type Status = "pending" | "active" | "done" | "blocked";

export const STATUSES: readonly Status[] = ["pending", "active", "done", "blocked"];

export interface Task {
	id: string;
	title: string;
	status: Status;
	parent?: string;
	note?: string;
	/** 完了時に残す結論。`/timeline` でタスクの後ろに表示する。 */
	result?: string;
	/** epoch ms。active になった時刻。 */
	startedAt?: number;
	/** epoch ms。done になった時刻。 */
	endedAt?: number;
}

export type TaskInput = { id: string; title: string; status?: Status; parent?: string; note?: string; result?: string };

export interface Line {
	id: string;
	depth: number;
	status: Status;
	title: string;
	duration?: string;
	note?: string;
	result?: string;
}

const GLYPHS: Record<Status, string> = { done: "✓", active: "▶", pending: "·", blocked: "!" };

export const glyph = (status: Status): string => GLYPHS[status];

/**
 * 入力を差分として扱う。同じ id は位置を保って更新し、新しい id は末尾に追加し、
 * 入力に現れない既存タスクは残す。時刻は同じ id の前回値から引き継ぎ、
 * active / done になった瞬間だけ刻む。空 id・空 title・重複 id は捨て、
 * 存在しない親は根に戻す。
 */
export function merge(prev: readonly Task[], input: readonly TaskInput[], now: number): Task[] {
	const byId = new Map<string, Task>();
	for (const t of prev) byId.set(t.id, t);
	const order: string[] = prev.map((t) => t.id);
	const tasks = new Map<string, Task>(byId);
	const seen = new Set<string>();
	for (const raw of input) {
		const id = String(raw?.id ?? "").trim();
		const title = String(raw?.title ?? "").trim();
		if (!id || !title || seen.has(id)) continue;
		seen.add(id);
		const status = raw.status && STATUSES.includes(raw.status) ? raw.status : "pending";
		const old = byId.get(id);
		const task: Task = { id, title, status };
		if (raw.parent && raw.parent !== id) task.parent = raw.parent;
		if (raw.note) task.note = raw.note;
		// 結論は完了時に付く。再送時に消えないよう前回値を引き継ぐ。
		const result = raw.result ?? old?.result;
		if (result) task.result = result;
		// active / done だけが時間を持つ。blocked や pending に戻したら計測を止める。
		const startedAt = status === "active" || status === "done" ? (old?.startedAt ?? now) : undefined;
		if (startedAt !== undefined) task.startedAt = startedAt;
		if (status === "done") task.endedAt = old?.endedAt ?? now;
		if (!byId.has(id)) order.push(id);
		tasks.set(id, task);
	}
	return order.map((id) => {
		const t = tasks.get(id)!;
		return t.parent && !tasks.has(t.parent) ? { ...t, parent: undefined } : t;
	});
}

export function progress(tasks: readonly Task[]): { done: number; total: number } {
	return { done: tasks.filter((t) => t.status === "done").length, total: tasks.length };
}

/** 進捗バー。塗りは丸めなので、ほぼ完了でも 1 マス残る。 */
export function bar(done: number, total: number, width = 10): string {
	const filled = total === 0 ? 0 : Math.min(width, Math.max(0, Math.round((done / total) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

export function fmtDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** active は現在まで、done は開始から終了まで。未開始は undefined。 */
export function elapsed(task: Task, now: number): number | undefined {
	if (task.startedAt === undefined) return undefined;
	return (task.endedAt ?? now) - task.startedAt;
}

/** 親→子の深さ優先。循環した親を持つタスクは根として並べ、描画から消えないようにする。 */
export function lines(tasks: readonly Task[], now: number): Line[] {
	const children = new Map<string | undefined, Task[]>();
	for (const t of tasks) {
		const siblings = children.get(t.parent) ?? [];
		siblings.push(t);
		children.set(t.parent, siblings);
	}
	const out: Line[] = [];
	const row = (t: Task, depth: number): Line => {
		const ms = elapsed(t, now);
		return {
			id: t.id,
			depth,
			status: t.status,
			title: t.title,
			duration: ms === undefined ? undefined : fmtDuration(ms),
			note: t.note,
			result: t.result,
		};
	};
	const visit = (parent: string | undefined, depth: number): void => {
		for (const t of children.get(parent) ?? []) {
			out.push(row(t, depth));
			if (depth < 5) visit(t.id, depth + 1);
		}
	};
	visit(undefined, 0);
	if (out.length < tasks.length) {
		const seen = new Set(out.map((l) => l.id));
		for (const t of tasks) if (!seen.has(t.id)) out.push(row(t, 0));
	}
	return out;
}

/** 開始から終了までの総作業時間（重なった active は合算しない）。 */
export function totalActive(tasks: readonly Task[], now: number): number {
	return tasks.reduce((sum, t) => sum + (elapsed(t, now) ?? 0), 0);
}
