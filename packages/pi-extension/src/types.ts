import type {
	BaseAgentMessage,
	BaseExtensionContext,
	BaseReadonlySessionManager,
	BaseSessionEntry,
	BaseSessionHeader,
} from "@signet/extension-base";

export const DAEMON_URL_DEFAULT = "http://127.0.0.1:3850";
export const HARNESS = "pi" as const;
export const RUNTIME_PATH = "plugin" as const;

export const READ_TIMEOUT = 5_000;
export const WRITE_TIMEOUT = 10_000;
export const PROMPT_SUBMIT_TIMEOUT = READ_TIMEOUT;

export const HIDDEN_RECALL_CUSTOM_TYPE = "signet-pi-hidden-recall";
export const HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE = "signet-pi-session-context";

export interface PreCompactionResult {
	readonly guidelines?: string;
	readonly summaryPrompt?: string;
}

// The upstream pi package's main entry point (@mariozechner/pi-coding-agent) does not
// export the handler result types (ContextEventResult, BeforeAgentStartEventResult,
// SessionBeforeCompactResult) needed to type the overloaded `on()` signatures. They
// exist in an internal dist path with no public sub-path export. Local shims here model
// only the runtime surface this extension actually consumes so `tsc --noEmit` still
// verifies our integration end-to-end.
export type PiAgentMessage = BaseAgentMessage;
export type PiSessionEntry = BaseSessionEntry;
export type PiSessionHeader = BaseSessionHeader;
export type ReadonlySessionManager = BaseReadonlySessionManager;

export interface PiInputEvent {
	readonly text: string;
}

export interface PiBeforeAgentStartEvent {
	readonly prompt: string;
	readonly systemPrompt: string;
}

export interface PiBeforeAgentStartResult {
	readonly systemPrompt?: string;
}

export interface PiContextEvent {
	readonly messages: ReadonlyArray<PiAgentMessage>;
}

export interface PiContextEventResult {
	readonly messages?: ReadonlyArray<PiAgentMessage>;
}

export interface PiSessionBeforeCompactEvent {
	readonly type: "session_before_compact";
	readonly preparation?: {
		readonly messagesToSummarize?: ReadonlyArray<unknown>;
		readonly tokensBefore?: number;
		readonly firstKeptEntryId?: string;
	};
}

export interface PiSessionCompactEvent {
	readonly compactionEntry?: {
		readonly summary?: string;
	};
}

export interface PiSessionSwitchEvent {
	readonly type: string;
	readonly previousSessionFile?: string;
}

// UI and notification types
export interface PiTheme {
	fg(color: string, text: string): string;
}

export interface PiUI {
	readonly theme: PiTheme;
	notify(message: string, type?: "info" | "success" | "warning" | "error"): void;
	setStatus(key: string, value: string | undefined): void;
}

export interface PiExtensionContext {
	readonly cwd?: string;
	readonly sessionManager: ReadonlySessionManager;
	readonly ui: PiUI;
}

// Command types
export interface PiCommandHandler {
	readonly description: string;
	readonly handler: (args: string, ctx: PiExtensionContext) => Promise<void>;
}

// Tool types
export interface ToolExecuteResult {
	readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
	readonly details?: Record<string, unknown>;
	readonly isError?: boolean;
}

export interface PiToolDefinition {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly promptSnippet?: string;
	readonly promptGuidelines?: readonly string[];
	readonly parameters: unknown;
	readonly execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: (update: unknown) => void,
		ctx: PiExtensionContext,
	) => Promise<ToolExecuteResult>;
}

// Flag types
export interface PiFlagDefinition {
	readonly description: string;
	readonly type: "boolean" | "string" | "number";
	readonly default?: unknown;
}

export interface PiExtensionApi {
	readonly ui: PiUI;
	on(event: "session_start", handler: (event: unknown, ctx: PiExtensionContext) => unknown): void;
	on(event: "session_switch", handler: (event: PiSessionSwitchEvent, ctx: PiExtensionContext) => unknown): void;
	on(event: "session_fork", handler: (event: PiSessionSwitchEvent, ctx: PiExtensionContext) => unknown): void;
	on(event: "session_shutdown", handler: (event: unknown, ctx: PiExtensionContext) => unknown): void;
	on(event: "input", handler: (event: PiInputEvent, ctx: PiExtensionContext) => unknown): void;
	on(
		event: "before_agent_start",
		handler: (
			event: PiBeforeAgentStartEvent,
			ctx: PiExtensionContext,
		) => PiBeforeAgentStartResult | Promise<PiBeforeAgentStartResult | undefined> | undefined,
	): void;
	on(
		event: "context",
		handler: (
			event: PiContextEvent,
			ctx: PiExtensionContext,
		) => PiContextEventResult | Promise<PiContextEventResult | undefined> | undefined,
	): void;
	on(
		event: "session_before_compact",
		handler: (
			event: PiSessionBeforeCompactEvent,
			ctx: PiExtensionContext,
		) => undefined | Promise<undefined>,
	): void;
	on(event: "session_compact", handler: (event: PiSessionCompactEvent, ctx: PiExtensionContext) => unknown): void;
	registerCommand(name: string, definition: PiCommandHandler): void;
	registerTool(definition: PiToolDefinition): void;
	registerFlag(name: string, definition: PiFlagDefinition): void;
	getFlag(name: string): unknown;
}

export type PiExtensionFactory = (pi: PiExtensionApi) => void;
