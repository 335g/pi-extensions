import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Theme = { fg(key: string, text: string): string; bold(text: string): string };

/** `?` の一覧。1 行のヒントには入り切らないので、ここに全部書く。 */
const KEY_HELP: [string, string][] = [
	["j / k", "選択を上下（↑ / ↓ も同じ）"],
	["Ctrl-f / Ctrl-b", "ページ送り（PgDn / PgUp も同じ）"],
	["l", "選択コメントを要約して枠の内側に差し込む"],
	["L", "未要約のコメントをまとめて要約"],
	["i", "選択コメントの直後の作業を要約"],
	["I", "未要約の作業をまとめて要約"],
	["b / h / w", "本文 / 要約 / 作業の表示切替（最後の 1 つは消せない）"],
	["c", "選択コメントをコピー"],
	["t", "選択コメントから分岐（/tree と同じ）"],
	["m / s", "全体要約へ / 会話へ戻る"],
	["z", "全画面と下部パネルを切り替え"],
	["Enter / q / Esc", "閉じる"],
];

/** 一覧の枠の幅。横に伸びないよう 76 桁で頭打ちにし、狭い端末では縮める。 */
export const helpWidth = (columns: number | undefined): number => Math.max(24, Math.min(76, (columns ?? 80) - 4));

/** 枠付きの一覧。width は枠を含めた全体の幅。 */
export const helpLines = (theme: Theme, width: number): string[] => {
	const edge = (text: string): string => theme.fg("accent", text);
	const inner = width - 4;
	const content = (line: string): string =>
		`${edge("│")} ${line + " ".repeat(Math.max(0, inner - visibleWidth(line)))} ${edge("│")}`;
	const body = [
		theme.bold(" pi-summary キー一覧"),
		"",
		...KEY_HELP.map(([key, desc]) => ` ${theme.fg("accent", key.padEnd(15))}${desc}`),
		"",
		theme.fg("dim", " 何かキーを押すと戻る"),
	].map((line) => content(truncateToWidth(line, inner)));
	return [edge(`┌${"─".repeat(width - 2)}┐`), ...body, edge(`└${"─".repeat(width - 2)}┘`)];
};
