import type { WriteDb } from "./db-accessor";

const SEMANTIC_PREMISE_KIND = "ontology_claim";
const EPISODIC_SOURCE_KINDS = new Set(["memory", "artifact", "transcript", "summary"]);

function validateSemanticPremise(db: WriteDb, agentId: string, sourceId: string): void {
	const row = db
		.prepare(
			`SELECT attr.agent_id AS attribute_agent_id,
			        attr.status AS attribute_status,
			        attr.superseded_by AS attribute_superseded_by,
			        attr.archived_at AS attribute_archived_at,
			        aspect.agent_id AS aspect_agent_id,
			        aspect.status AS aspect_status,
			        aspect.archived_at AS aspect_archived_at,
			        entity.agent_id AS entity_agent_id,
			        entity.status AS entity_status,
			        entity.archived_at AS entity_archived_at,
			        memory.agent_id AS memory_agent_id,
			        memory.is_deleted AS memory_is_deleted,
			        memory.stale_at AS memory_stale_at,
			        memory.superseded_by AS memory_superseded_by
			 FROM entity_attributes attr
			 JOIN entity_aspects aspect ON aspect.id = attr.aspect_id
			 JOIN entities entity ON entity.id = aspect.entity_id
			 LEFT JOIN memories memory ON memory.id = attr.memory_id
			 WHERE attr.id = ?`,
		)
		.get(sourceId) as
		| {
				attribute_agent_id: string | null;
				attribute_status: string | null;
				attribute_superseded_by: string | null;
				attribute_archived_at: string | null;
				aspect_agent_id: string | null;
				aspect_status: string | null;
				aspect_archived_at: string | null;
				entity_agent_id: string | null;
				entity_status: string | null;
				entity_archived_at: string | null;
				memory_agent_id: string | null;
				memory_is_deleted: number | null;
				memory_stale_at: string | null;
				memory_superseded_by: string | null;
		  }
		| null
		| undefined;
	if (
		row == null ||
		row.attribute_agent_id !== agentId ||
		row.aspect_agent_id !== agentId ||
		row.entity_agent_id !== agentId ||
		row.attribute_status !== "active" ||
		row.attribute_superseded_by !== null ||
		row.attribute_archived_at !== null ||
		row.aspect_status !== "active" ||
		row.aspect_archived_at !== null ||
		row.entity_status !== "active" ||
		row.entity_archived_at !== null ||
		(row.memory_agent_id !== null && row.memory_agent_id !== agentId) ||
		(row.memory_is_deleted !== null && row.memory_is_deleted !== 0) ||
		row.memory_stale_at !== null ||
		row.memory_superseded_by !== null
	) {
		throw new Error(`Derived memory provenance semantic premise is not in the authorized agent scope: ${sourceId}`);
	}
}

function validateSource(db: WriteDb, agentId: string, sourceKind: string, sourceId: string): void {
	if (sourceKind === SEMANTIC_PREMISE_KIND) {
		validateSemanticPremise(db, agentId, sourceId);
		return;
	}
	if (!EPISODIC_SOURCE_KINDS.has(sourceKind)) {
		throw new Error(`Derived memory provenance source kind is not supported: ${sourceKind}`);
	}
}

/** Validate one provenance source before a derived row or assertion is persisted. */
export function validateDerivedMemorySourceInTx(
	db: WriteDb,
	input: { readonly agentId: string; readonly sourceKind: string; readonly sourceId: string },
): void {
	validateSource(db, input.agentId, input.sourceKind, input.sourceId);
}

/** A canonical evidence record used to derive a semantic memory. */
export interface DerivedMemorySource {
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath?: string | null;
}

function required(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`Derived memory provenance ${field} is required`);
	return normalized;
}

/**
 * Record the immutable evidence identities that a derived memory depends on.
 * Callers use episodic record identity (`memory`, `artifact`, `transcript`,
 * `summary`) or a same-agent semantic premise (`ontology_claim`). Semantic
 * premise rows are checked before the relation is persisted so fabricated and
 * cross-agent pointers fail closed.
 */
export function linkDerivedMemorySourcesInTx(
	db: WriteDb,
	input: {
		readonly derivedMemoryId: string;
		readonly agentId: string;
		readonly sources: readonly DerivedMemorySource[];
		readonly createdAt: string;
	},
): void {
	const derivedMemoryId = required(input.derivedMemoryId, "derivedMemoryId");
	const agentId = required(input.agentId, "agentId");
	const createdAt = required(input.createdAt, "createdAt");
	const seen = new Set<string>();
	const insert = db.prepare(
		`INSERT OR IGNORE INTO derived_memory_sources
		 (derived_memory_id, source_kind, source_id, source_path, agent_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	for (const source of input.sources) {
		const sourceKind = required(source.sourceKind, "sourceKind");
		const sourceId = required(source.sourceId, "sourceId");
		const key = `${sourceKind}\u0000${sourceId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		validateDerivedMemorySourceInTx(db, { agentId, sourceKind, sourceId });
		insert.run(derivedMemoryId, sourceKind, sourceId, source.sourcePath?.trim() || null, agentId, createdAt);
	}
}

/**
 * Hide derived semantic rows immediately when one of their evidence records
 * changes. The relation is retained for audit and re-derivation; only the
 * derived row's currentness changes.
 */
export function markDerivedMemoriesStaleForSourceInTx(
	db: WriteDb,
	input: {
		readonly sourceKind: string;
		readonly sourceId: string;
		readonly agentId: string;
		readonly staleAt: string;
	},
): readonly string[] {
	const sourceKind = required(input.sourceKind, "sourceKind");
	const sourceId = required(input.sourceId, "sourceId");
	const agentId = required(input.agentId, "agentId");
	const staleAt = required(input.staleAt, "staleAt");
	const ids = db
		.prepare(
			`SELECT dms.derived_memory_id AS id
			 FROM derived_memory_sources dms
			 JOIN memories derived ON derived.id = dms.derived_memory_id
			 WHERE dms.agent_id = ?
			   AND dms.source_kind = ?
			   AND dms.source_id = ?
			   AND derived.agent_id = ?
			   AND derived.is_deleted = 0
			   AND derived.stale_at IS NULL`,
		)
		.all(agentId, sourceKind, sourceId, agentId) as Array<{ id: string }>;
	if (ids.length === 0) return [];
	db.prepare(
		`UPDATE memories
		 SET stale_at = ?
		 WHERE agent_id = ?
		   AND stale_at IS NULL
		   AND id IN (${ids.map(() => "?").join(", ")})`,
	).run(staleAt, agentId, ...ids.map((row) => row.id));
	return ids.map((row) => row.id);
}
