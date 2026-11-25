import { syncEmbeddingCompartment, resetCompartmentVectorShards, type MigrationDb } from "@signet/core";
import type { EmbeddingProjectionRequest } from "./embedding-projection";

export function executeEmbeddingProjection(db: MigrationDb, request: EmbeddingProjectionRequest): { updated: number } {
	if (request.ids.length + (request.contentHashes?.length ?? 0) > 100) throw new Error("projection_admission_limit");
	const dims = request.resetDimensions;
	if (dims !== undefined && (!Number.isSafeInteger(dims) || dims < 1 || dims > 65536))
		throw new Error("invalid_dimensions");
	db.exec("BEGIN IMMEDIATE");
	try {
		if (dims !== undefined) {
			resetCompartmentVectorShards(db, request.projection);
			db.exec(
				`DROP TABLE IF EXISTS ${request.projection};CREATE VIRTUAL TABLE ${request.projection} USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[${dims}] distance_metric=cosine)`,
			);
		}
		const ids = new Set(request.ids);
		for (const hash of request.contentHashes ?? []) {
			const row = db.prepare(`SELECT id FROM ${request.store} WHERE content_hash=?`).get(hash);
			if (typeof row?.id === "string") ids.add(row.id);
		}
		for (const id of ids) syncEmbeddingCompartment(db, request.store, id, request.projection);
		db.exec("COMMIT");
		return { updated: ids.size };
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
