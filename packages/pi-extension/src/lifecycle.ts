import {
	type LifecycleConfig,
	type LifecycleDeps,
	defaultStaticFallback,
	currentSessionRef,
	endCurrentSession,
	endPreviousSession,
	ensureSessionContext,
	flushPendingSessionEnds,
	refreshSessionStart,
	requestRecallForPrompt,
} from "@signet/extension-base";
import {
	HARNESS,
	HIDDEN_RECALL_CUSTOM_TYPE,
	HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
	PROMPT_SUBMIT_TIMEOUT,
	READ_TIMEOUT,
	RUNTIME_PATH,
	WRITE_TIMEOUT,
} from "./types.js";

export type { LifecycleDeps };
export { currentSessionRef, endCurrentSession, endPreviousSession, ensureSessionContext, flushPendingSessionEnds, refreshSessionStart, requestRecallForPrompt };

const EXCLUDED_CUSTOM_TYPES: ReadonlySet<string> = new Set([
	HIDDEN_RECALL_CUSTOM_TYPE,
	HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
]);

export const PI_LIFECYCLE_CONFIG: LifecycleConfig = {
	harness: HARNESS,
	runtimePath: RUNTIME_PATH,
	writeTimeout: WRITE_TIMEOUT,
	promptSubmitTimeout: PROMPT_SUBMIT_TIMEOUT,
	excludedCustomTypes: EXCLUDED_CUSTOM_TYPES,
	sessionStartTimeout: () => READ_TIMEOUT,
	staticFallback: defaultStaticFallback,
};
