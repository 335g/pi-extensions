import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CompleteFn, completeText } from "./commit-prompt.js";
import type { PiAutocommitConfig } from "./config.js";

/**
 * Task-boundary detector.
 *
 * The extension splits an agent loop into commit batches at the points where a
 * unit of work ends. A new user instruction is one such point, but a single
 * prompt can ask for several things ("add X, fix Y, update the docs"), and the
 * agent never asks for permission between them. The only evidence that item one
 * is finished is the agent's own turn, so the boundary is decided by a small
 * classification call over the user request and the latest turn.
 *
 * The call is deliberately tiny: it reuses the commit-message model, sends at
 * most {@link MAX_BOUNDARY_CONTEXT_CHARS} of each text, and expects one word
 * back. A failed or unparseable answer degrades to "continue", so a broken
 * classifier never splits history on its own.
 */

/** Characters of request/turn text sent to the classifier. */
export const MAX_BOUNDARY_CONTEXT_CHARS = 3_000;

/** Everything the classifier needs to judge one turn. */
export interface BoundaryInput {
  /** The user request the run is working through (empty when unknown). */
  request: string;
  /** Text of the assistant turn that just ended. */
  turnText: string;
  /** Files changed in this turn, relative to the repo root. */
  changedFiles: string[];
}

/** One-word classification prompt. */
export function buildBoundaryPrompt(input: BoundaryInput): {
  systemPrompt: string;
  userContent: string;
} {
  const systemPrompt = [
    "You label one turn of an AI coding agent that is working through a user request.",
    "",
    "Decide whether this turn ENDED one self-contained piece of the request.",
    "",
    "Answer with exactly one word:",
    "BOUNDARY — the turn finished a piece of the request that makes sense as its own set of commits, and the next turn starts different work. A finished numbered or listed item is a BOUNDARY.",
    "CONTINUE — the turn is a step inside the current piece: still implementing, still debugging, still exploring, or the same change unfinished. Saying what comes next without having finished the current item is CONTINUE.",
    "",
    "Judge only by what the turn reports and touches. Do not guess about work the request mentions but the turn has not started.",
  ].join("\n");

  const files =
    input.changedFiles.length > 0
      ? input.changedFiles.map((f) => `- ${f}`).join("\n")
      : "(none)";

  const userContent = [
    "User request:",
    truncate(input.request, MAX_BOUNDARY_CONTEXT_CHARS) || "(unknown)",
    "",
    "Latest turn:",
    truncate(input.turnText, MAX_BOUNDARY_CONTEXT_CHARS) || "(no text)",
    "",
    "Files changed in that turn:",
    files,
  ].join("\n");

  return { systemPrompt, userContent };
}

/**
 * Read the classifier's answer.
 *
 * Only an explicit BOUNDARY counts. Anything else — CONTINUE, an explanation,
 * an empty response — is not a boundary, because a wrong split is visible in
 * history while a missed split is only a larger batch.
 */
export function parseBoundaryAnswer(text: string): boolean {
  return /\bBOUNDARY\b/i.test(text.slice(0, 200));
}

/**
 * Ask the model whether the turn that just ended completes a piece of work.
 *
 * Never throws: a missing model, a provider error, or an unparseable answer all
 * return `false` and the run keeps collecting checkpoints until the next
 * boundary or the turn backstop.
 */
export async function detectTaskBoundary(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  input: BoundaryInput,
  complete?: CompleteFn,
): Promise<boolean> {
  if (!input.turnText.trim()) {
    return false;
  }

  const { systemPrompt, userContent } = buildBoundaryPrompt(input);
  try {
    const answer = await completeText(
      ctx,
      config,
      systemPrompt,
      userContent,
      complete,
    );
    return parseBoundaryAnswer(answer);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[pi-autocommit] task boundary check failed (${reason}). Treating the turn as mid-task.`,
    );
    return false;
  }
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n…` : trimmed;
}
