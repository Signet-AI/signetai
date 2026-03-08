import type { DbAccessor } from "./db-accessor";
import { getStructuralDensity } from "./knowledge-graph";

export type StructuralCandidateSource =
	| "effective"
	| "fts_only"
	| "ka_traversal"
	| "ka_traversal_pinned";

export interface StructuralFeatures {
	/** Hashed entity ID (0-255, for embedding table lookup) */
	readonly entitySlot: number;
	/** Hashed primary aspect ID (0-255) */
	readonly aspectSlot: number;
	/** 1 if this memory is a constraint, 0 otherwise */
	readonly isConstraint: number;
	/** aspect_count + attribute_count for parent entity */
	readonly structuralDensity: number;
	/** Source: 'ka_traversal' | 'effective' | 'fts_only' | null */
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

export function getStructuralFeatures(
	accessor: DbAccessor,
	memoryIds: ReadonlyArray<string>,
	agentId: string,
	sourceById?: ReadonlyMap<string, StructuralCandidateSource>,
): Map<string, StructuralFeatures | null> {
	const featuresByMemoryId = new Map<string, StructuralFeatures | null>();
	for (const memoryId of memoryIds) {
		featuresByMemoryId.set(memoryId, null);
	}

	if (memoryIds.length === 0) return featuresByMemoryId;

	const primaryRows = accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT
					ea.memory_id,
					ea.kind,
					ea.aspect_id,
					ea.importance,
					ea.created_at,
					asp.entity_id
				 FROM entity_attributes ea
				 JOIN entity_aspects asp ON asp.id = ea.aspect_id
				 WHERE ea.memory_id IN (${buildPlaceholders(memoryIds.length)})
				   AND ea.agent_id = ?
				   AND ea.status = 'active'
				 ORDER BY ea.memory_id ASC,
				   CASE ea.kind WHEN 'constraint' THEN 0 ELSE 1 END,
				   ea.importance DESC,
				   ea.created_at ASC`,
			)
			.all(...memoryIds, agentId) as ReadonlyArray<StructuralAttributeRow>;

		const byMemoryId = new Map<string, StructuralAttributeRow>();
		for (const row of rows) {
			byMemoryId.set(row.memory_id, choosePrimaryRow(byMemoryId.get(row.memory_id), row));
		}
		return byMemoryId;
	});

	const densityCache = new Map<string, number>();
	for (const [memoryId, row] of primaryRows) {
		let density = densityCache.get(row.entity_id);
		if (density === undefined) {
			const structuralDensity = getStructuralDensity(accessor, row.entity_id, agentId);
			density = structuralDensity.aspectCount + structuralDensity.attributeCount;
			densityCache.set(row.entity_id, density);
		}

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

export function buildCandidateFeatures(
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
): ReadonlyArray<ReadonlyArray<number>> {
	if (candidates.length === 0) return [];

	void sessionContext.projectSlot;

	const candidateIds = candidates.map((candidate) => candidate.id);
	const sourceById = new Map<string, StructuralCandidateSource>();
	for (const candidate of candidates) {
		if (
			candidate.source === "effective" ||
			candidate.source === "fts_only" ||
			candidate.source === "ka_traversal"
		) {
			sourceById.set(candidate.id, candidate.source);
		}
	}
	const structuralById = getStructuralFeatures(
		accessor,
		candidateIds,
		agentId,
		sourceById,
	);
	const embeddedIds = accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT DISTINCT source_id
				 FROM embeddings
				 WHERE source_type = 'memory'
				   AND source_id IN (${buildPlaceholders(candidateIds.length)})`,
			)
			.all(...candidateIds) as ReadonlyArray<{ source_id: string }>;
		return new Set(rows.map((row) => row.source_id));
	});

	const nowMs = Date.now();
	const todAngle = (2 * Math.PI * sessionContext.timeOfDay) / 24;
	const dowAngle = (2 * Math.PI * sessionContext.dayOfWeek) / 7;
	const moyAngle = (2 * Math.PI * sessionContext.monthOfYear) / 12;
	const safeSessionGapDays = Math.max(0, sessionContext.sessionGapDays);

	return candidates.map((candidate) => {
		const structural = structuralById.get(candidate.id) ?? null;
		const source = structural?.candidateSource ?? candidate.source ?? null;
		return [
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
	});
}
