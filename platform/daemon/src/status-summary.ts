import { detectSchemaType, type SchemaType } from "@signet/core";
import type { DbAccessor } from "./db-accessor";
import type { DbOwnerClient } from "./db-owner-client";
import { withRegisteredDbOwnerMaintenance } from "./db-owner-maintenance";
import { getDbOwnerForAccessor } from "./db-owner-runtime";
import { ownerReadOne } from "./db-owner-sql";
import { KNOWLEDGE_STATS_SQL, normalizeKnowledgeStatsRow, type KnowledgeStats } from "./knowledge-graph";

export interface WorkspaceStatusSummary {
	readonly agentId: string;
	readonly memoryCount: number;
	readonly capturedSessionCount: number | null;
	readonly schema: SchemaType;
	readonly needsMigration: boolean;
	readonly ontology: KnowledgeStats;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCount(row: Readonly<Record<string, unknown>> | undefined | null, key: string): number {
	if (row == null) throw new Error(`Workspace status count is unavailable: ${String(key)}`);
	const count = Number(row[key]);
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new Error(`Workspace status count is invalid: ${String(key)}`);
	}
	return count;
}

async function readWorkspaceSnapshot(
	owner: DbOwnerClient,
	agentId: string,
): Promise<{
	readonly memoryCount: number;
	readonly capturedSessionCount: number | null;
	readonly schema: SchemaType;
	readonly ontology: KnowledgeStats;
}> {
	const queryOptions = { deadlineMs: 5_000, estimatedWorkUnits: 1 } as const;
	const sessionTable = await ownerReadOne<{ readonly name: string }>(
		owner,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_transcripts'",
		[],
		{ operation: "db:status.workspace-summary.read", ...queryOptions },
	);
	const sessionCountSql =
		sessionTable === null
			? "NULL"
			: `(SELECT COUNT(DISTINCT session_key)
   FROM session_transcripts
   WHERE COALESCE(NULLIF(agent_id, ''), 'default') = ?)`;
	const memoryColumnsRow = await ownerReadOne<{ readonly columns: string | null }>(
		owner,
		"SELECT GROUP_CONCAT(name, ',') AS columns FROM pragma_table_info('memories')",
		[],
		{ operation: "db:status.workspace-summary.memory-columns", ...queryOptions },
	);
	const memoryColumnNames =
		typeof memoryColumnsRow?.columns === "string" && memoryColumnsRow.columns.length > 0
			? memoryColumnsRow.columns.split(",")
			: [];
	const memoryPlan = buildMemoryCountPlan(memoryColumnNames);
	const sql = `WITH knowledge AS (
${KNOWLEDGE_STATS_SQL}
)
SELECT
  ${memoryPlan.memoryCountSql},
  ${sessionCountSql} AS capturedSessionCount,
  knowledge.*
FROM knowledge`;
	// Placeholder order follows SQL text order: the knowledge CTE binds first,
	// then the memory-count and session-count subqueries in the outer SELECT.
	const params = [
		...Array(12).fill(agentId),
		...(memoryPlan.scopedByAgent ? [agentId] : []),
		...(sessionTable === null ? [] : [agentId]),
	];
	const row = await ownerReadOne<Record<string, unknown>>(owner, sql, params, {
		operation: "db:status.workspace-summary.snapshot",
		...queryOptions,
		estimatedWorkUnits: 16,
	});
	if (!isRecord(row)) throw new Error("Workspace status snapshot is unavailable");
	const memoryCount = readCount(row, "memoryCount");
	const capturedSessionCount = row.capturedSessionCount === null ? null : readCount(row, "capturedSessionCount");
	return {
		memoryCount,
		capturedSessionCount,
		schema: memoryPlan.schema,
		ontology: normalizeKnowledgeStatsRow(row),
	};
}

export function buildMemoryCountPlan(memoryColumns: readonly string[]): {
	readonly schema: SchemaType;
	readonly scopedByAgent: boolean;
	readonly memoryCountSql: string;
} {
	const schema = detectSchemaType(memoryColumns);
	if (schema === "unknown" && memoryColumns.length === 0) {
		throw new Error("Workspace status is unavailable: memories table not found");
	}
	const hasAgentScope = memoryColumns.includes("agent_id");
	const hasSoftDelete = memoryColumns.includes("is_deleted");
	if (schema === "core" && hasAgentScope) {
		// Legacy core databases predate migration 003: agent scoping exists but the
		// soft-delete column does not, so only the verified clauses may filter.
		const softDeleteClause = hasSoftDelete ? "\n     AND (is_deleted = 0 OR is_deleted IS NULL)" : "";
		return {
			schema,
			scopedByAgent: true,
			memoryCountSql: `(SELECT COUNT(*) FROM memories\n   WHERE COALESCE(NULLIF(agent_id, ''), 'default') = ?${softDeleteClause}) AS memoryCount`,
		};
	}
	// Legacy python/cli-v1 schemas predate agent scoping entirely: every row
	// belongs to the single workspace agent, so an unscoped count is correct and
	// keeps the summary (and its needsMigration signal) reportable.
	return { schema, scopedByAgent: false, memoryCountSql: "(SELECT COUNT(*) FROM memories) AS memoryCount" };
}

export async function getWorkspaceStatusSummary(
	accessor: DbAccessor,
	agentId: string,
): Promise<WorkspaceStatusSummary> {
	const result = await withRegisteredDbOwnerMaintenance(async () => {
		const owner = await getDbOwnerForAccessor(accessor);
		return await readWorkspaceSnapshot(owner, agentId);
	});
	if (result === undefined) throw new Error("DB owner is unavailable for workspace status");

	return {
		agentId,
		memoryCount: result.memoryCount,
		capturedSessionCount: result.capturedSessionCount,
		schema: result.schema,
		needsMigration: result.schema !== "core" && result.schema !== "unknown",
		ontology: result.ontology,
	};
}
