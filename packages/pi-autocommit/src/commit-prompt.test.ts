import assert from "node:assert";
import { describe, it } from "node:test";
import {
  type CompleteFn,
  completeCommitGroups,
  completeSingleMessage,
  extractAssistantContext,
  MAX_LLM_DIFF_CHARS,
} from "./commit-prompt.js";
import type { PiAutocommitConfig } from "./config.js";

// ── Test helpers ─────────────────────────────────────────

/** Minimal model stub for fake adapters — only `id` matters in the core. */
const stubModel = { id: "test-model" } as unknown as Parameters<CompleteFn>[0];

/** Build a fake CompleteFn returning the given text from its first content block. */
function fakeCompleteReturning(text: string): CompleteFn {
  return async () =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
    }) as never;
}

/** Minimal ctx stub: only what the LLM call path touches. */
function makeCtx(model: unknown, over: Record<string, unknown> = {}) {
  return {
    model,
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: false, error: "not configured" }),
    },
    sessionManager: { getSessionId: () => "sess-test" },
    ...over,
  } as never;
}

function config(over: Partial<PiAutocommitConfig> = {}): PiAutocommitConfig {
  return {
    lang: "en",
    enable: true,
    commitPickerMaxCommits: 30,
    ignoreSubmodules: false,
    mergeSimilarPrevious: false,
    organiseMode: "auto",
  detectTaskBoundary: false,
    ...over,
  };
}

void describe("extractAssistantContext", () => {
  void it("returns empty string when no assistant messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];
    assert.strictEqual(extractAssistantContext(messages), "");
  });

  void it("extracts text from a single assistant message", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "I will fix the bug." }],
      },
    ];
    assert.strictEqual(
      extractAssistantContext(messages),
      "I will fix the bug.",
    );
  });

  void it("joins multiple assistant messages with --- separator", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "fix it" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "First I'll add a test." }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Then I'll fix the code." }],
      },
    ];
    assert.strictEqual(
      extractAssistantContext(messages),
      "First I'll add a test.\n\n---\n\nThen I'll fix the code.",
    );
  });

  void it("skips non-text content blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", text: "ignored" },
          { type: "text", text: "kept" },
          { type: "text" }, // empty text dropped
        ],
      },
    ];
    assert.strictEqual(extractAssistantContext(messages), "kept");
  });
});

void describe("completeSingleMessage", () => {
  void it("returns the cleaned LLM message with injected scope (mapping present)", async () => {
    const cfg = config({ scope: { "packages/frontend/**": "frontend" } });
    const complete = fakeCompleteReturning(
      "```\nfeat: add login\n\nImplement JWT login.\n```",
    );

    const message = await completeSingleMessage(
      makeCtx(stubModel),
      cfg,
      {
        diff: "--- a/packages/frontend/login.ts\n+++ b/packages/frontend/login.ts\n",
        nameStatus: "A\tpackages/frontend/login.ts\n",
        stat: "1 file changed",
      },
      complete,
    );

    assert.strictEqual(
      message,
      "feat(frontend): add login\n\nImplement JWT login.",
    );
  });

  void it("falls back to the heuristic when the LLM returns empty text", async () => {
    const cfg = config();
    const complete = fakeCompleteReturning("");

    const message = await completeSingleMessage(
      makeCtx(stubModel),
      cfg,
      {
        diff: "--- a/src/a.ts\n+++ b/src/a.ts\n",
        nameStatus: "A\tsrc/a.ts\n",
        stat: "1 file changed",
      },
      complete,
    );

    // Heuristic: new file → `feat`, top-level dir → scope `src`.
    assert.match(message, /^feat\(src\): add new functionality/);
    assert.match(message, /src\/a\.ts/);
  });

  void it("falls back to the heuristic when the LLM adapter throws", async () => {
    const cfg = config();
    const complete: CompleteFn = async () => {
      throw new Error("LLM unreachable");
    };

    const message = await completeSingleMessage(
      makeCtx(stubModel),
      cfg,
      {
        diff: "--- a/docs/x.md\n+++ b/docs/x.md\n",
        nameStatus: "M\tdocs/x.md\n",
        stat: "1 file changed",
      },
      complete,
    );

    // Docs-only diff → `docs` type, scope `docs`.
    assert.match(message, /^docs\(docs\): update documentation/);
  });

  void it("skips the LLM and uses the heuristic when the diff is too large", async () => {
    const cfg = config();
    let called = false;
    const complete: CompleteFn = async () => {
      called = true;
      throw new Error("must not be reached");
    };

    const message = await completeSingleMessage(
      makeCtx(stubModel),
      cfg,
      {
        diff: "x".repeat(MAX_LLM_DIFF_CHARS + 1),
        nameStatus: "A\tsrc/a.ts\n",
        stat: "1 file changed",
      },
      complete,
    );

    assert.strictEqual(called, false);
    assert.match(message, /^feat\(src\): add new functionality/);
  });
});

void describe("completeCommitGroups", () => {
  void it("parses the LLM response into groups with injected scope (mapping present)", async () => {
    const cfg = config({
      scope: {
        "packages/frontend/**": "frontend",
        "packages/backend/**": "backend",
      },
    });
    const llmText = [
      "=== COMMIT 1 ===",
      "feat: add login",
      "",
      "Implement login.",
      "=== FILES ===",
      "packages/frontend/auth.ts",
      "=== END ===",
      "=== COMMIT 2 ===",
      "fix(db): escape input",
      "",
      "Prevent injection.",
      "=== FILES ===",
      "packages/backend/query.ts",
      "=== END ===",
    ].join("\n");
    const complete = fakeCompleteReturning(llmText);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      cfg,
      {
        diff: "staged diff here",
        reasoning: "I will split login and db fix.",
      },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat(frontend): add login\n\nImplement login.",
        files: ["packages/frontend/auth.ts"],
      },
      {
        message: "fix(backend): escape input\n\nPrevent injection.",
        files: ["packages/backend/query.ts"],
      },
    ]);
  });

  void it("returns no groups without calling the LLM when the diff is too large", async () => {
    const cfg = config();
    let called = false;
    const complete: CompleteFn = async () => {
      called = true;
      throw new Error("must not be reached");
    };

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      cfg,
      { diff: "x".repeat(MAX_LLM_DIFF_CHARS + 1), reasoning: "reasoning" },
      complete,
    );

    assert.strictEqual(called, false);
    assert.deepStrictEqual(groups, []);
  });

  void it("throws when the LLM returns empty text", async () => {
    const cfg = config();
    const complete = fakeCompleteReturning("");

    await assert.rejects(
      completeCommitGroups(
        makeCtx(stubModel),
        cfg,
        { diff: "diff", reasoning: "reasoning" },
        complete,
      ),
      /Empty LLM response/,
    );
  });

  void it("throws when the LLM response has no parseable groups", async () => {
    const cfg = config();
    const complete = fakeCompleteReturning("sorry, I cannot help with that.");

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      cfg,
      { diff: "diff", reasoning: "reasoning" },
      complete,
    );

    // Parseable returns empty groups (not throw) — throw only on empty raw text.
    assert.deepStrictEqual(groups, []);
  });

  void it("throws when no model is available", async () => {
    const cfg = config();
    const complete = fakeCompleteReturning("feat: x");

    await assert.rejects(
      completeCommitGroups(
        makeCtx(undefined),
        cfg,
        { diff: "diff", reasoning: "reasoning" },
        complete,
      ),
      /No model available/,
    );
  });

  void it("strips markdown fences from the LLM response before parsing groups", async () => {
    const cfg = config();
    const llmText = [
      "```",
      "=== COMMIT 1 ===",
      "feat: add login",
      "",
      "Implement login.",
      "=== FILES ===",
      "src/auth.ts",
      "=== END ===",
      "```",
    ].join("\n");
    const complete = fakeCompleteReturning(llmText);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      cfg,
      { diff: "diff", reasoning: "reasoning" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat: add login\n\nImplement login.",
        files: ["src/auth.ts"],
      },
    ]);
  });

  void it("works with Japanese config and Japanese LLM responses", async () => {
    const cfg = config({ lang: "ja" });
    const llmText = [
      "=== COMMIT 1 ===",
      "feat: ログインを追加",
      "",
      "ログイン機能を実装。",
      "=== FILES ===",
      "src/auth.ts",
      "=== END ===",
    ].join("\n");
    const complete = fakeCompleteReturning(llmText);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      cfg,
      { diff: "diff", reasoning: "reasoning" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat: ログインを追加\n\nログイン機能を実装。",
        files: ["src/auth.ts"],
      },
    ]);
  });
});

void describe("ADR-0003 scope injection", () => {
  void it("single path strips an LLM-emitted scope before injecting the deterministic one", async () => {
    const cfg = config({ scope: { "packages/frontend/**": "frontend" } });
    // LLM ignored the “no scope” instruction and emitted `feat(auth)`.
    const complete = fakeCompleteReturning("feat(auth): add login\n\nBody.");

    const message = await completeSingleMessage(
      makeCtx(stubModel),
      cfg,
      {
        diff: "diff",
        nameStatus: "A\tpackages/frontend/login.ts\n",
        stat: "1 file changed",
      },
      complete,
    );

    assert.strictEqual(message, "feat(frontend): add login\n\nBody.");
  });

  void it("groups path strips an LLM-emitted scope before injecting the deterministic one", async () => {
    const cfg = config({ scope: { "packages/frontend/**": "frontend" } });
    const llmText = [
      "=== COMMIT 1 ===",
      "feat(auth): add login",
      "=== FILES ===",
      "packages/frontend/auth.ts",
      "=== END ===",
    ].join("\n");
    const complete = fakeCompleteReturning(llmText);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      cfg,
      { diff: "diff", reasoning: "reasoning" },
      complete,
    );

    assert.strictEqual(groups[0]?.message, "feat(frontend): add login");
  });

  void it("no mapping: leaves the LLM-emitted scope untouched (single path)", async () => {
    const cfg = config();
    const complete = fakeCompleteReturning("feat(auth): add login\n\nBody.");

    const message = await completeSingleMessage(
      makeCtx(stubModel),
      cfg,
      {
        diff: "diff",
        nameStatus: "A\tsrc/auth/login.ts\n",
        stat: "1 file changed",
      },
      complete,
    );

    assert.strictEqual(message, "feat(auth): add login\n\nBody.");
  });
});

void describe("provider request options", () => {
  /** opencode models need the session attribution headers pi core attaches. */
  const opencodeModel = {
    id: "kimi-k2.7-code",
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
  };

  /** Adapter capturing the options it was called with. */
  function captureOptions(into: { seen?: unknown }): CompleteFn {
    return async (_model, _context, options) => {
      into.seen = options;
      return { content: [{ type: "string", text: "feat: x" }] };
    };
  }

  void it("passes the resolved api key and session headers for opencode models", async () => {
    const ctx = makeCtx(opencodeModel, {
      modelRegistry: {
        find: () => undefined,
        hasConfiguredAuth: () => true,
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: "resolved-key",
          headers: { "x-extra": "1" },
        }),
      },
      sessionManager: { getSessionId: () => "sess-42" },
    });
    const captured: { seen?: unknown } = {};

    await completeSingleMessage(
      ctx,
      config(),
      { diff: "diff", nameStatus: "A\tsrc/a.ts\n", stat: "1 file changed" },
      captureOptions(captured),
    );

    assert.deepStrictEqual(captured.seen, {
      apiKey: "resolved-key",
      headers: {
        "x-extra": "1",
        "x-opencode-session": "sess-42",
        "x-opencode-client": "pi",
      },
    });
  });

  void it("adds no session headers for other providers", async () => {
    const captured: { seen?: unknown } = {};

    await completeSingleMessage(
      makeCtx(stubModel),
      config(),
      { diff: "diff", nameStatus: "A\tsrc/a.ts\n", stat: "1 file changed" },
      captureOptions(captured),
    );

    assert.deepStrictEqual(captured.seen, {});
  });

  void it("treats a provider error stop reason as a failure (single path)", async () => {
    const complete: CompleteFn = async () => ({
      content: [],
      stopReason: "error",
      errorMessage: "400: MissingSessionID",
    });
    let reason: string | undefined;

    const message = await completeSingleMessage(
      makeCtx(stubModel),
      config(),
      { diff: "diff", nameStatus: "A\tsrc/a.ts\n", stat: "1 file changed" },
      complete,
      (r) => {
        reason = r;
      },
    );

    // Heuristic, and the caller learns why the LLM path was skipped.
    assert.match(message, /^feat\(src\): add new functionality/);
    assert.match(reason ?? "", /400: MissingSessionID/);
  });

  void it("treats a provider error stop reason as a failure (groups path)", async () => {
    const complete: CompleteFn = async () => ({
      content: [],
      stopReason: "error",
      errorMessage: "400: MissingSessionID",
    });

    await assert.rejects(
      completeCommitGroups(
        makeCtx(stubModel),
        config(),
        { diff: "diff", reasoning: "reasoning" },
        complete,
      ),
      /LLM request failed: 400: MissingSessionID/,
    );
  });
});
