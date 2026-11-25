import type { WriteDb } from "./db-accessor";
import { txIngestEnvelope } from "./transactions";
export interface ReflectionAnswerInput {
	readonly sourceAgentId: string;
	readonly id: string;
	readonly agentId: string;
	readonly memoryId: string;
	readonly answer: string;
	readonly now: string;
	readonly author: import("./auth/audit-owner").WriteAuthor;
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
