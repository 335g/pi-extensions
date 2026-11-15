import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList, type SelectListTheme } from "@earendil-works/pi-tui";
import {
  buildModelSelectItems,
  CLEAR_LABEL,
  CLEAR_VALUE,
  MAX_VISIBLE_MODELS,
  modelPopupMaxVisible,
  showModelPopup,
} from "./model-popup.js";

/**
 * Minimal theme stub: `SelectList.render` only calls these string transforms.
 */
const theme: SelectListTheme = {
  selectedPrefix: (t) => t,
  selectedText: (t) => t,
  description: (t) => t,
  scrollInfo: (t) => t,
  noMatch: (t) => t,
};

/**
 * Minimal `ExtensionContext` stub exposing only `modelRegistry.getAvailable()`.
 */
function makeCtx(
  models: Array<{ provider: string; id: string; name: string }>,
): unknown {
  return {
    modelRegistry: {
      getAvailable: () => models,
    },
  };
}

function fakeModels(
  n: number,
): Array<{ provider: string; id: string; name: string }> {
  return Array.from({ length: n }, (_, i) => ({
    provider: "p",
    id: `m${i}`,
    name: `Model ${i}`,
  }));
}

void describe("buildModelSelectItems", () => {
  void it("places the clear entry first with the sentinel value", () => {
    const ctx = makeCtx(fakeModels(3));
    const items = buildModelSelectItems(ctx as never, "p/m0");

    assert.strictEqual(items[0].value, CLEAR_VALUE);
    assert.ok(
      items[0].label.startsWith(CLEAR_LABEL),
      `expected clear label, got ${items[0].label}`,
    );
  });

  void it("marks the clear entry (current) when no model is set", () => {
    const ctx = makeCtx(fakeModels(1));
    const items = buildModelSelectItems(ctx as never, undefined);

    assert.strictEqual(items[0].value, CLEAR_VALUE);
    assert.strictEqual(items[0].label, `${CLEAR_LABEL} (current)`);
  });

  void it("includes provider/modelId values and model names", () => {
    const ctx = makeCtx(fakeModels(2));
    const items = buildModelSelectItems(ctx as never, undefined);

    assert.deepStrictEqual(items[1], {
      value: "p/m0",
      label: "p/m0",
      description: "Model 0",
    });
    assert.deepStrictEqual(items[2], {
      value: "p/m1",
      label: "p/m1",
      description: "Model 1",
    });
  });

  void it("marks the current model with (current) but keeps its raw value", () => {
    const ctx = makeCtx(fakeModels(2));
    const items = buildModelSelectItems(ctx as never, "p/m1");

    const current = items.find((i) => i.value === "p/m1");
    assert.ok(current);
    assert.strictEqual(current?.label, "p/m1 (current)");
  });

  void it("appends the configured model when it is unavailable", () => {
    const ctx = makeCtx(fakeModels(1));
    const items = buildModelSelectItems(ctx as never, "p/missing");

    const tail = items[items.length - 1];
    assert.strictEqual(tail.value, "p/missing");
    assert.strictEqual(tail.label, "p/missing (current, unavailable)");
  });
});

void describe("model popup viewport (red-capable for top-clipping bug)", () => {
  void it("renders at most MAX_VISIBLE rows regardless of model count", () => {
    const ctx = makeCtx(fakeModels(65));
    const items = buildModelSelectItems(ctx as never, undefined);
    const maxVisible = modelPopupMaxVisible(items);

    assert.strictEqual(maxVisible, MAX_VISIBLE_MODELS);

    const list = new SelectList(items, maxVisible, theme);
    const lines = list.render(80);

    // +1 for the scroll indicator line shown when the list is truncated.
    assert.ok(
      lines.length <= maxVisible + 1,
      `expected <= ${maxVisible + 1} rendered lines, got ${lines.length}`,
    );
    assert.ok(
      lines.length < items.length,
      `expected scrolling (got all ${items.length} items in ${lines.length} lines)`,
    );
  });

  void it("renders all items when fewer than MAX_VISIBLE", () => {
    const ctx = makeCtx(fakeModels(3));
    const items = buildModelSelectItems(ctx as never, undefined);
    const maxVisible = modelPopupMaxVisible(items);

    assert.strictEqual(maxVisible, items.length);

    const list = new SelectList(items, maxVisible, theme);
    const lines = list.render(80);

    // No scroll indicator when nothing is truncated.
    assert.ok(
      lines.length <= maxVisible,
      `expected <= ${maxVisible} rendered lines, got ${lines.length}`,
    );
  });
});

/**
 * Minimal context with a mock UI for testing showModelPopup.
 */
function makeCtxWithUI(
  models: Array<{ provider: string; id: string; name: string }>,
  mode: "tui" | "rpc",
  ui: unknown,
): unknown {
  return {
    mode,
    hasUI: true,
    modelRegistry: {
      getAvailable: () => models,
    },
    ui,
  };
}

void describe("showModelPopup", () => {
  void it("returns the selected model in TUI mode", async () => {
    const ctx = makeCtxWithUI(fakeModels(2), "tui", {
      custom: async () => "p/m1",
    });

    const result = await showModelPopup(ctx as never, undefined);

    assert.strictEqual(result, "p/m1");
  });

  void it("returns null when TUI popup is cancelled", async () => {
    const ctx = makeCtxWithUI(fakeModels(2), "tui", {
      custom: async () => null,
    });

    const result = await showModelPopup(ctx as never, undefined);

    assert.strictEqual(result, null);
  });

  void it("returns the selected model in non-TUI mode", async () => {
    const ctx = makeCtxWithUI(fakeModels(2), "rpc", {
      select: async () => "p/m0",
    });

    const result = await showModelPopup(ctx as never, undefined);

    assert.strictEqual(result, "p/m0");
  });

  void it("returns null when non-TUI select is cancelled", async () => {
    const ctx = makeCtxWithUI(fakeModels(2), "rpc", {
      select: async () => undefined,
    });

    const result = await showModelPopup(ctx as never, undefined);

    assert.strictEqual(result, null);
  });

  void it("returns CLEAR_VALUE when clear label is selected in non-TUI mode", async () => {
    const ctx = makeCtxWithUI(fakeModels(2), "rpc", {
      select: async () => CLEAR_LABEL,
    });

    const result = await showModelPopup(ctx as never, undefined);

    assert.strictEqual(result, CLEAR_VALUE);
  });

  void it("strips the (current) suffix from non-TUI selection", async () => {
    const ctx = makeCtxWithUI(fakeModels(2), "rpc", {
      select: async () => "p/m0 (current)",
    });

    const result = await showModelPopup(ctx as never, "p/m0");

    assert.strictEqual(result, "p/m0");
  });
});
