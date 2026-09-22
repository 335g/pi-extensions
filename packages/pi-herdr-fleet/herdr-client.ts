/**
 * herdr-client: the transport layer over herdr's socket API.
 *
 * Newline-delimited JSON: `{id, method, params}` out, `{id, result}` or
 * `{id, error}` back. Pushed events reuse the same stream once a subscription
 * is acknowledged.
 *
 * Nothing here throws. herdr may be an older build, may be gone, or may be slow;
 * a caller that cannot reach it degrades to "no data" and Pi keeps working.
 */

import net from "node:net";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type ReadSource = "visible" | "recent" | "recent_unwrapped" | "detection";

/**
 * One entry of an `events.subscribe` request. `pane_id` is required by the
 * pane-scoped events (`pane.agent_status_changed`, `pane.scroll_changed`) and
 * rejected by the lifecycle events, so it is only ever set for the former.
 */
export interface Subscription {
	type: string;
	pane_id?: string;
}

export interface HerdrEvent {
	event: string;
	data: Record<string, any>;
}

/** The subset of `session.snapshot` this extension reads. */
export interface Snapshot {
	version: string;
	panes: { pane_id: string; workspace_id: string }[];
	agents: AgentInfo[];
}

export interface AgentInfo {
	pane_id: string;
	workspace_id: string;
	agent?: string | null;
	display_agent?: string | null;
	name?: string | null;
	agent_status: AgentStatus;
	state_labels?: Record<string, string>;
	/** Where the agent's own session lives, when herdr knows. */
	agent_session?: { value?: string | null } | null;
	cwd?: string | null;
}

/**
 * A request either produced a value or degraded. `code` is herdr's own error
 * code when it sent one (`agent_pane_busy`, `pane_not_found`, ...): the message
 * is for a human, so nothing should branch on its wording.
 */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

export function ok<T>(value: T): Outcome<T> {
	return { ok: true, value };
}

export function err<T = never>(error: string, code?: string): Outcome<T> {
	return code === undefined ? { ok: false, error } : { ok: false, error, code };
}

/** A pushed event, or the signal that the stream has to be rebuilt. */
export type SubscribeEvent =
	| { kind: "event"; event: HerdrEvent }
	/** `reconnect`: the transport dropped and came back. `refused`: herdr rejected
	 *  the set itself, so retrying it unchanged would never succeed. */
	| { kind: "resync"; reason: "reconnect" | "refused"; snapshot: Outcome<Snapshot> };

export interface SubscriptionHandle {
	close(): void;
}

const REQUEST_TIMEOUT_MS = 5_000;
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 15_000;

function endpoint(socketPath: string): string {
	return process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

let requestSeq = 0;

export class HerdrClient {
	private readonly socketPath: string;
	private readonly paneId: string;
	private readonly workspaceId: string | undefined;

	constructor(socketPath: string, paneId: string, workspaceId?: string) {
		this.socketPath = socketPath;
		this.paneId = paneId;
		this.workspaceId = workspaceId;
	}

	/** Undefined unless this process really runs inside a herdr-managed pane. */
	static fromEnv(): HerdrClient | undefined {
		const socketPath = process.env.HERDR_SOCKET_PATH;
		const paneId = process.env.HERDR_PANE_ID;
		if (process.env.HERDR_ENV !== "1" || !socketPath || !paneId) return undefined;
		return new HerdrClient(socketPath, paneId, process.env.HERDR_WORKSPACE_ID);
	}

	selfPaneId(): string {
		return this.paneId;
	}

	selfWorkspaceId(): string | undefined {
		return this.workspaceId;
	}

	/** One request on its own connection, so a lost reply cannot stall later calls. */
	request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Outcome<any>> {
		return new Promise((resolve) => {
			let settled = false;
			let buffer = "";
			let timer: ReturnType<typeof setTimeout> | undefined;
			const socket = net.createConnection(endpoint(this.socketPath));
			const finish = (outcome: Outcome<any>) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				socket.destroy();
				resolve(outcome);
			};

			timer = setTimeout(() => finish(err(`${method}: no reply in ${timeoutMs}ms`)), timeoutMs);
			timer.unref?.();
			socket.on("error", (error) => finish(err(`${method}: ${error.message}`)));
			socket.on("end", () => finish(err(`${method}: connection closed`)));
			socket.on("connect", () => {
				requestSeq += 1;
				socket.write(`${JSON.stringify({ id: `fleet:${requestSeq}`, method, params })}\n`);
			});
			socket.on("data", (chunk) => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				finish(parseResponse(buffer.slice(0, newline), method));
			});
		});
	}

	async snapshot(): Promise<Outcome<Snapshot>> {
		const response = await this.request("session.snapshot", {});
		if (!response.ok) return response;
		const snapshot = response.value?.snapshot;
		if (!snapshot) return err("session.snapshot: no snapshot in the response");
		return ok(snapshot as Snapshot);
	}

	/** The pane's rendered text. `detection` is herdr's own view of the prompt UI. */
	async agentRead(target: string, source: ReadSource, lines?: number): Promise<Outcome<string>> {
		const params = lines === undefined ? { target, source } : { target, source, lines };
		const response = await this.request("agent.read", params);
		if (!response.ok) return response;
		const text = response.value?.read?.text;
		if (typeof text !== "string") return err("agent.read: no text in the response");
		return ok(text);
	}

	/** Raw keystrokes into a pane: `1`, `enter`, `esc`, `up`, `ctrl+c`, ... */
	paneSendKeys(paneId: string, keys: string[]): Promise<Outcome<void>> {
		return this.expectOk("pane.send_keys", { pane_id: paneId, keys });
	}

	/**
	 * Literal text followed by keys, as one ordered submission.
	 *
	 * The agent-level write methods are the wrong tool for answering a dialog.
	 * `agent.prompt` refuses any pane herdr reports as blocked (`agent_blocked`)
	 * — which is every pane this extension can answer — and `agent.send_keys`
	 * refuses an agent reported through `pane.report_agent` (`agent_not_ready`),
	 * which is how hooks and plugins report state. The pane surface has neither
	 * check, and answering an approval dialog is intentional raw input.
	 */
	paneSendInput(paneId: string, text: string, keys: string[] = ["enter"]): Promise<Outcome<void>> {
		return this.expectOk("pane.send_input", { pane_id: paneId, text, keys });
	}

	/**
	 * Open a long-lived event stream. The subscription set is fixed for the life
	 * of one connection, so a caller whose set changes closes this handle and
	 * subscribes again.
	 *
	 * On a drop the stream reconnects with exponential backoff, resends the same
	 * set, and reports `resync` with a fresh snapshot so the caller can rebuild
	 * the state it derived from events.
	 */
	subscribe(subscriptions: Subscription[], onEvent: (event: SubscribeEvent) => void): SubscriptionHandle {
		let closed = false;
		let acknowledged = false;
		let reconnecting = false;
		let refused = false;
		let retryMs = INITIAL_RETRY_MS;
		let buffer = "";
		let socket: net.Socket | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const connect = () => {
			if (closed) return;
			acknowledged = false;
			buffer = "";
			socket = net.createConnection(endpoint(this.socketPath));
			socket.on("error", () => {
				// The close handler owns recovery; a connect error always closes.
			});
			socket.on("close", () => {
				// A refused set is a caller bug, not a transient drop: retrying it
				// unchanged would fail forever, so the caller gets one resync instead.
				if (closed || refused) return;
				timer = setTimeout(() => {
					reconnecting = true;
					connect();
				}, retryMs);
				timer.unref?.();
				retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
			});
			socket.on("connect", () => {
				requestSeq += 1;
				socket?.write(
					`${JSON.stringify({ id: `fleet:sub:${requestSeq}`, method: "events.subscribe", params: { subscriptions } })}\n`,
				);
			});
			socket.on("data", (chunk) => {
				buffer += chunk.toString();
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (line.trim() === "") continue;
					const parsed = parseJson(line);
					if (!parsed) continue;
					if (!acknowledged && parsed.result?.type === "subscription_started") {
						acknowledged = true;
						retryMs = INITIAL_RETRY_MS;
						if (reconnecting) {
							reconnecting = false;
							void this.snapshot().then((snapshot) => onEvent({ kind: "resync", reason: "reconnect", snapshot }));
						}
						continue;
					}
					if (!acknowledged && parsed.error) {
						refused = true;
						void this.snapshot().then((snapshot) => onEvent({ kind: "resync", reason: "refused", snapshot }));
						socket?.destroy();
						continue;
					}
					if (parsed.error || typeof parsed.event !== "string") continue;
					onEvent({ kind: "event", event: { event: parsed.event, data: parsed.data ?? {} } });
				}
			});
		};

		connect();
		return {
			close: () => {
				closed = true;
				if (timer) clearTimeout(timer);
				socket?.destroy();
			},
		};
	}

	private async expectOk(method: string, params: unknown): Promise<Outcome<void>> {
		const response = await this.request(method, params);
		return response.ok ? ok(undefined) : response;
	}
}

function parseJson(line: string): any | undefined {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

function parseResponse(line: string, method: string): Outcome<any> {
	const parsed = parseJson(line);
	if (!parsed) return err(`${method}: malformed response`);
	if (parsed.error) {
		const code = typeof parsed.error.code === "string" ? parsed.error.code : undefined;
		return err(`${method}: ${parsed.error.message ?? code ?? "error"}`, code);
	}
	return ok(parsed.result);
}
