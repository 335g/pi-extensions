import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiAutocommitConfig } from "./config.js";

/**
 * Validation result for a model string in `"provider/modelId"` format.
 */
export type ModelValidation =
  | { ok: true; model: Model<Api> }
  | { ok: false; reason: string };

/**
 * Validate a model string in `"provider/modelId"` format against the model
 * registry.
 *
 * Runs three checks in order:
 * 1. Format — must contain a `/` with non-empty provider and modelId parts.
 * 2. Registry — the model must exist in `ctx.modelRegistry`.
 * 3. Auth — the model must have configured auth.
 *
 * Returns the resolved model on success, or a human-readable `reason` on
 * failure. Used both by `resolveModel` (for commit message generation) and
 * by the `/autocommit-model` command (for argument validation).
 */
export function validateModelString(
  ctx: ExtensionContext,
  modelStr: string,
): ModelValidation {
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx < 1 || slashIdx >= modelStr.length - 1) {
    return {
      ok: false,
      reason:
        `Invalid model format "${modelStr}". ` +
        `Expected "provider/modelId" (e.g. "anthropic/claude-sonnet-4").`,
    };
  }

  const provider = modelStr.slice(0, slashIdx);
  const modelId = modelStr.slice(slashIdx + 1);
  const resolved = ctx.modelRegistry.find(provider, modelId);

  if (!resolved) {
    return {
      ok: false,
      reason: `Model "${modelStr}" not found in registry.`,
    };
  }

  if (!ctx.modelRegistry.hasConfiguredAuth(resolved)) {
    return {
      ok: false,
      reason: `Model "${modelStr}" not configured (no API key).`,
    };
  }

  return { ok: true, model: resolved };
}

/**
 * Resolve the model to use for commit message generation.
 *
 * When `config.model` is set (in `"provider/modelId"` format), validate it
 * via `validateModelString`. If the model is invalid (bad format, not found,
 * or no auth), fall back to `ctx.model` and log a warning.
 *
 * Used by the commit prompt module and by the `/autocommit-model` command.
 */
export function resolveModel(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
): Model<Api> | undefined {
  const modelStr = config.model;
  if (!modelStr || !ctx.model) {
    return ctx.model;
  }

  const result = validateModelString(ctx, modelStr);
  if (!result.ok) {
    console.warn(
      `[pi-autocommit] ${result.reason} Falling back to session model.`,
    );
    return ctx.model;
  }

  return result.model;
}
