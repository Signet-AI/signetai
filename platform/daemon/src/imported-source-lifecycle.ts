import { createHash } from "node:crypto";
import { SOURCE_CHUNK_SOURCE_TYPE } from "@signet/core";
import { getDbAccessor } from "./db-accessor";
import { countChanges, syncVecDeleteByEmbeddingIds } from "./db-helpers";
import { enqueueDreamingAttentionInTx } from "./pipeline/dreaming-attention";

export interface MarkImportedSourceUnsupportedInput {
	readonly sourceId: string;
	readonly agentId: string;
	readonly reason?: string;
}

export interface MarkImportedSourceUnsupportedResult {
	readonly artifacts: number;
	readonly embeddings: number;
	readonly derivedMemories: number;
	readonly entities: number;
	readonly aspects: number;
	readonly attributes: number;
	readonly dependencies: number;
}

/**
 * Detach imported evidence without deleting ontology derived from it. The
 * lifecycle row is the durable marker used by Dreaming/hygiene review; graph
 * rows keep their original source_id/source_path provenance.
 */
export function markImportedSourceUnsupported(
	input: MarkImportedSourceUnsupportedInput,
): MarkImportedSourceUnsupportedResult {
	const sourceId = input.sourceId.trim();
	const agentId = input.agentId.trim();
	if (!sourceId || !agentId)
		return { artifacts: 0, embeddings: 0, derivedMemories: 0, entities: 0, aspects: 0, attributes: 0, dependencies: 0 };
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return getDbAccessor().withWriteTx((db: import("./db-accessor").WriteDb) => {
		const now = new Date().toISOString();
		const reason = input.reason?.trim() || "imported source removed";
		db.prepare(
			`INSERT INTO imported_source_lifecycle
			 (id, source_id, agent_id, status, reason, removed_at, created_at, updated_at)
			 VALUES (?, ?, ?, 'unsupported', ?, ?, ?, ?)
			 ON CONFLICT(source_id, agent_id) DO UPDATE SET
			   status = 'unsupported', reason = excluded.reason,
			   removed_at = excluded.removed_at, updated_at = excluded.updated_at,
			   reviewed_at = NULL`,
		).run(
			`import-lifecycle:${createHash("sha256").update(`${agentId}\0${sourceId}`).digest("hex")}`,
			sourceId,
			agentId,
			reason,
			now,
			now,
			now,
		);

		const artifacts = countChanges(
			db.prepare("DELETE FROM memory_artifacts WHERE agent_id = ? AND source_id = ?").run(agentId, sourceId),
		);
		// Consumption rows describe the removed source's old artifact revisions.
		// Delete them in the same lifecycle transaction so a re-import starts
		// cleanly instead of inheriting a stale delivered frontier.
		db.prepare("DELETE FROM dreaming_evidence_consumption WHERE agent_id = ? AND source_entry_id = ?").run(
			agentId,
			sourceId,
		);
		const prefix = `${sourceId}:`;
		const embeddingRows = db
			.prepare(
				`SELECT id FROM embeddings
				 WHERE agent_id = ? AND source_type = ? AND source_id >= ? AND source_id < ?`,
			)
			.all(agentId, SOURCE_CHUNK_SOURCE_TYPE, prefix, `${prefix}\uffff`) as Array<{ id: string }>;
		const embeddingIds = embeddingRows.map((row) => row.id);
		if (!syncVecDeleteByEmbeddingIds(db, embeddingIds)) {
			throw new Error("failed to reconcile vec_embeddings before imported-source cleanup");
		}
		if (embeddingIds.length > 0) {
			const stmt = db.prepare("DELETE FROM embeddings WHERE id = ?");
			for (const id of embeddingIds) stmt.run(id);
		}

		const derivedMemoryRows = db
			.prepare(
				`SELECT DISTINCT dms.derived_memory_id AS id
				 FROM derived_memory_sources dms
				 JOIN memories derived ON derived.id = dms.derived_memory_id
				 WHERE dms.agent_id = ? AND dms.source_id = ?
				   AND derived.agent_id = ? AND derived.is_deleted = 0
				   AND derived.stale_at IS NULL`,
			)
			.all(agentId, sourceId, agentId) as Array<{ id: string }>;
		const derivedMemoryIds = derivedMemoryRows.map((row) => row.id);
		if (derivedMemoryIds.length > 0) {
			db.prepare(
				`UPDATE memories SET stale_at = ?
				 WHERE agent_id = ? AND stale_at IS NULL
				   AND id IN (${derivedMemoryIds.map(() => "?").join(", ")})`,
			).run(now, agentId, ...derivedMemoryIds);
		}

		const entityIds = db
			.prepare("SELECT id FROM entities WHERE agent_id = ? AND source_id = ?")
			.all(agentId, sourceId) as Array<{ id: string }>;
		const entityIdValues = entityIds.map((row) => row.id);
		const archiveReason = `unsupported source: ${reason}`;
		const entities = countChanges(
			db
				.prepare(
					`UPDATE entities SET status = 'archived', archived_at = ?, archived_by = ?, archive_reason = ?, updated_at = ?
				 WHERE agent_id = ? AND source_id = ? AND status = 'active'`,
				)
				.run(now, "source-lifecycle", archiveReason, now, agentId, sourceId),
		);
		let aspects = 0;
		if (entityIdValues.length > 0) {
			aspects = countChanges(
				db
					.prepare(
						`UPDATE entity_aspects SET status = 'archived', archived_at = ?, archived_by = ?, archive_reason = ?, updated_at = ?
					 WHERE agent_id = ? AND status = 'active'
					   AND entity_id IN (${entityIdValues.map(() => "?").join(", ")})`,
					)
					.run(now, "source-lifecycle", archiveReason, now, agentId, ...entityIdValues),
			);
		}
		const attributes = countChanges(
			db
				.prepare(
					`UPDATE entity_attributes SET status = 'archived', archived_at = ?, archived_by = ?, archive_reason = ?, updated_at = ?
				 WHERE agent_id = ? AND source_id = ? AND status = 'active'`,
				)
				.run(now, "source-lifecycle", archiveReason, now, agentId, sourceId),
		);
		const dependencies = countChanges(
			db
				.prepare(
					`UPDATE entity_dependencies SET status = 'archived', archived_at = ?, archived_by = ?, archive_reason = ?, updated_at = ?
				 WHERE agent_id = ? AND source_id = ? AND status = 'active'`,
				)
				.run(now, "source-lifecycle", archiveReason, now, agentId, sourceId),
		);

		enqueueDreamingAttentionInTx(db, {
			agentId,
			kind: "hygiene",
			subjectRef: `source:${sourceId}`,
			details: { sourceId, reason: "import-source-removed", lifecycle: "unsupported" },
			priority: 90,
		});
		return {
			artifacts,
			embeddings: embeddingIds.length,
			derivedMemories: derivedMemoryIds.length,
			entities,
			aspects,
			attributes,
			dependencies,
		};
	});
}
