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

import { ApprovalBroker, FleetOverlay, type Strings, strings } from "./approvals.ts";
import { AuditLog, registerAuditRenderer } from "./audit.ts";
import { cleanRun, fleetCleanTool } from "./clean.ts";
import { fleetForkTool, forkWorktree } from "./fork.ts";
import { HerdrClient } from "./herdr-client.ts";
import { applyRecipe, listRecipes, saveRecipe } from "./recipes.ts";
import { fleetReviewTool, reviewWorktree } from "./review.ts";
import { type RunState, fleetMergeTool, fleetStatusTool, fleetVerdictTool, mergeRun, statusRuns } from "./runs.ts";
import {
	type CommandRunner,
	type EnvPropagation,
	type InstallOutcome,
	createWorktree,
	mainCheckout,
} from "./worktree.ts";

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

/**
 * Split a command line into arguments, keeping quoted runs together.
 * `--task "two words"` has to arrive as one argument, not two.
 */
export function tokenize(args: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const character of args) {
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (current !== "") tokens.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	if (current !== "") tokens.push(current);
	return tokens;
}

function envSummary(env: EnvPropagation): string {
	const parts: string[] = [];
	if (env.copied.length > 0) parts.push(`copied ${env.copied.join(", ")}`);
	if (env.skipped.length > 0) parts.push(`kept ${env.skipped.join(", ")}`);
	parts.push(env.allowed ? "direnv allowed" : "direnv not allowed");
	return parts.join("; ");
}

function installSummary(install: InstallOutcome | undefined, t: Strings): string {
	if (!install) return t.forkNoInstall;
	if (install.ok) return t.forkInstalled(install.command);
	return t.forkInstallFailed(install.command, install.error ?? "");
}

/** The five states of §3c, in the reader's language. */
function stateLabel(state: RunState, t: Strings): string {
	if (state === "working") return t.stateWorking;
	if (state === "unreviewed") return t.stateUnreviewed;
	if (state === "merged") return t.stateMerged;
	// `approve` and `request-changes` are the verdict names themselves.
	return state;
}

export default function (pi: ExtensionAPI) {
	// Registered only inside herdr; elsewhere the extension does not exist.
	// `ctx.mode` is not available here, so the interactive half of the guard
	// runs in `session_start` below.
	const herdr = HerdrClient.fromEnv();
	if (!herdr) return;
	const client: HerdrClient = herdr;
	registerAuditRenderer(pi);

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

	async function forkCommand(rest: string[], ctx: ExtensionContext): Promise<void> {
		const t = strings();
		const [branch, ...tail] = rest;
		const { flags } = parseFlags(tail, ["task", "base", "scope", "no-install", "no-start"]);
		const task = flags.get("task");
		// Only the command line's own shape is checked here: a missing `--task` is a
		// typo in what was typed, and gets the usage line. What the fork itself needs
		// is validated in `forkWorktree`, because the tool's caller is a model.
		if (!branch || !task) {
			ctx.ui.notify(t.forkUsage, "warning");
			return;
		}

		ctx.ui.notify(t.forkCreating(branch), "info");
		const forked = await forkWorktree(client, run, {
			cwd: ctx.cwd,
			branch,
			task,
			base: flags.get("base") || undefined,
			scope: flags.get("scope") || undefined,
			install: !flags.has("no-install"),
			start: !flags.has("no-start"),
		});
		if (!forked.ok) {
			ctx.ui.notify(forked.error, "error");
			return;
		}

		const { env, install, path, session, workspaceId } = forked.value;
		const state =
			session === undefined ? t.forkNoStart : t.forkRunning(session.paneId, session.agent, installSummary(install, t));
		ctx.ui.notify(t.forkCreated(forked.value.branch, path, workspaceId, state), install?.ok === false ? "warning" : "info");
		for (const warning of forked.value.warnings) ctx.ui.notify(`${t.fleetWarningPrefix} ${warning}`, "warning");
		for (const warning of env.warnings) ctx.ui.notify(`${t.worktreeWarningPrefix} ${warning}`, "warning");
	}

	async function reviewCommand(rest: string[], ctx: ExtensionContext): Promise<void> {
		const t = strings();
		const [branch, ...tail] = rest;
		const { flags } = parseFlags(tail, ["task", "base"]);
		const task = flags.get("task");
		if (!branch || !task) {
			ctx.ui.notify(t.reviewUsage, "warning");
			return;
		}

		ctx.ui.notify(t.reviewStarting(branch), "info");
		const reviewed = await reviewWorktree(client, run, {
			cwd: ctx.cwd,
			branch,
			task,
			base: flags.get("base") || undefined,
		});
		if (!reviewed.ok) {
			ctx.ui.notify(reviewed.error, "error");
			return;
		}

		ctx.ui.notify(
			t.reviewStarted(reviewed.value.branch, reviewed.value.paneId, reviewed.value.agent, t.reviewMaterial(reviewed.value.diffChars, reviewed.value.authorMessages)),
			reviewed.value.warnings.length > 0 ? "warning" : "info",
		);
		for (const warning of reviewed.value.warnings) ctx.ui.notify(`${t.fleetWarningPrefix} ${warning}`, "warning");
	}

	async function statusCommand(ctx: ExtensionContext): Promise<void> {
		const t = strings();
		const main = await mainCheckout(run, ctx.cwd);
		if (!main) {
			ctx.ui.notify(t.notACheckout, "error");
			return;
		}
		// The rows come from `statusRuns`, which is also what `fleet_status`
		// returns; only the words differ, because this is read by a human.
		const rows = await statusRuns(run, main);
		if (rows.length === 0) {
			ctx.ui.notify(t.statusNone, "info");
			return;
		}
		// One message rather than one toast per run: the list is the point, and
		// toasts expire.
		const lines = [t.statusHeader, ...rows.map((row) => t.statusLine({ ...row, state: stateLabel(row.state, t) }))];
		ctx.ui.notify(lines.join("\n"), "info");
	}

	async function mergeCommand(rest: string[], ctx: ExtensionContext): Promise<void> {
		const t = strings();
		const [branch, ...tail] = rest;
		const { flags } = parseFlags(tail, ["force"]);
		if (!branch) {
			ctx.ui.notify(t.mergeUsage, "warning");
			return;
		}
		ctx.ui.notify(t.mergeStarting(branch), "info");
		const merged = await mergeRun(run, { cwd: ctx.cwd, branch, force: flags.has("force") });
		if (!merged.ok) {
			ctx.ui.notify(merged.error, "error");
			return;
		}
		ctx.ui.notify(t.mergeDone(merged.value.branch, merged.value.output), "info");
	}

	async function cleanCommand(rest: string[], ctx: ExtensionContext): Promise<void> {
		const t = strings();
		const [branch, ...tail] = rest;
		const { flags } = parseFlags(tail, ["force"]);
		if (!branch) {
			ctx.ui.notify(t.cleanUsage, "warning");
			return;
		}
		ctx.ui.notify(t.cleanStarting(branch), "info");
		const cleaned = await cleanRun(client, run, { cwd: ctx.cwd, branch, force: flags.has("force") });
		if (!cleaned.ok) {
			ctx.ui.notify(cleaned.error, "error");
			return;
		}
		const { worktreeRemoved, branchDeleted, panesClosed } = cleaned.value;
		ctx.ui.notify(t.cleanDone(branch, worktreeRemoved, branchDeleted, panesClosed.length), "info");
		for (const warning of cleaned.value.warnings) ctx.ui.notify(`${t.fleetWarningPrefix} ${warning}`, "warning");
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
		description: "Panes waiting on a human, layout recipes, worktrees, and forks",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const [group, ...rest] = tokenize(args);
			if (group === "recipe") return recipeCommand(rest, ctx);
			if (group === "worktree") return worktreeCommand(rest, ctx);
			if (group === "fork") return forkCommand(rest, ctx);
			if (group === "review") return reviewCommand(rest, ctx);
			if (group === "status") return statusCommand(ctx);
			if (group === "merge") return mergeCommand(rest, ctx);
			if (group === "clean") return cleanCommand(rest, ctx);
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
		// The tools are the primary way to run the loop, so they are registered with
		// the same guard as everything else: inside herdr, in an interactive session.
		pi.registerTool(fleetForkTool(client, run));
		pi.registerTool(fleetReviewTool(client, run));
		pi.registerTool(fleetVerdictTool(client, run, pi));
		pi.registerTool(fleetStatusTool(run));
		pi.registerTool(fleetMergeTool(run));
		pi.registerTool(fleetCleanTool(client, run));
		broker?.stop();
		config = readConfig();
		const t = strings();
		// The audit log (§6) rides the broker's subscription and writes what it is
		// given as session entries. Both live and die with the session, so a stale
		// pane's state is never carried into the next one.
		const audit = new AuditLog((customType, data) => pi.appendEntry(customType, data), client.selfPaneId());
		const next = new ApprovalBroker(
			client,
			(entry) => {
				if (!config.notify) return;
				ctx.ui.notify(t.blockedNotification(entry.name ?? entry.agent ?? entry.pane_id), "warning");
			},
			(event) => audit.record(event),
		);
		broker = next;
		await next.start();
	});

	pi.on("session_shutdown", () => {
		broker?.stop();
		broker = undefined;
	});
}
