/**
 * pi-herdr-fleet: connects herdr's pane/workspace topology to Pi's session
 * semantics.
 *
 * Phase 1 is the approval broker: herdr sees which panes are waiting on a
 * human, and this extension puts that list on the screen the human is already
 * looking at, so an approval can be answered without leaving the pane.
 *
 * Phase 2 adds the layout recipes and worktree creation, both reachable from
 * the same `/fleet` command.
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
import { applyRecipe, listRecipes, saveRecipe } from "./recipes.ts";
import { type CommandRunner, type EnvPropagation, createWorktree } from "./worktree.ts";

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

/** `--flag value` and bare `--flag` pairs, left to right. */
function parseFlags(args: string[], known: string[]): { flags: Map<string, string>; rest: string[] } {
	const flags = new Map<string, string>();
	const rest: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		if (!argument.startsWith("--")) {
			rest.push(argument);
			continue;
		}
		const [name, inline] = argument.slice(2).split("=", 2);
		if (!known.includes(name!)) {
			rest.push(argument);
			continue;
		}
		const next = args[index + 1];
		if (inline !== undefined) flags.set(name!, inline);
		else if (next !== undefined && !next.startsWith("--")) {
			flags.set(name!, next);
			index += 1;
		} else flags.set(name!, "");
	}
	return { flags, rest };
}

function envSummary(env: EnvPropagation): string {
	const parts: string[] = [];
	if (env.copied.length > 0) parts.push(`copied ${env.copied.join(", ")}`);
	if (env.skipped.length > 0) parts.push(`kept ${env.skipped.join(", ")}`);
	parts.push(env.allowed ? "direnv allowed" : "direnv not allowed");
	return parts.join("; ");
}

export default function (pi: ExtensionAPI) {
	// Registered only inside herdr; elsewhere the extension does not exist.
	// `ctx.mode` is not available here, so the interactive half of the guard
	// runs in `session_start` below.
	const herdr = HerdrClient.fromEnv();
	if (!herdr) return;
	const client: HerdrClient = herdr;

	const run: CommandRunner = (command, args, options) => pi.exec(command, args, options);

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

	async function recipeCommand(rest: string[], ctx: ExtensionContext): Promise<void> {
		const t = strings();
		const [verb, name, ...tail] = rest;
		switch (verb) {
			case "save": {
				if (!name) {
					ctx.ui.notify(t.recipeUsage, "warning");
					return;
				}
				ctx.ui.notify(t.recipeSaving(name), "info");
				const saved = await saveRecipe(client, { cwd: ctx.cwd, name, paneId: client.selfPaneId() });
				if (!saved.ok) {
					ctx.ui.notify(saved.error, "error");
					return;
				}
				ctx.ui.notify(t.recipeSaved(name, saved.value.panes, saved.value.path), "info");
				return;
			}
			case "apply": {
				if (!name) {
					ctx.ui.notify(t.recipeUsage, "warning");
					return;
				}
				const { flags } = parseFlags(tail, ["start"]);
				const applied = await applyRecipe(client, {
					cwd: ctx.cwd,
					name,
					start: flags.has("start"),
					workspaceId: client.selfWorkspaceId(),
				});
				if (!applied.ok) {
					ctx.ui.notify(applied.error, "error");
					return;
				}
				ctx.ui.notify(t.recipeApplied(name, applied.value.panes), "info");
				return;
			}
			case "ls":
			case undefined: {
				const recipes = listRecipes(ctx.cwd);
				if (!recipes.ok) {
					ctx.ui.notify(recipes.error, "error");
					return;
				}
				ctx.ui.notify(recipes.value.length === 0 ? t.recipeNone : t.recipeList(recipes.value), "info");
				return;
			}
			default:
				ctx.ui.notify(t.recipeUsage, "warning");
		}
	}

	async function worktreeCommand(rest: string[], ctx: ExtensionContext): Promise<void> {
		const t = strings();
		const [verb, branch, ...tail] = rest;
		if (verb !== "create" || !branch) {
			ctx.ui.notify(t.worktreeUsage, "warning");
			return;
		}
		const { flags } = parseFlags(tail, ["base", "label"]);
		ctx.ui.notify(t.worktreeCreating(branch), "info");
		const created = await createWorktree(client, run, {
			cwd: ctx.cwd,
			branch,
			base: flags.get("base") || undefined,
			label: flags.get("label") || undefined,
		});
		if (!created.ok) {
			ctx.ui.notify(created.error, "error");
			return;
		}
		const { env, path, workspaceId } = created.value;
		ctx.ui.notify(t.worktreeCreated(branch, path, workspaceId, envSummary(env)), env.warnings.length > 0 ? "warning" : "info");
		// A worktree with no environment is the failure this module exists to prevent.
		for (const warning of env.warnings) ctx.ui.notify(`${t.worktreeWarningPrefix} ${warning}`, "warning");
	}

	pi.registerCommand("fleet", {
		description: "Panes waiting on a human, layout recipes, and worktrees",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const [group, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (group === "recipe") return recipeCommand(rest, ctx);
			if (group === "worktree") return worktreeCommand(rest, ctx);
			if (group !== undefined) {
				ctx.ui.notify(strings().unknownSubcommand(group), "warning");
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
