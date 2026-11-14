import { textOf } from "./turns.ts";

/** 1 回のツール呼び出しと、その結果。 */
export type WorkItem = { tool: string; args: string; result: string; isError: boolean };

type Entry = { type?: string; message?: { role?: string; content?: unknown } };
type CallBlock = { type?: string; id?: string; name?: string; arguments?: unknown };

const LIMIT = 300;
const cut = (text: string) => (text.length > LIMIT ? `${text.slice(0, LIMIT)}…` : text);

/** 直前のユーザー発話以降に AI が実行したツール呼び出しだけを、結果と対にして返す。 */
export const extractLastWork = (entries: unknown[]): WorkItem[] => {
	const list = entries as Entry[];
	let start = 0;
	for (let i = list.length - 1; i >= 0; i--) {
		if (list[i]?.type === "message" && list[i].message?.role === "user") {
			start = i;
			break;
		}
	}

	const items: WorkItem[] = [];
	const byId = new Map<string, WorkItem>();
	for (const entry of list.slice(start)) {
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
		"以下は、直前のリクエストに対して AI が実行したツール呼び出しと結果のログです。",
		"AI が実際に何をしたかを 5〜15 行に要約してください。",
		"- 見出しは「やったこと」「触ったファイル」「結果」「注意点」の 4 つだけ。当てはまらない見出しは省く。",
		"- ファイルパス、コマンド、数値、エラーは具体的に書く。",
		"- 推測や評価を足さない。作業ログの要約に徹する。",
		"",
		"<log>",
		...items.map((item, index) => `[${index + 1}] ${item.tool} ${item.args}\n→ ${item.result || "(結果なし)"}${item.isError ? " [エラー]" : ""}`),
		"</log>",
	].join("\n"),
});
