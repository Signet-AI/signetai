/**
 * Incident timeline builder for operator debugging.
 *
 * Given a memory ID, request ID, or session ID, builds a chronological
 * timeline of everything that happened to/around that entity by joining
 * across memory_history, memory_jobs, logger, and error buffer.
 */

import type { ReadDb } from "./db-accessor";
import type { LogEntry } from "./logger";
import type { ErrorEntry } from "./analytics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimelineEvent {
	readonly timestamp: string;
	readonly source: "history" | "job" | "log" | "error";
	readonly event: string;
	readonly details: Readonly<Record<string, unknown>>;
}

export interface Timeline {
	readonly entityType: "memory" | "request" | "session" | "unknown";
	readonly entityId: string;
	readonly events: readonly TimelineEvent[];
	readonly generatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HistoryRow {
	memory_id: string;
	event: string;
	old_content: string | null;
	new_content: string | null;
	changed_by: string;
	reason: string | null;
	metadata: string | null;
	created_at: string;
}

interface JobRow {
	id: string;
	memory_id: string;
	job_type: string;
	status: string;
	attempts: number;
	error: string | null;
	created_at: string;
	updated_at: string;
	leased_at: string | null;
	completed_at: string | null;
	failed_at: string | null;
}

function historyToEvents(rows: readonly HistoryRow[]): TimelineEvent[] {
	return rows.map((r) => ({
		timestamp: r.created_at,
		source: "history" as const,
		event: r.event,
		details: {
			changedBy: r.changed_by,
			reason: r.reason,
			hasOldContent: r.old_content !== null,
			hasNewContent: r.new_content !== null,
			...(r.metadata ? tryParseJson(r.metadata) : {}),
		},
	}));
}

function jobToEvents(rows: readonly JobRow[]): TimelineEvent[] {
	const events: TimelineEvent[] = [];
	for (const j of rows) {
		events.push({
			timestamp: j.created_at,
			source: "job",
			event: `job:${j.job_type}:created`,
			details: { jobId: j.id, status: j.status },
		});
		if (j.leased_at) {
			events.push({
				timestamp: j.leased_at,
				source: "job",
				event: `job:${j.job_type}:leased`,
				details: { jobId: j.id, attempt: j.attempts },
			});
		}
		if (j.completed_at) {
			events.push({
				timestamp: j.completed_at,
				source: "job",
				event: `job:${j.job_type}:completed`,
				details: { jobId: j.id },
			});
		}
		if (j.failed_at) {
			events.push({
				timestamp: j.failed_at,
				source: "job",
				event: `job:${j.job_type}:failed`,
				details: { jobId: j.id, error: j.error, attempt: j.attempts },
			});
		}
	}
	return events;
}

function logToEvents(entries: readonly LogEntry[]): TimelineEvent[] {
	return entries.map((e) => ({
		timestamp: e.timestamp,
		source: "log" as const,
		event: `log:${e.level}:${e.category}`,
		details: {
			message: e.message,
			...(e.data ?? {}),
			...(e.duration !== undefined ? { durationMs: e.duration } : {}),
		},
	}));
}

function errorToEvents(entries: readonly ErrorEntry[]): TimelineEvent[] {
	return entries.map((e) => ({
		timestamp: e.timestamp,
		source: "error" as const,
		event: `error:${e.stage}:${e.code}`,
		details: {
			message: e.message,
			...(e.requestId ? { requestId: e.requestId } : {}),
			...(e.memoryId ? { memoryId: e.memoryId } : {}),
			...(e.actor ? { actor: e.actor } : {}),
		},
	}));
}

function tryParseJson(s: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(s);
		if (typeof parsed === "object" && parsed !== null) return parsed;
	} catch {
		// not json
	}
	return {};
}

// ---------------------------------------------------------------------------
// Entity detection
// ---------------------------------------------------------------------------

type EntityType = "memory" | "request" | "session" | "unknown";

function detectEntityType(
	db: ReadDb,
	id: string,
): { type: EntityType; memoryId?: string } {
	// Try memory_history by memory_id
	const historyHit = db
		.prepare(
			"SELECT 1 FROM memory_history WHERE memory_id = ? LIMIT 1",
		)
		.get(id) as unknown;
	if (historyHit) return { type: "memory", memoryId: id };

	// Try memories table directly
	const memoryHit = db
		.prepare("SELECT 1 FROM memories WHERE id = ? LIMIT 1")
		.get(id) as unknown;
	if (memoryHit) return { type: "memory", memoryId: id };

	// Try job by memory_id
	const jobHit = db
		.prepare("SELECT memory_id FROM memory_jobs WHERE id = ? LIMIT 1")
		.get(id) as { memory_id: string } | undefined;
	if (jobHit) return { type: "memory", memoryId: jobHit.memory_id };

	// Could be a request ID or session ID — we can't resolve these
	// from the DB alone, but we can still gather log/error matches
	return { type: "unknown" };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface TimelineSources {
	readonly db: ReadDb;
	readonly getRecentLogs: (opts: {
		limit?: number;
	}) => readonly LogEntry[];
	readonly getRecentErrors: (opts?: {
		limit?: number;
	}) => readonly ErrorEntry[];
}

export function buildTimeline(
	sources: TimelineSources,
	entityId: string,
): Timeline {
	const { db, getRecentLogs, getRecentErrors } = sources;
	const detection = detectEntityType(db, entityId);
	const allEvents: TimelineEvent[] = [];

	// Gather history events
	if (detection.memoryId) {
		const historyRows = db
			.prepare(
				`SELECT memory_id, event, old_content, new_content,
				        changed_by, reason, metadata, created_at
				 FROM memory_history
				 WHERE memory_id = ?
				 ORDER BY created_at ASC`,
			)
			.all(detection.memoryId) as HistoryRow[];
		allEvents.push(...historyToEvents(historyRows));

		// Gather job events
		const jobRows = db
			.prepare(
				`SELECT id, memory_id, job_type, status, attempts,
				        error, created_at, updated_at, leased_at,
				        completed_at, failed_at
				 FROM memory_jobs
				 WHERE memory_id = ?
				 ORDER BY created_at ASC`,
			)
			.all(detection.memoryId) as JobRow[];
		allEvents.push(...jobToEvents(jobRows));
	}

	// Gather log entries that mention this ID
	const logs = getRecentLogs({ limit: 500 });
	const matchingLogs = logs.filter((l) => {
		if (l.data) {
			const vals = Object.values(l.data);
			for (const v of vals) {
				if (typeof v === "string" && v.includes(entityId)) return true;
			}
		}
		return l.message.includes(entityId);
	});
	allEvents.push(...logToEvents(matchingLogs));

	// Gather error entries that mention this ID
	const errors = getRecentErrors({ limit: 500 });
	const matchingErrors = errors.filter(
		(e) =>
			e.memoryId === entityId ||
			e.requestId === entityId ||
			e.message.includes(entityId),
	);
	allEvents.push(...errorToEvents(matchingErrors));

	// Sort chronologically
	allEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	return {
		entityType: detection.type,
		entityId,
		events: allEvents,
		generatedAt: new Date().toISOString(),
	};
}
