import { extractAnchorTerms } from "./anchor-terms";
import { getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { sanitizeFtsQuery } from "./memory-search";

interface TranscriptRow {
	readonly session_key: string;
	readonly project: string | null;
	readonly seen_at: string;
	readonly excerpt?: string | null;
	readonly content?: string;
	readonly rank?: number | null;
}

export interface TranscriptHit {
	readonly sessionKey: string;
	readonly project: string | null;
	readonly updatedAt: string;
	readonly excerpt: string;
	readonly rank: number;
}

function tableExists(name: string): boolean {
	try {
		return getDbAccessor().withReadDb((db) => {
			const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
			return row !== undefined;
		});
	} catch {
		return false;
	}
}

function hasUpdatedAt(): boolean {
	try {
		return getDbAccessor().withReadDb((db) => {
			const cols = db.prepare("PRAGMA table_info(session_transcripts)").all() as ReadonlyArray<Record<string, unknown>>;
			return cols.some((col) => col.name === "updated_at");
		});
	} catch {
		return false;
	}
}

function cleanExcerpt(text: string): string {
	return text
		.replace(/^(?:Human|User|Assistant):\s*/gim, "")
		.replace(/\s+/g, " ")
		.trim();
}

function buildExcerpt(content: string, query: string): string {
	const base = cleanExcerpt(content);
	if (base.length <= 220) return base;

	const terms = query
		.toLowerCase()
		.split(/\W+/)
		.filter((term) => term.length >= 3)
		.slice(0, 8);
	const lower = base.toLowerCase();

	for (const term of terms) {
		const idx = lower.indexOf(term);
		if (idx === -1) continue;
		const start = Math.max(0, idx - 90);
		const end = Math.min(base.length, idx + 130);
		const prefix = start > 0 ? "..." : "";
		const suffix = end < base.length ? "..." : "";
		return `${prefix}${base.slice(start, end).trim()}${suffix}`;
	}

	return `${base.slice(0, 217).trim()}...`;
}

export function upsertSessionTranscript(
	sessionKey: string,
	transcript: string,
	harness: string,
	project: string | null,
	agentId: string,
): void {
	if (sessionKey.trim().length === 0 || transcript.trim().length === 0) return;

	try {
		getDbAccessor().withWriteTx((db) => {
			const row = db
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_transcripts'`)
				.get();
			if (!row) return;

			const now = new Date().toISOString();
			const cols = db.prepare("PRAGMA table_info(session_transcripts)").all() as ReadonlyArray<Record<string, unknown>>;
			const hasUpdated = cols.some((col) => col.name === "updated_at");
			if (hasUpdated) {
				db.prepare(
					`INSERT INTO session_transcripts (
						session_key, content, harness, project, agent_id, created_at, updated_at
					)
					VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(agent_id, session_key) DO UPDATE SET
						content = excluded.content,
						harness = excluded.harness,
						project = excluded.project,
						agent_id = excluded.agent_id,
						updated_at = excluded.updated_at`,
				).run(sessionKey, transcript, harness, project, agentId, now, now);
				return;
			}

			db.prepare(
				`INSERT INTO session_transcripts (session_key, content, harness, project, agent_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(agent_id, session_key) DO UPDATE SET
				   content = excluded.content,
				   harness = excluded.harness,
				   project = excluded.project,
				   agent_id = excluded.agent_id`,
			).run(sessionKey, transcript, harness, project, agentId, now);
		});
	} catch (error) {
		logger.warn("transcripts", "Transcript upsert failed", {
			error: error instanceof Error ? error.message : String(error),
			sessionKey,
		});
	}
}

/** Read the stored transcript content for a session. */
export function getSessionTranscriptContent(sessionKey: string, agentId: string): string | undefined {
	if (!tableExists("session_transcripts")) return undefined;
	try {
		return getDbAccessor().withReadDb((db) => {
			const row = db
				.prepare("SELECT content FROM session_transcripts WHERE session_key = ? AND agent_id = ?")
				.get(sessionKey, agentId) as { content: string } | undefined;
			return row?.content;
		});
	} catch {
		return undefined;
	}
}

export function searchTranscriptFallback(params: {
	readonly query: string;
	readonly agentId: string;
	readonly sessionKey?: string;
	readonly project?: string;
	readonly limit: number;
}): TranscriptHit[] {
	const limit = Math.max(1, Math.min(8, Math.trunc(params.limit)));
	if (!tableExists("session_transcripts")) return [];

	const seenExpr = hasUpdatedAt() ? "COALESCE(st.updated_at, st.created_at)" : "st.created_at";
	const sameProject = (project: string | null): number =>
		params.project && project && params.project === project ? 0 : 1;

	try {
		if (tableExists("session_transcripts_fts")) {
			const fts = sanitizeFtsQuery(params.query);
			if (fts.length > 0) {
				try {
					const rows = getDbAccessor().withReadDb((db) => {
						const parts = [
							`SELECT st.session_key, st.project, ${seenExpr} AS seen_at,`,
							`snippet(session_transcripts_fts, 0, '', '', ' … ', 18) AS excerpt,`,
							"bm25(session_transcripts_fts) AS rank",
							"FROM session_transcripts_fts",
							"JOIN session_transcripts st ON st.rowid = session_transcripts_fts.rowid",
							"WHERE session_transcripts_fts MATCH ?",
							"AND st.agent_id = ?",
						];
						const args: unknown[] = [fts, params.agentId];
						if (params.sessionKey) {
							parts.push("AND st.session_key != ?");
							args.push(params.sessionKey);
						}
						parts.push(`ORDER BY rank ASC, ${seenExpr} DESC LIMIT ?`);
						args.push(limit * 2);
						return db.prepare(parts.join("\n")).all(...args) as TranscriptRow[];
					});

					const hits = rows
						.map((row) => ({
							sessionKey: row.session_key,
							project: row.project,
							updatedAt: row.seen_at,
							excerpt: buildExcerpt(typeof row.excerpt === "string" ? row.excerpt : "", params.query),
							rank: typeof row.rank === "number" ? row.rank : 0,
						}))
						.filter((row) => row.excerpt.length > 0)
						.sort((a, b) => sameProject(a.project) - sameProject(b.project) || a.rank - b.rank)
						.slice(0, limit);
					if (hits.length > 0) return hits;
				} catch (error) {
					logger.warn("transcripts", "Transcript FTS query failed, falling back to LIKE", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}

		const words = params.query
			.toLowerCase()
			.split(/\W+/)
			.filter((term) => term.length >= 3)
			.slice(0, 5);
		const anchors = extractAnchorTerms(params.query).slice(0, 5);
		const terms = anchors.length > 0 ? anchors : words;
		if (terms.length === 0) return [];

		const rows = getDbAccessor().withReadDb((db) => {
			const score = terms.map(() => "CASE WHEN LOWER(st.content) LIKE ? THEN 1 ELSE 0 END").join(" + ");
			const any = terms.map(() => "LOWER(st.content) LIKE ?").join(" OR ");
			const parts = [
				`SELECT st.session_key, st.project, ${seenExpr} AS seen_at, st.content, ${score} AS rank`,
				"FROM session_transcripts st",
				"WHERE st.agent_id = ?",
			];
			const args: unknown[] = [];
			for (const term of terms) {
				args.push(`%${term}%`);
			}
			args.push(params.agentId);
			if (params.sessionKey) {
				parts.push("AND st.session_key != ?");
				args.push(params.sessionKey);
			}
			parts.push(`AND (${any})`);
			for (const term of terms) {
				args.push(`%${term}%`);
			}
			parts.push(`ORDER BY rank DESC, ${seenExpr} DESC LIMIT ?`);
			args.push(limit);
			return db.prepare(parts.join("\n")).all(...args) as TranscriptRow[];
		});

		return rows
			.map((row) => ({
				sessionKey: row.session_key,
				project: row.project,
				updatedAt: row.seen_at,
				excerpt: buildExcerpt(typeof row.content === "string" ? row.content : "", params.query),
				rank: typeof row.rank === "number" ? row.rank : 0,
			}))
			.filter((row) => row.excerpt.length > 0)
			.sort((a, b) => sameProject(a.project) - sameProject(b.project) || b.rank - a.rank)
			.slice(0, limit);
	} catch (error) {
		logger.warn("transcripts", "Transcript fallback search failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}
