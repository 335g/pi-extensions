/**
 * worktree: create a herdr worktree and carry the untracked development
 * environment into it.
 *
 * A fresh worktree has whatever git tracks and nothing else. `.env` and
 * `.envrc` are gitignored in most repos, so a Pi started in the new worktree
 * dies immediately with "No API key found". The copy below is the difference
 * between a usable worktree and a broken one.
 *
 * What is deliberately *not* done: granting direnv trust that the source never
 * had. `direnv allow` is a trust decision about code the worktree is about to
 * execute, so it is only mirrored, never introduced.
 */

import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { type HerdrClient, type Outcome, err, ok } from "./herdr-client.ts";

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/** `pi.exec`, narrowed to what this module needs. */
export type CommandRunner = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<CommandResult>;

/** `.env`, `.env.local`, `.envrc` — everything dotenv/direnv may read. */
const ENV_PREFIX = ".env";
const PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface EnvPropagation {
	/** Copied into the worktree. */
	copied: string[];
	/** Already present there, so left alone. */
	skipped: string[];
	/** True only when a copied `.envrc` was allowed in the new worktree. */
	allowed: boolean;
	warnings: string[];
}

export interface CreatedWorktree {
	/** The worktree's checkout path, as herdr reports it. */
	path: string;
	workspaceId: string;
	branch?: string | null;
	env: EnvPropagation;
}

export interface CreateWorktreeOptions {
	/** The repo (or any directory in it) the worktree is created from. */
	cwd: string;
	branch?: string;
	label?: string;
	/** Branch or commit the new branch is based on. */
	base?: string;
}

/**
 * `herdr worktree create` plus the environment copy. A failure to copy is a
 * warning, not a failure: the worktree itself exists and is usable.
 */
export async function createWorktree(
	client: HerdrClient,
	run: CommandRunner,
	options: CreateWorktreeOptions,
): Promise<Outcome<CreatedWorktree>> {
	const response = await client.request("worktree.create", {
		cwd: options.cwd,
		branch: options.branch,
		label: options.label,
		base: options.base,
		// Background work by default; ③ creates worktrees the user is not looking at.
		focus: false,
	});
	if (!response.ok) return response;

	const created = response.value;
	const path = created?.worktree?.path;
	const workspaceId = created?.workspace?.workspace_id;
	if (typeof path !== "string" || typeof workspaceId !== "string") {
		return err("worktree.create: no worktree path in the response");
	}

	const env = await propagateEnv(path, options.cwd, run);
	return ok({ path, workspaceId, branch: created.worktree.branch ?? undefined, env });
}

/**
 * Copy `.env*` from `sourceRoot` into `worktreePath` without overwriting
 * anything, then mirror the source's direnv trust for `.envrc`.
 */
export async function propagateEnv(
	worktreePath: string,
	sourceRoot: string,
	run: CommandRunner,
): Promise<EnvPropagation> {
	const copied: string[] = [];
	const skipped: string[] = [];
	const warnings: string[] = [];
	const result = (allowed: boolean): EnvPropagation => ({ copied, skipped, allowed, warnings });

	for (const name of envFiles(sourceRoot)) {
		const destination = join(worktreePath, name);
		// A tracked `.env.example` already exists here; the worktree's own copy wins.
		if (existsSync(destination)) {
			skipped.push(name);
			continue;
		}
		try {
			copyFileSync(join(sourceRoot, name), destination);
			copied.push(name);
		} catch (error) {
			warnings.push(`${name}: ${describe(error)}`);
		}
	}

	if (!copied.includes(".envrc")) {
		if (!skipped.includes(".envrc")) warnings.push(NOTICES.noEnvrc);
		return result(false);
	}

	if ((await run("direnv", ["version"], { timeout: PROBE_TIMEOUT_MS })).code !== 0) {
		warnings.push(NOTICES.noDirenv);
		return result(false);
	}

	const status = await run("direnv", ["status", "--json"], { cwd: sourceRoot, timeout: PROBE_TIMEOUT_MS });
	if (status.code !== 0) {
		warnings.push(NOTICES.noDirenv);
		return result(false);
	}
	if (!sourceIsAllowed(status.stdout)) {
		// The source never trusted this `.envrc`. Allowing it in the new worktree
		// would be a trust grant the user did not make.
		warnings.push(NOTICES.sourceNotAllowed);
		return result(false);
	}

	const allow = await run("direnv", ["allow", worktreePath], { timeout: DEFAULT_TIMEOUT_MS });
	if (allow.code !== 0) {
		warnings.push(`${NOTICES.allowFailed}: ${firstLine(allow.stderr) ?? `exit ${allow.code}`}`);
		return result(false);
	}
	return result(true);
}

/** `state.foundRC.allowed === 0` is direnv's "this .envrc is allowed". */
function sourceIsAllowed(statusJson: string): boolean {
	try {
		return JSON.parse(statusJson)?.state?.foundRC?.allowed === 0;
	} catch {
		return false;
	}
}

function envFiles(root: string): string[] {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	return names
		.filter((name) => {
			if (!name.startsWith(ENV_PREFIX)) return false;
			try {
				// Follow symlinks: a linked `.env` is common and still needs copying.
				return statSync(join(root, name)).isFile();
			} catch {
				return false;
			}
		})
		.sort();
}

const NOTICES = {
	noEnvrc: "the source has no .envrc, so nothing was allowed",
	noDirenv: "direnv is not usable here; the worktree's .envrc is not allowed",
	sourceNotAllowed: "the source .envrc is not allowed by direnv, so the new one is not either",
	allowFailed: "direnv allow failed",
};

function firstLine(text: string): string | undefined {
	return text.split("\n").find((line) => line.trim() !== "")?.trim();
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
