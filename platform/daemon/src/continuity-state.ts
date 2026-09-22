import { realpathSync } from "node:fs";
import type { PipelineContinuityConfig } from "@signet/core";

export interface ContinuityState {
	readonly sessionKey: string;
	readonly harness: string;
	readonly project: string | undefined;
	readonly projectNormalized: string | undefined;
	promptCount: number;
	totalPromptCount: number;
	lastCheckpointAt: number;
	pendingQueries: string[];
	pendingPromptSnippets: string[];
	startedAt: number;
	structuralSnapshot?: StructuralSnapshot;
}

export interface StructuralSnapshot {
	readonly focalEntityIds: ReadonlyArray<string>;
	readonly focalEntityNames: ReadonlyArray<string>;
	readonly activeAspectIds: ReadonlyArray<string>;
	readonly surfacedConstraintCount: number;
	readonly traversalMemoryCount: number;
}

const MAX_PENDING_QUERIES = 20;
const MAX_PENDING_SNIPPETS = 10;
const SNIPPET_MAX_CHARS = 200;

const state = new Map<string, ContinuityState>();
function normalizePath(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	try {
		return realpathSync(raw);
	} catch {
		return raw;
	}
}
export function initContinuity(sessionKey: string, harness: string, project: string | undefined): void {
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
		pendingPromptSnippets: [],
		startedAt: now,
	});
}

export function setStructuralSnapshot(sessionKey: string | undefined, snapshot: StructuralSnapshot): void {
	if (!sessionKey) return;
	const s = state.get(sessionKey);
	if (!s) return;
	s.structuralSnapshot = snapshot;
}
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
export function shouldCheckpoint(sessionKey: string | undefined, config: PipelineContinuityConfig): boolean {
	if (!sessionKey || !config.enabled) return false;
	const s = state.get(sessionKey);
	if (!s) return false;

	const promptsSinceLast = s.promptCount;
	const elapsed = Date.now() - s.lastCheckpointAt;
	if (elapsed >= config.timeIntervalMs) return true;
	if (promptsSinceLast >= config.promptInterval) return true;
	return false;
}
export function consumeState(sessionKey: string | undefined): ContinuityState | undefined {
	if (!sessionKey) return undefined;
	const s = state.get(sessionKey);
	if (!s) return undefined;
	const snapshot: ContinuityState = {
		...s,
		pendingQueries: [...s.pendingQueries],
		pendingPromptSnippets: [...s.pendingPromptSnippets],
	};
	s.promptCount = 0;
	s.lastCheckpointAt = Date.now();
	s.pendingQueries = [];
	s.pendingPromptSnippets = [];

	return snapshot;
}
export function clearContinuity(sessionKey: string | undefined): void {
	if (!sessionKey) return;
	state.delete(sessionKey);
}
export function getState(sessionKey: string | undefined): Readonly<ContinuityState> | undefined {
	if (!sessionKey) return undefined;
	return state.get(sessionKey);
}
export function getActiveSessionKeys(): ReadonlyArray<string> {
	return [...state.keys()];
}
