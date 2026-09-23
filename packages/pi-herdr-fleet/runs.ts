/**
 * runs: the record of a fork, its review and its verdict, and the gate that
 * reads it.
 *
 * Up to 3b everything about a run lived in live panes. That is not enough for a
 * gate: a verdict kept only in the reviewer's session disappears the moment the
 * pane is closed, and the gate would silently open. So the record is a file in
 * the main checkout — `<main checkout>/.pi/herdr-fleet/runs/<branch>.json`, with
 * `/` replaced by `-` in the branch — written by a fork, updated by a review and
 * by `fleet_verdict`.
 *
 * The verdict itself is a tool call, not a line of text. The reviewer's reply is
 * prose for the human reading it; the tool call is the machine-readable one, and
 * the merge gate reads only that.
 *
 * `fleet_verdict` executes inside the reviewer's own session, which is why it
 * checks the calling pane against the run it recorded: the extension is loaded
 * in every Pi session, so without that check any session could write a verdict.
 *
 * `fleet_status` and `fleet_merge` are the other two calls that close the loop:
 * a tool is what an agent can drive, and a command alone would put a human in
 * the middle of every round. `/fleet status` and `/fleet merge` are thin
 * wrappers over `statusRuns` and `mergeRun`, the same functions the tools call.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { type HerdrClient, type Outcome, err, ok } from "./herdr-client.ts";
import { type CommandRunner, mainCheckout } from "./worktree.ts";

export type VerdictKind = "approve" | "request-changes";

export interface Finding {
	path: string;
	line?: number;
	note: string;
}

export interface RunRecord {
	branch: string;
	/** The ref the fork branched from, so a review can default to it. */
	base?: string;
	path: string;
	workspaceId: string;
	/** The implementation session, when the fork started one. */
	paneId?: string;
	agentName?: string;
	scope: string;
	task: string;
	createdAt: string;
	reviewer?: { paneId: string; agentName: string; sessionPath?: string };
	verdict?: { verdict: VerdictKind; findings: Finding[]; at: string };
	/** Set by `/fleet merge`, so a status line can say it without asking git. */
	mergedAt?: string;
	/**
	 * Set by `fleet_clean`. The record is never deleted — it is the audit trail —
	 * so this field is the only trace that the worktree, the branch and the panes
	 * are gone.
	 */
	cleanedAt?: string;
}

/** What `/fleet status` reports, derived from the record and one git question. */
export type RunState = "working" | "unreviewed" | "approve" | "request-changes" | "merged" | "cleaned";

const GIT_TIMEOUT_MS = 30_000;
const MERGE_TIMEOUT_MS = 10 * 60_000;

// ------------------------------------------------------------------ storage

export const RUNS_DIR = join(".pi", "herdr-fleet", "runs");

export function runFileName(branch: string): string {
	return `${branch.replaceAll("/", "-")}.json`;
}

export function runsDir(main: string): string {
	return join(main, RUNS_DIR);
}

export function readRun(main: string, branch: string): RunRecord | undefined {
	try {
		return JSON.parse(readFileSync(join(runsDir(main), runFileName(branch)), "utf8")) as RunRecord;
	} catch {
		return undefined;
	}
}

export function writeRun(main: string, record: RunRecord): void {
	const dir = runsDir(main);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, runFileName(record.branch)), `${JSON.stringify(record, null, 2)}\n`);
}

export function updateRun(main: string, branch: string, patch: Partial<RunRecord>): RunRecord | undefined {
	const existing = readRun(main, branch);
	if (!existing) return undefined;
	const next = { ...existing, ...patch };
	writeRun(main, next);
	return next;
}

/** Every record, sorted by branch name. An unreadable directory is no records. */
export function listRuns(main: string): RunRecord[] {
	try {
		const dir = runsDir(main);
		return readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.sort()
			.flatMap((name) => {
				try {
					return [JSON.parse(readFileSync(join(dir, name), "utf8")) as RunRecord];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

// ------------------------------------------------------------------- status

export function runState(record: RunRecord, merged: boolean): RunState {
	// `cleanedAt` comes first: after `fleet_clean` the branch is gone, so git cannot
	// answer, and a force-cleaned run was never merged at all. Without this a cleaned
	// run falls back to its verdict and reads as `approve`, which invites a merge of a
	// branch that no longer exists.
	if (record.cleanedAt !== undefined) return "cleaned";
	// `mergedAt` is the same kind of evidence when the branch ref is gone but the run
	// was not cleaned: `fleet_merge` writes it only after a successful merge.
	if (merged || record.mergedAt !== undefined) return "merged";
	if (record.verdict) return record.verdict.verdict;
	// A reviewer was started but never answered: the run is waiting on it.
	if (record.reviewer) return "unreviewed";
	return "working";
}

/** Whether the branch is already in the main checkout's history. */
export async function isMerged(run: CommandRunner, main: string, branch: string): Promise<boolean> {
	const result = await run("git", ["merge-base", "--is-ancestor", branch, "HEAD"], { cwd: main, timeout: GIT_TIMEOUT_MS });
	return result.code === 0;
}

/** One row of the status list, before either caller gives it its own words. */
export interface RunStatus {
	branch: string;
	scope: string;
	state: RunState;
	/** The verdict name, or `-` when there is none. */
	verdict: string;
}

/**
 * Every recorded run with its state. One implementation behind `fleet_status`
 * and `/fleet status`: the list is the loop's own view of itself, and two
 * versions of it would disagree about what is mergeable.
 *
 * One git call per run — `merged` is the main checkout's history, not a field
 * in the record, so a branch merged by hand still reads as merged. The record's
 * own `mergedAt` and `cleanedAt` are the fallback when the branch ref is gone:
 * a cleaned branch cannot be asked about at all.
 */
export async function statusRuns(run: CommandRunner, main: string): Promise<RunStatus[]> {
	const rows: RunStatus[] = [];
	for (const record of listRuns(main)) {
		const merged = await isMerged(run, main, record.branch);
		rows.push({
			branch: record.branch,
			scope: record.scope,
			state: runState(record, merged),
			verdict: record.verdict?.verdict ?? "-",
		});
	}
	return rows;
}

// -------------------------------------------------------------- the verdict

const VERDICT_PARAMETERS = Type.Object({
	verdict: StringEnum(["approve", "request-changes"] as const, {
		description: "approve when the change is ready to merge; request-changes when the author has to act on a finding.",
	}),
	findings: Type.Array(
		Type.Object({
			path: Type.String({ description: "The file the finding is about, relative to the worktree." }),
			line: Type.Optional(Type.Number({ description: "The line in that file, when the finding points at one." })),
			note: Type.String({ description: "What is wrong, in one actionable sentence." }),
		}),
		{ description: "One entry per problem. Empty is allowed for approve; request-changes without findings is not useful." },
	),
});

/**
 * The tool the reviewer calls. It writes the run's verdict and, on
 * `request-changes`, sends the findings back to the implementation session when
 * that session is still alive (3c does not start a replacement: see DESIGN.md).
 */
export function fleetVerdictTool(
	client: HerdrClient,
	run: CommandRunner,
	pi: ExtensionAPI,
): ToolDefinition<typeof VERDICT_PARAMETERS> {
	return {
		name: "fleet_verdict",
		label: "Fleet verdict",
		description:
			"Record the verdict of a review you are running: approve or request-changes, with one finding per problem. Only the pane this run recorded as the reviewer may call it. On request-changes the findings are sent back to the author's session if it is still running.",
		promptSnippet: "Record this review's verdict so the branch can be merged or sent back",
		promptGuidelines: [
			"Call fleet_verdict once, when the review is finished: approve only when nothing is worth changing.",
			"The findings are what the author has to act on, so name the file, the line and the problem.",
		],
		parameters: VERDICT_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			if (ctx.mode !== "tui") throw new Error("fleet_verdict only works in an interactive Pi session");
			const main = await mainCheckout(run, ctx.cwd);
			if (!main) throw new Error(`fleet_verdict: ${ctx.cwd} is not inside a git checkout, so no run can be recorded`);

			const paneId = client.selfPaneId();
			const record = listRuns(main).find((candidate) => candidate.reviewer?.paneId === paneId);
			if (!record) {
				throw new Error(
					`fleet_verdict: this pane (${paneId}) is not the reviewer of any run in ${runsDir(main)}; only the reviewer recorded by fleet_review may give a verdict`,
				);
			}

			const findings: Finding[] = params.findings.map((finding) => ({
				path: finding.path,
				...(finding.line === undefined ? {} : { line: finding.line }),
				note: finding.note,
			}));
			const at = new Date().toISOString();
			updateRun(main, record.branch, { verdict: { verdict: params.verdict as VerdictKind, findings, at } });
			// The file is the gate; the entry is what keeps the verdict in the
			// conversation tree it was given in.
			pi.appendEntry("fleet-verdict", { branch: record.branch, verdict: params.verdict, findings, at });

			const notes: string[] = [];
			if (params.verdict === "request-changes") {
				notes.push(...(await deliverFindings(client, { ...record, verdict: { verdict: params.verdict as VerdictKind, findings, at } }, findings)));
			}

			const lines = [
				`recorded ${params.verdict} for ${record.branch}`,
				`findings: ${findings.length}`,
				`record: ${join(runsDir(main), runFileName(record.branch))}`,
				...notes,
			];
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { branch: record.branch, verdict: params.verdict, findings } };
		},
	};
}

/**
 * `request-changes` is only useful if the author hears about it. The
 * implementation session is the one the fork started, so it is reached through
 * its pane — the same surface §2 settled on. When that session is gone nothing
 * is started in its place; the caller is told, and a fork is the human's move.
 */
async function deliverFindings(client: HerdrClient, record: RunRecord, findings: Finding[]): Promise<string[]> {
	if (!record.paneId) return ["the run recorded no implementation pane, so the findings were not sent anywhere"];
	const snapshot = await client.snapshot();
	if (!snapshot.ok) return [`the implementation session could not be checked: ${snapshot.error}`];
	if (!snapshot.value.panes.some((pane) => pane.pane_id === record.paneId)) {
		return [`the implementation session (${record.paneId}) is gone; the findings were not sent — fork a new session for the rework`];
	}
	const sent = await client.paneSendInput(record.paneId, findingsText(record.branch, findings));
	return sent.ok ? [`the findings were sent to the implementation session (${record.paneId})`] : [`the findings could not be sent: ${sent.error}`];
}

/** One message back to the author: the verdict, and every finding. */
export function findingsText(branch: string, findings: Finding[]): string {
	const lines = [`A review of ${branch} requested changes. Act on the findings, then commit again.`, "", "# Findings", ""];
	if (findings.length === 0) lines.push("- (the reviewer gave no findings; ask what it wants changed)");
	for (const finding of findings) lines.push(`- ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`} ${finding.note}`);
	return lines.join("\n");
}

// ------------------------------------------------------------- the gate

export interface MergeRequest {
	/** Any directory in the repository; the merge itself runs in the main checkout. */
	cwd: string;
	branch: string;
	/** Merge even without an approve verdict. */
	force?: boolean;
}

export interface MergeResult {
	branch: string;
	main: string;
	/** The verdict the gate saw, when there was one. */
	verdict?: VerdictKind;
	output: string;
}

/**
 * `/fleet merge`: the approve verdict, then a clean main checkout, then git.
 *
 * The worktree is deliberately left in place — its branch is now in main, but
 * the checkout is also where the reviewer ran and where the author's session may
 * still be. Cleanup is its own operation, not a side effect of merging.
 */
export async function mergeRun(run: CommandRunner, request: MergeRequest): Promise<Outcome<MergeResult>> {
	const branch = request.branch.trim();
	if (branch === "") return err("merge: a branch is required");
	const main = await mainCheckout(run, request.cwd);
	if (!main) return err(`merge: ${request.cwd} is not inside a git checkout`);
	const record = readRun(main, branch);

	const verdict = record?.verdict?.verdict;
	if (verdict !== "approve" && request.force !== true) {
		const why = record === undefined ? "no run was recorded for it" : `its verdict is ${verdict ?? "missing"}`;
		return err(`merge: ${branch} has no approve verdict (${why}); review it first, or pass --force`);
	}

	// Only tracked changes count. The run records live under `.pi/` inside this
	// checkout, so treating an untracked `.pi/` as a dirty tree would make the
	// gate refuse forever. git still refuses a merge that would clobber an
	// untracked file, and reports that itself.
	const dirty = await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: main, timeout: GIT_TIMEOUT_MS });
	if (dirty.code !== 0) return err(`merge: git status failed in ${main}: ${firstLine(dirty.stderr) ?? `exit ${dirty.code}`}`);
	if (dirty.stdout.trim() !== "") return err(`merge: ${main} has uncommitted changes; commit or stash them first`);

	const merged = await run("git", ["merge", "--no-edit", branch], { cwd: main, timeout: MERGE_TIMEOUT_MS });
	if (merged.code !== 0) {
		return err(`merge: git merge ${branch} failed: ${firstLine(merged.stderr) ?? firstLine(merged.stdout) ?? `exit ${merged.code}`}`);
	}
	if (record) updateRun(main, branch, { mergedAt: new Date().toISOString() });
	return ok({ branch, main, verdict, output: merged.stdout.trim() });
}

function firstLine(text: string): string | undefined {
	return text.split("\n").find((line) => line.trim() !== "")?.trim();
}

// ------------------------------------------------------------- the tools

/** Every state, in the tool's language. `stateLabel` is the command's. */
const STATE_TEXT: Record<RunState, string> = {
	working: "working",
	unreviewed: "unreviewed",
	approve: "approve",
	"request-changes": "request-changes",
	merged: "merged",
	cleaned: "cleaned",
};

/** No arguments: the list is the main checkout's own record. */
const STATUS_PARAMETERS = Type.Object({});

/**
 * The tool an agent calls to see the loop's state. Same rows as `/fleet status`,
 * but the result is a conversation entry, which is what lets a driving agent
 * decide what to review or merge without a human reading a toast.
 */
export function fleetStatusTool(run: CommandRunner): ToolDefinition<typeof STATUS_PARAMETERS> {
	return {
		name: "fleet_status",
		label: "Fleet status",
		description:
			"List every recorded fleet run, one per branch that fleet_fork created, with its branch, scope, state and verdict. A state is working, unreviewed, approve, request-changes, or merged when the branch is already in the main checkout's history. Read-only, and takes no arguments.",
		promptSnippet: "List every recorded run with its branch, scope, state and verdict",
		promptGuidelines: [
			"Call fleet_status to see which branches are still working, waiting on a review, approved or already merged.",
			"Only a run whose state is approve may be merged; fleet_merge refuses the rest unless force is set.",
		],
		parameters: STATUS_PARAMETERS,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
			if (ctx.mode !== "tui") throw new Error("fleet_status only works in an interactive Pi session");
			const main = await mainCheckout(run, ctx.cwd);
			if (!main) throw new Error(`fleet_status: ${ctx.cwd} is not inside a git checkout, so no run can be listed`);
			const rows = await statusRuns(run, main);
			const lines = rows.length === 0 ? [`no run has been recorded in ${main}`] : rows.map((row) => statusLine(row));
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { main, runs: rows } };
		},
	};
}

/** `branch · scope · state · verdict`, the same shape the command prints. */
function statusLine(row: RunStatus): string {
	return `${row.branch} · ${row.scope} · ${STATE_TEXT[row.state]} · ${row.verdict}`;
}

const MERGE_PARAMETERS = Type.Object({
	branch: Type.String({ description: "The branch to merge. It must have a run whose recorded verdict is approve, unless force is set." }),
	force: Type.Optional(
		Type.Boolean({
			description:
				"Merge even though the recorded verdict is not approve. Defaults to false. It does not bypass a dirty main checkout.",
		}),
	),
});

/**
 * The tool that closes the loop. `mergeRun` is the gate and git call; the tool
 * only turns its refusal into a thrown error, because a returned value never
 * sets the error flag and the agent has to know the merge did not happen.
 */
export function fleetMergeTool(run: CommandRunner): ToolDefinition<typeof MERGE_PARAMETERS> {
	return {
		name: "fleet_merge",
		label: "Fleet merge",
		description:
			"Merge a reviewed branch into the main checkout with `git merge --no-edit`. It presumes the run's recorded verdict is approve and refuses otherwise; pass force to merge anyway. Either way it refuses while the main checkout has uncommitted tracked changes. The branch's worktree is left in place: merging is not cleanup.",
		promptSnippet: "Merge a branch whose review recorded approve into the main checkout",
		promptGuidelines: [
			"Call fleet_merge once a review has recorded approve; set force only when the human asks for it, and say why.",
			"fleet_merge leaves the worktree in place, so a merged branch is still cleaned up separately.",
		],
		parameters: MERGE_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			if (ctx.mode !== "tui") throw new Error("fleet_merge only works in an interactive Pi session");
			const merged = await mergeRun(run, { cwd: ctx.cwd, branch: params.branch, force: params.force });
			if (!merged.ok) throw new Error(merged.error);
			const lines = [
				`merged ${merged.value.branch} into ${merged.value.main}`,
				`verdict: ${merged.value.verdict ?? "none (forced)"}`,
			];
			if (merged.value.output) lines.push(merged.value.output);
			lines.push("the worktree was left in place");
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: merged.value };
		},
	};
}
