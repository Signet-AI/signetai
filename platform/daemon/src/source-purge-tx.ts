import { SOURCE_CHUNK_SOURCE_TYPE } from "@signet/core";
import { readScopeSql, type ReadScope } from "./read-scope";
import type { WriteDb } from "./db-accessor";
import { countChanges, syncVecDeleteByEmbeddingIds, tableExists } from "./db-helpers";
import { reconcileOntologyContradictionsInTx } from "./ontology-contradictions";
import { purgeAttributeMemoryProjectionsInTx } from "./semantic-memory-projection";
import { purgeSourceArtifactStructureInTx } from "./source-artifact-graph";

export function derivedPurgeOutcome(
	pinned: boolean,
	survivingCitation: boolean,
	survivingProvenance: boolean,
): "pinned" | "mixed" | "deleted" {
	return pinned ? "pinned" : survivingCitation || survivingProvenance ? "mixed" : "deleted";
}

interface MemoryPurgeTable {
	readonly name: string;
	readonly columns: readonly string[];
	readonly scoped: boolean;
}

const memoryPurgeSchemas = new WeakMap<
	WriteDb,
	{ readonly version: number; readonly tables: readonly MemoryPurgeTable[] }
>();

function quoted(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function memoryPurgeTables(db: WriteDb): readonly MemoryPurgeTable[] {
	const version = db.prepare("PRAGMA schema_version").get()?.schema_version;
	if (typeof version !== "number") throw new Error("Missing schema version for memory purge");
	const cached = memoryPurgeSchemas.get(db);
	if (cached?.version === version) return cached.tables;
	const tables: MemoryPurgeTable[] = [];
	for (const table of db
		.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
		.all<{ name: string }>()) {
		if (
			table.name === "memories" ||
			table.name === "memories_cold" ||
			table.name.startsWith("session_transcript_delete")
		)
			continue;
		const columns = new Set<string>();
		const fields = new Set<string>();
		for (const column of db.prepare(`PRAGMA table_info(${quoted(table.name)})`).all<{ name: string }>()) {
			fields.add(column.name);
			if (["memory_id", "derived_memory_id", "aggregate_memory_id", "source_memory_id"].includes(column.name))
				columns.add(column.name);
		}
		for (const foreign of db
			.prepare(`PRAGMA foreign_key_list(${quoted(table.name)})`)
			.all<{ table: string; from: string }>()) {
			if (foreign.table === "memories") columns.add(foreign.from);
		}
		if (columns.size)
			tables.push({
				name: table.name,
				columns: [...columns],
				scoped: fields.has("agent_id") && fields.has("compartment_id"),
			});
	}
	memoryPurgeSchemas.set(db, { version, tables });
	return tables;
}

export function purgeMemoryEmbeddingsInTx(db: WriteDb, memoryId: string, scope?: ReadScope): number {
	const read = scope
		? readScopeSql("e", scope, { visibility: null, memory: "source_id", session: null, source: null })
		: { sql: "", args: [] };
	const embeddings = db
		.prepare(
			`SELECT id FROM embeddings e WHERE source_type = 'memory' AND source_id = ?${read.sql} UNION SELECT id FROM embeddings_staging e WHERE source_type = 'memory' AND source_id = ?${read.sql}`,
		)
		.all<{ id: string }>(memoryId, ...read.args, memoryId, ...read.args);
	if (
		!syncVecDeleteByEmbeddingIds(
			db,
			embeddings.map((row) => row.id),
		)
	)
		throw new Error("Failed to reconcile memory vectors");
	for (const table of ["vec_embeddings", "vec_embeddings_staging"]) {
		if (!tableExists(db, table)) continue;
		for (const row of embeddings) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
	}
	for (const table of ["embeddings", "embeddings_staging"])
		db.prepare(
			`DELETE FROM ${table} WHERE id IN (SELECT e.id FROM ${table} e WHERE source_type='memory' AND source_id=?${read.sql})`,
		).run(memoryId, ...read.args);
	return embeddings.length;
}

export function purgeMemoryInTx(db: WriteDb, memoryId: string, scope?: ReadScope): void {
	if (scope) {
		const read = readScopeSql("m", scope);
		const coldRead = readScopeSql("c", scope, { visibility: null, memory: null, session: null, source: "source_id" });
		if (!db.prepare(`SELECT 1 FROM memories m WHERE m.id=?${read.sql}`).get(memoryId, ...read.args)) {
			db.prepare(
				`DELETE FROM memories_cold WHERE memory_id=? AND archive_id IN (SELECT c.archive_id FROM memories_cold c WHERE c.memory_id=? AND c.provenance_resolved=1${coldRead.sql})`,
			).run(memoryId, memoryId, ...coldRead.args);
			return;
		}
	}
	const coldRead = scope
		? readScopeSql("c", scope, { visibility: null, memory: null, session: null, source: "source_id" })
		: { sql: "", args: [] };
	if (tableExists(db, "memories_cold"))
		db.prepare(
			`DELETE FROM memories_cold WHERE archive_id IN (SELECT c.archive_id FROM memories_cold c WHERE c.memory_id=?${coldRead.sql})`,
		).run(memoryId, ...coldRead.args);
	const memory = db.prepare("SELECT pinned FROM memories WHERE id = ?").get(memoryId);
	if (!memory) return;
	if (memory.pinned === 1) throw new Error("Pinned memories cannot be purged by source deletion");
	for (const table of memoryPurgeTables(db)) {
		const read =
			scope && table.scoped
				? readScopeSql(
						"",
						{ ...scope, projects: null },
						{ visibility: null, memory: null, session: null, source: null },
					)
				: { sql: "", args: [] };
		db.prepare(
			`DELETE FROM ${quoted(table.name)} WHERE (${table.columns.map((column) => `${quoted(column)} = ?`).join(" OR ")})${read.sql}`,
		).run(...table.columns.map(() => memoryId), ...read.args);
	}
	for (const table of [
		"aggregate_evidence_sources",
		"dreaming_evidence_consumption",
		"dreaming_evidence_reviews",
		"dreaming_evidence_exclusions",
	]) {
		db.prepare(`DELETE FROM ${table} WHERE source_kind = 'memory' AND source_id = ?`).run(memoryId);
	}
	db.prepare("DELETE FROM memory_thread_heads WHERE node_id = ?").run(memoryId);
	db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
}

export function purgeSummaryRecordInTx(db: WriteDb, id: string, agentId: string, scope?: ReadScope): void {
	if (!purgeEvidenceReadable(db, "session_summaries", "id", id, agentId, scope)) return;
	purgeColdEvidenceInTx(db, id, agentId, scope);
	db.prepare("DELETE FROM session_summary_children WHERE parent_id=? OR child_id=?").run(id, id);
	db.prepare("DELETE FROM session_summary_memories WHERE summary_id=?").run(id);
	db.prepare("DELETE FROM memory_thread_heads WHERE agent_id=? AND node_id=?").run(agentId, id);
	db.prepare("DELETE FROM session_summaries WHERE id=? AND agent_id=?").run(id, agentId);
}
export function purgeDocumentRecordInTx(db: WriteDb, id: string, scope?: ReadScope): void {
	if (scope && !purgeEvidenceReadable(db, "documents", "id", id, undefined, scope)) return;
	purgeColdEvidenceInTx(db, id, undefined, scope);
	if (db.prepare("SELECT 1 FROM document_memories WHERE document_id=? LIMIT 1").get(id))
		throw new Error("Document still owns memory");
	db.prepare("DELETE FROM memory_jobs WHERE document_id=?").run(id);
	db.prepare("DELETE FROM documents WHERE id=?").run(id);
}
export function purgeArtifactRecordInTx(
	db: WriteDb,
	artifact: { readonly agent_id: string; readonly source_path: string; readonly source_id: string | null },
	scope?: ReadScope,
): void {
	if (!purgeEvidenceReadable(db, "memory_artifacts", "source_path", artifact.source_path, artifact.agent_id, scope))
		return;
	purgeColdEvidenceInTx(db, artifact.source_path, artifact.agent_id, scope);
	if (artifact.source_id)
		purgeSourceArtifactStructureInTx(db, {
			agentId: artifact.agent_id,
			sourceId: artifact.source_id,
			sourcePath: artifact.source_path,
		});
	db.prepare("DELETE FROM memory_artifacts WHERE agent_id=? AND source_path=?").run(
		artifact.agent_id,
		artifact.source_path,
	);
}

function purgeEvidenceReadable(
	db: WriteDb,
	table: string,
	key: string,
	id: string,
	agentId: string | undefined,
	scope?: ReadScope,
): boolean {
	if (!scope) return true;
	const read = readScopeSql("r", scope, {
		visibility: null,
		memory: null,
		session: table === "documents" ? null : "session_key",
		source: table === "memory_artifacts" ? "source_id" : null,
	});
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM ${table} r WHERE r.${key}=?${agentId === undefined ? "" : " AND r.agent_id=?"}${read.sql}`,
			)
			.get(id, ...(agentId === undefined ? [] : [agentId]), ...read.args),
	);
}

export function purgeColdEvidenceInTx(db: WriteDb, sourceId: string, agentId?: string, scope?: ReadScope): number {
	if (!tableExists(db, "memories_cold")) return 0;
	const read = scope
		? readScopeSql("c", scope, { visibility: null, memory: null, session: null, source: "source_id" })
		: { sql: "", args: [] };
	return db
		.prepare(
			`DELETE FROM memories_cold WHERE archive_id IN (SELECT c.archive_id FROM memories_cold c WHERE (c.source_id=? OR c.cold_source_id=?)${agentId === undefined ? "" : " AND c.agent_id=?"}${read.sql})`,
		)
		.run(sourceId, sourceId, ...(agentId === undefined ? [] : [agentId]), ...read.args).changes;
}

export interface PurgeSourceOwnedRowsInput {
	readonly sourceId: string;
	readonly agentId?: string;
}

const SOURCE_OWNED_GRAPH_TABLES = [
	"entity_attributes",
	"entity_dependencies",
	"entity_communities",
	"entities",
] as const;

export function purgeSourceOwnedRowsInTx(db: WriteDb, input: PurgeSourceOwnedRowsInput): number {
	const sourceId = input.sourceId.trim();
	if (!sourceId) return 0;
	const agents =
		input.agentId === undefined
			? db
					.prepare(
						"SELECT DISTINCT agent_id FROM classification_assignments WHERE target_kind='source' AND target_id=?",
					)
					.all(sourceId)
					.flatMap((row) =>
						typeof row === "object" && row !== null && "agent_id" in row && typeof row.agent_id === "string"
							? [row.agent_id]
							: [],
					)
			: [input.agentId];
	for (const agent of agents)
		db.prepare("DELETE FROM classification_assignments WHERE target_kind='source' AND target_id=? AND agent_id=?").run(
			sourceId,
			agent,
		);
	db.prepare(
		`DELETE FROM import_content_registry WHERE source_id=?${input.agentId === undefined ? "" : " AND agent_id=?"}`,
	).run(sourceId, ...(input.agentId === undefined ? [] : [input.agentId]));
	const embeddingPrefix = `${sourceId}:`;
	db.prepare(
		`DELETE FROM document_import_jobs WHERE source_id=?${input.agentId === undefined ? "" : " AND agent_id=?"}`,
	).run(sourceId, ...(input.agentId === undefined ? [] : [input.agentId]));
	const agentWhere = input.agentId !== undefined ? "agent_id = ? AND " : "";
	const embeddingRows = db
		.prepare(
			`SELECT id FROM embeddings
				 WHERE ${agentWhere}source_type = ?
				   AND source_id >= ?
				   AND source_id < ?`,
		)
		.all(
			...(input.agentId !== undefined ? [input.agentId] : []),
			SOURCE_CHUNK_SOURCE_TYPE,
			embeddingPrefix,
			`${embeddingPrefix}\uffff`,
		) as Array<{ id: string }>;
	const embeddingIds = embeddingRows.map((row) => row.id);
	if (!syncVecDeleteByEmbeddingIds(db, embeddingIds)) {
		throw new Error("failed to reconcile vec_embeddings before source purge");
	}
	let purged = embeddingIds.length + purgeColdEvidenceInTx(db, sourceId, input.agentId);

	if (embeddingIds.length > 0) {
		const stmt = db.prepare("DELETE FROM embeddings WHERE id = ?");
		for (const id of embeddingIds) stmt.run(id);
	}

	purged += countChanges(
		db
			.prepare(`DELETE FROM memory_artifacts WHERE ${agentWhere}source_id = ?`)
			.run(...(input.agentId !== undefined ? [input.agentId] : []), sourceId),
	);

	const entityRows = db
		.prepare(`SELECT id FROM entities WHERE ${agentWhere}source_id = ?`)
		.all(...(input.agentId !== undefined ? [input.agentId] : []), sourceId) as Array<{ id: string }>;
	if (entityRows.length > 0) {
		const stmt = db.prepare("DELETE FROM entity_aspects WHERE entity_id = ?");
		for (const row of entityRows) purged += countChanges(stmt.run(row.id));
	}

	purged += purgeAttributeMemoryProjectionsInTx(db, { sourceId, agentId: input.agentId });

	for (const table of SOURCE_OWNED_GRAPH_TABLES) {
		if (!tableHasColumn(db, table, "source_id")) continue;
		if (input.agentId !== undefined && !tableHasColumn(db, table, "agent_id")) continue;
		purged += countChanges(
			db
				.prepare(`DELETE FROM ${table} WHERE ${agentWhere}source_id = ?`)
				.run(...(input.agentId !== undefined ? [input.agentId] : []), sourceId),
		);
	}
	if (tableExists(db, "ontology_contradictions")) {
		if (input.agentId !== undefined) {
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
