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
import { HerdrClient, type Outcome, type SubscribeEvent } from "./herdr-client.ts";
import { applyRecipe, listRecipes, saveRecipe } from "./recipes.ts";
import { type CommandResult, type CommandRunner, createWorktree, propagateEnv } from "./worktree.ts";

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
				case "agent.send_keys":
				case "agent.prompt":
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
							root_pane: {},
							worktree: { path: join(scratch, "checkout"), branch: request.params.branch, label: request.params.label ?? "", is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true },
						},
					});
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

	const unknown = await client.request("no.such_method", {});
	assert(!unknown.ok, "a method the server does not know must degrade");

	const timedOut = await client.request("silent", {}, 60);
	assert(!timedOut.ok && timedOut.error.includes("60ms"), `a missing reply must time out: ${JSON.stringify(timedOut)}`);

	const read = await client.agentRead("w1:p2", "detection");
	assert(read.ok && read.value.trim() === "question for w1:p2", `agent.read should return the text: ${JSON.stringify(read)}`);

	assert((await client.agentSendKeys("w1:p2", ["esc", "1"])).ok, "agent.send_keys should succeed");
	assert((await client.agentPrompt("w1:p2", "yes, go ahead")).ok, "agent.prompt should succeed");
	assert(
		received.some((call) => call.method === "agent.send_keys" && call.params.keys.join() === "esc,1"),
		"send_keys must carry the keys",
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

	console.log("pi-herdr-fleet: ok");
} finally {
	server.close();
	rmSync(socketPath, { force: true });
	rmSync(scratch, { recursive: true, force: true });
}
