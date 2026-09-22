/**
 * Self-check for the parts that only exist next to herdr: the transport, the
 * degradation paths, and how the broker reacts to events.
 * `node selfcheck.ts`
 *
 * A fake herdr server replaces the real socket, so this runs anywhere.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { visibleWidth } from "@earendil-works/pi-tui";

import { ApprovalBroker, FleetOverlay, strings } from "./approvals.ts";
import { fleetForkTool, forkWorktree } from "./fork.ts";
import { HerdrClient, type Outcome, type SubscribeEvent } from "./herdr-client.ts";
import { tokenize } from "./index.ts";
import { applyRecipe, listRecipes, saveRecipe } from "./recipes.ts";
import { fleetReviewTool, readAuthorSession, reviewWorktree } from "./review.ts";
import { findScope, forkScopeIds, scopeIds } from "./scopes.ts";
import {
	type CommandResult,
	type CommandRunner,
	agentName,
	createWorktree,
	installPlan,
	prepareWorktree,
	propagateEnv,
	startAgent,
} from "./worktree.ts";

const assert = (condition: boolean, message: string) => {
	if (!condition) throw new Error(message);
};

const unwrap = <T>(outcome: Outcome<T>, what: string): T => {
	if (!outcome.ok) throw new Error(`${what}: ${outcome.error}`);
	return outcome.value;
};

/** Temp directories are real: the environment copy is a filesystem operation. */
const scratch = mkdtempSync(join(tmpdir(), "pi-herdr-fleet-"));
const tree = {
	type: "split",
	direction: "right",
	ratio: 0.5,
	first: { type: "pane", pane_id: "w1:p1", cwd: "/repo", label: "left" },
	second: { type: "pane", pane_id: "w1:p2", cwd: "/repo", command: ["just", "test"], env: { ROLE: "tests" }, label: "tests" },
};

// ---------------------------------------------------------------- fake herdr

const socketPath = join(tmpdir(), `pi-herdr-fleet-${process.pid}.sock`);
rmSync(socketPath, { force: true });

interface FakeAgent {
	pane_id: string;
	workspace_id: string;
	agent?: string;
	name?: string;
	agent_status: string;
	state_labels?: Record<string, string>;
	agent_session?: { value: string };
}

/** Mutable: herdr's state is what the broker re-reads, so the test moves it. */
const snapshot: {
	version: string;
	panes: { pane_id: string; workspace_id: string }[];
	agents: FakeAgent[];
} = {
	version: "test",
	panes: [
		{ pane_id: "w1:p1", workspace_id: "w1" },
		{ pane_id: "w1:p2", workspace_id: "w1" },
		{ pane_id: "w1:p3", workspace_id: "w1" },
	],
	agents: [
		{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" },
		{
			pane_id: "w1:p2",
			workspace_id: "w1",
			agent: "pi",
			name: "reviewer",
			agent_status: "blocked",
			state_labels: { blocked: "approval" },
		},
		{ pane_id: "w1:p3", workspace_id: "w1", agent: "pi", agent_status: "blocked" },
	],
};

const received: { method: string; params: any }[] = [];
const openSubscriptions = new Set<net.Socket>();
/** Set to have the next `events.subscribe` refused, the way herdr refuses a vanished pane. */
let refuseNextSubscribe = false;
/** What `pane.wait_for_output` reports as the pane's snapshot. */
let waitText = "";
/** `agent.start` failures, consumed one per call; empty means it succeeds. */
let startFaults: { code: string; message: string }[] = [];
/** What `worktree.list` reports. Set per test; empty means "no worktrees". */
let worktreeList: { path: string; branch: string; open_workspace_id: string | null }[] = [];

const server = net.createServer((socket) => {
	let buffer = "";
	socket.on("error", () => {});
	socket.on("close", () => openSubscriptions.delete(socket));
	socket.on("data", (chunk) => {
		buffer += chunk.toString();
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (line.trim() === "") continue;
			const request = JSON.parse(line);
			received.push({ method: request.method, params: request.params });
			const reply = (payload: unknown) => socket.write(`${JSON.stringify({ id: request.id, ...(payload as object) })}\n`);

			switch (request.method) {
				case "session.snapshot":
					reply({ result: { type: "session_snapshot", snapshot } });
					break;
				case "agent.read":
					reply({ result: { type: "pane_read", read: { text: `  question for ${request.params.target}  ` } } });
					break;
				case "pane.send_keys":
				case "pane.send_input":
					reply({ result: { type: "ok" } });
					break;
				case "boom":
					reply({ error: { code: "pane_not_found", message: "pane w9:p9 not found" } });
					break;
				case "events.subscribe":
					if (refuseNextSubscribe) {
						refuseNextSubscribe = false;
						reply({ error: { code: "pane_not_found", message: "pane w1:p2 not found" } });
						break;
					}
					openSubscriptions.add(socket);
					reply({ result: { type: "subscription_started" } });
					break;
				case "layout.export":
					reply({
						result: {
							type: "layout_export",
							layout: { workspace_id: "w1", tab_id: "w1:t1", zoomed: false, focused_pane_id: "w1:p1", root: tree },
						},
					});
					break;
				case "layout.apply":
					reply({ result: { type: "layout_apply", layout: { workspace_id: "w1", tab_id: "w1:t9", zoomed: false, focused_pane_id: "w1:p9", root: request.params.root } } });
					break;
				case "worktree.create":
					reply({
						result: {
							type: "worktree_created",
							workspace: { workspace_id: "w9" },
							tab: {},
							root_pane: { pane_id: "w9:p1" },
							worktree: { path: join(scratch, "checkout"), branch: request.params.branch, label: request.params.label ?? "", is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true },
						},
					});
					break;
				case "worktree.list":
					reply({
						result: {
							type: "worktree_list",
							source: { repo_key: "/repo/.git", repo_name: "repo", repo_root: "/repo", source_checkout_path: "/repo" },
							worktrees: worktreeList,
						},
					});
					break;
				case "pane.split":
					reply({ result: { type: "pane_info", pane: { pane_id: "w9:p2", workspace_id: "w9" } } });
					break;
				case "pane.wait_for_output":
					reply({ result: { type: "output_matched", pane_id: request.params.pane_id, read: { text: waitText } } });
					break;
				case "agent.start": {
					const fault = startFaults.shift();
					if (fault) reply({ error: fault });
					else reply({ result: { type: "agent_started", agent: { pane_id: request.params.pane_id, name: request.params.name, agent: "pi", agent_status: "unknown" } } });
					break;
				}
				case "agent.wait":
					reply({ result: { type: "agent_settled", agent: { pane_id: request.params.target, agent_status: "idle" } } });
					break;
				default:
					break; // "silent": never answers, so the timeout path is reachable
			}
		}
	});
});

/** Push one event line to every open subscription. */
function push(event: string, data: unknown): void {
	for (const socket of openSubscriptions) {
		socket.write(`${JSON.stringify({ id: "push", event, data })}\n`);
	}
}

/** Let the socket layer flush and the client's microtasks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

await new Promise<void>((resolve) => server.listen(socketPath, resolve));

try {
	const client = new HerdrClient(socketPath, "w1:p1");

	// ------------------------------------------------------------ request paths

	const ok = await client.snapshot();
	assert(ok.ok && ok.value.agents.length === 3, "session.snapshot should return the snapshot");
	const failure = await client.request("boom", {});
	assert(!failure.ok && failure.error.includes("not found"), `an error response must degrade: ${JSON.stringify(failure)}`);
	assert(!failure.ok && failure.code === "pane_not_found", `herdr's error code must survive: ${JSON.stringify(failure)}`);

	const unknown = await client.request("no.such_method", {});
	assert(!unknown.ok, "a method the server does not know must degrade");

	const timedOut = await client.request("silent", {}, 60);
	assert(!timedOut.ok && timedOut.error.includes("60ms"), `a missing reply must time out: ${JSON.stringify(timedOut)}`);

	const read = await client.agentRead("w1:p2", "detection");
	assert(read.ok && read.value.trim() === "question for w1:p2", `agent.read should return the text: ${JSON.stringify(read)}`);

	assert((await client.paneSendKeys("w1:p2", ["esc", "1"])).ok, "pane.send_keys should succeed");
	assert((await client.paneSendInput("w1:p2", "yes, go ahead")).ok, "pane.send_input should succeed");
	assert(
		received.some((call) => call.method === "pane.send_keys" && call.params.keys.join() === "esc,1"),
		"send_keys must carry the keys",
	);
	assert(
		received.some(
			(call) => call.method === "pane.send_input" && call.params.text === "yes, go ahead" && call.params.keys.join() === "enter",
		),
		"send_input must submit the text followed by Enter",
	);

	// ------------------------------------------------------------ subscribe paths

	const events: SubscribeEvent[] = [];
	const handle = client.subscribe(
		[{ type: "pane.created" }, { type: "pane.agent_status_changed", pane_id: "w1:p2" }],
		(event) => events.push(event),
	);
	await settle();
	push("pane.agent_status_changed", { pane_id: "w1:p2", workspace_id: "w1", agent_status: "idle" });
	await settle();
	const pushed = events.find((event) => event.kind === "event");
	assert(
		pushed?.kind === "event" && pushed.event.event === "pane.agent_status_changed" && pushed.event.data.agent_status === "idle",
		`a pushed event must reach the caller: ${JSON.stringify(events)}`,
	);

	// Drop the stream server-side: the client must resubscribe and resync.
	for (const socket of openSubscriptions) socket.destroy();
	await new Promise((resolve) => setTimeout(resolve, 900));
	const resync = events.find((event) => event.kind === "resync");
	assert(
		resync?.kind === "resync" && resync.reason === "reconnect" && resync.snapshot.ok,
		`a reconnect must resync from a snapshot: ${JSON.stringify(events)}`,
	);
	assert(openSubscriptions.size === 1, `the client must reopen exactly one subscription: ${openSubscriptions.size}`);
	handle.close();

	// ------------------------------------------------------------ broker

	const notified: string[] = [];
	const broker = new ApprovalBroker(client, (entry) => notified.push(entry.pane_id));
	const byId = () => broker.entries().map((entry) => entry.pane_id).join();

	/** Move herdr's own state and emit the event, the way the server does. */
	const status = (pane_id: string, agent_status: string) => {
		const agent = snapshot.agents.find((candidate) => candidate.pane_id === pane_id);
		if (agent) agent.agent_status = agent_status;
		else snapshot.agents.push({ pane_id, workspace_id: "w1", agent: "pi", agent_status });
		push("pane.agent_status_changed", { pane_id, workspace_id: "w1", agent_status });
	};

	await broker.start();
	await settle();
	assert(byId() === "w1:p2,w1:p3", `only other panes count as blocked: ${byId()}`);
	assert(broker.entries().every((entry) => entry.question !== undefined), "a blocked pane's question must be read");
	assert(broker.entries()[0]!.name === "reviewer", "a named agent should be listed by its name");
	assert(notified.length === 0, "the first snapshot must not notify");

	status("w1:p2", "idle");
	status("w1:p3", "working");
	status("w1:p4", "blocked");
	await settle();
	assert(byId() === "w1:p4", `leaving blocked must drop a row: ${byId()}`);
	assert(notified.join() === "w1:p4", `a new blocked pane must notify: ${notified.join()}`);

	// A pane appeared: the broker re-reads the snapshot, which now agrees.
	snapshot.panes.push({ pane_id: "w1:p4", workspace_id: "w1" });
	push("pane_created", { pane: { pane_id: "w1:p4", workspace_id: "w1" } });
	await settle();
	await settle();
	assert(byId() === "w1:p4", `a snapshot refresh must keep the row: ${byId()}`);
	assert(notified.join() === "w1:p4", `a refresh must not re-announce a known pane: ${notified.join()}`);

	// A pane this extension runs in never appears: answering itself would deadlock.
	status("w1:p1", "blocked");
	await settle();
	assert(!broker.entries().some((entry) => entry.pane_id === "w1:p1"), "this pane must never list itself");

	// A closed pane leaves the list even before the snapshot is re-read.
	snapshot.panes = snapshot.panes.filter((pane) => pane.pane_id !== "w1:p4");
	snapshot.agents = snapshot.agents.filter((agent) => agent.pane_id !== "w1:p4");
	push("pane_closed", { pane_id: "w1:p4", workspace_id: "w1" });
	await settle();
	await settle();
	assert(byId() === "", `a closed pane must leave the list: ${byId()}`);

	// A pane that vanished between the snapshot and the subscribe makes herdr
	// refuse the whole set. Retrying it unchanged would fail forever, so the
	// broker has to rebuild the set from a fresh snapshot.
	snapshot.panes.push({ pane_id: "w1:p5", workspace_id: "w1" });
	snapshot.agents.push({ pane_id: "w1:p5", workspace_id: "w1", agent: "pi", agent_status: "working" });
	refuseNextSubscribe = true;
	push("pane_created", { pane: { pane_id: "w1:p9", workspace_id: "w1" } });
	await settle();
	await settle();
	await settle();
	// Only a live subscription can deliver this: w1:p6 is not in the snapshot.
	status("w1:p6", "blocked");
	await settle();
	assert(broker.entries().some((entry) => entry.pane_id === "w1:p6"), `a refused set must be rebuilt: ${byId()}`);

	const sentText = await broker.sendText("w1:p4", "approve");
	assert(sentText.ok, "sendText should succeed");
	assert((await broker.sendKeys("w1:p4", ["enter"])).ok, "sendKeys should succeed");
	assert((await broker.sendKeys("w1:p4", [])).ok === false, "an empty key list is a caller bug, not a send");
	assert(broker.error() === undefined, "a successful send must clear the error");
	await broker.sendText("w9:p9", "");
	broker.stop();

	// ------------------------------------------------------------ overlay

	const overlay = new FleetOverlay(broker, strings());
	const width = 80;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	overlay.attach({ terminal: { rows: 40, columns: width }, requestRender: () => {} } as never, theme as never, () => {});
	const lines = overlay.render(width);
	const widths = new Set(lines.map((line) => visibleWidth(line)));
	assert(widths.size === 1 && widths.has(width), `overlay lines must all be ${width} wide: ${[...widths]}`);
	assert(lines[0]!.startsWith("╭") && lines.at(-1)!.endsWith("╯"), "the overlay box must be closed");
	assert(lines.length <= 40, "the overlay must fit the terminal");

	// ------------------------------------------------------------ recipes

	const project = join(scratch, "project");
	mkdirSync(project, { recursive: true });

	const saved = unwrap(await saveRecipe(client, { cwd: project, name: "dev", paneId: "w1:p1" }), "saveRecipe");
	assert(saved.panes === 2, `the recipe should count both panes: ${saved.panes}`);
	const stored = JSON.parse(readFileSync(saved.path, "utf8"));
	assert(
		JSON.stringify(stored).includes("just") && stored.second.pane_id === undefined && stored.first.env === undefined,
		"the recipe keeps the tree but drops pane ids",
	);
	assert(
		unwrap(listRecipes(project), "listRecipes")
			.map((recipe) => `${recipe.name}:${recipe.panes}`)
			.join() === "dev:2",
		"ls should list the recipe",
	);
	assert(!(await saveRecipe(client, { cwd: project, name: "../escape", paneId: "w1:p1" })).ok, "a name must not escape the recipe directory");

	const applied = await applyRecipe(client, { cwd: project, name: "dev", start: false, workspaceId: "w1" });
	assert(applied.ok, `applyRecipe should succeed: ${JSON.stringify(applied)}`);
	const plain = received.filter((call) => call.method === "layout.apply").at(-1)!;
	assert(JSON.stringify(plain.params.root).includes("just") === false, "without --start the saved commands are dropped");
	assert(plain.params.tab_label === "dev" && plain.params.workspace_id === "w1", "apply must name the new tab and target the workspace");

	const started = await applyRecipe(client, { cwd: project, name: "dev", start: true, workspaceId: "w1" });
	assert(started.ok, "apply --start should succeed");
	assert(
		JSON.stringify(received.filter((call) => call.method === "layout.apply").at(-1)!.params.root).includes("just"),
		"with --start the saved commands are kept",
	);
	assert(!(await applyRecipe(client, { cwd: project, name: "missing", start: false })).ok, "an unknown recipe must fail");

	// ------------------------------------------------------------ worktree environment

	const runs: { command: string; args: string[]; cwd?: string }[] = [];
	let answer: (command: string, args: string[]) => CommandResult = () => ({ stdout: "", stderr: "", code: 0, killed: false });
	const run: CommandRunner = async (command, args, options) => {
		runs.push({ command, args, cwd: options?.cwd });
		return answer(command, args);
	};
	const direnv = (allowed: number) => {
		answer = (command, args) => {
			if (command !== "direnv") return { stdout: "", stderr: "", code: 0, killed: false };
			if (args[0] === "status") return { stdout: JSON.stringify({ state: { foundRC: { allowed } } }), stderr: "", code: 0, killed: false };
			return { stdout: "", stderr: "", code: 0, killed: false };
		};
	};
	const allows = () => runs.filter((call) => call.command === "direnv" && call.args[0] === "allow");
	const prepare = (files: Record<string, string>) => {
		const source = mkdtempSync(join(scratch, "source-"));
		const checkout = mkdtempSync(join(scratch, "checkout-"));
		for (const [name, content] of Object.entries(files)) writeFileSync(join(source, name), content);
		return { source, checkout };
	};

	// An allowed source is mirrored into the worktree.
	direnv(0);
	runs.length = 0;
	let dirs = prepare({ ".env": "TOKEN=1\n", ".envrc": "export A=1\n", ".env.example": "TOKEN=\n", "notes.md": "ignore me\n" });
	let env = await propagateEnv(dirs.checkout, dirs.source, run);
	assert(env.copied.join() === ".env,.env.example,.envrc", `only .env* is copied: ${env.copied.join()}`);
	assert(readFileSync(join(dirs.checkout, ".env"), "utf8") === "TOKEN=1\n", "the .env content must be copied");
	assert(env.allowed && allows().length === 1, `an allowed source must be allowed in the worktree: ${JSON.stringify(env)}`);
	assert(allows()[0]!.args[1] === dirs.checkout, "direnv allow must target the new worktree");
	assert(
		runs.some((call) => call.command === "direnv" && call.args[0] === "status" && call.cwd === dirs.source),
		"the trust check must read direnv's state for the source root",
	);

	// A source that is not allowed is never granted trust in the new worktree.
	direnv(1);
	runs.length = 0;
	dirs = prepare({ ".envrc": "export A=1\n" });
	env = await propagateEnv(dirs.checkout, dirs.source, run);
	assert(!env.allowed && allows().length === 0, `an unallowed source must not be allowed: ${JSON.stringify(env)}`);
	assert(env.warnings.length === 1, `the refusal has to be reported: ${JSON.stringify(env.warnings)}`);

	// An existing file in the worktree wins.
	direnv(0);
	runs.length = 0;
	dirs = prepare({ ".env": "TOKEN=from-source\n", ".envrc": "export A=1\n" });
	writeFileSync(join(dirs.checkout, ".env"), "TOKEN=worktree\n");
	env = await propagateEnv(dirs.checkout, dirs.source, run);
	assert(readFileSync(join(dirs.checkout, ".env"), "utf8") === "TOKEN=worktree\n", "nothing may be overwritten");
	assert(env.skipped.join() === ".env" && env.copied.join() === ".envrc", `skipped files must be reported: ${JSON.stringify(env)}`);

	// No .envrc, and no direnv, are warnings rather than failures.
	runs.length = 0;
	dirs = prepare({ ".env": "TOKEN=1\n" });
	env = await propagateEnv(dirs.checkout, dirs.source, run);
	assert(env.copied.join() === ".env" && env.warnings.length === 1 && runs.length === 0, "no .envrc is a warning, not a direnv call");

	runs.length = 0;
	answer = () => ({ stdout: "", stderr: "", code: 1, killed: false });
	dirs = prepare({ ".envrc": "export A=1\n" });
	env = await propagateEnv(dirs.checkout, dirs.source, run);
	assert(!env.allowed && env.warnings.length === 1 && allows().length === 0, `a missing direnv must only warn: ${JSON.stringify(env)}`);

	// createWorktree: herdr makes the checkout, then the environment follows.
	direnv(0);
	runs.length = 0;
	dirs = prepare({ ".env": "TOKEN=1\n", ".envrc": "export A=1\n" });
	mkdirSync(join(scratch, "checkout"), { recursive: true });
	const created = unwrap(await createWorktree(client, run, { cwd: dirs.source, branch: "feat/x", label: "x", base: "main" }), "createWorktree");
	assert(created.path.endsWith("checkout") && created.workspaceId === "w9", "the checkout path and workspace id come from herdr");
	assert(created.env.allowed, "the new worktree's environment must be propagated");
	const create = received.filter((call) => call.method === "worktree.create").at(-1)!;
	assert(
		create.params.cwd === dirs.source && create.params.branch === "feat/x" && create.params.base === "main" && create.params.focus === false,
		`worktree.create must not steal focus: ${JSON.stringify(create.params)}`,
	);

	// A failed environment step must not turn a created worktree into a failure.
	rmSync(join(scratch, "checkout"), { recursive: true, force: true });
	mkdirSync(join(scratch, "checkout"), { recursive: true });
	dirs = prepare({ ".env": "TOKEN=2\n", ".envrc": "export A=1\n" });
	answer = () => ({ stdout: "", stderr: "nope", code: 1, killed: false });
	const tolerated = await createWorktree(client, run, { cwd: dirs.source, branch: "feat/y" });
	assert(
		tolerated.ok && readFileSync(join(scratch, "checkout", ".env"), "utf8") === "TOKEN=2\n" && tolerated.value.env.warnings.length > 0,
		`a propagation failure is a warning, not a failure: ${JSON.stringify(tolerated)}`,
	);

	// ------------------------------------------------------------ fork preparation

	// The lockfile, and only the lockfile, decides the installer.
	const lockRoot = mkdtempSync(join(scratch, "lockfile-"));
	assert(installPlan(lockRoot) === undefined, "a checkout with no lockfile has nothing to install");
	writeFileSync(join(lockRoot, "package-lock.json"), "{}");
	assert(installPlan(lockRoot)?.command === "npm install", "package-lock.json selects npm");
	writeFileSync(join(lockRoot, "pnpm-lock.yaml"), "");
	assert(installPlan(lockRoot)?.manager === "pnpm", "pnpm wins over npm when both are present");
	rmSync(join(lockRoot, "pnpm-lock.yaml"));
	writeFileSync(join(lockRoot, "yarn.lock"), "");
	assert(installPlan(lockRoot)?.manager === "yarn", "yarn.lock selects yarn");
	rmSync(join(lockRoot, "yarn.lock"));
	writeFileSync(join(lockRoot, "bun.lockb"), "");
	assert(installPlan(lockRoot)?.manager === "bun", "bun.lockb selects bun");

	// herdr requires `[a-z][a-z0-9_-]{0,31}`; a branch is not that yet.
	assert(agentName("feat/pi-herdr-fleet-fork") === "feat-pi-herdr-fleet-fork", `a branch becomes a slug: ${agentName("feat/pi-herdr-fleet-fork")}`);
	assert(agentName("123-fix") === "fork-123-fix", `a name that starts with a digit needs a letter: ${agentName("123-fix")}`);
	assert(agentName("x".repeat(80)).length === 32, "an agent name is cut at 32 characters");
	for (const branch of ["Feat/Ünicode Branch!", "---", "", "feat/x"]) {
		assert(/^[a-z][a-z0-9_-]{0,31}$/.test(agentName(branch)), `every name must satisfy herdr: ${branch} -> ${agentName(branch)}`);
	}

	// The scope registry: one message, built from the task and the worktree.
	const implementation = findScope("implementation");
	assert(implementation !== undefined, "the implementation scope must be registered");
	assert(findScope("review") !== undefined, "the review scope is registered");
	assert(forkScopeIds().join() === "implementation", `a fork is offered only the forkable scopes: ${forkScopeIds()}`);
	assert(scopeIds() === "implementation, review", `the registry lists both scopes: ${scopeIds()}`);
	const seed = implementation!.seed({ task: "TASK-MARKER", path: "/wt", branch: "feat/x", base: "main" });
	assert(
		["TASK-MARKER", "/wt", "feat/x", "main", "Commit"].every((part) => seed.includes(part)),
		`the seed carries the task, the worktree and the done condition: ${seed}`,
	);
	assert(seed.split("\n").filter((line) => line.startsWith("worktree: ")).length === 1, "the worktree is named once");
	assert(implementation!.deliverable.length > 0 && seed.includes(implementation!.deliverable), "the deliverable is part of the brief");

	// The review seed carries the material no scope before it needed: what was
	// asked, what changed, and what the author said.
	const reviewScope = findScope("review")!;
	const reviewSeedText = reviewScope.seed({
		task: "REVIEW-TASK",
		path: "/wt",
		branch: "feat/x",
		base: "main",
		diff: "DIFF-MARKER",
		author: "AUTHOR-MARKER",
		authorSession: "/sessions/author.jsonl",
	});
	for (const part of ["REVIEW-TASK", "DIFF-MARKER", "AUTHOR-MARKER", "/wt", "feat/x", "main", "/sessions/author.jsonl"]) {
		assert(reviewSeedText.includes(part), `the review seed carries ${part}: ${reviewSeedText.slice(0, 400)}`);
	}
	assert(reviewSeedText.includes("read-only") || reviewSeedText.includes("Do not modify"), "the reviewer is told to leave the worktree alone");
	assert(
		reviewSeedText.includes("VERDICT: approve | request-changes") && reviewSeedText.includes(reviewScope.deliverable),
		"the verdict shape is fixed in the seed, because 3c has no tool to read yet",
	);
	const bareReview = reviewScope.seed({ task: "T", path: "/wt", branch: "b" });
	assert(bareReview.includes("(the diff is empty)"), "a review with no material says so instead of looking empty");

	// Quoted arguments survive the command line: `--task "two words"` is one argument.
	assert(tokenize('fork feat/x --task "two words"').join("|") === "fork|feat/x|--task|two words", "a double-quoted argument is one token");
	assert(tokenize("--task 'single quoted'").join("|") === "--task|single quoted", "a single-quoted argument is one token");
	assert(tokenize("  a   b  ").join("|") === "a|b", "plain whitespace still splits");
	assert(tokenize("").length === 0, "an empty line has no arguments");

	// prepareWorktree: split the pane, then install in it when a lockfile says to.
	const installs = () => received.filter((call) => call.method === "pane.send_input");
	waitText = "FLEET_INSTALL_1=0\n";
	let pane = unwrap(
		await prepareWorktree(client, { path: lockRoot, workspaceId: "w9", rootPaneId: "w9:p1", install: true, timeoutMs: 5_000 }),
		"prepareWorktree",
	);
	assert(pane.paneId === "w9:p2", `the pane id comes from pane.split: ${pane.paneId}`);
	assert(pane.install?.ok === true && pane.install.command === "bun install", `a finished install is reported: ${JSON.stringify(pane.install)}`);
	const split = received.filter((call) => call.method === "pane.split").at(-1)!;
	assert(
		split.params.cwd === lockRoot && split.params.workspace_id === "w9" && split.params.target_pane_id === "w9:p1" && split.params.focus === false,
		`the pane opens in the worktree without stealing focus: ${JSON.stringify(split.params)}`,
	);
	const install = installs().at(-1)!;
	assert(install.params.text.includes("FLEET_INSTALL_$$"), "the marker is built at runtime, never typed literally");
	assert(!/FLEET_INSTALL_[0-9]/.test(install.params.text), "the echoed command must not match the marker regex itself");
	assert(install.params.text.includes("bun install"), `the lockfile's installer is the one typed: ${install.params.text}`);

	// A failing install is a reported outcome, not an exception.
	waitText = "FLEET_INSTALL_1=7\n";
	pane = unwrap(await prepareWorktree(client, { path: lockRoot, install: true, timeoutMs: 5_000 }), "prepareWorktree");
	assert(pane.install?.ok === false && (pane.install.error ?? "").includes("7"), `a non-zero exit is a failure: ${JSON.stringify(pane.install)}`);

	waitText = "no marker here\n";
	pane = unwrap(await prepareWorktree(client, { path: lockRoot, install: true, timeoutMs: 5_000 }), "prepareWorktree");
	assert(pane.install?.ok === false, `a snapshot without the marker is a failure: ${JSON.stringify(pane.install)}`);

	// Nothing to install, and `--no-install`, both stop before typing anything.
	const bare = mkdtempSync(join(scratch, "bare-"));
	received.length = 0;
	pane = unwrap(await prepareWorktree(client, { path: bare, workspaceId: "w9", install: true }), "prepareWorktree");
	assert(pane.install === undefined && !received.some((call) => call.method === "pane.wait_for_output"), "no lockfile means no install");
	assert(received.some((call) => call.method === "pane.split"), "the pane is still opened without a lockfile");

	received.length = 0;
	pane = unwrap(await prepareWorktree(client, { path: lockRoot, install: false }), "prepareWorktree");
	assert(pane.install === undefined && installs().length === 0, "--no-install types nothing at all");

	// startAgent: herdr reports the pane busy for a moment after a command, and
	// reports the agent ready before it accepts input.
	received.length = 0;
	startFaults = [{ code: "agent_pane_busy", message: "agent target pane is not an available shell" }];
	unwrap(await startAgent(client, { paneId: "w9:p2", name: "feat-x" }), "startAgent");
	const starts = received.filter((call) => call.method === "agent.start");
	assert(starts.length === 2, `a busy pane must be retried: ${starts.length} attempts`);
	assert(
		starts[0]!.params.name === "feat-x" && starts[0]!.params.kind === "pi" && starts[0]!.params.pane_id === "w9:p2",
		`agent.start must name the agent and the pane: ${JSON.stringify(starts[0]!.params)}`,
	);
	assert(
		received.some((call) => call.method === "agent.wait" && call.params.target === "w9:p2" && call.params.until.join() === "idle,done,blocked"),
		"the agent must settle before a prompt is typed into it",
	);

	// A failure a retry cannot fix is reported instead of retried.
	received.length = 0;
	startFaults = [{ code: "agent_name_taken", message: "agent name is already in use" }];
	const refused = await startAgent(client, { paneId: "w9:p2", name: "feat-x" });
	assert(
		!refused.ok && refused.error.includes("already in use") && refused.code === "agent_name_taken",
		`an unfixable failure must be reported with its code: ${JSON.stringify(refused)}`,
	);
	assert(received.filter((call) => call.method === "agent.start").length === 1, "an unfixable failure must not be retried");

	// ------------------------------------------------------------ tool path

	// The schema is what a model's arguments are checked against before
	// `forkWorktree` sees them, so it has to carry the requirements itself.
	const tool = fleetForkTool(client, run);
	const schema = tool.parameters as any;
	assert(tool.name === "fleet_fork", `the tool name is the API: ${tool.name}`);
	assert(schema.required.join() === "branch,task", `branch and task must be required: ${JSON.stringify(schema.required)}`);
	assert(
		schema.properties.scope.enum.join() === forkScopeIds().join(),
		`the fork's scope enum is the forkable scopes: ${JSON.stringify(schema.properties.scope)}`,
	);
	assert(
		schema.properties.install.type === "boolean" && schema.properties.start.type === "boolean",
		"install and start are optional booleans",
	);

	// Empty arguments never reach herdr: the caller is a model, and a field it
	// filled with nothing is the shape a missing argument usually takes.
	received.length = 0;
	for (const request of [
		{ cwd: dirs.source, branch: "  ", task: "do it" },
		{ cwd: dirs.source, branch: "feat/x", task: "" },
		{ cwd: dirs.source, branch: "feat/x", task: "do it", scope: "nonsense" },
		// `review` is a scope, but a fork cannot build its seed: there is no diff yet.
		{ cwd: dirs.source, branch: "feat/x", task: "do it", scope: "review" },
	]) {
		const refused = await forkWorktree(client, run, request);
		assert(!refused.ok, `an invalid fork request must be refused: ${JSON.stringify(request)}`);
	}
	assert(received.length === 0, `a refused request must not reach herdr: ${JSON.stringify(received.map((call) => call.method))}`);

	// The tool path reaches the same herdr calls as the command, because both go
	// through forkWorktree.
	direnv(0);
	received.length = 0;
	startFaults = [];
	waitText = "FLEET_INSTALL_1=0\n";
	writeFileSync(join(scratch, "checkout", "package-lock.json"), "{}");
	const forked = await tool.execute(
		"call-1",
		{ branch: "feat/tool", task: "TOOL-MARKER" },
		undefined,
		undefined,
		{ mode: "tui", cwd: dirs.source } as never,
	);
	const report = (forked.content[0] as { text: string }).text;
	assert(report.includes("forked feat/tool") && report.includes("agent: feat-tool"), `the tool result must name the fork: ${report}`);
	assert(report.includes(join(scratch, "checkout")), `the tool result must name the worktree: ${report}`);
	assert(!report.includes("warning:") && !report.includes("copied"), `a clean fork says nothing about the environment: ${report}`);
	assert(
		received.some((call) => call.method === "worktree.create" && call.params.branch === "feat/tool") &&
			received.some((call) => call.method === "pane.send_input" && call.params.text.includes("TOOL-MARKER")),
		"the tool must create the worktree and send the seed",
	);
	assert((forked.details as { install?: { command: string } }).install?.command === "npm install", "the install is reported to the model");

	// An environment warning is the one thing about the environment the result
	// carries, because it is the one thing the caller may have to act on.
	rmSync(join(scratch, "checkout"), { recursive: true, force: true });
	mkdirSync(join(scratch, "checkout"), { recursive: true });
	writeFileSync(join(scratch, "checkout", "package-lock.json"), "{}");
	answer = () => ({ stdout: "", stderr: "nope", code: 1, killed: false });
	const warned = await tool.execute(
		"call-2",
		{ branch: "feat/tool-warn", task: "TOOL-MARKER" },
		undefined,
		undefined,
		{ mode: "tui", cwd: dirs.source } as never,
	);
	assert(
		(warned.content[0] as { text: string }).text.includes("warning:"),
		`an environment warning must reach the model: ${(warned.content[0] as { text: string }).text}`,
	);

	// A tool reports failure by throwing; a returned value never sets the error
	// flag, and the model has to know the fork did not happen.
	const refusal = async (params: Record<string, unknown>, mode = "tui") => {
		try {
			await tool.execute("call-x", params as never, undefined, undefined, { mode, cwd: dirs.source } as never);
			return "";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	};
	assert((await refusal({ branch: "", task: "" })).includes("required"), "an empty request must fail the tool call");
	assert((await refusal({ branch: "feat/x", task: "do it" }, "print")).includes("interactive"), "outside a TUI session the tool refuses");

	// ------------------------------------------------------------ linked worktree

	/** git's answers: one helper, so each test states only the answers it needs. */
	const gitAnswer = (responses: Record<string, string>) => (command: string, args: string[]) => {
		const stdout = command === "git" ? responses[args.join(" ")] ?? responses[args[0]!] ?? "" : "";
		return { stdout, stderr: "", code: 0, killed: false };
	};

	// `worktree.create` refuses a linked worktree as its source, so the call is
	// redirected to the main checkout with the caller's own HEAD pinned as base —
	// without the pin the fork point would silently move to the main checkout.
	const mainPath = mkdtempSync(join(scratch, "main-"));
	const linkedPath = mkdtempSync(join(scratch, "linked-"));
	const pinned = "a".repeat(40);
	answer = gitAnswer({
		"worktree list --porcelain": `worktree ${mainPath}\nHEAD ${pinned}\nbranch refs/heads/main\n\nworktree ${linkedPath}\nHEAD ${pinned}\nbranch refs/heads/feat/outer\n\n`,
		"rev-parse --show-toplevel": `${linkedPath}\n`,
		"rev-parse": `${pinned}\n`,
		status: " M file.txt\n",
	});
	received.length = 0;
	const relocated = unwrap(
		await createWorktree(client, run, { cwd: linkedPath, branch: "feat/inner" }),
		"createWorktree from a linked worktree",
	);
	const relocatedCall = received.filter((call) => call.method === "worktree.create").at(-1)!;
	assert(relocatedCall.params.cwd === mainPath, `the source must be the main checkout: ${JSON.stringify(relocatedCall.params)}`);
	assert(relocatedCall.params.base === pinned, `the caller's HEAD must be pinned: ${JSON.stringify(relocatedCall.params)}`);
	assert(relocated.warnings.length === 2, `the detour and the uncommitted changes must be reported: ${JSON.stringify(relocated.warnings)}`);

	// From the main checkout nothing is redirected, and an explicit base is kept.
	mkdirSync(join(scratch, "checkout"), { recursive: true });
	answer = gitAnswer({
		"worktree list --porcelain": `worktree ${mainPath}\nHEAD ${pinned}\nbranch refs/heads/main\n\n`,
		"rev-parse --show-toplevel": `${mainPath}\n`,
	});
	received.length = 0;
	const inPlace = unwrap(await createWorktree(client, run, { cwd: mainPath, branch: "feat/plain", base: "main" }), "createWorktree in the main checkout");
	const plainCall = received.filter((call) => call.method === "worktree.create").at(-1)!;
	assert(
		plainCall.params.cwd === mainPath && plainCall.params.base === "main" && inPlace.warnings.length === 0,
		`the main checkout is passed through untouched: ${JSON.stringify(plainCall.params)}`,
	);

	// ------------------------------------------------------------ author session

	// The author's session is JSONL and grows to megabytes, so only the assistant
	// text is taken and both a line and a character cap are applied — from the end,
	// because the report is the newest message.
	const sessionPath = join(scratch, "author.jsonl");
	const sessionLine = (message: unknown) => `${JSON.stringify({ type: "message", message })}\n`;
	writeFileSync(
		sessionPath,
		sessionLine({ role: "user", content: [{ type: "text", text: "SEED-MARKER" }] }) +
			sessionLine({ role: "assistant", content: [{ type: "text", text: "FIRST" }] }) +
			sessionLine({ role: "assistant", content: [{ type: "thinking", thinking: "HIDDEN" }, { type: "text", text: "SECOND" }] }) +
			sessionLine({ role: "assistant", content: [{ type: "text", text: "THIRD\nline two" }] }) +
			"{ not json at all\n",
	);
	const excerpt = readAuthorSession(sessionPath);
	assert(excerpt.messages === 3 && !excerpt.truncated, `all three assistant messages fit: ${JSON.stringify(excerpt)}`);
	assert(excerpt.text.includes("FIRST") && excerpt.text.includes("SECOND") && excerpt.text.includes("THIRD"), "the assistant text must be extracted");
	assert(!excerpt.text.includes("SEED-MARKER") && !excerpt.text.includes("HIDDEN"), "neither the user nor the thinking is the author's text");
	const byLines = readAuthorSession(sessionPath, 6);
	assert(byLines.truncated && byLines.text.includes("THIRD") && !byLines.text.includes("FIRST"), `the line cap keeps the newest: ${JSON.stringify(byLines)}`);
	const byChars = readAuthorSession(sessionPath, 100, 60);
	assert(byChars.truncated && byChars.text.includes("THIRD") && !byChars.text.includes("FIRST"), `the character cap keeps the newest: ${JSON.stringify(byChars)}`);
	assert(readAuthorSession(sessionPath, 100, 30).text.includes("earlier messages omitted"), "a message larger than the budget is cut, and says so");

	// Both caps bound what is delivered, separators and the omission marker
	// included. Counting only the messages' own lines would deliver 1500 lines of
	// seed for a session of 300 one-line messages.
	const manyPath = join(scratch, "many.jsonl");
	writeFileSync(
		manyPath,
		Array.from({ length: 400 }, (_, index) => sessionLine({ role: "assistant", content: [{ type: "text", text: `M${index}` }] })).join(""),
	);
	const capped = readAuthorSession(manyPath);
	assert(capped.truncated && capped.messages < 400, `a long session is cut: ${capped.messages} messages`);
	assert(capped.text.split("\n").length <= 300, `the excerpt is at most 300 lines: ${capped.text.split("\n").length}`);
	assert(capped.text.length <= 20_000, `the excerpt is at most 20000 characters: ${capped.text.length}`);
	assert(capped.text.includes("M399") && !capped.text.includes("M0"), "the newest message survives and the oldest does not");

	// ------------------------------------------------------------ review

	snapshot.agents.push({
		pane_id: "w1:p7",
		workspace_id: "w1",
		agent: "pi",
		name: "feat-review",
		agent_status: "idle",
		agent_session: { value: sessionPath },
	});
	snapshot.panes.push({ pane_id: "w1:p7", workspace_id: "w1" });
	worktreeList = [{ path: "/repo/wt", branch: "feat/review", open_workspace_id: "w1" }];
	answer = gitAnswer({ "rev-parse": "cafe\n", diff: "DIFF-MARKER\n" });
	received.length = 0;
	startFaults = [];
	const reviewed = unwrap(await reviewWorktree(client, run, { cwd: "/repo", branch: "feat/review", task: "TASK-MARKER" }), "reviewWorktree");
	assert(reviewed.path === "/repo/wt" && reviewed.workspaceId === "w1", `the review runs in the author's worktree: ${JSON.stringify(reviewed)}`);
	assert(reviewed.authorPaneId === "w1:p7" && reviewed.authorSession === sessionPath, `the author is found by its agent name: ${JSON.stringify(reviewed)}`);
	assert(reviewed.base === "cafe" && reviewed.diffChars === "DIFF-MARKER\n".length, `the diff is taken against the main checkout's HEAD: ${JSON.stringify(reviewed)}`);
	const reviewSplit = received.find((call) => call.method === "pane.split")!;
	assert(
		reviewSplit.params.cwd === "/repo/wt" && reviewSplit.params.workspace_id === "w1" && reviewSplit.params.target_pane_id === "w1:p7",
		`the review pane must land in the author's worktree: ${JSON.stringify(reviewSplit.params)}`,
	);
	const reviewStart = received.filter((call) => call.method === "agent.start").at(-1)!;
	assert(reviewStart.params.name === "feat-review-review", `the reviewer needs its own agent name: ${JSON.stringify(reviewStart.params)}`);
	const reviewSeed = received.filter((call) => call.method === "pane.send_input").at(-1)!.params.text as string;
	for (const material of ["TASK-MARKER", "DIFF-MARKER", "THIRD", "/repo/wt", "VERDICT: approve | request-changes"]) {
		assert(reviewSeed.includes(material), `the seed must carry the review material (${material}): ${reviewSeed.slice(0, 400)}`);
	}
	assert(!reviewSeed.includes("SEED-MARKER"), "the author's seed is not the author's report");

	// Nothing is started for a request that cannot be reviewed.
	worktreeList = [];
	received.length = 0;
	for (const bad of [
		{ cwd: "/repo", branch: "  ", task: "t" },
		{ cwd: "/repo", branch: "feat/review", task: " " },
		{ cwd: "/repo", branch: "feat/nope", task: "t" },
	]) {
		const refused = await reviewWorktree(client, run, bad);
		assert(!refused.ok, `an unanswerable review must be refused: ${JSON.stringify(bad)}`);
	}
	worktreeList = [{ path: "/repo/wt", branch: "feat/closed", open_workspace_id: null }];
	assert(!(await reviewWorktree(client, run, { cwd: "/repo", branch: "feat/closed", task: "t" })).ok, "a worktree with no workspace has nowhere to review");
	assert(
		received.every((call) => call.method === "worktree.list"),
		`a refused review must not open a pane or start an agent: ${JSON.stringify(received.map((call) => call.method))}`,
	);

	// The tool's arguments come from a model, so the schema carries the shape.
	const reviewTool = fleetReviewTool(client, run);
	assert(reviewTool.name === "fleet_review", `the tool name is the API: ${reviewTool.name}`);
	assert(
		(reviewTool.parameters as any).required.join() === "branch,task",
		`branch and task must be required: ${JSON.stringify((reviewTool.parameters as any).required)}`,
	);
	assert(findScope("review") !== undefined && !forkScopeIds().includes("review"), "review is a scope, but not one a fork can be asked for");

	// ------------------------------------------------------------ registration guard

	const registered = (env: Record<string, string | undefined>) => {
		const saved = { ...process.env };
		for (const [key, value] of Object.entries({ HERDR_ENV: undefined, HERDR_SOCKET_PATH: undefined, HERDR_PANE_ID: undefined })) {
			delete process.env[key];
		}
		Object.assign(process.env, env);
		const names: string[] = [];
		extension({
			registerCommand: (name: string) => names.push(`command:${name}`),
			registerShortcut: (key: string) => names.push(`shortcut:${key}`),
			on: (event: string) => names.push(`on:${event}`),
		} as never);
		process.env = saved;
		return names.join();
	};

	const extension = (await import("./index.ts")).default;
	assert(registered({}) === "", "outside herdr the extension must register nothing");
	assert(
		registered({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/not-used.sock" }) ===
			"command:fleet,shortcut:ctrl+shift+a,on:session_start,on:session_shutdown",
		"inside herdr the extension must register the command, the shortcut and both lifecycle events",
	);
	assert(registered({ HERDR_ENV: "1" }) === "", "a missing socket path must keep the extension inert");
	assert(registered({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }) === "", "a missing socket path must keep the extension inert");

	// The tool is registered from `session_start`, so it only exists in the modes
	// that have a terminal: print and RPC modes can never call it.
	const toolsIn = async (mode: string): Promise<string> => {
		const saved = { ...process.env };
		Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "w1:p1" });
		const names: string[] = [];
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		extension({
			registerCommand: () => {},
			registerShortcut: () => {},
			registerTool: (definition: { name: string }) => names.push(definition.name),
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(event, handler),
		} as never);
		await handlers.get("session_start")!({}, { mode, ui: { notify: () => {} } });
		await handlers.get("session_shutdown")!({}, {});
		process.env = saved;
		return names.join();
	};
	assert((await toolsIn("tui")) === "fleet_fork,fleet_review", "an interactive session must register both tools");
	assert((await toolsIn("print")) === "", "a print session must register no tool");

	console.log("pi-herdr-fleet: ok");
} finally {
	server.close();
	rmSync(socketPath, { force: true });
	rmSync(scratch, { recursive: true, force: true });
}
