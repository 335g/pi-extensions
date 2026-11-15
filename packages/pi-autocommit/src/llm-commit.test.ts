import assert from "node:assert";
import { describe, it } from "node:test";
import type { PiAutocommitConfig } from "./config.js";
import { resolveModel, validateModelString } from "./llm-commit.js";

/** Base config preset for tests so each it() only overrides what it needs. */
const BASE_CONFIG: PiAutocommitConfig = {
  lang: "en",
  enable: true,
  commitPickerMaxCommits: 30,
  ignoreSubmodules: false,
  mergeSimilarPrevious: false,
  organiseMode: "auto",
  detectTaskBoundary: false,
};

/**
 * Minimal stub for the `ModelRegistry` surface used by `resolveModel`.
 */
interface RegistryStub {
  find(): unknown;
  hasConfiguredAuth(): boolean;
}

/**
 * Build a minimal `ExtensionContext`-shaped object with only the fields
 * `resolveModel` touches: `model` and `modelRegistry`.
 */
function makeCtx(
  model: unknown,
  registry: RegistryStub,
): { model: unknown; modelRegistry: RegistryStub } {
  return { model, modelRegistry: registry };
}

void describe("resolveModel", () => {
  void it("returns ctx.model when config.model is unset", () => {
    const sessionModel = { id: "session-model" };
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = { ...BASE_CONFIG };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("returns ctx.model when config.model is an empty string", () => {
    const sessionModel = { id: "session-model" };
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = { ...BASE_CONFIG, model: "" };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("returns the resolved model when found and configured", () => {
    const sessionModel = { id: "session-model" };
    const configuredModel = { id: "claude-sonnet-4" };
    const registry: RegistryStub = {
      find: () => configuredModel,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = {
      ...BASE_CONFIG,
      model: "anthropic/claude-sonnet-4",
    };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, configuredModel);
  });

  void it("falls back to ctx.model when model is not found in registry", () => {
    const sessionModel = { id: "session-model" };
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = {
      ...BASE_CONFIG,
      model: "anthropic/unknown-model",
    };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("falls back to ctx.model when model has no configured auth", () => {
    const sessionModel = { id: "session-model" };
    const unconfiguredModel = { id: "claude-sonnet-4" };
    const registry: RegistryStub = {
      find: () => unconfiguredModel,
      hasConfiguredAuth: () => false,
    };
    const config: PiAutocommitConfig = {
      ...BASE_CONFIG,
      model: "anthropic/claude-sonnet-4",
    };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("falls back to ctx.model on invalid format (missing slash)", () => {
    const sessionModel = { id: "session-model" };
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = {
      ...BASE_CONFIG,
      model: "invalid",
    };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("falls back to ctx.model on invalid format (leading slash)", () => {
    const sessionModel = { id: "session-model" };
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = {
      ...BASE_CONFIG,
      model: "/foo",
    };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("falls back to ctx.model on invalid format (trailing slash)", () => {
    const sessionModel = { id: "session-model" };
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = {
      ...BASE_CONFIG,
      model: "foo/",
    };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("returns undefined when ctx.model is undefined and config.model unset", () => {
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = { ...BASE_CONFIG };

    const result = resolveModel(makeCtx(undefined, registry) as never, config);

    assert.strictEqual(result, undefined);
  });

  void it("returns undefined when fallback triggered and ctx.model is undefined", () => {
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = {
      ...BASE_CONFIG,
      model: "anthropic/unknown",
    };

    const result = resolveModel(makeCtx(undefined, registry) as never, config);

    assert.strictEqual(result, undefined);
  });
});

void describe("validateModelString", () => {
  void it("returns ok with the model when found and configured", () => {
    const configuredModel = { id: "claude-sonnet-4" };
    const registry: RegistryStub = {
      find: () => configuredModel,
      hasConfiguredAuth: () => true,
    };

    const result = validateModelString(
      makeCtx(undefined, registry) as never,
      "anthropic/claude-sonnet-4",
    );

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.model, configuredModel);
    }
  });

  void it("rejects invalid format (missing slash)", () => {
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };

    const result = validateModelString(
      makeCtx(undefined, registry) as never,
      "invalid",
    );

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /Invalid model format/);
    }
  });

  void it("rejects invalid format (leading slash)", () => {
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };

    const result = validateModelString(
      makeCtx(undefined, registry) as never,
      "/foo",
    );

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /Invalid model format/);
    }
  });

  void it("rejects invalid format (trailing slash)", () => {
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };

    const result = validateModelString(
      makeCtx(undefined, registry) as never,
      "foo/",
    );

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /Invalid model format/);
    }
  });

  void it("rejects when model is not found in registry", () => {
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };

    const result = validateModelString(
      makeCtx(undefined, registry) as never,
      "anthropic/unknown-model",
    );

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /not found in registry/);
    }
  });

  void it("rejects when model has no configured auth", () => {
    const unconfiguredModel = { id: "claude-sonnet-4" };
    const registry: RegistryStub = {
      find: () => unconfiguredModel,
      hasConfiguredAuth: () => false,
    };

    const result = validateModelString(
      makeCtx(undefined, registry) as never,
      "anthropic/claude-sonnet-4",
    );

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /not configured/);
    }
  });
});
