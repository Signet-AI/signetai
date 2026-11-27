import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { MigrationDb } from "@signet/core";

const entry = z.object({
	at: z.string(),
	status: z.union([z.literal(401), z.literal(403)]),
	reason: z.string(),
	requestId: z.string(),
});
export interface ConnectorErrorRequest {
	readonly keyId: string;
	readonly record?: { readonly status: 401 | 403; readonly reason: string; readonly requestId: string };
}
export async function connectorErrorsInOwner(db: MigrationDb, databasePath: string, input: ConnectorErrorRequest) {
	const key = db.prepare("SELECT user_id FROM api_keys WHERE id=? AND kind='connector'").get(input.keyId);
	if (!key) return [];
	const directory = `${databasePath}.connector-errors`;
	const path = join(directory, `${createHash("sha256").update(input.keyId).digest("hex")}.json`);
	const now = Date.now();
	let stored: string | undefined;
	try {
		stored = await readFile(path, "utf8");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const history = stored === undefined ? [] : z.array(entry).max(10).parse(JSON.parse(stored));
	const errors = history.filter((error) => Date.parse(error.at) >= now - 7 * 86400_000);
	if (input.record && !errors.some((error) => error.requestId === input.record?.requestId)) {
		const reason = /^[a-z_]{1,64}$/.test(input.record.reason) ? input.record.reason : "request_denied";
		errors.unshift({ ...input.record, reason, at: new Date(now).toISOString() });
		errors.splice(10);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify(errors), { mode: 0o600 });
		await rename(temporary, path);
		const minute = new Date(Math.floor(now / 60_000) * 60_000).toISOString();
		db.prepare(
			"INSERT INTO audit_events(id,at,actor_user_id,actor_credential,action,target_kind,target_id,outcome,detail_json) SELECT ?,?,?,?,'auth.failure','key',?,'denied',? WHERE NOT EXISTS(SELECT 1 FROM audit_events WHERE target_kind='key' AND target_id=? AND action='auth.failure' AND at>=?)",
		).run(
			`aud_${randomUUID().replaceAll("-", "")}`,
			new Date(now).toISOString(),
			key.user_id,
			`api_key:${input.keyId}`,
			input.keyId,
			JSON.stringify({ status: input.record.status, reason }),
			input.keyId,
			minute,
		);
	} else if (history.length !== errors.length) {
		await writeFile(path, JSON.stringify(errors), { mode: 0o600 });
	}
	return errors.map(({ requestId: _requestId, ...error }) => error);
}
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
export function sourceWriteAuthor(source: import("@signet/core").SignetSourceEntry): WriteAuthor {
	return source.writeIdentity
		? { userId: source.writeIdentity.authorUserId, credential: source.writeIdentity.authorCredential }
		: SYSTEM_AUTHOR;
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
