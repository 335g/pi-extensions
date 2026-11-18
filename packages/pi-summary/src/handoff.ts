import { groupRallies, SYSTEM_PROMPT, type Rally } from "./summarize.ts";
import type { DeferredItem } from "./store.ts";
import type { Turn } from "./turns.ts";

export const HANDOFF_SECTIONS = ["状況", "決まったこと", "未解決", "次にやること", "注意"] as const;

export type Coverage = Map<number, "adopted" | "deferred" | "dropped">;

export type Handoff = { text: string; deferred: DeferredItem[]; coverage: Coverage; rallyCount: number };

/** ラリーを番号付きで直列化する。出典に使う番号と揃える。 */
const serializeOne = (rally: Rally, number: number): string => {
	const lines = [`[ラリー${number}]`, "ユーザー:", rally.user.join("\n")];
	if (rally.assistant.length) lines.push("AI:", rally.assistant.join("\n"));
	return lines.join("\n");
};

export const serializeRallies = (turns: Turn[]): string =>
	groupRallies(turns).map((rally, index) => serializeOne(rally, index + 1)).join("\n\n");

/** 番号を start（1 始まり）から振って直列化する。増分更新の新ラリー用。 */
export const serializeRalliesFrom = (turns: Turn[], start: number): string =>
	groupRallies(turns)
		.slice(start - 1)
		.map((rally, index) => serializeOne(rally, start + index))
		.join("\n\n");

/** 保留リストを既存フォーマット（「- ラリーN | 要約: ... | 理由: ...」）で直列化する。 */
export const serializeDeferred = (items: DeferredItem[]): string =>
	items.length
		? items.map((item) => `- ラリー${item.sources.join(",")} | 要約: ${item.summary} | 理由: ${item.reason}`).join("\n")
		: "- なし";

/** 引き継ぎ書 + 保留リストを 1 回で生成するプロンプト。 */
export const buildHandoffPrompt = (turns: Turn[]): { systemPrompt: string; user: string } => {
	const count = groupRallies(turns).length;
	const instruction = [
		`以下は ${count} 個の会話ラリーです。新規セッションに引き継ぐ資料を作ってください。`,
		"",
		"出力は次の形に厳密に従ってください。",
		"",
		"1. 引き継ぎ書（Markdown）。見出しは「状況」「決まったこと」「未解決」「次にやること」「注意」の 5 つだけ。",
		"   各項目の末尾に「（出典: ラリーN）」の形で元のラリー番号を必ず付ける。該当がない節は書かない。",
		"2. その後、「## 保留」という見出しを置き、引き継ぎ書に入れなかったが重要かもしれない事項を列挙する。",
		"   各行は「- ラリーN | 要約: ... | 理由: ...」の形。理由は省いた理由を書く。無ければ「- なし」とだけ書く。",
		"",
		"判断基準:",
		"- 引き継ぎ書には、新しいセッションが作業を再開するために必要なことだけを入れる。",
		"- 保留には、重要かもしれないが引き継ぎ書から省いたものを入れ、省いた理由を必ず明記する。",
		"- 全ラリーに目を通して漏れなく評価する。推測や評価を足さない。",
	];
	return { systemPrompt: SYSTEM_PROMPT, user: `${instruction.join("\n")}\n\n<log>\n${serializeRallies(turns)}\n</log>` };
};

/** 既存の引き継ぎ書 + 保留リストに新しいラリーだけを統合して完成形を返させる増分更新プロンプト。 */
export const buildHandoffUpdatePrompt = (
	current: { text: string; deferred: DeferredItem[] },
	processedRallies: number,
	turns: Turn[],
): { systemPrompt: string; user: string } => {
	const instruction = [
		"既存の引き継ぎ書に新しい会話ラリーを統合し、完成形を出力してください。",
		"",
		"出力は次の形に厳密に従ってください。",
		"",
		"1. 統合後の引き継ぎ書（Markdown）。見出しは「状況」「決まったこと」「未解決」「次にやること」「注意」の 5 つだけ。",
		"   各項目の末尾に「（出典: ラリーN）」の形で元のラリー番号を必ず付ける。該当がない節は書かない。",
		"   新しいラリーで覆った古い記述は更新または削除し、同じ内容を重複させない。",
		"2. その後、「## 保留」という見出しを置き、統合後の保留リストを列挙する。",
		"   各行は「- ラリーN | 要約: ... | 理由: ...」の形。理由は省いた理由を書く。無ければ「- なし」とだけ書く。",
		"",
		"判断基準:",
		"- 引き継ぎ書には、新しいセッションが作業を再開するために必要なことだけを入れる。",
		"- 保留には、重要かもしれないが引き継ぎ書から省いたものを入れ、省いた理由を必ず明記する。",
		"- 新しいラリーを漏れなく評価し、既存の記述と矛盾・重複するものは統合する。推測や評価を足さない。",
	];
	return {
		systemPrompt: SYSTEM_PROMPT,
		user: [
			instruction.join("\n"),
			"",
			"<handoff>",
			current.text,
			"</handoff>",
			"",
			"<deferred>",
			serializeDeferred(current.deferred),
			"</deferred>",
			"",
			"<new>",
			serializeRalliesFrom(turns, processedRallies + 1),
			"</new>",
		].join("\n"),
	};
};

const SOURCE_RE = /（出典:\s*ラリー\s*([\d,、\s]+)）/g;

/** 「（出典: ラリー1,2）」の形からラリー番号を取り出す。 */
export const parseSources = (text: string): number[] =>
	[...text.matchAll(SOURCE_RE)]
		.flatMap((m) => m[1].split(/[,、\s]+/).filter(Boolean).map(Number))
		.filter((n) => Number.isInteger(n) && n > 0);

/** コピー前に出典マーカーを除去する。 */
export const stripSources = (text: string): string => text.replace(SOURCE_RE, "").replace(/[ \t]+$/gm, "").trim();

/** 引き継ぎ書に引用されたラリー → adopted、保留リスト → deferred、それ以外 → dropped。 */
export const computeCoverage = (rallyCount: number, handoffText: string, deferred: DeferredItem[]): Coverage => {
	const coverage: Coverage = new Map();
	for (let i = 1; i <= rallyCount; i++) coverage.set(i, "dropped");
	for (const n of parseSources(handoffText)) coverage.set(n, "adopted");
	for (const item of deferred) for (const n of item.sources) if (coverage.get(n) !== "adopted") coverage.set(n, "deferred");
	return coverage;
};

/** 生成結果を「引き継ぎ書 + ## 保留」で分割し、coverage まで計算する。 */
export const parseHandoff = (raw: string, rallyCount: number): Handoff => {
	const [handoffPart, ...rest] = raw.split(/^##\s*保留\s*$/m);
	const text = (handoffPart ?? "").trim();
	const deferred = parseDeferred(rest.join(""));
	return { text, deferred, coverage: computeCoverage(rallyCount, text, deferred), rallyCount };
};

const parseDeferred = (block: string): DeferredItem[] => {
	const items: DeferredItem[] = [];
	for (const line of block.split("\n")) {
		const m = line.trim().match(/^-\s*ラリー\s*([\d,、\s]+)\s*\|\s*要約:\s*(.*?)\s*\|\s*理由:\s*(.*)$/);
		if (!m) continue;
		const sources = m[1].split(/[,、\s]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
		const summary = m[2].trim();
		const reason = m[3].trim();
		if (summary && sources.length) items.push({ summary, reason, sources });
	}
	return items;
};

/** 採用時に、保留項目を引き継ぎ書向けの箇条書きへ再要約するプロンプト。 */
export const buildAdoptPrompt = (item: DeferredItem, turns: Turn[]): { systemPrompt: string; user: string } => {
	const rallies = groupRallies(turns);
	const parts = item.sources
		.map((n) => {
			const rally = rallies[n - 1];
			if (!rally) return "";
			const lines = [`[ラリー${n}]`, "ユーザー:", rally.user.join("\n")];
			if (rally.assistant.length) lines.push("AI:", rally.assistant.join("\n"));
			return lines.join("\n");
		})
		.filter(Boolean);
	const instruction = [
		"以下は採用する保留項目の元になった会話ラリーです。",
		"引き継ぎ書に追記する 1〜2 行の箇条書きに要約してください。",
		"",
		"出力は次の 2 行だけを返してください。",
		"節: <状況|決まったこと|未解決|次にやること|注意>",
		"文: - 箇条書きの本文",
		"",
		`元の保留項目の要約: ${item.summary}`,
	];
	return { systemPrompt: SYSTEM_PROMPT, user: `${instruction.join("\n")}\n\n<log>\n${parts.join("\n\n")}\n</log>` };
};

/** 採用結果の「節:」「文:」2 行を読み取る。読めなければ注意節 + 元の要約に倒す。 */
export const parseAdopt = (raw: string, fallback: string): { section: string; bullet: string } => {
	const section = raw.match(/^節:\s*(\S+)/m)?.[1]?.trim() ?? "";
	const bullet = raw.match(/^文:\s*(.+)$/m)?.[1]?.trim() ?? "";
	const clean = bullet.startsWith("-") ? bullet : `- ${bullet}`;
	return {
		section: (HANDOFF_SECTIONS as readonly string[]).includes(section) ? section : "注意",
		bullet: bullet ? clean : `- ${fallback}`,
	};
};

/** 指定した節の末尾に箇条書きを足す。節が無ければ末尾に節ごと追加する。 */
export const insertBullet = (text: string, section: string, bullet: string): string => {
	const heading = `## ${section}`;
	const idx = text.indexOf(heading);
	const clean = bullet.trim().replace(/^-+\s*/, "- ");
	if (idx === -1) return `${text.trim()}\n\n${heading}\n${clean}`.trim();
	const afterHeading = text.slice(idx + heading.length);
	const next = afterHeading.search(/\n## /);
	const insertAt = next === -1 ? text.length : idx + heading.length + next;
	return `${text.slice(0, insertAt).replace(/\n+$/, "")}\n${clean}${text.slice(insertAt)}`;
};

/** 新規セッションの冒頭に貼る引き継ぎプロンプト。 */
export const buildHandoffText = (text: string): string =>
	`以下は前のセッションからの引き継ぎです。これを踏まえて作業を再開してください。\n\n${text.trim()}\n`;
