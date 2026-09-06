/**
 * Set-based, bounded owner reads for graph-backed recall context.
 *
 * The owner returns raw rows only. Safety scanning and all prompt-facing
 * assembly remain in the daemon process after each SQLite read completes.
 */

import type { DbOwnerClient } from "../db-owner-client";
import { ownerReadAll } from "../db-owner-sql";

export type ContextSafetyLedgerState = "available" | "missing" | "unavailable";

/**
 * Explicit accounting for the bounded context operation. `partial` means
 * that a focal-entity budget or safety-ledger failure limited the snapshot;
 * it is not used for ordinary content filtering.
 */
export interface ContextSnapshotWork {
	readonly focalEntityCount: number;
	readonly selectedEntityCount: number;
	readonly entityCount: number;
	readonly entityLimit: number;
	readonly omittedEntityCount: number;
	readonly statementCount: number;
	readonly estimatedWorkUnits: number;
	readonly partial: boolean;
	readonly safetyLedger: ContextSafetyLedgerState;
}

export interface ContextSnapshot {
	readonly entityIds: ReadonlyArray<string>;
	readonly entities: ReadonlyArray<EntityRow>;
	readonly aspects: ReadonlyArray<AspectRow>;
	readonly attributes: ReadonlyArray<AttributeRow>;
	readonly constraints: ReadonlyArray<ConstraintRow>;
	readonly dependencies: ReadonlyArray<DependencyRow>;
	readonly safety: ReadonlyMap<string, SafetyRow>;
	readonly safetyLedger: ContextSafetyLedgerState;
	readonly work: ContextSnapshotWork;
}

/** The hard entity and row budgets for one context snapshot. */
export const CONTEXT_MAX_ENTITIES = 32;
export const CONTEXT_MAX_ASPECTS_PER_ENTITY = 10;
export const CONTEXT_MAX_ATTRIBUTES_PER_ASPECT = 5;
export const CONTEXT_MAX_CONSTRAINTS_PER_ENTITY = 10;
export const CONTEXT_MAX_DEPENDENCIES_PER_ENTITY = 8;
/** Keep safety lookups below SQLite's variable-parameter limit. */
export const CONTEXT_SAFETY_BATCH_SIZE = 400;
export const CONTEXT_SNAPSHOT_MAX_SAFETY_BATCHES = Math.ceil(
	(CONTEXT_MAX_ENTITIES * CONTEXT_MAX_ASPECTS_PER_ENTITY * CONTEXT_MAX_ATTRIBUTES_PER_ASPECT * 2 +
		CONTEXT_MAX_ENTITIES * CONTEXT_MAX_CONSTRAINTS_PER_ENTITY) /
		CONTEXT_SAFETY_BATCH_SIZE,
);
export const CONTEXT_SNAPSHOT_MAX_STATEMENTS = 6 + CONTEXT_SNAPSHOT_MAX_SAFETY_BATCHES;
export const CONTEXT_SNAPSHOT_WORK_UNIT_CEILING = 10_000;

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

export interface EntityRow {
	readonly id: string;
	readonly name: string;
	readonly entity_type: string;
}

export interface AspectRow {
	readonly id: string;
	readonly entity_id: string;
	readonly name: string;
}

export interface AttributeRow {
	readonly aspect_id: string;
	readonly content: string;
	readonly kind: string;
	readonly status: string;
	readonly importance: number;
	readonly memory_id: string | null;
	readonly all_row_number: number;
	readonly kind_row_number: number;
}

export interface ConstraintRow {
	readonly entity_id: string;
	readonly content: string;
	readonly importance: number;
	readonly memory_id: string | null;
}

export interface DependencyRow {
	readonly source_entity_id: string;
	readonly target_entity_id: string;
	readonly name: string;
}

export interface SafetyRow {
	readonly source_id: string;
	readonly status: string;
	readonly context_eligible: number;
}

type AsyncSnapshotQuery = <Row extends object>(
	sql: string,
	params: readonly unknown[],
	workUnits: number,
) => Promise<ReadonlyArray<Row>>;

function sanitizeEntityIds(ids: ReadonlyArray<string>): string[] {
	const unique = new Set<string>();
	for (const id of ids) {
		if (typeof id === "string" && id.length > 0) unique.add(id);
	}
	return [...unique];
}

function normalizeEntityLimit(limit: number): number {
	if (!Number.isFinite(limit) || limit <= 0) return 1;
	return Math.min(CONTEXT_MAX_ENTITIES, Math.max(1, Math.trunc(limit)));
}

function emptySnapshot(focalEntityCount = 0, entityLimit = 0): ContextSnapshot {
	return {
		entityIds: [],
		entities: [],
		aspects: [],
		attributes: [],
		constraints: [],
		dependencies: [],
		safety: new Map(),
		safetyLedger: "missing",
		work: {
			focalEntityCount,
			selectedEntityCount: 0,
			entityCount: 0,
			entityLimit,
			omittedEntityCount: 0,
			statementCount: 0,
			estimatedWorkUnits: 0,
			partial: false,
			safetyLedger: "missing",
		},
	};
}

function contextWork(
	focalEntityCount: number,
	selectedEntityCount: number,
	entityCount: number,
	entityLimit: number,
	statementCount: number,
	estimatedWorkUnits: number,
	safetyLedger: ContextSafetyLedgerState,
): ContextSnapshotWork {
	const omittedEntityCount = Math.max(0, focalEntityCount - selectedEntityCount);
	return {
		focalEntityCount,
		selectedEntityCount,
		entityCount,
		entityLimit,
		omittedEntityCount,
		statementCount,
		estimatedWorkUnits,
		partial: omittedEntityCount > 0 || safetyLedger === "unavailable",
		safetyLedger,
	};
}

function placeholders(ids: ReadonlyArray<string>): string {
	return ids.map(() => "?").join(", ");
}

function estimatedUnits(value: number): number {
	return Math.max(1, Math.min(CONTEXT_SNAPSHOT_WORK_UNIT_CEILING, value));
}

function entityAspectSql(entityIds: ReadonlyArray<string>): string {
	return `WITH ranked AS (
			SELECT id, entity_id, name,
				ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY weight DESC, id) AS row_number
			FROM entity_aspects INDEXED BY idx_entity_aspects_entity
			WHERE entity_id IN (${placeholders(entityIds)}) AND agent_id = ?
		)
		SELECT id, entity_id, name
		FROM ranked
		WHERE row_number <= ?
		ORDER BY entity_id, row_number`;
}

function attributeSql(aspectIds: ReadonlyArray<string>): string {
	return `WITH ranked AS (
			SELECT aspect_id, content, kind, status, importance, memory_id,
				ROW_NUMBER() OVER (PARTITION BY aspect_id ORDER BY importance DESC, rowid) AS all_row_number,
				ROW_NUMBER() OVER (
					PARTITION BY aspect_id, (kind = 'constraint')
					ORDER BY importance DESC, rowid
				) AS kind_row_number
			FROM entity_attributes INDEXED BY idx_entity_attributes_aspect
			WHERE aspect_id IN (${placeholders(aspectIds)})
			  AND agent_id = ?
			  AND status = 'active'
		)
		SELECT aspect_id, content, kind, status, importance, memory_id, all_row_number, kind_row_number
		FROM ranked
		WHERE all_row_number <= ?
		   OR (kind != 'constraint' AND kind_row_number <= ?)
		ORDER BY aspect_id, all_row_number, kind_row_number`;
}

function constraintSql(entityIds: ReadonlyArray<string>): string {
	return `WITH candidates AS (
			SELECT DISTINCT asp.entity_id, ea.content, ea.importance, ea.memory_id
			FROM entity_aspects asp INDEXED BY idx_entity_aspects_entity
			CROSS JOIN entity_attributes ea INDEXED BY idx_entity_attributes_aspect
			  ON ea.aspect_id = asp.id
			WHERE asp.entity_id IN (${placeholders(entityIds)})
			  AND asp.agent_id = ?
			  AND ea.agent_id = ?
			  AND ea.kind = 'constraint'
			  AND ea.status = 'active'
		), ranked AS (
			SELECT entity_id, content, importance, memory_id,
				ROW_NUMBER() OVER (
					PARTITION BY entity_id
					ORDER BY importance DESC, content, COALESCE(memory_id, '')
				) AS row_number
			FROM candidates
		)
		SELECT entity_id, content, importance, memory_id
		FROM ranked
		WHERE row_number <= ?
		ORDER BY entity_id, row_number`;
}

function dependencySql(entityIds: ReadonlyArray<string>): string {
	return `WITH ranked AS (
			SELECT ed.source_entity_id, ed.target_entity_id, e.name,
				ROW_NUMBER() OVER (
					PARTITION BY ed.source_entity_id
					ORDER BY ed.strength DESC, ed.target_entity_id
				) AS row_number
			FROM entity_dependencies ed INDEXED BY idx_entity_dependencies_source
			JOIN entities e
			  ON e.id = ed.target_entity_id AND e.agent_id = ?
			WHERE ed.source_entity_id IN (${placeholders(entityIds)})
			  AND ed.agent_id = ?
			  AND ed.strength >= 0.3
		)
		SELECT source_entity_id, target_entity_id, name
		FROM ranked
		WHERE row_number <= ?
		ORDER BY source_entity_id, row_number`;
}

function safetySql(memoryIds: ReadonlyArray<string>): string {
	return `SELECT source_id, status, context_eligible
		FROM memory_content_safety
		WHERE agent_id = ? AND source_kind = 'memory'
		  AND source_id IN (${placeholders(memoryIds)})`;
}

// ---------------------------------------------------------------------------
// Owner snapshot loading
// ---------------------------------------------------------------------------

function finalizeSnapshot(
	focalEntityIds: ReadonlyArray<string>,
	selectedEntityIds: ReadonlyArray<string>,
	entities: ReadonlyArray<EntityRow>,
	aspects: ReadonlyArray<AspectRow>,
	attributes: ReadonlyArray<AttributeRow>,
	constraints: ReadonlyArray<ConstraintRow>,
	dependencies: ReadonlyArray<DependencyRow>,
	safety: ReadonlyArray<SafetyRow>,
	safetyLedger: ContextSafetyLedgerState,
	entityLimit: number,
	statementCount: number,
	estimatedWorkUnits: number,
): ContextSnapshot {
	const entityById = new Map(entities.map((entity) => [entity.id, entity]));
	const orderedEntities = selectedEntityIds.flatMap((id) => {
		const entity = entityById.get(id);
		return entity ? [entity] : [];
	});
	const entityIds = orderedEntities.map((entity) => entity.id);
	const safetyById = new Map(safety.map((row) => [row.source_id, row]));
	return {
		entityIds,
		entities: orderedEntities,
		aspects,
		attributes,
		constraints,
		dependencies,
		safety: safetyById,
		safetyLedger,
		work: contextWork(
			focalEntityIds.length,
			selectedEntityIds.length,
			orderedEntities.length,
			entityLimit,
			statementCount,
			estimatedWorkUnits,
			safetyLedger,
		),
	};
}

async function readContextSnapshotViaOwner(
	query: AsyncSnapshotQuery,
	agentId: string,
	focalEntityIds: ReadonlyArray<string>,
	entityLimitInput: number,
): Promise<ContextSnapshot> {
	const focalIds = sanitizeEntityIds(focalEntityIds);
	if (focalIds.length === 0) return emptySnapshot();
	const entityLimit = normalizeEntityLimit(entityLimitInput);
	const selectedIds = focalIds.slice(0, entityLimit);
	let statementCount = 0;
	let estimatedWorkUnitsTotal = 0;
	const read: AsyncSnapshotQuery = async <Row extends object>(
		sql: string,
		params: readonly unknown[],
		workUnits: number,
	): Promise<ReadonlyArray<Row>> => {
		statementCount++;
		const units = estimatedUnits(workUnits);
		estimatedWorkUnitsTotal += units;
		return await query<Row>(sql, params, units);
	};

	let safetyLedger: ContextSafetyLedgerState = "unavailable";
	try {
		const tableRows = await read<{ readonly name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_content_safety'",
			[],
			1,
		);
		safetyLedger = tableRows.length > 0 ? "available" : "missing";
	} catch {
		// A safety-schema failure must fail closed for memory-backed rows.
	}

	const entities = await read<EntityRow>(
		`SELECT id, name, entity_type FROM entities
			WHERE agent_id = ? AND id IN (${placeholders(selectedIds)})`,
		[agentId, ...selectedIds],
		selectedIds.length,
	);
	if (entities.length === 0)
		return finalizeSnapshot(
			focalIds,
			selectedIds,
			[],
			[],
			[],
			[],
			[],
			[],
			safetyLedger,
			entityLimit,
			statementCount,
			estimatedWorkUnitsTotal,
		);

	const entityIds = entities.map((entity) => entity.id);
	const aspects = await read<AspectRow>(
		entityAspectSql(entityIds),
		[...entityIds, agentId, CONTEXT_MAX_ASPECTS_PER_ENTITY],
		entityIds.length * CONTEXT_MAX_ASPECTS_PER_ENTITY,
	);
	const aspectIds = aspects.map((aspect) => aspect.id);
	const attributes =
		aspectIds.length === 0
			? []
			: await read<AttributeRow>(
					attributeSql(aspectIds),
					[...aspectIds, agentId, CONTEXT_MAX_ATTRIBUTES_PER_ASPECT, CONTEXT_MAX_ATTRIBUTES_PER_ASPECT],
					aspectIds.length * CONTEXT_MAX_ATTRIBUTES_PER_ASPECT * 2,
				);
	const constraints = await read<ConstraintRow>(
		constraintSql(entityIds),
		[...entityIds, agentId, agentId, CONTEXT_MAX_CONSTRAINTS_PER_ENTITY],
		entityIds.length * CONTEXT_MAX_CONSTRAINTS_PER_ENTITY,
	);
	const dependencies = await read<DependencyRow>(
		dependencySql(entityIds),
		[agentId, ...entityIds, agentId, CONTEXT_MAX_DEPENDENCIES_PER_ENTITY],
		entityIds.length * CONTEXT_MAX_DEPENDENCIES_PER_ENTITY,
	);
	const memoryIds = sanitizeEntityIds([
		...attributes.flatMap((attribute) => (attribute.memory_id ? [attribute.memory_id] : [])),
		...constraints.flatMap((constraint) => (constraint.memory_id ? [constraint.memory_id] : [])),
	]);
	let safety: ReadonlyArray<SafetyRow> = [];
	if (safetyLedger === "available" && memoryIds.length > 0) {
		const safetyRows: SafetyRow[] = [];
		for (let offset = 0; offset < memoryIds.length; offset += CONTEXT_SAFETY_BATCH_SIZE) {
			const batch = memoryIds.slice(offset, offset + CONTEXT_SAFETY_BATCH_SIZE);
			try {
				safetyRows.push(...(await read<SafetyRow>(safetySql(batch), [agentId, ...batch], batch.length)));
			} catch {
				// A failed safety batch makes every memory-backed projection unsafe.
				safetyLedger = "unavailable";
				break;
			}
		}
		safety = safetyRows;
	}
	return finalizeSnapshot(
		focalIds,
		selectedIds,
		entities,
		aspects,
		attributes,
		constraints,
		dependencies,
		safety,
		safetyLedger,
		entityLimit,
		statementCount,
		estimatedWorkUnitsTotal,
	);
}

/** Read a bounded, set-based context snapshot through the serialized owner. */
export async function loadContextSnapshotViaOwner(
	owner: DbOwnerClient,
	agentId: string,
	focalEntityIds: ReadonlyArray<string>,
	entityLimit: number,
): Promise<ContextSnapshot> {
	const query: AsyncSnapshotQuery = async <Row extends object>(
		sql: string,
		params: readonly unknown[],
		workUnits: number,
	): Promise<ReadonlyArray<Row>> =>
		await ownerReadAll<Row>(owner, sql, params, {
			operation: "memory-search.context.snapshot",
			lane: "read",
			workloadClass: "foreground",
			deadlineMs: 30_000,
			estimatedWorkUnits: estimatedUnits(workUnits),
		});
	return await readContextSnapshotViaOwner(query, agentId, focalEntityIds, entityLimit);
}
