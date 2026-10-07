import type { WriteDb } from "./db-accessor";
import { syncVecDeleteByEmbeddingIds } from "./db-helpers";
import { txDecrementEntityMentions } from "./pipeline/graph-transactions";

export type AgentRemovalMode = "archive" | "purge";

export interface AgentRemovalInput {
	readonly agentId: string;
	readonly mode: AgentRemovalMode;
	readonly changedBy: string;
	readonly changedAt: string;
}

export type AgentRemovalResult =
	| { readonly status: "not_found" }
	| { readonly status: "removed"; readonly mode: AgentRemovalMode; readonly rows: Readonly<Record<string, number>> };

const AGENT_MEMORIES = "SELECT id FROM memories WHERE agent_id = ?";
const AGENT_ENTITIES = "SELECT id FROM entities WHERE agent_id = ?";
const AGENT_SUMMARIES = "SELECT id FROM session_summaries WHERE agent_id = ?";

const MEMORY_REFERENCES: ReadonlyArray<readonly [table: string, column: string]> = [
	["memory_history", "memory_id"],
	["memory_jobs", "memory_id"],
	["memory_hints", "memory_id"],
	["document_memories", "memory_id"],
	["session_memories", "memory_id"],
	["session_summary_memories", "memory_id"],
	["path_feedback_events", "memory_id"],
	["legacy_markdown_chunks", "memory_id"],
	["aggregate_memory_sources", "aggregate_memory_id"],
	["aggregate_memory_sources", "source_memory_id"],
	["aggregate_evidence_sources", "aggregate_memory_id"],
	["derived_memory_sources", "derived_memory_id"],
];

const ONTOLOGY_ARCHIVE_TABLES = ["entities", "entity_aspects", "entity_attributes", "entity_dependencies"] as const;

const MAX_SWEEP_PASSES = 4;

type Rows = Record<string, number>;

export function removeAgentInTx(db: WriteDb, input: AgentRemovalInput): AgentRemovalResult {
	if (!db.prepare("SELECT 1 FROM agents WHERE id = ?").get(input.agentId)) return { status: "not_found" };
	const rows: Rows = {};
	if (input.mode === "purge") purgeAgentRowsInTx(db, input, rows);
	else archiveAgentRowsInTx(db, input, rows);
	deleteCounted(db, rows, "agents", "id = ?", [input.agentId]);
	return { status: "removed", mode: input.mode, rows };
}

function countWhere(db: WriteDb, table: string, where: string, params: readonly unknown[]): number {
	const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`).get(...params) as { n: number };
	return row.n;
}

function record(rows: Rows, key: string, count: number): void {
	if (count > 0) rows[key] = (rows[key] ?? 0) + count;
}

function deleteCounted(db: WriteDb, rows: Rows, table: string, where: string, params: readonly unknown[]): number {
	const count = countWhere(db, table, where, params);
	if (count > 0) db.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...params);
	record(rows, table, count);
	return count;
}

function recordHistoryInTx(
	db: WriteDb,
	rows: Rows,
	input: AgentRemovalInput,
	event: "archived" | "purged",
	memoryFilter: string,
): void {
	const params = [input.agentId];
	const count = countWhere(db, "memories", memoryFilter, params);
	if (count === 0) return;
	db.prepare(
		`INSERT INTO memory_history (id, memory_id, event, old_content, new_content, changed_by, reason, metadata, created_at, actor_type)
		 SELECT lower(hex(randomblob(16))), id, ?, NULL, NULL, ?, ?, ?, ?, 'operator'
		 FROM memories WHERE ${memoryFilter}`,
	).run(
		event,
		input.changedBy,
		`agent ${input.agentId} ${event}`,
		JSON.stringify({ agentId: input.agentId, mode: input.mode }),
		input.changedAt,
		...params,
	);
	record(rows, `memory_history.${event}`, count);
}

function archiveAgentRowsInTx(db: WriteDb, input: AgentRemovalInput, rows: Rows): void {
	const unarchived = "agent_id = ? AND COALESCE(visibility, 'global') != 'archived'";
	recordHistoryInTx(db, rows, input, "archived", unarchived);
	const memories = countWhere(db, "memories", unarchived, [input.agentId]);
	db.prepare(
		`UPDATE memories SET visibility = 'archived', updated_at = ?, updated_by = ?, version = version + 1
		 WHERE ${unarchived}`,
	).run(input.changedAt, input.changedBy, input.agentId);
	record(rows, "memories", memories);
	const reason = `agent ${input.agentId} archived`;
	for (const table of ONTOLOGY_ARCHIVE_TABLES) {
		const count = countWhere(db, table, "agent_id = ? AND status = 'active'", [input.agentId]);
		db.prepare(
			`UPDATE ${table}
			 SET status = 'archived', archived_at = ?, archived_by = ?, archive_reason = ?, updated_at = ?
			 WHERE agent_id = ? AND status = 'active'`,
		).run(input.changedAt, input.changedBy, reason, input.changedAt, input.agentId);
		record(rows, table, count);
	}
}

function purgeAgentRowsInTx(db: WriteDb, input: AgentRemovalInput, rows: Rows): void {
	const agentId = input.agentId;
	const agentEmbeddings = `agent_id = ? OR (source_type = 'memory' AND source_id IN (${AGENT_MEMORIES}))`;
	const embeddingIds = (
		db.prepare(`SELECT id FROM embeddings WHERE ${agentEmbeddings}`).all(agentId, agentId) as Array<{ id: string }>
	).map((row) => row.id);
	if (!syncVecDeleteByEmbeddingIds(db, embeddingIds)) {
		throw new Error("failed to reconcile vec_embeddings before agent purge");
	}
	deleteCounted(db, rows, "embeddings", agentEmbeddings, [agentId, agentId]);

	const foreignEntityIds = (
		db
			.prepare(
				`SELECT DISTINCT entity_id FROM memory_entity_mentions
				 WHERE memory_id IN (${AGENT_MEMORIES}) AND entity_id NOT IN (${AGENT_ENTITIES})`,
			)
			.all(agentId, agentId) as Array<{ entity_id: string }>
	).map((row) => row.entity_id);
	deleteCounted(
		db,
		rows,
		"memory_entity_mentions",
		`memory_id IN (${AGENT_MEMORIES}) OR entity_id IN (${AGENT_ENTITIES})`,
		[agentId, agentId],
	);
	txDecrementEntityMentions(db, { entityIds: foreignEntityIds });
	deleteCounted(
		db,
		rows,
		"relations",
		`source_entity_id IN (${AGENT_ENTITIES}) OR target_entity_id IN (${AGENT_ENTITIES})`,
		[agentId, agentId],
	);
	deleteCounted(
		db,
		rows,
		"session_summary_children",
		`parent_id IN (${AGENT_SUMMARIES}) OR child_id IN (${AGENT_SUMMARIES})`,
		[agentId, agentId],
	);
	deleteCounted(db, rows, "session_summary_memories", `summary_id IN (${AGENT_SUMMARIES})`, [agentId]);
	deleteCounted(db, rows, "document_memories", "document_id IN (SELECT id FROM documents WHERE agent_id = ?)", [
		agentId,
	]);
	for (const [table, column] of MEMORY_REFERENCES) {
		deleteCounted(db, rows, table, `${column} IN (${AGENT_MEMORIES})`, [agentId]);
	}
	const detached = countWhere(db, "entity_attributes", `memory_id IN (${AGENT_MEMORIES})`, [agentId]);
	db.prepare(`UPDATE entity_attributes SET memory_id = NULL WHERE memory_id IN (${AGENT_MEMORIES})`).run(agentId);
	record(rows, "entity_attributes.memory_detached", detached);

	recordHistoryInTx(db, rows, input, "purged", "agent_id = ?");

	const tables = agentScopedTables(db);
	for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
		let changed = 0;
		for (const table of tables) changed += deleteCounted(db, rows, table, "agent_id = ?", [agentId]);
		if (changed === 0) break;
	}
	const remaining = tables.filter((table) => countWhere(db, table, "agent_id = ?", [agentId]) > 0);
	if (remaining.length > 0) {
		throw new Error(`agent purge left rows in: ${remaining.join(", ")}`);
	}
}

function agentScopedTables(db: WriteDb): string[] {
	const tables = db
		.prepare(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'
			 ORDER BY name`,
		)
		.all() as Array<{ name: string }>;
	return tables
		.map((row) => row.name)
		.filter((name) =>
			(db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).some(
				(column) => column.name === "agent_id",
			),
		);
}
