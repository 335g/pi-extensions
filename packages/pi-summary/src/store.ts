/** 要約をセッションに残すときの customType。 */
export const STORE = "pi-summary";

/** 引き継ぎ書・保留リストを保存するときの固定 entryId。 */
export const HANDOFF_ID = "__handoff__";

/** セッション全体の要約（`m`）を保存するときの固定 entryId。 */
export const MIN_ID = "__min__";

/** 保留リストの 1 項目。sources は 1 始まりのラリー番号。 */
export type DeferredItem = { summary: string; reason: string; sources: number[] };

export type Saved = {
	entryId: string;
	summary?: string;
	work?: string;
	/** 引き継ぎ書の本文（セッションに 1 つ）。 */
	handoff?: string;
	/** 保留リスト（セッションに 1 つ）。 */
	deferred?: DeferredItem[];
	/** `handoff` に取り込み済みのラリー数。増分更新の基準。 */
	handoffRallies?: number;
	/** セッション全体の要約（`m`）。 */
	min?: string;
	/** `min` を生成した時点のラリー数。成長判定に使う。 */
	minRallies?: number;
};

/** entryId → 要約テキスト。会話はセッションを跨いでも id が変わらない。 */
export type Store = {
	summaries: Map<string, string>;
	works: Map<string, string>;
	handoff?: string;
	deferred: DeferredItem[];
	handoffRallies?: number;
	min?: string;
	minRallies?: number;
};

type Entry = { type: string; customType?: string; data?: unknown };

/** ブランチ上の保存を古い順に畳み込む。同じ entryId は後の保存が勝つ。 */
export const readStore = (entries: readonly Entry[]): Store => {
	const store: Store = { summaries: new Map(), works: new Map(), deferred: [] };
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STORE) continue;
		const saved = entry.data as Saved | undefined;
		if (!saved) continue;
		if (saved.entryId) {
			if (saved.summary) store.summaries.set(saved.entryId, saved.summary);
			if (saved.work) store.works.set(saved.entryId, saved.work);
		}
		if (saved.handoff) store.handoff = saved.handoff;
		if (saved.deferred) store.deferred = saved.deferred;
		if (typeof saved.handoffRallies === "number") store.handoffRallies = saved.handoffRallies;
		if (saved.min) store.min = saved.min;
		if (typeof saved.minRallies === "number") store.minRallies = saved.minRallies;
	}
	return store;
};
