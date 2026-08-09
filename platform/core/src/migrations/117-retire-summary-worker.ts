import { createHash } from "node:crypto";
import type { MigrationDb } from "./index";

function hasTable(db: MigrationDb, table: string): boolean {
	return db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (columns.some((row) => row.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function tableColumns(db: MigrationDb, table: string): Set<string> {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return new Set(rows.map((row) => (typeof row.name === "string" ? row.name : "")));
}

function hashTranscript(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function backfillTranscriptHashes(db: MigrationDb): void {
	const columns = tableColumns(db, "session_transcripts");
	if (!columns.has("content_hash") || !columns.has("content")) return;
	const rows = db
		.prepare("SELECT session_key, agent_id, content FROM session_transcripts WHERE content_hash IS NULL")
		.all() as ReadonlyArray<{ session_key?: unknown; agent_id?: unknown; content?: unknown }>;
	const update = db.prepare(
		"UPDATE session_transcripts SET content_hash = ? WHERE agent_id = ? AND session_key = ? AND content_hash IS NULL",
	);
	for (const row of rows) {
		if (typeof row.content !== "string" || typeof row.session_key !== "string") continue;
		update.run(
			hashTranscript(row.content),
			typeof row.agent_id === "string" ? row.agent_id : "default",
			row.session_key,
		);
	}
}

type RetiredSummaryJob = {
	id?: string;
	session_key?: string;
	transcript?: string;
	harness?: string | null;
	project?: string | null;
	agent_id?: string | null;
	trigger?: string | null;
	boundary_reason?: string | null;
	captured_at?: string | null;
	ended_at?: string | null;
	completed_at?: string | null;
	created_at?: string | null;
};

type BackfillCandidate = {
	readonly sessionKey: string;
	readonly job: RetiredSummaryJob;
	readonly content: string;
	readonly createdAt: string;
	readonly completedAt: string | null;
};

const COMPLETION_BOUNDARY_REASONS = new Set(["session_closed", "session_clear", "stale_session", "ttl_expired"]);

function summaryJobTimestamp(job: RetiredSummaryJob): string {
	return job.completed_at ?? job.ended_at ?? job.captured_at ?? job.created_at ?? new Date(0).toISOString();
}

function isCompletionBoundary(job: RetiredSummaryJob, columns: Set<string>): boolean {
	return (
		(columns.has("trigger") && job.trigger === "session_end") ||
		(columns.has("boundary_reason") && COMPLETION_BOUNDARY_REASONS.has(job.boundary_reason ?? ""))
	);
}

/** Preserve every distinct legacy job payload without duplicating full snapshots. */
function mergeTranscriptContent(current: string, next: string): string {
	if (current.length === 0) return next;
	if (next.length === 0 || current === next || current.includes(next)) return current;
	if (next.includes(current)) return next;
	return `${current}\n${next}`;
}

function backfillTranscriptsFromSummaryJobs(db: MigrationDb): void {
	if (!hasTable(db, "summary_jobs")) return;
	const summaryColumns = tableColumns(db, "summary_jobs");
	if (!summaryColumns.has("transcript")) return;

	const select = (name: keyof RetiredSummaryJob): string =>
		summaryColumns.has(name) ? `"${name}" AS "${name}"` : `NULL AS "${name}"`;
	const jobs = db
		.prepare(
			`SELECT ${(
				[
					"id",
					"session_key",
					"transcript",
					"harness",
					"project",
					"agent_id",
					"trigger",
					"boundary_reason",
					"captured_at",
					"ended_at",
					"completed_at",
					"created_at",
				] as const
			)
				.map(select)
				.join(", ")} FROM summary_jobs`,
		)
		.all() as ReadonlyArray<RetiredSummaryJob>;

	const candidates = new Map<string, BackfillCandidate>();
	for (const job of jobs) {
		if (typeof job.transcript !== "string" || job.transcript.trim().length === 0) continue;
		const agentId = typeof job.agent_id === "string" && job.agent_id.length > 0 ? job.agent_id : "default";
		const sessionKey =
			typeof job.session_key === "string" && job.session_key.trim().length > 0
				? job.session_key
				: `legacy-summary-job:${job.id ?? hashTranscript(`${summaryJobTimestamp(job)}\u0000${job.transcript}`)}`;
		const key = `${agentId}\u0000${sessionKey}`;
		const current = candidates.get(key);
		const timestamp = summaryJobTimestamp(job);
		const boundary = isCompletionBoundary(job, summaryColumns);
		const createdAt = job.captured_at ?? job.created_at ?? job.ended_at ?? timestamp;
		if (!current) {
			candidates.set(key, {
				sessionKey,
				job: { ...job, agent_id: agentId },
				content: job.transcript,
				createdAt,
				completedAt: boundary ? timestamp : null,
			});
			continue;
		}

		const currentTimestamp = summaryJobTimestamp(current.job);
		const preferred =
			timestamp > currentTimestamp || (timestamp === currentTimestamp && job.transcript.length > current.content.length)
				? { ...job, agent_id: agentId }
				: current.job;
		candidates.set(key, {
			sessionKey,
			job: preferred,
			content: mergeTranscriptContent(current.content, job.transcript),
			createdAt: current.createdAt < createdAt ? current.createdAt : createdAt,
			completedAt: current.completedAt ?? (boundary ? timestamp : null),
		});
	}

	const transcriptColumns = tableColumns(db, "session_transcripts");
	const hasUpdated = transcriptColumns.has("updated_at");
	const hasCompleted = transcriptColumns.has("completed_at");
	const hasHash = transcriptColumns.has("content_hash");
	const insertColumns = ["session_key", "content", "harness", "project", "agent_id", "created_at"];
	if (hasUpdated) insertColumns.push("updated_at");
	if (hasCompleted) insertColumns.push("completed_at");
	if (hasHash) insertColumns.push("content_hash");
	const insert = db.prepare(
		`INSERT OR IGNORE INTO session_transcripts (${insertColumns.join(", ")}) VALUES (${insertColumns.map(() => "?").join(", ")})`,
	);
	const existing = db.prepare(
		"SELECT content, completed_at FROM session_transcripts WHERE agent_id = ? AND session_key = ?",
	);
	for (const candidate of candidates.values()) {
		const job = candidate.job;
		const agentId = job.agent_id ?? "default";
		const existingRow = existing.get(agentId, candidate.sessionKey) as
			| { content?: unknown; completed_at?: unknown }
			| null
			| undefined;
		if (existingRow != null) {
			const previousContent = typeof existingRow.content === "string" ? existingRow.content : "";
			const mergedContent = mergeTranscriptContent(previousContent, candidate.content);
			const completedAt =
				typeof existingRow.completed_at === "string" && existingRow.completed_at.length > 0
					? existingRow.completed_at
					: candidate.completedAt;
			const assignments = ["content = ?"];
			const values: unknown[] = [mergedContent];
			if (hasUpdated && mergedContent !== previousContent) {
				assignments.push("updated_at = ?");
				values.push(candidate.createdAt);
			}
			if (hasCompleted && completedAt && !existingRow.completed_at) {
				assignments.push("completed_at = ?");
				values.push(completedAt);
			}
			if (hasHash) {
				assignments.push("content_hash = ?");
				values.push(hashTranscript(mergedContent));
			}
			values.push(agentId, candidate.sessionKey);
			db.prepare(`UPDATE session_transcripts SET ${assignments.join(", ")} WHERE agent_id = ? AND session_key = ?`).run(
				...values,
			);
			continue;
		}

		const values: unknown[] = [
			candidate.sessionKey,
			candidate.content,
			job.harness ?? null,
			job.project ?? null,
			agentId,
			candidate.createdAt,
		];
		if (hasUpdated) values.push(candidate.createdAt);
		if (hasCompleted) values.push(candidate.completedAt);
		if (hasHash) values.push(hashTranscript(candidate.content));
		insert.run(...values);
	}
}

/**
 * Migration 117: retire the summary-worker delivery boundary (#1271).
 *
 * Session transcripts now carry their own completion marker and content hash.
 * Existing session-end summary jobs backfill the completion marker and any
 * missing canonical transcript row before the obsolete queue is drained. The
 * historical table remains for migration compatibility.
 */
export function up(db: MigrationDb): void {
	if (!hasTable(db, "session_transcripts")) return;

	addColumnIfMissing(db, "session_transcripts", "completed_at", "TEXT");
	addColumnIfMissing(db, "session_transcripts", "content_hash", "TEXT");
	backfillTranscriptHashes(db);

	if (hasTable(db, "transcript_capture_jobs")) {
		const captureColumns = db.prepare("PRAGMA table_info(transcript_capture_jobs)").all() as ReadonlyArray<
			Record<string, unknown>
		>;
		if (captureColumns.some((row) => row.name === "summary_status")) {
			db.exec(
				"UPDATE transcript_capture_jobs SET summary_status = 'not_requested' WHERE summary_status IN ('pending', 'failed', 'skipped')",
			);
		}
	}

	if (hasTable(db, "summary_jobs")) {
		backfillTranscriptsFromSummaryJobs(db);
		backfillTranscriptHashes(db);
		const summaryColumns = tableColumns(db, "summary_jobs");
		const timestampParts = ["completed_at", "ended_at", "captured_at", "created_at"]
			.filter((column) => summaryColumns.has(column))
			.map((column) => `sj.${column}`);
		const timestampValue = timestampParts.length === 1 ? timestampParts[0] : `COALESCE(${timestampParts.join(", ")})`;
		const completionTimestamp = timestampValue ? `MAX(${timestampValue})` : "NULL";
		const boundaryParts = [
			summaryColumns.has("trigger") ? "sj.trigger = 'session_end'" : null,
			summaryColumns.has("boundary_reason")
				? "sj.boundary_reason IN ('session_closed', 'session_clear', 'stale_session', 'ttl_expired')"
				: null,
		].filter((part): part is string => part !== null);
		const boundaryPredicate = boundaryParts.length > 0 ? `(${boundaryParts.join(" OR ")})` : "1=1";
		const agentPredicate = summaryColumns.has("agent_id")
			? "sj.agent_id = session_transcripts.agent_id"
			: "session_transcripts.agent_id = 'default'";
		if (completionTimestamp !== "NULL") {
			db.exec(`
				UPDATE session_transcripts
				SET completed_at = COALESCE(
					completed_at,
					(
						SELECT ${completionTimestamp}
						FROM summary_jobs AS sj
						WHERE ${agentPredicate}
						  AND sj.session_key = session_transcripts.session_key
						  AND ${boundaryPredicate}
					)
				)
				WHERE completed_at IS NULL;
			`);
		}
		db.exec("DELETE FROM summary_jobs");
	}

	const completionIndexColumns = ["agent_id", "completed_at"];
	if (tableColumns(db, "session_transcripts").has("updated_at")) completionIndexColumns.push("updated_at");
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_st_agent_completed
			ON session_transcripts(${completionIndexColumns.join(", ")});
		CREATE INDEX IF NOT EXISTS idx_st_agent_hash
			ON session_transcripts(agent_id, content_hash);
	`);
}
