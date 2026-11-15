import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSessionEnabled, loadConfig } from "./config.js";
import type { GitOperations } from "./git-operations.js";

/**
 * Shared footer-status updater for the checkpoint pipeline and organiser.
 *
 * Used exclusively by the presenter in index.ts, both in the success and
 * error paths. Reads the config itself so every call site stays a no-arg
 * `updateFooter()`.
 */
export class StatusIndicator {
  constructor(
    private git: GitOperations,
    private ctx: ExtensionContext,
  ) {}

  async updateFooter(): Promise<void> {
    const config = loadConfig(this.ctx.cwd);
    try {
      // The mode is only meaningful while auto-commit runs; hide it otherwise.
      this.ctx.ui.setStatus(
        "pi-autocommit-mode",
        isSessionEnabled(this.ctx.cwd) ? `[${config.organiseMode}]` : undefined,
      );

      if (!(await this.git.isInsideGitRepo())) {
        this.ctx.ui.setStatus("pi-autocommit-uncommitted", undefined);
        return;
      }
      const hasChanges = await this.git.checkUncommittedChanges();
      this.ctx.ui.setStatus(
        "pi-autocommit-uncommitted",
        hasChanges ? "[has changes]" : undefined,
      );
    } catch {
      this.ctx.ui.setStatus("pi-autocommit-uncommitted", undefined);
    }
  }
}
