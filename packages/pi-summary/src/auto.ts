/**
 * 自動要約（`m`）と引き継ぎ書の増分更新の設定と発火判定。副作用の無い純粋関数だけを置き、extension から薄く呼ぶ。
 *
 * 設定は `.pi/pi-summary.json`:
 *   { "auto": { "enabled": true, "minRallies": 6, "growth": 3, "handoff": true } }
 */

export type AutoConfig = {
	enabled: boolean;
	/** 何ラリー以上で自動要約を始めるか。 */
	minRallies: number;
	/** 前回の要約から何ラリー増えたら再要約するか。 */
	growth: number;
	/** 引き継ぎ書も増分更新するか。 */
	handoff: boolean;
};

export const DEFAULT_AUTO: AutoConfig = { enabled: false, minRallies: 6, growth: 3, handoff: false };

const positiveInt = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

/** JSON 文字列から自動要約設定を読む。壊れていれば既定値（無効）。 */
export const parseAutoConfig = (raw: string): AutoConfig => {
	try {
		const parsed = JSON.parse(raw) as { auto?: { enabled?: unknown; minRallies?: unknown; growth?: unknown; handoff?: unknown } };
		const a = parsed?.auto;
		if (!a || typeof a !== "object") return { ...DEFAULT_AUTO };
		return {
			enabled: a.enabled === true,
			minRallies: positiveInt(a.minRallies, DEFAULT_AUTO.minRallies),
			growth: positiveInt(a.growth, DEFAULT_AUTO.growth),
			handoff: a.handoff === true,
		};
	} catch {
		return { ...DEFAULT_AUTO };
	}
};

/** 自動要約すべきか。無効・閾値未満・前回から成長不足なら false。 */
export const shouldRefreshMin = (store: { min?: string; minRallies?: number }, rallyCount: number, auto: AutoConfig): boolean => {
	if (!auto.enabled) return false;
	if (rallyCount < auto.minRallies) return false;
	if (store.min === undefined || store.minRallies === undefined) return true;
	return rallyCount - store.minRallies >= auto.growth;
};

/** 引き継ぎ書を増分更新すべきか。handoff 有効・閾値超え・未生成または成長分で発火。 */
export const shouldRefreshHandoff = (store: { handoff?: string; handoffRallies?: number }, rallyCount: number, auto: AutoConfig): boolean => {
	if (!auto.enabled || !auto.handoff) return false;
	if (rallyCount < auto.minRallies) return false;
	if (store.handoff === undefined || store.handoffRallies === undefined) return true;
	return rallyCount - store.handoffRallies >= auto.growth;
};
