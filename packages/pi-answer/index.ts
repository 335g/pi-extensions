/**
 * pi-answer: extract questions from the last assistant message and answer them
 * in an interactive Q&A TUI.
 *
 * Port of https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/answer.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonWithRepair, type Api, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

interface ExtractedQuestion {
	question: string;
	context?: string;
	/** Short candidate answers; pressing 1-9 inserts one when the answer is empty. */
	options?: string[];
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

type ExtractionOutcome =
	| { status: "ok"; result: ExtractionResult }
	| { status: "cancelled" }
	| { status: "error"; message: string };

type AnswerLanguage = "en" | "ja";

interface AnswerConfig {
	/** Locale string in the same format as LANG, e.g. "ja_JP.UTF-8". */
	lang?: string;
	/** `provider/modelId` or bare `modelId`; the session model when unset or unknown. */
	model?: string;
}

/** Project config (when trusted) overrides the global one, key by key. */
function readConfig(ctx: ExtensionContext): AnswerConfig {
	const global = readConfigFile(join(getAgentDir(), "pi-answer.json"));
	if (!ctx.isProjectTrusted()) return global;
	return { ...global, ...readConfigFile(join(ctx.cwd, CONFIG_DIR_NAME, "pi-answer.json")) };
}

function readConfigFile(path: string): AnswerConfig {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return {};
		const record = parsed as Record<string, unknown>;
		const config: AnswerConfig = {};
		if (typeof record.lang === "string" && record.lang.trim().length > 0) config.lang = record.lang.trim();
		if (typeof record.model === "string" && record.model.trim().length > 0) config.model = record.model.trim();
		return config;
	} catch {
		// Missing or unreadable config: defaults.
		return {};
	}
}

/** `lang` in the config, else the locale. Both use LANG format. */
function resolveLanguage(config: AnswerConfig): AnswerLanguage {
	const locale = config.lang ?? process.env.LC_ALL ?? process.env.LANG ?? "";
	return /^ja/i.test(locale) ? "ja" : "en";
}

/** The configured extraction model, or the session model when unset/unknown. */
function resolveModel(
	ctx: ExtensionContext,
	config: AnswerConfig,
	messages: Messages,
	sessionModel: Model<Api>,
): Model<Api> {
	const configured = config.model;
	if (!configured) return sessionModel;

	const slash = configured.indexOf("/");
	const provider = slash === -1 ? undefined : configured.slice(0, slash);
	const modelId = slash === -1 ? configured : configured.slice(slash + 1);
	const match = ctx.modelRegistry
		.getAvailable()
		.find((model) => model.id === modelId && (provider === undefined || model.provider === provider));
	if (match) return match;

	ctx.ui.notify(messages.modelUnavailable(configured, sessionModel.id), "warning");
	return sessionModel;
}

interface Messages {
	extracting(modelId: string): string;
	requiresTui: string;
	noModel: string;
	modelUnavailable(configured: string, fallback: string): string;
	incomplete(reason: string): string;
	noAssistantMessages: string;
	cancelled: string;
	extractionFailed(message: string): string;
	extractionFailedGeneric: string;
	extractionInvalidJson: string;
	noQuestions: string;
	noAnswersToSubmit: string;
	titleQuestions(page: number, total: number): string;
	titleReview(answered: number, total: number): string;
	titleFreeSpace(page: number, total: number): string;
	freeSpaceHint: string;
	answerLabel: string;
	nothingToSubmit: string;
	submitPrompt: string;
	submitKeys: string;
	discardPrompt: string;
	discardKeys: string;
	editingKeys: string;
	submittedPrefix: string;
}

const MESSAGES: Record<AnswerLanguage, Messages> = {
	en: {
		extracting: (modelId) => `Extracting questions using ${modelId}...`,
		requiresTui: "answer requires interactive mode",
		noModel: "No model selected",
		modelUnavailable: (configured, fallback) =>
			`pi-answer.json model "${configured}" is not available; using ${fallback}`,
		incomplete: (reason) => `Last assistant message incomplete (${reason})`,
		noAssistantMessages: "No assistant messages found",
		cancelled: "Cancelled",
		extractionFailed: (message) => `Question extraction failed: ${message}`,
		extractionFailedGeneric: "question extraction failed",
		extractionInvalidJson: "question extraction returned invalid JSON",
		noQuestions: "No questions found in the last message",
		noAnswersToSubmit: "No answers to submit",
		titleQuestions: (page, total) => `Questions (${page}/${total})`,
		titleReview: (answered, total) => `Review (${answered}/${total} answered)`,
		titleFreeSpace: (page, total) => `Free space (${page}/${total})`,
		freeSpaceHint: "Free space: Extra notes that are not part of an answer (optional).",
		answerLabel: "A: ",
		nothingToSubmit: "Nothing to submit yet: answer a question or write a note.",
		submitPrompt: "Submit all answers?",
		submitKeys: "Enter/y submit · Esc/n first Q · l last Q",
		discardPrompt: "Discard all answers?",
		discardKeys: "Enter/y discard · Esc/n keep editing",
		editingKeys:
			"Tab/Enter next · Shift+Tab prev · Shift+Enter newline · Ctrl+X exclude · Esc cancel",
		submittedPrefix: "I answered your questions in the following way:",
	},
	ja: {
		extracting: (modelId) => `${modelId} で質問を抽出中...`,
		requiresTui: "answer は対話モードでのみ使えます",
		noModel: "モデルが選択されていません",
		modelUnavailable: (configured, fallback) =>
			`pi-answer.json の model "${configured}" が見つかりません。${fallback} を使います`,
		incomplete: (reason) => `最後のアシスタントメッセージが未完です (${reason})`,
		noAssistantMessages: "アシスタントのメッセージが見つかりません",
		cancelled: "キャンセルしました",
		extractionFailed: (message) => `質問の抽出に失敗しました: ${message}`,
		extractionFailedGeneric: "質問の抽出に失敗しました",
		extractionInvalidJson: "抽出結果の JSON が不正です",
		noQuestions: "最後のメッセージに質問はありません",
		noAnswersToSubmit: "送信する回答がありません",
		titleQuestions: (page, total) => `質問 (${page}/${total})`,
		titleReview: (answered, total) => `確認 (${answered}/${total} 回答済み)`,
		titleFreeSpace: (page, total) => `フリースペース (${page}/${total})`,
		freeSpaceHint: "フリースペース: 回答に含めない補足（任意）。回答のあとにエージェントへ渡されます。",
		answerLabel: "回答: ",
		nothingToSubmit: "送信する内容がまだありません。回答するかメモを書いてください。",
		submitPrompt: "全ての回答を送信しますか？",
		submitKeys: "Enter/y 送信 · Esc/n 最初の質問 · l 最後の質問",
		discardPrompt: "全ての回答を破棄しますか？",
		discardKeys: "Enter/y 破棄 · Esc/n 編集に戻る",
		editingKeys: "Tab/Enter 次へ · Shift+Tab 前へ · Shift+Enter 改行 · Ctrl+X 質問を除外 · Esc キャンセル",
		submittedPrefix: "質問に以下のとおり回答しました:",
	},
};

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question",
      "options": ["Short answer A", "Short answer B"]
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- Add "options" (2 to 4 items, each under 20 characters) when the question has a small set of likely answers, ordered with the most likely first
- Omit "options" for open-ended questions
- If no questions are found, return {"questions": []}`;

function isOpencodeHost(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname === "opencode.ai";
	} catch {
		return false;
	}
}

/**
 * Pi's own requests carry these headers for opencode models; the registry's
 * `complete()` bypasses the agent's stream wrapper, so add them here.
 */
function opencodeSessionHeaders(model: Model<Api>, sessionId: string | undefined) {
	if (!sessionId) return undefined;
	const isOpencode =
		model.provider === "opencode" || model.provider === "opencode-go" || isOpencodeHost(model.baseUrl);
	return isOpencode ? { "x-opencode-session": sessionId, "x-opencode-client": "pi" } : undefined;
}

function toExtractedQuestion(value: unknown): ExtractedQuestion | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.question !== "string") return null;
	if (record.context !== undefined && record.context !== null && typeof record.context !== "string") {
		return null;
	}
	const parsed: ExtractedQuestion =
		typeof record.context === "string" && record.context.length > 0
			? { question: record.question, context: record.context }
			: { question: record.question };
	if (Array.isArray(record.options)) {
		// Model output, so accept only what we can render as number keys 1-9.
		const options = record.options
			.filter((option): option is string => typeof option === "string")
			.map((option) => option.trim())
			.filter((option) => option.length > 0)
			.slice(0, 9);
		if (options.length > 1) parsed.options = options;
	}
	return parsed;
}

function toExtractionResult(value: unknown): ExtractionResult | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.questions)) return null;
	const questions: ExtractedQuestion[] = [];
	for (const question of record.questions) {
		const parsed = toExtractedQuestion(question);
		if (!parsed) return null;
		questions.push(parsed);
	}
	return { questions };
}

/**
 * Model-readable transcript of the Q&A; the agent reads this as its next user turn.
 * Unanswered questions are omitted entirely to keep the next turn small.
 * Question numbers keep their extraction order, so gaps mean "skipped".
 */
export function formatAnswers(questions: ExtractedQuestion[], answers: string[], notes = ""): string {
	const parts: string[] = [];
	for (let i = 0; i < questions.length; i++) {
		const answer = answers[i]?.trim();
		if (!answer) continue;
		const q = questions[i];
		parts.push(`### Q${i + 1}: ${q.question}`);
		if (q.context) parts.push(`Context: ${q.context}`);
		parts.push(`Answer: ${answer}`);
		parts.push("");
	}
	if (notes.trim()) {
		parts.push("### Notes");
		parts.push(notes.trim());
	}
	return parts.join("\n").trim();
}

function parseExtractionResult(text: string): ExtractionResult | null {
	const candidates: string[] = [];
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) candidates.push(fenced[1].trim());

	const trimmed = text.trim();
	candidates.push(trimmed);

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
	}

	for (const candidate of candidates) {
		try {
			const result = toExtractionResult(parseJsonWithRepair<unknown>(candidate));
			if (result) return result;
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

class QnAComponent implements Component, Focusable {
	private questions: ExtractedQuestion[];
	private answers: string[];
	private notes = "";
	private currentIndex = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private messages: Messages;
	private showingConfirmation = false;
	private confirmingCancel = false;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private focusedState = false;

	/**
	 * TUI only sets `focused` on this wrapper, so forward it to the inner editor.
	 * Without it the editor emits no CURSOR_MARKER and the terminal puts the IME
	 * preedit (conversion candidates) wherever the hardware cursor happened to be,
	 * instead of at the answer text.
	 */
	get focused(): boolean {
		return this.focusedState;
	}

	set focused(value: boolean) {
		this.focusedState = value;
		this.editor.focused = value;
	}

	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	constructor(
		questions: ExtractedQuestion[],
		tui: TUI,
		onDone: (result: string | null) => void,
		messages: Messages,
	) {
		this.questions = questions;
		this.answers = questions.map(() => "");
		this.tui = tui;
		this.onDone = onDone;
		this.messages = messages;

		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedPrefix: this.cyan,
				selectedText: (s: string) => `\x1b[44m${s}\x1b[0m`,
				description: this.gray,
				scrollInfo: this.dim,
				noMatch: this.yellow,
			},
		};

		this.editor = new Editor(tui, editorTheme);
		// Handle Enter ourselves so the answer text is preserved on submit.
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	/** Last step is the free-form notes box. */
	private get stepCount(): number {
		return this.questions.length + 1;
	}

	private isNotesStep(): boolean {
		return this.currentIndex === this.questions.length;
	}

	private saveCurrentAnswer(): void {
		if (this.isNotesStep()) this.notes = this.editor.getText();
		else this.answers[this.currentIndex] = this.editor.getText();
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.stepCount) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.isNotesStep() ? this.notes : this.answers[index] || "");
		this.invalidate();
	}

	private submit(): void {
		this.saveCurrentAnswer();
		const payload = this.payload();
		this.onDone(payload ? `${this.messages.submittedPrefix}\n\n${payload}` : "");
	}

	/** Exactly the Q&A block that gets sent, without the prefix. */
	private payload(): string {
		return formatAnswers(this.questions, this.answers, this.notes);
	}

	private answeredCount(): number {
		return this.answers.filter((a) => (a?.trim() || "").length > 0).length;
	}

	/** Any answer at all, including text still in the editor. */
	private hasAnyInput(): boolean {
		if (this.editor.getText().trim().length > 0) return true;
		return this.answers.some((a) => (a || "").trim().length > 0) || this.notes.trim().length > 0;
	}

	/** Drop the question on screen. Answers and numbering shift down with it. */
	private excludeCurrent(): void {
		if (this.isNotesStep()) return;
		this.questions.splice(this.currentIndex, 1);
		this.answers.splice(this.currentIndex, 1);
		if (this.currentIndex >= this.questions.length) this.currentIndex = this.questions.length;
		this.editor.setText(this.isNotesStep() ? this.notes : this.answers[this.currentIndex] || "");
		this.invalidate();
	}

	/**
	 * Option keys work only while the answer is empty, so digits stay typeable
	 * and the chosen option can still be annotated by typing after it.
	 */
	private tryInsertOption(data: string): boolean {
		if (this.isNotesStep()) return false;
		const options = this.questions[this.currentIndex].options;
		if (!options || options.length === 0) return false;
		if (!/^[1-9]$/.test(data)) return false;
		if (this.editor.getText().length > 0) return false;
		const option = options[Number(data) - 1];
		if (option === undefined) return false;
		this.editor.insertTextAtCursor(option);
		this.saveCurrentAnswer();
		this.invalidate();
		this.tui.requestRender();
		return true;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.confirmingCancel) {
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "y") {
				this.onDone(null);
				return;
			}
			if (matchesKey(data, Key.escape) || data.toLowerCase() === "n") {
				this.confirmingCancel = false;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				// Review is the end of the flow, so return to the top rather than the last answer.
				this.navigateTo(0);
				this.tui.requestRender();
				return;
			}
			if (data.toLowerCase() === "l" || matchesKey(data, Key.shift("tab"))) {
				this.showingConfirmation = false;
				// Symmetric with Esc: jump to the last question, not the notes step.
				this.navigateTo(this.questions.length - 1);
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			// Esc throws away every answer, so ask once before doing it — unless there is nothing to lose.
			if (!this.hasAnyInput()) {
				this.onDone(null);
				return;
			}
			this.confirmingCancel = true;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.ctrl("x"))) {
			this.excludeCurrent();
			this.tui.requestRender();
			return;
		}

		if (this.tryInsertOption(data)) return;

		if (matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.stepCount - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}

		// Arrows navigate questions only when the editor is empty.
		if (matchesKey(data, Key.up) && this.editor.getText() === "" && this.currentIndex > 0) {
			this.navigateTo(this.currentIndex - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) && this.editor.getText() === "" && this.currentIndex < this.stepCount - 1) {
			this.navigateTo(this.currentIndex + 1);
			this.tui.requestRender();
			return;
		}

		// Plain Enter advances; Shift+Enter inserts a newline (handled by the editor).
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.stepCount - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				this.showingConfirmation = true;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120);
		const contentWidth = boxWidth - 4;
		const horizontalLine = (count: number) => "─".repeat(count);

		const boxLine = (content: string, leftPad = 2): string => {
			const padded = " ".repeat(leftPad) + content;
			const rightPad = Math.max(0, boxWidth - visibleWidth(padded) - 2);
			return this.dim("│") + padded + " ".repeat(rightPad) + this.dim("│");
		};
		const emptyBoxLine = () => this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		const padToWidth = (line: string) => line + " ".repeat(Math.max(0, width - visibleWidth(line)));

		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));
		const title = this.showingConfirmation
			? `${this.bold(this.cyan(this.messages.titleReview(this.answeredCount(), this.questions.length)))}`
			: this.isNotesStep()
				? `${this.bold(this.cyan(this.messages.titleFreeSpace(this.currentIndex + 1, this.stepCount)))}`
				: `${this.bold(this.cyan(this.messages.titleQuestions(this.currentIndex + 1, this.stepCount)))}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
		lines.push(padToWidth(emptyBoxLine()));

		const answerIndent = " ".repeat(visibleWidth(this.messages.answerLabel));

		if (this.showingConfirmation) {
			// Verbatim: the review shows the message that will be sent, unchanged.
			const payload = this.payload();
			const body = payload ? `${this.messages.submittedPrefix}\n\n${payload}` : this.dim(this.messages.nothingToSubmit);
			for (const line of body.split("\n")) {
				for (const wrapped of wrapTextWithAnsi(line, contentWidth)) lines.push(padToWidth(boxLine(wrapped)));
			}
			lines.push(padToWidth(emptyBoxLine()));
		} else {
			if (this.isNotesStep()) {
				const hint = this.dim(this.messages.freeSpaceHint);
				for (const line of wrapTextWithAnsi(hint, contentWidth)) lines.push(padToWidth(boxLine(line)));
			} else {
				const q = this.questions[this.currentIndex];
				for (const line of wrapTextWithAnsi(`${this.bold("Q:")} ${q.question}`, contentWidth)) {
					lines.push(padToWidth(boxLine(line)));
				}

				if (q.context) {
					lines.push(padToWidth(emptyBoxLine()));
					for (const line of wrapTextWithAnsi(this.gray(`> ${q.context}`), contentWidth - 2)) {
						lines.push(padToWidth(boxLine(line)));
					}
				}

				if (q.options && q.options.length > 0) {
					const current = this.editor.getText().trim();
					const rendered = q.options
						.map((option, j) => {
							const label = `${this.cyan(String(j + 1))}. ${option}`;
							return current === option ? this.green(label) : this.dim(label);
						})
						.join("   ");
					lines.push(padToWidth(emptyBoxLine()));
					for (const line of wrapTextWithAnsi(rendered, contentWidth)) lines.push(padToWidth(boxLine(line)));
				}
			}

			lines.push(padToWidth(emptyBoxLine()));

			// Skip the editor's own border lines. CURSOR_MARKER survives inside them.
			const editorLines = this.editor.render(contentWidth - 4 - 3);
			const notesPrefix = "✎: ";
			const firstPrefix = this.bold(this.isNotesStep() ? notesPrefix : this.messages.answerLabel);
			const continuation = this.isNotesStep() ? " ".repeat(visibleWidth(notesPrefix)) : answerIndent;
			for (let i = 1; i < editorLines.length - 1; i++) {
				const prefix = i === 1 ? firstPrefix : continuation;
				lines.push(padToWidth(boxLine(prefix + editorLines[i])));
			}

			lines.push(padToWidth(emptyBoxLine()));
		}

		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
		const footer = this.confirmingCancel
			? `${this.yellow(this.messages.discardPrompt)} ${this.dim(this.messages.discardKeys)}`
			: this.showingConfirmation
				? `${this.yellow(this.messages.submitPrompt)} ${this.dim(this.messages.submitKeys)}`
				: this.dim(this.messages.editingKeys);
		lines.push(padToWidth(boxLine(truncateToWidth(footer, contentWidth))));
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

async function answerHandler(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const config = readConfig(ctx);
	const messages = MESSAGES[resolveLanguage(config)];
	if (ctx.mode !== "tui") {
		ctx.ui.notify(messages.requiresTui, "error");
		return;
	}
	const sessionModel = ctx.model;
	if (!sessionModel) {
		ctx.ui.notify(messages.noModel, "error");
		return;
	}

	const branch = ctx.sessionManager.getBranch();
	let lastAssistantText: string | undefined;

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!("role" in msg) || msg.role !== "assistant") continue;
		if (msg.stopReason !== "stop") {
			ctx.ui.notify(messages.incomplete(msg.stopReason), "error");
			return;
		}
		const textParts = msg.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text);
		if (textParts.length > 0) {
			lastAssistantText = textParts.join("\n");
			break;
		}
	}

	if (!lastAssistantText) {
		ctx.ui.notify(messages.noAssistantMessages, "error");
		return;
	}

	// Use the configured extraction model, else the session's current model.
	const extractionModel = resolveModel(ctx, config, messages, sessionModel);

	const extractionOutcome = await ctx.ui.custom<ExtractionOutcome>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, messages.extracting(extractionModel.id));
		loader.onAbort = () => done({ status: "cancelled" });

		const doExtract = async (): Promise<ExtractionOutcome> => {
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: lastAssistantText! }],
				timestamp: Date.now(),
			};
			const sessionId = ctx.sessionManager.getSessionId();

			const response = await ctx.modelRegistry.complete(
				extractionModel,
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
				{
					signal: loader.signal,
					sessionId,
					transformHeaders: (headers: Record<string, string>) => ({
						...headers,
						...opencodeSessionHeaders(extractionModel, sessionId),
					}),
				},
			);

			if (response.stopReason === "aborted") return { status: "cancelled" };
			if (response.stopReason === "error") {
				return { status: "error", message: response.errorMessage ?? messages.extractionFailedGeneric };
			}

			const responseText = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const result = parseExtractionResult(responseText);
			if (!result) return { status: "error", message: messages.extractionInvalidJson };
			return { status: "ok", result };
		};

		doExtract()
			.then(done)
			.catch((error: unknown) => {
				done({ status: "error", message: error instanceof Error ? error.message : String(error) });
			});

		return loader;
	});

	if (extractionOutcome.status === "cancelled") {
		ctx.ui.notify(messages.cancelled, "info");
		return;
	}
	if (extractionOutcome.status === "error") {
		ctx.ui.notify(messages.extractionFailed(extractionOutcome.message), "error");
		return;
	}

	const { questions } = extractionOutcome.result;
	if (questions.length === 0) {
		ctx.ui.notify(messages.noQuestions, "info");
		return;
	}

	const answersResult = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
		return new QnAComponent(questions, tui, done, messages);
	});

	if (answersResult === null) {
		ctx.ui.notify(messages.cancelled, "info");
		return;
	}
	if (!answersResult) {
		ctx.ui.notify(messages.noAnswersToSubmit, "info");
		return;
	}

	pi.sendMessage(
		{
			customType: "answers",
			content: answersResult,
			display: true,
		},
		{ triggerTurn: true },
	);
}

export default function (pi: ExtensionAPI) {
	const handler = (ctx: ExtensionContext) => answerHandler(pi, ctx);

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => handler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler,
	});
}
