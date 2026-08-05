import type { ReadDb } from "./db-accessor";

/** Immutable evidence available to Dreaming and ontology extraction. */
export type EpisodicSourceKind = "memory" | "artifact" | "transcript" | "summary";

/** A stable resume point across the merged episodic stores. */
export interface EpisodicCursor {
	readonly capturedAt: string;
	readonly kind: EpisodicSourceKind | null;
	readonly id: string;
	/**
	 * A character offset into the canonical rendered evidence for `kind:id`.
	 * Present only while Dreaming is safely processing an oversized immutable
	 * record across passes; the source row itself is never changed.
	 */
	readonly fragmentOffset?: number;
}

export interface EpisodicSourceRecord {
	readonly kind: EpisodicSourceKind;
	readonly id: string;
	readonly content: string;
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	/**
	 * The configured Signet source entry id (memory_artifacts.source_id) that
	 * owns an artifact, when known. Purge on disconnect matches this id, so
	 * Dreaming stamps it onto derived semantic rows instead of the episodic
	 * node/session id in `sourceId`.
	 */
	readonly sourceEntryId: string | null;
	readonly project: string | null;
	readonly harness: string | null;
	readonly capturedAt: string;
	/**
	 * Canonical structured evidence metadata (JSON string) preserved verbatim
	 * from a structured remember save. Present on `memory`-kind records when
	 * the caller supplied a structured payload; null otherwise. Dreaming reads
	 * this to reason over structured entities/aspects without direct graph
	 * writes at save time.
	 */
	readonly evidenceMeta: string | null;
}

export interface ReadEpisodicSourceOptions {
	readonly agentId: string;
	readonly from: string;
}

const SOURCE_KIND_RANK: Readonly<Record<EpisodicSourceKind, number>> = {
	memory: 0,
	artifact: 1,
	transcript: 2,
	summary: 3,
};

function cursorPredicate(
	timestampColumn: string,
	idColumn: string,
	kind: EpisodicSourceKind,
	newerThan: string | null,
	cursor: EpisodicCursor | null | undefined,
): { readonly sql: string; readonly args: readonly (string | null)[] } {
	if (cursor) {
		const cursorRank = cursor.kind === null ? -1 : SOURCE_KIND_RANK[cursor.kind];
		const rank = SOURCE_KIND_RANK[kind];
		if (rank > cursorRank) {
			return { sql: `julianday(${timestampColumn}) >= julianday(?)`, args: [cursor.capturedAt] };
		}
		if (rank < cursorRank) {
			return { sql: `julianday(${timestampColumn}) > julianday(?)`, args: [cursor.capturedAt] };
		}
		return {
			sql: `(julianday(${timestampColumn}) > julianday(?) OR (julianday(${timestampColumn}) = julianday(?) AND ${idColumn} > ?))`,
			args: [cursor.capturedAt, cursor.capturedAt, cursor.id],
		};
	}
	return {
		sql: `(? IS NULL OR julianday(${timestampColumn}) > julianday(?))`,
		args: [newerThan, newerThan],
	};
}

function compareEpisodicSources(a: EpisodicSourceRecord, b: EpisodicSourceRecord, order: "newest" | "oldest"): number {
	const time = timestampMillis(a.capturedAt) - timestampMillis(b.capturedAt);
	if (time !== 0) return order === "oldest" ? time : -time;
	const rank = SOURCE_KIND_RANK[a.kind] - SOURCE_KIND_RANK[b.kind];
	if (rank !== 0) return order === "oldest" ? rank : -rank;
	const id = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	return order === "oldest" ? id : -id;
}

/** Match SQLite julianday's UTC interpretation of timezone-less timestamps. */
function timestampMillis(value: string): number {
	const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
		? `${value.replace(" ", "T")}Z`
		: value;
	const parsed = Date.parse(normalized);
	return Number.isFinite(parsed) ? parsed : 0;
}

function readNonEmptyTrimmed(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function sourceIdCandidates(value: string): string[] {
	const trimmed = value.trim();
	const stripped = trimmed.replace(/^(memory|artifact|source|transcript|session|summary):/, "");
	return [
		...new Set(
			[
				trimmed,
				stripped,
				`memory:${stripped}`,
				`artifact:${stripped}`,
				`source:${stripped}`,
				`transcript:${stripped}`,
				`session:${stripped}`,
				`summary:${stripped}`,
			].filter(Boolean),
		),
	];
}

export function readEpisodicMemory(db: ReadDb, agentId: string, id: string): EpisodicSourceRecord | null {
	const ids = sourceIdCandidates(id);
	const placeholders = ids.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT id, content, source_type, source_id, source_path, runtime_path, project, who, created_at, evidence_meta
			 FROM memories
			 WHERE agent_id = ?
			   AND memory_kind = 'episodic'
			   AND COALESCE(is_deleted, 0) = 0
			   AND visibility != 'archived'
			   AND scope IS NULL
			   AND id IN (${placeholders})
			 LIMIT 1`,
		)
		.get(agentId, ...ids) as
		| {
				readonly id: string;
				readonly content: string;
				readonly source_type: string | null;
				readonly source_id: string | null;
				readonly source_path: string | null;
				readonly runtime_path: string | null;
				readonly project: string | null;
				readonly who: string | null;
				readonly created_at: string;
				readonly evidence_meta: string | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		kind: "memory",
		id: row.id,
		content: row.content,
		sourceKind: row.source_type ?? "manual",
		sourceId: row.source_id ?? row.id,
		sourceEntryId: null,
		sourcePath: readNonEmptyTrimmed(row.source_path) ?? readNonEmptyTrimmed(row.runtime_path),
		project: row.project,
		harness: readNonEmptyTrimmed(row.who),
		// Order/cursor by immutable creation (capture) time, not updated_at.
		// Metadata edits (tags/importance/pinned) bump updated_at but must not
		// re-submit already-processed evidence to Dreaming.
		capturedAt: row.created_at,
		evidenceMeta: row.evidence_meta,
	};
}

export function readEpisodicArtifact(db: ReadDb, agentId: string, id: string): EpisodicSourceRecord | null {
	const ids = sourceIdCandidates(id);
	const placeholders = ids.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT source_path, source_kind, source_id, source_node_id, session_id, session_key, session_token,
			        project, harness, content, captured_at, updated_at
			 FROM memory_artifacts
			 WHERE agent_id = ?
			   AND COALESCE(is_deleted, 0) = 0
			   AND (
			     source_path = ?
			     OR source_node_id IN (${placeholders})
			     OR session_id IN (${placeholders})
			     OR session_key IN (${placeholders})
			     OR session_token IN (${placeholders})
			   )
			 ORDER BY captured_at DESC
			 LIMIT 1`,
		)
		.get(agentId, id, ...ids, ...ids, ...ids, ...ids) as
		| {
				readonly source_path: string;
				readonly source_kind: string;
				readonly source_id: string | null;
				readonly source_node_id: string | null;
				readonly session_id: string;
				readonly session_key: string | null;
				readonly session_token: string;
				readonly project: string | null;
				readonly harness: string | null;
				readonly content: string;
				readonly captured_at: string;
				readonly updated_at: string;
		  }
		| undefined;
	if (!row) return null;
	return {
		kind: "artifact",
		id: row.source_path,
		content: row.content,
		sourceKind: row.source_kind,
		sourceId: row.source_node_id ?? row.session_key ?? row.session_id ?? row.session_token,
		sourceEntryId: readNonEmptyTrimmed(row.source_id),
		sourcePath: row.source_path,
		project: row.project,
		harness: row.harness,
		capturedAt: row.captured_at ?? row.updated_at,
		evidenceMeta: null,
	};
}

export function readEpisodicTranscript(db: ReadDb, agentId: string, id: string): EpisodicSourceRecord | null {
	const ids = sourceIdCandidates(id);
	const placeholders = ids.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT session_key, content, harness, project, created_at, updated_at
			 FROM session_transcripts
			 WHERE agent_id = ? AND session_key IN (${placeholders})
			 ORDER BY updated_at DESC, created_at DESC
			 LIMIT 1`,
		)
		.get(agentId, ...ids) as
		| {
				readonly session_key: string;
				readonly content: string;
				readonly harness: string | null;
				readonly project: string | null;
				readonly created_at: string;
				readonly updated_at: string | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		kind: "transcript",
		id: row.session_key,
		content: row.content,
		sourceKind: "transcript",
		sourceId: row.session_key,
		sourceEntryId: null,
		sourcePath: null,
		project: row.project,
		harness: row.harness,
		capturedAt: row.updated_at ?? row.created_at,
		evidenceMeta: null,
	};
}

export function readEpisodicSummary(db: ReadDb, agentId: string, id: string): EpisodicSourceRecord | null {
	const ids = sourceIdCandidates(id);
	const placeholders = ids.map(() => "?").join(", ");
	// Compaction/checkpoint rows are first-class episodic evidence here. The
	// Dreaming pass intentionally narrows its own LLM input to primary summaries
	// to avoid feeding its derived rollups back into consolidation.
	const row = db
		.prepare(
			`SELECT id, content, project, harness, session_key, source_type, source_ref, latest_at
			 FROM session_summaries
			 WHERE agent_id = ?
			   AND depth = 0
			   AND COALESCE(source_type, 'summary') IN ('summary', 'compaction', 'checkpoint')
			   AND (id IN (${placeholders}) OR source_ref IN (${placeholders}))
			 ORDER BY latest_at DESC
			 LIMIT 1`,
		)
		.get(agentId, ...ids, ...ids) as
		| {
				readonly id: string;
				readonly content: string;
				readonly project: string | null;
				readonly harness: string | null;
				readonly session_key: string | null;
				readonly source_type: string | null;
				readonly source_ref: string | null;
				readonly latest_at: string;
		  }
		| undefined;
	if (!row) return null;
	return {
		kind: "summary",
		id: row.id,
		content: row.content,
		sourceKind: row.source_type ?? "summary",
		sourceId: row.source_ref ?? row.session_key ?? row.id,
		sourceEntryId: null,
		sourcePath: null,
		project: row.project,
		harness: row.harness,
		capturedAt: row.latest_at,
		evidenceMeta: null,
	};
}

/**
 * Read evidence across all current episodic stores.
 *
 * `newerThan` is a captured-artifact watermark, not a mutation cursor: the
 * artifacts themselves remain immutable and selectable after a Dreaming pass.
 */
export function readRecentEpisodicSources(
	db: ReadDb,
	agentId: string,
	limit: number,
	kinds?: readonly EpisodicSourceKind[],
	newerThan?: string | null,
	order: "newest" | "oldest" = "newest",
	cursor?: EpisodicCursor | null,
): EpisodicSourceRecord[] {
	const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
	const newer = newerThan?.trim() || null;
	const direction = order === "oldest" ? "ASC" : "DESC";
	const memoryCursor = cursorPredicate("created_at", "id", "memory", newer, cursor);
	const artifactCursor = cursorPredicate("captured_at", "source_path", "artifact", newer, cursor);
	const transcriptCursor = cursorPredicate(
		"COALESCE(updated_at, created_at)",
		"session_key",
		"transcript",
		newer,
		cursor,
	);
	const summaryCursor = cursorPredicate("latest_at", "id", "summary", newer, cursor);
	const allowedKinds = kinds ? new Set(kinds) : null;
	const wants = (kind: EpisodicSourceKind): boolean => allowedKinds === null || allowedKinds.has(kind);
	const hasExclusions = (() => {
		try {
			return Boolean(
				db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dreaming_evidence_exclusions'").get(),
			);
		} catch {
			return false;
		}
	})();
	const requeuePredicate = (kind: EpisodicSourceKind, idColumn: string): string =>
		!hasExclusions
			? "0"
			: `EXISTS (
			SELECT 1 FROM dreaming_evidence_exclusions AS dee
			WHERE dee.agent_id = ?
			  AND dee.source_kind = '${kind}'
			  AND dee.source_id = ${idColumn}
			  AND dee.requeue_requested_at IS NOT NULL
			  AND dee.resolved_at IS NULL
		)`;
	const memoryRequeue = requeuePredicate("memory", "id");
	const artifactRequeue = requeuePredicate("artifact", "source_path");
	const transcriptRequeue = requeuePredicate("transcript", "session_key");
	const summaryRequeue = requeuePredicate("summary", "id");
	const requeueArgs = hasExclusions ? [agentId] : [];
	const memories: EpisodicSourceRecord[] = wants("memory")
		? db
				.prepare(
					`SELECT id, content, source_type, source_id, source_path, runtime_path, project, who, created_at, evidence_meta
				 FROM memories
				 WHERE agent_id = ?
				   AND memory_kind = 'episodic'
				   AND COALESCE(is_deleted, 0) = 0
				   AND visibility != 'archived'
				   AND scope IS NULL
				   -- Session summaries are retained in memories for ordinary recall,
				   -- but their temporal-DAG node is the one canonical Dreaming input.
				   AND COALESCE(type, '') != 'session_summary'
				   AND (${memoryCursor.sql} OR ${memoryRequeue})
				 ORDER BY julianday(created_at) ${direction}, id ${direction}
				 LIMIT ?`,
				)
				.all(agentId, ...memoryCursor.args, ...requeueArgs, boundedLimit)
				.map((row) => {
					const memory = row as {
						readonly id: string;
						readonly content: string;
						readonly source_type: string | null;
						readonly source_id: string | null;
						readonly source_path: string | null;
						readonly runtime_path: string | null;
						readonly project: string | null;
						readonly who: string | null;
						readonly created_at: string;
						readonly evidence_meta: string | null;
					};
					return {
						kind: "memory",
						id: memory.id,
						content: memory.content,
						sourceKind: memory.source_type ?? "manual",
						sourceId: memory.source_id ?? memory.id,
						sourceEntryId: null,
						sourcePath: readNonEmptyTrimmed(memory.source_path) ?? readNonEmptyTrimmed(memory.runtime_path),
						project: memory.project,
						harness: readNonEmptyTrimmed(memory.who),
						capturedAt: memory.created_at,
						evidenceMeta: memory.evidence_meta,
					} satisfies EpisodicSourceRecord;
				})
		: [];
	const artifacts: EpisodicSourceRecord[] = wants("artifact")
		? db
				.prepare(
					`SELECT source_path, source_kind, source_id, source_node_id, session_id, session_key, session_token,
			        project, harness, content, captured_at, updated_at
			 FROM memory_artifacts AS ma
			 WHERE ma.agent_id = ? AND COALESCE(ma.is_deleted, 0) = 0
			   -- Canonical session artifacts preserve immutable lineage. When their
			   -- matching temporal node is present, it is the single Dreaming input;
			   -- otherwise keep the artifact as the durable recovery fallback.
			   AND NOT (
			     ma.source_kind = 'manifest'
			     OR (
			       ma.source_kind = 'transcript' AND ma.session_key IS NOT NULL
			       AND EXISTS (
			         SELECT 1 FROM session_transcripts AS st
			         WHERE st.agent_id = ma.agent_id AND st.session_key = ma.session_key
			       )
			     )
			     OR (
			       ma.source_kind IN ('summary', 'compaction')
			       AND EXISTS (
			         SELECT 1 FROM session_summaries AS ss
			         WHERE ss.agent_id = ma.agent_id
			           AND ss.depth = 0
			           AND COALESCE(ss.source_type, 'summary') = ma.source_kind
			           AND (
			             ss.session_key = ma.session_key
			             OR (
			               ss.session_key IS NULL AND ma.session_key IS NULL
			               AND ss.content = ma.content
			               AND julianday(ss.latest_at) = julianday(ma.captured_at)
			             )
			           )
			       )
			     )
			   )
				   AND (${artifactCursor.sql} OR ${artifactRequeue})
			 ORDER BY julianday(captured_at) ${direction}, source_path ${direction}
			 LIMIT ?`,
				)
				.all(agentId, ...artifactCursor.args, ...requeueArgs, boundedLimit)
				.map((row) => {
					const artifact = row as {
						readonly source_path: string;
						readonly source_kind: string;
						readonly source_id: string | null;
						readonly source_node_id: string | null;
						readonly session_id: string;
						readonly session_key: string | null;
						readonly session_token: string;
						readonly project: string | null;
						readonly harness: string | null;
						readonly content: string;
						readonly captured_at: string;
						readonly updated_at: string;
					};
					return {
						kind: "artifact",
						id: artifact.source_path,
						content: artifact.content,
						sourceKind: artifact.source_kind,
						sourceId: artifact.source_node_id ?? artifact.session_key ?? artifact.session_id ?? artifact.session_token,
						sourceEntryId: readNonEmptyTrimmed(artifact.source_id),
						sourcePath: artifact.source_path,
						project: artifact.project,
						harness: artifact.harness,
						capturedAt: artifact.captured_at ?? artifact.updated_at,
						evidenceMeta: null,
					} satisfies EpisodicSourceRecord;
				})
		: [];
	const transcripts: EpisodicSourceRecord[] = wants("transcript")
		? db
				.prepare(
					`SELECT session_key, content, harness, project, created_at, updated_at
			 FROM session_transcripts
			 WHERE agent_id = ?
			   AND (${transcriptCursor.sql} OR ${transcriptRequeue})
			 ORDER BY julianday(COALESCE(updated_at, created_at)) ${direction}, session_key ${direction}
			 LIMIT ?`,
				)
				.all(agentId, ...transcriptCursor.args, ...requeueArgs, boundedLimit)
				.map((row) => {
					const transcript = row as {
						readonly session_key: string;
						readonly content: string;
						readonly harness: string | null;
						readonly project: string | null;
						readonly created_at: string;
						readonly updated_at: string | null;
					};
					return {
						kind: "transcript",
						id: transcript.session_key,
						content: transcript.content,
						sourceKind: "transcript",
						sourceId: transcript.session_key,
						sourceEntryId: null,
						sourcePath: null,
						project: transcript.project,
						harness: transcript.harness,
						capturedAt: transcript.updated_at ?? transcript.created_at,
						evidenceMeta: null,
					} satisfies EpisodicSourceRecord;
				})
		: [];
	const summaries: EpisodicSourceRecord[] = wants("summary")
		? db
				.prepare(
					`SELECT id, content, project, harness, session_key, source_type, source_ref, latest_at
			 FROM session_summaries
			 WHERE agent_id = ?
			   AND depth = 0
			   AND COALESCE(source_type, 'summary') IN ('summary', 'compaction', 'checkpoint')
			   AND (${summaryCursor.sql} OR ${summaryRequeue})
			 ORDER BY julianday(latest_at) ${direction}, id ${direction}
			 LIMIT ?`,
				)
				.all(agentId, ...summaryCursor.args, ...requeueArgs, boundedLimit)
				.map((row) => {
					const summary = row as {
						readonly id: string;
						readonly content: string;
						readonly project: string | null;
						readonly harness: string | null;
						readonly session_key: string | null;
						readonly source_type: string | null;
						readonly source_ref: string | null;
						readonly latest_at: string;
					};
					return {
						kind: "summary",
						id: summary.id,
						content: summary.content,
						sourceKind: summary.source_type ?? "summary",
						sourceId: summary.source_ref ?? summary.session_key ?? summary.id,
						sourceEntryId: null,
						sourcePath: null,
						project: summary.project,
						harness: summary.harness,
						capturedAt: summary.latest_at,
						evidenceMeta: null,
					} satisfies EpisodicSourceRecord;
				})
		: [];
	return [...memories, ...artifacts, ...transcripts, ...summaries]
		.sort((a, b) => compareEpisodicSources(a, b, order))
		.slice(0, boundedLimit);
}

/** Resolve one episodic record without falling back to semantic memory. */
export function readEpisodicSource(db: ReadDb, options: ReadEpisodicSourceOptions): EpisodicSourceRecord | null {
	const from = options.from.trim();
	if (!from) return null;
	if (from.startsWith("memory:")) {
		return readEpisodicMemory(db, options.agentId, from.replace(/^memory:/, ""));
	}
	if (from.startsWith("transcript:") || from.startsWith("session:")) {
		return readEpisodicTranscript(db, options.agentId, from);
	}
	if (from.startsWith("summary:")) return readEpisodicSummary(db, options.agentId, from);
	if (from.startsWith("artifact:") || from.startsWith("source:")) {
		return readEpisodicArtifact(db, options.agentId, from.replace(/^(artifact|source):/, ""));
	}
	return (
		readEpisodicMemory(db, options.agentId, from) ??
		readEpisodicArtifact(db, options.agentId, from) ??
		readEpisodicTranscript(db, options.agentId, from) ??
		readEpisodicSummary(db, options.agentId, from)
	);
}

/**
 * Search immutable episodic evidence without falling back to semantic memory.
 *
 * This belongs beside the canonical cross-store reader so every Dreaming
 * caller uses the same provenance, deletion, and source-native boundaries.
 * It deliberately returns complete source records: callers bound the number
 * of matches, never by truncating the evidence a model may cite.
 */
export function searchEpisodicSources(
	db: ReadDb,
	params: {
		readonly agentId: string;
		readonly query: string;
		readonly since?: string;
		readonly before?: string;
		readonly kind?: "memory" | "artifact" | "transcript" | "summary";
		readonly limit?: number;
	},
): EpisodicSourceRecord[] {
	const query = params.query.trim();
	const limit = Math.max(1, Math.min(Math.floor(params.limit ?? 20), 50));
	const like = `%${query}%`;
	// An empty query still lists recent sources (runbook cutoff pattern); the
	// LIKE below degrades to a match-all and the outer ORDER BY picks newest.
	const timeArgs: unknown[] = [];
	if (params.since !== undefined) timeArgs.push(params.since);
	if (params.before !== undefined) timeArgs.push(params.before);

	const branches: Array<{ sql: string; args: unknown[] }> = [];
	if (params.kind === undefined || params.kind === "memory") {
		branches.push({
			sql: `SELECT 'memory' AS kind, id, created_at AS captured_at
			      FROM memories
			      WHERE agent_id = ? AND memory_kind = 'episodic'
			        AND COALESCE(is_deleted, 0) = 0 AND visibility != 'archived' AND scope IS NULL
			        AND COALESCE(type, '') != 'session_summary' AND content LIKE ?
			        ${params.since ? "AND created_at >= ?" : ""} ${params.before ? "AND created_at <= ?" : ""}`,
			args: [params.agentId, like, ...timeArgs],
		});
	}
	if (params.kind === undefined || params.kind === "artifact") {
		branches.push({
			// Artifacts are deduped by content hash: content-identical files
			// across vault paths collapse to one canonical row (most recent
			// captured_at; tie-break by path). Empty placeholder artifacts are
			// excluded entirely.
			sql: `SELECT 'artifact' AS kind, ma.source_path AS id, ma.captured_at AS captured_at
			      FROM memory_artifacts ma
			      WHERE ma.agent_id = ? AND COALESCE(ma.is_deleted, 0) = 0
			        AND length(ma.content) > 0 AND ma.content LIKE ?
			        ${params.since ? "AND ma.captured_at >= ?" : ""} ${params.before ? "AND ma.captured_at <= ?" : ""}
			        AND (ma.source_sha256 IS NULL OR ma.source_sha256 = ''
			             OR (ma.agent_id, ma.source_path) = (
			               SELECT ma2.agent_id, ma2.source_path FROM memory_artifacts ma2
			               WHERE ma2.agent_id = ma.agent_id AND COALESCE(ma2.is_deleted, 0) = 0
			                 AND ma2.source_sha256 = ma.source_sha256
			               ORDER BY ma2.captured_at DESC, ma2.source_path ASC
			               LIMIT 1
			             ))`,
			args: [params.agentId, like, ...timeArgs],
		});
	}
	if (params.kind === undefined || params.kind === "transcript") {
		branches.push({
			sql: `SELECT 'transcript' AS kind, session_key AS id, COALESCE(updated_at, created_at) AS captured_at
			      FROM session_transcripts
			      WHERE agent_id = ? AND content LIKE ?
			        ${params.since ? "AND COALESCE(updated_at, created_at) >= ?" : ""}
			        ${params.before ? "AND COALESCE(updated_at, created_at) <= ?" : ""}`,
			args: [params.agentId, like, ...timeArgs],
		});
	}
	if (params.kind === undefined || params.kind === "summary") {
		branches.push({
			sql: `SELECT 'summary' AS kind, id, latest_at AS captured_at
			      FROM session_summaries
			      WHERE agent_id = ? AND depth = 0
			        AND COALESCE(source_type, 'summary') IN ('summary', 'compaction', 'checkpoint')
			        AND content LIKE ?
			        ${params.since ? "AND latest_at >= ?" : ""} ${params.before ? "AND latest_at <= ?" : ""}`,
			args: [params.agentId, like, ...timeArgs],
		});
	}

	const union = branches.map((branch) => branch.sql).join("\nUNION ALL\n");
	const rows = db
		.prepare(
			`SELECT kind, id
			 FROM (
			 ${union}
			 )
			 ORDER BY julianday(captured_at) DESC, kind ASC, id ASC
			 LIMIT ?`,
		)
		.all(...branches.flatMap((branch) => branch.args), limit) as Array<{
		kind: EpisodicSourceKind;
		id: string;
	}>;
	return rows
		.map((row) => readEpisodicSource(db, { agentId: params.agentId, from: `${row.kind}:${row.id}` }))
		.filter((source): source is EpisodicSourceRecord => source !== null);
}
