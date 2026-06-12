import { createHash, randomUUID } from "node:crypto";
import { type ReadDb, type WriteDb, getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import type { ResolvedMemoryConfig } from "./memory-config";
import { isNoiseSession } from "./session-noise";

export interface ClearSessionStartRequest {
	readonly harness: string;
	readonly project?: string;
	readonly sessionKey?: string;
}

// Session keys can be shared across distinct harness runs (for example
// recurring heartbeat sessions), so artifact lineage needs a more specific
// fallback identifier when the harness does not supply sessionId.
export function deriveSessionEndFallbackId(
	sessionKey: string | undefined,
	transcriptPath: string | undefined,
	transcript: string,
): string {
	const scopedKey = sessionKey?.trim() || "anonymous";
	const path = transcriptPath?.trim();
	const body = transcript.trim();
	if (path) {
		// Include a content digest so rotating log files that reuse the same
		// path across distinct sessions produce different IDs.
		// Note: sessions with identical path AND identical content will
		// intentionally deduplicate — writeImmutableArtifact returns the
		// existing artifact path when the content hash matches, so this is
		// a graceful no-op rather than an error.
		if (body.length > 0) {
			const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
			return `session-end:path:${path}:${digest}`;
		}
		// Intentionally non-idempotent: without transcript content there is no
		// stable material to hash, so each call produces a unique ID.  This
		// prevents two empty-body session-end calls from colliding but means
		// retries will create distinct artifacts rather than deduplicating.
		return `session-end:path:${path}:${randomUUID()}`;
	}
	if (body.length > 0) {
		const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
		return `session-end:${scopedKey}:${digest}`;
	}
	// See comment above: non-idempotent for the same reason.
	return `session-end:${scopedKey}:${randomUUID()}`;
}

function tableColumns(db: ReadDb | WriteDb, table: string): Set<string> {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
	return new Set(
		rows.map((row) => (typeof row.name === "string" ? row.name : "")).filter((name): name is string => name.length > 0),
	);
}

function summaryJobExistsForRecoveredSession(
	db: ReadDb | WriteDb,
	sessionKey: string,
	sessionId: string,
	agentId: string,
): boolean {
	const columns = tableColumns(db, "summary_jobs");
	if (columns.has("session_id")) {
		const agentClause = columns.has("agent_id") ? " AND agent_id = ?" : "";
		const args = columns.has("agent_id") ? [sessionId, agentId] : [sessionId];
		const row = db
			.prepare(`SELECT id FROM summary_jobs WHERE session_id = ?${agentClause} AND status <> 'dead' LIMIT 1`)
			.get(...args);
		return row != null;
	}
	const row = db
		.prepare("SELECT id FROM summary_jobs WHERE session_key = ? AND status <> 'dead' LIMIT 1")
		.get(sessionKey);
	return row != null;
}

function clearStoredSessionTranscript(db: WriteDb, sessionKey: string, agentId: string): void {
	db.prepare("DELETE FROM session_transcripts WHERE session_key = ? AND agent_id = ?").run(sessionKey, agentId);
}

function getClearRecoveryTranscriptTarget(
	db: ReadDb | WriteDb,
	req: ClearSessionStartRequest,
	sessionKey: string,
	agentId: string,
):
	| {
			readonly sessionKey: string;
			readonly transcript: string;
	  }
	| undefined {
	const direct = db
		.prepare("SELECT content FROM session_transcripts WHERE session_key = ? AND agent_id = ? LIMIT 1")
		.get(sessionKey, agentId) as { content: string } | undefined;
	if (direct?.content.trim()) return { sessionKey, transcript: direct.content };

	const columns = tableColumns(db, "session_transcripts");
	const timestampExpr = columns.has("updated_at") ? "COALESCE(updated_at, created_at)" : "created_at";
	const row = db
		.prepare(
			`SELECT session_key, content
			 FROM session_transcripts
			 WHERE agent_id = ?
			   AND (? = '' OR harness = ?)
			   AND (? = '' OR project = ?)
			 ORDER BY ${timestampExpr} DESC
			 LIMIT 1`,
		)
		.get(agentId, req.harness, req.harness, req.project ?? "", req.project ?? "") as
		| { session_key: string; content: string }
		| undefined;
	if (!row || row.content.trim().length === 0) return undefined;
	return { sessionKey: row.session_key, transcript: row.content };
}

export function recoverMissingSessionEndOnClearStart(
	req: ClearSessionStartRequest,
	agentId: string,
	memoryCfg: ResolvedMemoryConfig,
	startedAt: string,
): string | undefined {
	const sessionKey = req.sessionKey?.trim();
	if (!sessionKey) return undefined;

	// TS memory config has a separate dreaming summary path; the Rust manifest
	// config currently exposes only pipelineV2, so Rust follows that runtime gate.
	const pipelineEnabled = memoryCfg.pipelineV2.enabled || memoryCfg.pipelineV2.shadowMode || memoryCfg.dreaming.enabled;

	try {
		// Keep target selection, duplicate detection, enqueue, and cleanup in one
		// write transaction so parallel clear hooks cannot double-enqueue.
		const result = getDbAccessor().withWriteTx((db) => {
			const target = getClearRecoveryTranscriptTarget(db, req, sessionKey, agentId);
			if (!target) return { skipped: "no-stored-transcript" as const };

			const transcript = target.transcript;
			const recoveredSessionKey = target.sessionKey;
			const sessionId = deriveSessionEndFallbackId(recoveredSessionKey, undefined, transcript);
			const noiseSession = isNoiseSession({
				project: req.project ?? null,
				sessionKey: recoveredSessionKey,
				sessionId,
				harness: req.harness,
			});
			const skipReason = !pipelineEnabled
				? "pipeline-disabled"
				: transcript.length < 500
					? "transcript-too-short"
					: noiseSession
						? "noise-session"
						: null;
			if (skipReason) {
				clearStoredSessionTranscript(db, recoveredSessionKey, agentId);
				return { skipped: skipReason, recoveredSessionKey, transcriptChars: transcript.length };
			}

			if (summaryJobExistsForRecoveredSession(db, recoveredSessionKey, sessionId, agentId)) {
				clearStoredSessionTranscript(db, recoveredSessionKey, agentId);
				return { skipped: "duplicate-job" as const, recoveredSessionKey, transcriptChars: transcript.length };
			}

			const jobId = randomUUID();
			const columns = tableColumns(db, "summary_jobs");
			if (columns.has("session_id")) {
				db.prepare(
					`INSERT INTO summary_jobs
					 (id, session_key, session_id, harness, project, agent_id, transcript,
					  trigger, captured_at, started_at, ended_at, status, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
				).run(
					jobId,
					recoveredSessionKey,
					sessionId,
					req.harness,
					req.project ?? null,
					agentId,
					transcript,
					"session_end",
					startedAt,
					null,
					startedAt,
					startedAt,
				);
			} else {
				db.prepare(
					`INSERT INTO summary_jobs
					 (id, session_key, harness, project, transcript, status, created_at)
					 VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
				).run(jobId, recoveredSessionKey, req.harness, req.project ?? null, transcript, startedAt);
			}
			clearStoredSessionTranscript(db, recoveredSessionKey, agentId);
			return { jobId, recoveredSessionKey, transcriptChars: transcript.length };
		});

		if ("jobId" in result) {
			logger.info("summary-worker", "Enqueued session summary job", {
				jobId: result.jobId,
				harness: req.harness,
				sessionKey: result.recoveredSessionKey,
				project: req.project,
				transcriptChars: result.transcriptChars,
			});
			logger.info("hooks", "Recovered missing session-end summary from clear session-start", {
				harness: req.harness,
				project: req.project,
				sessionKey: result.recoveredSessionKey,
				clearSessionKey: sessionKey,
				agentId,
				jobId: result.jobId,
				transcriptChars: result.transcriptChars,
			});
			return result.jobId;
		}

		if (result.skipped !== "no-stored-transcript" && result.skipped !== "duplicate-job") {
			logger.info("hooks", "Skipped reset summary recovery", {
				harness: req.harness,
				project: req.project,
				sessionKey: result.recoveredSessionKey,
				agentId,
				reason: result.skipped,
				transcriptChars: result.transcriptChars,
			});
		} else if (result.skipped === "no-stored-transcript") {
			logger.debug("hooks", "Skipped reset summary recovery", {
				harness: req.harness,
				project: req.project,
				sessionKey,
				agentId,
				reason: result.skipped,
			});
		}
		return undefined;
	} catch (error) {
		logger.warn("hooks", "Reset summary recovery failed", {
			error: error instanceof Error ? error.message : String(error),
			harness: req.harness,
			project: req.project,
			sessionKey,
		});
		return undefined;
	}
}
