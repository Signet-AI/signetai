/**
 * Knowledge graph CRUD operations for KA-1.
 *
 * Provides read/write helpers for entity aspects, attributes,
 * dependencies, task metadata, and structural density queries.
 * All writes go through withWriteTx, all reads through withReadDb.
 *
 * Follows the DbAccessor pattern established in skill-graph.ts.
 */

import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import type {
	EntityAspect,
	EntityAttribute,
	EntityDependency,
	TaskMeta,
	AttributeKind,
	AttributeStatus,
	DependencyType,
	TaskStatus,
} from "@signet/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toCanonicalName(raw: string): string {
	return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function now(): string {
	return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToAspect(r: Record<string, unknown>): EntityAspect {
	return {
		id: r.id as string,
		entityId: r.entity_id as string,
		agentId: r.agent_id as string,
		name: r.name as string,
		canonicalName: r.canonical_name as string,
		weight: r.weight as number,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
	};
}

function rowToAttribute(r: Record<string, unknown>): EntityAttribute {
	return {
		id: r.id as string,
		aspectId: r.aspect_id as string,
		agentId: r.agent_id as string,
		memoryId: (r.memory_id as string) ?? null,
		kind: r.kind as AttributeKind,
		content: r.content as string,
		normalizedContent: r.normalized_content as string,
		confidence: r.confidence as number,
		importance: r.importance as number,
		status: r.status as AttributeStatus,
		supersededBy: (r.superseded_by as string) ?? null,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
	};
}

function rowToDependency(r: Record<string, unknown>): EntityDependency {
	return {
		id: r.id as string,
		sourceEntityId: r.source_entity_id as string,
		targetEntityId: r.target_entity_id as string,
		agentId: r.agent_id as string,
		aspectId: (r.aspect_id as string) ?? null,
		dependencyType: r.dependency_type as DependencyType,
		strength: r.strength as number,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
	};
}

function rowToTaskMeta(r: Record<string, unknown>): TaskMeta {
	return {
		entityId: r.entity_id as string,
		agentId: r.agent_id as string,
		status: r.status as TaskStatus,
		expiresAt: (r.expires_at as string) ?? null,
		retentionUntil: (r.retention_until as string) ?? null,
		completedAt: (r.completed_at as string) ?? null,
		updatedAt: r.updated_at as string,
	};
}

// ---------------------------------------------------------------------------
// Aspects
// ---------------------------------------------------------------------------

export interface UpsertAspectParams {
	readonly entityId: string;
	readonly agentId: string;
	readonly name: string;
	readonly weight?: number;
}

export function upsertAspect(
	accessor: DbAccessor,
	params: UpsertAspectParams,
): EntityAspect {
	const canonical = toCanonicalName(params.name);
	const ts = now();
	const id = crypto.randomUUID();

	return accessor.withWriteTx((db) => {
		// Uses ON CONFLICT on the UNIQUE(entity_id, canonical_name) constraint
		db.prepare(
			`INSERT INTO entity_aspects
			 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(entity_id, canonical_name) DO UPDATE SET
			   name = excluded.name,
			   weight = COALESCE(excluded.weight, entity_aspects.weight),
			   updated_at = excluded.updated_at`,
		).run(
			id,
			params.entityId,
			params.agentId,
			params.name,
			canonical,
			params.weight ?? 0.5,
			ts,
			ts,
		);

		// Read back the actual row (may have kept old id on conflict)
		const row = db
			.prepare(
				`SELECT * FROM entity_aspects
				 WHERE entity_id = ? AND canonical_name = ? AND agent_id = ?`,
			)
			.get(params.entityId, canonical, params.agentId) as Record<string, unknown>;
		return rowToAspect(row);
	});
}

export function getAspectsForEntity(
	accessor: DbAccessor,
	entityId: string,
	agentId: string,
): readonly EntityAspect[] {
	return accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT * FROM entity_aspects
				 WHERE entity_id = ? AND agent_id = ?
				 ORDER BY weight DESC`,
			)
			.all(entityId, agentId) as Array<Record<string, unknown>>;
		return rows.map(rowToAspect);
	});
}

export function deleteAspect(accessor: DbAccessor, aspectId: string): void {
	accessor.withWriteTx((db) => {
		db.prepare("DELETE FROM entity_aspects WHERE id = ?").run(aspectId);
	});
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

export interface CreateAttributeParams {
	readonly aspectId: string;
	readonly agentId: string;
	readonly memoryId?: string;
	readonly kind: AttributeKind;
	readonly content: string;
	readonly confidence?: number;
	readonly importance?: number;
}

export function createAttribute(
	accessor: DbAccessor,
	params: CreateAttributeParams,
): EntityAttribute {
	const id = crypto.randomUUID();
	const ts = now();
	const normalized = params.content.trim().toLowerCase().replace(/\s+/g, " ");

	return accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, memory_id, kind, content,
			  normalized_content, confidence, importance, status,
			  created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
		).run(
			id,
			params.aspectId,
			params.agentId,
			params.memoryId ?? null,
			params.kind,
			params.content,
			normalized,
			params.confidence ?? 0.0,
			params.importance ?? 0.5,
			ts,
			ts,
		);

		return {
			id,
			aspectId: params.aspectId,
			agentId: params.agentId,
			memoryId: params.memoryId ?? null,
			kind: params.kind,
			content: params.content,
			normalizedContent: normalized,
			confidence: params.confidence ?? 0.0,
			importance: params.importance ?? 0.5,
			status: "active" as const,
			supersededBy: null,
			createdAt: ts,
			updatedAt: ts,
		};
	});
}

export function getAttributesForAspect(
	accessor: DbAccessor,
	aspectId: string,
	agentId: string,
): readonly EntityAttribute[] {
	return accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT * FROM entity_attributes
				 WHERE aspect_id = ? AND agent_id = ? AND status = 'active'
				 ORDER BY importance DESC`,
			)
			.all(aspectId, agentId) as Array<Record<string, unknown>>;
		return rows.map(rowToAttribute);
	});
}

/**
 * Get all constraints for an entity across all its aspects.
 * Joins through entity_aspects to collect kind='constraint' rows.
 * This is the query that enforces the "constraints always surface" invariant.
 */
export function getConstraintsForEntity(
	accessor: DbAccessor,
	entityId: string,
	agentId: string,
): readonly EntityAttribute[] {
	return accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT ea.* FROM entity_attributes ea
				 JOIN entity_aspects asp ON asp.id = ea.aspect_id
				 WHERE asp.entity_id = ? AND asp.agent_id = ?
				   AND ea.agent_id = ?
				   AND ea.kind = 'constraint'
				   AND ea.status = 'active'
				 ORDER BY ea.importance DESC`,
			)
			.all(entityId, agentId, agentId) as Array<Record<string, unknown>>;
		return rows.map(rowToAttribute);
	});
}

export function supersedeAttribute(
	accessor: DbAccessor,
	id: string,
	supersededById: string,
): void {
	const ts = now();
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE entity_attributes
			 SET status = 'superseded', superseded_by = ?, updated_at = ?
			 WHERE id = ?`,
		).run(supersededById, ts, id);
	});
}

export function deleteAttribute(accessor: DbAccessor, id: string): void {
	const ts = now();
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE entity_attributes
			 SET status = 'deleted', updated_at = ?
			 WHERE id = ?`,
		).run(ts, id);
	});
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface UpsertDependencyParams {
	readonly sourceEntityId: string;
	readonly targetEntityId: string;
	readonly agentId: string;
	readonly aspectId?: string;
	readonly dependencyType: DependencyType;
	readonly strength?: number;
}

export function upsertDependency(
	accessor: DbAccessor,
	params: UpsertDependencyParams,
): EntityDependency {
	const ts = now();

	return accessor.withWriteTx((db) => {
		const existing = db
			.prepare(
				`SELECT * FROM entity_dependencies
				 WHERE source_entity_id = ? AND target_entity_id = ?
				   AND dependency_type = ? AND agent_id = ?`,
			)
			.get(
				params.sourceEntityId,
				params.targetEntityId,
				params.dependencyType,
				params.agentId,
			) as Record<string, unknown> | undefined;

		if (existing) {
			db.prepare(
				`UPDATE entity_dependencies
				 SET strength = ?, aspect_id = ?, updated_at = ?
				 WHERE id = ?`,
			).run(
				params.strength ?? (existing.strength as number),
				params.aspectId ?? (existing.aspect_id as string | null),
				ts,
				existing.id as string,
			);
			return rowToDependency({
				...existing,
				strength: params.strength ?? (existing.strength as number),
				aspect_id: params.aspectId ?? (existing.aspect_id as string | null),
				updated_at: ts,
			});
		}

		const id = crypto.randomUUID();
		db.prepare(
			`INSERT INTO entity_dependencies
			 (id, source_entity_id, target_entity_id, agent_id,
			  aspect_id, dependency_type, strength, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			params.sourceEntityId,
			params.targetEntityId,
			params.agentId,
			params.aspectId ?? null,
			params.dependencyType,
			params.strength ?? 0.5,
			ts,
			ts,
		);

		return {
			id,
			sourceEntityId: params.sourceEntityId,
			targetEntityId: params.targetEntityId,
			agentId: params.agentId,
			aspectId: params.aspectId ?? null,
			dependencyType: params.dependencyType,
			strength: params.strength ?? 0.5,
			createdAt: ts,
			updatedAt: ts,
		};
	});
}

export function getDependenciesFrom(
	accessor: DbAccessor,
	entityId: string,
	agentId: string,
): readonly EntityDependency[] {
	return accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT * FROM entity_dependencies
				 WHERE source_entity_id = ? AND agent_id = ?`,
			)
			.all(entityId, agentId) as Array<Record<string, unknown>>;
		return rows.map(rowToDependency);
	});
}

export function getDependenciesTo(
	accessor: DbAccessor,
	entityId: string,
	agentId: string,
): readonly EntityDependency[] {
	return accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT * FROM entity_dependencies
				 WHERE target_entity_id = ? AND agent_id = ?`,
			)
			.all(entityId, agentId) as Array<Record<string, unknown>>;
		return rows.map(rowToDependency);
	});
}

export function deleteDependency(accessor: DbAccessor, id: string): void {
	accessor.withWriteTx((db) => {
		db.prepare("DELETE FROM entity_dependencies WHERE id = ?").run(id);
	});
}

// ---------------------------------------------------------------------------
// Task meta
// ---------------------------------------------------------------------------

export interface UpsertTaskMetaParams {
	readonly entityId: string;
	readonly agentId: string;
	readonly status: TaskStatus;
	readonly expiresAt?: string;
	readonly retentionUntil?: string;
}

export function upsertTaskMeta(
	accessor: DbAccessor,
	params: UpsertTaskMetaParams,
): TaskMeta {
	const ts = now();

	const completedAt =
		params.status === "done" || params.status === "cancelled" ? ts : null;

	return accessor.withWriteTx((db) => {
		// entity_id is PRIMARY KEY, so ON CONFLICT handles the upsert
		db.prepare(
			`INSERT INTO task_meta
			 (entity_id, agent_id, status, expires_at, retention_until,
			  completed_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(entity_id) DO UPDATE SET
			   status = excluded.status,
			   expires_at = excluded.expires_at,
			   retention_until = excluded.retention_until,
			   completed_at = excluded.completed_at,
			   updated_at = excluded.updated_at`,
		).run(
			params.entityId,
			params.agentId,
			params.status,
			params.expiresAt ?? null,
			params.retentionUntil ?? null,
			completedAt,
			ts,
		);

		return {
			entityId: params.entityId,
			agentId: params.agentId,
			status: params.status,
			expiresAt: params.expiresAt ?? null,
			retentionUntil: params.retentionUntil ?? null,
			completedAt,
			updatedAt: ts,
		};
	});
}

export function getTaskMeta(
	accessor: DbAccessor,
	entityId: string,
	agentId: string,
): TaskMeta | null {
	return accessor.withReadDb((db) => {
		const row = db
			.prepare("SELECT * FROM task_meta WHERE entity_id = ? AND agent_id = ?")
			.get(entityId, agentId) as Record<string, unknown> | undefined;
		return row ? rowToTaskMeta(row) : null;
	});
}

export function updateTaskStatus(
	accessor: DbAccessor,
	entityId: string,
	agentId: string,
	status: TaskStatus,
): void {
	const ts = now();
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE task_meta
			 SET status = ?, completed_at = ?, updated_at = ?
			 WHERE entity_id = ? AND agent_id = ?`,
		).run(
			status,
			status === "done" || status === "cancelled" ? ts : null,
			ts,
			entityId,
			agentId,
		);
	});
}

// ---------------------------------------------------------------------------
// Structural density
// ---------------------------------------------------------------------------

export interface StructuralDensity {
	readonly aspectCount: number;
	readonly attributeCount: number;
	readonly constraintCount: number;
	readonly dependencyCount: number;
}

export function getStructuralDensity(
	accessor: DbAccessor,
	entityId: string,
	agentId: string,
): StructuralDensity {
	return accessor.withReadDb((db) => {
		const aspects = db
			.prepare(
				`SELECT COUNT(*) as n FROM entity_aspects
				 WHERE entity_id = ? AND agent_id = ?`,
			)
			.get(entityId, agentId) as { n: number };

		const attributes = db
			.prepare(
				`SELECT COUNT(*) as n FROM entity_attributes ea
				 JOIN entity_aspects asp ON asp.id = ea.aspect_id
				 WHERE asp.entity_id = ? AND asp.agent_id = ?
				   AND ea.agent_id = ?
				   AND ea.kind = 'attribute' AND ea.status = 'active'`,
			)
			.get(entityId, agentId, agentId) as { n: number };

		const constraints = db
			.prepare(
				`SELECT COUNT(*) as n FROM entity_attributes ea
				 JOIN entity_aspects asp ON asp.id = ea.aspect_id
				 WHERE asp.entity_id = ? AND asp.agent_id = ?
				   AND ea.agent_id = ?
				   AND ea.kind = 'constraint' AND ea.status = 'active'`,
			)
			.get(entityId, agentId, agentId) as { n: number };

		const dependencies = db
			.prepare(
				`SELECT COUNT(*) as n FROM entity_dependencies
				 WHERE (source_entity_id = ? OR target_entity_id = ?)
				   AND agent_id = ?`,
			)
			.get(entityId, entityId, agentId) as { n: number };

		return {
			aspectCount: aspects.n,
			attributeCount: attributes.n,
			constraintCount: constraints.n,
			dependencyCount: dependencies.n,
		};
	});
}
