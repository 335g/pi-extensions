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
import { AuditLog, AUDIT_CUSTOM_TYPE, describe, registerAuditRenderer } from "./audit.ts";
import { cleanRun, fleetCleanTool } from "./clean.ts";
import { FleetViewOverlay, formatCost, formatTokens, gatherFleet } from "./fleet.ts";
import { fleetForkTool, forkWorktree } from "./fork.ts";
import { HerdrClient, type Outcome, type SubscribeEvent } from "./herdr-client.ts";
import { tokenize } from "./index.ts";
import { applyRecipe, listRecipes, saveRecipe } from "./recipes.ts";
import { fleetReviewTool, freeAgentName, readAuthorSession, reviewWorktree } from "./review.ts";
import {
	type RunRecord,
	fleetMergeTool,
	fleetStatusTool,
	fleetVerdictTool,
	mergeRun,
	readRun,
	runFileName,
	runState,
	runsDir,
	statusRuns,
	updateRun,
	writeRun,
} from "./runs.ts";
import { findScope, forkScopeIds, scopeIds } from "./scopes.ts";
import { contextTokens, readSessionSummary, readTail } from "./session.ts";
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
	cwd?: string;
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
/**
 * Set to have every `events.subscribe` refused: an older herdr that does not
 * know one of the types refuses the set every time, not once.
 */
let refuseAllSubscribes = false;
/** What `pane.wait_for_output` reports as the pane's snapshot. */
let waitText = "";
/**
 * The subscription types herdr accepts, and the ones that carry a `pane_id`.
 *
 * A fake that accepts anything is friendlier than herdr: a typo in the set the
 * broker builds (`pane.create` for `pane.created`) would be silently accepted
 * here and refused by the real server, so the whole subscription would be
 * refused in the field and nowhere in this file.
 */
const SUBSCRIPTION_TYPES = new Set(
	[
		"workspace.created workspace.updated workspace.metadata_updated workspace.renamed workspace.moved workspace.reordered",
		"workspace.closed workspace.focused worktree.created worktree.opened worktree.removed",
		"tab.created tab.closed tab.focused tab.renamed tab.moved",
		"pane.created pane.closed pane.updated pane.focused pane.moved pane.exited pane.agent_detected",
		"pane.output_matched pane.agent_status_changed pane.scroll_changed layout.updated",
	].flatMap((group) => group.split(" ")),
);
/** `pane.agent_status_changed` without a `pane_id` is `invalid_request`, measured. */
const PANE_SCOPED_TYPES = new Set(["pane.output_matched", "pane.agent_status_changed", "pane.scroll_changed"]);
/** `agent.start` failures, consumed one per call; empty means it succeeds. */
let startFaults: { code: string; message: string }[] = [];
/** What `worktree.list` reports. Set per test; empty means "no worktrees". */
let worktreeList: { path: string; branch: string; open_workspace_id: string | null }[] = [];
/** Set to have `worktree.remove` fail, the way herdr answers a workspace it no longer has. */
let worktreeRemoveError: { code: string; message: string } | undefined;

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
				case "pane.close":
					reply({ result: { type: "ok" } });
					break;
				case "boom":
					reply({ error: { code: "pane_not_found", message: "pane w9:p9 not found" } });
					break;
				case "events.subscribe": {
					// herdr deserializes the set before it looks anything up, so an
					// unknown type is refused here too.
					const set: { type: string; pane_id?: string }[] = request.params.subscriptions;
					const invalid = set.find(
						(subscription) =>
							!SUBSCRIPTION_TYPES.has(subscription.type) ||
							(PANE_SCOPED_TYPES.has(subscription.type) && typeof subscription.pane_id !== "string"),
					);
					if (invalid) {
						reply({ error: { code: "invalid_request", message: `invalid request: unknown variant \`${invalid.type}\`` } });
						break;
					}
					if (refuseAllSubscribes || refuseNextSubscribe) {
						refuseNextSubscribe = false;
						reply({ error: { code: "pane_not_found", message: "pane w1:p2 not found" } });
						break;
					}
					openSubscriptions.add(socket);
					reply({ result: { type: "subscription_started" } });
					break;
				}
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
				case "worktree.remove":
					if (worktreeRemoveError) reply({ error: worktreeRemoveError });
					else reply({ result: { type: "worktree_removed" } });
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
					if (fault) {
						reply({ error: fault });
						break;
					}
					// `agent_started` carries the argv it launched; the fake sends one too.
					reply({
						result: {
							type: "agent_started",
							agent: { pane_id: request.params.pane_id, name: request.params.name, agent: "pi", agent_status: "unknown" },
							argv: [],
						},
					});
					break;
				}
				case "agent.wait":
					// `agent_info`, as herdr answers it. An invented `agent_settled` would
					// let a caller branch on a type the real server never sends.
					reply({ result: { type: "agent_info", agent: { pane_id: request.params.target, agent_status: "idle" } } });
					break;
				case "silent":
					break; // never answers, so the timeout path is reachable
				default:
					reply({ error: { code: "invalid_request", message: `invalid request: unknown variant \`${request.method}\`` } });
			}
		}
	});
});

/** Push one event line to every open subscription. The envelope is `{event, data}`. */
function push(event: string, data: unknown): void {
	for (const socket of openSubscriptions) {
		socket.write(`${JSON.stringify({ event, data })}\n`);
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
	assert(!timedOut.ok && timedOut.code === "timeout", `a client timeout is not herdr's failure and must say so: ${JSON.stringify(timedOut)}`);

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
	const auditEntries: { type: string; data: ReturnType<typeof describe> }[] = [];
	const audit = new AuditLog((type, data) => auditEntries.push({ type, data }), "w1:p1");
	const broker = new ApprovalBroker(client, (entry) => notified.push(entry.pane_id), (event) => audit.record(event));
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

	// ------------------------------------------------------------ audit log

	// `describe` is the whole decision of what is worth keeping, so it is checked
	// against herdr's own event names and payloads before it is checked through
	// the broker. Both spellings are here: the pane-scoped subscriptions push the
	// dotted name, the lifecycle events push the schema's underscored kind.
	const worktreeCreated = describe({
		event: "worktree_created",
		data: { worktree: { branch: "feat/x", path: "/repo/wt" }, workspace: { workspace_id: "w9" } },
	});
	assert(worktreeCreated?.summary === "worktree created feat/x", `a worktree carries its branch: ${JSON.stringify(worktreeCreated)}`);
	assert(worktreeCreated?.branch === "feat/x" && worktreeCreated?.workspace_id === "w9", "the branch and the workspace are searchable on their own");
	const worktreeRemoved = describe({ event: "worktree_removed", data: { workspace_id: "w9", worktree: { branch: "feat/x" }, forced: true } });
	assert(worktreeRemoved?.summary === "worktree removed feat/x (forced)", `a forced removal says so: ${JSON.stringify(worktreeRemoved)}`);
	assert(describe({ event: "worktree_removed", data: { worktree: { branch: "feat/x" }, forced: false } })?.forced === false, "an unforced removal is not marked");
	const workspaceCreated = describe({ event: "workspace_created", data: { workspace: { workspace_id: "w9", label: "feat-x" } } });
	assert(workspaceCreated?.summary === "workspace created feat-x (w9)", `a workspace carries its label: ${JSON.stringify(workspaceCreated)}`);
	assert(describe({ event: "workspace_closed", data: { workspace_id: "w9" } })?.summary === "workspace closed w9", "a closed workspace is named by its id");
	const statusChanged = describe({
		event: "pane.agent_status_changed",
		data: { pane_id: "w6:p1", workspace_id: "w6", agent_status: "blocked", display_agent: "claude" },
	});
	assert(statusChanged?.summary === "w6:p1 blocked (claude)", `the dotted name is normalized, not missed: ${JSON.stringify(statusChanged)}`);
	assert(
		describe({ event: "pane_agent_status_changed", data: { pane_id: "w6:p1", agent_status: "blocked" } })?.event === "pane_agent_status_changed",
		"the underscored spelling describes the same event",
	);
	assert(describe({ event: "pane.agent_status_changed", data: {} }) === undefined, "a status event with nothing in it is not an entry");

	// Noise stays out twice over: the subscription never asks for it, and the
	// description refuses it even if it arrives.
	for (const ignored of [
		"pane_output_changed",
		"pane_output_matched",
		"pane_scroll_changed",
		"layout_updated",
		"pane_created",
		"pane_closed",
		"tab_closed",
		"workspace_focused",
	]) {
		assert(describe({ event: ignored, data: { pane_id: "w6:p1", agent_status: "blocked" } }) === undefined, `${ignored} must not become an entry`);
	}

	// Through the broker: the audit rides the one subscription, so a written
	// entry is proof that the event travelled the real path.
	auditEntries.length = 0;
	push("worktree_created", { worktree: { branch: "feat/audit", path: "/repo/audit" }, workspace: { workspace_id: "w9" } });
	push("pane.agent_status_changed", { pane_id: "w1:p2", workspace_id: "w1", agent_status: "blocked", display_agent: "claude" });
	// herdr re-announces a state after a reconnect; the log keeps the transition.
	push("pane.agent_status_changed", { pane_id: "w1:p2", workspace_id: "w1", agent_status: "blocked", display_agent: "claude" });
	// The pane this extension runs in is the session doing the logging.
	push("pane.agent_status_changed", { pane_id: "w1:p1", workspace_id: "w1", agent_status: "blocked" });
	await settle();
	await settle();
	assert(
		auditEntries.map((entry) => entry.data?.summary).join(" | ") === "worktree created feat/audit | w1:p2 blocked (claude)",
		`one entry per lifecycle event and per transition: ${JSON.stringify(auditEntries)}`,
	);
	assert(auditEntries.every((entry) => entry.type === AUDIT_CUSTOM_TYPE), "every entry carries the audit customType");
	const auditSubscriptions = received
		.filter((call) => call.method === "events.subscribe")
		.flatMap((call) => (call.params.subscriptions as { type: string }[]).map((subscription) => subscription.type));
	for (const wanted of ["worktree.created", "worktree.removed", "workspace.created", "workspace.closed"]) {
		assert(auditSubscriptions.includes(wanted), `the subscription set must carry ${wanted}: ${[...new Set(auditSubscriptions)].join(",")}`);
	}
	assert(
		!auditSubscriptions.some((type) => /output|scroll|layout/.test(type)),
		`no high-frequency type may be subscribed to: ${[...new Set(auditSubscriptions)].join(",")}`,
	);

	// The renderer folds an entry into one line: a log is scanned, not read.
	let renderer: ((entry: unknown, options: { expanded: boolean }, theme: unknown) => { render(width: number): string[] }) | undefined;
	registerAuditRenderer({ registerEntryRenderer: (_customType: string, value: never) => (renderer = value) } as never);
	const auditTheme = { fg: (_color: string, value: string) => value };
	const collapsed = renderer!({ data: worktreeCreated }, { expanded: false }, auditTheme).render(80);
	assert(
		collapsed.length === 1 && collapsed[0]!.includes("worktree created feat/x"),
		`an entry is one line: ${JSON.stringify(collapsed)}`,
	);
	assert(renderer!({ data: worktreeCreated }, { expanded: true }, auditTheme).render(80).length > 1, "expanded shows the payload");

	// An event type herdr does not know refuses the whole set, every time. Retrying
	// that set would spin, so the broker retries once — the set may only have named
	// a pane that vanished — and then gives up with the reason on screen.
	snapshot.panes.push({ pane_id: "w1:p8", workspace_id: "w1" });
	snapshot.agents.push({ pane_id: "w1:p8", workspace_id: "w1", agent: "pi", agent_status: "idle" });
	refuseAllSubscribes = true;
	const beforeRefused = received.filter((call) => call.method === "events.subscribe").length;
	push("pane_created", { pane: { pane_id: "w1:p8", workspace_id: "w1" } });
	await settle();
	await settle();
	const afterRefused = received.filter((call) => call.method === "events.subscribe").length;
	assert(afterRefused === beforeRefused + 2, `a permanently refused set must be retried once, not forever: ${afterRefused - beforeRefused}`);
	await settle();
	assert(
		received.filter((call) => call.method === "events.subscribe").length === afterRefused,
		"a set refused twice must stop being retried",
	);
	assert((broker.error() ?? "").includes("refused the same subscription set"), `the refusal must be surfaced: ${broker.error()}`);
	refuseAllSubscribes = false;

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

	// ------------------------------------------------------------ session summary

	// The fleet view reads each pane's session from the tail, so the whole file is
	// never in memory. What it takes out is the newest model, context, cost and
	// words — and it has to say when the tail cut the cost into a lower bound.
	const summaryPath = join(scratch, "fleet-summary.jsonl");
	const jsonLine = (value: unknown) => `${JSON.stringify(value)}\n`;
	writeFileSync(
		summaryPath,
		jsonLine({ type: "session", cwd: "/repo/wt" }) +
			jsonLine({ type: "model_change", provider: "p", modelId: "m" }) +
			jsonLine({ type: "message", message: { role: "user", content: [{ type: "text", text: "FIRST ASK" }] } }) +
			// A malformed line is skipped, wherever it sits; this one is in the middle
			// so the last two lines stay the newest user and assistant messages.
			"{ not json at all\n" +
			jsonLine({
				type: "message",
				message: {
					role: "assistant",
					provider: "p",
					model: "m",
					stopReason: "toolUse",
					usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { total: 0.001 } },
					content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }],
				},
			}) +
			jsonLine({ type: "message", message: { role: "user", content: [{ type: "text", text: "SECOND ASK\nwith newline" }] } }) +
			jsonLine({
				type: "message",
				message: {
					role: "assistant",
					provider: "p",
					model: "m2",
					stopReason: "stop",
					usage: { input: 200, output: 30, cacheRead: 0, cacheWrite: 10, totalTokens: 240, cost: { total: 0.002 } },
					content: [{ type: "thinking", thinking: "HIDDEN" }, { type: "text", text: "DONE" }],
				},
			}),
	);
	const summary = readSessionSummary(summaryPath);
	assert(summary.provider === "p" && summary.modelId === "m2", `the newest model wins: ${JSON.stringify(summary)}`);
	assert(summary.contextTokens === 240, `context is the newest usage, Pi's formula: ${summary.contextTokens}`);
	assert(Math.abs(summary.cost - 0.003) < 1e-9, `cost is the sum over the read range: ${summary.cost}`);
	assert(summary.lastUser === "SECOND ASK\nwith newline" && summary.lastAssistant === "DONE", "the newest user and assistant text are taken");
	assert(!summary.lastAssistant?.includes("HIDDEN"), "thinking is not assistant text");
	assert(summary.runningTool === undefined, "a text-only newest assistant message means nothing is running");
	assert(summary.cwd === "/repo/wt" && summary.assistantMessages === 2 && !summary.truncated, `the session is read whole: ${JSON.stringify(summary)}`);

	// A tool call in the *newest* assistant message is what is running now.
	const runningPath = join(scratch, "fleet-running.jsonl");
	writeFileSync(
		runningPath,
		jsonLine({
			type: "message",
			message: {
				role: "assistant",
				provider: "p",
				model: "m",
				stopReason: "toolUse",
				usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } },
				content: [{ type: "toolCall", name: "bash" }, { type: "toolCall", name: "grep" }],
			},
		}),
	);
	assert(readSessionSummary(runningPath).runningTool === "bash, grep", "the newest assistant message's tool calls are what is running");

	// Both caps: a line cap drops the oldest lines and says so, and a byte cap
	// smaller than one line reads nothing at all rather than half a record.
	const lineCapped = readSessionSummary(summaryPath, undefined, 2);
	assert(lineCapped.truncated && lineCapped.contextTokens === 240, `the line cap keeps the newest and flags itself: ${JSON.stringify(lineCapped)}`);
	assert(Math.abs(lineCapped.cost - 0.002) < 1e-9, `a cut read sums only what it saw: ${lineCapped.cost}`);
	assert(readSessionSummary(summaryPath, 8).truncated, "a tail smaller than a line is a cut read");
	assert(contextTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }) === 10, "context falls back to the four parts summed");
	assert(contextTokens({ totalTokens: 7, input: 1 }) === 7 && contextTokens({}) === 0, "totalTokens wins, and an empty usage is zero");

	// A session of megabytes is never read whole: the primitive is bounded, and the
	// summary of a file past the cap still comes from its newest line.
	const bigPath = join(scratch, "fleet-big.jsonl");
	writeFileSync(
		bigPath,
		`{"type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"${"x".repeat(300_000)}"}]}}\n`.repeat(10) +
			jsonLine({
				type: "message",
				message: {
					role: "assistant",
					provider: "p",
					model: "m3",
					stopReason: "stop",
					usage: { totalTokens: 5, cost: { total: 0.5 } },
					content: [{ type: "text", text: "BIG-TAIL" }],
				},
			}),
	);
	assert(readTail(bigPath, 1_000).length <= 1_000, "readTail never returns more than the bytes it was given");
	const big = readSessionSummary(bigPath);
	assert(
		big.truncated && big.lastAssistant === "BIG-TAIL" && big.modelId === "m3",
		`a session past the cap is read from its tail: ${JSON.stringify(big)}`,
	);

	// ------------------------------------------------------------ fleet view

	// A pane with a real session, a pane whose session cannot be read, and a pane
	// with no agent at all: the view lists all three, and the calling pane too.
	snapshot.panes.push(
		{ pane_id: "w1:p11", workspace_id: "w1" },
		{ pane_id: "w1:p12", workspace_id: "w1" },
		{ pane_id: "w1:p13", workspace_id: "w1" },
	);
	snapshot.agents.push(
		{
			pane_id: "w1:p11",
			workspace_id: "w1",
			agent: "pi",
			name: "worker",
			agent_status: "working",
			agent_session: { value: summaryPath },
			cwd: "/repo/wt",
		},
		{
			pane_id: "w1:p12",
			workspace_id: "w1",
			agent: "pi",
			name: "idle-one",
			agent_status: "idle",
			agent_session: { value: join(scratch, "gone.jsonl") },
			cwd: "/repo/other",
		},
	);
	worktreeList = [
		{ path: "/repo/wt", branch: "feat/view", open_workspace_id: "w1" },
		{ path: "/repo/other", branch: "main", open_workspace_id: "w2" },
	];
	const models = { find: (provider: string, modelId: string) => (provider === "p" && modelId === "m2" ? { contextWindow: 1_000 } : undefined) };
	const fleetRows = unwrap(await gatherFleet(client, { cwd: "/repo", selfPaneId: "w1:p11", models }), "gatherFleet");
	const selfRow = fleetRows.find((row) => row.paneId === "w1:p11")!;
	assert(fleetRows[0]!.paneId === "w1:p11" && selfRow.self, "the calling pane is first and marked as self");
	assert(selfRow.session?.modelId === "m2" && selfRow.contextWindow === 1_000, `the context window comes from the registry: ${JSON.stringify(selfRow)}`);
	assert(selfRow.branch === "feat/view" && selfRow.cwd === "/repo/wt", `the worktree branch is matched by cwd: ${JSON.stringify(selfRow)}`);
	const idleRow = fleetRows.find((row) => row.paneId === "w1:p12")!;
	assert(
		idleRow.status === "idle" && idleRow.session === undefined && typeof idleRow.sessionError === "string",
		`an unreadable session is a row that says so, not a throw: ${JSON.stringify(idleRow)}`,
	);
	const shellRow = fleetRows.find((row) => row.paneId === "w1:p13")!;
	assert(
		shellRow.sessionPath === undefined && shellRow.session === undefined && shellRow.status === "unknown",
		`a pane with no agent is still a row: ${JSON.stringify(shellRow)}`,
	);
	assert(fleetRows.some((row) => row.paneId === "w1:p1"), "every pane in the snapshot is listed");

	assert(formatTokens(950) === "950" && formatTokens(12_500) === "12.5k" && formatTokens(2_500_000) === "2.5M", "tokens are shown short");
	assert(
		formatCost(0.001, true) === "≥$0.0010" && formatCost(0.5, false) === "$0.50" && formatCost(0, false) === "$0",
		"a truncated cost is a lower bound and says so",
	);

	const viewOverlay = new FleetViewOverlay(client, strings(), { cwd: "/repo", selfPaneId: "w1:p11", models, maxLines: 2 });
	viewOverlay.attach({ terminal: { rows: 40, columns: width }, requestRender: () => {} } as never, theme as never, () => {});
	await viewOverlay.refresh();
	const viewLines = viewOverlay.render(width);
	const viewWidths = new Set(viewLines.map((line) => visibleWidth(line)));
	assert(viewWidths.size === 1 && viewWidths.has(width), `fleet view lines must all be ${width} wide: ${[...viewWidths]}`);
	const viewText = viewLines.join("\n");
	assert(viewText.includes(strings().viewSelf), "the self marker is on the screen");
	assert(viewText.includes(strings().viewNoSession), "a pane without a Pi session says so");
	assert(viewText.includes(strings().viewUnreadable), "a session that cannot be read is told apart from having none");
	// The pane id leads and the last user message follows it *before* the name and
	// the state, so a narrow pane keeps the meaning. Presence alone would pass on
	// the old order, so the positions are compared. The numbers are detail-only.
	const selfLine = viewLines.find((line) => line.includes("w1:p11"))!;
	const message = selfLine.indexOf("SECOND ASK");
	assert(selfLine.indexOf("w1:p11") < message, `the list row leads with the pane id: ${selfLine}`);
	assert(
		message < selfLine.indexOf("worker") && message < selfLine.indexOf("working"),
		`the last user message comes before the name and the state: ${selfLine}`,
	);
	const shellLine = viewLines.find((line) => line.includes("w1:p13"))!;
	assert(
		shellLine.split("w1:p13").length - 1 === 1,
		`a pane with no name and no agent shows its id once: ${shellLine}`,
	);
	assert(!viewText.includes("p/m2"), "the list does not carry the model: it is detail-only now");
	viewOverlay.handleInput("\r");
	const detail = viewOverlay.render(width).join("\n");
	assert(detail.includes(strings().viewModel) && detail.includes("p/m2"), `the detail view names the model: ${detail}`);
	assert(detail.includes(strings().viewContext), "the detail view carries the context tokens");
	assert(
		detail.includes(strings().viewCost) && detail.includes("≥"),
		"the detail carries the cost, and marks a truncated read as a lower bound",
	);
	assert(detail.includes(strings().viewBranch) && detail.includes("feat/view"), "the detail view names the worktree branch");
	assert(detail.split("w1:p11").length - 1 === 1, `the detail header names the pane id once: ${detail}`);

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
		reviewSeedText.includes("fleet_verdict") && reviewSeedText.includes(reviewScope.deliverable),
		"the verdict is a tool call, fixed in the seed",
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

	// The tool's own result — the worktree, the pane, the seed, the conversation
	// entry — is asserted end to end by `acceptance-fork.sh` §7. What is left for
	// the fake is the environment warning, which that run cannot stage: every
	// command fails here, so neither the environment nor the run record can be
	// written and both come back as warnings.
	rmSync(join(scratch, "checkout"), { recursive: true, force: true });
	mkdirSync(join(scratch, "checkout"), { recursive: true });
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
	// The linked case itself is asserted end to end by `acceptance-fork.sh` §10;
	// what is left here is that the main checkout is passed through unchanged.
	const mainPath = mkdtempSync(join(scratch, "main-"));
	const pinned = "a".repeat(40);

	mkdirSync(join(scratch, "checkout"), { recursive: true });
	answer = gitAnswer({
		"worktree list --porcelain": `worktree ${mainPath}\nHEAD ${pinned}\nbranch refs/heads/main\n\n`,
		"rev-parse --show-toplevel": `${mainPath}\n`,
		"rev-parse": `${pinned}\n`,
	});
	received.length = 0;
	const inPlace = unwrap(await createWorktree(client, run, { cwd: mainPath, branch: "feat/plain", base: "main" }), "createWorktree in the main checkout");
	const plainCall = received.filter((call) => call.method === "worktree.create").at(-1)!;
	assert(
		plainCall.params.cwd === mainPath && plainCall.params.base === pinned && inPlace.warnings.length === 0,
		`the main checkout is passed through with its fork point pinned to a commit: ${JSON.stringify(plainCall.params)}`,
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
	const reviewStart = received.filter((call) => call.method === "agent.start").at(-1)!;
	assert(reviewStart.params.name === "feat-review-review", `the reviewer needs its own agent name: ${JSON.stringify(reviewStart.params)}`);
	assert(
		reviewStart.params.args?.[0] === "-e" && String(reviewStart.params.args?.[1]).endsWith("index.ts"),
		`the reviewer must load this extension by path, so fleet_verdict exists even when it is not installed: ${JSON.stringify(reviewStart.params.args)}`,
	);

	// A send-back is a second review of the same branch, and herdr refuses an
	// agent name that is already taken. The first reviewer is still in the
	// snapshot, so the second review has to take the next suffix.
	assert((await freeAgentName(client, "feat/other", "review")) === "feat-other-review", "a free name is used as it is");
	snapshot.agents.push({ pane_id: "w1:p10", workspace_id: "w1", agent: "pi", name: "feat-review-review", agent_status: "idle" });
	snapshot.panes.push({ pane_id: "w1:p10", workspace_id: "w1" });
	assert((await freeAgentName(client, "feat/review", "review")) === "feat-review-review-2", "a taken name advances to -2");
	received.length = 0;
	const again = unwrap(await reviewWorktree(client, run, { cwd: "/repo", branch: "feat/review", task: "TASK-MARKER" }), "second reviewWorktree");
	assert(again.agent === "feat-review-review-2", `a second review must not reuse the first reviewer's name: ${again.agent}`);
	assert(
		received.filter((call) => call.method === "agent.start").at(-1)!.params.name === "feat-review-review-2",
		"the unique name is the one herdr is asked to start",
	);

	// A start herdr refuses must not leave the pane it was started in: the pane is
	// this call's own, and nothing else will ever close it.
	received.length = 0;
	startFaults = [{ code: "agent_name_taken", message: "agent name feat-review-review-2 is already used" }];
	const orphan = await reviewWorktree(client, run, { cwd: "/repo", branch: "feat/review", task: "TASK-MARKER" });
	assert(!orphan.ok && orphan.error.includes("was closed"), `a failed start must close its pane: ${JSON.stringify(orphan)}`);
	assert(
		received.some((call) => call.method === "pane.close" && call.params.pane_id === "w9:p2"),
		`the orphaned pane must be closed: ${JSON.stringify(received.map((call) => call.method))}`,
	);
	startFaults = [];

	// What the reviewer was given, and where its pane landed, is asserted end to
	// end by `acceptance-fork.sh` §9, which reads the reviewer's own session.

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

	// ------------------------------------------------------------ run records

	const runMain = mkdtempSync(join(scratch, "runs-main-"));
	assert(runFileName("feat/x-y") === "feat-x-y.json", `a branch becomes a file name: ${runFileName("feat/x-y")}`);
	const record: RunRecord = {
		branch: "feat/record",
		base: "abc",
		path: "/wt",
		workspaceId: "w9",
		paneId: "w1:p2",
		agentName: "feat-record",
		scope: "implementation",
		task: "TASK",
		createdAt: "2020-01-01T00:00:00.000Z",
	};
	writeRun(runMain, record);
	assert(readRun(runMain, "feat/record")?.task === "TASK", "a run must round-trip through its file");
	assert(readRun(runMain, "feat/other") === undefined, "a branch with no record reads as nothing");
	assert(
		runState(record, false) === "working" &&
			runState({ ...record, reviewer: { paneId: "w9:p2", agentName: "x" } }, false) === "unreviewed" &&
			runState({ ...record, verdict: { verdict: "approve", findings: [], at: "now" } }, false) === "approve" &&
			runState({ ...record, verdict: { verdict: "request-changes", findings: [], at: "now" } }, false) === "request-changes" &&
			runState(record, true) === "merged",
		"the state follows the reviewer, the verdict and the merge",
	);
	// The record is the only evidence left once the branch ref is gone. A cleaned
	// run must not fall back to its verdict: `approve` would invite a merge of a
	// branch that no longer exists.
	const approved: RunRecord = { ...record, verdict: { verdict: "approve", findings: [], at: "now" } };
	assert(runState({ ...approved, mergedAt: "now" }, false) === "merged", "mergedAt decides when the branch is gone");
	assert(runState({ ...approved, mergedAt: "now", cleanedAt: "later" }, false) === "cleaned", "a cleaned run reads as cleaned, not approve");
	assert(runState({ ...record, cleanedAt: "now" }, false) === "cleaned", "a force-cleaned unmerged run is cleaned too, not working");

	// ------------------------------------------------------------- merge gate

	const gateMain = mkdtempSync(join(scratch, "gate-main-"));
	const gateGit = (extra: Record<string, string> = {}) =>
		gitAnswer({ "worktree list --porcelain": `worktree ${gateMain}\nHEAD abc\nbranch refs/heads/main\n\n`, ...extra });

	answer = gateGit();
	writeRun(gateMain, { ...record, branch: "feat/gate" });
	runs.length = 0;
	const noVerdict = await mergeRun(run, { cwd: gateMain, branch: "feat/gate" });
	assert(
		!noVerdict.ok && noVerdict.error.includes("no approve verdict"),
		`the gate must refuse without an approve: ${JSON.stringify(noVerdict)}`,
	);
	assert(!(await mergeRun(run, { cwd: gateMain, branch: "feat/absent" })).ok, "a branch with no record must be refused");
	assert(!runs.some((call) => call.args[0] === "merge"), "a refused merge must not run git merge");

	updateRun(gateMain, "feat/gate", { verdict: { verdict: "approve", findings: [], at: "now" } });
	answer = gateGit({ "merge --no-edit feat/gate": "Fast-forward\n" });
	const merged = unwrap(await mergeRun(run, { cwd: gateMain, branch: "feat/gate" }), "mergeRun");
	assert(merged.verdict === "approve" && merged.output.includes("Fast-forward"), `an approved branch merges: ${JSON.stringify(merged)}`);
	assert(readRun(gateMain, "feat/gate")?.mergedAt !== undefined, "a merge is recorded on the run");

	answer = gateGit({ "status --porcelain --untracked-files=no": " M src/x.ts\n" });
	const dirty = await mergeRun(run, { cwd: gateMain, branch: "feat/gate" });
	assert(!dirty.ok && dirty.error.includes("uncommitted"), `a dirty checkout must refuse: ${JSON.stringify(dirty)}`);
	// Untracked files are not dirt: the run records themselves live under `.pi/`,
	// so a strict check would make the gate refuse its own state forever.
	assert(
		runs.some((call) => call.command === "git" && call.args.join(" ") === "status --porcelain --untracked-files=no"),
		`the gate must ignore untracked files: ${JSON.stringify(runs.map((call) => call.args.join(" ")))}`,
	);

	updateRun(gateMain, "feat/gate", { verdict: { verdict: "request-changes", findings: [], at: "now" } });
	answer = gateGit({ "merge --no-edit feat/gate": "" });
	assert((await mergeRun(run, { cwd: gateMain, branch: "feat/gate", force: true })).ok, "--force overrides a missing approve");

	// ------------------------------------------------------------ status tools

	// The rows are one function behind `fleet_status` and `/fleet status`; the two
	// callers only word them differently. One git question per run decides whether
	// it is merged, so a branch merged by hand still reads as merged.
	const listMain = mkdtempSync(join(scratch, "status-main-"));
	writeRun(listMain, { ...record, branch: "feat/working" });
	writeRun(listMain, { ...record, branch: "feat/approved", verdict: { verdict: "approve", findings: [], at: "now" } });
	writeRun(listMain, { ...record, branch: "feat/merged" });
	// A cleaned run whose branch is gone: git cannot answer, so the record has to.
	writeRun(listMain, {
		...record,
		branch: "feat/cleaned",
		verdict: { verdict: "approve", findings: [], at: "now" },
		mergedAt: "now",
		cleanedAt: "later",
	});
	answer = (command, args) => {
		if (command !== "git") return { stdout: "", stderr: "", code: 0, killed: false };
		if (args[0] === "worktree") return { stdout: `worktree ${listMain}\n\n`, stderr: "", code: 0, killed: false };
		if (args[0] === "merge-base") return { stdout: "", stderr: "", code: args[2] === "feat/merged" ? 0 : 1, killed: false };
		return { stdout: "", stderr: "", code: 0, killed: false };
	};
	const rows = await statusRuns(run, listMain);
	assert(
		rows.map((row) => `${row.branch} ${row.state} ${row.verdict}`).join(",") ===
			"feat/approved approve approve,feat/cleaned cleaned approve,feat/merged merged -,feat/working working -",
		`statusRuns lists every run with its state: ${JSON.stringify(rows)}`,
	);

	const statusTool = fleetStatusTool(run);
	assert(statusTool.name === "fleet_status", `the tool name is the API: ${statusTool.name}`);
	assert((statusTool.parameters as any).required === undefined, "fleet_status takes no arguments");
	const listed = await statusTool.execute("s1", {}, undefined, undefined, { mode: "tui", cwd: listMain } as never);
	assert(
		(listed.content[0] as { text: string }).text.split("\n").length === 4,
		`fleet_status returns one line per run: ${JSON.stringify(listed.content)}`,
	);

	// The merge tool turns the gate's refusal into a thrown error: a returned
	// value never sets the error flag, so the model has to see the merge fail.
	const mergeTool = fleetMergeTool(run);
	const mergeSchema = mergeTool.parameters as any;
	assert(
		mergeTool.name === "fleet_merge" && mergeSchema.required.join() === "branch" && mergeSchema.properties.force.type === "boolean",
		`fleet_merge takes a branch and an optional force: ${JSON.stringify(mergeSchema)}`,
	);
	answer = gitAnswer({ "worktree list --porcelain": `worktree ${gateMain}\n\n` });
	writeRun(gateMain, { ...record, branch: "feat/tool-merge" });
	let mergeRefusal = "";
	try {
		await mergeTool.execute("m1", { branch: "feat/tool-merge" }, undefined, undefined, { mode: "tui", cwd: gateMain } as never);
	} catch (error) {
		mergeRefusal = error instanceof Error ? error.message : String(error);
	}
	assert(mergeRefusal.includes("no approve verdict"), `fleet_merge refuses without an approve: ${JSON.stringify(mergeRefusal)}`);

	updateRun(gateMain, "feat/tool-merge", { verdict: { verdict: "approve", findings: [], at: "now" } });
	answer = gateGit({ "merge --no-edit feat/tool-merge": "Fast-forward\n" });
	const done = await mergeTool.execute("m2", { branch: "feat/tool-merge" }, undefined, undefined, { mode: "tui", cwd: gateMain } as never);
	assert(
		(done.content[0] as { text: string }).text.includes("merged feat/tool-merge") &&
			(done.content[0] as { text: string }).text.includes("worktree was left in place"),
		`fleet_merge reports the merge and the surviving worktree: ${JSON.stringify(done.content)}`,
	);

	// ---------------------------------------------------------------- verdict

	const entries: unknown[] = [];
	const verdictPi = { appendEntry: (type: string, data: unknown) => entries.push({ type, data }) } as never;
	const verdictTool = fleetVerdictTool(client, run, verdictPi);

	// A pane that is not the reviewer is refused end to end by
	// `acceptance-fork.sh` §12, where a real model calls the tool.
	const reviewerMain = mkdtempSync(join(scratch, "verdict-reviewer-"));
	answer = gitAnswer({ "worktree list --porcelain": `worktree ${reviewerMain}\n\n` });
	writeRun(reviewerMain, {
		...record,
		branch: "feat/verdict",
		reviewer: { paneId: client.selfPaneId(), agentName: "feat-verdict-review" },
	});
	const accepted = await verdictTool.execute(
		"v2",
		{ verdict: "approve", findings: [] },
		undefined,
		undefined,
		{ mode: "tui", cwd: reviewerMain } as never,
	);
	assert((accepted.content[0] as { text: string }).text.includes("recorded approve"), `the tool reports the verdict: ${JSON.stringify(accepted.content)}`);
	assert(readRun(reviewerMain, "feat/verdict")?.verdict?.verdict === "approve", "the recorded reviewer writes the verdict");
	assert(entries.length === 1, `the verdict is also a session entry: ${entries.length}`);

	// `request-changes` reaches the author: the findings go to the implementation
	// pane when it is still alive, and nothing is started when it is gone.
	received.length = 0;
	writeRun(reviewerMain, {
		...record,
		branch: "feat/sendback",
		paneId: "w1:p2",
		reviewer: { paneId: client.selfPaneId(), agentName: "r" },
	});
	const sentBack = await verdictTool.execute(
		"v3",
		{ verdict: "request-changes", findings: [{ path: "src/a.ts", line: 3, note: "NOPE" }] },
		undefined,
		undefined,
		{ mode: "tui", cwd: reviewerMain } as never,
	);
	const delivered = received.filter((call) => call.method === "pane.send_input").at(-1)!;
	assert(
		delivered.params.pane_id === "w1:p2" && delivered.params.text.includes("src/a.ts:3") && delivered.params.text.includes("NOPE"),
		`the findings must reach the author's pane: ${JSON.stringify(delivered.params)}`,
	);
	assert((sentBack.content[0] as { text: string }).text.includes("sent to the implementation session"), "the send-back is reported");

	received.length = 0;
	writeRun(reviewerMain, {
		...record,
		branch: "feat/dead",
		paneId: "w9:dead",
		reviewer: { paneId: client.selfPaneId(), agentName: "r" },
	});
	const dead = await verdictTool.execute(
		"v4",
		{ verdict: "request-changes", findings: [{ path: "a", note: "n" }] },
		undefined,
		undefined,
		{ mode: "tui", cwd: reviewerMain } as never,
	);
	assert((dead.content[0] as { text: string }).text.includes("is gone"), `a dead author must be reported, not replaced: ${JSON.stringify(dead.content)}`);
	assert(!received.some((call) => call.method === "pane.send_input"), "a dead author must not be sent to");

	// A verdict outside a TUI session is refused, like the other tools.
	const noTui = await (async () => {
		try {
			await verdictTool.execute("v5", { verdict: "approve", findings: [] }, undefined, undefined, { mode: "print", cwd: reviewerMain } as never);
			return "";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	})();
	assert(noTui.includes("interactive"), `outside a TUI the verdict tool refuses: ${noTui}`);

	// ---------------------------------------------------------------- clean

	// `fleet_clean` removes what a merged run left behind. The record and the
	// session are the audit trail and are kept; only the record's `cleanedAt`
	// says the rest is history. The worktree comes from the record, so a run with
	// no record cannot be cleaned at all.
	const cleanMain = mkdtempSync(join(scratch, "clean-main-"));
	let cleanMerged = false;
	let cleanBranchExists = true;
	let branchDeleteFails = false;
	answer = (command, args) => {
		if (command !== "git") return { stdout: "", stderr: "", code: 0, killed: false };
		if (args[0] === "worktree") return { stdout: `worktree ${cleanMain}\nHEAD abc\nbranch refs/heads/main\n\n`, stderr: "", code: 0, killed: false };
		if (args[0] === "merge-base") return { stdout: "", stderr: "", code: cleanMerged ? 0 : 1, killed: false };
		if (args[0] === "show-ref") return { stdout: "", stderr: "", code: cleanBranchExists ? 0 : 1, killed: false };
		if (args[0] === "branch" && branchDeleteFails) {
			return { stdout: "", stderr: "error: Cannot delete branch 'x' checked out at '/wt'", code: 1, killed: false };
		}
		return { stdout: "", stderr: "", code: 0, killed: false };
	};
	const cleanRecord: RunRecord = {
		...record,
		branch: "feat/clean",
		workspaceId: "w9",
		paneId: client.selfPaneId(),
		reviewer: { paneId: "w9:p2", agentName: "feat-clean-review" },
	};
	writeRun(cleanMain, cleanRecord);

	// Not merged, no force: refused, and nothing is touched.
	runs.length = 0;
	received.length = 0;
	const notMerged = await cleanRun(client, run, { cwd: cleanMain, branch: "feat/clean" });
	assert(!notMerged.ok && notMerged.error.includes("has not been merged"), `an unmerged run must be refused: ${JSON.stringify(notMerged)}`);
	assert(!received.some((call) => call.method === "worktree.remove" || call.method === "pane.close"), "a refused clean must not remove anything");
	assert(!runs.some((call) => call.command === "git" && call.args[0] === "branch"), "a refused clean must not delete the branch");
	assert(!(await cleanRun(client, run, { cwd: cleanMain, branch: "feat/no-record" })).ok, "a branch with no run record cannot be cleaned");

	// `force` cleans the unmerged run, and deletes the branch with -D.
	received.length = 0;
	const forced = unwrap(await cleanRun(client, run, { cwd: cleanMain, branch: "feat/clean", force: true }), "forced cleanRun");
	assert(forced.worktreeRemoved && forced.branchDeleted, `force cleans an unmerged run: ${JSON.stringify(forced)}`);
	const forcedRemove = received.filter((call) => call.method === "worktree.remove").at(-1)!;
	assert(
		forcedRemove.params.workspace_id === "w9" && forcedRemove.params.force === true,
		`the recorded workspace is removed: ${JSON.stringify(forcedRemove.params)}`,
	);
	const forcedBranch = runs.filter((call) => call.command === "git" && call.args[0] === "branch").at(-1)!;
	assert(forcedBranch.args.join(" ") === "branch -D feat/clean", `force deletes with -D: ${forcedBranch.args.join(" ")}`);

	// This session's own pane is never closed; the reviewer's is. The record is
	// kept and gains `cleanedAt` rather than being deleted.
	assert(forced.panesClosed.join() === "w9:p2", `only the recorded panes are closed: ${JSON.stringify(forced.panesClosed)}`);
	assert(!received.some((call) => call.method === "pane.close" && call.params.pane_id === client.selfPaneId()), "clean must not close this session's own pane");
	assert(readRun(cleanMain, "feat/clean")?.cleanedAt !== undefined, "the record survives and gains cleanedAt");
	assert(readFileSync(join(runsDir(cleanMain), runFileName("feat/clean")), "utf8").includes('"branch": "feat/clean"'), "the record file is not deleted");

	// Idempotent: a second clean is not an error even though everything is gone.
	cleanBranchExists = false;
	worktreeRemoveError = { code: "pane_not_found", message: "workspace w9 not found" };
	runs.length = 0;
	received.length = 0;
	const twice = unwrap(await cleanRun(client, run, { cwd: cleanMain, branch: "feat/clean" }), "idempotent cleanRun");
	assert(!twice.worktreeRemoved && !twice.branchDeleted, `a second clean finds nothing to remove: ${JSON.stringify(twice)}`);
	assert(twice.warnings.length > 0, "what was already gone is reported, not hidden");
	assert(!runs.some((call) => call.command === "git" && call.args[0] === "branch"), "a second clean does not delete the branch again");
	worktreeRemoveError = undefined;

	// Merged through git, with no `mergedAt`: the `--is-ancestor` fallback is what
	// opens the gate, so a branch merged by hand is cleanable too.
	cleanMerged = true;
	cleanBranchExists = true;
	writeRun(cleanMain, { ...cleanRecord, branch: "feat/clean-git" });
	runs.length = 0;
	const byGit = unwrap(await cleanRun(client, run, { cwd: cleanMain, branch: "feat/clean-git" }), "git-merged cleanRun");
	assert(byGit.branchDeleted, `an ancestor branch is cleanable without force: ${JSON.stringify(byGit)}`);
	assert(runs.filter((call) => call.command === "git" && call.args[0] === "branch").at(-1)!.args.join(" ") === "branch -d feat/clean-git", "without force the branch goes with -d");

	// The branch delete is where an incomplete cleanup surfaces: the worktree herdr
	// could not remove still has the branch checked out. git's own message blames
	// git, so the warnings collected before it have to travel in the error. The
	// client timed out rather than herdr answering, so herdr's own list is asked:
	// it still has the worktree, which is why the timeout stands.
	writeRun(cleanMain, { ...cleanRecord, branch: "feat/clean-fail" });
	branchDeleteFails = true;
	worktreeList = [{ path: cleanRecord.path, branch: "feat/clean-fail", open_workspace_id: "w9" }];
	worktreeRemoveError = { code: "timeout", message: "worktree.remove: no reply in 120000ms" };
	runs.length = 0;
	received.length = 0;
	const failed = await cleanRun(client, run, { cwd: cleanMain, branch: "feat/clean-fail" });
	assert(
		!failed.ok && failed.error.includes("was not removed") && failed.error.includes("Cannot delete branch"),
		`a branch-delete failure must carry the earlier warnings: ${JSON.stringify(failed)}`,
	);
	assert(received.some((call) => call.method === "worktree.list"), "a timeout is checked against herdr's own list");
	const failedRecord = readRun(cleanMain, "feat/clean-fail");
	assert(failedRecord?.cleanedAt === undefined, "an incomplete clean must not record cleanedAt");
	// The record is the audit trail: a cleanup that stopped half way has to say
	// which stages ran, or the panes closed and the worktree gone still read as an
	// untouched run. The message alone is not enough; this is the record's state.
	assert(
		failedRecord?.cleanError !== undefined &&
			failedRecord.cleanError.includes("Cannot delete branch") &&
			failedRecord.cleanError.includes("worktree removed: false"),
		`an incomplete clean records the reason and the stages that ran: ${JSON.stringify(failedRecord)}`,
	);
	branchDeleteFails = false;

	// The same client timeout, but herdr's list no longer has the worktree: the
	// removal did happen, so it is not a failure and the branch delete goes ahead.
	writeRun(cleanMain, { ...cleanRecord, branch: "feat/clean-slow" });
	cleanBranchExists = true;
	worktreeList = [];
	runs.length = 0;
	received.length = 0;
	const slow = unwrap(await cleanRun(client, run, { cwd: cleanMain, branch: "feat/clean-slow" }), "timed-out cleanRun");
	assert(slow.worktreeRemoved && slow.branchDeleted, `a removal herdr did finish counts as removed: ${JSON.stringify(slow)}`);
	assert(
		slow.warnings.some((warning) => warning.includes("did not answer")),
		`the slow answer is still reported: ${JSON.stringify(slow.warnings)}`,
	);
	assert(
		readRun(cleanMain, "feat/clean-slow")?.cleanedAt !== undefined,
		"a removal confirmed against herdr lets the clean finish",
	);
	worktreeRemoveError = undefined;

	// The tool is the path an agent drives; the schema carries the shape.
	const cleanTool = fleetCleanTool(client, run);
	const cleanSchema = cleanTool.parameters as any;
	assert(
		cleanTool.name === "fleet_clean" && cleanSchema.required.join() === "branch" && cleanSchema.properties.force.type === "boolean",
		`fleet_clean takes a branch and an optional force: ${JSON.stringify(cleanSchema)}`,
	);
	writeRun(cleanMain, { ...cleanRecord, branch: "feat/clean-tool" });
	cleanMerged = true;
	const cleanedTool = await cleanTool.execute("c1", { branch: "feat/clean-tool" }, undefined, undefined, { mode: "tui", cwd: cleanMain } as never);
	assert(
		(cleanedTool.content[0] as { text: string }).text.includes("cleaned feat/clean-tool") &&
			(cleanedTool.content[0] as { text: string }).text.includes("gained cleanedAt"),
		`the tool reports the cleanup and the surviving record: ${JSON.stringify(cleanedTool.content)}`,
	);

	// The tool reports failure by throwing, and refuses outside a TUI session.
	writeRun(cleanMain, { ...cleanRecord, branch: "feat/clean-refused" });
	cleanMerged = false;
	let cleanRefusal = "";
	try {
		await cleanTool.execute("c2", { branch: "feat/clean-refused" }, undefined, undefined, { mode: "tui", cwd: cleanMain } as never);
	} catch (error) {
		cleanRefusal = error instanceof Error ? error.message : String(error);
	}
	assert(cleanRefusal.includes("has not been merged"), `fleet_clean refuses an unmerged run: ${JSON.stringify(cleanRefusal)}`);
	let cleanNoTui = "";
	try {
		await cleanTool.execute("c3", { branch: "feat/clean-refused" }, undefined, undefined, { mode: "print", cwd: cleanMain } as never);
	} catch (error) {
		cleanNoTui = error instanceof Error ? error.message : String(error);
	}
	assert(cleanNoTui.includes("interactive"), `outside a TUI the clean tool refuses: ${cleanNoTui}`);

	// ------------------------------------------------------------ registration guard

	const registered = (env: Record<string, string | undefined>) => {
		const saved = { ...process.env };
		for (const [key, value] of Object.entries({ HERDR_ENV: undefined, HERDR_SOCKET_PATH: undefined, HERDR_PANE_ID: undefined })) {
			delete process.env[key];
		}
		Object.assign(process.env, env);
		const names: string[] = [];
		extension({
			registerEntryRenderer: (customType: string) => names.push(`entryRenderer:${customType}`),
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
			"entryRenderer:herdr-event,command:fleet,shortcut:ctrl+shift+a,on:session_start,on:session_shutdown",
		"inside herdr the extension must register the renderer, the command, the shortcut and both lifecycle events",
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
			registerEntryRenderer: () => {},
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
	assert((await toolsIn("tui")) === "fleet_fork,fleet_review,fleet_verdict,fleet_status,fleet_merge,fleet_clean", "an interactive session must register every tool");
	assert((await toolsIn("print")) === "", "a print session must register no tool");

	console.log("pi-herdr-fleet: ok");
} finally {
	server.close();
	rmSync(socketPath, { force: true });
	rmSync(scratch, { recursive: true, force: true });
}
