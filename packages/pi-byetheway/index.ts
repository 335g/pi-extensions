/**
 * pi-byetheway: a side conversation space (/btw) that reads the session context
 * and never writes to it.
 *
 * The exchange happens in memory only: nothing is appended to the session file,
 * and nothing enters the main agent's context. `ctrl+n` reformats any part of the
 * exchange into one message and hands that message to the main session.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	ProviderHeaders,
} from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRegistry,
	type Theme,
	convertToLlm,
	getMarkdownTheme,
	getSelectListTheme,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	Markdown,
	type TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { assistantTurn, hasAnswer, sanitize, transcriptOf, userTurn, type Turn } from "./messages.ts";

/**
 * The panel shares the screen with the session transcript it sits on top of: it
 * takes this much of the terminal, so the conversation above stays readable.
 */
const PANEL_HEIGHT_RATIO = 0.6;

// ---------------------------------------------------------------- session context

/**
 * The messages the main agent would have sent, minus tools: this request carries
 * no tool definitions, so `sanitize` flattens tool calls and results to text.
 */
function contextMessages(ctx: ExtensionContext): Message[] {
	return sanitize(convertToLlm(ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages)));
}

// ---------------------------------------------------------------- model call

type AskOutcome = { status: "ok"; text: string } | { status: "error"; message: string } | { status: "aborted" };

type StreamFunction = (
	model: Model<Api>,
	context: Context,
	options: Record<string, unknown>,
) => AsyncIterable<AssistantMessageEvent>;

/**
 * `ModelRegistry` only exposes `complete()`, but it wraps the runtime that owns
 * `stream()`. Read it off the facade; fall back to `complete()` when absent.
 *
 * `ModelRuntime.stream` calls `this.prepareRequest`, so the receiver must be kept.
 */
export function runtimeStream(registry: unknown): StreamFunction | undefined {
	const runtime = (registry as { runtime?: { stream?: StreamFunction } }).runtime;
	if (!runtime || typeof runtime.stream !== "function") return undefined;
	return (model, context, options) => runtime.stream!(model, context, options);
}

function isOpencodeHost(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname === "opencode.ai";
	} catch {
		return false;
	}
}

/** Pi's own requests carry these headers for opencode models; the registry bypasses that wrapper. */
function opencodeSessionHeaders(model: Model<Api>, sessionId: string): ProviderHeaders {
	const isOpencode =
		model.provider === "opencode" || model.provider === "opencode-go" || isOpencodeHost(model.baseUrl);
	return isOpencode ? { "x-opencode-session": sessionId, "x-opencode-client": "pi" } : {};
}

function responseText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

async function ask(
	host: Host,
	messages: Message[],
	signal: AbortSignal,
	onDelta: (delta: string) => void,
): Promise<AskOutcome> {
	const context: Context = { systemPrompt: host.systemPrompt, messages };
	const options = {
		signal,
		sessionId: host.sessionId,
		transformHeaders: (headers: ProviderHeaders) => ({ ...headers, ...opencodeSessionHeaders(host.model, host.sessionId) }),
	};

	const stream = runtimeStream(host.registry);
	if (!stream) {
		try {
			const response = await host.registry.complete(host.model, context, options);
			if (response.stopReason === "aborted") return { status: "aborted" };
			if (response.stopReason === "error") return { status: "error", message: response.errorMessage ?? "error" };
			const text = responseText(response);
			onDelta(text);
			return { status: "ok", text };
		} catch (error) {
			return { status: "error", message: describe(error) };
		}
	}

	let text = "";
	let final: AssistantMessage | undefined;
	try {
		for await (const event of stream(host.model, context, options)) {
			if (event.type === "text_delta") {
				text += event.delta;
				onDelta(event.delta);
			} else if (event.type === "done") {
				final = event.message;
			} else if (event.type === "error") {
				if (event.reason === "aborted") return { status: "aborted" };
				return { status: "error", message: event.error.errorMessage ?? "error" };
			}
		}
	} catch (error) {
		if (signal.aborted) return { status: "aborted" };
		return { status: "error", message: describe(error) };
	}
	return { status: "ok", text: final ? responseText(final) || text : text };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------- strings

interface Strings {
	title: string;
	context(count: number, model: string): string;
	above(lines: number): string;
	chatKeys: string;
	promoteKeys: string;
	previewKeys: string;
	closeConfirm: string;
	closeKeys: string;
	thinking: string;
	promoteHint: string;
	presets: string[];
	noTurns: string;
	aborted: string;
	emptyAnswer: string;
	noModel: string;
	requiresTui: string;
	peeked: string;
	sent: string;
	defaultInstruction: string;
	systemSuffix: string;
	formatPrompt(transcript: string, instruction: string): string;
}

const JA: Strings = {
	title: "btw",
	context: (count, model) => `文脈 ${count} 件 · ${model}`,
	above: (lines) => `↑ ${lines} 行`,
	chatKeys: "Enter 送信 · Shift+Enter 改行 · Esc 退避 · ctrl+n 本体へ送る · ctrl+d 終了",
	promoteKeys: "Enter 整形 · Esc 戻る",
	previewKeys: "Enter 送信 · Esc 戻る · ctrl+r 整形し直す · 本文は編集できます",
	closeConfirm: "この検討を破棄して閉じますか？",
	closeKeys: "Enter/y 破棄 · Esc/n 続ける",
	thinking: "考えています…",
	promoteHint: "観点を選ぶか入力（空なら既定の観点）",
	presets: ["結論と根拠", "決定と理由", "未解決の問い", "却下した案"],
	noTurns: "まだやりとりがありません",
	aborted: "中断しました",
	emptyAnswer: "回答が空でした。ツールを使おうとした可能性があります",
	noModel: "モデルが選択されていません",
	requiresTui: "btw は対話モードでのみ使えます",
	peeked: "btw を退避しました。/btw で再開します",
	sent: "本体セッションへ送信しました",
	defaultInstruction: "結論と根拠、未解決点",
	systemSuffix: `# btw モード
あなたは本体セッションの記録を読める補助の対話相手であり、実行主体ではない。
- ツールは使えない。ファイルを読む、コマンドを実行する、変更を加えることはできない
- 渡される記録は文脈であり、あなたが実行したことではない
- 「実行します」「確認します」と宣言せず、記録だけで答えられないことは答えられないと短く述べる
- ツール呼び出しの形式（[bash] のような行）だけを返さない。必ず文章で答える
- 相手が使っている言語で答える`,
	formatPrompt: (transcript, instruction) => `以下は、ある開発セッションの途中で、ユーザと別のAIが交わした検討です。

<検討>
${transcript}
</検討>

上記を、本体セッションのエージェントに渡す1つのメッセージに再構成してください。会話の再現ではなく、ユーザ自身のまとめとして読ませるのが目的です。

観点: ${instruction}

規則:
- 出力は送信される本文だけ。前置き・見出し・コードフェンス・「以下が〜」などの導入・感想は書かない
- 一人称で書く。読み手は「ユーザがこう判断した」として読む
- 別のAIの提案や反論は帰属を残す（「別案として〜」「〜という指摘もあった」）
- 結論・根拠・未解決点を短く。冗長な前置きは削る`,
};

const EN: Strings = {
	title: "btw",
	context: (count, model) => `${count} context messages · ${model}`,
	above: (lines) => `↑ ${lines} lines`,
	chatKeys: "Enter send · Shift+Enter newline · Esc stash · ctrl+n send to session · ctrl+d close",
	promoteKeys: "Enter format · Esc back",
	previewKeys: "Enter send · Esc back · ctrl+r reformat · the body is editable",
	closeConfirm: "Discard this side conversation?",
	closeKeys: "Enter/y discard · Esc/n keep",
	thinking: "Thinking...",
	promoteHint: "Pick a focus or type one (empty = the default focus)",
	presets: ["Conclusion and evidence", "Decision and reason", "Open questions", "Rejected options"],
	noTurns: "Nothing to send yet",
	aborted: "Interrupted",
	emptyAnswer: "The answer was empty; the model likely tried to call a tool",
	noModel: "No model selected",
	requiresTui: "btw is only available in interactive mode",
	peeked: "btw stashed. /btw resumes it",
	sent: "Sent to the session",
	defaultInstruction: "the conclusion, the evidence, and what is still open",
	systemSuffix: `# btw mode
You are a side conversation partner that can read the main session's record. You are not the one acting.
- You have no tools. You cannot read files, run commands, or change anything
- The record below is context, not something you did
- Never announce "I will run/check ..."; if the record alone cannot answer, say so briefly
- Never answer with a tool-call form alone (such as a line containing only [bash]); always answer in prose
- Answer in the language the user is writing`,
	formatPrompt: (transcript, instruction) => `Below is a short exchange between the user and a separate AI, held in the middle of a development session.

<exchange>
${transcript}
</exchange>

Rewrite it as a single message to hand to the agent of the main session. The goal is a summary the user appears to have written, not a transcript.

Focus: ${instruction}

Rules:
- Output only the message body. No preamble, heading, code fence, "here is a summary", or commentary
- Write in the first person; the reader treats it as the user's own judgement
- Keep attribution for the other AI's proposals and objections ("an alternative was ...", "it was pointed out that ...")
- Be short: conclusion, evidence, open questions`,
};

function strings(): Strings {
	const locale = process.env.LC_ALL ?? process.env.LANG ?? "";
	return /^ja/i.test(locale) ? JA : EN;
}

// ---------------------------------------------------------------- component

type Mode = "chat" | "promote" | "preview";
type Phase = "idle" | "asking" | "formatting";

type Exit = { action: "peek" } | { action: "close" } | { action: "send"; text: string };

interface Host {
	systemPrompt: string;
	model: Model<Api>;
	registry: ModelRegistry;
	sessionId: string;
	context: Message[];
	contextCount: number;
}

class BtwComponent implements Component, Focusable {
	private tui!: TUI;
	private theme!: Theme;
	private done!: (result: Exit) => void;
	private lastEditorHeight = 3;
	private chatEditor?: Editor;
	private instructionEditor?: Editor;
	private previewEditor?: Editor;

	private turns: Turn[] = [];
	private draft = "";
	private answer = "";
	private promoted = "";
	private instruction = "";
	private lastInstruction = "";
	private mode: Mode = "chat";
	private phase: Phase = "idle";
	private error?: string;
	private status?: string;
	private scroll = 0;
	private confirmingClose = false;
	private abort?: AbortController;
	private focusedState = false;
	private completedCache?: { width: number; count: number; lines: string[] };

	private host: Host;
	private t: Strings;

	constructor(host: Host, t: Strings) {
		this.host = host;
		this.t = t;
	}

	// Focus must reach the inner editor: without it the editor emits no
	// CURSOR_MARKER and the terminal puts the IME preedit outside the box.
	get focused(): boolean {
		return this.focusedState;
	}

	set focused(value: boolean) {
		this.focusedState = value;
		this.applyFocus();
	}

	private applyFocus(): void {
		if (this.chatEditor) this.chatEditor.focused = this.focusedState && this.mode === "chat";
		if (this.instructionEditor) this.instructionEditor.focused = this.focusedState && this.mode === "promote";
		if (this.previewEditor) this.previewEditor.focused = this.focusedState && this.mode === "preview";
	}

	/** Re-entering after a stash: the state lives on, only the tui/theme/done triple is new. */
	attach(tui: TUI, theme: Theme, done: (result: Exit) => void): void {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		if (!this.chatEditor) {
			const editorTheme: EditorTheme = {
				borderColor: (text) => this.theme.fg("borderMuted", text),
				selectList: getSelectListTheme(),
			};
			this.chatEditor = this.makeEditor(editorTheme, () => (this.draft = this.chatEditor!.getText()));
			this.instructionEditor = this.makeEditor(editorTheme, () => (this.instruction = this.instructionEditor!.getText()));
			this.previewEditor = this.makeEditor(editorTheme, () => (this.promoted = this.previewEditor!.getText()));
			this.chatEditor.setText(this.draft);
			this.instructionEditor.setText(this.instruction);
			this.previewEditor.setText(this.promoted);
		}
		this.applyFocus();
	}

	private makeEditor(editorTheme: EditorTheme, onChange: () => void): Editor {
		const editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
		editor.disableSubmit = true;
		editor.onChange = () => {
			onChange();
			this.tui.requestRender();
		};
		return editor;
	}

	private activeEditor(): Editor {
		if (this.mode === "promote") return this.instructionEditor!;
		if (this.mode === "preview") return this.previewEditor!;
		return this.chatEditor!;
	}

	private isBusy(): boolean {
		return this.phase !== "idle";
	}

	invalidate(): void {
		this.completedCache = undefined;
	}

	// ------------------------------------------------------------ actions

	private requestRender(): void {
		this.tui.requestRender();
	}

	private send(): void {
		const question = this.chatEditor!.getText().trim();
		if (!question) return;
		this.draft = "";
		this.chatEditor!.setText("");
		this.error = undefined;
		this.status = undefined;
		void this.run(question);
	}

	private async run(question: string): Promise<void> {
		this.answer = "";
		this.phase = "asking";
		this.scroll = 0;

		const abort = new AbortController();
		this.abort = abort;
		const history: Message[] = this.turns.flatMap((turn) => [userTurn(turn.question), assistantTurn(turn.answer)]);
		const result = await ask(this.host, [...this.host.context, ...history, userTurn(question)], abort.signal, (delta) => {
			this.answer += delta;
			this.requestRender();
		});

		this.abort = undefined;
		this.phase = "idle";
		this.invalidate();
		if (result.status === "ok" && hasAnswer(result.text)) {
			this.turns.push({ question, answer: result.text });
			this.answer = "";
		} else {
			// Keep the question: the user asked it once and should not have to retype it.
			this.answer = "";
			this.draft = question;
			this.chatEditor!.setText(question);
			this.error =
				result.status === "ok" ? this.t.emptyAnswer : result.status === "aborted" ? this.t.aborted : result.message;
		}
		this.requestRender();
	}

	private startPromote(): void {
		if (this.turns.length === 0) {
			this.status = this.t.noTurns;
			this.requestRender();
			return;
		}
		this.mode = "promote";
		this.error = undefined;
		this.status = undefined;
		this.instruction = "";
		this.scroll = 0;
		this.instructionEditor!.setText("");
		this.applyFocus();
		this.requestRender();
	}

	private async format(instruction: string): Promise<void> {
		this.lastInstruction = instruction;
		this.mode = "promote";
		this.phase = "formatting";
		this.promoted = "";
		this.error = undefined;
		this.scroll = 0;
		this.applyFocus();
		this.requestRender();

		const abort = new AbortController();
		this.abort = abort;
		const prompt = this.t.formatPrompt(transcriptOf(this.turns), instruction);
		const result = await ask(this.host, [userTurn(prompt)], abort.signal, (delta) => {
			this.promoted += delta;
			this.requestRender();
		});

		this.abort = undefined;
		this.phase = "idle";
		if (result.status === "ok" && hasAnswer(result.text)) {
			this.promoted = result.text;
			this.mode = "preview";
			this.previewEditor!.setText(result.text);
		} else {
			this.error =
				result.status === "ok" ? this.t.emptyAnswer : result.status === "aborted" ? this.t.aborted : result.message;
		}
		this.applyFocus();
		this.requestRender();
	}

	private close(): void {
		this.abort?.abort();
		this.abort = undefined;
		this.done({ action: "close" });
	}

	// ------------------------------------------------------------ input

	handleInput(data: string): void {
		if (this.confirmingClose) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.close();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.confirmingClose = false;
				this.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			// Esc leaves the promote flow; in the chat it only stashes the space.
			if (this.mode !== "chat") {
				this.mode = "chat";
				this.phase = "idle";
				this.abort?.abort();
				this.abort = undefined;
				this.applyFocus();
				this.requestRender();
				return;
			}
			this.done({ action: "peek" });
			return;
		}

		if (matchesKey(data, Key.ctrl("d"))) {
			const touched = this.turns.length > 0 || this.answer.length > 0 || this.chatEditor!.getText().trim().length > 0;
			if (!touched) {
				this.close();
				return;
			}
			this.confirmingClose = true;
			this.requestRender();
			return;
		}

		// ctrl+p would collide with pi's model cycling in the main editor; ctrl+n is
		// unbound there, so a stray press has no effect.
		if (matchesKey(data, Key.ctrl("n"))) {
			if (this.mode === "chat" && !this.isBusy()) this.startPromote();
			return;
		}

		if (this.mode === "preview" && matchesKey(data, Key.ctrl("r"))) {
			if (!this.isBusy()) void this.format(this.lastInstruction);
			return;
		}

		if (this.scrollHistory(data)) return;

		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			if (this.isBusy()) return;
			if (this.mode === "chat") this.send();
			else if (this.mode === "promote") {
				const instruction = this.instructionEditor!.getText().trim() || this.t.defaultInstruction;
				void this.format(instruction);
			} else {
				const text = this.previewEditor!.getText().trim();
				if (text) this.done({ action: "send", text });
			}
			return;
		}

		if (this.mode === "promote" && this.tryPreset(data)) return;

		this.activeEditor().handleInput(data);
		this.requestRender();
	}

	/** Page keys and, with an empty input, arrows, scroll the history. */
	private scrollHistory(data: string): boolean {
		const page = Math.max(3, this.bodyHeight() - 2);
		if (matchesKey(data, Key.pageUp)) return this.scrollBy(page);
		if (matchesKey(data, Key.pageDown)) return this.scrollBy(-page);
		if (matchesKey(data, Key.ctrl("u"))) return this.scrollBy(5);
		if (this.mode === "chat" && this.chatEditor!.getText() === "") {
			if (matchesKey(data, Key.up)) return this.scrollBy(1);
			if (matchesKey(data, Key.down)) return this.scrollBy(-1);
		}
		return false;
	}

	private scrollBy(lines: number): boolean {
		const max = Math.max(0, this.historyLines(this.contentWidth()).length - this.bodyHeight());
		const next = Math.min(max, Math.max(0, this.scroll + lines));
		if (next === this.scroll) return false;
		this.scroll = next;
		this.requestRender();
		return true;
	}

	/** Digits pick a focus; `5` short circuits to the raw transcript. */
	private tryPreset(data: string): boolean {
		if (!/^[1-5]$/.test(data)) return false;
		if (this.isBusy()) return false;
		if (this.instructionEditor!.getText().length > 0) return false;
		if (data === "5") {
			this.promoted = transcriptOf(this.turns);
			this.mode = "preview";
			this.scroll = 0;
			this.previewEditor!.setText(this.promoted);
			this.applyFocus();
			this.requestRender();
			return true;
		}
		this.instructionEditor!.insertTextAtCursor(this.t.presets[Number(data) - 1]);
		this.instruction = this.instructionEditor!.getText();
		this.requestRender();
		return true;
	}

	// ------------------------------------------------------------ render

	private contentWidth(): number {
		return Math.max(24, this.tui.terminal.columns - 6);
	}

	private bodyHeight(): number {
		const hints = this.mode === "promote" ? 2 : 0;
		// Chrome around the body: two rules, the header, and the footer.
		return Math.max(3, this.height() - this.lastEditorHeight - hints - 4);
	}

	private height(): number {
		return Math.max(12, Math.floor(this.tui.terminal.rows * PANEL_HEIGHT_RATIO));
	}

	private completedLines(width: number): string[] {
		const cache = this.completedCache;
		if (cache && cache.width === width && cache.count === this.turns.length) return cache.lines;
		const lines: string[] = [];
		for (const turn of this.turns) {
			if (lines.length > 0) lines.push("");
			lines.push(...this.questionLines(width, turn.question));
			lines.push(...this.markdownLines(turn.answer, width));
		}
		this.completedCache = { width, count: this.turns.length, lines };
		return lines;
	}

	private historyLines(width: number): string[] {
		const lines = [...this.completedLines(width)];
		if (this.answer) {
			lines.push(...this.markdownLines(this.answer, width));
		} else if (this.phase === "asking") {
			lines.push(this.theme.fg("dim", this.t.thinking));
		}
		if (this.mode !== "chat" && this.phase === "formatting" && this.promoted) {
			lines.push("", ...this.markdownLines(this.promoted, width));
		}
		return lines;
	}

	private questionLines(width: number, question: string): string[] {
		return wrapTextWithAnsi(this.theme.bold(this.theme.fg("accent", `> ${question}`)), width);
	}

	private markdownLines(text: string, width: number): string[] {
		return new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
	}

	render(width: number): string[] {
		const editorLines = this.activeEditor().render(width);
		this.lastEditorHeight = editorLines.length;
		const bodyHeight = this.bodyHeight();
		const history = this.historyLines(this.contentWidth());

		// A failure has to be impossible to miss: the reply never arrives, so the
		// body is the only place the user is looking.
		const notice = this.error
			? this.theme.fg("error", this.error)
			: this.status
				? this.theme.fg("success", this.status)
				: undefined;
		const noticeLines = notice ? wrapTextWithAnsi(notice, this.contentWidth()) : [];
		const historyHeight = Math.max(1, bodyHeight - noticeLines.length);

		const maxScroll = Math.max(0, history.length - historyHeight);
		if (this.scroll > maxScroll) this.scroll = maxScroll;
		const start = Math.max(0, history.length - historyHeight - this.scroll);

		const lines: string[] = [this.rule(width), this.headerLine(width, start), this.rule(width)];
		const visible = history.slice(start, start + historyHeight);
		for (const line of visible) lines.push(this.pad(`  ${line}`, width));
		for (let i = visible.length; i < historyHeight; i++) lines.push(" ".repeat(width));
		for (const line of noticeLines) lines.push(this.pad(`  ${line}`, width));

		if (this.mode === "promote") {
			const presetWidth = Math.max(10, Math.floor(width / this.t.presets.length) - 6);
			const presets = this.t.presets
				.map((preset, index) => this.theme.fg("dim", `${index + 1}. `) + truncateToWidth(preset, presetWidth, ""))
				.join("   ");
			lines.push(this.pad(`  ${this.theme.fg("muted", truncateToWidth(presets, width - 4))}`, width));
			lines.push(
				this.pad(
					`  ${this.theme.fg("dim", truncateToWidth(`${this.t.promoteHint}  5. ${transcriptLabel(this.t)}`, width - 4))}`,
					width,
				),
			);
		}

		for (const line of editorLines) lines.push(this.pad(line, width));
		lines.push(this.footerLine(width));
		return lines;
	}

	private rule(width: number): string {
		return this.theme.fg("borderMuted", "─".repeat(width));
	}

	private headerLine(width: number, start: number): string {
		const separator = this.theme.fg("dim", " · ");
		const parts = [this.theme.bold(this.theme.fg("accent", this.t.title)), this.theme.fg("dim", this.t.context(this.host.contextCount, this.host.model.id))];
		if (start > 0) parts.push(this.theme.fg("warning", this.t.above(start)));
		return truncateToWidth(parts.join(separator), width);
	}

	private footerLine(width: number): string {
		if (this.confirmingClose) {
			return truncateToWidth(`${this.theme.fg("error", this.t.closeConfirm)}  ${this.theme.fg("dim", this.t.closeKeys)}`, width);
		}
		const keys = this.mode === "chat" ? this.t.chatKeys : this.mode === "promote" ? this.t.promoteKeys : this.t.previewKeys;
		return truncateToWidth(this.theme.fg("dim", keys), width);
	}

	private pad(line: string, width: number): string {
		return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	}
}

function transcriptLabel(t: Strings): string {
	return t === JA ? "全文をそのまま" : "Raw transcript";
}

// ---------------------------------------------------------------- command

/** Kept across `ctx.ui.custom` calls so Esc can stash the space and resume it. */
let pending: BtwComponent | undefined;

async function openBtw(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const t = strings();
	if (ctx.mode !== "tui") {
		ctx.ui.notify(t.requiresTui, "error");
		return;
	}
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify(t.noModel, "error");
		return;
	}

	let component: BtwComponent;
	if (pending) {
		component = pending;
	} else {
		const context = contextMessages(ctx);
		component = new BtwComponent(
			{
				systemPrompt: `${ctx.getSystemPrompt()}\n\n${t.systemSuffix}`,
				model,
				registry: ctx.modelRegistry,
				sessionId: ctx.sessionManager.getSessionId(),
				context,
				contextCount: context.length,
			},
			t,
		);
	}

	const result = await ctx.ui.custom<Exit>((tui, theme, _keybindings, done) => {
		// The factory runs again on every entry, so the panel picks up the current theme.
		component.attach(tui, theme, done);
		return component;
	});

	if (result.action === "send") {
		pending = undefined;
		pi.sendUserMessage(result.text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		ctx.ui.notify(t.sent, "info");
		return;
	}
	if (result.action === "peek") {
		pending = component;
		ctx.ui.notify(t.peeked, "info");
		return;
	}
	pending = undefined;
}

export default function (pi: ExtensionAPI) {
	// A stash belongs to one session; drop it when the session is replaced.
	pi.on("session_start", () => {
		pending = undefined;
	});

	pi.registerCommand("btw", {
		description: "Side conversation space that reads the session without writing to it",
		handler: (_args, ctx) => openBtw(pi, ctx),
	});
}
