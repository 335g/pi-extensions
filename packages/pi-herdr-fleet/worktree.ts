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
 *
 * The next thing a fresh worktree lacks is `node_modules`. `prepareWorktree`
 * opens a pane in the checkout and installs there, so the install runs in a
 * shell the user can watch instead of inside the main session's process.
 */

import { copyFileSync, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
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
const GIT_TIMEOUT_MS = 15_000;
/** The socket's own timeout has to outlast herdr's, or every install looks dead. */
const REQUEST_SLACK_MS = 10_000;
const AGENT_START_TIMEOUT_MS = 60_000;
const AGENT_SETTLE_TIMEOUT_MS = 30_000;
const AGENT_START_ATTEMPTS = 6;
const AGENT_START_RETRY_MS = 1_000;

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
	/** The workspace's original pane, still a shell at the checkout. */
	rootPaneId?: string;
	branch?: string | null;
	/** The ref the branch was cut from, when it is known. */
	base?: string;
	env: EnvPropagation;
	/** Warnings about the checkout itself, as opposed to its environment. */
	warnings: string[];
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
	const source = await resolveSource(run, options.cwd, options.base);
	if (!source.ok) return source;
	const response = await client.request("worktree.create", {
		cwd: source.value.cwd,
		branch: options.branch,
		label: options.label,
		base: source.value.base ?? options.base,
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

	// The environment comes from the caller's own checkout, not from the main one:
	// what a fork carries over is the environment it was started in.
	const env = await propagateEnv(path, options.cwd, run);
	const rootPaneId = created?.root_pane?.pane_id;
	return ok({
		path,
		workspaceId,
		rootPaneId: typeof rootPaneId === "string" ? rootPaneId : undefined,
		branch: created.worktree.branch ?? undefined,
		// The ref actually branched from: for a linked worktree the caller's own
		// HEAD was pinned to a commit, and that is what a review has to diff against.
		base: source.value.base ?? options.base,
		env,
		warnings: source.value.warnings,
	});
}

/**
 * The main checkout for `cwd`: the first entry of `git worktree list`. herdr
 * refuses a linked worktree as a worktree source, so callers that need "the
 * repository" — the run records in §3c — resolve through here.
 */
export async function mainCheckout(run: CommandRunner, cwd: string): Promise<string | undefined> {
	const worktrees = await gitWorktrees(run, cwd);
	return worktrees?.[0]?.path;
}

// ------------------------------------------------------- worktree source

interface WorktreeSource {
	/** What `worktree.create` is given as its `cwd`. */
	cwd: string;
	/** The commit to branch from: always a commit, never a symbolic ref. */
	base?: string;
	warnings: string[];
}

interface GitWorktree {
	path: string;
	branch?: string;
}

/**
 * Which checkout `worktree.create` may be told to branch from.
 *
 * herdr refuses a linked worktree as the source (`linked_worktree_source`), so a
 * fork started inside one is created from the main checkout instead — that is
 * the first entry of `git worktree list`.
 *
 * The cost of that detour is the fork point: `worktree.create` with no `base`
 * would branch from the main checkout's HEAD, which is not where the caller is.
 * So the caller's HEAD is resolved to a commit and passed as `base`. Uncommitted
 * changes cannot be part of a commit, so they are warned about rather than
 * silently left behind.
 */
async function resolveSource(run: CommandRunner, cwd: string, base: string | undefined): Promise<Outcome<WorktreeSource>> {
	const worktrees = await gitWorktrees(run, cwd);
	// Not a repository, or a git too old for `--porcelain`: let herdr report it.
	if (!worktrees || worktrees.length === 0) return ok({ cwd, warnings: [] });

	const main = worktrees[0]!;
	const toplevel = await git(run, ["rev-parse", "--show-toplevel"], cwd);
	const linked = toplevel.code === 0 && !samePath(toplevel.stdout.trim(), main.path);

	// The fork point is resolved to a commit in the caller's own checkout, for
	// two reasons. `HEAD` names each worktree's own commit, so the main checkout
	// may resolve it differently; and the commit is what §3c records, so a review
	// can diff a nested fork against its own fork point instead of the parent's.
	const pinned = await git(run, ["rev-parse", "--verify", "--quiet", base ?? "HEAD"], cwd);
	const commit = pinned.stdout.trim();
	if (pinned.code !== 0 || commit === "") return err(`worktree: cannot resolve ${base ?? "HEAD"} in ${cwd}`);

	if (!linked) return ok({ cwd, base: commit, warnings: [] });

	const warnings = [`created from the main checkout at ${main.path}: herdr cannot branch from a linked worktree`];
	const status = await git(run, ["status", "--porcelain"], cwd);
	if (status.code === 0 && status.stdout.trim() !== "") {
		warnings.push(`uncommitted changes in ${cwd} are not part of the fork`);
	}
	return ok({ cwd: main.path, base: commit, warnings });
}

/** `git worktree list --porcelain`, or nothing when git cannot answer. */
async function gitWorktrees(run: CommandRunner, cwd: string): Promise<GitWorktree[] | undefined> {
	const result = await git(run, ["worktree", "list", "--porcelain"], cwd);
	if (result.code !== 0) return undefined;
	const worktrees: GitWorktree[] = [];
	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("worktree ")) worktrees.push({ path: line.slice("worktree ".length).trim() });
		else if (line.startsWith("branch ")) worktrees.at(-1)!.branch = line.slice("branch ".length).trim();
	}
	return worktrees;
}

/** Symlinks differ between git and a caller's shell (`/tmp` against `/private/tmp`). */
function samePath(left: string, right: string): boolean {
	const resolve = (path: string) => {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	};
	return resolve(left) === resolve(right);
}

function git(run: CommandRunner, args: string[], cwd: string): Promise<CommandResult> {
	return run("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
}

// ---------------------------------------------------------------- preparation

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Lockfiles, most specific first. The first one found decides the installer. */
const LOCKFILES: [string, PackageManager][] = [
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["bun.lockb", "bun"],
	["bun.lock", "bun"],
	["package-lock.json", "npm"],
];

export interface InstallPlan {
	manager: PackageManager;
	lockfile: string;
	command: string;
}

/** Which install this checkout needs, or nothing when it has no lockfile. */
export function installPlan(root: string): InstallPlan | undefined {
	for (const [lockfile, manager] of LOCKFILES) {
		if (existsSync(join(root, lockfile))) return { manager, lockfile, command: `${manager} install` };
	}
	return undefined;
}

/**
 * The completion marker. It cannot be a literal in the script: the pane echoes
 * the command as it is typed, so a literal marker matches before the install has
 * run a single step. `$$` expands to digits in the output while the echoed line
 * keeps `$$`, and only the expanded form matches.
 */
const INSTALL_MARKER = "FLEET_INSTALL";
const INSTALL_MARKED = new RegExp(`${INSTALL_MARKER}_[0-9]+=([0-9]+)`);
const installScript = (command: string) => `fleet_t=${INSTALL_MARKER}_$$; ${command}; printf '%s=%s\\n' "$fleet_t" "$?"`;

/** Ten minutes: enough for a real install, short enough to give up eventually. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** The result of the install step, reported whether or not it finished. */
export interface InstallOutcome {
	command: string;
	lockfile: string;
	ok: boolean;
	/** Why it did not finish, when `ok` is false. */
	error?: string;
}

export interface WorktreePane {
	paneId: string;
	/** Absent when there was nothing to install, or installation was skipped. */
	install?: InstallOutcome;
}

export interface PrepareWorktreeOptions {
	/** The checkout the pane opens in. */
	path: string;
	workspaceId?: string;
	/** The worktree workspace's own pane, so the split cannot land elsewhere. */
	rootPaneId?: string;
	/** False for `--no-install`. */
	install: boolean;
	timeoutMs?: number;
}

/**
 * Open the pane the forked agent will run in, and install there first.
 *
 * The install is a shell command typed into that pane rather than an exec in
 * this process: its output belongs on the screen the user can switch to, and a
 * slow install must not be work the main session is doing.
 */
export async function prepareWorktree(
	client: HerdrClient,
	options: PrepareWorktreeOptions,
): Promise<Outcome<WorktreePane>> {
	const split = await client.request("pane.split", {
		direction: "right",
		cwd: options.path,
		workspace_id: options.workspaceId,
		target_pane_id: options.rootPaneId,
		focus: false,
	});
	if (!split.ok) return split;
	const paneId = split.value?.pane?.pane_id;
	if (typeof paneId !== "string") return err("pane.split: no pane id in the response");

	const plan = options.install ? installPlan(options.path) : undefined;
	if (!plan) return ok({ paneId });
	return ok({ paneId, install: await installInPane(client, paneId, plan, options.timeoutMs) });
}

/** A failed install is reported, not thrown: the worktree and the pane still exist. */
async function installInPane(
	client: HerdrClient,
	paneId: string,
	plan: InstallPlan,
	timeoutMs = INSTALL_TIMEOUT_MS,
): Promise<InstallOutcome> {
	const result = (ok: boolean, error?: string): InstallOutcome => ({
		command: plan.command,
		lockfile: plan.lockfile,
		ok,
		error,
	});

	const sent = await client.paneSendInput(paneId, installScript(plan.command));
	if (!sent.ok) return result(false, sent.error);

	const waited = await client.request(
		"pane.wait_for_output",
		{
			pane_id: paneId,
			source: "recent_unwrapped",
			match: { type: "regex", value: `${INSTALL_MARKER}_[0-9]+=[0-9]+` },
			timeout_ms: timeoutMs,
		},
		timeoutMs + REQUEST_SLACK_MS,
	);
	if (!waited.ok) return result(false, waited.error);

	// The wait hands back the snapshot that matched, so the exit status is here.
	const exit = INSTALL_MARKED.exec(waited.value?.read?.text ?? "")?.[1];
	if (exit === undefined) return result(false, "pane.wait_for_output: no exit status in the snapshot");
	return result(exit === "0", exit === "0" ? undefined : `${plan.command} exited ${exit}`);
}

/**
 * The agent name for a branch: `[a-z][a-z0-9_-]{0,31}` as herdr requires.
 * Unique agent names are what make `agent get` unambiguous later.
 *
 * `suffix` is what keeps two agents on the same branch apart, as a review of a
 * branch needs: an agent name is taken once, and the second `agent.start` with
 * the same name is refused rather than retried.
 */
export function agentName(branch: string, suffix = ""): string {
	const slug = branch
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "");
	const named = /^[a-z]/.test(slug) ? slug : `fork-${slug}`;
	const tail = suffix === "" ? "" : `-${suffix}`;
	const head = named.slice(0, AGENT_NAME_MAX - tail.length).replace(/[-_]+$/, "");
	return `${head === "" ? "fork" : head}${tail}`;
}

/** herdr's limit, not this extension's choice. */
const AGENT_NAME_MAX = 32;

// ---------------------------------------------------------------- agent start

/**
 * `agent.start`, then `agent.wait` for a settled state.
 *
 * Both halves are here because a real pane does not behave the way the API
 * reads. Measured against herdr and Pi:
 *
 * - `agent.start` answers `agent_pane_busy` while the pane's shell is still
 *   being recognised — the common case here, because the install just ran in
 *   that pane. A retry a second later succeeds, so a busy pane is waited out.
 * - herdr reports the agent ready about three seconds before the agent accepts
 *   input. A prompt sent inside that window lands in the editor and is never
 *   submitted: the trailing Enter is simply lost. Waiting for a settled state
 *   is what makes the seed arrive as a message.
 */
export async function startAgent(client: HerdrClient, options: StartAgentOptions): Promise<Outcome<void>> {
	const timeoutMs = options.timeoutMs ?? AGENT_START_TIMEOUT_MS;
	let last = "agent.start: no attempt was made";
	for (let attempt = 0; attempt < AGENT_START_ATTEMPTS; attempt += 1) {
		if (attempt > 0) await delay(AGENT_START_RETRY_MS);
		const started = await client.request(
			"agent.start",
			{
				name: options.name,
				kind: "pi",
				pane_id: options.paneId,
				...(options.args ? { args: options.args } : {}),
				timeout_ms: timeoutMs,
			},
			timeoutMs + REQUEST_SLACK_MS,
		);
		if (started.ok) return waitForAgent(client, options.paneId);
		last = started.error;
		// A name already taken, or a kind herdr does not know, will not change on
		// a retry; only the pane's shell is expected to settle.
		if (started.code !== "agent_pane_busy") return err(last, started.code);
	}
	return err(last);
}

export interface StartAgentOptions {
	paneId: string;
	name: string;
	/**
	 * Arguments for the agent itself, passed through to the agent's own CLI.
	 * `fleet_review` uses this to load this extension with `-e`, so the reviewer
	 * always has `fleet_verdict` even when the extension is not installed.
	 */
	args?: string[];
	timeoutMs?: number;
}

async function waitForAgent(client: HerdrClient, paneId: string): Promise<Outcome<void>> {
	const waited = await client.request(
		"agent.wait",
		{ target: paneId, until: ["idle", "done", "blocked"], timeout_ms: AGENT_SETTLE_TIMEOUT_MS },
		AGENT_SETTLE_TIMEOUT_MS + REQUEST_SLACK_MS,
	);
	return waited.ok ? ok(undefined) : waited;
}

/**
 * Deliver a seed as one message: the text through `pane.send_input`, then an
 * Enter, retried until the agent actually starts working.
 *
 * A seed is a long, multi-line paste. An Enter sent while the paste is still
 * being ingested is dropped, and the seed then sits in the editor forever — the
 * failure the acceptance test catches as "the seed never reached the forked
 * session". A fixed delay is a guess that a loaded machine breaks, so the
 * retry waits on herdr's own view of the agent instead: once it is working, the
 * seed arrived. `blocked` and `done` count too, because an agent that answered
 * immediately has also received it.
 */
export async function sendSeed(client: HerdrClient, paneId: string, text: string): Promise<Outcome<void>> {
	const typed = await client.paneSendInput(paneId, text, []);
	if (!typed.ok) return typed;
	let last = "the seed was typed but the agent never started working";
	for (let attempt = 0; attempt < SEED_SUBMIT_ATTEMPTS; attempt += 1) {
		await delay(SEED_SUBMIT_DELAY_MS);
		const pressed = await client.paneSendKeys(paneId, ["enter"]);
		if (!pressed.ok) return pressed;
		const accepted = await client.request(
			"agent.wait",
			{ target: paneId, until: ["working", "blocked", "done"], timeout_ms: SEED_ACCEPT_TIMEOUT_MS },
			SEED_ACCEPT_TIMEOUT_MS + REQUEST_SLACK_MS,
		);
		if (accepted.ok) return ok(undefined);
		last = accepted.error;
	}
	return err(last);
}

const SEED_SUBMIT_ATTEMPTS = 5;
const SEED_SUBMIT_DELAY_MS = 700;
const SEED_ACCEPT_TIMEOUT_MS = 4_000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
