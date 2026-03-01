/**
 * Session Checkpoints — write/read/prune checkpoint rows and
 * manage a debounced flush queue so writes don't block the
 * user-prompt-submit hot path.
 */

import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import type { ContinuityState } from "./continuity-state";
import { logger } from "./logger";

// ============================================================================
// Types
// ============================================================================

export type CheckpointTrigger =
	| "periodic"
	| "pre_compaction"
	| "agent"
	| "explicit";

export interface CheckpointRow {
	readonly id: string;
	readonly session_key: string;
	readonly harness: string;
	readonly project: string | null;
	readonly project_normalized: string | null;
	readonly trigger: string;
	readonly digest: string;
	readonly prompt_count: number;
	readonly memory_queries: string | null;
	readonly recent_remembers: string | null;
	readonly created_at: string;
}

export interface WriteCheckpointParams {
	readonly sessionKey: string;
	readonly harness: string;
	readonly project: string | undefined;
	readonly projectNormalized: string | undefined;
	readonly trigger: CheckpointTrigger;
	readonly digest: string;
	readonly promptCount: number;
	readonly memoryQueries: ReadonlyArray<string>;
	readonly recentRemembers: ReadonlyArray<string>;
}

// ============================================================================
// Redaction
// ============================================================================

// Common secret patterns — applied before storage and before API serve
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
	// Bearer tokens
	/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
	// API key formats (sk-, pk-, key-, api_key=, etc.)
	/\b(sk|pk|api[_-]?key|token|secret|password|credential)[_\-]?[=:\s]+\S{8,}/gi,
	// Base64-encoded blobs that look like credentials (32+ chars)
	/\b[A-Za-z0-9+/]{32,}={0,2}\b/g,
	// Environment variable references with values
	/\$[A-Z_]{4,}=[^\s]+/g,
	// Common key=value patterns
	/\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|NPM_TOKEN|AWS_SECRET)[=:\s]+\S+/gi,
];

export function redactSecrets(text: string): string {
	let result = text;
	for (const pattern of SECRET_PATTERNS) {
		// Reset lastIndex for global regexes
		pattern.lastIndex = 0;
		result = result.replace(pattern, "[REDACTED]");
	}
	return result;
}

/** Apply redaction to a checkpoint row before serving via API. */
export function redactCheckpointRow(row: CheckpointRow): CheckpointRow {
	return {
		...row,
		digest: redactSecrets(row.digest),
		recent_remembers: row.recent_remembers
			? JSON.stringify(
					(JSON.parse(row.recent_remembers) as string[]).map(redactSecrets),
				)
			: null,
	};
}

// ============================================================================
// Write
// ============================================================================

export function writeCheckpoint(
	db: DbAccessor,
	params: WriteCheckpointParams,
	maxPerSession: number,
): void {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const digest = redactSecrets(params.digest);

	db.withWriteTx((wdb: WriteDb) => {
		wdb.prepare(
			`INSERT INTO session_checkpoints
			 (id, session_key, harness, project, project_normalized,
			  trigger, digest, prompt_count, memory_queries,
			  recent_remembers, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			params.sessionKey,
			params.harness,
			params.project ?? null,
			params.projectNormalized ?? null,
			params.trigger,
			digest,
			params.promptCount,
			params.memoryQueries.length > 0
				? JSON.stringify(params.memoryQueries)
				: null,
			params.recentRemembers.length > 0
				? JSON.stringify(params.recentRemembers.map(redactSecrets))
				: null,
			now,
		);

		// Enforce per-session cap by deleting oldest beyond limit
		const count = wdb
			.prepare(
				"SELECT COUNT(*) as cnt FROM session_checkpoints WHERE session_key = ?",
			)
			.get(params.sessionKey) as { cnt: number };

		if (count.cnt > maxPerSession) {
			const excess = count.cnt - maxPerSession;
			wdb.prepare(
				`DELETE FROM session_checkpoints
				 WHERE id IN (
					 SELECT id FROM session_checkpoints
					 WHERE session_key = ?
					 ORDER BY created_at ASC, rowid ASC
					 LIMIT ?
				 )`,
			).run(params.sessionKey, excess);
		}
	});

	logger.info("checkpoints", "Checkpoint written", {
		id,
		sessionKey: params.sessionKey,
		trigger: params.trigger,
		promptCount: params.promptCount,
	});
}

// ============================================================================
// Read
// ============================================================================

/**
 * Get the most recent checkpoint for a normalized project path
 * within the given time window.
 */
export function getLatestCheckpoint(
	db: DbAccessor,
	projectNormalized: string | undefined,
	withinMs: number,
): CheckpointRow | undefined {
	if (!projectNormalized) return undefined;
	const cutoff = new Date(Date.now() - withinMs).toISOString();

	return db.withReadDb((rdb: ReadDb) => {
		const row = rdb
			.prepare(
				`SELECT * FROM session_checkpoints
				 WHERE project_normalized = ?
				   AND created_at > ?
				 ORDER BY created_at DESC, rowid DESC
				 LIMIT 1`,
			)
			.get(projectNormalized, cutoff) as CheckpointRow | null;
		return row ?? undefined;
	});
}

/** Get the most recent checkpoint for a specific session key. */
export function getLatestCheckpointBySession(
	db: DbAccessor,
	sessionKey: string,
): CheckpointRow | undefined {
	return db.withReadDb((rdb: ReadDb) => {
		const row = rdb
			.prepare(
				`SELECT * FROM session_checkpoints
				 WHERE session_key = ?
				 ORDER BY created_at DESC, rowid DESC
				 LIMIT 1`,
			)
			.get(sessionKey) as CheckpointRow | null;
		return row ?? undefined;
	});
}

/** Get all checkpoints for a session, newest first. */
export function getCheckpointsBySession(
	db: DbAccessor,
	sessionKey: string,
): ReadonlyArray<CheckpointRow> {
	return db.withReadDb((rdb: ReadDb) => {
		return rdb
			.prepare(
				`SELECT * FROM session_checkpoints
				 WHERE session_key = ?
				 ORDER BY created_at DESC, rowid DESC`,
			)
			.all(sessionKey) as CheckpointRow[];
	});
}

/** Get recent checkpoints for a project (for API). */
export function getCheckpointsByProject(
	db: DbAccessor,
	projectNormalized: string,
	limit: number,
): ReadonlyArray<CheckpointRow> {
	return db.withReadDb((rdb: ReadDb) => {
		return rdb
			.prepare(
				`SELECT * FROM session_checkpoints
				 WHERE project_normalized = ?
				 ORDER BY created_at DESC, rowid DESC
				 LIMIT ?`,
			)
			.all(projectNormalized, limit) as CheckpointRow[];
	});
}

// ============================================================================
// Pruning
// ============================================================================

/**
 * Delete all checkpoints older than retentionDays. Strict retention —
 * checkpoints are ephemeral session state, not forensic data.
 */
export function pruneCheckpoints(
	db: DbAccessor,
	retentionDays: number,
): number {
	const cutoff = new Date(
		Date.now() - retentionDays * 24 * 60 * 60 * 1000,
	).toISOString();

	return db.withWriteTx((wdb: WriteDb) => {
		const result = wdb
			.prepare("DELETE FROM session_checkpoints WHERE created_at < ?")
			.run(cutoff);

		const deleted = (result as unknown as { changes: number }).changes ?? 0;
		if (deleted > 0) {
			logger.info("checkpoints", "Pruned old checkpoints", {
				deleted,
				retentionDays,
			});
		}
		return deleted;
	});
}

// ============================================================================
// Digest formatting (passive channel)
// ============================================================================

export function formatPeriodicDigest(state: ContinuityState): string {
	const elapsed = Date.now() - state.startedAt;
	const elapsedStr = formatDuration(elapsed);

	const parts: string[] = [
		"## Session Checkpoint",
		`Project: ${state.project ?? "unknown"}`,
		`Prompts: ${state.promptCount} | Duration: ${elapsedStr}`,
	];

	if (state.pendingQueries.length > 0 || state.pendingRemembers.length > 0) {
		parts.push("", "### Memory Activity Since Last Checkpoint");
		if (state.pendingQueries.length > 0) {
			parts.push(`Queries: ${state.pendingQueries.join(", ")}`);
		}
		if (state.pendingRemembers.length > 0) {
			parts.push(
				`Remembered: ${state.pendingRemembers.map((r) => r.slice(0, 120)).join("; ")}`,
			);
		}
	}

	return parts.join("\n");
}

function formatDuration(ms: number): string {
	const mins = Math.floor(ms / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	const remainMins = mins % 60;
	return `${hours}h${remainMins > 0 ? ` ${remainMins}m` : ""}`;
}

// ============================================================================
// Buffered flush queue
// ============================================================================

interface PendingCheckpoint {
	readonly params: WriteCheckpointParams;
	readonly maxPerSession: number;
}

const pendingWrites = new Map<string, PendingCheckpoint>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let dbRef: DbAccessor | null = null;

const FLUSH_DELAY_MS = 2500;

/** Set the DB accessor used by the flush queue. Call once at daemon startup. */
export function initCheckpointFlush(db: DbAccessor): void {
	dbRef = db;
}

/**
 * Queue a checkpoint write. If a write is already pending for the same
 * session, merge the queries and remembers so data isn't lost when
 * two triggers fire within the flush window.
 */
export function queueCheckpointWrite(
	params: WriteCheckpointParams,
	maxPerSession: number,
): void {
	const existing = pendingWrites.get(params.sessionKey);
	if (existing) {
		// Merge: keep latest prompt count + digest, union queries/remembers
		const mergedQueries = [
			...existing.params.memoryQueries,
			...params.memoryQueries,
		].slice(-20);
		const mergedRemembers = [
			...existing.params.recentRemembers,
			...params.recentRemembers,
		].slice(-10);
		pendingWrites.set(params.sessionKey, {
			params: {
				...params,
				promptCount: existing.params.promptCount + params.promptCount,
				memoryQueries: mergedQueries,
				recentRemembers: mergedRemembers,
			},
			maxPerSession,
		});
	} else {
		pendingWrites.set(params.sessionKey, { params, maxPerSession });
	}

	if (flushTimer === null) {
		flushTimer = setTimeout(flushPendingCheckpoints, FLUSH_DELAY_MS);
	}
}

/** Flush all pending checkpoint writes immediately. */
export function flushPendingCheckpoints(): void {
	if (flushTimer !== null) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}

	if (pendingWrites.size === 0 || !dbRef) return;

	const entries = [...pendingWrites.values()];
	pendingWrites.clear();

	for (const entry of entries) {
		try {
			writeCheckpoint(dbRef, entry.params, entry.maxPerSession);
		} catch (err) {
			logger.error("checkpoints", "Failed to flush checkpoint", {
				sessionKey: entry.params.sessionKey,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
