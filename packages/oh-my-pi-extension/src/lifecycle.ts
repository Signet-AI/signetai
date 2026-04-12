import { homedir } from "node:os";
import { join } from "node:path";
import {
	STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS,
	readStaticIdentity,
	resolveSessionStartTimeoutMs,
} from "@signet/core";
import {
	type LifecycleConfig,
	type LifecycleDeps,
	currentSessionRef,
	endCurrentSession,
	endPreviousSession,
	ensureSessionContext,
	flushPendingSessionEnds,
	refreshSessionStart,
	requestRecallForPrompt,
} from "@signet/pi-extension-base";
import { readTrimmedRuntimeEnv } from "@signet/pi-extension-base";
import {
	FETCH_TIMEOUT_ENV,
	HARNESS,
	HIDDEN_RECALL_CUSTOM_TYPE,
	HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
	PROMPT_SUBMIT_TIMEOUT,
	RUNTIME_PATH,
	SESSION_START_TIMEOUT_ENV,
	WRITE_TIMEOUT,
} from "./types.js";

export type { LifecycleDeps };
export {
	currentSessionRef,
	endCurrentSession,
	endPreviousSession,
	ensureSessionContext,
	flushPendingSessionEnds,
	refreshSessionStart,
	requestRecallForPrompt,
};

const EXCLUDED_CUSTOM_TYPES: ReadonlySet<string> = new Set([
	HIDDEN_RECALL_CUSTOM_TYPE,
	HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
]);

export const OMP_LIFECYCLE_CONFIG: LifecycleConfig = {
	harness: HARNESS,
	runtimePath: RUNTIME_PATH,
	writeTimeout: WRITE_TIMEOUT,
	promptSubmitTimeout: PROMPT_SUBMIT_TIMEOUT,
	excludedCustomTypes: EXCLUDED_CUSTOM_TYPES,
	sessionStartTimeout: () =>
		resolveSessionStartTimeoutMs(
			readTrimmedRuntimeEnv(SESSION_START_TIMEOUT_ENV) ?? readTrimmedRuntimeEnv(FETCH_TIMEOUT_ENV),
		),
	staticFallback: (reason: "offline" | "timeout"): string => {
		const signetPath = readTrimmedRuntimeEnv("SIGNET_PATH") ?? join(homedir(), ".agents");
		if (reason === "timeout") {
			return readStaticIdentity(signetPath, STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS) ?? "";
		}
		return readStaticIdentity(signetPath) ?? "";
	},
};
