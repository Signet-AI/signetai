import type { WriteDb } from "../db-accessor";
export interface WriteAuthor {
	readonly userId: string | null;
	readonly credential: string;
}
export function auditAuthoredWriteInTx(
	db: WriteDb,
	author: WriteAuthor | undefined,
	action: string,
	targetKind: string,
	targetId: string,
	agentId: string,
): void {
	if (!author) return;
	db.prepare(
		"INSERT INTO audit_events (id,at,actor_user_id,actor_credential,action,target_kind,target_id,agent_id,outcome) VALUES (?,?,?,?,?,?,?,?,'ok')",
	).run(
		`aud_${crypto.randomUUID().replaceAll("-", "")}`,
		new Date().toISOString(),
		author.userId,
		author.credential,
		action,
		targetKind,
		targetId,
		agentId,
	);
}
