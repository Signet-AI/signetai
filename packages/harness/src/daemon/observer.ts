/**
 * SSE log stream consumer that normalizes daemon LogEntry objects
 * into typed PipelineEvent objects for the visualization layer.
 */

import type { LogEntry } from "./types.js";
import type { PipelineEvent } from "../viz/types.js";

/**
 * Normalize a daemon LogEntry into a PipelineEvent.
 * Returns undefined if the entry doesn't map to a pipeline event.
 */
export function normalizeLogEntry(
	entry: LogEntry,
): PipelineEvent | undefined {
	const now = new Date(entry.timestamp).getTime() || Date.now();
	const data = entry.data ?? {};
	const msg = entry.message;

	switch (entry.category) {
		case "hooks":
			return normalizeHookEntry(msg, data, now);
		case "pipeline":
			return normalizePipelineEntry(msg, data, now);
		case "memory":
			return normalizeMemoryEntry(msg, data, now);
		case "session-memories":
			return normalizeSessionMemoriesEntry(data, now);
		default:
			return undefined;
	}
}

function normalizeHookEntry(
	msg: string,
	data: Record<string, unknown>,
	ts: number,
): PipelineEvent | undefined {
	// Session start/end/prompt hooks
	if (
		msg.includes("Session start") ||
		msg.includes("User prompt") ||
		msg.includes("Session end") ||
		msg.includes("Pre-compaction") ||
		msg.includes("Recall") ||
		msg.includes("Remember")
	) {
		const hookName = extractHookName(msg);
		return {
			kind: "hook",
			name: hookName,
			durationMs: (data.durationMs as number) ?? 0,
			memoryCount: (data.memoryCount as number) ?? 0,
			injectChars: (data.injectChars as number) ?? 0,
			sessionKey: data.sessionKey as string | undefined,
			timestamp: ts,
		};
	}

	return undefined;
}

function normalizePipelineEntry(
	msg: string,
	data: Record<string, unknown>,
	ts: number,
): PipelineEvent | undefined {
	if (msg.includes("extraction") || msg.includes("extract")) {
		return {
			kind: "extraction",
			facts: (data.facts as number) ?? (data.factCount as number) ?? 0,
			entities:
				(data.entities as number) ??
				(data.entityCount as number) ??
				0,
			durationMs: (data.durationMs as number) ?? 0,
			jobId: data.jobId as string | undefined,
			timestamp: ts,
		};
	}

	if (
		msg.includes("decision") ||
		msg.includes("proposal") ||
		msg.includes("shadow")
	) {
		return {
			kind: "decision",
			action:
				(data.action as "add" | "update" | "skip" | "delete") ??
				(data.proposedAction as
					| "add"
					| "update"
					| "skip"
					| "delete") ??
				"skip",
			confidence: (data.confidence as number) ?? 0,
			content: (data.content as string) ?? (data.fact as string) ?? "",
			memoryId: data.memoryId as string | undefined,
			timestamp: ts,
		};
	}

	if (msg.includes("worker")) {
		return {
			kind: "pipeline_worker",
			worker: (data.worker as string) ?? "unknown",
			status: (data.status as string) ?? msg,
			timestamp: ts,
		};
	}

	return undefined;
}

function normalizeMemoryEntry(
	msg: string,
	data: Record<string, unknown>,
	ts: number,
): PipelineEvent | undefined {
	if (msg.includes("saved") || msg.includes("created")) {
		return {
			kind: "memory_write",
			id: (data.id as string) ?? "",
			content: (data.content as string) ?? "",
			type: (data.type as string) ?? "fact",
			timestamp: ts,
		};
	}
	return undefined;
}

function normalizeSessionMemoriesEntry(
	data: Record<string, unknown>,
	ts: number,
): PipelineEvent {
	return {
		kind: "injection_candidates",
		total: (data.total as number) ?? (data.candidateCount as number) ?? 0,
		injected:
			(data.injected as number) ?? (data.injectedCount as number) ?? 0,
		sessionKey: data.sessionKey as string | undefined,
		timestamp: ts,
	};
}

function extractHookName(msg: string): string {
	const lower = msg.toLowerCase();
	if (lower.includes("session start")) return "session-start";
	if (lower.includes("session end")) return "session-end";
	if (lower.includes("user prompt")) return "user-prompt-submit";
	if (lower.includes("pre-compaction")) return "pre-compaction";
	if (lower.includes("recall")) return "recall";
	if (lower.includes("remember")) return "remember";
	return msg.slice(0, 30);
}
