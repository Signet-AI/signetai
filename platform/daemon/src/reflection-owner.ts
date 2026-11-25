import type { WriteAuthor } from "./auth/audit-owner";
import type { WriteDb } from "./db-accessor";
import { getDbAccessorPath } from "./db-accessor";
import { getDbOwner } from "./db-owner-runtime";
import { ownerReadAll, ownerReadOne } from "./db-owner-sql";
import { readScopeSql, type ReadScope } from "./read-scope";
import { txIngestEnvelope } from "./transactions";

export interface ReflectionRow {
	id: string;
	agent_id: string;
	date: string;
	summary: string;
	patterns: string;
	question: string | null;
	answer: string | null;
	answer_memory_id: string | null;
	memory_ids: string;
	summary_ids: string;
	model: string | null;
	created_at: string;
	answered_at: string | null;
}

export async function readReflections(
	scope: ReadScope,
	input: { readonly date?: string; readonly ids?: readonly string[]; readonly limit: number },
): Promise<readonly ReflectionRow[]> {
	const predicate = reflectionPredicate(scope);
	const filters = ["1=1", predicate.sql];
	const params = [...predicate.args];
	if (input.date !== undefined) {
		filters.push("AND r.date=?");
		params.push(input.date);
	}
	if (input.ids !== undefined) {
		if (input.ids.length === 0) return [];
		filters.push(`AND r.id IN (${input.ids.map(() => "?").join(",")})`);
		params.push(...input.ids);
	}
	params.push(Math.min(100, Math.max(1, input.limit)));
	return ownerReadAll<ReflectionRow>(
		await getDbOwner(getDbAccessorPath()),
		`SELECT r.* FROM daily_reflections r WHERE ${filters.join(" ")} ORDER BY r.created_at DESC, r.id LIMIT ?`,
		params,
		{ operation: "reflection.list", deadlineMs: 3000 },
	);
}

export async function readReflection(scope: ReadScope, id: string): Promise<ReflectionRow | null> {
	const predicate = reflectionPredicate(scope);
	return ownerReadOne<ReflectionRow>(
		await getDbOwner(getDbAccessorPath()),
		`SELECT r.* FROM daily_reflections r WHERE r.id=? ${predicate.sql}`,
		[id, ...predicate.args],
		{ operation: "reflection.get", deadlineMs: 3000 },
	);
}

function reflectionPredicate(scope: ReadScope): ReturnType<typeof readScopeSql> {
	return readScopeSql(
		"r",
		{
			...scope,
			reach:
				scope.reach.kind === "shared" || scope.reach.kind === "group"
					? { kind: "own", agentId: scope.reach.agentId }
					: scope.reach,
			projects: scope.projects === null ? null : [],
		},
		{ visibility: null, memory: null, session: null, source: null },
	);
}

export interface ReflectionAnswerInput {
	readonly sourceAgentId: string;
	readonly id: string;
	readonly agentId: string;
	readonly memoryId: string;
	readonly answer: string;
	readonly now: string;
	readonly author: WriteAuthor;
}
export function txAnswerReflection(db: WriteDb, input: ReflectionAnswerInput): boolean {
	const changed = db
		.prepare(
			"UPDATE daily_reflections SET answer=?,answer_memory_id=?,answered_at=?,agent_id=? WHERE id=? AND agent_id=? AND answer IS NULL",
		)
		.run(input.answer, input.memoryId, input.now, input.agentId, input.id, input.sourceAgentId);
	if (changed.changes === 0) return false;
	txIngestEnvelope(db, {
		author: input.author,
		id: input.memoryId,
		content: input.answer,
		contentHash: `reflection-a-${input.id}`,
		who: input.agentId,
		why: "daily-reflection-answer",
		project: null,
		importance: 0.6,
		type: "reflection",
		tags: "reflection,answered",
		pinned: 0,
		memoryKind: "episodic",
		sourceType: "reflection-answer",
		sourceId: input.id,
		agentId: input.agentId,
		createdAt: input.now,
	});
	return true;
}
