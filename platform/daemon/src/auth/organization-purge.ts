import { prepareTypedStatement, type WriteDb, getDbAccessorPath, resolveSqliteAgentsDir } from "../db-accessor";
import { purgeMemoryInTx } from "../source-purge-tx";
import { dbOwnerOrganizationPurge, dbOwnerTranscriptOperation, getDbOwner } from "../db-owner-runtime";
import type { TranscriptDeleteResult } from "../session-transcript-lifecycle";
import type { Principal } from "./principal";
import { auditStatement, organizationQuery, organizationWrite, statement } from "./organization-store";

export function purgeAuthoredMemoryBatchInTx(db: WriteDb, userId: string): { removed: number; remaining: number } {
	const rows = prepareTypedStatement<{ id: string }>(
		db,
		"SELECT id FROM memories WHERE author_user_id = ? LIMIT 100",
	).all(userId);
	for (const row of rows) purgeMemoryInTx(db, row.id);
	const remaining =
		prepareTypedStatement<{ n: number }>(db, "SELECT COUNT(*) AS n FROM memories WHERE author_user_id = ?").get(userId)
			?.n ?? 0;
	return { removed: rows.length, remaining };
}
export async function runOffboardPurge(p: Principal, jobId: string, userId: string): Promise<void> {
	const deadline = Date.now() + 10 * 60_000;
	let memories = 0,
		transcripts = 0;
	for (;;) {
		if (Date.now() >= deadline) throw new Error("Offboarding purge deadline exceeded");
		const batch = await dbOwnerOrganizationPurge(userId);
		memories += batch.removed;
		if (!batch.remaining) break;
	}
	for (;;) {
		if (Date.now() >= deadline) throw new Error("Offboarding purge deadline exceeded");
		const batch = await organizationQuery<{ agent_id: string; session_key: string }[]>(
			statement(
				"SELECT agent_id,session_key FROM session_transcripts WHERE speaker_user_id = ? LIMIT 20",
				[userId],
				"all",
			),
		);
		if (!batch.length) break;
		for (const row of batch) {
			const owner = await getDbOwner();
			const result = await dbOwnerTranscriptOperation<TranscriptDeleteResult>(
				owner,
				{
					kind: "session_transcript_delete",
					input: {
						basePath: resolveSqliteAgentsDir(),
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
			transcripts++;
		}
		await organizationWrite([
			statement("UPDATE org_jobs SET progress_json = ? WHERE id = ?", [
				JSON.stringify({ memories, transcripts }),
				jobId,
			]),
		]);
	}
	await organizationWrite([
		statement("UPDATE org_jobs SET status = 'complete',progress_json = ?,finished_at = ? WHERE id = ?", [
			JSON.stringify({ removed: { memories, transcripts } }),
			new Date().toISOString(),
			jobId,
		]),
		auditStatement(p, "user.purged", "user", userId, { memories, transcripts }),
	]);
}
