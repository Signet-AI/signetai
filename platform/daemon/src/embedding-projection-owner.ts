import {
	compartmentForWrite,
	syncEmbeddingCompartment,
	resetCompartmentVectorShards,
	type MigrationDb,
} from "@signet/core";
import type { EmbeddingProjectionRequest } from "./embedding-projection";

export function executeEmbeddingProjection(db: MigrationDb, request: EmbeddingProjectionRequest): { updated: number } {
	if (request.ids.length > 100) throw new Error("projection_admission_limit");
	const dims = request.resetDimensions;
	if (dims !== undefined && (!Number.isSafeInteger(dims) || dims < 1 || dims > 65536))
		throw new Error("invalid_dimensions");
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = executeEmbeddingProjectionInTx(db, request);
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
export function executeEmbeddingProjectionInTx(
	db: MigrationDb,
	request: EmbeddingProjectionRequest,
): { updated: number } {
	const dims = request.resetDimensions;
	if (request.ids.length > 100) throw new Error("projection_admission_limit");
	if (dims !== undefined && (!Number.isSafeInteger(dims) || dims < 1 || dims > 65536))
		throw new Error("invalid_dimensions");
	if (dims !== undefined) {
		resetCompartmentVectorShards(db, request.projection);
		db.exec(
			`DROP TABLE IF EXISTS ${request.projection};CREATE VIRTUAL TABLE ${request.projection} USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[${dims}] distance_metric=cosine)`,
		);
	}
	const ids = new Set(request.ids);
	for (const id of ids) syncEmbeddingCompartment(db, request.store, id, request.projection);
	return { updated: ids.size };
}

export function writeFilesystemDocumentInTx(
	db: import("./db-accessor").WriteDb,
	input: {
		readonly connectorId: string;
		readonly sourceUrl: string;
		readonly title: string;
		readonly content: string;
		readonly modifiedAt: number;
		readonly forceUpdate: boolean;
	},
): { readonly id: string; readonly added: number; readonly updated: number } {
	const connector = db.prepare("SELECT config_json FROM connectors WHERE id = ?").get(input.connectorId);
	if (typeof connector?.config_json !== "string") throw new Error("connector_agent_required");
	const config: unknown = JSON.parse(connector.config_json);
	const settings: unknown = typeof config === "object" && config !== null ? Reflect.get(config, "settings") : null;
	const agentId: unknown = typeof settings === "object" && settings !== null ? Reflect.get(settings, "agentId") : null;
	if (typeof agentId !== "string" || !agentId.trim()) throw new Error("connector_agent_required");
	if (!db.prepare("SELECT 1 AS found FROM agents WHERE id = ? AND archived_at IS NULL").get(agentId))
		throw new Error("connector_agent_not_found");
	const existing = db
		.prepare(
			"SELECT id,updated_at,compartment_id FROM documents WHERE source_url = ? AND connector_id = ? AND agent_id = ? AND status <> 'deleted' LIMIT 1",
		)
		.get(input.sourceUrl, input.connectorId, agentId);
	const now = new Date().toISOString();
	if (typeof existing?.id === "string") {
		if (
			!input.forceUpdate &&
			typeof existing.updated_at === "string" &&
			input.modifiedAt <= new Date(existing.updated_at).getTime()
		)
			return { id: existing.id, added: 0, updated: 0 };
		db.prepare(
			"UPDATE documents SET raw_content = ?, status = 'queued', error = NULL, chunk_count = 0, memory_count = 0, completed_at = NULL, updated_at = ?, compartment_id = ? WHERE id = ? AND agent_id = ? AND connector_id = ?",
		).run(
			input.content,
			now,
			compartmentForWrite(db, {
				agentId,
				sourceId: input.connectorId,
				parentCompartment: typeof existing.compartment_id === "number" ? existing.compartment_id : null,
			}),
			existing.id,
			agentId,
			input.connectorId,
		);
		return { id: existing.id, added: 0, updated: 1 };
	}
	const id = crypto.randomUUID();
	const compartment = compartmentForWrite(db, { agentId, sourceId: input.connectorId });
	db.prepare(
		"INSERT INTO documents (id,source_url,source_type,content_type,title,raw_content,status,connector_id,chunk_count,memory_count,created_at,updated_at,agent_id,author_user_id,compartment_id) VALUES (?,?,'file','text/plain',?,?,'queued',?,0,0,?,?,?,NULL,?)",
	).run(id, input.sourceUrl, input.title, input.content, input.connectorId, now, now, agentId, compartment);
	return { id, added: 1, updated: 0 };
}
