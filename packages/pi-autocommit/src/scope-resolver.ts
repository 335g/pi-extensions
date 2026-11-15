import picomatch from "picomatch";
import type { PiAutocommitConfig } from "./config.js";

/**
 * Returns `true` when the config carries a usable path-to-scope mapping
 * (a `scope` object with at least one entry). An empty or absent mapping
 * means "let the LLM/heuristic infer the scope as before".
 */
export function hasScopeMapping(config: PiAutocommitConfig): boolean {
  return config.scope !== undefined && Object.keys(config.scope).length > 0;
}

/**
 * Resolve the Conventional Commits scope for a set of changed file paths.
 *
 * Cascade (see ADR 0003):
 *
 *   1. **User mapping** — when `config.scope` is set, each path is matched
 *      against the mapping's picomatch globs. When multiple globs match the
 *      same path, the one with the **longest literal** (most non-wildcard
 *      characters) wins.
 *      - When every path matches and they all resolve to the **same** scope,
 *        that scope is returned.
 *      - When every path matches but the scopes **differ**, the commit spans
 *        multiple scopes → `null` (scope omitted).
 *      - When **any** path has no matching glob, fall through to tier 2.
 *   2. **Heuristic** — the original `determineScope` path-based heuristic
 *      (top-level dir → two-level dir → single-file stem). Preserved verbatim
 *      so unmapped repos and partial mappings keep their existing behaviour.
 *   3. `null` — neither tier could decide; the scope is omitted
 *      (`type: summary`).
 *
 * @param paths  Changed file paths (relative, POSIX-style).
 * @param config Loaded pi-autocommit config.
 * @returns The resolved scope, or `null` to omit it.
 */
export function resolveScope(
  paths: string[],
  config: PiAutocommitConfig,
): string | null {
  if (paths.length === 0) return null;

  const mapping = config.scope;
  if (mapping && Object.keys(mapping).length > 0) {
    const mapped = paths.map((p) => matchMapping(p, mapping));

    // Unmatched path → cascade to heuristic for the whole group.
    if (mapped.every((s) => s !== null)) {
      const first = mapped[0];
      if (first === null) return null;
      return mapped.every((s) => s === first) ? first : null;
    }
  }

  return determineScopeHeuristic(paths);
}

/**
 * Inject the deterministic scope into the subject line of a commit message.
 *
 * The subject (first line) is normalised to `type: summary` first — stripping
 * any LLM-emitted `type(scope):` — then reassembled as `type(scope): summary`
 * when `resolveScope` returns a non-null scope, or left as `type: summary`
 * otherwise. Body and footer lines are left untouched.
 *
 * Used only when a scope mapping is configured (ADR 0003), so the LLM is
 * told to omit scope and we reattach it deterministically.
 */
export function injectScopeIntoMessage(
  message: string,
  paths: string[],
  config: PiAutocommitConfig,
): string {
  const scope = resolveScope(paths, config);
  const lines = message.split("\n");
  const subject = lines[0];
  if (subject === undefined) return message;

  const match = subject.match(/^([a-z]+)(?:\([^)]*\))?\s*:\s*(.*)$/i);
  if (!match) return message;

  const type = match[1];
  const summary = match[2];
  const typePart = scope ? `${type}(${scope})` : type;
  lines[0] = `${typePart}: ${summary}`;
  return lines.join("\n");
}

/**
 * Find the single best scope for `path` from the user mapping.
 *
 * "Best" = the matching glob with the longest literal (most specific).
 * Returns `null` when no glob matches.
 */
function matchMapping(
  path: string,
  mapping: Record<string, string>,
): string | null {
  let bestScope: string | null = null;
  let bestScore = -1;

  for (const [pattern, scope] of Object.entries(mapping)) {
    if (picomatch.isMatch(path, pattern)) {
      const score = literalLength(pattern);
      if (score > bestScore) {
        bestScore = score;
        bestScope = scope;
      }
    }
  }

  return bestScope;
}

/**
 * Specificity proxy: literal (non-wildcard) character count.
 *
 * Wildcards (`globstar`, `star`, `bracket`, `qmark`) contribute 0; every
 * other character contributes 1. This is a cheap, robust heuristic — a
 * longer literal such as `packages/frontend/` (19) outranks a bare wildcard
 * (0), and a test-file pattern like `*.test.ts` (9) outranks a wildcard (0)
 * but is outranked by an even more specific prefix. See ADR 0003.
 */
function literalLength(pattern: string): number {
  return pattern.replace(/[*?]/g, "").length;
}

/**
 * Heuristic scope derivation from changed file paths.
 *
 * Extracted verbatim from the original `determineScope` in
 * `commit-message.ts` so the cascade has a stable, behaviour-preserving
 * fallback tier that is independently testable.
 */
function determineScopeHeuristic(paths: string[]): string | null {
  if (paths.length === 0) return null;

  const dirs = paths.map((p) => {
    const idx = p.indexOf("/");
    return idx >= 0 ? p.substring(0, idx) : p;
  });

  const uniqueDirs = [...new Set(dirs)];
  if (uniqueDirs.length === 1 && uniqueDirs[0] !== "") return uniqueDirs[0];

  // Two-level scope
  const dirs2 = paths.map((p) => {
    const parts = p.split("/");
    return parts.length >= 3
      ? `${parts[0]}/${parts[1]}`
      : parts.length >= 2
        ? parts[0]
        : p;
  });
  const uniqueDirs2 = [...new Set(dirs2)];
  if (uniqueDirs2.length === 1) return uniqueDirs2[0];

  // Single file → use its stem name
  if (paths.length === 1) {
    return paths[0].replace(/\.[^.]+$/, "");
  }

  return null;
}
