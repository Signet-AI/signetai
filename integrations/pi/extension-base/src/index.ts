export {
	createDaemonClient,
	type DaemonClient,
	type DaemonClientConfig,
	type DaemonFetchFailure,
	type DaemonFetchResult,
} from "./daemon-client.js";
export {
	isRecord,
	readRuntimeEnv,
	readTrimmedRuntimeEnv,
	readTrimmedString,
} from "./helpers.js";
export {
	currentSessionRef,
	defaultStaticFallback,
	endCurrentSession,
	endPreviousSession,
	ensureSessionContext,
	flushPendingSessionEnds,
	type LifecycleConfig,
	type LifecycleDeps,
	refreshSessionStart,
	requestRecallForPrompt,
	type SessionRef,
	type SessionStartResult,
	type UserPromptSubmitResult,
} from "./lifecycle.js";
export {
	type BaseSessionState,
	BaseSessionStateStore,
	evictOldestKey,
	MAX_ENDED_SESSIONS,
	MAX_PENDING_PER_SESSION,
	MAX_PENDING_SESSIONS,
	type PendingSessionEnd,
	sanitizeInject,
} from "./session-state.js";
export {
	buildTranscriptFromEntries,
	readSessionFileSnapshot,
	type SessionFileSnapshot,
} from "./transcript.js";
export type {
	BaseAgentMessage,
	BaseExtensionContext,
	BaseReadonlySessionManager,
	BaseSessionEntry,
	BaseSessionHeader,
} from "./types.js";
