/**
 * Continuity State — per-session accumulation for checkpoint writes.
 *
 * Tracks prompt counts, search queries, and /remember calls so the
 * checkpoint module can build periodic digests. Separate from
 * session-tracker.ts which handles runtime claim mutex.
 */

import { realpathSync } from "node:fs";
import type { PipelineContinuityConfig } from "@signet/core";

export interface ContinuityState {
	readonly sessionKey: string;
	readonly harness: string;
	readonly project: string | undefined;
	readonly projectNormalized: string | undefined;
	/** Prompts since last consume (interval count). */
	promptCount: number;
	/** Total prompts across the entire session (never reset). */
	totalPromptCount: number;
	lastCheckpointAt: number;
	pendingQueries: string[];
	pendingRemembers: string[];
	pendingPromptSnippets: string[];
	startedAt: number;
}

const MAX_PENDING_QUERIES = 20;
const MAX_PENDING_REMEMBERS = 10;
const MAX_PENDING_SNIPPETS = 10;
const SNIPPET_MAX_CHARS = 200;

const state = new Map<string, ContinuityState>();

/** Resolve a project path via realpath, falling back to raw value. */
function normalizePath(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	try {
		return realpathSync(raw);
	} catch {
		return raw;
	}
}

/** Initialize accumulation state for a new session. */
export function initContinuity(
	sessionKey: string,
	harness: string,
	project: string | undefined,
): void {
	if (!sessionKey) return;
	const now = Date.now();
	state.set(sessionKey, {
		sessionKey,
		harness,
		project,
		projectNormalized: normalizePath(project),
		promptCount: 0,
		totalPromptCount: 0,
		lastCheckpointAt: now,
		pendingQueries: [],
		pendingRemembers: [],
		pendingPromptSnippets: [],
		startedAt: now,
	});
}

/** Record a user prompt, its search terms, and a truncated snippet. */
export function recordPrompt(
	sessionKey: string | undefined,
	queryTerms: string | undefined,
	promptSnippet: string | undefined,
): void {
	if (!sessionKey) return;
	const s = state.get(sessionKey);
	if (!s) return;
	s.promptCount++;
	s.totalPromptCount++;
	if (queryTerms) {
		s.pendingQueries.push(queryTerms);
		if (s.pendingQueries.length > MAX_PENDING_QUERIES) {
			s.pendingQueries.shift();
		}
	}
	if (promptSnippet) {
		const trimmed = promptSnippet.slice(0, SNIPPET_MAX_CHARS).trim();
		if (trimmed.length > 0) {
			s.pendingPromptSnippets.push(trimmed);
			if (s.pendingPromptSnippets.length > MAX_PENDING_SNIPPETS) {
				s.pendingPromptSnippets.shift();
			}
		}
	}
}

/** Record a /remember call content. */
export function recordRemember(
	sessionKey: string | undefined,
	content: string,
): void {
	if (!sessionKey) return;
	const s = state.get(sessionKey);
	if (!s) return;
	s.pendingRemembers.push(content);
	if (s.pendingRemembers.length > MAX_PENDING_REMEMBERS) {
		s.pendingRemembers.shift();
	}
}

/** Check whether a checkpoint should be written based on config thresholds. */
export function shouldCheckpoint(
	sessionKey: string | undefined,
	config: PipelineContinuityConfig,
): boolean {
	if (!sessionKey || !config.enabled) return false;
	const s = state.get(sessionKey);
	if (!s) return false;

	const promptsSinceLast = s.promptCount;
	// promptCount is total; check against interval relative to last checkpoint
	// We use a simple check: has promptCount crossed a multiple of promptInterval
	// since the last checkpoint?
	const elapsed = Date.now() - s.lastCheckpointAt;
	if (elapsed >= config.timeIntervalMs) return true;
	if (promptsSinceLast >= config.promptInterval) return true;
	return false;
}

/**
 * Return accumulated state and reset pending arrays.
 * The promptCount resets to 0 for the next interval.
 */
export function consumeState(
	sessionKey: string | undefined,
): ContinuityState | undefined {
	if (!sessionKey) return undefined;
	const s = state.get(sessionKey);
	if (!s) return undefined;

	// Snapshot
	const snapshot: ContinuityState = {
		...s,
		pendingQueries: [...s.pendingQueries],
		pendingRemembers: [...s.pendingRemembers],
		pendingPromptSnippets: [...s.pendingPromptSnippets],
	};

	// Reset for next interval
	s.promptCount = 0;
	s.lastCheckpointAt = Date.now();
	s.pendingQueries = [];
	s.pendingRemembers = [];
	s.pendingPromptSnippets = [];

	return snapshot;
}

/** Clear state when a session ends. */
export function clearContinuity(sessionKey: string | undefined): void {
	if (!sessionKey) return;
	state.delete(sessionKey);
}

/** Read-only access for diagnostics. */
export function getState(
	sessionKey: string | undefined,
): Readonly<ContinuityState> | undefined {
	if (!sessionKey) return undefined;
	return state.get(sessionKey);
}

/** Get all active session keys (for flush-on-shutdown). */
export function getActiveSessionKeys(): ReadonlyArray<string> {
	return [...state.keys()];
}
