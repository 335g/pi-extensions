export type Turn = { role: "user" | "assistant"; text: string; id?: string };

type ContentBlock = { type?: string; text?: string };
type Entry = { id?: string; type?: string; message?: { role?: string; content?: unknown } };

/** text ブロックだけを連結する。 */
export const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as ContentBlock[]) {
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
};

/** user/assistant の発話だけを残す。tool call・tool result・system は落とす。 */
export const extractTurns = (entries: unknown[]): Turn[] => {
	const turns: Turn[] = [];
	for (const entry of entries as Entry[]) {
		if (entry?.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(entry.message?.content).trim();
		if (text) turns.push(entry.id ? { role, text, id: entry.id } : { role, text });
	}
	return turns;
};

export const formatTurns = (turns: Turn[]): string =>
	turns
		.map((turn, index) => `### ${index + 1}. ${turn.role === "user" ? "ユーザー" : "AI"}\n\n${turn.text}`)
		.join("\n\n");
