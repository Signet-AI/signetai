import { SOURCE_CHUNK_SOURCE_TYPE } from "@signet/core";
import { getDbAccessor, runWriteTxAsync, type WriteDb } from "./db-accessor";
import { countChanges, syncVecDeleteByEmbeddingIds, tableExists } from "./db-helpers";
import { reconcileOntologyContradictionsInTx } from "./ontology-contradictions";
import { purgeTranscriptImportFilesystem } from "./transcript-import-worker";
import { purgeAttributeMemoryProjectionsInTx } from "./semantic-memory-projection";

interface PurgeSourceOwnedRowsInput {
	readonly sourceId: string;
	readonly agentId?: string;
}

const SOURCE_OWNED_GRAPH_TABLES = [
	"entity_attributes",
	"entity_dependencies",
	"entity_communities",
	"entities",
] as const;

export async function purgeSourceOwnedRows(input: PurgeSourceOwnedRowsInput): Promise<number> {
	const sourceId = input.sourceId.trim();
	if (!sourceId) return 0;
	let managedPaths: string[] = [];
	try {
		managedPaths = (
			await getDbAccessor().withReadDbAsync(
				(db) =>
					db
						.prepare(
							`SELECT managed_path FROM source_import_files WHERE ${input.agentId ? "agent_id = ? AND " : ""}source_id = ?`,
						)
						.all(...(input.agentId ? [input.agentId] : []), sourceId) as Array<{ managed_path: string }>,
			)
		).map((row) => row.managed_path);
	} catch {
		// Older databases do not have import ledgers.
	}
	await purgeTranscriptImportFilesystem(
		process.env.SIGNET_PATH ?? `${process.env.HOME ?? "."}/.agents`,
		sourceId,
		input.agentId,
		managedPaths,
	);
	return await runWriteTxAsync(getDbAccessor(), (db) => purgeSourceOwnedRowsInTx(db, input));
}

export function purgeSourceOwnedRowsInTx(db: WriteDb, input: PurgeSourceOwnedRowsInput): number {
	const sourceId = input.sourceId.trim();
	if (!sourceId) return 0;
	const embeddingPrefix = `${sourceId}:`;
	const agentWhere = input.agentId ? "agent_id = ? AND " : "";
	const embeddingRows = db
		.prepare(
			`SELECT id FROM embeddings
				 WHERE ${agentWhere}source_type = ?
				   AND source_id >= ?
				   AND source_id < ?`,
		)
		.all(
			...(input.agentId ? [input.agentId] : []),
			SOURCE_CHUNK_SOURCE_TYPE,
			embeddingPrefix,
			`${embeddingPrefix}\uffff`,
		) as Array<{
		id: string;
	}>;
	const embeddingIds = embeddingRows.map((row) => row.id);
	if (!syncVecDeleteByEmbeddingIds(db, embeddingIds)) {
		throw new Error("failed to reconcile vec_embeddings before source purge");
	}
	let purged = embeddingIds.length;
	// Imported transcripts are evidence owned by the source. Remove the body and
	// ledger rows together; the source config tombstone is retained by the
	// lifecycle caller for audit/replay purposes.
	if (tableHasColumn(db, "session_transcripts", "source_id")) {
		purged += countChanges(
			db
				.prepare(`DELETE FROM session_transcripts WHERE ${agentWhere}source_id = ?`)
				.run(...(input.agentId ? [input.agentId] : []), sourceId),
		);
	}
	if (tableExists(db, "source_import_jobs")) {
		purged += countChanges(
			db
				.prepare(
					`DELETE FROM source_import_jobs WHERE ${agentWhere}id IN (SELECT job_id FROM source_import_files WHERE source_id = ?)`,
				)
				.run(...(input.agentId ? [input.agentId] : []), sourceId),
		);
	}
	for (const table of ["source_import_records", "source_import_files"] as const) {
		if (!tableExists(db, table)) continue;
		purged += countChanges(
			db
				.prepare(`DELETE FROM ${table} WHERE ${agentWhere}source_id = ?`)
				.run(...(input.agentId ? [input.agentId] : []), sourceId),
		);
	}
	if (tableExists(db, "transcript_import_conversations")) {
		purged += countChanges(
			db
				.prepare(
					`UPDATE transcript_import_conversations SET state = 'removed', updated_at = datetime('now') WHERE ${agentWhere}owner_source_id = ? AND state != 'removed'`,
				)
				.run(...(input.agentId ? [input.agentId] : []), sourceId),
		);
	}
	if (embeddingIds.length > 0) {
		const stmt = db.prepare("DELETE FROM embeddings WHERE id = ?");
		for (const id of embeddingIds) stmt.run(id);
	}

	purged += countChanges(
		db
			.prepare(`DELETE FROM memory_artifacts WHERE ${agentWhere}source_id = ?`)
			.run(...(input.agentId ? [input.agentId] : []), sourceId),
	);

	const entityRows = db
		.prepare(`SELECT id FROM entities WHERE ${agentWhere}source_id = ?`)
		.all(...(input.agentId ? [input.agentId] : []), sourceId) as Array<{ id: string }>;
	if (entityRows.length > 0) {
		const stmt = db.prepare("DELETE FROM entity_aspects WHERE entity_id = ?");
		for (const row of entityRows) purged += countChanges(stmt.run(row.id));
	}

	purged += purgeAttributeMemoryProjectionsInTx(db, { sourceId, agentId: input.agentId });

	for (const table of SOURCE_OWNED_GRAPH_TABLES) {
		if (!tableHasColumn(db, table, "source_id")) continue;
		if (input.agentId && !tableHasColumn(db, table, "agent_id")) continue;
		purged += countChanges(
			db
				.prepare(`DELETE FROM ${table} WHERE ${agentWhere}source_id = ?`)
				.run(...(input.agentId ? [input.agentId] : []), sourceId),
		);
	}
	if (tableExists(db, "ontology_contradictions")) {
		if (input.agentId) {
			reconcileOntologyContradictionsInTx(db, { agentId: input.agentId, sourceId });
		} else {
			const agents = db
				.prepare(
					"SELECT DISTINCT agent_id FROM ontology_contradictions WHERE left_source_id = ? OR right_source_id = ?",
				)
				.all(sourceId, sourceId) as Array<{ agent_id: string }>;
			for (const agent of agents) {
				reconcileOntologyContradictionsInTx(db, { agentId: agent.agent_id, sourceId });
			}
		}
	}
	return purged;
}

function tableHasColumn(
	db: { prepare: (sql: string) => { all: () => unknown[] } },
	table: string,
	column: string,
): boolean {
	try {
		const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
		return rows.some((row) => row.name === column);
	} catch {
		return false;
	}
}
