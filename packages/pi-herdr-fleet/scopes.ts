/**
 * scopes: what a forked session is told.
 *
 * A fork branches the repository *and* the context. What crosses over is not the
 * main session's history but one prompt built from the scope: the task, where to
 * do it, and what "done" means. A discussion is not a brief — the decisions it
 * produced have to be written into the task, and anything it left open has to be
 * asked again rather than reconstructed.
 *
 * `review` is the other direction: there the context *is* the material, because
 * nobody can review a change they cannot see.
 */

export interface ForkInput {
	/** The task text as the caller typed it. */
	task: string;
	/** The worktree the session works in. */
	path: string;
	branch: string;
	/** The ref the branch was cut from, when the caller named one. */
	base?: string;
	/** `review` only: the change under review, from `git diff <base>...HEAD`. */
	diff?: string;
	/** `review` only: what the author's own session said, taken from its JSONL. */
	author?: string;
	/** `review` only: the file that text came from, so the reviewer can read more. */
	authorSession?: string;
}

export interface Scope {
	id: string;
	/** One line, for errors and help. */
	purpose: string;
	/**
	 * Whether `fleet_fork` may use it. A fork can only supply a task; the review
	 * scope needs material gathered from an existing worktree, so it is reachable
	 * through `fleet_review` instead of through the fork's scope argument.
	 */
	forkable: boolean;
	/** The single message a forked session receives. */
	seed(input: ForkInput): string;
	deliverable: string;
}

const IMPLEMENT_DELIVERABLE = "a commit on the branch, and a short report back";
const REVIEW_DELIVERABLE = "a verdict (approve or request-changes) with findings";

const implementation: Scope = {
	id: "implementation",
	purpose: "Implement the task in the worktree and report back",
	forkable: true,
	deliverable: IMPLEMENT_DELIVERABLE,
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
			`- The deliverable is ${IMPLEMENT_DELIVERABLE}.`,
			"- Commit the work on this branch.",
			"- Reply with a short report: what changed, the commit, and what is still open. Do not paste diffs.",
		].join("\n"),
};

const review: Scope = {
	id: "review",
	purpose: "Review another session's change in its worktree and return a verdict",
	forkable: false,
	deliverable: REVIEW_DELIVERABLE,
	seed: (input) =>
		[
			"You are reviewing work that another Pi session did in this git worktree. You are the reviewer, not the author: read and judge, and change nothing. The task below is what the author was asked to do; the diff and the author's own session are the evidence.",
			"",
			`worktree: ${input.path}`,
			`branch: ${input.branch}`,
			...(input.base ? [`base: ${input.base} (the change under review is \`git diff ${input.base}...HEAD\`)`] : []),
			...(input.authorSession ? [`author session: ${input.authorSession} (assistant text only, truncated)`] : []),
			"",
			"# Task the author was given",
			"",
			input.task,
			"",
			"# The change",
			"",
			input.diff?.trim() ? input.diff : "(the diff is empty)",
			"",
			"# The author's session",
			"",
			input.author?.trim() ? input.author : "(no session text was available)",
			"",
			"# How to review",
			"",
			"- Read the files the diff touches, and anything else you need. You are in the author's worktree, so the code under review is right here.",
			"- Judge the change against the task, not against what you would have written instead.",
			"- Report what is wrong or missing, with the file and the line. A finding the author cannot act on is noise.",
			"- Do not modify, commit, revert, or run anything that changes this worktree, and do not create worktrees or agents.",
			"",
			"# Done",
			"",
			`- The deliverable is ${REVIEW_DELIVERABLE}.`,
			"- End your reply with exactly this, and nothing after it:",
			"",
			"VERDICT: approve | request-changes",
			"FINDINGS:",
			"- <path>:<line> <what is wrong>",
			"",
			"- Use `approve` only when you found nothing worth changing. An empty diff is not a pass: say so and request changes.",
		].join("\n"),
};

/** Every scope this build knows. */
export const SCOPES: Scope[] = [implementation, review];

/** The ids `fleet_fork` accepts, so the schema and the registry cannot drift. */
export function forkScopeIds(): string[] {
	return SCOPES.filter((scope) => scope.forkable).map((scope) => scope.id);
}

export function findScope(id: string): Scope | undefined {
	return SCOPES.find((scope) => scope.id === id);
}

export function scopeIds(): string {
	return SCOPES.map((scope) => scope.id).join(", ");
}
