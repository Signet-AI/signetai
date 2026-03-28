import type {
	BeforeAgentStartEvent,
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	InputEvent,
	SessionCompactingEvent,
	SessionCompactingResult,
	SessionSwitchEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ReadonlySessionManager, SessionEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-manager";

export const DAEMON_URL_DEFAULT = "http://localhost:3850";
export const HARNESS = "oh-my-pi" as const;
export const RUNTIME_PATH = "plugin" as const;

export const READ_TIMEOUT = 5_000;
export const WRITE_TIMEOUT = 10_000;
export const PROMPT_SUBMIT_TIMEOUT = READ_TIMEOUT;

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

export type OmpAgentMessage = ContextEvent["messages"][number];
export type OmpBeforeAgentStartEvent = BeforeAgentStartEvent;
export type OmpContextEvent = ContextEvent;
export type OmpContextEventResult = ContextEventResult;
export type OmpExtensionApi = ExtensionAPI;
export type OmpExtensionContext = ExtensionContext & {
	readonly sessionManager: ReadonlySessionManager;
};
export type OmpExtensionFactory = ExtensionFactory;
export type OmpInputEvent = InputEvent;
export type OmpSessionCompactingEvent = SessionCompactingEvent;
export type OmpSessionCompactingResult = SessionCompactingResult;
export type OmpSessionEntry = SessionEntry;
export type OmpSessionHeader = SessionHeader;
export type OmpSessionSwitchEvent = SessionSwitchEvent;
