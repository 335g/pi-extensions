import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Range, boxWidth } from "./panel.ts";

export type Role = "user" | "assistant" | "neutral";
export type Card = { role: Role; label: string; text: string; entryId?: string; summary?: string; work?: string; coverage?: "adopted" | "deferred" | "dropped" };
export type Rendered = { lines: string[]; ranges: Range[] };
export type Content = {
	render(width: number, selected: number): Rendered;
	textAt(index: number): string;
	idAt(index: number): string | undefined;
};
type Theme = { fg(key: string, text: string): string; bg(key: string, text: string): string };

/** 非選択は全役割で同じ背景。役割は左右の位置とラベルで見分ける。 */
const CARD_BG = "customMessageBg";

const pad = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

const box = (card: Card, width: number, theme: Theme, selected: boolean): string[] => {
	const inner = Math.max(1, width - 4);
	const edge = (text: string): string => theme.fg(selected ? "accent" : "border", text);
	const bg = (text: string): string => theme.bg(selected ? "selectedBg" : CARD_BG, text);
	const mark = card.coverage ? theme.fg(card.coverage === "dropped" ? "dim" : "accent", { adopted: "■", deferred: "◐", dropped: "□" }[card.coverage]) + " " : "";
	const label = ` ${mark}${selected ? "▶ " : ""}${card.label} `;
	const fill = Math.max(0, width - 3 - visibleWidth(label));
	const body = new Markdown(card.text, 0, 0, getMarkdownTheme()).render(inner);
	// 選択中は太枠。反転だと強すぎ、selectedBg だけだと弱いので枠で差を付ける。
	const [tl, h, tr, v, bl, br] = selected ? ["┏", "━", "┓", "┃", "┗", "┛"] : ["┌", "─", "┐", "│", "└", "┘"];
	const content = (line: string): string => `${edge(v)} ${pad(truncateToWidth(line, inner), inner)} ${edge(v)}`;
	const rows = [edge(`${tl}${h}${label}${h.repeat(fill)}${tr}`), ...body.map(content)];
	// 要約は同じ枠の内側に区切り線を挟んで並べる。
	for (const [name, text] of [
		["要約", card.summary],
		["作業", card.work],
	] as const) {
		if (!text) continue;
		const title = ` ${name} `;
		const rest = Math.max(0, width - 3 - visibleWidth(title));
		rows.push(edge(`├${h}${title}${h.repeat(rest)}┤`));
		for (const line of new Markdown(text, 0, 0, getMarkdownTheme()).render(inner)) rows.push(content(line));
	}
	rows.push(edge(`${bl}${h.repeat(Math.max(0, width - 2))}${br}`));
	return rows.map(bg);
};

export const cardsContent = (cards: Card[], theme: Theme): Content => ({
	textAt(index: number): string {
		return cards[index]?.text ?? "";
	},

	idAt(index: number): string | undefined {
		return cards[index]?.entryId;
	},

	render(width: number, selected: number): Rendered {
		const lines: string[] = [];
		const ranges: Range[] = [];
		cards.forEach((card, index) => {
			if (lines.length) lines.push("");
			const w = card.role === "neutral" ? width : boxWidth(width);
			const left = card.role === "user" ? " ".repeat(Math.max(0, width - w)) : "";
			const right = card.role === "user" ? "" : " ".repeat(Math.max(0, width - w));
			const start = lines.length;
			for (const row of box(card, w, theme, index === selected)) lines.push(left + row + right);
			ranges.push({ start, end: lines.length - 1 });
		});
		return { lines, ranges };
	},
});
