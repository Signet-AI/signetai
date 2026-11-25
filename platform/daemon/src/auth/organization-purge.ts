import { prepareTypedStatement, type WriteDb } from "../db-accessor";
import {
	purgeDocumentRecordInTx,
	purgeSummaryRecordInTx,
	purgeArtifactRecordInTx,
	purgeMemoryInTx,
	purgeMemoryEmbeddingsInTx,
} from "../source-purge-tx";
import { dbOwnerOrganizationPurge, dbOwnerTranscriptOperation, getDbOwner } from "../db-owner-runtime";
import type { TranscriptDeleteResult } from "../session-transcript-lifecycle";
import type { Principal } from "./principal";
import { auditAuthoredWriteInTx, type WriteAuthor } from "./audit-owner";
import { auditStatement, organizationQuery, organizationWrite, statement } from "./organization-store";

export interface PurgeBatchResult {
	removed: number;
	remaining: number;
	counts: Record<string, number>;
	blocked: boolean;
}
export function purgeAuthoredMemoryBatchInTx(db: WriteDb, userId: string, author: WriteAuthor): PurgeBatchResult {
	const count = (sql: string, ...args: string[]) => prepareTypedStatement<{ n: number }>(db, sql).get(...args)?.n ?? 0;
	const roots = prepareTypedStatement<{ id: string }>(
		db,
		`SELECT id FROM memories WHERE author_user_id=? LIMIT 50`,
	).all(userId);
	const documents = prepareTypedStatement<{ id: string; agent_id: string }>(
		db,
		"SELECT id,agent_id FROM documents WHERE author_user_id=? LIMIT 1",
	).all(userId);
	const artifacts = prepareTypedStatement<{ source_path: string; source_id: string | null; agent_id: string }>(
		db,
		"SELECT source_path,source_id,agent_id FROM memory_artifacts WHERE author_user_id=? LIMIT 1",
	).all(userId);
	const summaries = prepareTypedStatement<{ id: string; agent_id: string }>(
		db,
		"SELECT id,agent_id FROM session_summaries WHERE author_user_id=? LIMIT 1",
	).all(userId);
	for (const doc of documents)
		roots.push(
			...prepareTypedStatement<{ id: string }>(
				db,
				"SELECT memory_id AS id FROM document_memories WHERE document_id=? LIMIT 50",
			).all(doc.id),
		);
	for (const artifact of artifacts)
		roots.push(
			...prepareTypedStatement<{ id: string }>(
				db,
				"SELECT derived_memory_id AS id FROM derived_memory_sources WHERE source_kind='artifact' AND source_id=? AND agent_id=? LIMIT 50",
			).all(artifact.source_path, artifact.agent_id),
		);
	const nodes = prepareTypedStatement<{ kind: "memory" | "summary"; id: string }>(
		db,
		`WITH RECURSIVE affected(kind,id) AS (
 SELECT 'memory',value FROM json_each(?) UNION SELECT 'summary',value FROM json_each(?)
 UNION SELECT 'memory',d.derived_memory_id FROM derived_memory_sources d JOIN affected a ON d.source_kind=a.kind AND d.source_id=a.id
 UNION SELECT 'memory',s.aggregate_memory_id FROM aggregate_memory_sources s JOIN affected a ON a.kind='memory' AND s.source_memory_id=a.id
 UNION SELECT 'memory',e.aggregate_memory_id FROM aggregate_evidence_sources e JOIN affected a ON e.source_kind=a.kind AND e.source_id=a.id
 UNION SELECT 'summary',s.summary_id FROM session_summary_memories s JOIN affected a ON a.kind='memory' AND s.memory_id=a.id
 UNION SELECT 'summary',s.parent_id FROM session_summary_children s JOIN affected a ON a.kind='summary' AND s.child_id=a.id LIMIT 1001)
 SELECT kind,id FROM affected`,
	).all(JSON.stringify([...new Set(roots.map((r) => r.id))]), JSON.stringify(summaries.map((s) => s.id)));
	const rows = prepareTypedStatement<{ id: string; agent_id: string; pinned: number }>(
		db,
		"SELECT id,agent_id,pinned FROM memories WHERE id IN (SELECT value FROM json_each(?))",
	).all(JSON.stringify(nodes.filter((n) => n.kind === "memory").map((n) => n.id)));
	const affectedSummaries = prepareTypedStatement<{ id: string; agent_id: string }>(
		db,
		"SELECT id,agent_id FROM session_summaries WHERE id IN (SELECT value FROM json_each(?))",
	).all(JSON.stringify(nodes.filter((n) => n.kind === "summary").map((n) => n.id)));
	const counts: Record<string, number> = { memories: 0, documents: 0, memory_artifacts: 0, session_summaries: 0 };
	const blocked = nodes.length > 1000 || rows.some((row) => row.pinned === 1);
	if (!blocked) {
		for (const row of rows) {
			purgeMemoryEmbeddingsInTx(db, row.id);
			purgeMemoryInTx(db, row.id);
			auditAuthoredWriteInTx(db, author, "memory.purged", "memory", row.id, row.agent_id, { offboardUserId: userId });
			counts.memories = (counts.memories ?? 0) + 1;
		}
		for (const doc of documents)
			if (!count("SELECT COUNT(*) AS n FROM document_memories WHERE document_id=?", doc.id)) {
				purgeDocumentRecordInTx(db, doc.id);
				counts.documents = (counts.documents ?? 0) + 1;
				auditAuthoredWriteInTx(db, author, "document.purged", "document", doc.id, doc.agent_id, {
					offboardUserId: userId,
				});
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
				auditAuthoredWriteInTx(db, author, "artifact.purged", "artifact", artifact.source_path, artifact.agent_id, {
					offboardUserId: userId,
				});
			}
		for (const summary of affectedSummaries) {
			purgeSummaryRecordInTx(db, summary.id, summary.agent_id);
			counts.session_summaries = (counts.session_summaries ?? 0) + 1;
			auditAuthoredWriteInTx(db, author, "summary.purged", "summary", summary.id, summary.agent_id, {
				offboardUserId: userId,
			});
		}
	}
	const remaining = count(
		"SELECT (SELECT COUNT(*) FROM memories WHERE author_user_id=?)+(SELECT COUNT(*) FROM documents WHERE author_user_id=?)+(SELECT COUNT(*) FROM memory_artifacts WHERE author_user_id=?)+(SELECT COUNT(*) FROM session_summaries WHERE author_user_id=?) AS n",
		userId,
		userId,
		userId,
		userId,
	);
	return { removed: counts.memories ?? 0, remaining, counts, blocked };
}
async function purgeResidual(userId: string, jobId: string): Promise<Record<string, number>> {
	const residual: Record<string, number> = {};
	for (const [table, column] of [
		["memories", "author_user_id"],
		["documents", "author_user_id"],
		["memory_artifacts", "author_user_id"],
		["session_transcripts", "speaker_user_id"],
	]) {
		const row = await organizationQuery<{ n: number }>(
			statement(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`, [userId], "get"),
		);
		residual[table ?? ""] = row.n;
	}
	for (const table of ["session_summaries", "session_claims", "memory_thread_heads", "session_memories"]) {
		const row = await organizationQuery<{ n: number }>(
			statement(
				`SELECT COUNT(*) AS n FROM ${table} s WHERE ${table === "session_summaries" ? "s.author_user_id=? OR " : ""}EXISTS (SELECT 1 FROM audit_events a WHERE a.target_kind='session' AND a.action='session.purged' AND a.agent_id=s.agent_id AND s.session_key IN (a.target_id,'session:'||a.target_id) AND json_extract(a.detail_json,'$.offboardUserId')=? AND json_extract(a.detail_json,'$.jobId')=?)`,
				table === "session_summaries" ? [userId, userId, jobId] : [userId, jobId],
				"get",
			),
		);
		residual[table] = row.n;
	}
	const retained = `SELECT DISTINCT m.id FROM memories m JOIN session_transcript_deleted_sources d ON d.kind='memory' AND d.id=m.id AND d.agent_id=m.agent_id JOIN audit_events a ON a.action='session.purged' AND a.target_kind='session' AND a.target_id=d.session_key AND a.agent_id=d.agent_id AND json_extract(a.detail_json,'$.generation')=d.generation WHERE json_extract(a.detail_json,'$.offboardUserId')=? AND json_extract(a.detail_json,'$.jobId')=?`;
	const derived = `SELECT DISTINCT m.id FROM memories m JOIN derived_memory_sources d ON d.derived_memory_id=m.id WHERE EXISTS (SELECT 1 FROM audit_events a WHERE a.target_kind=d.source_kind AND a.target_id=d.source_id AND a.agent_id=d.agent_id AND a.action IN ('memory.purged','artifact.purged','summary.purged') AND json_extract(a.detail_json,'$.offboardUserId')=?)`;
	const row = await organizationQuery<{ n: number }>(
		statement(`SELECT COUNT(*) AS n FROM (${derived} UNION ${retained})`, [userId, userId, jobId], "get"),
	);
	residual.derived_memories = row.n;
	const memories = await organizationQuery<{ n: number }>(
		statement(
			`SELECT COUNT(*) AS n FROM memories WHERE author_user_id=? OR id IN (${derived} UNION ${retained})`,
			[userId, userId, userId, jobId],
			"get",
		),
	);
	residual.memories = memories.n;

	return residual;
}
export async function runOffboardPurge(p: Principal, jobId: string, userId: string, basePath: string): Promise<void> {
	const deadline = Date.now() + 10 * 60_000;
	const author = { userId: p.userId, credential: `${p.credential.kind}:${p.credential.id}` };
	const removed: Record<string, number> = {
		memories: 0,
		session_transcripts: 0,
		documents: 0,
		memory_artifacts: 0,
		session_summaries: 0,
		session_claims: 0,
		memory_thread_heads: 0,
		session_memories: 0,
	};
	const add = (key: string, n: number) => {
		removed[key] = (removed[key] ?? 0) + n;
	};

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
			add("session_transcripts", 1);
			for (const [key, n] of Object.entries(result.counts ?? {}))
				if (typeof n === "number" && key !== "retainedPinned" && key !== "retainedMixed")
					add(key === "summaries" ? "session_summaries" : key === "artifacts" ? "memory_artifacts" : key, n);
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
					add(table, rows.length);
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
	for (;;) {
		if (Date.now() >= deadline) break;
		const batch = await dbOwnerOrganizationPurge(userId, author);
		for (const [key, n] of Object.entries(batch.counts)) add(key, n);
		await organizationWrite([
			statement("UPDATE org_jobs SET progress_json=? WHERE id=?", [JSON.stringify({ removed }), jobId]),
		]);
		if (!batch.remaining || batch.blocked || !Object.values(batch.counts).some((n) => n > 0)) break;
	}
	const residual = await purgeResidual(userId, jobId);
	const status = Object.values(residual).some((n) => n > 0) ? "incomplete" : "complete";
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
