/**
 * pi-herdr-fleet: connects herdr's pane/workspace topology to Pi's session
 * semantics.
 *
 * Phase 1 is the approval broker: herdr sees which panes are waiting on a
 * human, and this extension puts that list on the screen the human is already
 * looking at, so an approval can be answered without leaving the pane.
 *
 * Everything is gated on running inside a herdr-managed pane in interactive
 * mode. Outside that there is no socket to talk to and no terminal to draw in,
 * so nothing is registered at all.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

import { ApprovalBroker, FleetOverlay, strings } from "./approvals.ts";
import { HerdrClient } from "./herdr-client.ts";

interface Config {
	/** Announce panes that newly became blocked. */
	notify: boolean;
}

/** `<agent dir>/pi-herdr-fleet.json`. Anything unreadable means the defaults. */
function readConfig(): Config {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(getAgentDir(), "pi-herdr-fleet.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return { notify: true };
		const record = parsed as Record<string, unknown>;
		return { notify: record.notify !== false };
	} catch {
		return { notify: true };
	}
}

export default function (pi: ExtensionAPI) {
	// Registered only inside herdr; elsewhere the extension does not exist.
	// `ctx.mode` is not available here, so the interactive half of the guard
	// runs in `session_start` below.
	const client = HerdrClient.fromEnv();
	if (!client) return;

	let broker: ApprovalBroker | undefined;
	let config: Config = { notify: true };

	async function openFleet(ctx: ExtensionContext): Promise<void> {
		const current = broker;
		if (ctx.mode !== "tui" || !current) return;
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const overlay = new FleetOverlay(current, strings());
				overlay.attach(tui, theme, done);
				current.setOnChange(() => tui.requestRender());
				return overlay;
			},
			{ overlay: true, overlayOptions: { width: "70%", maxHeight: "80%", anchor: "center", margin: 1 } },
		);
		current.setOnChange(undefined);
	}

	pi.registerCommand("fleet", {
		description: "Panes waiting on a human, and answer them from here",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (args.trim() !== "") {
				ctx.ui.notify(strings().unknownArgs, "warning");
				return;
			}
			await openFleet(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+a", {
		description: "Panes waiting on a human (fleet)",
		handler: (ctx) => openFleet(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		// RPC and print modes have no PTY herdr can display and no terminal to
		// draw the overlay in, so the extension stays inert there.
		if (ctx.mode !== "tui") return;
		broker?.stop();
		config = readConfig();
		const t = strings();
		const next = new ApprovalBroker(client, (entry) => {
			if (!config.notify) return;
			ctx.ui.notify(t.blockedNotification(entry.name ?? entry.agent ?? entry.pane_id), "warning");
		});
		broker = next;
		await next.start();
	});

	pi.on("session_shutdown", () => {
		broker?.stop();
		broker = undefined;
	});
}
