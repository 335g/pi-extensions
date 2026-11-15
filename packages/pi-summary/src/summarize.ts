import type { Turn } from "./turns.ts";

export type SummaryLevel = "low" | "min";

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

export const buildPrompt = (level: SummaryLevel, turns: Turn[]): { systemPrompt: string; user: string } => {
	const count = groupRallies(turns).length;
	const instruction =
		level === "low"
			? [
					`以下のログは ${count} 個の会話ラリー（ユーザーの発話とそれへの AI の応答）です。`,
					"各ラリーを 2〜3 行に縮めてください。",
					"- 見出しは `### <番号>. <ラリーの主題を 20 文字以内>`。",
					"- 本文は「ユーザー: …」「AI: …」の 2 行まで。",
					"- 決定、指示、結論、ファイルパス、数値は残す。前置きと作業ログは捨てる。",
					"- 全ラリーを元の順序で、1 つも飛ばさず出力する。",
				]
			: [
					`以下のログは ${count} 個の会話ラリーです。`,
					"全体を 10〜20 行の日本語 Markdown に要約してください。",
					"- 見出しは「目的」「決まったこと」「未解決」「次にやること」の 4 つだけ。",
					"- 「次にやること」は実行できる 1 行の行動として書く。",
					"- 決定と未解決点を優先し、経過の説明は書かない。",
				];

	return {
		systemPrompt: SYSTEM_PROMPT,
		user: `${instruction.join("\n")}\n\n<log>\n${serialize(turns)}\n</log>`,
	};
};

export type RoleLine = { topic: string; role: "user" | "assistant"; text: string };

/**
 * `/summary-low` の出力（`### 見出し` と「ユーザー: 」「AI: 」行）を role 付きに読む。
 * 想定外の行は直前の発話に足す。role 行が 1 つも無ければ空を返す。
 */
export const parseLowSummary = (markdown: string): RoleLine[] => {
	const lines: RoleLine[] = [];
	let topic = "";
	for (const raw of markdown.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = line.match(/^#{1,6}\s*(.*)$/);
		if (heading) {
			topic = heading[1].replace(/^\d+[.、]\s*/, "");
			continue;
		}
		const role = line.match(/^(ユーザー|AI)[:：]\s*(.*)$/);
		if (role) {
			lines.push({ topic, role: role[1] === "AI" ? "assistant" : "user", text: role[2] });
			continue;
		}
		const last = lines.at(-1);
		if (last) last.text = `${last.text}\n${line}`;
	}
	return lines;
};
