import { textOf } from "./turns.ts";

/** 1 回のツール呼び出しと、その結果。 */
export type WorkItem = { tool: string; args: string; result: string; isError: boolean };

type Entry = { id?: string; type?: string; message?: { role?: string; content?: unknown } };
type CallBlock = { type?: string; id?: string; name?: string; arguments?: unknown };

const LIMIT = 300;
const cut = (text: string) => (text.length > LIMIT ? `${text.slice(0, LIMIT)}…` : text);

/**
 * 発話の直後（開始の次から、終了の id があればそこまで）に AI が実行したツール呼び出しを、結果と対にして返す。
 * 開始の id が見つからないときは空を返す。
 */
export const extractWorkBetween = (entries: unknown[], startId: string, endId?: string): WorkItem[] => {
	const list = entries as Entry[];
	const from = list.findIndex((entry) => entry?.id === startId);
	if (from < 0) return [];
	const found = endId === undefined ? -1 : list.findIndex((entry) => entry?.id === endId);
	if (found === from) return [];
	const to = found < 0 ? list.length - 1 : found;
	const [start, first] = from < to ? [from, to] : [to, from];
	// 終了コメント自身のツール呼び出しも範囲内。その結果（直後の toolResult）まで含める。
	let end = first;
	while (list[end + 1]?.message?.role === "toolResult") end++;

	const items: WorkItem[] = [];
	const byId = new Map<string, WorkItem>();
	for (const entry of list.slice(start + 1, end + 1)) {
		if (entry?.type !== "message" || !Array.isArray(entry.message?.content)) continue;
		const blocks = entry.message.content as CallBlock[];
		if (entry.message.role === "assistant") {
			for (const block of blocks) {
				if (block?.type !== "toolCall") continue;
				const item: WorkItem = {
					tool: String(block.name ?? "?"),
					args: cut(JSON.stringify(block.arguments ?? {})),
					result: "",
					isError: false,
				};
				items.push(item);
				if (block.id) byId.set(block.id, item);
			}
		} else if (entry.message.role === "toolResult") {
			const meta = entry.message as unknown as { toolCallId?: string; isError?: boolean };
			const item = meta.toolCallId ? byId.get(meta.toolCallId) : undefined;
			if (!item) continue;
			item.result = cut(textOf(entry.message.content).trim());
			item.isError = Boolean(meta.isError);
		}
	}
	return items;
};

export const buildWorkPrompt = (items: WorkItem[]): { systemPrompt: string; user: string } => ({
	systemPrompt:
		"あなたは作業ログの要約器です。与えられたツール呼び出しのログだけを根拠にする。ログに無いことは書かない。出力は日本語の Markdown のみ。",
	user: [
		"以下は AI が実行したツール呼び出しと結果のログです。",
		"AI が実際に何をしたかを要約してください。",
		"- 箇条書きだけを 2〜6 行で書く。各行は `- ` で始める。",
		"- 見出し、前置き、結びは書かない。",
		"- ファイルパス、コマンド、数値、エラーは具体的に書く。",
		"- 推測や評価を足さない。作業ログの要約に徹する。",
		"",
		"<log>",
		...items.map((item, index) => `[${index + 1}] ${item.tool} ${item.args}\n→ ${item.result || "(結果なし)"}${item.isError ? " [エラー]" : ""}`),
		"</log>",
	].join("\n"),
});
