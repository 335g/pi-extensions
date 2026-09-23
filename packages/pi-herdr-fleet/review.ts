/**
 * review: the one implementation behind the `fleet_review` tool and
 * `/fleet review`.
 *
 * A fork branches the work *and* the context: the implementation session gets a
 * task and nothing else. A review is the opposite trade. The reviewer can read
 * the worktree, but it has no way to know what was asked, what the author
 * believed it was doing, or which parts the author already knew were unfinished.
 * So the review seed carries the diff, the task, and a bounded excerpt of the
 * author's own session — the last of which is the only part no `git` command can
 * produce.
 *
 * The review runs in a new pane *inside the implementation worktree*, because
 * git refuses to check out one branch in two worktrees. The reviewer is told to
 * be read-only; a review that edits the thing under review is not a review.
 *
 * The verdict is still text. 3c replaces this with a `fleet_verdict` tool call,
 * which is why the seed fixes the shape now and why the reviewer is told to end
 * with it.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { type HerdrClient, type Outcome, err, ok } from "./herdr-client.ts";
import { type RunRecord, readRun, writeRun } from "./runs.ts";
import { findScope } from "./scopes.ts";
import { type CommandRunner, agentName, mainCheckout, prepareWorktree, sendSeed, startAgent } from "./worktree.ts";

/**
 * This extension's own entry point, taken from where this file is loaded from.
 *
 * The reviewer is started with `-e <this>` for two reasons: the installed path
 * may point at an older build in the main checkout, and there may be no
 * installed path at all. Either way the reviewer has to load the code that is
 * running here, or `fleet_verdict` is not in its tool list.
 */
const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));

export interface ReviewRequest {
	/** The directory the calling session is in: any checkout of the repository. */
	cwd: string;
	/** The branch the implementation session worked on. */
	branch: string;
	/** The task that session was given. A review is against the brief. */
	task: string;
	/** Ref the change is measured from. Defaults to the main checkout's HEAD. */
	base?: string;
}

export interface ReviewedWorktree {
	path: string;
	branch: string;
	workspaceId: string;
	/** The pane the reviewer runs in, split off inside the author's worktree. */
	paneId: string;
	agent: string;
	/** The ref the diff was taken against. */
	base: string;
	/** The author's pane, when its session was still running there. */
	authorPaneId?: string;
	authorSession?: string;
	/** What the reviewer was actually given, so a truncated review is visible. */
	diffChars: number;
	diffTruncated: boolean;
	authorChars: number;
	authorMessages: number;
	authorTruncated: boolean;
	warnings: string[];
}

/**
 * The caps on the author's session. A Pi session reaches megabytes, and the
 * whole point of reading it is to hand over a bounded amount, so both a line and
 * a character limit are needed: a session of one-line tool results and a session
 * of long prose hit different ceilings.
 *
 * 300 lines and 20000 characters are roughly 5k tokens — small next to the diff,
 * large enough to hold the reasoning around the last few commits. The newest
 * text is what survives, because that is where the report is.
 *
 * The caps bound everything that is delivered, marker included: the omission
 * notice is reserved out of the budget whether or not it is used. The separators
 * between messages count as lines too — a session of 300 one-line messages is
 * otherwise 1500 lines of seed.
 */
const AUTHOR_MAX_LINES = 300;
const AUTHOR_MAX_CHARS = 20_000;
/** Never read a whole session into memory: only its tail can be used anyway. */
const AUTHOR_TAIL_BYTES = 4 * 1024 * 1024;
const OMITTED = "[earlier messages omitted]";
const OMITTED_LINES = 2;
const SEPARATOR = "\n\n---\n\n";
const SEPARATOR_LINES = SEPARATOR.split("\n").length - 1;

/**
 * The diff goes into a seed sent through a pane, so a pathological one (a
 * regenerated lockfile, a vendored tree) has to be cut somewhere. It is cut
 * loudly: the reviewer is told, and can run `git diff` itself in the worktree.
 */
const DIFF_MAX_CHARS = 60_000;

const GIT_TIMEOUT_MS = 30_000;

export interface AuthorExcerpt {
	/** Assistant text, oldest first, with a marker when it was cut. */
	text: string;
	/** How many assistant messages survived. */
	messages: number;
	truncated: boolean;
}

/**
 * Read a Pi session JSONL and take the assistant text out of it.
 *
 * Only the `text` parts: thinking is not what the author said, and tool calls
 * and results are the diff by another route. The tail of the file is what is
 * read, so a session that grew past `AUTHOR_TAIL_BYTES` still parses (the first,
 * partial line is dropped) and an unreadable file is the caller's to report.
 */
export function readAuthorSession(
	path: string,
	maxLines = AUTHOR_MAX_LINES,
	maxChars = AUTHOR_MAX_CHARS,
): AuthorExcerpt {
	const messages: string[] = [];
	for (const line of readTail(path, AUTHOR_TAIL_BYTES).split("\n")) {
		const text = assistantText(line);
		if (text !== "") messages.push(text);
	}

	// Walked from the end, because the report is the newest message and the caps
	// are a budget rather than a per-message rule. The marker's room is taken out
	// first, so what is delivered is inside the caps either way.
	const kept: string[] = [];
	const maxBodyLines = maxLines - OMITTED_LINES;
	const maxBodyChars = maxChars - OMITTED.length - OMITTED_LINES;
	let lines = 0;
	let chars = 0;
	let truncated = false;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		const cost = kept.length === 0 ? message.length : message.length + SEPARATOR.length;
		const height = message.split("\n").length + (kept.length === 0 ? 0 : SEPARATOR_LINES);
		if (lines + height > maxBodyLines || chars + cost > maxBodyChars) {
			// The newest message can be longer than the whole budget on its own.
			if (kept.length === 0) kept.push(tailWithin(message, maxBodyLines, maxBodyChars));
			truncated = true;
			break;
		}
		kept.unshift(message);
		chars += cost;
		lines += height;
	}

	return {
		text: truncated ? `${OMITTED}\n\n${kept.join(SEPARATOR)}` : kept.join(SEPARATOR),
		messages: kept.length,
		truncated,
	};
}

/** The last `maxChars` characters, then the last `maxLines` of those. */
function tailWithin(text: string, maxLines: number, maxChars: number): string {
	let kept = text.length > maxChars ? text.slice(text.length - maxChars) : text;
	const lines = kept.split("\n");
	if (lines.length > maxLines) kept = lines.slice(lines.length - maxLines).join("\n");
	return kept;
}

/** One JSONL line, when it is an assistant message with text in it. */
function assistantText(line: string): string {
	let parsed: any;
	try {
		parsed = JSON.parse(line);
	} catch {
		return "";
	}
	if (parsed?.type !== "message" || parsed.message?.role !== "assistant") return "";
	const content = parsed.message.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part: { text: string }) => part.text.trim())
		.filter((text: string) => text !== "")
		.join("\n");
}

function readTail(path: string, maxBytes: number): string {
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

// ------------------------------------------------------------------ review

export async function reviewWorktree(
	client: HerdrClient,
	run: CommandRunner,
	request: ReviewRequest,
): Promise<Outcome<ReviewedWorktree>> {
	const branch = request.branch.trim();
	const task = request.task.trim();
	// The tool's caller is an agent, so an argument is usually missing as an empty
	// string rather than as an absent field.
	if (branch === "" || task === "") return err("review: branch and task are both required");
	const scope = findScope("review");
	if (!scope) return err("review: this build has no review scope");

	// The run record is where the fork point was written down, so a review of a
	// forked branch diffs against the fork's own base by default. Without it, a
	// nested fork would drag the parent branch's changes into the diff.
	const main = await mainCheckout(run, request.cwd);
	const record = main ? readRun(main, branch) : undefined;

	const located = await locate(client, run, { cwd: request.cwd, branch, base: request.base ?? record?.base });
	if (!located.ok) return located;
	const { authorPaneId, authorSession, base, path, targetPaneId, workspaceId } = located.value;
	const warnings = [...located.value.warnings];
	// Without a pane inside the author's workspace, `pane.split` would split whatever
	// is focused and the reviewer would end up somewhere else entirely.
	if (!targetPaneId) {
		return err(`review: no pane was found in workspace ${workspaceId}, so the reviewer has nowhere to run`);
	}

	// Gathered before the pane exists: a missing worktree or an unreadable git
	// should not leave a half-started review session behind.
	const diff = await git(run, ["diff", `${base}...HEAD`], path);
	if (diff.code !== 0) return err(`review: git diff ${base}...HEAD failed: ${firstLine(diff.stderr) ?? `exit ${diff.code}`}`);
	const truncatedDiff = diff.stdout.length > DIFF_MAX_CHARS;
	const diffText = truncatedDiff
		? `${diff.stdout.slice(0, DIFF_MAX_CHARS)}\n\n[diff truncated at ${DIFF_MAX_CHARS} of ${diff.stdout.length} characters: run git diff yourself for the rest]`
		: diff.stdout;

	let author: AuthorExcerpt | undefined;
	if (authorSession) {
		try {
			author = readAuthorSession(authorSession);
		} catch (error) {
			warnings.push(`the author's session could not be read: ${describe(error)}`);
		}
	} else {
		warnings.push(`no Pi session was found in ${path}, so the author's own account is not part of the review`);
	}

	const prepared = await prepareWorktree(client, {
		path,
		workspaceId,
		rootPaneId: targetPaneId,
		// Dependency installation is the implementation's problem, not the review's.
		install: false,
	});
	if (!prepared.ok) return err(`review: ${prepared.error} (the review is of what is already at ${path})`);

	const agent = agentName(branch, "review");
	const started = await startAgent(client, { paneId: prepared.value.paneId, name: agent, args: ["-e", ENTRY] });
	if (!started.ok) return err(`review: ${started.error} (the pane is ${prepared.value.paneId})`);

	const sent = await sendSeed(
		client,
		prepared.value.paneId,
		scope.seed({ task, path, branch, base, diff: diffText, author: author?.text, authorSession }),
	);
	if (!sent.ok) return err(`review: ${sent.error} (the reviewer's pane is ${prepared.value.paneId})`);

	// The record is what `fleet_verdict` checks the calling pane against, so the
	// reviewer has to be in it before it can answer.
	if (main) {
		const sessionPath = await sessionOf(client, prepared.value.paneId);
		const next: RunRecord = {
			...(record ?? {}),
			branch,
			base,
			path,
			workspaceId,
			scope: record?.scope ?? "implementation",
			task: record?.task ?? task,
			createdAt: record?.createdAt ?? new Date().toISOString(),
			reviewer: { paneId: prepared.value.paneId, agentName: agent, ...(sessionPath ? { sessionPath } : {}) },
		};
		try {
			writeRun(main, next);
		} catch (error) {
			warnings.push(`the run record could not be written: ${describe(error)}`);
		}
	}

	return ok({
		path,
		branch,
		workspaceId,
		paneId: prepared.value.paneId,
		agent,
		base,
		authorPaneId,
		authorSession,
		diffChars: diffText.length,
		diffTruncated: truncatedDiff,
		authorChars: author?.text.length ?? 0,
		authorMessages: author?.messages ?? 0,
		authorTruncated: author?.truncated ?? false,
		warnings,
	});
}

interface LocatedWorktree {
	path: string;
	workspaceId: string;
	/** Where the review pane is split from: a pane that is already in the worktree. */
	targetPaneId?: string;
	authorPaneId?: string;
	authorSession?: string;
	base: string;
	warnings: string[];
}

/**
 * Where the branch is checked out, who wrote it, and what to diff against.
 *
 * herdr is asked which worktree holds the branch, because the answer has to
 * include the workspace the review pane goes in. The author is found in the
 * snapshot, by name first: a second review of the same branch would otherwise
 * find the first reviewer's session before the author's.
 */
async function locate(
	client: HerdrClient,
	run: CommandRunner,
	request: { cwd: string; branch: string; base?: string },
): Promise<Outcome<LocatedWorktree>> {
	const listed = await client.request("worktree.list", { cwd: request.cwd });
	if (!listed.ok) return listed;
	const worktrees: any[] = Array.isArray(listed.value?.worktrees) ? listed.value.worktrees : [];
	const worktree = worktrees.find((candidate) => candidate?.branch === request.branch);
	if (!worktree) return err(`review: no worktree is checked out on ${request.branch}`);
	const workspaceId = worktree.open_workspace_id;
	if (typeof workspaceId !== "string") {
		return err(`review: the worktree for ${request.branch} is not open in a workspace, so there is nowhere to review it`);
	}

	const warnings: string[] = [];
	const author = await authorAgent(client, workspaceId, request.branch, warnings);
	const source = listed.value?.source?.source_checkout_path;
	const base = request.base?.trim() || (source ? await headOf(run, source) : undefined);
	if (!base) return err("review: no base to diff against: pass one, or run this from a checkout of the branch's repository");

	return ok({
		path: worktree.path,
		workspaceId,
		targetPaneId: author?.pane_id ?? (await anyPaneIn(client, workspaceId)),
		authorPaneId: author?.pane_id,
		authorSession: typeof author?.agent_session?.value === "string" ? author.agent_session.value : undefined,
		base,
		warnings,
	});
}

async function authorAgent(
	client: HerdrClient,
	workspaceId: string,
	branch: string,
	warnings: string[],
): Promise<{ pane_id: string; agent_session?: { value?: string | null } | null } | undefined> {
	const snapshot = await client.snapshot();
	if (!snapshot.ok) {
		warnings.push(`the snapshot could not be read: ${snapshot.error}`);
		return undefined;
	}
	const inWorkspace = snapshot.value.agents.filter((agent) => agent.workspace_id === workspaceId && agent.agent === "pi");
	return inWorkspace.find((agent) => agent.name === agentName(branch)) ?? inWorkspace[0];
}

/** A pane to split: the worktree's own shell when the author's Pi is gone. */
async function anyPaneIn(client: HerdrClient, workspaceId: string): Promise<string | undefined> {
	const snapshot = await client.snapshot();
	if (!snapshot.ok) return undefined;
	return snapshot.value.panes.find((pane) => pane.workspace_id === workspaceId)?.pane_id;
}

/** The session herdr knows for a pane, when it knows one yet. */
async function sessionOf(client: HerdrClient, paneId: string): Promise<string | undefined> {
	const snapshot = await client.snapshot();
	if (!snapshot.ok) return undefined;
	const value = snapshot.value.agents.find((agent) => agent.pane_id === paneId)?.agent_session?.value;
	return typeof value === "string" ? value : undefined;
}

async function headOf(run: CommandRunner, cwd: string): Promise<string | undefined> {
	const head = await git(run, ["rev-parse", "HEAD"], cwd);
	return head.code === 0 ? head.stdout.trim() : undefined;
}

function git(run: CommandRunner, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return run("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
}

function firstLine(text: string): string | undefined {
	return text.split("\n").find((line) => line.trim() !== "")?.trim();
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------ the tool

const REVIEW_PARAMETERS = Type.Object({
	branch: Type.String({ description: "The branch the implementation session worked on." }),
	task: Type.String({
		description: "The task that session was given, in full. The review is against the brief, and the reviewer cannot see this conversation.",
	}),
	base: Type.Optional(
		Type.String({ description: "Ref the change is measured from. Defaults to the main checkout's HEAD, which is where a fork branches from." }),
	),
});

/** The tool the agent calls. Registered in a TUI session only, like the command. */
export function fleetReviewTool(client: HerdrClient, run: CommandRunner): ToolDefinition<typeof REVIEW_PARAMETERS> {
	return {
		name: "fleet_review",
		label: "Fleet review",
		description:
			"Start a read-only Pi session in the worktree of a branch that was forked, and give it the diff, the task and the author's own session to judge. The reviewer answers with a verdict; it does not change the worktree. Returns the reviewer's pane and agent.",
		promptSnippet: "Send a reviewer into a forked worktree, with the diff and the author's session",
		promptGuidelines: [
			"Use fleet_review after fleet_fork once the implementation session has committed, so the work is reviewed before it is merged.",
			"Pass the same task that fleet_fork was given: the reviewer judges the change against that brief.",
		],
		parameters: REVIEW_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			if (ctx.mode !== "tui") throw new Error("fleet_review only works in an interactive Pi session");
			const reviewed = await reviewWorktree(client, run, {
				cwd: ctx.cwd,
				branch: params.branch,
				task: params.task,
				base: params.base,
			});
			if (!reviewed.ok) throw new Error(reviewed.error);
			return { content: [{ type: "text" as const, text: report(reviewed.value) }], details: reviewed.value };
		},
	};
}

/** One conversation entry, so it stays short: what was reviewed and by whom. */
function report(reviewed: ReviewedWorktree): string {
	const lines = [
		`reviewing ${reviewed.branch} against ${reviewed.base}`,
		`worktree: ${reviewed.path}`,
		`pane: ${reviewed.paneId}`,
		`agent: ${reviewed.agent}`,
		`diff: ${reviewed.diffChars} characters${reviewed.diffTruncated ? " (truncated)" : ""}`,
		`author session: ${reviewed.authorMessages} assistant messages, ${reviewed.authorChars} characters${
			reviewed.authorTruncated ? " (truncated)" : ""
		}`,
	];
	if (!reviewed.authorSession) lines.push("no author session was found");
	for (const warning of reviewed.warnings) lines.push(`warning: ${warning}`);
	lines.push("the reviewer records its verdict with the fleet_verdict tool; it does not modify the worktree");
	return lines.join("\n");
}
