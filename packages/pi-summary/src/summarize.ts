import type { Turn } from "./turns.ts";

export type Rally = { user: string[]; assistant: string[] };

/** user の発話から次の user までを 1 ラリーとする。 */
export const groupRallies = (turns: Turn[]): Rally[] => {
	const rallies: Rally[] = [];
	for (const turn of turns) {
		const last = rallies.at(-1);
		if (turn.role === "user" || !last) rallies.push({ user: turn.role === "user" ? [turn.text] : [], assistant: turn.role === "assistant" ? [turn.text] : [] });
		else last.assistant.push(turn.text);
	}
	return rallies;
};

const serialize = (turns: Turn[]): string =>
	turns.map((t, i) => `[${i + 1}] ${t.role === "user" ? "ユーザー" : "AI"}:\n${t.text}`).join("\n\n");

const SYSTEM_PROMPT =
	"あなたは会話ログの要約器です。与えられたログだけを根拠にする。推測や評価を足さない。出力は日本語の Markdown のみ。";

/** セッション全体の要約。 */
export const buildMinPrompt = (turns: Turn[]): { systemPrompt: string; user: string } => {
	const count = groupRallies(turns).length;
	const instruction = [
		`以下のログは ${count} 個の会話ラリーです。`,
		"全体を 10〜20 行の日本語 Markdown に要約してください。",
		"- 見出しは「目的」「決まったこと」「未解決」「次にやること」の 4 つだけ。",
		"- 「次にやること」は実行できる 1 行の行動として書く。",
		"- 決定と未解決点を優先し、経過の説明は書かない。",
	];
	return { systemPrompt: SYSTEM_PROMPT, user: `${instruction.join("\n")}\n\n<log>\n${serialize(turns)}\n</log>` };
};

/** 1 つの発話の要約。箇条書きだけを返させる。 */
export const buildCommentPrompt = (text: string): { systemPrompt: string; user: string } => ({
	systemPrompt: SYSTEM_PROMPT,
	user: [
		"以下の 1 つの発話を要約してください。",
		"- 箇条書きだけを 1〜4 行で書く。各行は `- ` で始める。",
		"- 見出し、前置き、結びは書かない。",
		"- 決定、指示、結論、ファイルパス、数値は残す。",
		"",
		"<text>",
		text,
		"</text>",
	].join("\n"),
});
