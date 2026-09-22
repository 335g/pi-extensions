/**
 * Self-check for the parts that only exist next to herdr: the transport, the
 * degradation paths, and how the broker reacts to events.
 * `node selfcheck.ts`
 *
 * A fake herdr server replaces the real socket, so this runs anywhere.
 */

import { rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { visibleWidth } from "@earendil-works/pi-tui";

import { ApprovalBroker, FleetOverlay, strings } from "./approvals.ts";
import { HerdrClient, type SubscribeEvent } from "./herdr-client.ts";

const assert = (condition: boolean, message: string) => {
	if (!condition) throw new Error(message);
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
}
