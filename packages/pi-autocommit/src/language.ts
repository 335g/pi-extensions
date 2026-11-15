/**
 * Commit message language resolution.
 *
 * Commit messages are written by the LLM, so "language support" is a
 * display-name resolution plus a cheap script heuristic for conversations
 * where the user never set `lang`. Only user messages are considered — the
 * assistant may write in a different language than the user speaks.
 * Latin-script languages (English, French, German, ...) are undetectable by
 * script and fall back to English.
 */

/** Map from known `lang` codes to display names used in LLM prompts. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  ru: "Russian",
};

/**
 * Display name for a `lang` value: known codes map to their name, anything
 * else (a language name in any language) passes through verbatim for the
 * LLM to interpret.
 */
export function languageName(lang: string): string {
  return LANGUAGE_NAMES[lang] ?? lang;
}

/**
 * Detect the conversation language from user message texts by script.
 *
 * Returns a `lang` code for the first message with a distinctive script,
 * or `undefined` when none matches. Order matters: kana is checked before
 * han so Japanese text (which mixes kanji with kana) is classified as
 * Japanese, not Chinese.
 */
export function detectLanguage(
  userTexts: ReadonlyArray<string>,
): string | undefined {
  for (const text of userTexts) {
    if (/[\u3040-\u30ff]/.test(text)) return "ja"; // hiragana / katakana
    if (/[\uac00-\ud7af]/.test(text)) return "ko"; // hangul
    if (/[\u4e00-\u9fff]/.test(text)) return "zh"; // han
    if (/[\u0400-\u04ff]/.test(text)) return "ru"; // cyrillic
  }
  return undefined;
}

/**
 * Extract text from user-role messages (structural type, no pi imports).
 * The user-side counterpart of `extractAssistantContext`.
 */
export function userMessageTexts(messages: ReadonlyArray<unknown>): string[] {
  const texts: string[] = [];
  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown };
    if (message.role !== "user") {
      continue;
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = (blocks as Array<{ type?: string; text?: string }>)
      .filter((b) => b?.type === "text" && !!b.text)
      .map((b) => b.text as string)
      .join("\n")
      .trim();
    if (text) {
      texts.push(text);
    }
  }
  return texts;
}
