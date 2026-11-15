import type { CommitType } from "./commit-types.js";
import type { PiAutocommitConfig } from "./config.js";
import { isJapanese } from "./config.js";
import { type ParsedNameStatus, parseNameStatus } from "./git-parser.js";
import { resolveScope } from "./scope-resolver.js";

export interface CommitMessage {
  type: CommitType;
  scope: string | null;
  subject: string;
  body: string;
  footer: string | null;
}

/**
 * Determine the Conventional Commits type from file paths alone.
 *
 * This is a lightweight fallback used when the LLM is unavailable.
 * No diff-content analysis — that would duplicate the LLM prompt's
 * domain logic and drift independently.
 */
function determineType(nameStatusEntries: ParsedNameStatus[]): CommitType {
  const paths = nameStatusEntries.map((e) => e.path);
  if (paths.length === 0) return "refactor";

  // Docs-only
  if (
    paths.every(
      (p) => /\.(md|txt)$/i.test(p) || /^docs\//i.test(p) || /^README/i.test(p),
    )
  ) {
    return "docs";
  }

  // Test-only
  if (
    paths.length > 0 &&
    paths.every(
      (p) =>
        /\.(test|spec)\./i.test(p) ||
        p.includes("__tests__") ||
        /\/test\//i.test(p) ||
        /^test\//i.test(p),
    )
  ) {
    return "test";
  }

  // Config-only
  if (
    paths.every((p) =>
      /package\.json|tsconfig|biome\.|\.github|\.gitignore|\.env|apm\.|Dockerfile|\.npmrc|\.prettier/i.test(
        p,
      ),
    )
  ) {
    return "chore";
  }

  // New files → feat
  if (nameStatusEntries.some((e) => e.status === "A")) return "feat";

  return "refactor";
}

/**
 * Build a simple subject line from the commit type and changed files.
 *
 * No diff-content parsing — this is a read-only fallback. The LLM path
 * handles semantic subject generation.
 */
function extractSubject(
  type: CommitType,
  nameStatusEntries: ParsedNameStatus[],
  jp: boolean,
): string {
  const hasRenames = nameStatusEntries.some((e) => e.status === "R");
  const hasDeletionsOnly =
    nameStatusEntries.length > 0 &&
    nameStatusEntries.every((e) => e.status === "D");

  if (jp) {
    switch (type) {
      case "feat":
        return "新機能を追加";
      case "fix":
        return "不具合を修正";
      case "docs":
        return "ドキュメントを更新";
      case "test":
        return "テストを追加";
      case "chore":
        return "設定を更新";
      case "style":
        return "コードスタイルを統一";
      case "perf":
        return "パフォーマンスを改善";
      default:
        if (hasRenames) return "ファイルをリネーム";
        if (hasDeletionsOnly) return "不要コードを削除";
        return "コードを整理";
    }
  }

  switch (type) {
    case "feat":
      return "add new functionality";
    case "fix":
      return "fix issues";
    case "docs":
      return "update documentation";
    case "test":
      return "add tests";
    case "chore":
      return "update configuration";
    case "style":
      return "format code";
    case "perf":
      return "improve performance";
    default:
      if (hasRenames) return "rename files";
      if (hasDeletionsOnly) return "remove dead code";
      return "refactor code";
  }
}

/**
 * Generate a simple body listing the changed files with their status.
 */
function generateBody(
  nameStatusEntries: ParsedNameStatus[],
  config: PiAutocommitConfig,
): string {
  const jp = isJapanese(config);
  const lines: string[] = [jp ? "変更内容:" : "Changes:"];

  for (const entry of nameStatusEntries) {
    const label = statusLabel(entry.status, jp);
    if (entry.status === "R" && entry.oldPath) {
      lines.push(
        jp
          ? `- ${entry.path} — ${entry.oldPath} から${label}`
          : `- ${entry.path} — ${label}d from ${entry.oldPath}`,
      );
    } else {
      lines.push(`- ${entry.path} — ${label}`);
    }
  }

  return lines.join("\n");
}

function statusLabel(status: string, jp: boolean): string {
  if (jp) {
    switch (status) {
      case "A":
        return "新規作成";
      case "D":
        return "削除";
      case "R":
        return "リネーム";
      default:
        return "変更";
    }
  }
  switch (status) {
    case "A":
      return "create";
    case "D":
      return "delete";
    case "R":
      return "rename";
    default:
      return "update";
  }
}

/**
 * Format the subject line as `type(scope): summary`.
 */
function formatSubject(
  type: CommitType,
  scope: string | null,
  summary: string,
): string {
  const typePart = scope ? `${type}(${scope})` : type;
  return `${typePart}: ${summary}`;
}

/**
 * Generate a simple fallback Conventional Commits message.
 *
 * Called when the LLM is unavailable. Produces a readable but generic
 * message — the LLM path is the single quality source.
 */
export function generateCommitMessage(
  nameStatusRaw: string,
  _stat: string,
  _diff: string,
  config: PiAutocommitConfig,
): CommitMessage {
  const entries = parseNameStatus(nameStatusRaw);

  const type = determineType(entries);
  const paths = entries.map((e) => e.path);
  const scope = resolveScope(paths, config);
  const summary = extractSubject(type, entries, isJapanese(config));
  const subject = formatSubject(type, scope, summary);
  const body = generateBody(entries, config);

  return { type, scope, subject, body, footer: null };
}

/**
 * Format the full commit message string ready for `git commit -m`.
 */
export function formatFullMessage(msg: CommitMessage): string {
  let full = msg.body ? `${msg.subject}\n\n${msg.body}` : msg.subject;
  if (msg.footer) {
    full += `\n\n${msg.footer}`;
  }
  return full;
}
