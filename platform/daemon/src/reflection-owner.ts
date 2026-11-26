import { compartmentFor } from "@signet/core";
import { getDbOwner, dbOwnerQuery, ownerStatement } from "./db-owner-runtime";
import { z } from "zod";
import { ownerReadAll } from "./db-owner-sql";
import type { ReflectionSourceContext } from "./pipeline/reflection-worker";
import type { WriteAuthor } from "./auth/audit-owner";
import { type WriteDb, prepareTypedStatement } from "./db-accessor";
import { type CitationEvidence, evidenceCompartmentInTx, recordEvidenceCitationsInTx } from "./db-helpers";
import { txIngestEnvelope } from "./transactions";
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
	if (input.sourceAgentId !== input.agentId) throw new Error("reflection_agent_conflict");
	const reflection = prepareTypedStatement<{ compartment_id: number | null; memory_ids: string; summary_ids: string }>(
		db,
		"SELECT compartment_id,memory_ids,summary_ids FROM daily_reflections WHERE id=? AND agent_id=? AND answer IS NULL",
	).get(input.id, input.agentId);
	if (!reflection) return false;
	const evidence = prepareTypedStatement<{ evidence_kind: CitationEvidence["kind"]; evidence_id: string }>(
		db,
		"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='reflection' AND derived_id=? AND agent_id=?",
	)
		.all(input.id, input.agentId)
		.map((ref): CitationEvidence => ({ kind: ref.evidence_kind, id: ref.evidence_id }));
	for (const [kind, raw] of [
		["memory", reflection.memory_ids],
		["summary", reflection.summary_ids],
	] as const) {
		const ids: unknown = JSON.parse(raw);
		if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new Error("invalid_reflection_evidence");
		for (const id of ids) if (typeof id === "string") evidence.push({ kind, id });
	}
	const changed = db
		.prepare(
			"UPDATE daily_reflections SET answer=?,answer_memory_id=?,answered_at=?,agent_id=? WHERE id=? AND agent_id=? AND answer IS NULL",
		)
		.run(input.answer, input.memoryId, input.now, input.agentId, input.id, input.sourceAgentId);
	if (changed.changes === 0) return false;
	txIngestEnvelope(db, {
		author: input.author,
		evidence,
		parentCompartment: reflection.compartment_id,
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

export interface CreateDailyReflectionsInput {
	readonly agentId: string;
	readonly date: string;
	readonly model: string;
	readonly now: string;
	readonly memoryIds: readonly string[];
	readonly summaryIds: readonly string[];
	readonly priorReflectionIds?: readonly string[];
	readonly insights: readonly {
		readonly id: string;
		readonly summary: string;
		readonly patterns: readonly string[];
		readonly question?: string;
		readonly contentKey: string;
	}[];
}

function unionCompartmentsInTx(db: WriteDb, agentId: string, left: number | null, right: number | null): number | null {
	const rows = prepareTypedStatement<{ classification_id: string }>(
		db,
		"SELECT classification_id FROM compartment_members WHERE compartment_id IN (?,?)",
	).all(left, right);
	return evidenceCompartmentInTx(
		db,
		agentId,
		[],
		compartmentFor(
			db,
			rows.map((row) => row.classification_id),
		),
	);
}

export function txCreateDailyReflections(db: WriteDb, input: CreateDailyReflectionsInput): string[] {
	const evidence: CitationEvidence[] = [
		...input.memoryIds.map((id): CitationEvidence => ({ kind: "memory", id })),
		...input.summaryIds.map((id): CitationEvidence => ({ kind: "summary", id })),
	];
	if (evidence.length === 0) throw new Error("reflection_evidence_required");
	let parentCompartment: number | null = null;
	for (const id of input.priorReflectionIds ?? []) {
		const prior = prepareTypedStatement<{ compartment_id: number | null }>(
			db,
			"SELECT compartment_id FROM daily_reflections WHERE id=? AND agent_id=?",
		).get(id, input.agentId);
		if (!prior) throw new Error("reflection_evidence_not_in_agent");
		const refs = prepareTypedStatement<{ evidence_kind: CitationEvidence["kind"]; evidence_id: string }>(
			db,
			"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='reflection' AND derived_id=? AND agent_id=?",
		).all(id, input.agentId);
		evidence.push(...refs.map((ref): CitationEvidence => ({ kind: ref.evidence_kind, id: ref.evidence_id })));
		parentCompartment = evidenceCompartmentInTx(
			db,
			input.agentId,
			evidence,
			unionCompartmentsInTx(db, input.agentId, parentCompartment, prior.compartment_id),
		);
	}
	const compartment = evidenceCompartmentInTx(db, input.agentId, evidence, parentCompartment);
	const ids: string[] = [];
	for (const insight of input.insights) {
		const result = db
			.prepare(
				`INSERT OR IGNORE INTO daily_reflections
			 (id,agent_id,date,summary,patterns,question,content_key,memory_ids,summary_ids,model,created_at,compartment_id)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				insight.id,
				input.agentId,
				input.date,
				insight.summary,
				JSON.stringify(insight.patterns),
				insight.question ?? null,
				insight.contentKey,
				JSON.stringify(input.memoryIds),
				JSON.stringify(input.summaryIds),
				input.model,
				input.now,
				compartment,
			);
		if (result.changes === 0) continue;
		recordEvidenceCitationsInTx(db, {
			agentId: input.agentId,
			derivedKind: "reflection",
			derivedId: insight.id,
			evidence,
		});
		ids.push(insight.id);
	}
	return ids;
}

export async function createDailyReflections(input: CreateDailyReflectionsInput): Promise<string[]> {
	const owner = await getDbOwner();
	return owner.submit<string[]>(
		{ kind: "reflection_generate", input },
		{
			operation: "reflection.generate",
			lane: "write",
			workloadClass: "maintenance",
			deadlineMs: 10000,
			estimatedWorkUnits: input.insights.length + input.memoryIds.length + input.summaryIds.length,
		},
	).result;
}

export async function readReflectionSourceContext(agentId: string): Promise<ReflectionSourceContext> {
	const options = { operation: "reflection.context", lane: "read" as const, deadlineMs: 5000, estimatedWorkUnits: 74 };
	const memories = z
		.array(
			z.object({
				id: z.string(),
				content: z.string(),
				type: z.string(),
				tags: z.string().nullable(),
				created_at: z.string(),
			}),
		)
		.parse(
			await dbOwnerQuery(
				ownerStatement(
					"SELECT id,content,type,tags,created_at FROM memories WHERE agent_id=? AND is_deleted=0 ORDER BY created_at DESC LIMIT 50",
					[agentId],
					"all",
				),
				options,
			),
		);
	const existing = z
		.array(
			z.object({
				id: z.string(),
				question: z.string().nullable(),
				summary: z
					.string()
					.nullable()
					.transform((value) => value ?? ""),
				created_at: z.string(),
			}),
		)
		.parse(
			await dbOwnerQuery(
				ownerStatement(
					"SELECT id,question,summary,created_at FROM daily_reflections WHERE agent_id=? ORDER BY created_at DESC LIMIT 24",
					[agentId],
					"all",
				),
				options,
			),
		);
	return {
		memories: memories.map((row) => ({
			id: row.id,
			content: row.content,
			type: row.type,
			tags: row.tags ?? "",
			createdAt: row.created_at,
		})),
		existingReflections: existing.map((row) => ({
			id: row.id,
			question: row.question,
			summary: row.summary,
			createdAt: row.created_at,
		})),
		summaries: [],
		transcripts: [],
		graphFacts: [],
	};
}
