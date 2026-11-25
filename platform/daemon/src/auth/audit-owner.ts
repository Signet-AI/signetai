import type { WriteDb } from "../db-accessor";
import type { DbOwnerStatement } from "../db-owner-protocol";
export function authoredAuditStatements(
	author: WriteAuthor | undefined,
	action: string,
	targetKind: string,
	targetId: string,
	agentId: string | null,
	detail?: Readonly<Record<string, unknown>>,
): readonly DbOwnerStatement[] {
	if (!author) return [];
	return [
		{
			sql: "INSERT INTO audit_events (id,at,actor_user_id,actor_credential,action,target_kind,target_id,agent_id,outcome,detail_json) VALUES (?,?,?,?,?,?,?,?,'ok',?)",
			params: [
				`aud_${crypto.randomUUID().replaceAll("-", "")}`,
				new Date().toISOString(),
				author.userId,
				author.credential,
				action,
				targetKind,
				targetId,
				agentId,
				detail ? JSON.stringify(detail) : null,
			],
			result: "run",
		},
	];
}
export function requireWriteAuthor(author: WriteAuthor | undefined): WriteAuthor {
	if (!author) throw new Error("A write requires an explicit author");
	return author;
}
export function parseWriteAuthor(value: unknown): WriteAuthor {
	if (typeof value !== "object" || value === null) throw new Error("A write requires an explicit author");
	const userId = Reflect.get(value, "userId"),
		credential = Reflect.get(value, "credential");
	if ((userId !== null && typeof userId !== "string") || typeof credential !== "string" || !credential)
		throw new Error("Invalid write author");
	return { userId, credential };
}
export const SYSTEM_AUTHOR = { userId: null, credential: "system" } as const;
export const LOCAL_AUTHOR = { userId: null, credential: "local" } as const;
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
	agentId: string | null,
	detail?: Readonly<Record<string, unknown>>,
): void {
	if (!author) return;
	db.prepare(
		"INSERT INTO audit_events (id,at,actor_user_id,actor_credential,action,target_kind,target_id,agent_id,outcome,detail_json) VALUES (?,?,?,?,?,?,?,?,'ok',?)",
	).run(
		`aud_${crypto.randomUUID().replaceAll("-", "")}`,
		new Date().toISOString(),
		author.userId,
		author.credential,
		action,
		targetKind,
		targetId,
		agentId,
		detail ? JSON.stringify(detail) : null,
	);
}
