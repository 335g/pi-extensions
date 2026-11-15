/** 表示する本文の最大行数。端末の 60% に収める。 */
export const panelRows = (terminalRows: number): number => Math.max(3, Math.floor(terminalRows * 0.6));

/** offset を範囲内に丸め、見える行だけを返す。 */
export const sliceWindow = (lines: string[], offset: number, rows: number): { lines: string[]; offset: number } => {
	const view = Math.max(1, Math.min(rows, lines.length));
	const start = Math.max(0, Math.min(offset, lines.length - view));
	return { lines: lines.slice(start, start + view), offset: start };
};

/** 吹き出しの幅。広い端末でも読みやすい幅に抑える。 */
export const boxWidth = (width: number): number => Math.max(10, Math.min(width, 76));

export type Range = { start: number; end: number };

/** 選択中の会話が全部見えるように offset を寄せる。 */
export const revealOffset = (range: Range | undefined, offset: number, rows: number): number => {
	if (!range) return offset;
	if (range.end - range.start + 1 > rows || range.start < offset) return Math.max(0, range.start);
	if (range.end >= offset + rows) return Math.max(0, range.end - rows + 1);
	return offset;
};

/** ページ送り先の会話 index。dir=1 は下（画面外に出る最初）、-1 は上（画面より上で最後）。 */
export const pageTarget = (ranges: Range[], offset: number, rows: number, dir: 1 | -1): number => {
	if (ranges.length === 0) return -1;
	if (dir === 1) {
		const first = ranges.findIndex((r) => r.start >= offset + rows);
		return first === -1 ? ranges.length - 1 : first;
	}
	return Math.max(0, ranges.findLastIndex((r) => r.end < offset));
};
