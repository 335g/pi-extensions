import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { languageName } from "./language.js";

// Known config keys (camelCase as they appear in JSON)
const KNOWN_KEYS = new Set([
  "lang",
  "enable",
  "model",
  "scope",
  "commitPickerMaxCommits",
  "ignoreSubmodules",
  "mergeSimilarPrevious",
  "organiseMode",
  "detectTaskBoundary",
]);

/** Config file name, relative to `.pi/`. */
const CONFIG_FILENAME = "pi-autocommit.json";

/**
 * How much control the user gets when checkpoints are reorganised.
 *
 * - `auto` — reorganise silently at `agent_end` (no popup).
 * - `picker` — show the commit picker at `agent_end` so the range to
 *   reorganise is chosen by hand.
 * - `review` — the picker, then a confirm/edit dialog for every proposed
 *   commit before anything is written.
 *
 * `/autocommit-organise` always shows the picker regardless of this setting.
 */
export const ORGANISE_MODES = ["auto", "picker", "review"] as const;
export type OrganiseMode = (typeof ORGANISE_MODES)[number];

export function isOrganiseMode(value: unknown): value is OrganiseMode {
  return (
    typeof value === "string" &&
    (ORGANISE_MODES as readonly string[]).includes(value)
  );
}

/**
 * Normalised configuration for the pi-autocommit extension.
 */
export interface PiAutocommitConfig {
  /**
   * Language for the commit message (subject and body). `"auto"` (default)
   * resolves from the conversation; any language name or code (e.g. `"ja"`,
   * `"Korean"`) is passed to the LLM prompt as-is.
   */
  lang: string;
  /**
   * Resolved commit message language display name (e.g. "Japanese"), set by
   * the reorganiser from conversation auto-detection when `lang` is unset.
   * Runtime-only — never persisted to the config file.
   */
  langName?: string;
  /** Whether auto-commit is enabled. Defaults to `false`. */
  enable: boolean;
  /**
   * LLM model for commit message generation, in `"provider/modelId"` format
   * (e.g. `"anthropic/claude-sonnet-4"`).
   * When omitted, the session's current model is used.
   */
  model?: string;
  /**
   * Path-to-scope mapping that fixes the Conventional Commits scope
   * deterministically. Keys are picomatch globs evaluated against changed
   * file paths; values are the scope to apply. When set, the LLM is told to
   * omit scope and the scope is injected by `scope-resolver.ts`.
   * When unset (or empty), the LLM infers the scope as before.
   */
  scope?: Record<string, string>;

  /**
   * Maximum number of recent commits to fetch from HEAD for the commit picker
   * popup shown at `agent_end`. Defaults to `30`.
   */
  commitPickerMaxCommits: number;

  /**
   * Keep submodule-related parent-side changes out of auto-commits:
   * gitlink updates (mode 160000 index entries, including absorbed embedded
   * repositories) and `.gitmodules`. When `true`, checkpoint commits and the
   * reorganiser never stage or record these paths; recording the pin updates
   * is left to the user. Detached-orphan warnings stay active, presented as
   * informational notices at `session_start` only. Defaults to `false`
   * (gitlinks are recorded like any other changed file, per ADR-0008).
   */
  ignoreSubmodules: boolean;

  /**
   * Merge reorganisation into the previous commit when it is a similar commit
   * (same changed-file set and same Conventional Commit `type`/`scope`) and is
   * not yet pushed. When the previous commit is already on the remote it is
   * left untouched and a notice is shown instead. Defaults to `true`.
   */
  mergeSimilarPrevious: boolean;

  /**
   * Whether a model call decides that the turn just ended completed one piece
   * of the user's request, so the pending checkpoint run can be reorganised
   * at that boundary instead of waiting for a new user instruction. Costs one
   * short call per mutating turn. Defaults to `true`. See ADR-0015.
   */
  detectTaskBoundary: boolean;

  /**
   * How much control `agent_end` hands over: `"auto"` (the default) reorganises
   * silently, `"picker"` stops on the commit picker, `"review"` also offers the
   * partition editor and confirms every proposed commit message before
   * committing. See ADR-0012, ADR-0013 and ADR-0014.
   */
  organiseMode: OrganiseMode;
}

const DEFAULT_CONFIG: PiAutocommitConfig = {
  lang: "auto",
  enable: false,
  commitPickerMaxCommits: 30,
  ignoreSubmodules: false,
  mergeSimilarPrevious: true,
  organiseMode: "auto",
  detectTaskBoundary: true,
};

/**
 * Load `.pi/pi-autocommit.json` from the project root.
 *
 * Returns default config (language auto-detect, auto-commit disabled) when
 * the file is missing or unreadable.
 */
export function loadConfig(cwd: string): PiAutocommitConfig {
  try {
    const configPath = join(cwd, ".pi", CONFIG_FILENAME);
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Warn about unknown (possibly misspelled) keys
    const unknownKeys = Object.keys(parsed).filter((k) => !KNOWN_KEYS.has(k));
    if (unknownKeys.length > 0) {
      console.warn(
        `[pi-autocommit] Unknown config key(s): ${unknownKeys.join(", ")}. ` +
          `Valid keys: ${[...KNOWN_KEYS].join(", ")}`,
      );
    }

    const lang =
      typeof parsed.lang === "string" && parsed.lang.trim().length > 0
        ? parsed.lang.trim()
        : DEFAULT_CONFIG.lang;

    const enable =
      typeof parsed.enable === "boolean"
        ? parsed.enable
        : DEFAULT_CONFIG.enable;

    const model =
      typeof parsed.model === "string" && parsed.model.trim().length > 0
        ? parsed.model.trim()
        : undefined;

    const scope =
      parsed.scope !== null &&
      typeof parsed.scope === "object" &&
      !Array.isArray(parsed.scope)
        ? normaliseScope(parsed.scope as Record<string, unknown>)
        : undefined;

    const commitPickerMaxCommits =
      typeof parsed.commitPickerMaxCommits === "number" &&
      Number.isInteger(parsed.commitPickerMaxCommits) &&
      parsed.commitPickerMaxCommits > 0
        ? parsed.commitPickerMaxCommits
        : DEFAULT_CONFIG.commitPickerMaxCommits;

    const ignoreSubmodules =
      typeof parsed.ignoreSubmodules === "boolean"
        ? parsed.ignoreSubmodules
        : DEFAULT_CONFIG.ignoreSubmodules;

    const mergeSimilarPrevious =
      typeof parsed.mergeSimilarPrevious === "boolean"
        ? parsed.mergeSimilarPrevious
        : DEFAULT_CONFIG.mergeSimilarPrevious;

    const organiseMode = isOrganiseMode(parsed.organiseMode)
      ? parsed.organiseMode
      : DEFAULT_CONFIG.organiseMode;

    const detectTaskBoundary =
      typeof parsed.detectTaskBoundary === "boolean"
        ? parsed.detectTaskBoundary
        : DEFAULT_CONFIG.detectTaskBoundary;

    return {
      lang,
      enable,
      model,
      scope,
      commitPickerMaxCommits,
      ignoreSubmodules,
      mergeSimilarPrevious,
      organiseMode,
      detectTaskBoundary,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Normalise a raw `scope` object into a `path → scope` record.
 *
 * Drops entries whose value is not a non-empty string. Returns `undefined`
 * when the result would be empty, so an absent/empty scope is treated the
 * same as no scope at all.
 */
function normaliseScope(
  raw: Record<string, unknown>,
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim().length > 0) {
      result[key] = value.trim();
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Write one key into `.pi/pi-autocommit.json`, preserving every other key.
 * Pass `undefined` to delete the key. Creates the file when missing.
 */
function persist(cwd: string, key: string, value: unknown): void {
  const configPath = join(cwd, ".pi", CONFIG_FILENAME);

  let parsed: Record<string, unknown> = {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Missing or unreadable file — start from defaults.
    parsed = { lang: DEFAULT_CONFIG.lang, enable: DEFAULT_CONFIG.enable };
  }

  if (value === undefined) {
    delete parsed[key];
  } else {
    parsed[key] = value;
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

/**
 * Persist `enable` to `.pi/pi-autocommit.json`, preserving every other key.
 */
export function saveEnable(cwd: string, enable: boolean): void {
  persist(cwd, "enable", enable);
}

/**
 * Session-scoped snapshot of `enable`.
 *
 * The config file is shared by every session, so re-reading it mid-session
 * would let a toggle in another session switch this one on or off. `init`
 * fixes the value at session start; `/autocommit-enable` changes only the
 * current session's copy. `undefined` means "not initialised yet" and falls
 * back to the file.
 */
let sessionEnable: boolean | undefined;

/** Snapshot `enable` from the config file for this session. */
export function initSessionEnable(cwd: string): void {
  sessionEnable = loadConfig(cwd).enable;
}

/** Whether auto-commit is enabled for this session (snapshot, not the file). */
export function isSessionEnabled(cwd: string): boolean {
  return sessionEnable ?? loadConfig(cwd).enable;
}

/** Update this session's snapshot (the file is written separately). */
export function setSessionEnable(enable: boolean): void {
  sessionEnable = enable;
}

/**
 * Persist `model` to `.pi/pi-autocommit.json`, preserving every other key.
 * Pass `undefined` to clear the `model` key entirely (fall back to the
 * session model).
 */
export function saveModel(cwd: string, model: string | undefined): void {
  persist(cwd, "model", model);
}

/**
 * Persist `organiseMode` to `.pi/pi-autocommit.json`, preserving every other
 * key.
 */
export function saveOrganiseMode(cwd: string, mode: OrganiseMode): void {
  persist(cwd, "organiseMode", mode);
}

/**
 * The language display name used for commit message generation, by
 * priority: the `lang` config when set (a fixed language wins over
 * detection), else the auto-detected `langName` (set at `agent_end`),
 * else English.
 */
export function resolvedLanguageName(config: PiAutocommitConfig): string {
  if (config.lang && config.lang !== "auto") {
    return languageName(config.lang);
  }
  return config.langName ?? "English";
}

/**
 * Returns `true` when the commit message should be written in Japanese.
 */
export function isJapanese(config: PiAutocommitConfig): boolean {
  return resolvedLanguageName(config) === "Japanese";
}
