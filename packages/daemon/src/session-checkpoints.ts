/**
 * Session Checkpoints — write/read/prune checkpoint rows and
 * manage a debounced flush queue so writes don't block the
 * user-prompt-submit hot path.
 */

import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import type {
	ContinuityState,
	StructuralSnapshot,
} from "./continuity-state";
import { logger } from "./logger";

// ============================================================================
// Types
// ============================================================================

export type CheckpointTrigger =
	| "periodic"
	| "pre_compaction"
	| "session_end"
	| "mid_session_extract"
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
	readonly focal_entity_ids: string | null;
	readonly focal_entity_names: string | null;
	readonly active_aspect_ids: string | null;
	readonly surfaced_constraint_count: number | null;
	readonly traversal_memory_count: number | null;
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
	readonly focalEntityIds?: ReadonlyArray<string>;
	readonly focalEntityNames?: ReadonlyArray<string>;
	readonly activeAspectIds?: ReadonlyArray<string>;
	readonly surfacedConstraintCount?: number;
	readonly traversalMemoryCount?: number;
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
			  recent_remembers, focal_entity_ids, focal_entity_names,
			  active_aspect_ids, surfaced_constraint_count,
			  traversal_memory_count, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			params.focalEntityIds && params.focalEntityIds.length > 0
				? JSON.stringify(params.focalEntityIds)
				: null,
			params.focalEntityNames && params.focalEntityNames.length > 0
				? JSON.stringify(params.focalEntityNames)
				: null,
			params.activeAspectIds && params.activeAspectIds.length > 0
				? JSON.stringify(params.activeAspectIds)
				: null,
			typeof params.surfacedConstraintCount === "number"
				? params.surfacedConstraintCount
				: null,
			typeof params.traversalMemoryCount === "number"
				? params.traversalMemoryCount
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

function parseJsonArray(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(value): value is string =>
				typeof value === "string" && value.trim().length > 0,
		);
	} catch {
		return [];
	}
}

function buildStructuralSection(snapshot?: StructuralSnapshot): string[] {
	if (!snapshot) return [];
	const lines: string[] = [];
	const focalNames = snapshot.focalEntityNames.join(", ");
	const activeAspectCount = snapshot.activeAspectIds.length;
	if (
		focalNames.length === 0 &&
		activeAspectCount === 0 &&
		snapshot.surfacedConstraintCount === 0 &&
		snapshot.traversalMemoryCount === 0
	) {
		return [];
	}

	lines.push("", "### Structural Context");
	if (focalNames.length > 0) {
		lines.push(`Focal entities: ${focalNames}`);
	}
	if (activeAspectCount > 0) {
		lines.push(`Active aspects: ${activeAspectCount}`);
	}
	if (snapshot.surfacedConstraintCount > 0) {
		lines.push(`Active constraints: ${snapshot.surfacedConstraintCount}`);
	}
	if (snapshot.traversalMemoryCount > 0) {
		lines.push(`Traversal memories: ${snapshot.traversalMemoryCount}`);
	}
	return lines;
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

export function formatPeriodicDigest(
	state: ContinuityState,
	structuralSnapshot?: StructuralSnapshot,
): string {
	const elapsed = Date.now() - state.startedAt;
	const elapsedStr = formatDuration(elapsed);

	const parts: string[] = [
		"## Session Checkpoint",
		`Project: ${state.project ?? "unknown"}`,
		`Prompts: ${state.promptCount} | Duration: ${elapsedStr}`,
	];

	parts.push(...buildStructuralSection(structuralSnapshot ?? state.structuralSnapshot));

	if (state.pendingPromptSnippets.length > 0) {
		parts.push("", "### Recent Prompts");
		for (const snippet of state.pendingPromptSnippets) {
			parts.push(`- ${snippet}`);
		}
	}

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

export function formatPreCompactionDigest(
	state: ContinuityState,
	sessionContext?: string,
	structuralSnapshot?: StructuralSnapshot,
): string {
	const elapsed = Date.now() - state.startedAt;
	const elapsedStr = formatDuration(elapsed);

	const parts: string[] = [
		"## Pre-Compaction Checkpoint",
		`Project: ${state.project ?? "unknown"}`,
		`Duration: ${elapsedStr} | Prompts: ${state.promptCount}`,
	];

	if (sessionContext) {
		parts.push("", "### Session Context", sessionContext);
	}

	parts.push(...buildStructuralSection(structuralSnapshot ?? state.structuralSnapshot));

	if (state.pendingPromptSnippets.length > 0) {
		parts.push("", "### Recent Prompts");
		for (const snippet of state.pendingPromptSnippets) {
			parts.push(`- ${snippet}`);
		}
	}

	if (state.pendingQueries.length > 0 || state.pendingRemembers.length > 0) {
		parts.push("", "### Memory Activity");
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

export function formatSessionEndDigest(
	state: ContinuityState,
	structuralSnapshot?: StructuralSnapshot,
): string {
	const elapsed = Date.now() - state.startedAt;
	const elapsedStr = formatDuration(elapsed);

	const parts: string[] = [
		"## Session End Checkpoint",
		`Project: ${state.project ?? "unknown"}`,
		`Duration: ${elapsedStr} | Total Prompts: ${state.totalPromptCount}`,
	];

	parts.push(...buildStructuralSection(structuralSnapshot ?? state.structuralSnapshot));

	if (state.pendingPromptSnippets.length > 0) {
		parts.push("", "### Recent Prompts");
		for (const snippet of state.pendingPromptSnippets) {
			parts.push(`- ${snippet}`);
		}
	}

	if (state.pendingQueries.length > 0 || state.pendingRemembers.length > 0) {
		parts.push("", "### Memory Activity");
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

export function getCheckpointStructuralSnapshot(
	row: CheckpointRow | undefined,
): StructuralSnapshot | undefined {
	if (!row) return undefined;
	const focalEntityIds = parseJsonArray(row.focal_entity_ids);
	const focalEntityNames = parseJsonArray(row.focal_entity_names);
	const activeAspectIds = parseJsonArray(row.active_aspect_ids);
	const surfacedConstraintCount = row.surfaced_constraint_count ?? 0;
	const traversalMemoryCount = row.traversal_memory_count ?? 0;
	if (
		focalEntityIds.length === 0 &&
		focalEntityNames.length === 0 &&
		activeAspectIds.length === 0 &&
		surfacedConstraintCount === 0 &&
		traversalMemoryCount === 0
	) {
		return undefined;
	}
	return {
		focalEntityIds,
		focalEntityNames,
		activeAspectIds,
		surfacedConstraintCount,
		traversalMemoryCount,
	};
}

export function formatRecoveryDigest(
	row: CheckpointRow,
	budgetChars: number,
): string {
	const digest = row.digest;
	if (budgetChars <= 0) return "";

	const structuralSnapshot = getCheckpointStructuralSnapshot(row);
	if (!structuralSnapshot) {
		return digest.length > budgetChars
			? `${digest.slice(0, budgetChars)}\n[truncated]`
			: digest;
	}

	const recentPromptIndex = digest.indexOf("\n### Recent Prompts");
	const memoryActivityIndex = digest.indexOf("\n### Memory Activity");
	const splitIndices = [recentPromptIndex, memoryActivityIndex].filter(
		(index) => index >= 0,
	);
	const splitIndex =
		splitIndices.length > 0 ? Math.min(...splitIndices) : digest.length;
	const structuralPriority = digest.slice(0, splitIndex);
	const remainder = digest.slice(splitIndex);

	if (structuralPriority.length >= budgetChars) {
		return `${structuralPriority.slice(0, budgetChars)}\n[truncated]`;
	}

	const remainingBudget = budgetChars - structuralPriority.length;
	if (remainder.length === 0) return structuralPriority;
	if (remainingBudget <= 0) return `${structuralPriority}\n[truncated]`;
	if (remainder.length <= remainingBudget) {
		return structuralPriority + remainder;
	}

	return `${structuralPriority}${remainder.slice(0, remainingBudget)}\n[truncated]`;
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
		const mergedFocalEntityIds = [
			...(existing.params.focalEntityIds ?? []),
			...(params.focalEntityIds ?? []),
		].filter((value, index, array) => array.indexOf(value) === index);
		const mergedFocalEntityNames = [
			...(existing.params.focalEntityNames ?? []),
			...(params.focalEntityNames ?? []),
		].filter((value, index, array) => array.indexOf(value) === index);
		const mergedActiveAspectIds = [
			...(existing.params.activeAspectIds ?? []),
			...(params.activeAspectIds ?? []),
		].filter((value, index, array) => array.indexOf(value) === index);
		pendingWrites.set(params.sessionKey, {
			params: {
				...params,
				promptCount: existing.params.promptCount + params.promptCount,
				memoryQueries: mergedQueries,
				recentRemembers: mergedRemembers,
				focalEntityIds:
					mergedFocalEntityIds.length > 0
						? mergedFocalEntityIds
						: undefined,
				focalEntityNames:
					mergedFocalEntityNames.length > 0
						? mergedFocalEntityNames
						: undefined,
				activeAspectIds:
					mergedActiveAspectIds.length > 0
						? mergedActiveAspectIds
						: undefined,
				surfacedConstraintCount: Math.max(
					existing.params.surfacedConstraintCount ?? 0,
					params.surfacedConstraintCount ?? 0,
				),
				traversalMemoryCount: Math.max(
					existing.params.traversalMemoryCount ?? 0,
					params.traversalMemoryCount ?? 0,
				),
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
