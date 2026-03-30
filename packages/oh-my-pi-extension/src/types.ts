export const DAEMON_URL_DEFAULT = "http://localhost:3850";
export const HARNESS = "oh-my-pi" as const;
export const RUNTIME_PATH = "plugin" as const;

export const READ_TIMEOUT = 5_000;
export const WRITE_TIMEOUT = 10_000;
export const PROMPT_SUBMIT_TIMEOUT = READ_TIMEOUT;
export const SESSION_START_TIMEOUT_ENV = "SIGNET_SESSION_START_TIMEOUT";
export const FETCH_TIMEOUT_ENV = "SIGNET_FETCH_TIMEOUT";

export const HIDDEN_RECALL_CUSTOM_TYPE = "signet-oh-my-pi-hidden-recall";
export const HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE = "signet-oh-my-pi-session-context";

export interface SessionStartResult {
	readonly inject?: string;
	readonly recentContext?: string;
}

export interface UserPromptSubmitResult {
	readonly inject?: string;
	readonly memoryCount?: number;
	readonly sessionKnown?: boolean;
}

export interface PreCompactionResult {
	readonly guidelines?: string;
	readonly summaryPrompt?: string;
}

// The upstream Oh My Pi package does not currently type-check cleanly as a
// dependency in this monorepo. Model only the runtime surface this extension
// actually consumes so `tsc --noEmit` still verifies our integration.
export type OmpMessageAttribution = "user" | "agent";

export interface OmpAgentMessage extends Record<string, unknown> {
	readonly role?: string;
	readonly customType?: string;
	readonly display?: boolean;
	readonly content?: unknown;
	readonly attribution?: OmpMessageAttribution;
	readonly timestamp?: number;
}

export interface OmpSessionEntry extends Record<string, unknown> {
	readonly type?: string;
	readonly customType?: string;
	readonly content?: unknown;
	readonly message?: {
		readonly role?: string;
		readonly content?: unknown;
		readonly parts?: unknown;
	};
}

export interface OmpSessionHeader extends Record<string, unknown> {
	readonly id?: unknown;
	readonly cwd?: unknown;
	readonly project?: unknown;
	readonly workspace?: unknown;
}

export interface ReadonlySessionManager {
	getBranch(): ReadonlyArray<OmpSessionEntry> | undefined;
	getEntries(): ReadonlyArray<OmpSessionEntry> | undefined;
	getHeader(): OmpSessionHeader | undefined;
	getSessionFile(): string | undefined;
	getSessionId(): string | undefined;
}

export interface OmpExtensionContext {
	readonly cwd?: string;
	readonly sessionManager: ReadonlySessionManager;
}

export interface OmpInputEvent {
	readonly text: string;
}

export interface OmpBeforeAgentStartEvent {
	readonly prompt: string;
}

export interface OmpBeforeAgentStartResult {
	readonly message?: OmpAgentMessage;
}

export interface OmpContextEvent {
	readonly messages: ReadonlyArray<OmpAgentMessage>;
}

export interface OmpContextEventResult {
	readonly messages?: ReadonlyArray<OmpAgentMessage>;
}

export interface OmpSessionCompactingEvent {
	readonly sessionId?: string;
	readonly messages?: ReadonlyArray<unknown>;
}

export interface OmpSessionCompactingResult {
	readonly context?: ReadonlyArray<string>;
	readonly prompt?: string;
}

export interface OmpSessionCompactEvent {
	readonly compactionEntry?: {
		readonly summary?: string;
	};
}

export interface OmpSessionSwitchEvent {
	readonly type: string;
	readonly previousSessionFile?: string;
}

export interface OmpExtensionApi {
	on(event: "session_start", handler: (event: unknown, ctx: OmpExtensionContext) => unknown): void;
	on(event: "session_switch", handler: (event: OmpSessionSwitchEvent, ctx: OmpExtensionContext) => unknown): void;
	on(event: "session_branch", handler: (event: OmpSessionSwitchEvent, ctx: OmpExtensionContext) => unknown): void;
	on(event: "session_shutdown", handler: (event: unknown, ctx: OmpExtensionContext) => unknown): void;
	on(event: "input", handler: (event: OmpInputEvent, ctx: OmpExtensionContext) => unknown): void;
	on(
		event: "before_agent_start",
		handler: (
			event: OmpBeforeAgentStartEvent,
			ctx: OmpExtensionContext,
		) => OmpBeforeAgentStartResult | Promise<OmpBeforeAgentStartResult | undefined> | undefined,
	): void;
	on(
		event: "context",
		handler: (
			event: OmpContextEvent,
			ctx: OmpExtensionContext,
		) => OmpContextEventResult | Promise<OmpContextEventResult | undefined> | undefined,
	): void;
	on(
		event: "session.compacting",
		handler: (
			event: OmpSessionCompactingEvent,
			ctx: OmpExtensionContext,
		) => OmpSessionCompactingResult | Promise<OmpSessionCompactingResult | undefined> | undefined,
	): void;
	on(event: "session_compact", handler: (event: OmpSessionCompactEvent, ctx: OmpExtensionContext) => unknown): void;
}

export type OmpExtensionFactory = (pi: OmpExtensionApi) => void;
