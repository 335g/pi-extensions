/** 表示する本文の最大行数。端末の 60% に収める。 */
export const panelRows = (terminalRows: number): number => Math.max(3, Math.floor(terminalRows * 0.6));

/** offset を範囲内に丸め、見える行だけを返す。 */
export const sliceWindow = (lines: string[], offset: number, rows: number): { lines: string[]; offset: number } => {
	const view = Math.max(1, Math.min(rows, lines.length));
	const start = Math.max(0, Math.min(offset, lines.length - view));
	return { lines: lines.slice(start, start + view), offset: start };
};
