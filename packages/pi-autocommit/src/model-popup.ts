import {
  DynamicBorder,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

/**
 * Sentinel value for the "use session model" (clear) popup entry.
 *
 * A non-empty, model-namespace-safe sentinel so it can never collide with a
 * real `"provider/modelId"` value returned by the registry.
 */
export const CLEAR_VALUE = "\u0000pi-autocommit-clear";

/** Label for the "use session model" (clear) popup entry. */
export const CLEAR_LABEL = "Use session model (clear)";

/**
 * Max rows the model popup shows before scrolling.
 *
 * Bounds the rendered height so the popup never overflows the terminal,
 * even when hundreds of models are registered. The actual height is
 * `Math.min(items.length, MAX_VISIBLE_MODELS)`; `SelectList` handles the
 * scrolling window and shows a `(n/total)` indicator when truncated.
 */
export const MAX_VISIBLE_MODELS = 10;

/**
 * Build the popup option list as `SelectList` items: clear entry first,
 * then the available models. The current value is marked with `(current)`.
 *
 * The `value` is the raw `"provider/modelId"` string (or `CLEAR_VALUE`), so
 * the selected item round-trips directly into `saveModel` without label
 * parsing.
 */
export function buildModelSelectItems(
  ctx: ExtensionContext,
  currentModel: string | undefined,
): SelectItem[] {
  const labelFor = (label: string, value: string | undefined): string =>
    value === currentModel ? `${label} (current)` : label;

  const items: SelectItem[] = [
    {
      value: CLEAR_VALUE,
      label: labelFor(CLEAR_LABEL, undefined),
      description: "Fall back to the session model.",
    },
  ];

  for (const model of ctx.modelRegistry.getAvailable()) {
    const value = `${model.provider}/${model.id}`;
    items.push({
      value,
      label: labelFor(value, value),
      description: model.name,
    });
  }

  // Mention the current value in case it's no longer in the available list,
  // so the user can see what is configured and switch away from it.
  if (currentModel && !items.some((i) => i.value === currentModel)) {
    items.push({
      value: currentModel,
      label: `${currentModel} (current, unavailable)`,
      description: "Configured model no longer available.",
    });
  }

  return items;
}

/**
 * Build the popup option list as plain strings.
 *
 * Used only by the non-TUI fallback (`ctx.ui.select`), which takes string
 * options. The TUI path uses `buildModelSelectItems` (SelectItem[]) with a
 * bounded, scrollable `SelectList` in the editor region.
 */
export function buildModelOptions(
  ctx: ExtensionContext,
  currentModel: string | undefined,
): string[] {
  const markCurrent = (label: string, value: string | undefined): string =>
    value === currentModel ? `${label} (current)` : label;

  const options: string[] = [markCurrent(CLEAR_LABEL, undefined)];

  for (const model of ctx.modelRegistry.getAvailable()) {
    const value = `${model.provider}/${model.id}`;
    options.push(markCurrent(value, value));
  }

  // Mention the current value in case it's not in the available list.
  if (currentModel && !options.some((o) => o.startsWith(currentModel))) {
    options.push(`${currentModel} (current, unavailable)`);
  }

  return options;
}

/**
 * Show the model selector popup and return the user's choice.
 *
 * In the TUI, renders a `SelectList` in the editor region via
 * `ctx.ui.custom()` (non-overlay), matching pi's built-in `/model` selector
 * UX: the chat history stays visible above and the popup does not overlap
 * it. The viewport is capped at `MAX_VISIBLE_MODELS` rows and scrolls, so
 * the list never overflows the terminal. In non-TUI modes (e.g. RPC), falls
 * back to `ctx.ui.select`.
 *
 * @returns The selected model value (`provider/modelId` or `CLEAR_VALUE`),
 *          or `null` if the user cancelled.
 */
export async function showModelPopup(
  ctx: ExtensionContext,
  currentModel: string | undefined,
): Promise<string | null> {
  const current = currentModel ?? "session model";
  const title = `pi-autocommit: select model (current: ${current})`;

  if (ctx.mode === "tui") {
    const items = buildModelSelectItems(ctx, currentModel);
    const maxVisible = Math.min(items.length, MAX_VISIBLE_MODELS);

    return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(
        new DynamicBorder((s: string) => theme.fg("accent", s)),
      );
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      container.addChild(
        new Text(
          theme.fg("dim", "↑↓ navigate · enter select · esc cancel"),
          1,
          0,
        ),
      );

      const selectList = new SelectList(items, maxVisible, {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      container.addChild(selectList);

      container.addChild(
        new DynamicBorder((s: string) => theme.fg("accent", s)),
      );

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  // Non-TUI (e.g. RPC): fall back to the built-in string select dialog.
  const options = buildModelOptions(ctx, currentModel);
  const choice = await ctx.ui.select(title, options);
  if (choice === undefined) {
    return null; // cancelled
  }

  if (choice === CLEAR_LABEL || choice.startsWith(`${CLEAR_LABEL} `)) {
    return CLEAR_VALUE;
  }

  // Strip the trailing `(current)` marker if present.
  return choice.replace(/ \(current\)$/, "");
}

/**
 * The number of visible rows the popup should render. Exposed for tests so
 * the bounded-viewport invariant can be asserted independently of the
 * `SelectList` implementation.
 */
export function modelPopupMaxVisible(items: SelectItem[]): number {
  return Math.min(items.length, MAX_VISIBLE_MODELS);
}
