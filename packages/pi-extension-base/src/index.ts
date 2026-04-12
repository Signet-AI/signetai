export {
	isRecord,
	readRuntimeEnv,
	readTrimmedString,
	readTrimmedRuntimeEnv,
} from "./helpers.js";

export type {
	BaseAgentMessage,
	BaseExtensionContext,
	BaseReadonlySessionManager,
	BaseSessionEntry,
	BaseSessionHeader,
} from "./types.js";

export {
	buildTranscriptFromEntries,
	readSessionFileSnapshot,
	type SessionFileSnapshot,
} from "./transcript.js";

export {
	createDaemonClient,
	type DaemonClient,
	type DaemonClientConfig,
	type DaemonFetchFailure,
	type DaemonFetchResult,
} from "./daemon-client.js";

export {
	currentSessionRef,
	defaultStaticFallback,
	endCurrentSession,
	endPreviousSession,
	ensureSessionContext,
	flushPendingSessionEnds,
	refreshSessionStart,
	requestRecallForPrompt,
	type LifecycleConfig,
	type LifecycleDeps,
	type SessionRef,
	type SessionStartResult,
	type UserPromptSubmitResult,
} from "./lifecycle.js";

export {
	BaseSessionStateStore,
	type BaseSessionState,
	type PendingSessionEnd,
	evictOldestKey,
	MAX_ENDED_SESSIONS,
	MAX_PENDING_PER_SESSION,
	MAX_PENDING_SESSIONS,
	sanitizeInject,
} from "./session-state.js";
