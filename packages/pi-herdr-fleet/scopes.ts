/**
 * scopes: what a forked session is told.
 *
 * A fork branches the repository *and* the context. What crosses over is not the
 * main session's history but one prompt built from the scope: the task, where to
 * do it, and what "done" means. A discussion is not a brief — the decisions it
 * produced have to be written into the task, and anything it left open has to be
 * asked again rather than reconstructed.
 */

export interface ForkInput {
	/** The task text as the caller typed it. */
	task: string;
	/** The worktree the forked session works in. */
	path: string;
	branch: string;
	/** The ref the branch was cut from, when the caller named one. */
	base?: string;
}

export interface Scope {
	id: string;
	/** One line, for errors and help. */
	purpose: string;
	/** The single message a forked session receives. */
	seed(input: ForkInput): string;
	deliverable: string;
}

const DELIVERABLE = "a commit on the branch, and a short report back";

const implementation: Scope = {
	id: "implementation",
	purpose: "Implement the task in the worktree and report back",
	deliverable: DELIVERABLE,
	seed: (input) =>
		[
			"You are working in a git worktree forked from another Pi session. The task below is the whole brief: the session that forked you kept its history to itself.",
			"",
			`worktree: ${input.path}`,
			`branch: ${input.branch}`,
			...(input.base ? [`base: ${input.base}`] : []),
			"",
			"# Task",
			"",
			input.task,
			"",
			"# Constraints",
			"",
			"- Work only inside this worktree. Do not touch other checkouts.",
			"- Commit on this branch. Do not create worktrees, start agents, or push.",
			"- If the task does not decide something, ask instead of guessing. The decision was made in the session that forked you, so it cannot be recovered from here.",
			"",
			"# Done",
			"",
			`- The deliverable is ${DELIVERABLE}.`,
			"- Commit the work on this branch.",
			"- Reply with a short report: what changed, the commit, and what is still open. Do not paste diffs.",
		].join("\n"),
};

/** Every scope this build knows. `review` is 3b. */
export const SCOPES: Scope[] = [implementation];

export function findScope(id: string): Scope | undefined {
	return SCOPES.find((scope) => scope.id === id);
}

export function scopeIds(): string {
	return SCOPES.map((scope) => scope.id).join(", ");
}
