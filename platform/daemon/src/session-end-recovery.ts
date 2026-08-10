import { createHash, randomUUID } from "node:crypto";
import { type ReadDb, type WriteDb, getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { markSessionTranscriptCompletedInTx } from "./session-transcripts";

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
	const columns = tableColumns(db, "session_transcripts");
	const incompletePredicate = columns.has("completed_at") ? " AND completed_at IS NULL" : "";
	const direct = db
		.prepare(
			`SELECT content FROM session_transcripts WHERE session_key = ? AND agent_id = ?${incompletePredicate} LIMIT 1`,
		)
		.get(sessionKey, agentId) as { content: string } | undefined;
	if (direct?.content.trim()) return { sessionKey, transcript: direct.content };

	const timestampExpr = columns.has("updated_at") ? "COALESCE(updated_at, created_at)" : "created_at";
	const row = db
		.prepare(
			`SELECT session_key, content
			 FROM session_transcripts
			 WHERE agent_id = ?
			   AND (? = '' OR harness = ?)
			   AND (? = '' OR project = ?)
			   ${incompletePredicate}
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
	completedAt: string,
): string | undefined {
	const sessionKey = req.sessionKey?.trim();
	if (!sessionKey) return undefined;

	try {
		// Keep target selection and completion in one write transaction so
		// parallel clear hooks cannot race a transcript back into the live set.
		const result = getDbAccessor().withWriteTx((db) => {
			const target = getClearRecoveryTranscriptTarget(db, req, sessionKey, agentId);
			if (!target) return { skipped: "no-stored-transcript" as const };
			const completed = markSessionTranscriptCompletedInTx(db, target.sessionKey, agentId, completedAt);
			if (!completed) {
				return { skipped: "already-completed" as const, recoveredSessionKey: target.sessionKey };
			}
			return { recoveredSessionKey: target.sessionKey, transcriptChars: target.transcript.length };
		});

		if ("transcriptChars" in result) {
			logger.info("hooks", "Recovered missing session-end completion from clear session-start", {
				harness: req.harness,
				project: req.project,
				sessionKey: result.recoveredSessionKey,
				clearSessionKey: sessionKey,
				agentId,
				transcriptChars: result.transcriptChars,
			});
			return result.recoveredSessionKey;
		}

		logger.debug("hooks", "Clear session-start completion recovery skipped", {
			harness: req.harness,
			project: req.project,
			sessionKey,
			agentId,
			reason: result.skipped,
		});
		return undefined;
	} catch (error) {
		logger.warn("hooks", "Clear session-start completion recovery failed", {
			error: error instanceof Error ? error.message : String(error),
			harness: req.harness,
			project: req.project,
			sessionKey,
		});
		return undefined;
	}
}
