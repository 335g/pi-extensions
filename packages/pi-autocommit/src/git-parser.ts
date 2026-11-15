/**
 * Git output parsing utilities.
 *
 * Parses structured git command output (name-status, numstat, etc.)
 * into TypeScript types for use across the commit pipeline.
 */

/**
 * A single entry from `git diff --cached --name-status`.
 */
export interface ParsedNameStatus {
  status: "A" | "M" | "D" | "R";
  path: string;
  oldPath?: string; // for renames
}

/**
 * Parse `git diff --cached --name-status` output into structured entries.
 */
export function parseNameStatus(raw: string): ParsedNameStatus[] {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line) => {
    const parts = line.split("\t");
    const statusRaw = parts[0].trim();
    const status = (
      statusRaw[0] === "R" ? "R" : statusRaw[0]
    ) as ParsedNameStatus["status"];
    const path = parts[parts.length - 1]?.trim() ?? "";
    const oldPath =
      status === "R" && parts.length >= 3 ? parts[1].trim() : undefined;
    return { status, path, oldPath };
  });
}
