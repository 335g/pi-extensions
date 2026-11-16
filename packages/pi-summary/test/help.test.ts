import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { helpLines, helpWidth } from "../src/help.ts";

const theme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };

test("ヘルプの枠幅は 76 桁で頭打ち、狭い端末では縮む", () => {
	assert.equal(helpWidth(200), 76);
	assert.equal(helpWidth(40), 36);
	assert.equal(helpWidth(20), 24);
	assert.equal(helpWidth(undefined), 76);
});

test("枠の各行は指定幅に揃い、上下が枠線で囲まれる", () => {
	const lines = helpLines(theme, 40);
	assert.equal(lines[0]?.startsWith("┌"), true);
	assert.equal(lines.at(-1)?.startsWith("└"), true);
	for (const line of lines) assert.equal(visibleWidth(line), 40);
});
