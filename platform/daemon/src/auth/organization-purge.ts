import { audienceSubjectFromPrincipal, readScopeSql, resolveReadScope, type ReadScope } from "../read-scope";
import { prepareTypedStatement, type WriteDb } from "../db-accessor";
import { dbOwnerOrganizationPurge, dbOwnerTranscriptOperation, getDbOwner } from "../db-owner-runtime";
import type { TranscriptDeleteResult } from "../session-transcript-lifecycle";
import {
	derivedPurgeOutcome,
	purgeArtifactRecordInTx,
	purgeDocumentRecordInTx,
	purgeMemoryEmbeddingsInTx,
	purgeMemoryInTx,
	purgeSummaryRecordInTx,
} from "../source-purge-tx";
import { auditAuthoredWriteInTx, type WriteAuthor } from "./audit-owner";
import { auditStatement, organizationQuery, organizationWrite, statement } from "./organization-store";
import { markDerivedMemoriesStaleForSourceInTx } from "../derived-memory-provenance";
import { enqueueDreamingAttentionInTx } from "../pipeline/dreaming-attention";
import type { Principal } from "./principal";

export interface PurgeBatchResult {
	removed: number;
	remaining: number;
	counts: Record<string, number>;
	blocked: boolean;
	hiddenMaterialRemains: boolean;
}
function purgeReadClause(
	scope: ReadScope | undefined,
	kind: "memory" | "artifact" | "document" | "summary" | "transcript" | "cold",
	alias: string,
	classificationId?: string,
) {
	if (!scope) return { sql: "", args: [] };
	const clause =
		kind === "memory"
			? readScopeSql(alias, scope)
			: readScopeSql(alias, scope, {
					visibility: null,
					memory: null,
					session: kind === "document" || kind === "cold" ? null : "session_key",
					source: kind === "artifact" || kind === "transcript" ? "source_id" : null,
				});
	return classificationId
		? {
				sql: `${clause.sql} AND EXISTS(SELECT 1 FROM compartment_members cm WHERE cm.compartment_id=${alias}.compartment_id AND cm.classification_id=?)`,
				args: [...clause.args, classificationId],
			}
		: clause;
}
function authoredPurgedEvidenceMemory(alias: string): string {
	return `EXISTS(SELECT 1 FROM audit_events a WHERE a.action IN ('session.purged','memory.purged','artifact.purged','summary.purged') AND a.agent_id=${alias}.agent_id AND json_extract(a.detail_json,'$.offboardUserId')=? AND (${alias}.source_id IN (a.target_id,'session:'||a.target_id) OR EXISTS(SELECT 1 FROM derived_memory_sources d WHERE d.derived_memory_id=${alias}.id AND d.agent_id=${alias}.agent_id AND d.source_kind=CASE WHEN a.target_kind='session' THEN 'transcript' ELSE a.target_kind END AND d.source_id IN (a.target_id,'session:'||a.target_id))))`;
}
function planAuthoredMemoryPurgeInTx(
	db: WriteDb,
	userId: string,
	options: {
		readonly scope?: ReadScope;
		readonly preview?: boolean;
		readonly agentId?: string;
		readonly classificationId?: string;
	} = {},
) {
	const memoryScope = purgeReadClause(options.scope, "memory", "m", options.classificationId);
	const documentScope = purgeReadClause(options.scope, "document", "d", options.classificationId);
	const artifactScope = purgeReadClause(options.scope, "artifact", "a", options.classificationId);
	const summaryScope = purgeReadClause(options.scope, "summary", "s", options.classificationId);
	const transcriptScope = purgeReadClause(options.scope, "transcript", "t", options.classificationId);
	const coldScope = purgeReadClause(options.scope, "cold", "c", options.classificationId);
	const cold = prepareTypedStatement<{ archive_id: string }>(
		db,
		`SELECT c.archive_id FROM memories_cold c WHERE c.${options.agentId ? "agent_id" : "author_user_id"}=? AND c.provenance_resolved=1${coldScope.sql} LIMIT ?`,
	).all(options.agentId ?? userId, ...coldScope.args, options.preview ? 1001 : 50);
	const rootLimit = options.preview ? 1001 : 50;
	const agentId = options.agentId;
	const evidenceLimit = options.preview ? 1001 : 1;
	const roots = prepareTypedStatement<{ id: string }>(
		db,
		`SELECT m.id FROM memories m WHERE ${agentId ? "m.agent_id=?" : `(m.author_user_id=? OR ${authoredPurgedEvidenceMemory("m")} OR EXISTS(SELECT 1 FROM session_transcripts t WHERE t.speaker_user_id=? AND t.agent_id=m.agent_id AND m.source_id IN (t.session_key,'session:'||t.session_key) AND (m.type='session_summary' OR m.source_type IN ('transcript','session','session_summary','checkpoint'))${transcriptScope.sql}))`}${memoryScope.sql} LIMIT ?`,
	).all(...(agentId ? [agentId] : [userId, userId, userId, ...transcriptScope.args]), ...memoryScope.args, rootLimit);
	const transcripts = prepareTypedStatement<{ agent_id: string; session_key: string }>(
		db,
		`SELECT t.agent_id,t.session_key FROM session_transcripts t WHERE t.${agentId ? "agent_id" : "speaker_user_id"}=?${transcriptScope.sql} LIMIT ?`,
	).all(agentId ?? userId, ...transcriptScope.args, rootLimit);
	const documents = prepareTypedStatement<{ id: string; agent_id: string }>(
		db,
		`SELECT d.id,d.agent_id FROM documents d WHERE d.${agentId ? "agent_id" : "author_user_id"}=?${documentScope.sql} LIMIT ?`,
	).all(agentId ?? userId, ...documentScope.args, evidenceLimit);
	const artifacts = prepareTypedStatement<{ source_path: string; source_id: string | null; agent_id: string }>(
		db,
		`SELECT a.source_path,a.source_id,a.agent_id FROM memory_artifacts a WHERE ${agentId ? "a.agent_id=?" : `(a.author_user_id=? OR (a.source_kind IN ('transcript','summary','compaction','manifest') AND EXISTS(SELECT 1 FROM session_transcripts t WHERE t.speaker_user_id=? AND t.agent_id=a.agent_id AND COALESCE(NULLIF(a.session_key,''),a.session_id) IN (t.session_key,'session:'||t.session_key)${transcriptScope.sql})))`}${artifactScope.sql} LIMIT ?`,
	).all(...(agentId ? [agentId] : [userId, userId, ...transcriptScope.args]), ...artifactScope.args, evidenceLimit);
	const summaries = prepareTypedStatement<{ id: string; agent_id: string }>(
		db,
		`SELECT s.id,s.agent_id FROM session_summaries s WHERE ${agentId ? "s.agent_id=?" : `(s.author_user_id=? OR EXISTS(SELECT 1 FROM session_transcripts t WHERE t.speaker_user_id=? AND t.agent_id=s.agent_id AND s.session_key IN (t.session_key,'session:'||t.session_key)${transcriptScope.sql}))`}${summaryScope.sql} LIMIT ?`,
	).all(...(agentId ? [agentId] : [userId, userId, ...transcriptScope.args]), ...summaryScope.args, evidenceLimit);
	const exceeded =
		options.preview &&
		[cold.length, roots.length, documents.length, artifacts.length, summaries.length, transcripts.length].some(
			(n) => n > 1000,
		);
	if (exceeded) throw new Error("plan_limit");
	for (const doc of documents) {
		roots.push(
			...prepareTypedStatement<{ id: string }>(
				db,
				`SELECT m.id FROM document_memories d JOIN memories m ON m.id=d.memory_id WHERE d.document_id=?${memoryScope.sql} LIMIT ?`,
			).all(doc.id, ...memoryScope.args, rootLimit),
		);
		if (roots.length > 1000) throw new Error("plan_limit");
	}
	const nodes = prepareTypedStatement<{ kind: "memory" | "summary"; id: string }>(
		db,
		`WITH RECURSIVE affected(kind,id,agent_id) AS (
 SELECT 'memory',m.id,m.agent_id FROM memories m WHERE m.id IN (SELECT value FROM json_each(?))
 UNION SELECT 'summary',s.id,s.agent_id FROM session_summaries s WHERE s.id IN (SELECT value FROM json_each(?))
 UNION SELECT 'artifact',json_extract(value,'$.source_path'),json_extract(value,'$.agent_id') FROM json_each(?)
 UNION SELECT 'transcript',json_extract(value,'$.session_key'),json_extract(value,'$.agent_id') FROM json_each(?)
 UNION SELECT 'transcript','session:'||json_extract(value,'$.session_key'),json_extract(value,'$.agent_id') FROM json_each(?)
 UNION SELECT 'memory',m.id,m.agent_id FROM derived_memory_sources d JOIN affected a ON d.source_kind=a.kind AND d.source_id=a.id AND (a.kind IN ('memory','summary') OR d.agent_id=a.agent_id) JOIN memories m ON m.id=d.derived_memory_id WHERE 1=1${memoryScope.sql}
 UNION SELECT 'memory',m.id,m.agent_id FROM aggregate_memory_sources g JOIN affected a ON a.kind='memory' AND g.source_memory_id=a.id JOIN memories m ON m.id=g.aggregate_memory_id WHERE 1=1${memoryScope.sql}
 UNION SELECT 'memory',m.id,m.agent_id FROM aggregate_evidence_sources e JOIN affected a ON e.source_kind=a.kind AND e.source_id=a.id AND (a.kind IN ('memory','summary') OR e.agent_id=a.agent_id) JOIN memories m ON m.id=e.aggregate_memory_id WHERE 1=1${memoryScope.sql}
 UNION SELECT 'summary',s.id,s.agent_id FROM session_summary_memories g JOIN affected a ON a.kind='memory' AND g.memory_id=a.id JOIN session_summaries s ON s.id=g.summary_id WHERE 1=1${summaryScope.sql}
 UNION SELECT 'summary',s.id,s.agent_id FROM session_summary_children g JOIN affected a ON a.kind='summary' AND g.child_id=a.id JOIN session_summaries s ON s.id=g.parent_id WHERE 1=1${summaryScope.sql} LIMIT 1001)
 SELECT kind,id FROM affected`,
	).all(
		JSON.stringify([...new Set(roots.map((r) => r.id))]),
		JSON.stringify(summaries.map((s) => s.id)),
		JSON.stringify(artifacts),
		JSON.stringify(transcripts),
		JSON.stringify(transcripts),
		...memoryScope.args,
		...memoryScope.args,
		...memoryScope.args,
		...summaryScope.args,
		...summaryScope.args,
	);
	const candidates = prepareTypedStatement<{
		id: string;
		agent_id: string;
		pinned: number;
		source_id: string | null;
		source_type: string | null;
	}>(
		db,
		"SELECT id,agent_id,pinned,source_id,source_type FROM memories WHERE id IN (SELECT value FROM json_each(?))",
	).all(JSON.stringify(nodes.filter((n) => n.kind === "memory").map((n) => n.id)));
	const affected = new Set(nodes.map((node) => `${node.kind}:${node.id}`));
	for (const artifact of artifacts) affected.add(`artifact:${artifact.source_path}`);
	for (const transcript of transcripts) {
		affected.add(`transcript:${transcript.session_key}`);
		affected.add(`transcript:session:${transcript.session_key}`);
	}
	const citations = prepareTypedStatement<{ derived_memory_id: string; source_kind: string; source_id: string }>(
		db,
		"SELECT derived_memory_id,source_kind,source_id FROM derived_memory_sources WHERE derived_memory_id IN (SELECT value FROM json_each(?)) LIMIT 1001",
	).all(JSON.stringify(candidates.map((row) => row.id)));
	if (citations.length > 1000) throw new Error("plan_limit");
	for (const citation of citations) {
		if (citation.source_kind !== "transcript") continue;
		if (
			db
				.prepare(
					"SELECT 1 FROM audit_events WHERE action='session.purged' AND json_extract(detail_json,'$.offboardUserId')=? AND ? IN (target_id,'session:'||target_id) LIMIT 1",
				)
				.get(userId, citation.source_id)
		)
			affected.add(`transcript:${citation.source_id}`);
	}
	const mixed = new Set<string>();
	for (;;) {
		let changed = false;
		for (const row of candidates) {
			if (mixed.has(row.id)) continue;
			const survivingCitation = citations.some(
				(citation) =>
					citation.derived_memory_id === row.id && !affected.has(`${citation.source_kind}:${citation.source_id}`),
			);
			const survivingProvenance =
				row.source_id !== null &&
				row.source_type !== null &&
				!affected.has(
					`${["session", "session_summary", "checkpoint"].includes(row.source_type) ? "transcript" : row.source_type}:${row.source_id}`,
				);
			if (
				derivedPurgeOutcome(false, survivingCitation, survivingProvenance) === "mixed" &&
				citations.some((citation) => citation.derived_memory_id === row.id)
			) {
				mixed.add(row.id);
				affected.delete(`memory:${row.id}`);
				changed = true;
			}
		}
		if (!changed) break;
	}
	const rows = candidates.filter((row) => !mixed.has(row.id));
	const retainedMixed = candidates
		.filter((row) => mixed.has(row.id))
		.map((row) => ({
			...row,
			citations: citations.filter(
				(citation) =>
					citation.derived_memory_id === row.id && affected.has(`${citation.source_kind}:${citation.source_id}`),
			),
		}));
	const affectedSummaries = prepareTypedStatement<{ id: string; agent_id: string }>(
		db,
		"SELECT id,agent_id FROM session_summaries WHERE id IN (SELECT value FROM json_each(?))",
	).all(JSON.stringify(nodes.filter((n) => n.kind === "summary").map((n) => n.id)));
	const blocked = nodes.length > 1000 || rows.some((row) => row.pinned === 1);
	if (options.preview && nodes.length > 1000) throw new Error("plan_limit");
	return { cold, rows, retainedMixed, documents, artifacts, affectedSummaries, transcripts, blocked };
}
export function planOffboardPurgeInTx(
	db: WriteDb,
	userId: string,
	scope: ReadScope,
	classificationId?: string,
): Record<string, number> {
	const plan = planAuthoredMemoryPurgeInTx(db, userId, { scope, preview: true, classificationId });
	return {
		cold: plan.cold.length,
		memories: plan.rows.length,
		documents: plan.documents.length,
		artifacts: plan.artifacts.length,
		summaries: plan.affectedSummaries.length,
		transcripts: plan.transcripts.length,
	};
}
export function purgeAuthoredMemoryBatchInTx(
	db: WriteDb,
	userId: string,
	author: WriteAuthor,
	options: { readonly agentId?: string; readonly scope?: ReadScope; readonly classificationId?: string } = {},
): PurgeBatchResult {
	const count = (sql: string, ...args: string[]) => prepareTypedStatement<{ n: number }>(db, sql).get(...args)?.n ?? 0;
	const { cold, rows, retainedMixed, documents, artifacts, affectedSummaries, blocked } = planAuthoredMemoryPurgeInTx(
		db,
		userId,
		options,
	);
	const detail = options.agentId ? { purgedAgentId: options.agentId } : { offboardUserId: userId };
	const counts: Record<string, number> = { memories: 0, documents: 0, memory_artifacts: 0, session_summaries: 0 };
	if (!blocked) {
		for (const row of cold) {
			db.prepare("DELETE FROM memories_cold WHERE archive_id=?").run(row.archive_id);
			counts.memories_cold = (counts.memories_cold ?? 0) + 1;
		}
		for (const memory of retainedMixed) {
			for (const citation of memory.citations) {
				markDerivedMemoriesStaleForSourceInTx(db, {
					agentId: memory.agent_id,
					sourceKind: citation.source_kind,
					sourceId: citation.source_id,
					staleAt: new Date().toISOString(),
					derivedMemoryId: memory.id,
				});
				db.prepare(
					"DELETE FROM derived_memory_sources WHERE agent_id=? AND derived_memory_id=? AND source_kind=? AND source_id=?",
				).run(memory.agent_id, memory.id, citation.source_kind, citation.source_id);
			}
			enqueueDreamingAttentionInTx(db, {
				agentId: memory.agent_id,
				kind: "evidence_requeue",
				subjectRef: `memory:${memory.id}`,
				details: { reason: "source_removed" },
				priority: 60,
				reopen: true,
			});
		}
		for (const row of rows) {
			purgeMemoryEmbeddingsInTx(db, row.id, options.scope);
			purgeMemoryInTx(db, row.id, options.scope);
			auditAuthoredWriteInTx(db, author, "memory.purged", "memory", row.id, row.agent_id, detail);
			counts.memories = (counts.memories ?? 0) + 1;
		}
		for (const doc of documents)
			if (!count("SELECT COUNT(*) AS n FROM document_memories WHERE document_id=?", doc.id)) {
				purgeDocumentRecordInTx(db, doc.id, options.scope);
				counts.documents = (counts.documents ?? 0) + 1;
				auditAuthoredWriteInTx(db, author, "document.purged", "document", doc.id, doc.agent_id, detail);
			}
		for (const artifact of artifacts)
			if (
				!count(
					"SELECT COUNT(*) AS n FROM derived_memory_sources d JOIN memories m ON m.id=d.derived_memory_id WHERE d.source_kind='artifact' AND d.source_id=? AND d.agent_id=?",
					artifact.source_path,
					artifact.agent_id,
				)
			) {
				purgeArtifactRecordInTx(db, artifact, options.scope);
				counts.memory_artifacts = (counts.memory_artifacts ?? 0) + 1;
				auditAuthoredWriteInTx(
					db,
					author,
					"artifact.purged",
					"artifact",
					artifact.source_path,
					artifact.agent_id,
					detail,
				);
			}
		for (const summary of affectedSummaries) {
			purgeSummaryRecordInTx(db, summary.id, summary.agent_id, options.scope);
			counts.session_summaries = (counts.session_summaries ?? 0) + 1;
			auditAuthoredWriteInTx(db, author, "summary.purged", "summary", summary.id, summary.agent_id, detail);
		}
	}
	const pending = planAuthoredMemoryPurgeInTx(db, userId, options);
	const remaining =
		pending.cold.length +
		pending.rows.length +
		pending.documents.length +
		pending.artifacts.length +
		pending.affectedSummaries.length;
	let hiddenMaterialRemains = false;
	if (options.scope) {
		for (const [table, kind, column] of [
			["memories_cold", "cold", "author_user_id"],
			["memories", "memory", "author_user_id"],
			["documents", "document", "author_user_id"],
			["memory_artifacts", "artifact", "author_user_id"],
			["session_summaries", "summary", "author_user_id"],
			["session_transcripts", "transcript", "speaker_user_id"],
		] as const) {
			const visible = purgeReadClause(options.scope, kind, "r", options.classificationId);
			const hidden = prepareTypedStatement<{ compartment_id: number | null; n: number }>(
				db,
				`SELECT r.compartment_id,COUNT(*) AS n FROM ${table} r WHERE (r.${column}=?${table === "memories" ? ` OR ${authoredPurgedEvidenceMemory("r")}` : ""}) AND NOT (1=1${visible.sql}) GROUP BY r.compartment_id`,
			).all(userId, ...(table === "memories" ? [userId] : []), ...visible.args);
			for (const row of hidden) {
				hiddenMaterialRemains = true;
				auditAuthoredWriteInTx(db, author, "purge.hidden_material", "user", userId, null, {
					ownerOnly: true,
					compartmentId: row.compartment_id,
					table,
					count: row.n,
				});
			}
		}
	}
	return { removed: counts.memories ?? 0, remaining, counts, blocked, hiddenMaterialRemains };
}
async function purgeResidual(
	userId: string,
	jobId: string,
	scope?: ReadScope,
	classificationId?: string,
): Promise<Record<string, number>> {
	const residual: Record<string, number> = {};
	for (const [table, column] of [
		["memories_cold", "author_user_id"],
		["memories", "author_user_id"],
		["documents", "author_user_id"],
		["memory_artifacts", "author_user_id"],
		["session_transcripts", "speaker_user_id"],
	]) {
		const clause = purgeReadClause(
			scope,
			table === "memories_cold"
				? "cold"
				: table === "memories"
					? "memory"
					: table === "documents"
						? "document"
						: table === "memory_artifacts"
							? "artifact"
							: "transcript",
			"r",
			classificationId,
		);
		const row = await organizationQuery<{ n: number }>(
			statement(
				`SELECT COUNT(*) AS n FROM ${table} r WHERE r.${column}=?${clause.sql}`,
				[userId, ...clause.args],
				"get",
			),
		);
		residual[table ?? ""] = row.n;
	}
	for (const table of ["session_summaries", "session_claims", "memory_thread_heads", "session_memories"]) {
		if (scope && table !== "session_summaries") continue;
		const clause =
			table === "session_summaries" ? purgeReadClause(scope, "summary", "s", classificationId) : { sql: "", args: [] };
		const row = await organizationQuery<{ n: number }>(
			statement(
				`SELECT COUNT(*) AS n FROM ${table} s WHERE (${table === "session_summaries" ? "s.author_user_id=? OR " : ""}EXISTS (SELECT 1 FROM audit_events a WHERE a.target_kind='session' AND a.action='session.purged' AND a.agent_id=s.agent_id AND s.session_key IN (a.target_id,'session:'||a.target_id) AND json_extract(a.detail_json,'$.offboardUserId')=? AND json_extract(a.detail_json,'$.jobId')=?))${clause.sql}`,
				[...(table === "session_summaries" ? [userId, userId, jobId] : [userId, jobId]), ...clause.args],
				"get",
			),
		);
		residual[table] = row.n;
	}
	const memoryScope = purgeReadClause(scope, "memory", "m", classificationId);
	const retained = `SELECT DISTINCT m.id FROM memories m JOIN session_transcript_deleted_sources d ON d.kind='memory' AND d.id=m.id AND d.agent_id=m.agent_id JOIN audit_events a ON a.action='session.purged' AND a.target_kind='session' AND a.target_id=d.session_key AND a.agent_id=d.agent_id AND json_extract(a.detail_json,'$.generation')=d.generation WHERE json_extract(a.detail_json,'$.offboardUserId')=? AND json_extract(a.detail_json,'$.jobId')=?${memoryScope.sql}`;
	const derived = `SELECT DISTINCT m.id FROM memories m JOIN derived_memory_sources d ON d.derived_memory_id=m.id WHERE EXISTS (SELECT 1 FROM audit_events a WHERE a.target_kind=d.source_kind AND a.target_id=d.source_id AND a.agent_id=d.agent_id AND a.action IN ('memory.purged','artifact.purged','summary.purged') AND json_extract(a.detail_json,'$.offboardUserId')=?)${memoryScope.sql}`;
	const row = await organizationQuery<{ n: number }>(
		statement(
			`SELECT COUNT(*) AS n FROM (${derived} UNION ${retained})`,
			[userId, ...memoryScope.args, userId, jobId, ...memoryScope.args],
			"get",
		),
	);
	residual.derived_memories = row.n;
	const memories = await organizationQuery<{ n: number }>(
		statement(
			`SELECT COUNT(*) AS n FROM memories m WHERE (m.author_user_id=? OR m.id IN (${derived} UNION ${retained}))${memoryScope.sql}`,
			[userId, userId, ...memoryScope.args, userId, jobId, ...memoryScope.args, ...memoryScope.args],
			"get",
		),
	);
	residual.memories = memories.n;

	return residual;
}
export async function runOffboardPurge(
	p: Principal,
	jobId: string,
	userId: string,
	basePath: string,
	classificationId?: string,
): Promise<void> {
	const deadline = Date.now() + 10 * 60_000;
	const author = { userId: p.userId, credential: `${p.credential.kind}:${p.credential.id}` };
	const scope = await resolveReadScope(
		{ reach: p.boundAgentId ? { kind: "own", agentId: p.boundAgentId } : { kind: "all" }, projects: p.allowedProjects },
		audienceSubjectFromPrincipal(p),
	);
	const removed: Record<string, number> = {
		memories: 0,
		documents: 0,
		memory_artifacts: 0,
		session_summaries: 0,
		session_transcripts: 0,
	};
	let blocked = false;
	let hiddenMaterialRemains = false;
	const purgeDerived = async () => {
		for (;;) {
			if (Date.now() >= deadline) break;
			const batch = await dbOwnerOrganizationPurge(userId, author, scope, classificationId);
			for (const [kind, count] of Object.entries(batch.counts)) removed[kind] = (removed[kind] ?? 0) + count;
			blocked ||= batch.blocked;
			hiddenMaterialRemains = batch.hiddenMaterialRemains;
			await organizationWrite([
				statement("UPDATE org_jobs SET progress_json=? WHERE id=?", [
					JSON.stringify({ phase: "purging", removed }),
					jobId,
				]),
			]);
			if (batch.blocked || !Object.values(batch.counts).some((n) => n > 0)) break;
		}
	};
	await purgeDerived();

	for (;;) {
		if (Date.now() >= deadline) break;
		const batch = await organizationQuery<{ agent_id: string; session_key: string }[]>(
			statement(
				`SELECT t.agent_id,t.session_key FROM session_transcripts t WHERE t.speaker_user_id=?${purgeReadClause(scope, "transcript", "t", classificationId).sql} LIMIT 20`,
				[userId, ...purgeReadClause(scope, "transcript", "t", classificationId).args],
				"all",
			),
		);
		if (!batch.length) break;
		for (const row of batch) {
			if (Date.now() >= deadline) break;
			const result = await dbOwnerTranscriptOperation<TranscriptDeleteResult>(
				await getDbOwner(),
				{
					kind: "session_transcript_delete",
					input: {
						basePath,
						readScope: scope,
						agentId: row.agent_id,
						sessionKey: row.session_key,
						hard: true,
						changedBy: `user:${p.userId}`,
					},
				},
				{
					operation: "organization.offboard-transcript",
					lane: "write",
					deadlineMs: Math.min(60_000, deadline - Date.now()),
				},
			);
			if (result.status !== "complete") throw new Error(`Transcript purge did not complete: ${result.status}`);
			removed.session_transcripts = (removed.session_transcripts ?? 0) + 1;
			for (const table of ["session_claims", "memory_thread_heads", "session_memories"]) {
				for (;;) {
					if (Date.now() >= deadline) break;
					const rows = await organizationQuery<{ rowid: number }[]>(
						statement(
							`SELECT rowid FROM ${table} WHERE agent_id=? AND session_key IN (?,?) LIMIT 100`,
							[row.agent_id, row.session_key, `session:${row.session_key}`],
							"all",
						),
					);
					if (!rows.length) break;
					await organizationWrite([
						statement(`DELETE FROM ${table} WHERE rowid IN (SELECT value FROM json_each(?))`, [
							JSON.stringify(rows.map((r) => r.rowid)),
						]),
					]);
				}
			}
			await organizationWrite([
				{
					sql: "INSERT INTO audit_events (id,at,actor_user_id,actor_credential,action,target_kind,target_id,agent_id,outcome,detail_json) VALUES (?,?,?,?,'session.purged','session',?,?,'ok',?)",
					params: [
						`aud_${crypto.randomUUID().replaceAll("-", "")}`,
						new Date().toISOString(),
						p.userId,
						author.credential,
						row.session_key,
						row.agent_id,
						JSON.stringify({ offboardUserId: userId, jobId, generation: result.generation }),
					],
					result: "run",
				},
			]);
		}
	}
	await purgeDerived();
	const residual = await purgeResidual(userId, jobId, scope, classificationId);
	const status =
		blocked || hiddenMaterialRemains || Object.values(residual).some((n) => n > 0) ? "incomplete" : "complete";
	await organizationWrite([
		statement("UPDATE org_jobs SET status=?,progress_json=?,finished_at=? WHERE id=?", [
			status,
			JSON.stringify({ removed, residual, ...(hiddenMaterialRemains ? { reason: "hidden_material_remains" } : {}) }),
			new Date().toISOString(),
			jobId,
		]),
		auditStatement(
			p,
			classificationId ? "classification.author_purged" : "user.purged",
			classificationId ? "classification" : "user",
			classificationId ?? userId,
			{ removed, residual, status, userId, jobId },
		),
	]);
}
