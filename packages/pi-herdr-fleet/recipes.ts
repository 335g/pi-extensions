/**
 * recipes: save and restore a tab layout.
 *
 * The recipe is exactly the `LayoutNode` tree herdr's `layout.export` returns,
 * minus what cannot be reused: a `pane_id` is dead the moment its pane closes,
 * so it is dropped on save.
 *
 * Applying always creates a new tab. Replacing the tab the caller is running in
 * would kill the session that asked for it, and the saved tree has no source
 * tab id to restore into.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type HerdrClient, type Outcome, err, ok } from "./herdr-client.ts";

export interface LayoutPaneNode {
	type: "pane";
	pane_id?: string | null;
	cwd?: string | null;
	env?: Record<string, string>;
	command?: string[] | null;
	label?: string | null;
}

export interface LayoutSplitNode {
	type: "split";
	direction: "right" | "down";
	ratio: number;
	first: LayoutNode;
	second: LayoutNode;
}

export type LayoutNode = LayoutPaneNode | LayoutSplitNode;

/** Under the project, next to the other `.pi` state. */
export function recipeDir(cwd: string): string {
	return join(cwd, ".pi", "herdr-fleet", "recipes");
}

/** A name becomes a filename, so it is restricted to one safe path segment. */
function recipePath(cwd: string, name: string): Outcome<string> {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) {
		return err(`invalid recipe name: ${name}`);
	}
	return ok(join(recipeDir(cwd), `${name}.json`));
}

export interface SavedRecipe {
	path: string;
	panes: number;
}

/** Export the caller's tab and store its tree. */
export async function saveRecipe(
	client: HerdrClient,
	options: { cwd: string; name: string; paneId: string },
): Promise<Outcome<SavedRecipe>> {
	const path = recipePath(options.cwd, options.name);
	if (!path.ok) return path;

	const response = await client.request("layout.export", { pane_id: options.paneId });
	if (!response.ok) return response;
	const root = response.value?.layout?.root;
	if (!root) return err("layout.export: no layout in the response");

	const trimmed = stripPanes(root as LayoutNode);
	try {
		mkdirSync(recipeDir(options.cwd), { recursive: true });
		writeFileSync(path.value, `${JSON.stringify(trimmed, null, 2)}\n`);
	} catch (error) {
		return err(`could not write ${path.value}: ${describe(error)}`);
	}
	return ok({ path: path.value, panes: countPanes(trimmed) });
}

export interface AppliedRecipe {
	tabId?: string;
	panes: number;
}

/**
 * Apply a stored tree as a new tab in `workspaceId`. `start` decides whether
 * the saved launch commands are replayed; by default only the shape is.
 */
export async function applyRecipe(
	client: HerdrClient,
	options: { cwd: string; name: string; start: boolean; workspaceId?: string },
): Promise<Outcome<AppliedRecipe>> {
	const path = recipePath(options.cwd, options.name);
	if (!path.ok) return path;
	if (!existsSync(path.value)) return err(`no recipe named ${options.name}`);

	let root: LayoutNode;
	try {
		root = JSON.parse(readFileSync(path.value, "utf8")) as LayoutNode;
	} catch (error) {
		return err(`could not read ${path.value}: ${describe(error)}`);
	}
	if (!root || (root.type !== "pane" && root.type !== "split")) {
		return err(`${path.value} is not a layout tree`);
	}

	const tree = options.start ? root : stripCommands(root);
	const response = await client.request("layout.apply", {
		root: tree,
		workspace_id: options.workspaceId,
		tab_label: options.name,
		focus: true,
	});
	if (!response.ok) return response;
	return ok({ tabId: response.value?.layout?.tab_id, panes: countPanes(tree) });
}

export interface RecipeSummary {
	name: string;
	panes: number;
}

export function listRecipes(cwd: string): Outcome<RecipeSummary[]> {
	let names: string[];
	try {
		names = readdirSync(recipeDir(cwd)).filter((name) => name.endsWith(".json"));
	} catch {
		return ok([]);
	}
	return ok(
		names
			.sort()
			.map((file) => {
				const name = file.slice(0, -".json".length);
				return { name, panes: countPanes(readTree(join(recipeDir(cwd), file))) };
			}),
	);
}

function readTree(path: string): LayoutNode | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as LayoutNode;
	} catch {
		return undefined;
	}
}

function countPanes(node: LayoutNode | undefined): number {
	if (!node) return 0;
	if (node.type === "pane") return 1;
	return countPanes(node.first) + countPanes(node.second);
}

/** `pane_id` is dropped: a pane id cannot be reused after its pane is gone. */
function stripPanes(node: LayoutNode): LayoutNode {
	if (node.type === "pane") {
		const { pane_id: _paneId, ...rest } = node;
		return rest;
	}
	return { ...node, first: stripPanes(node.first), second: stripPanes(node.second) };
}

/** Dropped unless `apply --start`: a saved command is a process to launch. */
function stripCommands(node: LayoutNode): LayoutNode {
	if (node.type === "pane") {
		const { command: _command, ...rest } = node;
		return rest;
	}
	return { ...node, first: stripCommands(node.first), second: stripCommands(node.second) };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
