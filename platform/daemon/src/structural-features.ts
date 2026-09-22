import type { DbAccessor } from "./db-accessor";
import { getDbOwner } from "./db-owner-runtime";
import { ownerReadAll } from "./db-owner-sql";

export const PREDICTOR_FEATURE_DIMENSIONS = 17;

export type StructuralCandidateSource = "effective" | "fts_only" | "ka_traversal" | "ka_traversal_pinned";

export interface StructuralFeatures {
	readonly entitySlot: number;
	readonly aspectSlot: number;
	readonly isConstraint: number;
	readonly structuralDensity: number;
	readonly candidateSource: string | null;
}

interface StructuralAttributeRow {
	readonly memory_id: string;
	readonly kind: string;
	readonly aspect_id: string;
	readonly entity_id: string;
	readonly importance: number;
	readonly created_at: string;
}

interface StructuralDensityRow {
	readonly entity_id: string;
	readonly aspect_count: number;
	readonly attribute_count: number;
}

const OWNER_QUERY_BATCH_SIZE = 400;

function buildPlaceholders(count: number): string {
	return new Array(count).fill("?").join(", ");
}

function hashSlot(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) % 256;
}

function daysSince(iso: string, nowMs: number): number {
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return 0;
	return Math.max(0, (nowMs - ts) / 86_400_000);
}

function choosePrimaryRow(
	current: StructuralAttributeRow | undefined,
	next: StructuralAttributeRow,
): StructuralAttributeRow {
	if (!current) return next;
	const currentConstraint = current.kind === "constraint" ? 1 : 0;
	const nextConstraint = next.kind === "constraint" ? 1 : 0;
	if (nextConstraint !== currentConstraint) {
		return nextConstraint > currentConstraint ? next : current;
	}
	if (next.importance !== current.importance) {
		return next.importance > current.importance ? next : current;
	}
	return next.created_at < current.created_at ? next : current;
}

async function readStructuralAttributeRows(
	owner: Awaited<ReturnType<typeof getDbOwner>>,
	memoryIds: ReadonlyArray<string>,
	agentId: string,
): Promise<ReadonlyArray<StructuralAttributeRow>> {
	const rows: StructuralAttributeRow[] = [];
	for (let offset = 0; offset < memoryIds.length; offset += OWNER_QUERY_BATCH_SIZE) {
		const batch = memoryIds.slice(offset, offset + OWNER_QUERY_BATCH_SIZE);
		const placeholders = buildPlaceholders(batch.length);
		const batchRows = await ownerReadAll<StructuralAttributeRow>(
			owner,
			`SELECT
				ea.memory_id,
				ea.kind,
				ea.aspect_id,
				ea.importance,
				ea.created_at,
				asp.entity_id
			 FROM entity_attributes ea
			 JOIN entity_aspects asp ON asp.id = ea.aspect_id
			 WHERE ea.memory_id IN (${placeholders})
			   AND ea.agent_id = ?
			   AND ea.status = 'active'
			 ORDER BY ea.memory_id ASC,
			   CASE ea.kind WHEN 'constraint' THEN 0 ELSE 1 END,
			   ea.importance DESC,
			   ea.created_at ASC`,
			[...batch, agentId],
			{
				operation: "session-start.structural-features.attributes",
				lane: "read",
				deadlineMs: 5_000,
				estimatedWorkUnits: Math.max(1, Math.min(1_200, batch.length * 3)),
			},
		);
		rows.push(...batchRows);
	}
	return rows;
}

async function readStructuralDensities(
	owner: Awaited<ReturnType<typeof getDbOwner>>,
	entityIds: ReadonlyArray<string>,
	agentId: string,
): Promise<ReadonlyMap<string, number>> {
	const densities = new Map<string, number>();
	for (let offset = 0; offset < entityIds.length; offset += OWNER_QUERY_BATCH_SIZE) {
		const batch = entityIds.slice(offset, offset + OWNER_QUERY_BATCH_SIZE);
		const placeholders = buildPlaceholders(batch.length);
		const rows = await ownerReadAll<StructuralDensityRow>(
			owner,
			`SELECT entity_id, SUM(aspect_count) AS aspect_count, SUM(attribute_count) AS attribute_count
			 FROM (
				 SELECT entity_id, COUNT(*) AS aspect_count, 0 AS attribute_count
				 FROM entity_aspects
				 WHERE agent_id = ? AND entity_id IN (${placeholders})
				 GROUP BY entity_id
				 UNION ALL
				 SELECT asp.entity_id, 0 AS aspect_count, COUNT(*) AS attribute_count
				 FROM entity_attributes ea
				 JOIN entity_aspects asp ON asp.id = ea.aspect_id
				 WHERE asp.agent_id = ?
				   AND ea.agent_id = ?
				   AND ea.kind = 'attribute'
				   AND ea.status = 'active'
				   AND asp.entity_id IN (${placeholders})
				 GROUP BY asp.entity_id
			 )
			 GROUP BY entity_id`,
			[agentId, ...batch, agentId, agentId, ...batch],
			{
				operation: "session-start.structural-features.density",
				lane: "read",
				deadlineMs: 5_000,
				estimatedWorkUnits: Math.max(1, Math.min(1_200, batch.length * 3)),
			},
		);
		for (const row of rows) densities.set(row.entity_id, row.aspect_count + row.attribute_count);
	}
	return densities;
}

async function readEmbeddedMemoryIds(
	owner: Awaited<ReturnType<typeof getDbOwner>>,
	memoryIds: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> {
	const embeddedIds = new Set<string>();
	for (let offset = 0; offset < memoryIds.length; offset += OWNER_QUERY_BATCH_SIZE) {
		const batch = memoryIds.slice(offset, offset + OWNER_QUERY_BATCH_SIZE);
		const rows = await ownerReadAll<{ readonly source_id: string }>(
			owner,
			`SELECT DISTINCT source_id
			 FROM embeddings
			 WHERE source_type = 'memory'
			   AND source_id IN (${buildPlaceholders(batch.length)})`,
			batch,
			{
				operation: "session-start.structural-features.embeddings",
				lane: "read",
				deadlineMs: 5_000,
				estimatedWorkUnits: Math.max(1, Math.min(1_200, batch.length * 2)),
			},
		);
		for (const row of rows) embeddedIds.add(row.source_id);
	}
	return embeddedIds;
}

export async function getStructuralFeatures(
	accessor: DbAccessor,
	memoryIds: ReadonlyArray<string>,
	agentId: string,
	sourceById?: ReadonlyMap<string, StructuralCandidateSource>,
	ownerOverride?: Awaited<ReturnType<typeof getDbOwner>>,
): Promise<Map<string, StructuralFeatures | null>> {
	const featuresByMemoryId = new Map<string, StructuralFeatures | null>();
	for (const memoryId of memoryIds) {
		featuresByMemoryId.set(memoryId, null);
	}

	if (memoryIds.length === 0) return featuresByMemoryId;

	void accessor;
	const owner = ownerOverride ?? (await getDbOwner());
	const primaryRows = new Map<string, StructuralAttributeRow>();
	for (const row of await readStructuralAttributeRows(owner, memoryIds, agentId)) {
		primaryRows.set(row.memory_id, choosePrimaryRow(primaryRows.get(row.memory_id), row));
	}
	const entityIds = [...new Set([...primaryRows.values()].map((row) => row.entity_id))];
	const densities = await readStructuralDensities(owner, entityIds, agentId);

	for (const [memoryId, row] of primaryRows) {
		const density = densities.get(row.entity_id) ?? 0;

		featuresByMemoryId.set(memoryId, {
			entitySlot: hashSlot(row.entity_id),
			aspectSlot: hashSlot(row.aspect_id),
			isConstraint: row.kind === "constraint" ? 1 : 0,
			structuralDensity: density,
			candidateSource: sourceById?.get(memoryId) ?? null,
		});
	}

	return featuresByMemoryId;
}

export async function buildCandidateFeatures(
	accessor: DbAccessor,
	candidates: ReadonlyArray<{
		readonly id: string;
		readonly importance: number;
		readonly createdAt: string;
		readonly accessCount: number;
		readonly lastAccessed: string | null;
		readonly pinned: boolean;
		readonly isSuperseded: boolean;
		readonly source?: string;
	}>,
	agentId: string,
	sessionContext: {
		readonly projectSlot: number;
		readonly timeOfDay: number;
		readonly dayOfWeek: number;
		readonly monthOfYear: number;
		readonly sessionGapDays: number;
	},
): Promise<ReadonlyArray<ReadonlyArray<number>>> {
	if (candidates.length === 0) return [];

	void sessionContext.projectSlot;

	const candidateIds = candidates.map((candidate) => candidate.id);
	const sourceById = new Map<string, StructuralCandidateSource>();
	for (const candidate of candidates) {
		if (candidate.source === "effective" || candidate.source === "fts_only" || candidate.source === "ka_traversal") {
			sourceById.set(candidate.id, candidate.source);
		}
	}
	const owner = await getDbOwner();
	const structuralById = await getStructuralFeatures(accessor, candidateIds, agentId, sourceById, owner);
	const embeddedIds = await readEmbeddedMemoryIds(owner, candidateIds);

	const nowMs = Date.now();
	const todAngle = (2 * Math.PI * sessionContext.timeOfDay) / 24;
	const dowAngle = (2 * Math.PI * sessionContext.dayOfWeek) / 7;
	const moyAngle = (2 * Math.PI * sessionContext.monthOfYear) / 12;
	const safeSessionGapDays = Math.max(0, sessionContext.sessionGapDays);

	return candidates.map((candidate) => {
		const structural = structuralById.get(candidate.id) ?? null;
		const source = structural?.candidateSource ?? candidate.source ?? null;
		const vector = [
			Math.log(daysSince(candidate.createdAt, nowMs) + 1),
			candidate.importance,
			Math.log(candidate.accessCount + 1),
			Math.sin(todAngle),
			Math.cos(todAngle),
			Math.sin(dowAngle),
			Math.cos(dowAngle),
			Math.sin(moyAngle),
			Math.cos(moyAngle),
			Math.log(safeSessionGapDays + 1),
			embeddedIds.has(candidate.id) ? 1 : 0,
			candidate.isSuperseded ? 1 : 0,
			(structural?.entitySlot ?? 0) / 255,
			(structural?.aspectSlot ?? 0) / 255,
			structural?.isConstraint ?? 0,
			Math.log((structural?.structuralDensity ?? 0) + 1),
			source === "ka_traversal" ? 1 : 0,
		];
		if (vector.length !== PREDICTOR_FEATURE_DIMENSIONS) {
			throw new Error(
				`predictor feature vector dimension mismatch: expected ${PREDICTOR_FEATURE_DIMENSIONS}, got ${vector.length}`,
			);
		}
		return vector;
	});
}
