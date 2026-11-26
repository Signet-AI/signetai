import { z } from "zod";
import type { EpisodicSourceKind } from "./episodic-sources";
import { dreamingReadPredicate } from "./pipeline/dreaming-read-scope";
import type { NamedContentReadRequest } from "./named-content-reads";
import { buildBlackBoxSessionInDb, listBlackBoxSessionsInDb } from "./black-box";
import { buildMemoryTimeline } from "./memory-timeline";
import { buildForgetCandidatesWhere } from "./memory-forget-read";
import { classificationsForWrite } from "@signet/core";
import { createHash } from "node:crypto";
import { ftsShardTables, vecShardTables, activeVectorProjectionTable } from "@signet/core";
import type { MigrationDb } from "@signet/core";
import type { ReadDb } from "./db-accessor";
import { gatherProjectionRows } from "./umap-projection";
import type { ContentReadRequest } from "./content-read";
import { readScopeSql, type ReadScope } from "./read-scope";
import { exportSourceSnapshotInDb } from "./source-snapshots";
import { expandTemporalNodeInDb } from "./temporal-expand";
import { sourceHasEligibleUnconsumedEvidence } from "./pipeline/dreaming-evidence-consumption";

export interface DreamingReviewedEvidence {
	readonly agentId: string;
	readonly sourceKind: EpisodicSourceKind;
	readonly sourceId: string;
	readonly sourceCapturedAt: string;
	readonly sourceEntryId: string;
	readonly sourceRevision: string;
	readonly reason: string;
	readonly passId: string;
	readonly reviewedAt: string;
}

const reviewedEvidenceRows = z.array(
	z.object({
		agentId: z.string(),
		sourceKind: z.enum(["memory", "artifact", "transcript", "summary"]),
		sourceId: z.string(),
		sourceCapturedAt: z.string(),
		sourceEntryId: z.string(),
		sourceRevision: z.string(),
		reason: z.string(),
		passId: z.string(),
		reviewedAt: z.string(),
	}),
);
export function readDreamingReviewedEvidenceInOwner(
	db: ReadDb,
	agentId: string,
	readScope?: ReadScope,
): readonly DreamingReviewedEvidence[] {
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dreaming_evidence_reviews'").get())
		return [];
	const predicate = dreamingReadPredicate("p", readScope);
	const row = dreamingReadPredicate(
		"",
		readScope ?? { reach: { kind: "own", agentId }, compartments: [], projects: null },
	);
	return reviewedEvidenceRows.parse(
		db
			.prepare(`SELECT agent_id AS agentId, source_kind AS sourceKind, source_id AS sourceId,
		        source_captured_at AS sourceCapturedAt, source_entry_id AS sourceEntryId,
		        source_revision AS sourceRevision, reason, pass_id AS passId,
		        reviewed_at AS reviewedAt
		 FROM dreaming_evidence_reviews
		 WHERE ${readScope ? "1=1" : "agent_id = ?"} ${row.sql}
 ${readScope ? `AND EXISTS (SELECT 1 FROM dreaming_passes p WHERE p.id = dreaming_evidence_reviews.pass_id AND p.agent_id = dreaming_evidence_reviews.agent_id ${predicate.sql})` : ""}
		 ORDER BY reviewed_at DESC, source_kind ASC, source_id ASC LIMIT 500`)
			.all(...(readScope ? [] : [agentId]), ...row.args, ...predicate.args),
	);
}

const schemaColumns = new WeakMap<ReadDb, { version: number; tables: Map<string, Set<string>> }>();
function scopedContentDb(
	db: ReadDb,
	scope: import("./read-scope").ReadScope,
	tables: readonly string[],
	subject?: import("./read-scope").AudienceSubject,
): ReadDb {
	return {
		prepare(sql) {
			const args: unknown[] = [];
			if (sql.trimStart().toUpperCase().startsWith("PRAGMA ")) return db.prepare(sql);
			const version = db.prepare("PRAGMA schema_version").get()?.schema_version;
			if (typeof version !== "number") throw new Error("Invalid schema version");
			let cached = schemaColumns.get(db);
			if (!cached || cached.version !== version) {
				cached = { version, tables: new Map() };
				schemaColumns.set(db, cached);
			}
			const views = tables.map((table) => {
				let columns = cached.tables.get(table);
				if (!columns) {
					columns = new Set(
						db
							.prepare(`PRAGMA table_info(${table})`)
							.all<Record<string, unknown>>()
							.flatMap((column) => (typeof column.name === "string" ? [column.name] : [])),
					);
					cached.tables.set(table, columns);
				}

				if (table === "memory_thread_heads") {
					const predicate = readScopeSql("_content", scope, {
						visibility: null,
						memory: null,
						session: "session_key",
						source: null,
					});
					args.push(...predicate.args);
					return `memory_thread_heads AS (SELECT _content.* FROM (SELECT head.*,parent.compartment_id FROM main.memory_thread_heads head LEFT JOIN main.session_summaries parent ON parent.id=head.node_id AND parent.agent_id=head.agent_id${scope.organizationMode === true ? " WHERE parent.id IS NOT NULL" : ""}) _content WHERE 1=1${predicate.sql})`;
				}
				if (!columns.has("compartment_id")) {
					if (!subject && scope.compartments !== "all") throw new Error("Import read requires a principal");
					const access = readScopeSql(
						"_content",
						{ ...scope, projects: null },
						{
							visibility: null,
							memory: null,
							session: columns.has("canonical_key") ? "canonical_key" : null,
							source: columns.has("source_id") ? "source_id" : null,
						},
					);
					const audience =
						subject?.local || scope.compartments === "all"
							? ""
							: ` AND NOT EXISTS(SELECT 1 FROM classification_assignments ca WHERE ca.agent_id=_content.agent_id AND (ca.target_kind='agent'${columns.has("source_id") ? " OR (ca.target_kind='source' AND ca.target_id=_content.source_id)" : ""}${columns.has("canonical_key") ? " OR (ca.target_kind='session' AND (ca.target_id=_content.canonical_key OR 'session:'||ca.target_id=_content.canonical_key OR ca.target_id='session:'||_content.canonical_key))" : ""}) AND NOT EXISTS(SELECT 1 FROM classification_audience audience WHERE audience.classification_id=ca.classification_id AND ((audience.principal_kind='user' AND audience.principal_id=?) OR (audience.principal_kind='group' AND audience.principal_id IN (SELECT group_id FROM group_members WHERE user_id=?)))))`;
					if (scope.compartments === "all") {
						args.push(...access.args);
						return `${table} AS (SELECT ${[...columns].map((column) => `_content.${column}`).join(",")} FROM (SELECT raw.*,NULL AS compartment_id FROM main.${table} raw) _content WHERE 1=1${access.sql}${scope.projects !== null ? " AND 0" : ""})`;
					}
					const projected = [...columns]
						.filter(
							(column) =>
								![
									"total",
									"imported",
									"duplicate",
									"rejected",
									"pending",
									"record_count",
									"size_bytes",
									"upload_size",
									"upload_offset",
									"updated_at",
									"error",
									"lease_token",
									"content_hash",
									"upload_digest",
								].includes(column),
						)
						.map((column) => `_content.${column}`);
					const counts = (status?: string) =>
						`(SELECT COUNT(*) FROM source_import_records readable WHERE readable.${table === "source_import_files" ? "file_id" : "job_id"}=_content.id${status ? ` AND readable.status='${status}'` : ""})`;
					if (table === "source_import_jobs") {
						for (const status of ["total", "imported", "duplicate", "rejected", "pending"])
							projected.push(`${counts(status === "total" ? undefined : status)} AS ${status}`);
					}
					if (table === "source_import_files") {
						projected.push(`${counts()} AS record_count`);
						for (const size of ["size_bytes", "upload_size", "upload_offset"]) {
							const readableSize = `(SELECT COALESCE(SUM(readable.byte_length),0) FROM source_import_records readable WHERE readable.file_id=_content.id)`;
							if (subject?.userId) {
								projected.push(
									`CASE WHEN EXISTS(SELECT 1 FROM main.source_import_jobs upload_owner WHERE upload_owner.id=_content.job_id AND upload_owner.agent_id=_content.agent_id AND upload_owner.author_user_id=?) THEN _content.${size} ELSE ${readableSize} END AS ${size}`,
								);
								args.push(subject.userId);
							} else projected.push(`${readableSize} AS ${size}`);
						}
					}
					if (columns.has("updated_at")) projected.push("_content.created_at AS updated_at");
					for (const column of ["error", "lease_token", "content_hash", "upload_digest"]) {
						if (!columns.has(column)) continue;
						if (table === "source_import_files" && column === "upload_digest" && subject?.userId) {
							projected.push(
								`CASE WHEN EXISTS(SELECT 1 FROM main.source_import_jobs upload_owner WHERE upload_owner.id=_content.job_id AND upload_owner.agent_id=_content.agent_id AND upload_owner.author_user_id=?) THEN _content.upload_digest ELSE NULL END AS upload_digest`,
							);
							args.push(subject.userId);
						} else projected.push(`NULL AS ${column}`);
					}
					args.push(...access.args, ...(audience ? [subject?.userId, subject?.userId] : []));
					const hasFiles =
						table === "source_import_jobs"
							? " AND EXISTS(SELECT 1 FROM source_import_files readable WHERE readable.job_id=_content.id)"
							: "";
					return `${table} AS (SELECT ${projected.join(",")} FROM (SELECT raw.*,NULL AS compartment_id FROM main.${table} raw) _content WHERE 1=1${access.sql}${audience}${scope.projects !== null ? " AND 0" : ""}${hasFiles})`;
				}
				if (table === "entity_aspects") {
					const parent = readScopeSql(
						"parent",
						{ ...scope, projects: null },
						{ visibility: null, memory: null, session: null, source: "source_id" },
					);
					args.push(...parent.args);
					return `entity_aspects AS (SELECT ${[...columns].map((column) => `_content.${column}`).join(",")} FROM main.entity_aspects _content JOIN main.entities parent ON parent.id=_content.entity_id AND parent.agent_id=_content.agent_id WHERE 1=1${parent.sql}${scope.projects === null ? "" : " AND 0"})`;
				}
				const predicate = readScopeSql("_content", columns.has("project") ? scope : { ...scope, projects: null }, {
					visibility: columns.has("visibility") ? "visibility" : null,
					memory: table === "memories" ? "id" : null,
					session: columns.has("session_key") ? "session_key" : table === "memories" ? "source_id" : null,
					source: columns.has("source_id") ? "source_id" : null,
				});
				args.push(...predicate.args);
				return `${table} AS (SELECT _content.*, _content.rowid AS rowid FROM main.${table} _content WHERE 1=1${predicate.sql}${!columns.has("project") && scope.projects !== null ? " AND 0" : ""})`;
			});
			const statement = db.prepare(views.length ? `WITH ${views.join(",")} ${sql}` : sql);
			return {
				get: (...params: unknown[]) => statement.get(...args, ...params),
				all<Row>(...params: unknown[]) {
					return statement.all<Row>(...args, ...params);
				},
				run() {
					throw new Error("Content read cannot mutate");
				},
			};
		},
	};
}

export function executeContentRead(
	db: MigrationDb & ReadDb,
	request: ContentReadRequest,
	check: () => void = () => {},
): unknown {
	check();
	if (request.op === "readable_pointers") {
		if (request.references.length > 2000) throw new Error("Pointer admission limit exceeded");
		return request.references.flatMap((ref) => {
			if (ref.kind === "session") {
				const id = ref.id.replace(/^session:/, "");
				const { cte, args } = sessionReadOwners(request.scope, [id, ref.id]);
				return db
					.prepare(`${cte} SELECT 1 FROM readable_sessions WHERE session_key IN (?,?) LIMIT 1`)
					.get(...args, id, ref.id)
					? [`session:${ref.id}`]
					: [];
			}

			const table = {
				memory: "memories",
				memory_value: "memories",
				summary: "session_summaries",
				artifact: "memory_artifacts",
				document: "documents",
			}[ref.kind];
			const key = ref.kind === "artifact" ? "source_path" : "id";
			const scope = readScopeSql("target", request.scope, {
				visibility: ref.kind === "memory" || ref.kind === "memory_value" ? "visibility" : null,
				memory: ref.kind === "memory" || ref.kind === "memory_value" ? "id" : null,
				session:
					ref.kind === "memory" || ref.kind === "memory_value"
						? "source_id"
						: ref.kind === "document"
							? null
							: "session_key",
				source: ref.kind === "summary" ? null : ref.kind === "document" ? "id" : "source_id",
			});
			const id = ref.id;
			const missing = ref.kind === "memory_value" ? `NOT EXISTS(SELECT 1 FROM memories WHERE id=?) OR ` : "";
			const row = db
				.prepare(
					`SELECT 1 WHERE ${missing}EXISTS(SELECT 1 FROM ${table} target WHERE target.${key} IN (?,?)${scope.sql})`,
				)
				.get(...(ref.kind === "memory_value" ? [id] : []), id, ref.id, ...scope.args);
			return row ? [`${ref.kind}:${ref.id}`] : [];
		});
	}
	if (request.op === "continuity") {
		const { cte, args } = sessionReadOwners(request.scope);
		const filtered = `${cte},filtered AS (SELECT s.id,s.session_key,s.project,s.harness,s.score,s.memories_recalled,s.memories_used,s.novel_context_count,s.reasoning,s.created_at FROM session_scores s JOIN readable_sessions r ON r.session_key=s.session_key${request.project ? " WHERE s.project=?" : ""})`;
		return db
			.prepare(
				request.latest
					? `${filtered} SELECT project,score,created_at FROM (SELECT project,score,created_at,ROW_NUMBER() OVER(PARTITION BY project ORDER BY created_at DESC,id) AS rank FROM filtered WHERE project IS NOT NULL) WHERE rank=1 ORDER BY created_at DESC LIMIT ?`
					: `${filtered} SELECT id,session_key,project,harness,score,memories_recalled,memories_used,novel_context_count,reasoning,created_at FROM filtered ORDER BY created_at DESC,id LIMIT ?`,
			)
			.all(...args, ...(request.project ? [request.project] : []), Math.max(1, Math.min(request.limit, 500)));
	}
	if (request.op === "dedupe_compartment") {
		const key = classificationsForWrite(db, request.writeScope).join(",");
		if (!key) return { exists: true, id: null, key };
		const row = db.prepare("SELECT id FROM compartments WHERE key=?").get(key);
		return { exists: Boolean(row), id: typeof row?.id === "number" ? row.id : null, key };
	}
	if (request.op === "forget_candidates") {
		const req = request.request;
		const limit = Math.max(1, Math.min(req.limit, 200));
		const memoryTable = request.legacy
			? "(SELECT raw.rowid,raw.*,CASE WHEN raw.visibility='archived' THEN 'private' ELSE raw.visibility END AS read_visibility FROM memories raw)"
			: "memories";
		const access = readScopeSql("m", request.scope, { visibility: request.legacy ? "read_visibility" : "visibility" });
		const scopeSql = `${request.mutation.sql}${access.sql}`;
		const scopeArgs = [...request.mutation.args, ...access.args];
		const filter = buildForgetCandidatesWhere(req, "m");
		if (request.ids) {
			const ids = [...new Set(request.ids.map((id) => id.trim()).filter(Boolean))].slice(0, limit);
			if (!ids.length) return [];
			const rows = db
				.prepare(
					`SELECT m.id,m.pinned,m.version,0 AS score FROM ${memoryTable} m WHERE m.is_deleted=0 AND m.id IN (${ids.map(() => "?").join(",")})${scopeSql}`,
				)
				.all(...ids, ...scopeArgs);
			const byId = new Map(rows.flatMap((row) => (typeof row.id === "string" ? [[row.id, row] as const] : [])));
			return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)] : []));
		}
		if (req.query.trim()) {
			try {
				const tables = ftsShardTables("memories_fts", request.scope.compartments, db);
				const args: unknown[] = [];
				const branches = tables.map((table) => {
					args.push(req.query, ...filter.args, ...scopeArgs);
					return `SELECT m.id,m.pinned,m.version,bm25(${table}) AS raw_score FROM ${table} JOIN ${memoryTable} m ON m.rowid=${table}.rowid WHERE ${table} MATCH ? AND m.is_deleted=0${filter.clause}${scopeSql}`;
				});
				if (!branches.length) return [];
				return db
					.prepare(`SELECT * FROM (${branches.join(" UNION ALL ")}) ORDER BY raw_score,id LIMIT ?`)
					.all(...args, limit)
					.map(({ raw_score, ...row }) => ({
						...row,
						score: 1 / (1 + Math.abs(typeof raw_score === "number" ? raw_score : 0)),
					}));
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!/fts5: syntax error|no such column|malformed MATCH|unknown special query|unterminated string/i.test(
						error.message,
					)
				)
					throw error;
				return db
					.prepare(
						`SELECT m.id,m.pinned,m.version,0 AS score FROM ${memoryTable} m WHERE m.is_deleted=0 AND (m.content LIKE ? OR m.tags LIKE ?)${filter.clause}${scopeSql} ORDER BY m.updated_at DESC,m.id LIMIT ?`,
					)
					.all(`%${req.query}%`, `%${req.query}%`, ...filter.args, ...scopeArgs, limit);
			}
		}
		return db
			.prepare(
				`SELECT m.id,m.pinned,m.version,0 AS score FROM ${memoryTable} m WHERE m.is_deleted=0${filter.clause}${scopeSql} ORDER BY m.pinned DESC,m.importance DESC,m.updated_at DESC,m.id LIMIT ?`,
			)
			.all(...filter.args, ...scopeArgs, limit);
	}
	if (request.op === "timeline")
		return buildMemoryTimeline(db, { tzOffsetMin: request.tzOffsetMin, scope: readScopeSql("m", request.scope) });
	if (request.op === "blackbox" || request.op === "blackbox_list") {
		const scoped = scopedContentDb(db, request.scope, [
			"memory_search_telemetry",
			"session_recall_events",
			"epistemic_assertions",
			"memories",
			"memory_artifacts",
			"session_transcripts",
			"session_summaries",
		]);
		const input = { ...request, agentId: request.scope.reach.kind === "all" ? "all" : request.agentId };
		return request.op === "blackbox"
			? buildBlackBoxSessionInDb(scoped, { ...input, sessionKey: request.sessionKey, at: request.at })
			: listBlackBoxSessionsInDb(scoped, input);
	}
	if (request.op === "import_file" || request.op === "import_bytes") {
		const scoped = scopedContentDb(
			db,
			request.scope,
			["source_import_records", "source_import_files", "source_import_jobs"],
			request.subject,
		);
		if (request.op === "import_file") {
			return request.cursor === undefined
				? (scoped
						.prepare(
							"SELECT agent_id,upload_generation,storage_state FROM source_import_files WHERE id=? AND job_id=? LIMIT 1",
						)
						.get(request.fileId, request.jobId) ?? null)
				: (scoped
						.prepare(
							"SELECT id,ordinal,byte_offset,byte_length FROM source_import_records WHERE file_id=? AND job_id=? AND ordinal>? ORDER BY ordinal,id LIMIT 1",
						)
						.get(request.fileId, request.jobId, request.cursor) ?? null);
		}
		if (
			!Number.isSafeInteger(request.offset) ||
			request.offset < 0 ||
			!Number.isSafeInteger(request.length) ||
			request.length < 1 ||
			request.length > 65536
		)
			throw new Error("Invalid import read range");
		const end = request.offset + request.length;
		const chunks = scoped
			.prepare(
				"SELECT c.byte_offset,c.content,c.checksum FROM source_import_chunks c JOIN source_import_files f ON f.id=c.file_id AND f.agent_id=c.agent_id JOIN source_import_records r ON r.file_id=f.id AND r.agent_id=f.agent_id WHERE r.id=? AND f.id=? AND f.job_id=? AND c.generation=f.upload_generation AND f.storage_state='sealed' AND r.byte_offset<=? AND r.byte_offset+r.byte_length>=? AND c.byte_offset<? AND c.byte_offset+length(c.content)>? ORDER BY c.byte_offset LIMIT 7",
			)
			.all<{ byte_offset: number; content: Uint8Array; checksum: string }>(
				request.recordId,
				request.fileId,
				request.jobId,
				request.offset,
				end,
				end,
				request.offset,
			);
		const parts = chunks.map((chunk) => {
			if (createHash("sha256").update(chunk.content).digest("hex") !== chunk.checksum)
				throw new Error("source evidence checksum mismatch");
			return Buffer.from(chunk.content).subarray(
				Math.max(0, request.offset - chunk.byte_offset),
				Math.min(chunk.content.byteLength, end - chunk.byte_offset),
			);
		});
		const result = Buffer.concat(parts);
		if (result.byteLength !== request.length) throw new Error("source evidence unavailable");
		return result.toString("hex");
	}
	if (request.op === "source_snapshot")
		return exportSourceSnapshotInDb(scopedContentDb(db, request.scope, ["memory_artifacts", "session_transcripts"]), {
			source: request.source,
			agentId: request.agentId,
			includeLocalDiscord: request.includeLocalDiscord,
			scoped: true,
		});
	if (request.op === "source_access") {
		const predicate = readScopeSql("s", request.scope, {
			visibility: null,
			memory: null,
			session: null,
			source: "source_id",
		});
		const blocked = request.subject.local
			? ""
			: " AND NOT EXISTS(SELECT 1 FROM classification_assignments ca WHERE ca.agent_id=s.agent_id AND (ca.target_kind='agent' OR (ca.target_kind='source' AND ca.target_id=s.source_id)) AND NOT EXISTS(SELECT 1 FROM classification_audience audience WHERE audience.classification_id=ca.classification_id AND ((audience.principal_kind='user' AND audience.principal_id=?) OR (audience.principal_kind='group' AND audience.principal_id IN (SELECT group_id FROM group_members WHERE user_id=?)))))";
		return Boolean(
			db
				.prepare(
					`SELECT 1 FROM (SELECT ? AS source_id,? AS agent_id,NULL AS compartment_id,NULL AS project) s WHERE 1=1${predicate.sql}${blocked}`,
				)
				.get(
					request.sourceId,
					request.agentId,
					...predicate.args,
					...(request.subject.local ? [] : [request.subject.userId, request.subject.userId]),
				),
		);
	}
	if ("parameters" in request) {
		const definition = namedReadStatement(request);
		if (!definition) throw new Error("Unknown content read operation");
		const statement = scopedContentDb(db, request.scope, definition.tables, request.subject).prepare(definition.sql);
		const offset = request.filters?.cursor ? 0 : (request.filters?.offset ?? 0);
		if (request.op === "sources.import.export" && (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000))
			throw new Error("Invalid export offset");
		const parameters = request.op === "sources.import.export" ? [...request.parameters, offset] : request.parameters;
		return definition.result === "all" ? statement.all(...parameters) : statement.get(...parameters);
	}
	if (request.op === "source_eligibility") {
		const scoped = scopedContentDb(db, request.scope, ["memory_artifacts", "session_transcripts"]);
		const agents = scoped
			.prepare(
				"SELECT DISTINCT agent_id FROM memory_artifacts WHERE source_id=? UNION SELECT DISTINCT agent_id FROM session_transcripts WHERE source_id=? LIMIT 1001",
			)
			.all<{ agent_id: string }>(request.sourceId, request.sourceId);
		if (agents.length > 1000) throw new Error("Source eligibility exceeds the 1000-agent admission limit");
		return agents.some((agent) =>
			sourceHasEligibleUnconsumedEvidence(scoped, agent.agent_id, request.sourceId, request.legacyRoot),
		);
	}
	if (request.op === "projection_rows")
		return {
			...gatherProjectionRows(db, {
				...request.query,
				scope: request.scope,
				limit: Math.min(request.query.limit ?? 100, 100),
			}),
			agents: db
				.prepare("SELECT id FROM agents WHERE archived_at IS NULL ORDER BY id LIMIT 10001")
				.all()
				.flatMap((row) => (typeof row.id === "string" ? [row.id] : [])),
		};
	if (request.op === "embeddings" || request.op === "similar") {
		const predicate = readScopeSql("m", request.scope, { current: true });
		const live = `e.source_type='memory' AND COALESCE(m.is_deleted,0)=0${predicate.sql}`;
		const args = [...predicate.args];
		if (request.op === "embeddings") {
			const count = db
				.prepare(`SELECT COUNT(*) AS total FROM embeddings e JOIN memories m ON m.id=e.source_id WHERE ${live}`)
				.get(...args);
			const rows = db
				.prepare(
					`SELECT m.id,m.content,m.author_user_id AS authorUserId,m.who,m.importance,m.type,m.tags,m.source_type,m.source_id,m.created_at${request.vectors ? ",hex(e.vector) AS vector_hex,e.dimensions" : ""} FROM embeddings e JOIN memories m ON m.id=e.source_id WHERE ${live} ORDER BY m.created_at DESC,m.id LIMIT ? OFFSET ?`,
				)
				.all(...args, Math.max(1, Math.min(request.limit, 5000)), Math.max(0, request.offset));
			return { rows, total: count?.total ?? 0 };
		}
		if (
			!request.vector.length ||
			request.vector.length > 65536 ||
			request.vector.some((value) => !Number.isFinite(value))
		)
			throw new Error("Invalid query vector");
		const limit = Math.max(1, Math.min(request.limit, 1000));
		const extra = ` AND m.id!=? AND COALESCE(m.source_type,'')!='aggregate-recall'${request.type ? " AND m.type=?" : ""}`;
		const extraArgs = [request.excludeId, ...(request.type ? [request.type] : [])];
		try {
			const projection = activeVectorProjectionTable(db);
			const tables = vecShardTables(request.scope.compartments, db, projection);
			if (!tables.length) throw new Error("Vector index unavailable");
			const candidates = tables.flatMap((table) =>
				db
					.prepare(
						`SELECT e.source_id AS id,v.distance FROM ${table} v JOIN embeddings e ON e.id=v.id JOIN memories m ON m.id=e.source_id WHERE v.embedding MATCH ? AND k=? AND v.rowid IN (SELECT candidate.rowid FROM ${table} candidate JOIN embeddings e ON e.id=candidate.id JOIN memories m ON m.id=e.source_id WHERE ${live}${extra}) ORDER BY v.distance`,
					)
					.all(new Float32Array(request.vector), limit, ...args, ...extraArgs),
			);
			const scores = candidates.flatMap((row) =>
				typeof row.id === "string" && typeof row.distance === "number"
					? [{ id: row.id, score: Math.max(0, 1 - row.distance) }]
					: [],
			);
			return {
				results: scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit),
				completeness: "complete",
			};
		} catch (error) {
			const maxScan = Math.max(1, Math.min(10000, Math.floor((4 * 1024 * 1024) / (request.vector.length * 4))));
			const rows = db
				.prepare(
					`SELECT e.source_id AS id,e.vector FROM embeddings e JOIN memories m ON m.id=e.source_id WHERE ${live}${extra} AND e.dimensions=? AND e.vector IS NOT NULL ORDER BY e.rowid DESC LIMIT ?`,
				)
				.all(...args, ...extraArgs, request.vector.length, maxScan + 1);
			const scores = rows.slice(0, maxScan).flatMap((row) => {
				if (
					typeof row.id !== "string" ||
					!(row.vector instanceof Uint8Array) ||
					row.vector.byteLength !== request.vector.length * 4
				)
					return [];
				const vector = new Float32Array(
					row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength),
				);
				let dot = 0,
					left = 0,
					right = 0;
				for (let index = 0; index < vector.length; index++) {
					dot += vector[index] * request.vector[index];
					left += vector[index] * vector[index];
					right += request.vector[index] * request.vector[index];
				}
				const score = left && right ? Math.max(0, Math.min(1, dot / Math.sqrt(left * right))) : 0;
				return score > 0 ? [{ id: row.id, score }] : [];
			});
			return {
				results: scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit),
				completeness: rows.length > maxScan ? "recent-window" : "complete",
				...(rows.length > maxScan ? { searchedWindow: maxScan } : {}),
				method: "scoped-cosine",
				indexUnavailable: error instanceof Error,
			};
		}
	}
	if (request.op === "summary_expand")
		return expandTemporalNodeInDb(db, request.id, request.agentId, {
			scope: request.scope,
			includeTranscript: request.includeTranscript,
			transcriptCharLimit: request.transcriptCharLimit,
		});
	if (request.op === "shards") return ftsShardTables(request.base, request.scope.compartments, db);
	if (request.op === "documents") {
		const documentTable = request.localGlobal
			? "(SELECT raw.*, 'global' AS read_visibility FROM documents raw)"
			: "documents";
		const predicate = readScopeSql("d", request.scope, {
			visibility: request.localGlobal ? "read_visibility" : null,
			memory: null,
			session: null,
			source: null,
		});
		const memories = readScopeSql("m", request.memoryScope ?? request.scope);
		const where = `d.status!='deleted'${predicate.sql}${request.id ? " AND d.id=?" : ""}${request.status ? " AND d.status=?" : ""}`;
		const args = [...predicate.args, ...(request.id ? [request.id] : []), ...(request.status ? [request.status] : [])];
		if (request.mode === "chunks") {
			const exists = db.prepare(`SELECT d.id FROM ${documentTable} d WHERE ${where}`).get(...args);
			if (!exists) return request.scope.organizationMode !== true ? [] : null;
			return db
				.prepare(
					`SELECT m.id,m.content,m.type,m.created_at,m.author_user_id AS authorUserId,dm.chunk_index FROM document_memories dm JOIN ${documentTable} d ON d.id=dm.document_id JOIN memories m ON m.id=dm.memory_id WHERE ${where} AND COALESCE(m.is_deleted,0)=0${memories.sql} ORDER BY dm.chunk_index,m.id LIMIT 1000`,
				)
				.all(...args, ...memories.args);
		}
		const rows = db
			.prepare(
				`SELECT d.id,d.source_url,d.source_type,d.content_type,d.title,d.status,d.connector_id,d.chunk_count,d.memory_count,d.metadata_json,d.agent_id,d.project,d.created_at,d.updated_at,d.author_user_id AS authorUserId${request.mode === "detail" ? ",d.raw_content" : ""}, (SELECT COUNT(*) FROM document_memories dm JOIN memories m ON m.id=dm.memory_id WHERE dm.document_id=d.id AND COALESCE(m.is_deleted,0)=0${memories.sql}) AS readable_memory_count FROM ${documentTable} d WHERE ${where} ORDER BY d.created_at DESC,d.id LIMIT ? OFFSET ?`,
			)
			.all(
				...memories.args,
				...args,
				request.mode === "detail" ? 1 : Math.max(1, Math.min(request.limit, 500)),
				Math.max(0, request.offset),
			);
		const documents = rows.map(({ readable_memory_count, read_visibility: _visibility, ...row }) => ({
			...row,
			...(request.localGlobal ? {} : { chunk_count: readable_memory_count, memory_count: readable_memory_count }),
		}));
		if (request.mode === "detail") return documents[0] ?? null;
		const count = db.prepare(`SELECT COUNT(*) AS total FROM ${documentTable} d WHERE ${where}`).get(...args);
		return { documents, total: count?.total ?? 0 };
	}
	if (request.op === "transcripts") {
		const predicate = readScopeSql("t", request.scope, {
			visibility: null,
			memory: null,
			session: "session_key",
			source: "source_id",
		});
		const keySql = request.sessionKey ? " AND t.session_key IN (?,?)" : "";
		const keys = request.sessionKey ? [request.sessionKey, request.sessionKey.replace(/^session:/, "")] : [];
		const excludeSql = request.excludeSessionKey ? " AND t.session_key NOT IN (?,?)" : "";
		const excludes = request.excludeSessionKey
			? [request.excludeSessionKey, request.excludeSessionKey.replace(/^session:/, "")]
			: [];
		const columns =
			"t.session_key AS id, t.session_key AS sessionKey, t.agent_id AS agentId, t.project, t.harness, t.created_at AS createdAt, t.updated_at AS updatedAt, t.completed_at AS completedAt, t.speaker_user_id AS authorUserId, t.speaker_user_id AS speakerUserId";
		if (request.mode === "search") {
			const rawQuery = (request.query ?? "").trim();
			const exact = db
				.prepare(
					`SELECT ${columns},substr(t.content,1,1000) AS excerpt,0 AS rank FROM session_transcripts t WHERE t.session_key IN (?,?)${predicate.sql}${keySql}${excludeSql} ORDER BY COALESCE(t.updated_at,t.created_at) DESC,t.rowid LIMIT ?`,
				)
				.all(
					rawQuery,
					rawQuery.replace(/^session:/, ""),
					...predicate.args,
					...keys,
					...excludes,
					Math.max(1, Math.min(request.limit, 20)),
				);
			if (exact.length) return exact;
			const query = (request.query ?? "")
				.split(/\s+/)
				.filter(Boolean)
				.slice(0, 32)
				.map((word) => `"${word.replaceAll('"', '""')}"`)
				.join(" OR ");
			if (!query) return [];
			const tables = ftsShardTables("session_transcripts_fts", request.scope.compartments, db);
			const args: unknown[] = [];
			const branches = tables.map((table) => {
				args.push(query, ...predicate.args, ...keys, ...excludes);
				return `SELECT ${columns}, bm25(${table}) AS rank, snippet(${table},0,'','',' … ',18) AS excerpt FROM ${table} JOIN session_transcripts t ON t.rowid=${table}.rowid WHERE ${table} MATCH ?${predicate.sql}${keySql}${excludeSql}`;
			});
			if (!branches.length) return [];
			return db
				.prepare(`SELECT * FROM (${branches.join(" UNION ALL ")}) ORDER BY rank, updatedAt DESC, id LIMIT ?`)
				.all(...args, Math.max(1, Math.min(request.limit, 20)));
		}
		const rows = db
			.prepare(
				`SELECT ${columns}${request.mode === "detail" ? ",t.content" : ""} FROM session_transcripts t WHERE 1=1${predicate.sql}${keySql} ORDER BY COALESCE(t.updated_at,t.created_at) DESC,t.rowid LIMIT ?`,
			)
			.all(...predicate.args, ...keys, request.mode === "detail" ? 1 : Math.max(1, Math.min(request.limit, 500)));
		return request.mode === "detail" ? (rows[0] ?? null) : rows;
	}
	if (request.op === "summaries") {
		const predicate = readScopeSql("s", request.scope, {
			visibility: null,
			memory: null,
			session: "session_key",
			source: null,
		});
		const child = readScopeSql("child", request.scope, {
			visibility: null,
			memory: null,
			session: "session_key",
			source: null,
		});
		const filters = `${predicate.sql}${request.depth === undefined ? "" : " AND s.depth=?"}${request.sessionKey ? " AND s.session_key=?" : ""}`;
		const args = [
			...predicate.args,
			...(request.depth === undefined ? [] : [request.depth]),
			...(request.sessionKey ? [request.sessionKey] : []),
		];
		const count = db.prepare(`SELECT COUNT(*) AS total FROM session_summaries s WHERE 1=1${filters}`).get(...args);
		const summaries = db
			.prepare(
				`SELECT s.id,s.agent_id,s.project,s.depth,s.kind,s.token_count,s.earliest_at,s.latest_at,s.session_key,s.harness,s.source_type,s.source_ref,s.meta_json,s.created_at, (SELECT COUNT(*) FROM session_summary_children rel JOIN session_summaries child ON child.id=rel.child_id WHERE rel.parent_id=s.id${child.sql}) AS childCount FROM session_summaries s WHERE 1=1${filters} ORDER BY s.latest_at DESC,s.id LIMIT ? OFFSET ?`,
			)
			.all(...child.args, ...args, Math.max(0, Math.min(request.limit, 200)), Math.max(0, request.offset));
		return { summaries, total: count?.total ?? 0 };
	}
	if (request.op === "checkpoints") {
		const predicate = readScopeSql("c", request.scope, {
			visibility: null,
			checkpoint: true,
			project: "project_normalized",
		});
		const session = readScopeSql("checkpoint_session", request.scope, {
			visibility: null,
			memory: null,
			session: "session_key",
			source: "source_id",
		});
		return db
			.prepare(
				`SELECT c.id,c.agent_id,c.session_key,c.harness,c.project,c.project_normalized,c.trigger,c.digest,c.prompt_count,c.memory_queries,c.recent_remembers,c.created_at FROM session_checkpoints c WHERE 1=1${predicate.sql} AND NOT EXISTS(SELECT 1 FROM session_transcripts checkpoint_session WHERE checkpoint_session.agent_id=c.agent_id AND checkpoint_session.session_key=c.session_key AND NOT(1=1${session.sql}))${request.sessionKey ? " AND c.session_key=?" : ""}${request.project ? " AND c.project_normalized=?" : ""} ORDER BY c.created_at DESC,c.rowid DESC LIMIT ?`,
			)
			.all(
				...predicate.args,
				...session.args,
				...(request.sessionKey ? [request.sessionKey] : []),
				...(request.project ? [request.project] : []),
				Math.max(1, Math.min(request.limit, 500)),
			);
	}
	if (request.op === "export_content") {
		if (
			!Number.isSafeInteger(request.offset) ||
			request.offset < 0 ||
			!Number.isSafeInteger(request.length) ||
			request.length < 1 ||
			request.length > 1024 * 1024
		)
			throw new Error("Invalid export byte range");
		const memory = request.table === "memories",
			transcript = request.table === "session_transcripts";
		const access = readScopeSql("r", request.scope, {
			visibility: memory ? "visibility" : null,
			memory: memory ? "id" : null,
			session: memory ? "source_id" : "session_key",
			source: "source_id",
		});
		const author = transcript ? "speaker_user_id" : "author_user_id";
		return (
			db
				.prepare(
					`SELECT hex(substr(CAST(r.content AS BLOB),?,?)) AS content FROM ${request.table} r WHERE r.rowid=? AND r.${author}=? AND length(CAST(r.content AS BLOB))=? AND r.updated_at IS ?${memory || request.table === "memory_artifacts" ? " AND COALESCE(r.is_deleted,0)=0" : ""}${access.sql}`,
				)
				.get(
					request.offset + 1,
					request.length,
					request.row,
					request.author,
					request.expectedBytes,
					request.expectedUpdatedAt,
					...access.args,
				) ?? null
		);
	}
	if (request.op !== "export") throw new Error("Unknown content read operation");
	const transcript = request.table === "session_transcripts";
	const memory = request.table === "memories";
	const predicate = readScopeSql("r", request.scope, {
		visibility: memory ? "visibility" : null,
		memory: memory ? "id" : null,
		session: memory ? "source_id" : "session_key",
		source: "source_id",
	});
	const author = transcript ? "speaker_user_id" : "author_user_id";
	const columns = memory
		? "r.id,r.type,r.importance,r.tags,r.pinned,r.agent_id AS agentId,r.project,r.created_at AS createdAt,r.updated_at AS updatedAt"
		: transcript
			? "r.session_key AS sessionKey,r.agent_id AS agentId,r.project,r.harness,r.created_at AS createdAt,r.updated_at AS updatedAt"
			: "r.agent_id AS agentId,r.source_kind AS sourceKind,r.source_path AS sourcePath,r.captured_at AS capturedAt,r.updated_at AS updatedAt";
	const statement = db.prepare(
		`SELECT ${columns},r.content,r.rowid AS exportCursor,r.${author} AS authorUserId FROM ${request.table} r WHERE r.${author}=? AND r.rowid>?${memory || request.table === "memory_artifacts" ? " AND COALESCE(r.is_deleted,0)=0" : ""}${predicate.sql} ORDER BY r.rowid LIMIT 1`,
	);
	const rows: Record<string, unknown>[] = [];
	let cursor = request.cursor,
		bytes = 0;
	for (let n = 0; n < Math.max(1, Math.min(request.limit, 200)); n++) {
		check();
		const meta = db
			.prepare(
				`SELECT length(CAST(r.content AS BLOB)) AS bytes FROM ${request.table} r WHERE r.${author}=? AND r.rowid>?${memory || request.table === "memory_artifacts" ? " AND COALESCE(r.is_deleted,0)=0" : ""}${predicate.sql} ORDER BY r.rowid LIMIT 1`,
			)
			.get(request.author, cursor, ...predicate.args);
		if (typeof meta?.bytes === "number" && meta.bytes > 4 * 1024 * 1024) {
			if (rows.length) break;
			const large = db
				.prepare(
					`SELECT ${columns},r.rowid AS exportCursor,r.${author} AS authorUserId,length(CAST(r.content AS BLOB)) AS exportContentBytes FROM ${request.table} r WHERE r.${author}=? AND r.rowid>?${memory || request.table === "memory_artifacts" ? " AND COALESCE(r.is_deleted,0)=0" : ""}${predicate.sql} ORDER BY r.rowid LIMIT 1`,
				)
				.get(request.author, cursor, ...predicate.args);
			return large ? [large] : [];
		}

		const row = statement.get(request.author, cursor, ...predicate.args);
		check();
		if (!row) break;
		const size = Buffer.byteLength(JSON.stringify(row));
		check();
		if (rows.length && bytes + size > 4 * 1024 * 1024) break;
		rows.push(row);
		bytes += size;
		if (typeof row.exportCursor !== "number") throw new Error("Invalid export cursor");
		cursor = row.exportCursor;
		if (bytes >= 4 * 1024 * 1024) break;
	}
	return rows;
}

function exportWhere(request: NamedContentReadRequest): string[] {
	const where = [request.scope.reach.kind === "all" ? "? IS NOT NULL" : "agent_id = ?"];
	const filters = request.filters;
	if (filters?.harnesses) where.push(`harness IN (${Array.from({ length: filters.harnesses }, () => "?").join(",")})`);
	if (filters?.since) where.push("created_at >= ?");
	if (filters?.until) where.push("created_at <= ?");
	return where;
}
function namedReadStatement(request: NamedContentReadRequest): {
	sql: string;
	tables: readonly string[];
	result: "all" | "get";
} {
	const params = request.parameters;
	switch (request.op) {
		case "sources.stats_artifacts":
			return {
				sql:
					params.length === 4
						? `SELECT COUNT(*) AS n FROM memory_artifacts
				 WHERE ? IS NOT NULL AND (source_id = ? OR (harness = 'obsidian' AND source_id IS NULL AND source_path >= ? AND source_path < ?))
				   AND COALESCE(is_deleted, 0) = 0`
						: `SELECT COUNT(*) AS n FROM memory_artifacts
				 WHERE ? IS NOT NULL AND source_id = ? AND COALESCE(is_deleted, 0) = 0`,
				tables: ["memory_artifacts"],
				result: "get",
			};
		case "sources.stats_chunks":
			return {
				sql: `SELECT COUNT(*) AS n FROM embeddings WHERE ? IS NOT NULL AND source_type IN (?, ?) AND source_id >= ? AND source_id < ?`,
				tables: ["embeddings"],
				result: "get",
			};
		case "sources.health_orphan_chunks":
			return {
				sql: `SELECT rowid, source_id,
		        CASE WHEN instr(tail, char(10)) > 0 THEN substr(tail, 1, instr(tail, char(10)) - 1) ELSE tail END AS chunk_text
		 FROM (
		   SELECT rowid, source_id,
		          CASE WHEN header_at > 0 THEN substr(framed, header_at + 1, 1024) END AS tail
		   FROM (
		     SELECT rowid, source_id, char(10) || chunk_text AS framed,
		            instr(char(10) || lower(chunk_text), char(10) || 'source_path:') AS header_at
		     FROM embeddings
		     WHERE ? IS NOT NULL AND source_type IN (?, ?) AND source_id >= ? AND source_id < ? AND rowid > ?
		     ORDER BY rowid LIMIT ?
		   )
		 )`,
				tables: ["embeddings"],
				result: "all",
			};
		case "sources.health_live_paths":
			return {
				sql:
					params.length === 6
						? `SELECT rowid, source_path FROM memory_artifacts
			 WHERE ? IS NOT NULL AND COALESCE(is_deleted, 0) = 0
			   AND (source_id = ? OR (harness = 'obsidian' AND source_id IS NULL AND source_path >= ? AND source_path < ?))
			   AND rowid > ?
			 ORDER BY rowid LIMIT ?`
						: `SELECT rowid, source_path FROM memory_artifacts
		 WHERE ? IS NOT NULL AND source_id = ? AND COALESCE(is_deleted, 0) = 0 AND rowid > ?
		 ORDER BY rowid LIMIT ?`,
				tables: ["memory_artifacts"],
				result: "all",
			};
		case "sources.health_artifacts":
			return {
				sql:
					params.length === 4
						? `SELECT MAX(updated_at) AS latestArtifactAt,
			        SUM(CASE WHEN COALESCE(is_deleted, 0) = 1 THEN 1 ELSE 0 END) AS deletedArtifacts
			   FROM memory_artifacts WHERE ? IS NOT NULL
			     AND (source_id = ? OR (harness = 'obsidian' AND source_id IS NULL AND source_path >= ? AND source_path < ?))`
						: `SELECT MAX(updated_at) AS latestArtifactAt,
			        SUM(CASE WHEN COALESCE(is_deleted, 0) = 1 THEN 1 ELSE 0 END) AS deletedArtifacts
			   FROM memory_artifacts WHERE ? IS NOT NULL AND source_id = ?`,
				tables: ["memory_artifacts"],
				result: "get",
			};
		case "sources.health_failures":
			return {
				sql: `SELECT source_meta_json
			   FROM memory_artifacts
			  WHERE ? IS NOT NULL AND source_id = ?
			    AND source_kind = ? AND COALESCE(is_deleted, 0) = 0`,
				tables: ["memory_artifacts"],
				result: "all",
			};
		case "sources.health_discord":
			return {
				sql: `SELECT source_kind, source_meta_json, updated_at FROM memory_artifacts WHERE ? IS NOT NULL AND source_id = ? AND source_kind IN ('source_discord_failure', 'source_discord_checkpoint') AND COALESCE(is_deleted, 0) = 0`,
				tables: ["memory_artifacts"],
				result: "all",
			};
		case "sources.health_entities":
			return {
				sql: `SELECT COUNT(*) AS n FROM entities WHERE ? IS NOT NULL AND source_id = ?`,
				tables: ["entities"],
				result: "get",
			};
		case "sources.health_document_entity":
			return {
				sql: `SELECT id FROM entities WHERE ? IS NOT NULL AND source_id = ? AND entity_type = 'source_document' ORDER BY updated_at DESC LIMIT 1`,
				tables: ["entities"],
				result: "get",
			};
		case "sources.health_aspects":
			return {
				sql: `SELECT COUNT(*) AS n FROM entity_aspects AS a JOIN entities AS e ON e.id = a.entity_id AND e.agent_id = a.agent_id WHERE ? IS NOT NULL AND e.source_id = ?`,
				tables: ["entities", "entity_aspects"],
				result: "get",
			};
		case "sources.health_attributes":
			return {
				sql: `SELECT COUNT(*) AS n FROM entity_attributes WHERE ? IS NOT NULL AND source_id = ?`,
				tables: ["entity_attributes"],
				result: "get",
			};
		case "sources.health_dependencies":
			return {
				sql: `SELECT COUNT(*) AS n FROM entity_dependencies WHERE ? IS NOT NULL AND source_id = ?`,
				tables: ["entity_dependencies"],
				result: "get",
			};
		case "sources.health_communities":
			return {
				sql: `SELECT COUNT(*) AS n FROM entity_communities WHERE ? IS NOT NULL AND source_id = ?`,
				tables: ["entity_communities"],
				result: "get",
			};
		case "sources.import.list":
			return {
				sql: `SELECT id,kind,agent_id,schema_id,adapter_version,state,control_request,generation,total,imported,duplicate,rejected,pending,error,created_at,updated_at,started_at,completed_at,reconciled_at FROM source_import_jobs WHERE ${request.scope.reach.kind === "all" ? "? IS NOT NULL" : "agent_id = ?"} ORDER BY created_at DESC LIMIT 100`,
				tables: ["source_import_records", "source_import_files", "source_import_jobs"],
				result: "all",
			};
		case "sources.import.export":
			return {
				sql: `SELECT speaker_user_id,session_key,length(CAST(content AS BLOB)) AS bytes,harness,project,agent_id,created_at FROM session_transcripts WHERE ${exportWhere(request).join(" AND ")} ${request.filters?.cursor ? "AND (created_at,session_key,agent_id) > (?,?,?)" : ""} ORDER BY created_at,session_key,agent_id LIMIT 1 OFFSET ?`,
				tables: ["session_transcripts"],
				result: "get",
			};
		case "sources.import.export.content":
			return {
				sql: "SELECT hex(substr(CAST(content AS BLOB),?,1048576)) AS content FROM session_transcripts WHERE agent_id = ? AND session_key = ? AND created_at = ? AND length(CAST(content AS BLOB)) = ?",
				tables: ["session_transcripts"],
				result: "get",
			};
		case "sources.import.status":
			return {
				sql: `SELECT id,kind,agent_id,schema_id,adapter_version,state,control_request,generation,total,imported,duplicate,rejected,pending,error,created_at,updated_at,started_at,completed_at,reconciled_at FROM source_import_jobs WHERE id = ? AND ${request.scope.reach.kind === "all" ? "? IS NOT NULL" : "agent_id = ?"}`,
				tables: ["source_import_records", "source_import_files", "source_import_jobs"],
				result: "get",
			};
		case "sources.import.files":
			return {
				sql: `SELECT id,job_id,source_id,agent_id,ordinal,name,size_bytes,state,record_count,created_at,updated_at,upload_generation,upload_offset,upload_size,upload_digest,storage_state FROM source_import_files WHERE job_id = ? AND ${request.scope.reach.kind === "all" ? "? IS NOT NULL" : "agent_id = ?"} ORDER BY ordinal`,
				tables: ["source_import_records", "source_import_files", "source_import_jobs"],
				result: "all",
			};
		case "sources.import.rejections":
			return {
				sql: `SELECT id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_length,status,canonical_id,canonical_key,rejection_code,created_at,updated_at FROM source_import_records WHERE job_id = ? AND ${request.scope.reach.kind === "all" ? "? IS NOT NULL" : "agent_id = ?"} AND status = 'rejected' AND id > ? ORDER BY id LIMIT 100`,
				tables: ["source_import_records", "source_import_files", "source_import_jobs"],
				result: "all",
			};
		case "sources.import.reconciliation":
			return {
				sql: `SELECT total,imported,duplicate,rejected,pending FROM source_import_jobs WHERE id = ? AND ${request.scope.reach.kind === "all" ? "? IS NOT NULL" : "agent_id = ?"}`,
				tables: ["source_import_records", "source_import_files", "source_import_jobs"],
				result: "all",
			};
		case "memory.projection.threads":
			return {
				sql: `SELECT label,source_type,latest_at,sample,node_id,project,session_key,harness FROM memory_thread_heads WHERE agent_id=? ORDER BY latest_at DESC,thread_key LIMIT 12`,
				tables: ["memory_thread_heads"],
				result: "all",
			};
		case "memory.projection.top":
			return {
				sql: `SELECT m.id,m.content,m.type,m.importance,m.project FROM memories m WHERE m.is_deleted=0 ORDER BY m.pinned DESC,m.importance DESC,m.created_at DESC,m.id LIMIT 32`,
				tables: ["memories"],
				result: "all",
			};
		case "memory.projection.temporal":
			return {
				sql: `SELECT id,kind,COALESCE(source_type,kind) AS source_type,depth,latest_at,project,session_key,source_ref,content FROM session_summaries WHERE agent_id=? ORDER BY latest_at DESC,id LIMIT 20`,
				tables: ["session_summaries"],
				result: "all",
			};
		case "memory.projection.ledger":
			return {
				sql: `SELECT agent_id,source_path,source_sha256,source_kind,session_id,session_key,session_token,project,harness,captured_at,started_at,ended_at,source_node_id,memory_sentence,memory_sentence_quality,content FROM memory_artifacts WHERE agent_id=? AND source_kind IN ('summary','transcript','compaction','manifest') AND COALESCE(ended_at,captured_at)>=? ORDER BY COALESCE(ended_at,captured_at) DESC,captured_at DESC LIMIT 5000`,
				tables: ["memory_artifacts"],
				result: "all",
			};
	}
}

function sessionReadOwners(scope: ReadScope, keys: readonly string[] = []): { cte: string; args: readonly unknown[] } {
	const keyWhere = (alias = "") =>
		keys.length ? ` WHERE ${alias}session_key IN (${keys.map(() => "?").join(",")})` : "";

	const access = readScopeSql("t", scope, {
		visibility: null,
		memory: null,
		session: "session_key",
		source: "source_id",
	});
	const blocked =
		scope.compartments === "all"
			? ""
			: ` AND (t.is_claim=0 OR NOT EXISTS(SELECT 1 FROM classification_assignments ca WHERE ca.agent_id=t.agent_id AND (ca.target_kind='agent' OR (ca.target_kind='session' AND ca.target_id=t.session_key)) AND NOT EXISTS(SELECT 1 FROM compartment_members readable_label WHERE readable_label.classification_id=ca.classification_id AND readable_label.compartment_id IN (${scope.compartments.map(() => "?").join(",") || "NULL"}))))`;
	const cte = `WITH known_owners AS (SELECT session_key,agent_id FROM session_transcripts${keyWhere()} UNION SELECT session_key,agent_id FROM session_claims${keyWhere()} UNION SELECT session_key,agent_id FROM session_summaries${keyWhere()}), owners AS (SELECT session_key,agent_id,compartment_id,project,source_id,0 AS is_claim FROM session_transcripts${keyWhere()} UNION ALL SELECT session_key,agent_id,NULL,NULL,NULL,1 FROM session_claims${keyWhere()} UNION ALL SELECT session_key,agent_id,compartment_id,project,NULL,0 FROM session_summaries${keyWhere()} UNION ALL SELECT c.session_key,COALESCE(c.agent_id,k.agent_id),c.compartment_id,c.project,NULL,0 FROM session_checkpoints c LEFT JOIN known_owners k ON c.agent_id IS NULL AND k.session_key=c.session_key${keyWhere("c.")}),readable AS (SELECT t.session_key,t.agent_id,t.compartment_id,t.project,t.source_id,t.is_claim FROM owners t WHERE 1=1${access.sql}${blocked}),readable_sessions AS (SELECT DISTINCT t.session_key FROM readable t WHERE NOT EXISTS(SELECT 1 FROM owners o WHERE o.session_key=t.session_key AND NOT EXISTS(SELECT 1 FROM readable r WHERE r.session_key=o.session_key AND r.agent_id IS o.agent_id AND r.compartment_id IS o.compartment_id AND r.project IS o.project AND r.source_id IS o.source_id AND r.is_claim=o.is_claim)))`;
	return {
		cte,
		args: [
			...Array.from({ length: 7 }, () => keys).flat(),
			...access.args,
			...(blocked && scope.compartments !== "all" ? scope.compartments : []),
		],
	};
}
