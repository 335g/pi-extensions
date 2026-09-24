/**
 * session: reading a Pi session JSONL from the tail, under caps.
 *
 * A Pi session reaches megabytes, and everything this extension wants from one
 * is at its end: the newest model, the newest usage, the newest words. So the
 * file is never read whole — only its tail — and what is taken out of that tail
 * is bounded in lines and characters too.
 *
 * `readTail` is the one primitive, and it is shared: `review.ts` uses it for the
 * author's session, `fleet.ts` for every pane's. The extraction on top differs —
 * a review wants assistant prose, the fleet view wants model, usage, cost and
 * the last exchange — so only the reading is common.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

/**
 * Read at most `maxBytes` from the end of a file.
 *
 * The cut lands mid-line and possibly mid-character, so the partial first line
 * goes. A caller that needs to know whether anything was dropped compares the
 * file size itself, because that is a different question from what was read.
 */
export function readTail(path: string, maxBytes: number): string {
	if (statSync(path).size <= maxBytes) return readFileSync(path, "utf8");
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const read = readSync(fd, buffer, 0, maxBytes, statSync(path).size - maxBytes);
		const text = buffer.subarray(0, read).toString("utf8");
		// The cut lands mid-line and possibly mid-character; the partial line goes.
		const newline = text.indexOf("\n");
		return newline < 0 ? "" : text.slice(newline + 1);
	} finally {
		closeSync(fd);
	}
}

// ------------------------------------------------------- one pane's session

/**
 * The caps on one pane's session for the fleet view.
 *
 * Smaller than the review's, because this runs for every pane at once and the
 * fleet view only shows the last exchange. 2MB of tail and 2000 lines hold the
 * last few turns of any realistic session; the newest lines are what survives.
 */
export const SESSION_TAIL_BYTES = 2 * 1024 * 1024;
export const SESSION_MAX_LINES = 2_000;
/** A single user or assistant message is bounded too: one line can be 100kB. */
export const SESSION_TEXT_CHARS = 2_000;

export interface SessionSummary {
	/** The provider and model of the newest assistant message. */
	provider?: string;
	modelId?: string;
	/** Context tokens of the newest assistant usage, Pi's own formula. */
	contextTokens?: number;
	/** Sum of `usage.cost.total` over the assistant messages that were read. */
	cost: number;
	assistantMessages: number;
	/** The newest user text, and the newest assistant text that had any. */
	lastUser?: string;
	lastAssistant?: string;
	/** Tool calls in the newest assistant message, when it made any. */
	runningTool?: string;
	/** The cwd the session records, for a pane herdr reports no cwd for. */
	cwd?: string;
	/** True when the file or the line cap cut the read: cost is then a lower bound. */
	truncated: boolean;
}

/**
 * The tail of a Pi session, reduced to what the fleet view shows.
 *
 * `truncated` means cost is a lower bound: an assistant message older than the
 * tail was not summed. Context, the last exchange and the running tool are the
 * newest entries, so they survive the cut and stay exact. An unreadable file
 * throws, and the caller decides what to show for that pane.
 */
export function readSessionSummary(
	path: string,
	maxBytes = SESSION_TAIL_BYTES,
	maxLines = SESSION_MAX_LINES,
): SessionSummary {
	const oversized = statSync(path).size > maxBytes;
	const all = readTail(path, maxBytes)
		.split("\n")
		.filter((line) => line.trim() !== "");
	const lines = all.length > maxLines ? all.slice(all.length - maxLines) : all;

	const summary: SessionSummary = {
		cost: 0,
		assistantMessages: 0,
		truncated: oversized || all.length > maxLines,
	};

	for (const line of lines) {
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			// A session is appended to while it is read, so a partial last line is
			// normal. A malformed line elsewhere is not this reader's to report.
			continue;
		}
		if (entry?.type === "session" && typeof entry.cwd === "string") {
			summary.cwd = entry.cwd;
			continue;
		}
		if (entry?.type === "model_change" && typeof entry.provider === "string") {
			summary.provider = entry.provider;
			summary.modelId = typeof entry.modelId === "string" ? entry.modelId : undefined;
			continue;
		}
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "user") {
			const text = textParts(message.content);
			if (text !== "") summary.lastUser = text;
			continue;
		}
		if (message?.role !== "assistant") continue;

		summary.assistantMessages += 1;
		if (typeof message.provider === "string") summary.provider = message.provider;
		if (typeof message.model === "string") summary.modelId = message.model;
		if (message.usage && typeof message.usage === "object") {
			const cost = message.usage.cost?.total;
			if (typeof cost === "number" && Number.isFinite(cost)) summary.cost += cost;
			// Pi ignores the usage of an aborted or errored turn, so the context
			// reading does too; otherwise a failed call would look like context.
			if (message.stopReason !== "aborted" && message.stopReason !== "error") {
				const tokens = contextTokens(message.usage);
				if (tokens > 0) summary.contextTokens = tokens;
			}
		}
		const text = textParts(message.content);
		if (text !== "") summary.lastAssistant = text;
		// Reset every assistant message: what is running is what the *newest* one
		// asked for, and a final text-only message means nothing is.
		const tools = toolNames(message.content);
		summary.runningTool = tools.length > 0 ? tools.join(", ") : undefined;
	}

	return summary;
}

/** Pi's own context estimate: `totalTokens`, else the four parts summed. */
export function contextTokens(usage: any): number {
	const total = usage?.totalTokens;
	if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
	const parts = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite];
	if (parts.some((part) => typeof part !== "number" || !Number.isFinite(part))) return 0;
	return parts.reduce((sum: number, part: number) => sum + part, 0);
}

/** The text of a message's `text` parts, capped, or "" when it has none. */
function textParts(content: unknown): string {
	if (typeof content === "string") return cap(content.trim());
	if (!Array.isArray(content)) return "";
	const text = content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part: { text: string }) => part.text.trim())
		.filter((part: string) => part !== "")
		.join("\n");
	return cap(text);
}

/** The names of a message's tool calls, in order. */
function toolNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((part) => part?.type === "toolCall" && typeof part.name === "string")
		.map((part: { name: string }) => part.name);
}

function cap(text: string): string {
	return text.length > SESSION_TEXT_CHARS ? text.slice(0, SESSION_TEXT_CHARS) : text;
}
