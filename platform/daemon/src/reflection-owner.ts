import type { WriteAuthor } from "./auth/audit-owner";
import { z } from "zod";
import type { ReadDb, WriteDb } from "./db-accessor";
import { dbOwnerReflectionGet, dbOwnerReflectionList } from "./db-owner-runtime";
import { readScopeSql, type ReadScope } from "./read-scope";
import { citedEvidenceReadScopeSql } from "./diagnostics";
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

const reflectionRowSchema = z.object({
	id: z.string(),
	agent_id: z.string(),
	date: z.string(),
	summary: z.string(),
	patterns: z.string(),
	question: z.string().nullable(),
	answer: z.string().nullable(),
	answer_memory_id: z.string().nullable(),
	memory_ids: z.string(),
	summary_ids: z.string(),
	model: z.string().nullable(),
	created_at: z.string(),
	answered_at: z.string().nullable(),
});

export interface ReflectionListInput {
	readonly date?: string;
	readonly ids?: readonly string[];
	readonly limit: number;
}

export function readReflections(scope: ReadScope, input: ReflectionListInput): Promise<readonly ReflectionRow[]> {
	return dbOwnerReflectionList(scope, input);
}

export function readReflection(scope: ReadScope, id: string): Promise<ReflectionRow | null> {
	return dbOwnerReflectionGet(scope, id);
}

function reflectionProjection(scope: ReadScope): ReturnType<typeof readScopeSql> {
	const answer = readScopeSql("answer_memory", scope);
	const copied = citedEvidenceReadScopeSql("answer_memory", scope, "memory");
	return {
		sql: `r.id,r.agent_id,r.date,r.summary,r.patterns,r.question,r.answer,CASE WHEN EXISTS(SELECT 1 FROM memories answer_memory WHERE answer_memory.id=r.answer_memory_id${answer.sql}${copied.sql}) THEN r.answer_memory_id ELSE NULL END AS answer_memory_id,r.memory_ids,r.summary_ids,r.model,r.created_at,r.answered_at`,
		args: [...answer.args, ...copied.args],
	};
}

export function readReflectionsInOwner(
	db: ReadDb,
	scope: ReadScope,
	input: ReflectionListInput,
): readonly ReflectionRow[] {
	const predicate = reflectionPredicate(scope);
	const filters = ["1=1", predicate.sql];
	const projection = reflectionProjection(scope);
	const params = [...projection.args, ...predicate.args];
	if (input.date !== undefined) {
		filters.push("AND r.date=?");
		params.push(input.date);
	}
	if (input.ids !== undefined) {
		if (input.ids.length === 0) return [];
		if (input.ids.length > 100) throw new Error("reflection_id_limit");
		filters.push(`AND r.id IN (${input.ids.map(() => "?").join(",")})`);
		params.push(...input.ids);
	}
	params.push(Math.min(100, Math.max(1, input.limit)));
	return z
		.array(reflectionRowSchema)
		.parse(
			db
				.prepare(
					`SELECT ${projection.sql} FROM daily_reflections r WHERE ${filters.join(" ")} ORDER BY r.created_at DESC,r.id LIMIT ?`,
				)
				.all(...params),
		);
}

export function readReflectionInOwner(db: ReadDb, scope: ReadScope, id: string): ReflectionRow | null {
	const predicate = reflectionPredicate(scope);
	const projection = reflectionProjection(scope);
	return reflectionRowSchema
		.nullable()
		.parse(
			db
				.prepare(`SELECT ${projection.sql} FROM daily_reflections r WHERE r.id=? ${predicate.sql}`)
				.get(...projection.args, id, ...predicate.args) ?? null,
		);
}

function reflectionPredicate(scope: ReadScope): ReturnType<typeof readScopeSql> {
	const normalized: ReadScope = {
		...scope,
		reach:
			scope.reach.kind === "shared" || scope.reach.kind === "group"
				? { kind: "own", agentId: scope.reach.agentId }
				: scope.reach,
	};
	const predicate = readScopeSql(
		"r",
		{
			...normalized,
			projects: normalized.projects === null ? null : [],
		},
		{ visibility: null, memory: null, session: null, source: null },
	);
	if (scope.compartments === "all" && scope.projects === null) return predicate;
	const checks: string[] = [];
	const args = [...predicate.args];
	for (const evidence of [
		{
			kind: "memory",
			table: "memories",
			key: "id",
			visibility: "visibility",
			session: "source_id",
			source: "source_id",
		},
		{
			kind: "artifact",
			table: "memory_artifacts",
			key: "source_path",
			visibility: null,
			session: "session_key",
			source: "source_id",
		},
		{
			kind: "transcript",
			table: "session_transcripts",
			key: "session_key",
			visibility: null,
			session: "session_key",
			source: "source_id",
		},
		{ kind: "summary", table: "session_summaries", key: "id", visibility: null, session: "session_key", source: null },
	] as const) {
		const readable = readScopeSql("e", normalized, {
			visibility: evidence.visibility,
			memory: evidence.kind === "memory" ? "id" : null,
			session: evidence.session,
			source: evidence.source,
		});
		const copied =
			evidence.kind === "memory" ? citedEvidenceReadScopeSql("e", normalized, "memory") : { sql: "", args: [] };
		checks.push(
			`(citation.evidence_kind='${evidence.kind}' AND NOT EXISTS (SELECT 1 FROM ${evidence.table} e WHERE e.agent_id=r.agent_id AND e.${evidence.key}=citation.evidence_id ${readable.sql}${copied.sql}))`,
		);
		args.push(...readable.args, ...copied.args);
	}
	return {
		sql: `${predicate.sql} AND NOT EXISTS (SELECT 1 FROM evidence_citations citation WHERE citation.agent_id=r.agent_id AND citation.derived_kind='reflection' AND citation.derived_id=r.id AND (${checks.join(" OR ")}))`,
		args,
	};
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
