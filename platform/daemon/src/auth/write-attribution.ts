import { z } from "zod";
import { dbOwnerQuery } from "../db-owner-runtime";
import { prepareTypedStatement, type WriteDb } from "../db-accessor";
import type { DbOwnerStatement } from "../db-owner-protocol";
import type { WriteAuthor } from "./audit-owner";
export interface WriteAttributionTarget {
	readonly kind: "transcript_import" | "board_post" | "dreaming_pass" | "cross_agent_message";
	readonly id: string;
	readonly agentId: string;
}
const attributionSchema = z.object({
	target: z.object({
		kind: z.enum(["transcript_import", "board_post", "dreaming_pass", "cross_agent_message"]),
		id: z.string(),
		agentId: z.string(),
	}),
	author: z.object({ userId: z.string().nullable(), credential: z.string() }),
});
function admissionId(target: WriteAttributionTarget): string {
	return `job_${z.uuid().parse(target.id).replaceAll("-", "")}`;
}
function attributionQuery(target: WriteAttributionTarget): DbOwnerStatement {
	return {
		sql: "SELECT params_json FROM org_jobs WHERE id = ? AND kind = 'write_attribution' AND status = 'complete'",
		params: [admissionId(target)],
		result: "get",
		readonly: true,
	};
}
export function writeAttributionStatements(
	author: WriteAuthor | undefined,
	target: WriteAttributionTarget,
): readonly DbOwnerStatement[] {
	if (!author) return [];
	const at = new Date().toISOString();
	return [
		{
			sql: "INSERT INTO org_jobs (id,kind,status,params_json,progress_json,created_by,created_at,started_at,finished_at) VALUES (?,'write_attribution','complete',?,'{\"recorded\":true}',?,?,?,?) ON CONFLICT(id) DO NOTHING",
			params: [admissionId(target), JSON.stringify({ target, author }), author.userId, at, at, at],
			result: "run",
		},
	];
}
function parseAttribution(
	row: { params_json: string } | null | undefined,
	target: WriteAttributionTarget,
): WriteAuthor | undefined {
	if (!row) return undefined;
	const value = attributionSchema.parse(JSON.parse(row.params_json));
	if (value.target.kind !== target.kind || value.target.id !== target.id || value.target.agentId !== target.agentId)
		throw new Error("Write attribution scope mismatch");
	return value.author;
}
export async function readWriteAttribution(target: WriteAttributionTarget): Promise<WriteAuthor | undefined> {
	return parseAttribution(
		await dbOwnerQuery<{ params_json: string } | null>(attributionQuery(target), {
			operation: "organization.attribution.read",
			lane: "read",
			deadlineMs: 5000,
		}),
		target,
	);
}
export function readWriteAttributionInTx(db: WriteDb, target: WriteAttributionTarget): WriteAuthor | undefined {
	if (!z.uuid().safeParse(target.id).success) return undefined;
	if (
		!prepareTypedStatement<{ name: string }>(
			db,
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'org_jobs'",
		).get()
	)
		return undefined;
	const query = attributionQuery(target);
	return parseAttribution(
		prepareTypedStatement<{ params_json: string }>(db, query.sql).get(...(query.params ?? [])),
		target,
	);
}
