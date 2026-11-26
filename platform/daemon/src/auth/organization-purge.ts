import { audienceSubjectFromPrincipal, readScopeSql, resolveReadScope, type ReadScope } from "../read-scope";
import { prepareTypedStatement, type WriteDb } from "../db-accessor";
import {
	dbOwnerOrganizationPurge,
	dbOwnerOrganizationPurgePlan,
	dbOwnerTranscriptOperation,
	getDbOwner,
} from "../db-owner-runtime";
import type { TranscriptDeleteResult } from "../session-transcript-lifecycle";
import {
	purgeArtifactRecordInTx,
	purgeDocumentRecordInTx,
	purgeMemoryEmbeddingsInTx,
	purgeMemoryInTx,
	purgeSummaryRecordInTx,
} from "../source-purge-tx";
import { auditAuthoredWriteInTx, type WriteAuthor } from "./audit-owner";
import { auditStatement, organizationQuery, organizationWrite, statement } from "./organization-store";
import type { Principal } from "./principal";

export interface PurgeBatchResult {
	removed: number;
	remaining: number;
	counts: Record<string, number>;
	blocked: boolean;
}
function purgeReadClause(
	scope: ReadScope | undefined,
	kind: "memory" | "artifact" | "document" | "summary" | "transcript",
	alias: string,
) {
	if (!scope) return { sql: "", args: [] };
	if (kind === "memory") return readScopeSql(alias, scope);
	return readScopeSql(alias, scope, {
		visibility: null,
		memory: null,
		session: kind === "document" ? null : "session_key",
		source: kind === "artifact" || kind === "transcript" ? "source_id" : null,
	});
}
function planAuthoredMemoryPurgeInTx(
	db: WriteDb,
	userId: string,
	options: { readonly scope?: ReadScope; readonly preview?: boolean; readonly agentId?: string } = {},
) {
	const memoryScope = purgeReadClause(options.scope, "memory", "m");
	const documentScope = purgeReadClause(options.scope, "document", "d");
	const artifactScope = purgeReadClause(options.scope, "artifact", "a");
	const summaryScope = purgeReadClause(options.scope, "summary", "s");
	const transcriptScope = purgeReadClause(options.scope, "transcript", "t");
	const rootLimit = options.preview ? 1001 : 50;
	const agentId = options.agentId;
	const evidenceLimit = options.preview ? 1001 : 1;
	const roots = prepareTypedStatement<{ id: string }>(
		db,
		`SELECT m.id FROM memories m WHERE ${agentId ? "m.agent_id=?" : `(m.author_user_id=? OR EXISTS(SELECT 1 FROM session_transcripts t WHERE t.speaker_user_id=? AND t.agent_id=m.agent_id AND m.source_id IN (t.session_key,'session:'||t.session_key) AND (m.type='session_summary' OR m.source_type IN ('transcript','session','session_summary','checkpoint'))${transcriptScope.sql}))`}${memoryScope.sql} LIMIT ?`,
	).all(...(agentId ? [agentId] : [userId, userId, ...transcriptScope.args]), ...memoryScope.args, rootLimit);
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
		[roots.length, documents.length, artifacts.length, summaries.length, transcripts.length].some((n) => n > 1000);
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
	const rows = prepareTypedStatement<{ id: string; agent_id: string; pinned: number }>(
		db,
		"SELECT id,agent_id,pinned FROM memories WHERE id IN (SELECT value FROM json_each(?))",
	).all(JSON.stringify(nodes.filter((n) => n.kind === "memory").map((n) => n.id)));
	const affectedSummaries = prepareTypedStatement<{ id: string; agent_id: string }>(
		db,
		"SELECT id,agent_id FROM session_summaries WHERE id IN (SELECT value FROM json_each(?))",
	).all(JSON.stringify(nodes.filter((n) => n.kind === "summary").map((n) => n.id)));
	const blocked = nodes.length > 1000 || rows.some((row) => row.pinned === 1);
	if (options.preview && nodes.length > 1000) throw new Error("plan_limit");
	return { rows, documents, artifacts, affectedSummaries, transcripts, blocked };
}
export function planOffboardPurgeInTx(db: WriteDb, userId: string, scope: ReadScope): Record<string, number> {
	const plan = planAuthoredMemoryPurgeInTx(db, userId, { scope, preview: true });
	return {
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
	options: { readonly agentId?: string } = {},
): PurgeBatchResult {
	const count = (sql: string, ...args: string[]) => prepareTypedStatement<{ n: number }>(db, sql).get(...args)?.n ?? 0;
	const { rows, documents, artifacts, affectedSummaries, blocked } = planAuthoredMemoryPurgeInTx(db, userId, options);
	const detail = options.agentId ? { purgedAgentId: options.agentId } : { offboardUserId: userId };
	const counts: Record<string, number> = { memories: 0, documents: 0, memory_artifacts: 0, session_summaries: 0 };
	if (!blocked) {
		for (const row of rows) {
			purgeMemoryEmbeddingsInTx(db, row.id);
			purgeMemoryInTx(db, row.id);
			auditAuthoredWriteInTx(db, author, "memory.purged", "memory", row.id, row.agent_id, detail);
			counts.memories = (counts.memories ?? 0) + 1;
		}
		for (const doc of documents)
			if (!count("SELECT COUNT(*) AS n FROM document_memories WHERE document_id=?", doc.id)) {
				purgeDocumentRecordInTx(db, doc.id);
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
				purgeArtifactRecordInTx(db, artifact);
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
			purgeSummaryRecordInTx(db, summary.id, summary.agent_id);
			counts.session_summaries = (counts.session_summaries ?? 0) + 1;
			auditAuthoredWriteInTx(db, author, "summary.purged", "summary", summary.id, summary.agent_id, detail);
		}
	}
	const column = options.agentId ? "agent_id" : "author_user_id";
	const target = options.agentId ?? userId;
	const remaining = count(
		`SELECT (SELECT COUNT(*) FROM memories WHERE ${column}=?)+(SELECT COUNT(*) FROM documents WHERE ${column}=?)+(SELECT COUNT(*) FROM memory_artifacts WHERE ${column}=?)+(SELECT COUNT(*) FROM session_summaries WHERE ${column}=?) AS n`,
		target,
		target,
		target,
		target,
	);
	return { removed: counts.memories ?? 0, remaining, counts, blocked };
}
async function purgeResidual(userId: string, jobId: string, scope?: ReadScope): Promise<Record<string, number>> {
	const residual: Record<string, number> = {};
	for (const [table, column] of [
		["memories", "author_user_id"],
		["documents", "author_user_id"],
		["memory_artifacts", "author_user_id"],
		["session_transcripts", "speaker_user_id"],
	]) {
		const clause = purgeReadClause(
			scope,
			table === "memories"
				? "memory"
				: table === "documents"
					? "document"
					: table === "memory_artifacts"
						? "artifact"
						: "transcript",
			"r",
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
		const clause = table === "session_summaries" ? purgeReadClause(scope, "summary", "s") : { sql: "", args: [] };
		const row = await organizationQuery<{ n: number }>(
			statement(
				`SELECT COUNT(*) AS n FROM ${table} s WHERE (${table === "session_summaries" ? "s.author_user_id=? OR " : ""}EXISTS (SELECT 1 FROM audit_events a WHERE a.target_kind='session' AND a.action='session.purged' AND a.agent_id=s.agent_id AND s.session_key IN (a.target_id,'session:'||a.target_id) AND json_extract(a.detail_json,'$.offboardUserId')=? AND json_extract(a.detail_json,'$.jobId')=?))${clause.sql}`,
				[...(table === "session_summaries" ? [userId, userId, jobId] : [userId, jobId]), ...clause.args],
				"get",
			),
		);
		residual[table] = row.n;
	}
	const memoryScope = purgeReadClause(scope, "memory", "m");
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
export async function runOffboardPurge(p: Principal, jobId: string, userId: string, basePath: string): Promise<void> {
	const deadline = Date.now() + 10 * 60_000;
	const author = { userId: p.userId, credential: `${p.credential.kind}:${p.credential.id}` };
	const scope = await resolveReadScope(
		{ reach: p.boundAgentId ? { kind: "own", agentId: p.boundAgentId } : { kind: "all" }, projects: p.allowedProjects },
		audienceSubjectFromPrincipal(p),
	);
	const impact = await dbOwnerOrganizationPurgePlan(userId, scope);
	let blocked = false;
	const purgeDerived = async () => {
		for (;;) {
			if (Date.now() >= deadline) break;
			const batch = await dbOwnerOrganizationPurge(userId, author);
			blocked ||= batch.blocked;
			await organizationWrite([
				statement("UPDATE org_jobs SET progress_json=? WHERE id=?", [
					JSON.stringify({ phase: "purging", removed: {} }),
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
				"SELECT agent_id,session_key FROM session_transcripts WHERE speaker_user_id=? LIMIT 20",
				[userId],
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
	const allResidual = await purgeResidual(userId, jobId);
	const residual = await purgeResidual(userId, jobId, scope);
	const status = blocked || Object.values(allResidual).some((n) => n > 0) ? "incomplete" : "complete";
	const removed =
		status === "complete"
			? {
					memories: impact.memories ?? 0,
					documents: impact.documents ?? 0,
					memory_artifacts: impact.artifacts ?? 0,
					session_summaries: impact.summaries ?? 0,
					session_transcripts: impact.transcripts ?? 0,
				}
			: {};
	await organizationWrite([
		statement("UPDATE org_jobs SET status=?,progress_json=?,finished_at=? WHERE id=?", [
			status,
			JSON.stringify({ removed, residual }),
			new Date().toISOString(),
			jobId,
		]),
		auditStatement(p, "user.purged", "user", userId, { removed, residual, status }),
	]);
}
