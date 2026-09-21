import { type ReadDb, type WriteDb, getDbAccessor } from "./db-accessor";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
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
function canonicalTranscriptPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export function deriveSessionEndFallbackId(
	sessionKey: string | undefined,
	transcriptPath: string | undefined,
	transcript: string,
): string {
	const scopedKey = sessionKey?.trim() || "anonymous";
	const path = transcriptPath?.trim();
	// The source generation belongs to capture admission, not artifact identity.
	// Keeping this key stable lets a newer source generation replace the one
	// transcript artifact instead of appending a new artifact for every turn.
	if (path) return `session-end:path:${canonicalTranscriptPath(path)}`;
	if (sessionKey?.trim()) return `session-end:${scopedKey}`;
	return `session-end:anonymous:${transcript.trim().length > 0 ? "inline" : "empty"}`;
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

export async function recoverMissingSessionEndOnClearStart(
	req: ClearSessionStartRequest,
	agentId: string,
	completedAt: string,
): Promise<string | undefined> {
	const sessionKey = req.sessionKey?.trim();
	if (!sessionKey) return undefined;

	try {
		const result = await getDbAccessor().withWriteTxAsync(
			(db) => {
				const target = getClearRecoveryTranscriptTarget(db, req, sessionKey, agentId);
				if (!target) return { skipped: "no-stored-transcript" as const };
				const completed = markSessionTranscriptCompletedInTx(db, target.sessionKey, agentId, completedAt);
				if (!completed) {
					return { skipped: "already-completed" as const, recoveredSessionKey: target.sessionKey };
				}
				return { recoveredSessionKey: target.sessionKey, transcriptChars: target.transcript.length };
			},
			{ siteToken: "db:session-end.recovery.clear", operation: "session-end.clear-recovery" },
		);

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
