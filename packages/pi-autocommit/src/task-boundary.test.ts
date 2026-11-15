import assert from "node:assert";
import { describe, it } from "node:test";
import type { CompleteFn } from "./commit-prompt.js";
import type { PiAutocommitConfig } from "./config.js";
import {
  buildBoundaryPrompt,
  detectTaskBoundary,
  MAX_BOUNDARY_CONTEXT_CHARS,
  parseBoundaryAnswer,
} from "./task-boundary.js";

function config(over: Partial<PiAutocommitConfig> = {}): PiAutocommitConfig {
  return {
    lang: "en",
    enable: true,
    commitPickerMaxCommits: 30,
    ignoreSubmodules: false,
    mergeSimilarPrevious: false,
    organiseMode: "auto",
    detectTaskBoundary: true,
    ...over,
  };
}

/** The classifier never needs the real model: it is resolved from the ctx. */
const stubModel = { id: "test-model", provider: "test" } as never;

function makeCtx() {
  return {
    model: stubModel,
    modelRegistry: {
      find: () => stubModel,
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
    sessionManager: { getSessionId: () => "session-1" },
  } as never;
}

/** Adapter that records the prompts it was called with. */
function recordingComplete(answer: string): {
  complete: CompleteFn;
  calls: Array<{ systemPrompt: string; content: string }>;
} {
  const calls: Array<{ systemPrompt: string; content: string }> = [];
  const complete: CompleteFn = async (_model, context) => {
    calls.push({
      systemPrompt: context.systemPrompt,
      content: context.messages[0]?.content ?? "",
    });
    return { content: [{ type: "text", text: answer }] } as never;
  };
  return { complete, calls };
}

void describe("buildBoundaryPrompt", () => {
  void it("includes the request, the turn text and the changed files", () => {
    const { systemPrompt, userContent } = buildBoundaryPrompt({
      request: "add X, fix Y, update the docs",
      turnText: "X is done. Next: Y.",
      changedFiles: ["src/x.ts", "src/x.test.ts"],
    });

    assert.ok(systemPrompt.includes("BOUNDARY"));
    assert.ok(userContent.includes("add X, fix Y, update the docs"));
    assert.ok(userContent.includes("X is done. Next: Y."));
    assert.ok(userContent.includes("- src/x.ts"));
    assert.ok(userContent.includes("- src/x.test.ts"));
  });

  void it("marks missing request and files instead of sending empty lines", () => {
    const { userContent } = buildBoundaryPrompt({
      request: "   ",
      turnText: "Working on it.",
      changedFiles: [],
    });

    assert.ok(userContent.includes("(unknown)"));
    assert.ok(userContent.includes("(none)"));
  });

  void it("truncates oversized text", () => {
    const { userContent } = buildBoundaryPrompt({
      request: "x".repeat(MAX_BOUNDARY_CONTEXT_CHARS * 2),
      turnText: "done",
      changedFiles: [],
    });

    assert.ok(userContent.length < MAX_BOUNDARY_CONTEXT_CHARS * 2 + 1_000);
    assert.ok(userContent.includes("…"));
  });
});

void describe("parseBoundaryAnswer", () => {
  void it("reads an explicit BOUNDARY", () => {
    assert.strictEqual(parseBoundaryAnswer("BOUNDARY"), true);
    assert.strictEqual(parseBoundaryAnswer("  boundary\n"), true);
    assert.strictEqual(parseBoundaryAnswer("Answer: BOUNDARY"), true);
  });

  void it("treats anything else as mid-task", () => {
    for (const answer of ["", "CONTINUE", "continue", "BOUNDARYISH", "maybe"]) {
      assert.strictEqual(parseBoundaryAnswer(answer), false);
    }
  });

  void it("ignores the word deep inside a long answer", () => {
    assert.strictEqual(
      parseBoundaryAnswer(`${"x ".repeat(200)}BOUNDARY`),
      false,
    );
  });
});

void describe("detectTaskBoundary", () => {
  void it("returns true when the model answers BOUNDARY", async () => {
    const { complete, calls } = recordingComplete("BOUNDARY");

    const boundary = await detectTaskBoundary(
      makeCtx(),
      config(),
      { request: "do three things", turnText: "first is done", changedFiles: [] },
      complete,
    );

    assert.strictEqual(boundary, true);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].content.includes("first is done"));
  });

  void it("returns false when the model answers CONTINUE", async () => {
    const { complete } = recordingComplete("CONTINUE");

    const boundary = await detectTaskBoundary(
      makeCtx(),
      config(),
      { request: "do three things", turnText: "still on it", changedFiles: [] },
      complete,
    );

    assert.strictEqual(boundary, false);
  });

  void it("skips the call for a turn with no text", async () => {
    const { complete, calls } = recordingComplete("BOUNDARY");

    const boundary = await detectTaskBoundary(
      makeCtx(),
      config(),
      { request: "do three things", turnText: "   ", changedFiles: [] },
      complete,
    );

    assert.strictEqual(boundary, false);
    assert.strictEqual(calls.length, 0);
  });

  void it("treats a failing provider as mid-task", async () => {
    const complete: CompleteFn = async () =>
      ({
        content: [],
        stopReason: "error",
        errorMessage: "boom",
      }) as never;

    const boundary = await detectTaskBoundary(
      makeCtx(),
      config(),
      { request: "do three things", turnText: "still on it", changedFiles: [] },
      complete,
    );

    assert.strictEqual(boundary, false);
  });
});
