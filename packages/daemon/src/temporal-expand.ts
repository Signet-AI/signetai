import { getDbAccessor } from "./db-accessor";

interface RawNode {
	readonly id: string;
	readonly project: string | null;
	readonly depth: number;
	readonly kind: string;
	readonly content: string;
	readonly token_count: number | null;
	readonly earliest_at: string;
	readonly latest_at: string;
	readonly session_key: string | null;
	readonly harness: string | null;
	readonly agent_id: string;
	readonly source_type: string | null;
	readonly source_ref: string | null;
	readonly meta_json: string | null;
	readonly created_at: string;
}

interface RawLink {
	readonly parent_id?: string;
	readonly child_id?: string;
	readonly ordinal: number;
}

interface RawMemory {
	readonly id: string;
	readonly content: string;
	readonly type: string;
	readonly created_at: string;
	readonly is_deleted?: number;
}

export interface TemporalExpandNode {
	readonly id: string;
	readonly project: string | null;
	readonly depth: number;
	readonly kind: string;
	readonly content: string;
	readonly tokenCount: number | null;
	readonly earliestAt: string;
	readonly latestAt: string;
	readonly sessionKey: string | null;
	readonly harness: string | null;
	readonly agentId: string;
	readonly sourceType: string | null;
	readonly sourceRef: string | null;
	readonly metaJson: string | null;
	readonly createdAt: string;
}

export interface TemporalExpandMemory {
	readonly id: string;
	readonly content: string;
	readonly type: string;
	readonly createdAt: string;
	readonly deleted: boolean;
}

export interface TemporalExpandTranscript {
	readonly sessionKey: string;
	readonly harness: string | null;
	readonly project: string | null;
	readonly updatedAt: string;
	readonly excerpt: string;
	readonly content?: string;
}

export interface TemporalExpandResult {
	readonly node: TemporalExpandNode;
	readonly parents: ReadonlyArray<TemporalExpandNode>;
	readonly children: ReadonlyArray<TemporalExpandNode>;
	readonly linkedMemories: ReadonlyArray<TemporalExpandMemory>;
	readonly transcript?: TemporalExpandTranscript;
}

function mapNode(row: RawNode): TemporalExpandNode {
	return {
		id: row.id,
		project: row.project,
		depth: row.depth,
		kind: row.kind,
		content: row.content,
		tokenCount: row.token_count,
		earliestAt: row.earliest_at,
		latestAt: row.latest_at,
		sessionKey: row.session_key,
		harness: row.harness,
		agentId: row.agent_id,
		sourceType: row.source_type,
		sourceRef: row.source_ref,
		metaJson: row.meta_json,
		createdAt: row.created_at,
	};
}

function clean(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function excerpt(text: string, anchor?: string, limit = 420): string {
	const base = clean(text);
	if (base.length <= limit) return base;
	const query = clean(anchor ?? "").toLowerCase();
	if (query.length > 0) {
		const terms = query
			.split(/\W+/)
			.filter((term) => term.length >= 4)
			.slice(0, 6);
		const lower = base.toLowerCase();
		for (const term of terms) {
			const idx = lower.indexOf(term);
			if (idx === -1) continue;
			const start = Math.max(0, idx - 160);
			const end = Math.min(base.length, idx + 220);
			return `${start > 0 ? "..." : ""}${base.slice(start, end).trim()}${end < base.length ? "..." : ""}`;
		}
	}
	return `${base.slice(0, Math.max(1, limit - 3)).trim()}...`;
}

function resolveTranscriptKey(node: TemporalExpandNode): string | null {
	if (node.sessionKey && node.sessionKey.trim().length > 0) return node.sessionKey;
	if (node.sourceType === "chunk" && node.sourceRef && node.sourceRef.trim().length > 0) return node.sourceRef;
	if (node.sourceType === "compaction" && node.sourceRef && node.sourceRef.trim().length > 0) return node.sourceRef;
	if (node.sourceType === "summary" && node.sourceRef && node.sourceRef.trim().length > 0) return node.sourceRef;
	return null;
}

export function expandTemporalNode(
	id: string,
	agentId: string,
	opts?: {
		readonly includeTranscript?: boolean;
		readonly project?: string;
		readonly transcriptCharLimit?: number;
	},
): TemporalExpandResult | null {
	return getDbAccessor().withReadDb((db) => {
		const table = db
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`)
			.get();
		if (!table) return null;

		const projectClause = opts?.project ? " AND project = ?" : "";
		const projectArgs = opts?.project ? [opts.project] : [];
		const node = db
			.prepare(
				`SELECT id, project, depth, kind, content, token_count,
				        earliest_at, latest_at, session_key, harness, agent_id,
				        source_type, source_ref, meta_json, created_at
				 FROM session_summaries
				 WHERE id = ? AND agent_id = ?${projectClause}`,
			)
			.get(id, agentId, ...projectArgs) as RawNode | undefined;
		if (!node) return null;

		const parentRows = db
			.prepare(
				`SELECT ss.id, ss.project, ss.depth, ss.kind, ss.content, ss.token_count,
				        ss.earliest_at, ss.latest_at, ss.session_key, ss.harness, ss.agent_id,
				        ss.source_type, ss.source_ref, ss.meta_json, ss.created_at,
				        rel.ordinal
				 FROM session_summary_children rel
				 JOIN session_summaries ss ON ss.id = rel.parent_id
				 WHERE rel.child_id = ? AND ss.agent_id = ?${projectClause}
				 ORDER BY rel.ordinal ASC, ss.latest_at DESC`,
			)
			.all(id, agentId, ...projectArgs) as Array<RawNode & RawLink>;

		const childRows = db
			.prepare(
				`SELECT ss.id, ss.project, ss.depth, ss.kind, ss.content, ss.token_count,
				        ss.earliest_at, ss.latest_at, ss.session_key, ss.harness, ss.agent_id,
				        ss.source_type, ss.source_ref, ss.meta_json, ss.created_at,
				        rel.ordinal
				 FROM session_summary_children rel
				 JOIN session_summaries ss ON ss.id = rel.child_id
				 WHERE rel.parent_id = ? AND ss.agent_id = ?${projectClause}
				 ORDER BY rel.ordinal ASC, ss.latest_at DESC`,
			)
			.all(id, agentId, ...projectArgs) as Array<RawNode & RawLink>;

		const memories = db
			.prepare(
				`SELECT ssm.memory_id AS id,
				        COALESCE(m.content, '[deleted memory]') AS content,
				        COALESCE(m.type, 'unknown') AS type,
				        COALESCE(m.created_at, ss.created_at) AS created_at,
				        CASE WHEN m.id IS NULL OR COALESCE(m.is_deleted, 0) = 1 THEN 1 ELSE 0 END AS is_deleted
				 FROM session_summary_memories ssm
				 JOIN session_summaries ss ON ss.id = ssm.summary_id
				 LEFT JOIN memories m ON m.id = ssm.memory_id
				 WHERE ssm.summary_id = ? AND ss.agent_id = ?${
						opts?.project ? " AND ss.project = ? AND (m.id IS NULL OR COALESCE(m.project, ss.project) = ?)" : ""
					}
				 ORDER BY created_at DESC
				 LIMIT 25`,
			)
			.all(id, agentId, ...(opts?.project ? [opts.project, opts.project] : [])) as RawMemory[];

		const mapped = mapNode(node);
		const transcriptKey = resolveTranscriptKey(mapped);
		let transcript: TemporalExpandTranscript | undefined;
		if (opts?.includeTranscript !== false && transcriptKey) {
			const cols = db.prepare("PRAGMA table_info(session_transcripts)").all() as ReadonlyArray<Record<string, unknown>>;
			const hasUpdated = cols.some((col) => col.name === "updated_at");
			const seenExpr = hasUpdated ? "COALESCE(updated_at, created_at)" : "created_at";
			const row = db
				.prepare(
					`SELECT session_key, harness, project, content, ${seenExpr} AS seen_at
					 FROM session_transcripts
					 WHERE session_key = ? AND agent_id = ?${opts?.project ? " AND project = ?" : ""}`,
				)
				.get(transcriptKey, agentId, ...(opts?.project ? [opts.project] : [])) as
				| {
						session_key: string;
						harness: string | null;
						project: string | null;
						content: string;
						seen_at: string;
				  }
				| undefined;
			if (row) {
				const limit = Math.max(400, Math.min(opts?.transcriptCharLimit ?? 2000, 12000));
				const raw = clean(row.content);
				transcript = {
					sessionKey: row.session_key,
					harness: row.harness,
					project: row.project,
					updatedAt: row.seen_at,
					excerpt: excerpt(raw, mapped.content),
					content: raw.length <= limit ? raw : `${raw.slice(0, Math.max(1, limit - 3))}...`,
				};
			}
		}

		return {
			node: mapped,
			parents: parentRows.map(mapNode),
			children: childRows.map(mapNode),
			linkedMemories: memories.map((row) => ({
				id: row.id,
				content: row.content,
				type: row.type,
				createdAt: row.created_at,
				deleted: row.is_deleted === 1,
			})),
			...(transcript ? { transcript } : {}),
		};
	});
}
