/** 要約をセッションに残すときの customType。 */
export const STORE = "pi-summary";

export type Saved = { entryId: string; summary?: string; work?: string };

/** entryId → 要約テキスト。会話はセッションを跨いでも id が変わらない。 */
export type Store = { summaries: Map<string, string>; works: Map<string, string> };

type Entry = { type: string; customType?: string; data?: unknown };

/** ブランチ上の保存を古い順に畳み込む。同じ entryId は後の保存が勝つ。 */
export const readStore = (entries: readonly Entry[]): Store => {
	const store: Store = { summaries: new Map(), works: new Map() };
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STORE) continue;
		const saved = entry.data as Saved | undefined;
		if (!saved?.entryId) continue;
		if (saved.summary) store.summaries.set(saved.entryId, saved.summary);
		if (saved.work) store.works.set(saved.entryId, saved.work);
	}
	return store;
};
