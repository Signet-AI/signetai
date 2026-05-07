import type { ReadDb } from "./db-accessor";
import { sanitizeFtsQuery } from "./memory-search";
import { redactSecrets } from "./session-checkpoints";

export interface SubagentContextRequest {
	readonly harness: string;
	readonly project?: string;
	readonly sessionKey?: string;
	readonly agentId: string;
	readonly harnessAgentId?: string;
	readonly parentSessionKey?: string;
	readonly parentKey?: string;
	readonly parentId?: string;
	readonly parentID?: string;
}

export interface SubagentContextConfig {
	readonly inheritContext: boolean;
	readonly tailChars: number;
}

export interface ParentSessionRef {
	readonly sessionKey: string;
	readonly agentId: string;
	readonly source: "explicit" | "openclaw" | "claude-code";
}

export interface SessionSearchHit {
	readonly sessionKey: string;
	readonly project: string | null;
	readonly updatedAt: string;
	readonly excerpt: string;
	readonly rank: number;
}

function cleanString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function tableExists(db: ReadDb, name: string): boolean {
	const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
	return row !== undefined && row !== null;
}

function columnExists(db: ReadDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return rows.some((row) => row.name === column);
}

function timestampExpr(db: ReadDb, alias: string): string {
	return columnExists(db, "session_transcripts", "updated_at")
		? `COALESCE(${alias}.updated_at, ${alias}.created_at)`
		: `${alias}.created_at`;
}

export function parentSessionKeyFromOpenClaw(sessionKey: string | undefined): string | undefined {
	const parts = cleanString(sessionKey)?.split(":") ?? [];
	if (parts.length < 4) return undefined;
	if (parts[0] !== "agent" || !parts[1] || parts[2] !== "subagent") return undefined;
	return `agent:${parts[1]}:main`;
}

function explicitParentSessionKey(req: SubagentContextRequest): string | undefined {
	return (
		cleanString(req.parentSessionKey) ??
		cleanString(req.parentKey) ??
		cleanString(req.parentId) ??
		cleanString(req.parentID)
	);
}

export function resolveParentSession(db: ReadDb, req: SubagentContextRequest): ParentSessionRef | null {
	const current = cleanString(req.sessionKey);
	const explicit = explicitParentSessionKey(req);
	if (explicit && explicit !== current) {
		return { sessionKey: explicit, agentId: req.agentId, source: "explicit" };
	}

	const openclaw = parentSessionKeyFromOpenClaw(current);
	if (openclaw && openclaw !== current) {
		return { sessionKey: openclaw, agentId: req.agentId, source: "openclaw" };
	}

	if (req.harness !== "claude-code") return null;
	if (!cleanString(req.harnessAgentId) || !current || !cleanString(req.project)) return null;
	if (!tableExists(db, "session_transcripts")) return null;

	const seen = timestampExpr(db, "st");
	const row = db
		.prepare(
			`SELECT st.session_key
			 FROM session_transcripts st
			 WHERE st.agent_id = ?
			   AND st.harness = ?
			   AND st.project = ?
			   AND st.session_key != ?
			 ORDER BY ${seen} DESC, st.created_at DESC, st.rowid DESC
			 LIMIT 1`,
		)
		.get(req.agentId, req.harness, req.project, current) as { session_key: string } | undefined;

	return row?.session_key ? { sessionKey: row.session_key, agentId: req.agentId, source: "claude-code" } : null;
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.map(cleanString).filter((value): value is string => value !== undefined);
	} catch {
		return [];
	}
}

function latestCheckpoint(
	db: ReadDb,
	parent: ParentSessionRef,
): {
	readonly digest: string;
	readonly focal_entity_ids: string | null;
	readonly focal_entity_names: string | null;
} | null {
	if (!tableExists(db, "session_checkpoints")) return null;
	const hasAgentId = columnExists(db, "session_checkpoints", "agent_id");
	if (!hasAgentId && parent.agentId !== "default") return null;
	const where = hasAgentId ? "session_key = ? AND agent_id = ?" : "session_key = ?";
	const args = hasAgentId ? [parent.sessionKey, parent.agentId] : [parent.sessionKey];
	return (
		(db
			.prepare(
				`SELECT digest, focal_entity_ids, focal_entity_names
				 FROM session_checkpoints
				 WHERE ${where}
				 ORDER BY created_at DESC, rowid DESC
				 LIMIT 1`,
			)
			.get(...args) as
			| {
					readonly digest: string;
					readonly focal_entity_ids: string | null;
					readonly focal_entity_names: string | null;
			  }
			| undefined) ?? null
	);
}

function transcriptTail(db: ReadDb, parent: ParentSessionRef, tailChars: number): string {
	if (tailChars <= 0 || !tableExists(db, "session_transcripts")) return "";
	const row = db
		.prepare("SELECT content FROM session_transcripts WHERE agent_id = ? AND session_key = ? LIMIT 1")
		.get(parent.agentId, parent.sessionKey) as { readonly content: string } | undefined;
	const content = row?.content?.trim();
	if (!content) return "";
	return content.length <= tailChars ? content : content.slice(content.length - tailChars);
}

function activeConstraints(
	db: ReadDb,
	agentId: string,
	entityIds: readonly string[],
	entityNames: readonly string[],
): Array<{ readonly entityName: string; readonly content: string }> {
	if (entityIds.length === 0 && entityNames.length === 0) return [];
	if (!tableExists(db, "entities") || !tableExists(db, "entity_aspects") || !tableExists(db, "entity_attributes")) {
		return [];
	}

	const clauses: string[] = [];
	const args: unknown[] = [agentId];
	if (entityIds.length > 0) {
		clauses.push(`e.id IN (${entityIds.map(() => "?").join(", ")})`);
		args.push(...entityIds);
	}
	if (entityNames.length > 0) {
		const placeholders = entityNames.map(() => "?").join(", ");
		clauses.push(`(e.name IN (${placeholders}) OR e.canonical_name IN (${placeholders}))`);
		args.push(...entityNames, ...entityNames);
	}

	return db
		.prepare(
			`SELECT e.name AS entityName, ea.content
			 FROM entities e
			 JOIN entity_aspects asp ON asp.entity_id = e.id AND asp.agent_id = e.agent_id
			 JOIN entity_attributes ea ON ea.aspect_id = asp.id AND ea.agent_id = e.agent_id
			 WHERE e.agent_id = ?
			   AND (${clauses.join(" OR ")})
			   AND ea.kind = 'constraint'
			   AND COALESCE(ea.status, 'active') = 'active'
			 ORDER BY COALESCE(ea.importance, 0) DESC, ea.updated_at DESC
			 LIMIT 8`,
		)
		.all(...args) as Array<{ readonly entityName: string; readonly content: string }>;
}

export function assembleInheritedContextBlock(
	db: ReadDb,
	parent: ParentSessionRef,
	cfg: SubagentContextConfig,
): string | null {
	if (!cfg.inheritContext) return null;

	const checkpoint = latestCheckpoint(db, parent);
	const tail = redactSecrets(transcriptTail(db, parent, Math.max(0, Math.trunc(cfg.tailChars))).trim());
	if (!checkpoint && tail.length === 0) return null;

	const focalEntityIds = parseJsonStringArray(checkpoint?.focal_entity_ids);
	const focalEntityNames = parseJsonStringArray(checkpoint?.focal_entity_names);
	const constraints = activeConstraints(db, parent.agentId, focalEntityIds, focalEntityNames);
	const lines = ["\n## Inherited from Parent Session\n", `Parent session: ${parent.sessionKey}`];

	if (checkpoint?.digest) {
		lines.push("\nCheckpoint:");
		lines.push(redactSecrets(checkpoint.digest.trim()));
	}
	if (tail.length > 0) {
		lines.push("\nRecent context:");
		lines.push(tail);
	}
	if (focalEntityNames.length > 0) {
		lines.push(`\nFocal entities: ${focalEntityNames.join(", ")}`);
	}
	if (constraints.length > 0) {
		lines.push("\nActive constraints:");
		for (const row of constraints) {
			lines.push(`- ${row.entityName}: ${redactSecrets(row.content)}`);
		}
	}

	return lines.join("\n");
}

function cleanExcerpt(text: string): string {
	return text
		.replace(/^(?:Human|User|Assistant):\s*/gim, "")
		.replace(/\s+/g, " ")
		.trim();
}

function excerptFor(content: string, query: string, maxChars = 320): string {
	const clean = cleanExcerpt(content);
	if (clean.length <= maxChars) return clean;
	const terms = query
		.toLowerCase()
		.split(/\W+/)
		.filter((term) => term.length >= 3)
		.slice(0, 8);
	const lower = clean.toLowerCase();
	for (const term of terms) {
		const idx = lower.indexOf(term);
		if (idx === -1) continue;
		const start = Math.max(0, idx - Math.floor(maxChars * 0.35));
		const end = Math.min(clean.length, start + maxChars);
		return `${start > 0 ? "..." : ""}${clean.slice(start, end).trim()}${end < clean.length ? "..." : ""}`;
	}
	return `${clean.slice(0, maxChars - 3).trim()}...`;
}

export function searchSessionTranscripts(params: {
	readonly db: ReadDb;
	readonly query: string;
	readonly agentId: string;
	readonly sessionKey?: string;
	readonly currentSessionKey?: string;
	readonly project?: string;
	readonly limit: number;
}): SessionSearchHit[] {
	if (!tableExists(params.db, "session_transcripts")) return [];
	const query = params.query.trim();
	if (query.length === 0) return [];
	const limit = Math.max(1, Math.min(20, Math.trunc(params.limit)));
	const targetSessionKey = cleanString(params.sessionKey) ?? parentSessionKeyFromOpenClaw(params.currentSessionKey);
	const seen = timestampExpr(params.db, "st");

	if (tableExists(params.db, "session_transcripts_fts")) {
		const fts = sanitizeFtsQuery(query);
		if (fts.length > 0) {
			const parts = [
				`SELECT st.session_key, st.project, ${seen} AS updated_at, st.content,`,
				"snippet(session_transcripts_fts, 0, '', '', ' ... ', 24) AS excerpt,",
				"bm25(session_transcripts_fts) AS rank",
				"FROM session_transcripts_fts",
				"JOIN session_transcripts st ON st.rowid = session_transcripts_fts.rowid",
				"WHERE session_transcripts_fts MATCH ?",
				"AND st.agent_id = ?",
			];
			const args: unknown[] = [fts, params.agentId];
			if (targetSessionKey) {
				parts.push("AND st.session_key = ?");
				args.push(targetSessionKey);
			} else if (params.currentSessionKey) {
				parts.push("AND st.session_key != ?");
				args.push(params.currentSessionKey);
			}
			if (params.project) {
				parts.push("AND st.project = ?");
				args.push(params.project);
			}
			parts.push(`ORDER BY rank ASC, ${seen} DESC LIMIT ?`);
			args.push(limit);
			const rows = params.db.prepare(parts.join("\n")).all(...args) as Array<{
				readonly session_key: string;
				readonly project: string | null;
				readonly updated_at: string;
				readonly content: string;
				readonly excerpt: string | null;
				readonly rank: number;
			}>;
			if (rows.length > 0) {
				return rows.map((row) => ({
					sessionKey: row.session_key,
					project: row.project,
					updatedAt: row.updated_at,
					excerpt: excerptFor(row.content || row.excerpt || "", query),
					rank: row.rank,
				}));
			}
		}
	}

	const words = query
		.toLowerCase()
		.split(/\W+/)
		.filter((term) => term.length >= 3)
		.slice(0, 8);
	if (words.length === 0) return [];
	const score = words.map(() => "CASE WHEN LOWER(st.content) LIKE ? THEN 1 ELSE 0 END").join(" + ");
	const any = words.map(() => "LOWER(st.content) LIKE ?").join(" OR ");
	const patterns = words.map((word) => `%${word}%`);
	const parts = [
		`SELECT st.session_key, st.project, ${seen} AS updated_at, st.content, ${score} AS rank`,
		"FROM session_transcripts st",
		"WHERE st.agent_id = ?",
	];
	const scoreArgs: unknown[] = patterns;
	const whereArgs: unknown[] = [params.agentId];
	if (targetSessionKey) {
		parts.push("AND st.session_key = ?");
		whereArgs.push(targetSessionKey);
	} else if (params.currentSessionKey) {
		parts.push("AND st.session_key != ?");
		whereArgs.push(params.currentSessionKey);
	}
	if (params.project) {
		parts.push("AND st.project = ?");
		whereArgs.push(params.project);
	}
	parts.push(`AND (${any})`);
	parts.push(`ORDER BY rank DESC, ${seen} DESC LIMIT ?`);
	const args = [...scoreArgs, ...whereArgs, ...patterns, limit];

	return (
		params.db.prepare(parts.join("\n")).all(...args) as Array<{
			readonly session_key: string;
			readonly project: string | null;
			readonly updated_at: string;
			readonly content: string;
			readonly rank: number;
		}>
	).map((row) => ({
		sessionKey: row.session_key,
		project: row.project,
		updatedAt: row.updated_at,
		excerpt: excerptFor(row.content, query),
		rank: row.rank,
	}));
}
