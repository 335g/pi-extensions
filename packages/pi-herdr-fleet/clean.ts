/**
 * clean: the one implementation behind the `fleet_clean` tool and
 * `/fleet clean`.
 *
 * Merging deliberately leaves the worktree in place (§3c), so something has to
 * remove what the loop created: the worktree, the branch, and the panes the run
 * recorded. This is that operation, and it is a separate call rather than a side
 * effect of merging because the worktree is also where the reviewer ran and
 * where the author's session may still be.
 *
 * Two things are deliberately *not* removed: the run record and the session
 * JSONL. The record is what makes "why did we abandon that worktree?" answerable
 * later, and the session is what `session_search` indexes; both compound, and a
 * cleanup that erased them would make the audit log (§6) write-only. The record
 * gets a `cleanedAt` timestamp instead.
 *
 * A run may only be cleaned once its branch is in the main checkout's history —
 * the record's `mergedAt`, or `git merge-base --is-ancestor`. `force` overrides
 * that, and switches the branch deletion from `git branch -d` to `-D`. Removing
 * a worktree herdr no longer knows about, a branch that is already gone, or a
 * pane that is already closed is not an error: the operation is idempotent.
 */

import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { type HerdrClient, type Outcome, err, ok } from "./herdr-client.ts";
import { isMerged, readRun, runFileName, runsDir, updateRun } from "./runs.ts";
import { type CommandRunner, mainCheckout } from "./worktree.ts";

const GIT_TIMEOUT_MS = 30_000;

export interface CleanRequest {
	/** Any directory in the repository; the branch is deleted in the main checkout. */
	cwd: string;
	branch: string;
	/** Clean even without a merge, and delete the branch with `-D`. */
	force?: boolean;
}

export interface CleanResult {
	branch: string;
	main: string;
	/** False when herdr had no such worktree, or could not remove it. */
	worktreeRemoved: boolean;
	/** False when the branch was already gone. */
	branchDeleted: boolean;
	/** The panes the record named that were closed, this session's own excluded. */
	panesClosed: string[];
	/** What did not happen, in the caller's language. Never a refusal. */
	warnings: string[];
}

/**
 * `/fleet clean`: the merge check, then the panes, the worktree and the branch.
 *
 * The panes go first. `worktree.remove` closes the workspace and everything in
 * it, so a pane close attempted afterwards would always look like a failure; in
 * this order a normal cleanup has nothing to report. A pane this session runs in
 * is never closed — that is the session doing the cleaning.
 */
export async function cleanRun(
	client: HerdrClient,
	run: CommandRunner,
	request: CleanRequest,
): Promise<Outcome<CleanResult>> {
	const branch = request.branch.trim();
	if (branch === "") return err("clean: a branch is required");
	const main = await mainCheckout(run, request.cwd);
	if (!main) return err(`clean: ${request.cwd} is not inside a git checkout`);

	// The record is what names the worktree and the panes, so without one there is
	// nothing to clean — and a branch deleted behind herdr's back would leave its
	// worktree dangling.
	const record = readRun(main, branch);
	if (!record) {
		return err(`clean: no run was recorded for ${branch} in ${runsDir(main)}; fleet_clean only removes what fleet_fork created`);
	}

	// A run that was already cleaned stays cleanable: the merge check is about the
	// first cleanup, and refusing the second would make the operation fail on the
	// very state it created.
	const merged = record.cleanedAt !== undefined || record.mergedAt !== undefined || (await isMerged(run, main, branch));
	if (!merged && request.force !== true) {
		return err(`clean: ${branch} has not been merged; merge it first, or pass force to remove it anyway`);
	}

	const warnings: string[] = [];

	const panesClosed: string[] = [];
	const self = client.selfPaneId();
	for (const paneId of namedPanes(record)) {
		if (paneId === self) continue;
		const closed = await client.request("pane.close", { pane_id: paneId });
		if (closed.ok) panesClosed.push(paneId);
		else warnings.push(`the pane ${paneId} was not closed: ${closed.error}`);
	}

	let worktreeRemoved = false;
	if (record.workspaceId) {
		// `force` here is herdr's, not the gate's: a merged worktree still has the
		// untracked environment (`node_modules`, `.env`) that made it usable.
		const removed = await client.request("worktree.remove", { workspace_id: record.workspaceId, force: true });
		if (removed.ok) worktreeRemoved = true;
		else warnings.push(`the worktree (${record.workspaceId}) was not removed: ${removed.error}`);
	} else {
		warnings.push("the run recorded no workspace, so no worktree was removed");
	}

	let branchDeleted = false;
	if (await branchExists(run, main, branch)) {
		const deleted = await run("git", ["branch", request.force === true ? "-D" : "-d", branch], {
			cwd: main,
			timeout: GIT_TIMEOUT_MS,
		});
		if (deleted.code !== 0) {
			const reason = firstLine(deleted.stderr) ?? `exit ${deleted.code}`;
			// The branch delete is often the first step that can fail after the worktree
			// is gone, and the reason is usually a warning collected above: a worktree
			// herdr could not remove still has the branch checked out, and git's own
			// message then points at git rather than at herdr. The warnings carry the
			// root cause, so they go into the error instead of being dropped.
			const context = warnings.length === 0 ? "" : `; before it: ${warnings.join("; ")}`;
			return err(
				`clean: git branch ${request.force === true ? "-D" : "-d"} ${branch} failed: ${reason}${context}`,
			);
		}
		branchDeleted = true;
	}

	// The record stays. It is the audit trail, and `cleanedAt` is what says the
	// rest of it is history rather than live state.
	updateRun(main, branch, { cleanedAt: new Date().toISOString() });

	return ok({ branch, main, worktreeRemoved, branchDeleted, panesClosed, warnings });
}

/** The panes the record names: the author's, then the reviewer's, without repeats. */
function namedPanes(record: { paneId?: string; reviewer?: { paneId: string } }): string[] {
	return [...new Set([record.paneId, record.reviewer?.paneId].filter((id): id is string => typeof id === "string" && id !== ""))];
}

/** Whether the branch still exists, so an already-deleted one is not an error. */
async function branchExists(run: CommandRunner, main: string, branch: string): Promise<boolean> {
	const found = await run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: main, timeout: GIT_TIMEOUT_MS });
	return found.code === 0;
}

function firstLine(text: string): string | undefined {
	return text.split("\n").find((line) => line.trim() !== "")?.trim();
}

// ------------------------------------------------------------------ the tool

const CLEAN_PARAMETERS = Type.Object({
	branch: Type.String({
		description: "The branch of the run to clean. A run must have been recorded for it by fleet_fork.",
	}),
	force: Type.Optional(
		Type.Boolean({
			description:
				"Clean even though the branch has not been merged, and delete it with `git branch -D` instead of `-d`. Defaults to false.",
		}),
	),
});

/**
 * The tool an agent calls once a branch is merged. `/fleet clean` is a thin
 * wrapper over `cleanRun`, the same function this calls.
 */
export function fleetCleanTool(client: HerdrClient, run: CommandRunner): ToolDefinition<typeof CLEAN_PARAMETERS> {
	return {
		name: "fleet_clean",
		label: "Fleet clean",
		description:
			"Remove what a merged run created: its worktree through herdr's worktree.remove, its branch with `git branch -d` in the main checkout, and the panes the run recorded. It presumes the branch is already merged — the record's mergedAt, or `git merge-base --is-ancestor` — and refuses otherwise; pass force to clean an unmerged run anyway and delete its branch with -D. The run record and the session JSONL are never deleted: the record only gets a cleanedAt timestamp. Already-removed worktrees, branches and panes are not an error.",
		promptSnippet: "Remove a merged run's worktree, branch and panes, keeping its record",
		promptGuidelines: [
			"Call fleet_clean after fleet_merge to remove the worktree, branch and panes the run left behind.",
			"Only a merged run may be cleaned; set force only when the human asks for it, and say why.",
			"fleet_clean keeps the run record and the session JSONL; it only adds cleanedAt.",
		],
		parameters: CLEAN_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			if (ctx.mode !== "tui") throw new Error("fleet_clean only works in an interactive Pi session");
			const cleaned = await cleanRun(client, run, { cwd: ctx.cwd, branch: params.branch, force: params.force });
			if (!cleaned.ok) throw new Error(cleaned.error);
			const lines = [
				`cleaned ${cleaned.value.branch}`,
				`worktree: ${cleaned.value.worktreeRemoved ? "removed" : "nothing to remove"}`,
				`branch: ${cleaned.value.branchDeleted ? "deleted" : "already gone"}`,
				`panes closed: ${cleaned.value.panesClosed.length === 0 ? "none" : cleaned.value.panesClosed.join(", ")}`,
				`record: ${join(runsDir(cleaned.value.main), runFileName(cleaned.value.branch))}`,
			];
			for (const warning of cleaned.value.warnings) lines.push(`warning: ${warning}`);
			lines.push("the run record and the session JSONL were kept; the record only gained cleanedAt");
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: cleaned.value };
		},
	};
}
