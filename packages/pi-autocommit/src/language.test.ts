import assert from "node:assert";
import { describe, it } from "node:test";
import type { PiAutocommitConfig } from "./config.js";
import { isJapanese, resolvedLanguageName } from "./config.js";
import { detectLanguage, languageName, userMessageTexts } from "./language.js";

function config(over: Partial<PiAutocommitConfig> = {}): PiAutocommitConfig {
  return {
    lang: "auto",
    enable: true,
    commitPickerMaxCommits: 30,
    ...over,
    ignoreSubmodules: over.ignoreSubmodules ?? false,
    mergeSimilarPrevious: over.mergeSimilarPrevious ?? false,
    organiseMode: over.organiseMode ?? "auto",
    detectTaskBoundary: over.detectTaskBoundary ?? false,
  };
}

void describe("detectLanguage", () => {
  void it("detects script-distinctive languages from the first matching message", () => {
    assert.strictEqual(detectLanguage(["こんにちは"]), "ja");
    assert.strictEqual(detectLanguage(["안녕하세요"]), "ko");
    assert.strictEqual(detectLanguage(["你好"]), "zh");
    assert.strictEqual(detectLanguage(["Привет"]), "ru");
    assert.strictEqual(detectLanguage(["hello", "こんにちは"]), "ja");
  });

  void it("returns undefined for Latin-script messages", () => {
    assert.strictEqual(detectLanguage(["OK", "thanks"]), undefined);
    assert.strictEqual(detectLanguage([]), undefined);
  });
});

void describe("userMessageTexts", () => {
  void it("extracts text from user messages only", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello!" }] },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ];
    assert.deepStrictEqual(userMessageTexts(messages), ["hi", "thanks"]);
  });
});

void describe("languageName", () => {
  void it("maps known codes and passes other values through", () => {
    assert.strictEqual(languageName("ja"), "Japanese");
    assert.strictEqual(languageName("ko"), "Korean");
    assert.strictEqual(languageName("Korean"), "Korean");
    assert.strictEqual(languageName("한국어"), "한국어");
  });
});

void describe("resolvedLanguageName", () => {
  void it("prefers the configured lang over detection", () => {
    assert.strictEqual(
      resolvedLanguageName(config({ lang: "en", langName: "Japanese" })),
      "English",
    );
    assert.strictEqual(
      resolvedLanguageName(config({ lang: "ja", langName: "Korean" })),
      "Japanese",
    );
  });

  void it("uses the detected langName when lang is auto", () => {
    assert.strictEqual(
      resolvedLanguageName(config({ langName: "Korean" })),
      "Korean",
    );
  });

  void it("falls back to English when nothing is known", () => {
    assert.strictEqual(resolvedLanguageName(config()), "English");
  });

  void it("maps known lang codes to display names", () => {
    assert.strictEqual(resolvedLanguageName(config({ lang: "ko" })), "Korean");
    assert.strictEqual(resolvedLanguageName(config({ lang: "zh" })), "Chinese");
    assert.strictEqual(resolvedLanguageName(config({ lang: "ru" })), "Russian");
  });
});

void describe("isJapanese", () => {
  void it("is true only for Japanese", () => {
    assert.strictEqual(isJapanese(config({ lang: "ja" })), true);
    assert.strictEqual(isJapanese(config({ langName: "Japanese" })), true);
    assert.strictEqual(isJapanese(config({ lang: "en" })), false);
    assert.strictEqual(isJapanese(config({ lang: "ko" })), false);
    assert.strictEqual(isJapanese(config()), false);
  });
});
