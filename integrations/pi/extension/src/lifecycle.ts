import { resolvePromptSubmitTimeoutMs } from "@signet/core";
import {
	type LifecycleConfig,
	type LifecycleDeps,
	beginPromptSubmit,
	currentSessionRef,
	defaultStaticFallback,
	endCurrentSession,
	endPreviousSession,
	ensureSessionContext,
	flushPendingSessionEnds,
	readTrimmedRuntimeEnv,
	refreshSessionStart,
	requestNotifications,
	settlePromptSubmit,
} from "@signet/pi-extension-base";
import {
	HARNESS,
	HIDDEN_CLOCK_CUSTOM_TYPE,
	HIDDEN_RECALL_CUSTOM_TYPE,
	HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
	PROMPT_SUBMIT_TIMEOUT_ENV,
	READ_TIMEOUT,
	RUNTIME_PATH,
	WRITE_TIMEOUT,
} from "./types.js";

export type { LifecycleDeps };
export {
	beginPromptSubmit,
	currentSessionRef,
	endCurrentSession,
	endPreviousSession,
	ensureSessionContext,
	flushPendingSessionEnds,
	refreshSessionStart,
	requestNotifications,
	settlePromptSubmit,
};

const EXCLUDED_CUSTOM_TYPES: ReadonlySet<string> = new Set([
	HIDDEN_CLOCK_CUSTOM_TYPE,
	HIDDEN_RECALL_CUSTOM_TYPE,
	HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
]);

export const PI_LIFECYCLE_CONFIG: LifecycleConfig = {
	harness: HARNESS,
	runtimePath: RUNTIME_PATH,
	writeTimeout: WRITE_TIMEOUT,
	promptSubmitTimeout: resolvePromptSubmitTimeoutMs(readTrimmedRuntimeEnv(PROMPT_SUBMIT_TIMEOUT_ENV)),
	excludedCustomTypes: EXCLUDED_CUSTOM_TYPES,
	sessionStartTimeout: () => READ_TIMEOUT,
	staticFallback: defaultStaticFallback,
};
