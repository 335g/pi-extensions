import assert from "node:assert";
import { describe, it } from "node:test";
import { parseNameStatus } from "./git-parser.js";

void describe("parseNameStatus", () => {
  void it("returns an empty array for empty input", () => {
    assert.deepStrictEqual(parseNameStatus(""), []);
  });

  void it("returns an empty array for whitespace-only input", () => {
    assert.deepStrictEqual(parseNameStatus("   \n  \n"), []);
  });

  void it("parses a single added file", () => {
    assert.deepStrictEqual(parseNameStatus("A\tfoo.ts"), [
      { status: "A", path: "foo.ts", oldPath: undefined },
    ]);
  });

  void it("parses a single modified file", () => {
    assert.deepStrictEqual(parseNameStatus("M\tbar.ts"), [
      { status: "M", path: "bar.ts", oldPath: undefined },
    ]);
  });

  void it("parses a single deleted file", () => {
    assert.deepStrictEqual(parseNameStatus("D\tbaz/qux.ts"), [
      { status: "D", path: "baz/qux.ts", oldPath: undefined },
    ]);
  });

  void it("parses a single renamed file with old path", () => {
    assert.deepStrictEqual(parseNameStatus("R100\told.ts\tnew.ts"), [
      { status: "R", path: "new.ts", oldPath: "old.ts" },
    ]);
  });

  void it("parses multiple entries", () => {
    const input = [
      "A\tsrc/new.ts",
      "M\tsrc/modified.ts",
      "D\tsrc/deleted.ts",
    ].join("\n");
    assert.deepStrictEqual(parseNameStatus(input), [
      { status: "A", path: "src/new.ts", oldPath: undefined },
      { status: "M", path: "src/modified.ts", oldPath: undefined },
      { status: "D", path: "src/deleted.ts", oldPath: undefined },
    ]);
  });

  void it("handles mixed renames with other statuses", () => {
    const input = ["R065\told.ts\tnew.ts", "M\tunchanged.ts"].join("\n");
    assert.deepStrictEqual(parseNameStatus(input), [
      { status: "R", path: "new.ts", oldPath: "old.ts" },
      { status: "M", path: "unchanged.ts", oldPath: undefined },
    ]);
  });

  void it("handles rename without oldPath when parts < 3", () => {
    // Edge case: malformed R entry with only 2 tab-separated parts
    const result = parseNameStatus("R\tfile.ts");
    // status is "R" but no oldPath when parts < 3
    assert.strictEqual(result[0].status, "R");
    assert.strictEqual(result[0].path, "file.ts");
    assert.strictEqual(result[0].oldPath, undefined);
  });

  void it("trims whitespace from status and path", () => {
    // The function trims the status prefix but NOT the path.
    //  "  A\t  foo.ts  " → status is trimmed to "A", path keeps surrounding whitespace.
    // However the original code uses `?.trim()` on the path, so it IS trimmed.
    assert.deepStrictEqual(parseNameStatus("  A\t  foo.ts  "), [
      { status: "A", path: "foo.ts", oldPath: undefined },
    ]);
  });

  void it("supports copy status (C)", () => {
    // C entries use status[0] which is 'C'; the union type excludes it
    // but parseNameStatus still casts it. Unlike rename, oldPath is NOT
    // populated for copy status because the condition checks for "R".
    const result = parseNameStatus("C100\torig.ts\tcopy.ts");
    assert.strictEqual(result[0].status, "C");
    assert.strictEqual(result[0].path, "copy.ts");
    assert.strictEqual(result[0].oldPath, undefined);
  });
});
