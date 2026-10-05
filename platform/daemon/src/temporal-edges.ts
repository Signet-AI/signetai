import type { WriteDb } from "./db-accessor";
import { createTemporalEdgeId } from "./temporal-recall";

export interface MemoryTemporalEdgeInput {
	readonly facet: "source" | "observed" | "occurred" | "valid";
	readonly startAt: string;
	readonly endAt: string | null;
	readonly provenance: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export function txInsertMemoryTemporalEdges(params: {
	readonly db: WriteDb;
	readonly memoryId: string;
	readonly agentId: string;
	readonly inputs: readonly MemoryTemporalEdgeInput[];
	readonly now: string;
}): void {
	if (params.inputs.length === 0) return;
	const table = params.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='temporal_edges'").get();
	if (!table) return;
	const stmt = params.db.prepare(
		`INSERT INTO temporal_edges
		   (id, agent_id, subject_type, subject_id, facet, start_at, end_at, confidence,
		    provenance_json, metadata_json, created_at, updated_at)
		 VALUES (?, ?, 'memory', ?, ?, ?, ?, 1.0, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   end_at = excluded.end_at,
		   confidence = excluded.confidence,
		   provenance_json = excluded.provenance_json,
		   metadata_json = excluded.metadata_json,
		   updated_at = excluded.updated_at`,
	);
	for (const input of params.inputs) {
		stmt.run(
			createTemporalEdgeId({
				agentId: params.agentId,
				subjectType: "memory",
				subjectId: params.memoryId,
				facet: input.facet,
				startAt: input.startAt,
			}),
			params.agentId,
			params.memoryId,
			input.facet,
			input.startAt,
			input.endAt,
			JSON.stringify({ source: input.provenance }),
			input.metadata === undefined ? null : JSON.stringify(input.metadata),
			params.now,
			params.now,
		);
	}
}

export function txDeleteMemoryTemporalEdges(db: WriteDb, memoryIds: readonly string[]): void {
	if (memoryIds.length === 0) return;
	const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='temporal_edges'").get();
	if (!table) return;
	db.prepare(
		`DELETE FROM temporal_edges
		 WHERE subject_type = 'memory' AND subject_id IN (${memoryIds.map(() => "?").join(", ")})`,
	).run(...memoryIds);
}
