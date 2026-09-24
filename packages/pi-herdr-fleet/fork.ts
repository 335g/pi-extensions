/**
 * fork: the one implementation behind the `fleet_fork` tool and `/fleet fork`.
 *
 * The tool is the primary caller. The loop this extension exists for is driven
 * by an agent — fork, review, merge — and a command alone would put a human in
 * the middle of every step, which is where a shell script already is. The
 * command stays as a thin wrapper for the times a human does want to type it.
 *
 * Both go through `forkWorktree`, so there is exactly one order of operations to
 * keep right, and the arguments the tool receives are validated here rather than
 * trusted: the caller is a model.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { type HerdrClient, type Outcome, err, ok } from "./herdr-client.ts";
import { type RunRecord, writeRun } from "./runs.ts";
import { findScope, forkScopeIds, scopeIds } from "./scopes.ts";
import {
	type CommandRunner,
	type EnvPropagation,
	type InstallOutcome,
	agentName,
	closeOwnPane,
	createWorktree,
	mainCheckout,
	prepareWorktree,
	sendSeed,
	startAgent,
} from "./worktree.ts";

export interface ForkRequest {
	/** The directory the worktree is created from: a checkout of the repository. */
	cwd: string;
	branch: string;
	/** The task the forked session works on. It is the whole brief. */
	task: string;
	base?: string;
	/** Scope id. Defaults to `implementation`. */
	scope?: string;
	/** Install dependencies when the checkout has a lockfile. Defaults to true. */
	install?: boolean;
	/** Split a pane and start Pi in it. Defaults to true. */
	start?: boolean;
}

export interface ForkedWorktree {
	path: string;
	branch: string;
	workspaceId: string;
	/** The ref the branch was cut from, once it is known. */
	base?: string;
	/** The session that was started, when `start` was true. */
	session?: { paneId: string; agent: string };
	/** Absent when nothing needed installing, or installation was skipped. */
	install?: InstallOutcome;
	env: EnvPropagation;
	/** Warnings about the checkout itself: the environment has its own, in `env`. */
	warnings: string[];
}

/**
 * The five steps of §3a, in order. `run` is only used for `direnv`; everything
 * that happens in herdr goes through the socket.
 */
export async function forkWorktree(
	client: HerdrClient,
	run: CommandRunner,
	request: ForkRequest,
): Promise<Outcome<ForkedWorktree>> {
	// The tool's caller is an agent, so the empty string is the shape a missing
	// argument usually takes: a field the model filled in with nothing.
	const branch = request.branch.trim();
	const task = request.task.trim();
	if (branch === "" || task === "") return err("fork: branch and task are both required");

	const scopeId = request.scope?.trim() || "implementation";
	const scope = findScope(scopeId);
	if (!scope) return err(`fork: unknown scope ${scopeId} (a fork can use ${forkScopeIds().join(", ")})`);
	// A fork has a task and a worktree and nothing else, so a scope that needs
	// material gathered from an existing worktree is not one it can start.
	if (!scope.forkable) return err(`fork: the ${scopeId} scope is not started by a fork (a fork can use ${forkScopeIds().join(", ")})`);

	const base = request.base?.trim() || undefined;
	const created = await createWorktree(client, run, { cwd: request.cwd, branch, base, label: branch });
	if (!created.ok) return created;
	const { env, path, workspaceId, rootPaneId, warnings } = created.value;
	// Everything past this point has to say that the checkout is already there,
	// because it is: a failed fork leaves a worktree behind.
	const afterCreate = (error: string) => `fork: ${error} (the worktree at ${path} was created)`;
	const forked: ForkedWorktree = { path, branch: created.value.branch ?? branch, workspaceId, base: created.value.base, env, warnings };
	// The run record is the only state 3c keeps: it is what a review updates and
	// what the merge gate reads. Failing to write it is a warning, not a failed
	// fork — the worktree and the session are already real.
	const recordRun = async (): Promise<void> => {
		const main = await mainCheckout(run, request.cwd);
		if (!main) {
			forked.warnings.push("the run record could not be written: no main checkout was found");
			return;
		}
		const record: RunRecord = {
			branch: forked.branch,
			base: forked.base,
			path,
			workspaceId,
			paneId: forked.session?.paneId,
			agentName: forked.session?.agent,
			scope: scope.id,
			task,
			createdAt: new Date().toISOString(),
		};
		try {
			writeRun(main, record);
		} catch (error) {
			forked.warnings.push(`the run record could not be written: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	if (request.start === false) {
		await recordRun();
		return ok(forked);
	}

	const prepared = await prepareWorktree(client, {
		path,
		workspaceId,
		rootPaneId,
		install: request.install !== false,
	});
	if (!prepared.ok) return err(afterCreate(prepared.error));
	forked.install = prepared.value.install;

	// The pane surface, not `agent.prompt`: see §2 of DESIGN.md.
	const paneId = prepared.value.paneId;
	const agent = agentName(forked.branch);
	const started = await startAgent(client, { paneId, name: agent });
	// The worktree stays for inspection, but the pane is this call's own: a
	// session that never started, or never got its task, is a pane with nothing in
	// it, and closing it is the only thing that keeps the screen clean.
	if (!started.ok) return err(afterCreate(`${started.error} (${await closeOwnPane(client, paneId)})`));

	const sent = await sendSeed(client, paneId, scope.seed({ task, path, branch: forked.branch, base }));
	if (!sent.ok) return err(afterCreate(`${sent.error} (${await closeOwnPane(client, paneId)})`));
	forked.session = { paneId, agent };

	await recordRun();
	return ok(forked);
}

/** The scope ids a fork can use, so the schema and the registry cannot drift apart. */
const FORK_SCOPE_IDS = forkScopeIds();

const FORK_PARAMETERS = Type.Object({
	branch: Type.String({ description: "Branch name for the new worktree. Created if it does not exist." }),
	task: Type.String({
		description:
			"The task the forked session works on, in full. It is the whole brief: the forking session's conversation is not passed on, so anything already decided has to be written here.",
	}),
	base: Type.Optional(Type.String({ description: "Ref to branch from. Defaults to HEAD." })),
	scope: Type.Optional(
		StringEnum(FORK_SCOPE_IDS, { description: `What kind of session to fork. Defaults to implementation. Known scopes: ${scopeIds()}.` }),
	),
	install: Type.Optional(
		Type.Boolean({ description: "Install dependencies in the worktree when it has a lockfile. Defaults to true." }),
	),
	start: Type.Optional(
		Type.Boolean({ description: "Open a pane and start Pi in the worktree. Defaults to true; false only creates the worktree." }),
	),
});

/** The tool the agent calls. Registered in a TUI session only, like the command. */
export function fleetForkTool(client: HerdrClient, run: CommandRunner): ToolDefinition<typeof FORK_PARAMETERS> {
	return {
		name: "fleet_fork",
		label: "Fleet fork",
		description:
			"Fork the repository into a new git worktree, start a Pi session in it, and hand it one task. The forked session works there on its own and commits its work; the forking session keeps its conversation to itself, so the task has to carry every decision it needs. Returns the worktree, the branch, the pane and the agent.",
		promptSnippet: "Fork a worktree, start a Pi session in it, and hand it a task",
		promptGuidelines: [
			"Use fleet_fork when work should happen in a separate worktree, by a separate Pi session, without blocking this one.",
			"Write the fleet_fork task as a complete brief: the forked session cannot see this conversation.",
		],
		parameters: FORK_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			if (ctx.mode !== "tui") throw new Error("fleet_fork only works in an interactive Pi session");
			const forked = await forkWorktree(client, run, {
				cwd: ctx.cwd,
				branch: params.branch,
				task: params.task,
				base: params.base,
				scope: params.scope,
				install: params.install,
				start: params.start,
			});
			// A tool reports failure by throwing; a returned value never sets the
			// error flag, and the model has to know the fork did not happen.
			if (!forked.ok) throw new Error(forked.error);
			return { content: [{ type: "text" as const, text: report(forked.value) }], details: forked.value };
		},
	};
}

/**
 * The tool result becomes one entry in the conversation, so it stays short: what
 * was created, and only the warnings — a fork that carried the environment over
 * cleanly has nothing to say about it.
 */
function report(forked: ForkedWorktree): string {
	const lines = [`forked ${forked.branch}`, `worktree: ${forked.path}`, `workspace: ${forked.workspaceId}`];
	if (forked.session) lines.push(`pane: ${forked.session.paneId}`, `agent: ${forked.session.agent}`);
	else lines.push("no pane was started");
	if (forked.install) {
		const { command, error, ok } = forked.install;
		lines.push(`prepare: ${ok ? `${command} finished` : `${command} failed (${error})`}`);
	}
	for (const warning of forked.warnings) lines.push(`warning: ${warning}`);
	for (const warning of forked.env.warnings) lines.push(`warning: ${warning}`);
	return lines.join("\n");
}
