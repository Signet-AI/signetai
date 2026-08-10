import { SOURCE_CHUNK_SOURCE_TYPE } from "@signet/core";
import { getDbAccessor } from "./db-accessor";
import { countChanges, syncVecDeleteByEmbeddingIds, tableExists } from "./db-helpers";
import { reconcileOntologyContradictionsInTx } from "./ontology-contradictions";
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

export function purgeSourceOwnedRows(input: PurgeSourceOwnedRowsInput): number {
	const sourceId = input.sourceId.trim();
	if (!sourceId) return 0;
	return getDbAccessor().withWriteTx((db) => {
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
		syncVecDeleteByEmbeddingIds(db, embeddingIds);
		let purged = embeddingIds.length;
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
	});
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
