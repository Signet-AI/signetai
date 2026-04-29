import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractAnchorTerms } from "./anchor-terms";
import { getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { sanitizeFtsQuery } from "./memory-search";
import {
	type TranscriptIdentity,
	type TranscriptSessionKeyClassification,
	appendCanonicalTranscriptSnapshotIfMissing,
	canonicalTranscriptPath,
	readCanonicalTranscriptSessionKeys,
	rewriteReplacingLiveOnlySessions,
	sanitizeHarnessPath,
	sessionSeqCacheKey,
} from "./transcript-jsonl";

interface TranscriptRow {
	readonly session_key: string;
	readonly project: string | null;
	readonly seen_at: string;
	readonly excerpt?: string | null;
	readonly content?: string;
	readonly rank?: number | null;
}

interface StoredTranscriptBackfillRow {
	readonly session_key: string;
	readonly content: string;
	readonly harness: string | null;
	readonly project: string | null;
	readonly agent_id: string | null;
	readonly created_at: string | null;
	readonly updated_at?: string | null;
}

const canonicalBackfills = new Set<string>();

export interface TranscriptHit {
	readonly sessionKey: string;
	readonly project: string | null;
	readonly updatedAt: string;
	readonly excerpt: string;
	readonly rank: number;
}

interface BackfillSeen {
	readonly classification: TranscriptSessionKeyClassification;
}

function createBackfillSeenReader(basePath: string, agentId?: string): (harness: string) => Promise<BackfillSeen> {
	const seen = new Map<string, Promise<BackfillSeen>>();
	return (harness: string) => {
		const key = sanitizeHarnessPath(harness);
		const existing = seen.get(key);
		if (existing) return existing;
		const loaded = readCanonicalTranscriptSessionKeys({ basePath, harness, agentId }).then((classification) => ({
			classification,
		}));
		seen.set(key, loaded);
		return loaded;
	};
}

function knownBackfillKeys(classification: TranscriptSessionKeyClassification): Set<string> {
	return new Set([...classification.canonicalKeys, ...classification.liveOnlyKeys]);
}

function markBackfillCanonical(classification: TranscriptSessionKeyClassification, key: string): void {
	classification.liveOnlyKeys.delete(key);
	classification.canonicalKeys.add(key);
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

function parseArtifactFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } | null {
	const text = content.replace(/\r\n?/g, "\n");
	if (!text.startsWith("---\n")) return null;
	const end = text.indexOf("\n---\n", 4);
	if (end === -1) return null;
	const frontmatter: Record<string, string> = {};
	for (const line of text.slice(4, end).split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const raw = line.slice(idx + 1).trim();
		if (raw === "null") continue;
		if (raw.startsWith('"')) {
			try {
				const parsed = JSON.parse(raw);
				if (typeof parsed === "string") frontmatter[key] = parsed;
				continue;
			} catch {
				frontmatter[key] = raw.slice(1, -1);
				continue;
			}
		}
		if (raw.length > 0) frontmatter[key] = raw;
	}
	return { frontmatter, body: text.slice(end + 5) };
}

async function backfillMarkdownTranscriptArtifacts(
	basePath: string,
	agentId: string | undefined,
	getSeen: (harness: string) => Promise<BackfillSeen>,
): Promise<number> {
	const memoryDir = join(basePath, "memory");
	if (!existsSync(memoryDir)) return 0;
	let failures = 0;
	const liveOnlyReplacements = new Map<
		string,
		Map<string, { readonly identity: TranscriptIdentity; readonly transcript: string }>
	>();
	const files = readdirSync(memoryDir).filter((name) => name.endsWith("--transcript.md"));
	for (const [i, name] of files.entries()) {
		const path = join(memoryDir, name);
		try {
			const parsed = parseArtifactFrontmatter(readFileSync(path, "utf8"));
			if (!parsed || parsed.frontmatter.kind !== "transcript") continue;
			const rowAgentId = parsed.frontmatter.agent_id || "default";
			if (agentId && rowAgentId !== agentId) continue;
			const harness = parsed.frontmatter.harness || "unknown";
			const input = {
				basePath,
				agentId: rowAgentId,
				harness,
				sessionKey: parsed.frontmatter.session_key || null,
				sessionId: parsed.frontmatter.session_id || null,
				project: parsed.frontmatter.project || null,
				capturedAt: parsed.frontmatter.captured_at || new Date().toISOString(),
				sourceFormat: "markdown" as const,
				sourcePath: `memory/${name}`,
				transcript: parsed.body,
			};
			const { classification } = await getSeen(harness);
			const key = sessionSeqCacheKey(input);
			if (classification.liveOnlyKeys.has(key)) {
				const replacements =
					liveOnlyReplacements.get(harness) ||
					new Map<string, { readonly identity: TranscriptIdentity; readonly transcript: string }>();
				replacements.set(key, {
					identity: {
						agentId: input.agentId,
						harness: input.harness,
						sessionKey: input.sessionKey,
						sessionId: input.sessionId,
						sourceFormat: "markdown",
					},
					transcript: input.transcript,
				});
				liveOnlyReplacements.set(harness, replacements);
				continue;
			}
			if (await appendCanonicalTranscriptSnapshotIfMissing(input, knownBackfillKeys(classification))) {
				markBackfillCanonical(classification, key);
			}
		} catch (error) {
			failures++;
			logger.warn("transcripts", "Markdown transcript backfill failed", {
				error: error instanceof Error ? error.message : String(error),
				path,
			});
		}
		if (i > 0 && i % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
	}
	for (const [harness, replacements] of liveOnlyReplacements.entries()) {
		if (replacements.size === 0) continue;
		const jsonlPath = canonicalTranscriptPath(basePath, harness);
		try {
			await rewriteReplacingLiveOnlySessions(jsonlPath, replacements);
			const { classification } = await getSeen(harness);
			for (const key of replacements.keys()) {
				markBackfillCanonical(classification, key);
			}
		} catch (error) {
			failures++;
			logger.warn("transcripts", "Markdown transcript backfill rewrite failed", {
				error: error instanceof Error ? error.message : String(error),
				harness,
				path: jsonlPath,
			});
		}
	}
	return failures;
}

async function backfillDatabaseTranscripts(
	basePath: string,
	agentId: string | undefined,
	getSeen: (harness: string) => Promise<BackfillSeen>,
): Promise<boolean> {
	if (!tableExists("session_transcripts")) return true;
	const PAGE_SIZE = 100;
	const liveOnlyReplacements = new Map<
		string,
		Map<string, { readonly identity: TranscriptIdentity; readonly transcript: string }>
	>();
	try {
		let offset = 0;
		while (true) {
			const rows = getDbAccessor().withReadDb((db) => {
				const cols = db.prepare("PRAGMA table_info(session_transcripts)").all() as ReadonlyArray<
					Record<string, unknown>
				>;
				const hasUpdated = cols.some((col) => col.name === "updated_at");
				const sql = hasUpdated
					? `SELECT session_key, content, harness, project, agent_id, created_at, updated_at
						FROM session_transcripts
						ORDER BY agent_id, harness, session_key, rowid
						LIMIT ? OFFSET ?`
					: `SELECT session_key, content, harness, project, agent_id, created_at, NULL AS updated_at
						FROM session_transcripts
						ORDER BY agent_id, harness, session_key, rowid
						LIMIT ? OFFSET ?`;
				return db.prepare(sql).all(PAGE_SIZE, offset) as StoredTranscriptBackfillRow[];
			});
			if (rows.length === 0) break;
			for (const row of rows) {
				const rowAgentId = row.agent_id?.trim() || "default";
				if (agentId && rowAgentId !== agentId) continue;
				const harness = row.harness?.trim() || "unknown";
				const input = {
					basePath,
					agentId: rowAgentId,
					harness,
					sessionKey: row.session_key,
					project: row.project,
					capturedAt: row.updated_at || row.created_at || new Date().toISOString(),
					sourceFormat: "db" as const,
					transcript: row.content,
				};
				const { classification } = await getSeen(harness);
				const key = sessionSeqCacheKey(input);
				if (classification.liveOnlyKeys.has(key)) {
					const replacements =
						liveOnlyReplacements.get(harness) ||
						new Map<string, { readonly identity: TranscriptIdentity; readonly transcript: string }>();
					replacements.set(key, {
						identity: {
							agentId: input.agentId,
							harness: input.harness,
							sessionKey: input.sessionKey,
							sourceFormat: "db",
						},
						transcript: input.transcript,
					});
					liveOnlyReplacements.set(harness, replacements);
					continue;
				}
				if (await appendCanonicalTranscriptSnapshotIfMissing(input, knownBackfillKeys(classification))) {
					markBackfillCanonical(classification, key);
				}
			}
			offset += PAGE_SIZE;
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		for (const [harness, replacements] of liveOnlyReplacements.entries()) {
			if (replacements.size === 0) continue;
			const jsonlPath = canonicalTranscriptPath(basePath, harness);
			await rewriteReplacingLiveOnlySessions(jsonlPath, replacements);
			const { classification } = await getSeen(harness);
			for (const key of replacements.keys()) {
				markBackfillCanonical(classification, key);
			}
		}
	} catch (error) {
		logger.warn("transcripts", "Database transcript backfill failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
	return true;
}

const BACKFILL_MARKER = ".canonical-transcript-backfill-v1";

function markerScope(agentId?: string): string {
	return (agentId?.trim() || "all").replace(/[^a-zA-Z0-9._-]+/g, "-") || "default";
}

function getMarkerPath(basePath: string, agentId?: string): string {
	return join(basePath, "memory", `${BACKFILL_MARKER}.${markerScope(agentId)}`);
}

function markerMatches(path: string, agentId?: string): boolean {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { readonly agent_id?: unknown };
		return parsed.agent_id === (agentId?.trim() || "*");
	} catch (error) {
		logger.warn("transcripts", "Ignoring invalid transcript backfill marker", {
			error: error instanceof Error ? error.message : String(error),
			path,
		});
		return false;
	}
}

export async function ensureCanonicalTranscriptHistory(basePath: string, agentId?: string): Promise<void> {
	const key = `${basePath}:${agentId ?? "*"}`;
	if (canonicalBackfills.has(key)) return;

	const markerPath = getMarkerPath(basePath, agentId);
	if (existsSync(markerPath) && markerMatches(markerPath, agentId)) {
		canonicalBackfills.add(key);
		return;
	}

	const getSeen = createBackfillSeenReader(basePath, agentId);
	const failures = await backfillMarkdownTranscriptArtifacts(basePath, agentId, getSeen);
	const databaseOk = await backfillDatabaseTranscripts(basePath, agentId, getSeen);
	if (failures > 0 || !databaseOk) {
		logger.warn("transcripts", "Canonical transcript backfill incomplete; will retry on next write", {
			agentId: agentId ?? "*",
			basePath,
			markdownFailures: failures,
			databaseOk,
		});
		return;
	}

	if (!writeMarker(markerPath, agentId)) return;
	canonicalBackfills.add(key);
}

function writeMarker(markerPath: string, agentId?: string): boolean {
	try {
		mkdirSync(dirname(markerPath), { recursive: true });
		writeFileSync(
			markerPath,
			JSON.stringify({ completed_at: new Date().toISOString(), agent_id: agentId ?? "*" }),
			"utf8",
		);
		return true;
	} catch (error) {
		logger.warn("transcripts", "Failed to write backfill marker", {
			error: error instanceof Error ? error.message : String(error),
		});
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
	readonly allowScanFallback?: boolean;
}): TranscriptHit[] {
	const limit = Math.max(1, Math.min(8, Math.trunc(params.limit)));
	if (!tableExists("session_transcripts")) return [];

	const seenExpr = hasUpdatedAt() ? "COALESCE(st.updated_at, st.created_at)" : "st.created_at";
	const sameProject = (project: string | null): number =>
		params.project && project && params.project === project ? 0 : 1;

	try {
		if (tableExists("session_transcripts_fts")) {
			const anchors = extractAnchorTerms(params.query)
				.map((term) => term.replace(/[_:/.-]+/g, " "))
				.join(" ");
			const ftsQueries = [...new Set([sanitizeFtsQuery(params.query), sanitizeFtsQuery(anchors)].filter(Boolean))];
			for (const fts of ftsQueries) {
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
					logger.warn(
						"transcripts",
						params.allowScanFallback === false
							? "Transcript FTS query failed, skipping scan fallback"
							: "Transcript FTS query failed, falling back to LIKE",
						{
							error: error instanceof Error ? error.message : String(error),
						},
					);
				}
			}
		}

		if (params.allowScanFallback === false) return [];

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
