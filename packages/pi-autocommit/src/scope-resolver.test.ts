import assert from "node:assert";
import { describe, it } from "node:test";
import type { PiAutocommitConfig } from "./config.js";
import {
  hasScopeMapping,
  injectScopeIntoMessage,
  resolveScope,
} from "./scope-resolver.js";

function config(scope?: Record<string, string>): PiAutocommitConfig {
  return {
    lang: "en",
    enable: true,
    commitPickerMaxCommits: 30,
    ignoreSubmodules: false,
    mergeSimilarPrevious: false,
    organiseMode: "auto",
  detectTaskBoundary: false,
    scope,
  };
}

void describe("hasScopeMapping", () => {
  void it("returns false when scope is undefined", () => {
    assert.strictEqual(hasScopeMapping(config()), false);
  });

  void it("returns false when scope is empty", () => {
    assert.strictEqual(hasScopeMapping(config({})), false);
  });

  void it("returns true when scope has entries", () => {
    assert.strictEqual(hasScopeMapping(config({ "**": "app" })), true);
  });
});

void describe("resolveScope", () => {
  // ── unmapped (heuristic) ───────────────────────────────

  void it("returns null for empty paths", () => {
    assert.strictEqual(resolveScope([], config()), null);
  });

  void it("uses top-level dir when all files share one (no mapping)", () => {
    assert.strictEqual(resolveScope(["src/a.ts", "src/b.ts"], config()), "src");
  });

  void it("uses the top-level dir even for nested shared paths (no mapping)", () => {
    // The original heuristic's first check (unique top-level dir) wins over
    // the two-level refinement, so this returns "packages", not "packages/foo".
    assert.strictEqual(
      resolveScope(["packages/foo/a.ts", "packages/foo/b.ts"], config()),
      "packages",
    );
  });

  void it("uses the full path as scope for a single top-level file (no mapping)", () => {
    // No slash → the top-level-dir check returns the path itself.
    assert.strictEqual(resolveScope(["README.md"], config()), "README.md");
  });

  void it("uses the top-level dir for a single nested file (no mapping)", () => {
    assert.strictEqual(resolveScope(["src/a.ts"], config()), "src");
  });

  void it("returns null when top-level dirs diverge (no mapping)", () => {
    assert.strictEqual(resolveScope(["src/a.ts", "docs/b.md"], config()), null);
  });

  // ── mapping: complete match ────────────────────────────

  void it("returns mapped scope when all files match same rule", () => {
    const cfg = config({ "packages/frontend/**": "frontend" });
    assert.strictEqual(
      resolveScope(["packages/frontend/a.ts", "packages/frontend/b.ts"], cfg),
      "frontend",
    );
  });

  void it("`**` matches everything to a single scope", () => {
    const cfg = config({ "**": "app" });
    assert.strictEqual(resolveScope(["a.ts", "packages/foo/b.ts"], cfg), "app");
  });

  void it("returns null when files map to different scopes (mixed)", () => {
    const cfg = config({
      "packages/frontend/**": "frontend",
      "packages/backend/**": "backend",
    });
    assert.strictEqual(
      resolveScope(["packages/frontend/a.ts", "packages/backend/b.ts"], cfg),
      null,
    );
  });

  // ── mapping: longest-literal-wins ──────────────────────

  void it("prefers the longer-literal glob on multiple matches", () => {
    const cfg = config({
      "**": "app",
      "packages/frontend/**": "frontend",
    });
    assert.strictEqual(
      resolveScope(["packages/frontend/a.ts"], cfg),
      "frontend",
    );
  });

  void it("falls back to `**` when no specific glob matches", () => {
    const cfg = config({
      "**": "app",
      "packages/frontend/**": "frontend",
    });
    assert.strictEqual(resolveScope(["docs/x.md"], cfg), "app");
  });

  // ── mapping: partial coverage → cascade ────────────────

  void it("cascades to heuristic when at least one path is unmapped", () => {
    const cfg = config({ "packages/frontend/**": "frontend" });
    // packages/frontend matches but README.md does not → heuristic.
    // Top-level dirs {packages, README.md} diverge → null.
    assert.strictEqual(
      resolveScope(["packages/frontend/a.ts", "README.md"], cfg),
      null,
    );
  });

  void it("cascaded heuristic returns null when heuristic diverges", () => {
    const cfg = config({ "docs/**": "docs-scope" });
    // Both under different top-level dirs → heuristic returns null.
    assert.strictEqual(resolveScope(["src/api/a.ts", "docs/b.md"], cfg), null);
  });
});

void describe("injectScopeIntoMessage", () => {
  void it("injects the resolved scope when mapping present", () => {
    const cfg = config({ "packages/frontend/**": "frontend" });
    const paths = ["packages/frontend/a.ts"];
    const msg = "feat: add login\n\nBody line.";
    assert.strictEqual(
      injectScopeIntoMessage(msg, paths, cfg),
      "feat(frontend): add login\n\nBody line.",
    );
  });

  void it("strips an LLM-emitted scope before injecting", () => {
    const cfg = config({ "packages/frontend/**": "frontend" });
    const paths = ["packages/frontend/a.ts"];
    // LLM ignored our "no scope" instruction and emitted `feat(auth)`.
    const msg = "feat(auth): add login\n\nBody.";
    assert.strictEqual(
      injectScopeIntoMessage(msg, paths, cfg),
      "feat(frontend): add login\n\nBody.",
    );
  });

  void it("leaves subject scope-less when resolveScope returns null", () => {
    // Both files match the mapping but to different scopes → null.
    const cfg = config({
      "packages/frontend/**": "frontend",
      "packages/backend/**": "backend",
    });
    const paths = ["packages/frontend/a.ts", "packages/backend/b.ts"];
    const msg = "feat: add login";
    assert.strictEqual(
      injectScopeIntoMessage(msg, paths, cfg),
      "feat: add login",
    );
  });

  void it("leaves multi-line bodies intact and only rewrites the subject", () => {
    const cfg = config({ "**": "app" });
    const paths = ["a.ts", "b.ts"];
    const msg = "feat: x\n\nFirst.\n\nSecond.\n\nBREAKING CHANGE: y";
    assert.strictEqual(
      injectScopeIntoMessage(msg, paths, cfg),
      "feat(app): x\n\nFirst.\n\nSecond.\n\nBREAKING CHANGE: y",
    );
  });

  void it("is a no-op when the subject does not match Conventional form", () => {
    const cfg = config({ "**": "app" });
    const msg = "not a commit subject";
    assert.strictEqual(injectScopeIntoMessage(msg, ["a.ts"], cfg), msg);
  });
});
