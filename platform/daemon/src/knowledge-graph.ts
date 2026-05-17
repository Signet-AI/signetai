/**
 * Knowledge graph CRUD operations for KA-1.
 *
 * Provides read/write helpers for entity aspects, attributes,
 * dependencies, task metadata, and structural density queries.
 * All writes go through withWriteTx, all reads through withReadDb.
 *
 * Follows the DbAccessor pattern established in skill-graph.ts.
 */

import type {
	AttributeKind,
	AttributeStatus,
	DependencyType,
	Entity,
	EntityAspect,
	EntityAttribute,
	EntityDependency,
	TaskMeta,
	TaskStatus,
} from "@signet/core";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { requireDependencyReason } from "./dependency-history";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toCanonicalName(raw: string): string {
	return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function now(): string {
	return new Date().toISOString();
}

function parseJsonArray(value: unknown): readonly unknown[] {
	if (typeof value !== "string") return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function rowToEntity(r: Record<string, unknown>): Entity {
	return {
		id: r.id as string,
		name: r.name as string,
		canonicalName: typeof r.canonical_name === "string" ? r.canonical_name : undefined,
		entityType: r.entity_type as string,
		agentId: r.agent_id as string,
		description: typeof r.description === "string" ? r.description : undefined,
		mentions: typeof r.mentions === "number" ? r.mentions : undefined,
		pinned: r.pinned === 1,
		pinnedAt: typeof r.pinned_at === "string" ? r.pinned_at : null,
		status: r.status === "archived" ? "archived" : "active",
		archivedAt: typeof r.archived_at === "string" ? r.archived_at : null,
		archivedBy: typeof r.archived_by === "string" ? r.archived_by : null,
		archiveReason: typeof r.archive_reason === "string" ? r.archive_reason : null,
		proposalId: typeof r.proposal_id === "string" ? r.proposal_id : null,
		proposalEvidence: parseJsonArray(r.proposal_evidence),
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
	};
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
		status: r.status === "archived" ? "archived" : "active",
		archivedAt: typeof r.archived_at === "string" ? r.archived_at : null,
		archivedBy: typeof r.archived_by === "string" ? r.archived_by : null,
		archiveReason: typeof r.archive_reason === "string" ? r.archive_reason : null,
		proposalId: typeof r.proposal_id === "string" ? r.proposal_id : null,
		proposalEvidence: parseJsonArray(r.proposal_evidence),
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
	};
}

function rowToAttribute(r: Record<string, unknown>): EntityAttribute {
	const proposalEvidence = parseJsonArray(r.proposal_evidence);
	return {
		id: r.id as string,
		aspectId: r.aspect_id as string,
		agentId: r.agent_id as string,
		memoryId: (r.memory_id as string) ?? null,
		kind: r.kind as AttributeKind,
		content: r.content as string,
		normalizedContent: r.normalized_content as string,
		groupKey: (r.group_key as string) ?? null,
		claimKey: (r.claim_key as string) ?? null,
		confidence: r.confidence as number,
		importance: r.importance as number,
		status: r.status as AttributeStatus,
		supersededBy: (r.superseded_by as string) ?? null,
		version: typeof r.version === "number" ? r.version : 1,
		versionRootId: typeof r.version_root_id === "string" ? r.version_root_id : (r.id as string),
		previousAttributeId: typeof r.previous_attribute_id === "string" ? r.previous_attribute_id : null,
		archivedAt: typeof r.archived_at === "string" ? r.archived_at : null,
		archivedBy: typeof r.archived_by === "string" ? r.archived_by : null,
		archiveReason: typeof r.archive_reason === "string" ? r.archive_reason : null,
		sourceKind: (r.source_kind as string) ?? null,
		sourceId: (r.source_id as string) ?? null,
		sourcePath: (r.source_path as string) ?? null,
		sourceRoot: (r.source_root as string) ?? null,
		proposalId: (r.proposal_id as string) ?? null,
		proposalEvidence,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
	};
}

function rowToDependency(r: Record<string, unknown>): EntityDependency {
	const proposalEvidence = parseJsonArray(r.proposal_evidence);
	return {
		id: r.id as string,
		sourceEntityId: r.source_entity_id as string,
		targetEntityId: r.target_entity_id as string,
		agentId: r.agent_id as string,
		aspectId: (r.aspect_id as string) ?? null,
		dependencyType: r.dependency_type as DependencyType,
		strength: r.strength as number,
		confidence: typeof r.confidence === "number" ? r.confidence : 0.7,
		reason: typeof r.reason === "string" ? r.reason : null,
		status: r.status === "archived" ? "archived" : "active",
		archivedAt: typeof r.archived_at === "string" ? r.archived_at : null,
		archivedBy: typeof r.archived_by === "string" ? r.archived_by : null,
		archiveReason: typeof r.archive_reason === "string" ? r.archive_reason : null,
		sourceKind: (r.source_kind as string) ?? null,
		sourceId: (r.source_id as string) ?? null,
		sourcePath: (r.source_path as string) ?? null,
		sourceRoot: (r.source_root as string) ?? null,
		proposalId: (r.proposal_id as string) ?? null,
		proposalEvidence,
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

export function upsertAspect(accessor: DbAccessor, params: UpsertAspectParams): EntityAspect {
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
		).run(id, params.entityId, params.agentId, params.name, canonical, params.weight ?? 0.5, ts, ts);

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

export function getAspectsForEntity(accessor: DbAccessor, entityId: string, agentId: string): readonly EntityAspect[] {
	return accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT * FROM entity_aspects
				 WHERE entity_id = ? AND agent_id = ?
				   AND COALESCE(status, 'active') = 'active'
				 ORDER BY weight DESC`,
			)
			.all(entityId, agentId) as Array<Record<string, unknown>>;
		return rows.map(rowToAspect);
	});
}

export function deleteAspect(accessor: DbAccessor, aspectId: string, agentId: string): void {
	accessor.withWriteTx((db) => {
		db.prepare("DELETE FROM entity_aspects WHERE id = ? AND agent_id = ?").run(aspectId, agentId);
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

export function createAttribute(accessor: DbAccessor, params: CreateAttributeParams): EntityAttribute {
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
			groupKey: null,
			claimKey: null,
			confidence: params.confidence ?? 0.0,
			importance: params.importance ?? 0.5,
			status: "active" as const,
			supersededBy: null,
			sourceKind: null,
			sourceId: null,
			sourcePath: null,
			sourceRoot: null,
			proposalId: null,
			proposalEvidence: [],
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
				   AND COALESCE(asp.status, 'active') = 'active'
				   AND ea.kind = 'constraint'
				   AND ea.status = 'active'
				 ORDER BY ea.importance DESC`,
			)
			.all(entityId, agentId, agentId) as Array<Record<string, unknown>>;
		return rows.map(rowToAttribute);
	});
}

export function supersedeAttribute(accessor: DbAccessor, id: string, supersededById: string, agentId: string): void {
	const ts = now();
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE entity_attributes
			 SET status = 'superseded', superseded_by = ?, updated_at = ?
			 WHERE id = ? AND agent_id = ?`,
		).run(supersededById, ts, id, agentId);
	});
}

export function deleteAttribute(accessor: DbAccessor, id: string, agentId: string): void {
	const ts = now();
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE entity_attributes
			 SET status = 'deleted', updated_at = ?
			 WHERE id = ? AND agent_id = ?`,
		).run(ts, id, agentId);
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
	readonly confidence?: number;
	readonly reason?: string;
}

export function upsertDependency(accessor: DbAccessor, params: UpsertDependencyParams): EntityDependency {
	const ts = now();

	return accessor.withWriteTx((db) => {
		const existing = db
			.prepare(
				`SELECT * FROM entity_dependencies
				 WHERE source_entity_id = ? AND target_entity_id = ?
				   AND dependency_type = ? AND agent_id = ?`,
			)
			.get(params.sourceEntityId, params.targetEntityId, params.dependencyType, params.agentId) as
			| Record<string, unknown>
			| undefined;

		if (existing) {
			const changed =
				params.strength !== undefined ||
				params.aspectId !== undefined ||
				params.confidence !== undefined ||
				params.reason !== undefined;

			if (!changed) {
				return rowToDependency(existing);
			}

			const reason = requireDependencyReason(
				params.dependencyType,
				params.reason ?? (typeof existing.reason === "string" ? existing.reason : null),
			);
			const conf = params.confidence ?? (typeof existing.confidence === "number" ? existing.confidence : 0.7);
			db.prepare(
				`UPDATE entity_dependencies
				 SET strength = ?, aspect_id = ?, reason = ?, confidence = ?, updated_at = ?
				 WHERE id = ? AND agent_id = ?`,
			).run(
				params.strength ?? (existing.strength as number),
				params.aspectId ?? (existing.aspect_id as string | null),
				reason,
				conf,
				ts,
				existing.id as string,
				params.agentId,
			);
			return rowToDependency({
				...existing,
				strength: params.strength ?? (existing.strength as number),
				aspect_id: params.aspectId ?? (existing.aspect_id as string | null),
				reason,
				confidence: conf,
				updated_at: ts,
			});
		}

		const id = crypto.randomUUID();
		const reason = requireDependencyReason(params.dependencyType, params.reason);
		const conf = params.confidence ?? 0.7;
		db.prepare(
			`INSERT INTO entity_dependencies
			 (id, source_entity_id, target_entity_id, agent_id,
			  aspect_id, dependency_type, strength, confidence, reason, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			params.sourceEntityId,
			params.targetEntityId,
			params.agentId,
			params.aspectId ?? null,
			params.dependencyType,
			params.strength ?? 0.5,
			conf,
			reason,
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
			confidence: conf,
			reason,
			sourceKind: null,
			sourceId: null,
			sourcePath: null,
			sourceRoot: null,
			proposalId: null,
			proposalEvidence: [],
			createdAt: ts,
			updatedAt: ts,
		};
	});
}

export function getEntityDependencyById(
	accessor: DbAccessor,
	params: { readonly id: string; readonly agentId: string },
): EntityDependency | null {
	return accessor.withReadDb((db) => {
		const row = db
			.prepare("SELECT * FROM entity_dependencies WHERE id = ? AND agent_id = ?")
			.get(params.id, params.agentId) as Record<string, unknown> | undefined;
		return row === undefined ? null : rowToDependency(row);
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
				`SELECT dep.*
				 FROM entity_dependencies dep
				 JOIN entities src ON src.id = dep.source_entity_id AND src.agent_id = dep.agent_id
				 JOIN entities dst ON dst.id = dep.target_entity_id AND dst.agent_id = dep.agent_id
				 WHERE dep.source_entity_id = ? AND dep.agent_id = ?
				   AND COALESCE(dep.status, 'active') = 'active'
				   AND COALESCE(src.status, 'active') = 'active'
				   AND COALESCE(dst.status, 'active') = 'active'`,
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
				`SELECT dep.*
				 FROM entity_dependencies dep
				 JOIN entities src ON src.id = dep.source_entity_id AND src.agent_id = dep.agent_id
				 JOIN entities dst ON dst.id = dep.target_entity_id AND dst.agent_id = dep.agent_id
				 WHERE dep.target_entity_id = ? AND dep.agent_id = ?
				   AND COALESCE(dep.status, 'active') = 'active'
				   AND COALESCE(src.status, 'active') = 'active'
				   AND COALESCE(dst.status, 'active') = 'active'`,
			)
			.all(entityId, agentId) as Array<Record<string, unknown>>;
		return rows.map(rowToDependency);
	});
}

export function deleteDependency(accessor: DbAccessor, id: string, agentId: string): void {
	// History is written by the trg_entity_dependencies_audit_delete AFTER DELETE
	// trigger (migration 050), which covers app deletes, FK cascades, and direct SQL.
	// No app-layer history write here to avoid duplicate audit rows.
	accessor.withWriteTx((db) => {
		db.prepare("DELETE FROM entity_dependencies WHERE id = ? AND agent_id = ?").run(id, agentId);
	});
}

// ---------------------------------------------------------------------------
// Entity pinning
// ---------------------------------------------------------------------------

export function pinEntity(accessor: DbAccessor, entityId: string, agentId: string): void {
	const ts = now();
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE entities
			 SET pinned = 1, pinned_at = ?, updated_at = ?
			 WHERE id = ? AND agent_id = ?`,
		).run(ts, ts, entityId, agentId);
	});
}

export function unpinEntity(accessor: DbAccessor, entityId: string, agentId: string): void {
	const ts = now();
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE entities
			 SET pinned = 0, pinned_at = NULL, updated_at = ?
			 WHERE id = ? AND agent_id = ?`,
		).run(ts, entityId, agentId);
	});
}

export function getPinnedEntities(accessor: DbAccessor, agentId: string): ReadonlyArray<PinnedEntitySummary> {
	return accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT id, name, pinned_at
				 FROM entities
				 WHERE agent_id = ?
				   AND pinned = 1
				   AND COALESCE(status, 'active') = 'active'
				 ORDER BY pinned_at DESC, updated_at DESC, name ASC`,
			)
			.all(agentId) as Array<Record<string, unknown>>;
		return rows.flatMap((row) => {
			if (typeof row.id !== "string" || typeof row.name !== "string") {
				return [];
			}
			return [
				{
					id: row.id,
					name: row.name,
					pinnedAt: typeof row.pinned_at === "string" ? row.pinned_at : "",
				},
			];
		});
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

export function upsertTaskMeta(accessor: DbAccessor, params: UpsertTaskMetaParams): TaskMeta {
	const ts = now();

	const completedAt = params.status === "done" || params.status === "cancelled" ? ts : null;

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

export function getTaskMeta(accessor: DbAccessor, entityId: string, agentId: string): TaskMeta | null {
	return accessor.withReadDb((db) => {
		const row = db.prepare("SELECT * FROM task_meta WHERE entity_id = ? AND agent_id = ?").get(entityId, agentId) as
			| Record<string, unknown>
			| undefined;
		return row ? rowToTaskMeta(row) : null;
	});
}

export function updateTaskStatus(accessor: DbAccessor, entityId: string, agentId: string, status: TaskStatus): void {
	const ts = now();
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE task_meta
			 SET status = ?, completed_at = ?, updated_at = ?
			 WHERE entity_id = ? AND agent_id = ?`,
		).run(status, status === "done" || status === "cancelled" ? ts : null, ts, entityId, agentId);
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

export interface KnowledgeEntityListItem {
	readonly entity: Entity;
	readonly aspectCount: number;
	readonly attributeCount: number;
	readonly constraintCount: number;
	readonly dependencyCount: number;
}

export interface KnowledgeEntityDetail {
	readonly entity: Entity;
	readonly aspectCount: number;
	readonly attributeCount: number;
	readonly constraintCount: number;
	readonly dependencyCount: number;
	readonly structuralDensity: StructuralDensity;
	readonly incomingDependencyCount: number;
	readonly outgoingDependencyCount: number;
}

export interface AspectWithCounts {
	readonly aspect: EntityAspect;
	readonly attributeCount: number;
	readonly constraintCount: number;
}

export interface KnowledgeDependencyEdge {
	readonly id: string;
	readonly direction: "incoming" | "outgoing";
	readonly dependencyType: string;
	readonly strength: number;
	readonly aspectId: string | null;
	readonly reason: string | null;
	readonly sourceEntityId: string;
	readonly sourceEntityName: string;
	readonly targetEntityId: string;
	readonly targetEntityName: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface KnowledgeStats {
	readonly entityCount: number;
	readonly aspectCount: number;
	readonly attributeCount: number;
	readonly constraintCount: number;
	readonly dependencyCount: number;
	readonly unassignedMemoryCount: number;
	readonly coveragePercent: number;
	readonly feedbackUpdatedAspectCount: number;
	readonly averageAspectWeight: number;
	readonly maxWeightAspectCount: number;
	readonly minWeightAspectCount: number;
}

export interface PinnedEntitySummary {
	readonly id: string;
	readonly name: string;
	readonly pinnedAt: string;
}

export interface EntityHealth {
	readonly entityId: string;
	readonly entityName: string;
	readonly comparisonCount: number;
	readonly winRate: number;
	readonly avgMargin: number;
	readonly trend: "improving" | "stable" | "declining";
}

export interface ResolvedNamedEntity {
	readonly id: string;
	readonly name: string;
	readonly canonicalName: string;
	readonly entityType: string;
	readonly description: string | null;
}

export interface EntityGroupSummary {
	readonly groupKey: string;
	readonly attributeCount: number;
	readonly constraintCount: number;
	readonly claimCount: number;
	readonly latestUpdatedAt: string | null;
}

export interface EntityClaimSummary {
	readonly claimKey: string;
	readonly groupKey: string | null;
	readonly attributeCount: number;
	readonly constraintCount: number;
	readonly activeCount: number;
	readonly supersededCount: number;
	readonly latestUpdatedAt: string | null;
	readonly preview: string | null;
}

export interface EntityTreeClaim {
	readonly claimKey: string;
	readonly attributeCount: number;
	readonly constraintCount: number;
	readonly activeCount: number;
	readonly supersededCount: number;
	readonly latestUpdatedAt: string | null;
	readonly preview: string | null;
}

export interface EntityTreeGroup {
	readonly groupKey: string;
	readonly attributeCount: number;
	readonly constraintCount: number;
	readonly claimCount: number;
	readonly latestUpdatedAt: string | null;
	readonly claims: readonly EntityTreeClaim[];
}

export interface EntityTreeAspect {
	readonly aspect: EntityAspect;
	readonly attributeCount: number;
	readonly constraintCount: number;
	readonly groupCount: number;
	readonly claimCount: number;
	readonly groups: readonly EntityTreeGroup[];
}

export interface EntityKnowledgeTree {
	readonly entity: Entity;
	readonly items: readonly EntityTreeAspect[];
	readonly limits: {
		readonly maxAspects: number;
		readonly maxGroups: number;
		readonly maxClaims: number;
		readonly depth: number;
	};
}

export function resolveNamedEntity(
	accessor: DbAccessor,
	input: {
		readonly agentId: string;
		readonly name: string;
	},
): ResolvedNamedEntity | null {
	const canonical = toCanonicalName(input.name);
	if (canonical.length === 0) return null;

	return accessor.withReadDb((db) => {
		const escaped = canonical.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
		const starts = `${escaped}%`;
		const contains = `%${escaped}%`;
		const rows = db
			.prepare(
				`SELECT
					id,
					name,
					COALESCE(canonical_name, LOWER(name)) AS canonical_name,
					entity_type,
					description,
					mentions,
					updated_at,
					CASE
						WHEN COALESCE(canonical_name, LOWER(name)) = ? THEN 0
						WHEN LOWER(name) = ? THEN 1
						WHEN COALESCE(canonical_name, LOWER(name)) LIKE ? ESCAPE '\\' THEN 2
						WHEN LOWER(name) LIKE ? ESCAPE '\\' THEN 3
						WHEN COALESCE(canonical_name, LOWER(name)) LIKE ? ESCAPE '\\' THEN 4
						WHEN LOWER(name) LIKE ? ESCAPE '\\' THEN 5
						ELSE 6
					END AS match_rank
				 FROM entities
				 WHERE agent_id = ?
				   AND COALESCE(status, 'active') = 'active'
				   AND (
						COALESCE(canonical_name, LOWER(name)) = ?
						OR LOWER(name) = ?
						OR COALESCE(canonical_name, LOWER(name)) LIKE ? ESCAPE '\\'
						OR LOWER(name) LIKE ? ESCAPE '\\'
						OR COALESCE(canonical_name, LOWER(name)) LIKE ? ESCAPE '\\'
						OR LOWER(name) LIKE ? ESCAPE '\\'
				   )
				 ORDER BY match_rank ASC, mentions DESC, updated_at DESC, name ASC
				 LIMIT 1`,
			)
			.get(
				canonical,
				canonical,
				starts,
				starts,
				contains,
				contains,
				input.agentId,
				canonical,
				canonical,
				starts,
				starts,
				contains,
				contains,
			) as
			| {
					id: string;
					name: string;
					canonical_name: string;
					entity_type: string;
					description: string | null;
			  }
			| undefined;

		if (!rows) return null;
		return {
			id: rows.id,
			name: rows.name,
			canonicalName: rows.canonical_name,
			entityType: rows.entity_type,
			description: rows.description,
		};
	});
}

function resolveAspectByName(
	db: ReadDb,
	params: {
		readonly entityId: string;
		readonly agentId: string;
		readonly aspect: string;
	},
): EntityAspect | null {
	const canonical = toCanonicalName(params.aspect);
	if (canonical.length === 0) return null;
	const row = db
		.prepare(
			`SELECT *
			 FROM entity_aspects
			 WHERE entity_id = ?
			   AND agent_id = ?
			   AND COALESCE(status, 'active') = 'active'
			   AND (canonical_name = ? OR LOWER(name) = ?)
			 ORDER BY weight DESC, updated_at DESC
			 LIMIT 1`,
		)
		.get(params.entityId, params.agentId, canonical, canonical) as Record<string, unknown> | undefined;
	return row ? rowToAspect(row) : null;
}

function resolveEntityRecordByName(
	db: ReadDb,
	params: {
		readonly agentId: string;
		readonly name: string;
	},
): Entity | null {
	const canonical = toCanonicalName(params.name);
	if (canonical.length === 0) return null;
	const escaped = canonical.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
	const starts = `${escaped}%`;
	const contains = `%${escaped}%`;
	const row = db
		.prepare(
			`SELECT *
			 FROM entities
			 WHERE agent_id = ?
			   AND COALESCE(status, 'active') = 'active'
			   AND (
					COALESCE(canonical_name, LOWER(name)) = ?
					OR LOWER(name) = ?
					OR COALESCE(canonical_name, LOWER(name)) LIKE ? ESCAPE '\\'
					OR LOWER(name) LIKE ? ESCAPE '\\'
					OR COALESCE(canonical_name, LOWER(name)) LIKE ? ESCAPE '\\'
					OR LOWER(name) LIKE ? ESCAPE '\\'
			   )
			 ORDER BY
			   CASE
				 WHEN COALESCE(canonical_name, LOWER(name)) = ? THEN 0
				 WHEN LOWER(name) = ? THEN 1
				 WHEN COALESCE(canonical_name, LOWER(name)) LIKE ? ESCAPE '\\' THEN 2
				 WHEN LOWER(name) LIKE ? ESCAPE '\\' THEN 3
				 WHEN COALESCE(canonical_name, LOWER(name)) LIKE ? ESCAPE '\\' THEN 4
				 WHEN LOWER(name) LIKE ? ESCAPE '\\' THEN 5
				 ELSE 6
			   END ASC,
			   mentions DESC,
			   updated_at DESC,
			   name ASC
			 LIMIT 1`,
		)
		.get(
			params.agentId,
			canonical,
			canonical,
			starts,
			starts,
			contains,
			contains,
			canonical,
			canonical,
			starts,
			starts,
			contains,
			contains,
		) as Record<string, unknown> | undefined;
	return row ? rowToEntity(row) : null;
}

export function getKnowledgeEntityByName(
	accessor: DbAccessor,
	params: {
		readonly agentId: string;
		readonly name: string;
	},
): KnowledgeEntityDetail | null {
	const resolved = resolveNamedEntity(accessor, params);
	return resolved ? getKnowledgeEntityDetail(accessor, resolved.id, params.agentId) : null;
}

export function getEntityAspectsByName(
	accessor: DbAccessor,
	params: {
		readonly agentId: string;
		readonly entity: string;
	},
): { readonly entity: Entity; readonly items: readonly AspectWithCounts[] } | null {
	return accessor.withReadDb((db) => {
		const entity = resolveEntityRecordByName(db, {
			agentId: params.agentId,
			name: params.entity,
		});
		if (!entity) return null;
		return {
			entity,
			items: getEntityAspectsWithCounts(accessor, entity.id, params.agentId),
		};
	});
}

export function getEntityKnowledgeTree(
	accessor: DbAccessor,
	params: {
		readonly agentId: string;
		readonly entity: string;
		readonly maxAspects: number;
		readonly maxGroups: number;
		readonly maxClaims: number;
		readonly depth: number;
	},
): EntityKnowledgeTree | null {
	return accessor.withReadDb((db) => {
		const entity = resolveEntityRecordByName(db, {
			agentId: params.agentId,
			name: params.entity,
		});
		if (!entity) return null;

		const aspectRows = db
			.prepare(
				`SELECT
				   asp.*,
				   COUNT(DISTINCT CASE
				     WHEN attr.kind = 'attribute' AND attr.status = 'active' THEN attr.id
				   END) AS attribute_count,
				   COUNT(DISTINCT CASE
				     WHEN attr.kind = 'constraint' AND attr.status = 'active' THEN attr.id
				   END) AS constraint_count,
				   COUNT(DISTINCT CASE
				     WHEN attr.status != 'deleted' THEN COALESCE(attr.group_key, 'general')
				   END) AS group_count,
				   COUNT(DISTINCT CASE
				     WHEN attr.status != 'deleted' AND attr.claim_key IS NOT NULL
				     THEN COALESCE(attr.group_key, 'general') || ':' || attr.claim_key
				   END) AS claim_count
				 FROM entity_aspects asp
				 LEFT JOIN entity_attributes attr
				   ON attr.aspect_id = asp.id AND attr.agent_id = asp.agent_id
				 WHERE asp.entity_id = ? AND asp.agent_id = ?
				   AND COALESCE(asp.status, 'active') = 'active'
				 GROUP BY asp.id
				 ORDER BY asp.weight DESC, asp.name ASC
				 LIMIT ?`,
			)
			.all(entity.id, params.agentId, params.maxAspects) as Array<Record<string, unknown>>;

		return {
			entity,
			limits: {
				maxAspects: params.maxAspects,
				maxGroups: params.maxGroups,
				maxClaims: params.maxClaims,
				depth: params.depth,
			},
			items: aspectRows.map((aspectRow) => {
				const aspect = rowToAspect(aspectRow);
				const groupRows =
					params.depth >= 2
						? (db
								.prepare(
									`SELECT
									   COALESCE(ea.group_key, 'general') AS group_key,
									   COUNT(DISTINCT CASE
									     WHEN ea.kind = 'attribute' AND ea.status = 'active' THEN ea.id
									   END) AS attribute_count,
									   COUNT(DISTINCT CASE
									     WHEN ea.kind = 'constraint' AND ea.status = 'active' THEN ea.id
									   END) AS constraint_count,
									   COUNT(DISTINCT CASE
									     WHEN ea.claim_key IS NOT NULL THEN ea.claim_key
									   END) AS claim_count,
									   MAX(ea.updated_at) AS latest_updated_at
									 FROM entity_attributes ea
									 WHERE ea.aspect_id = ?
									   AND ea.agent_id = ?
									   AND ea.status != 'deleted'
									 GROUP BY COALESCE(ea.group_key, 'general')
									 ORDER BY attribute_count DESC, constraint_count DESC, claim_count DESC, group_key ASC
									 LIMIT ?`,
								)
								.all(aspect.id, params.agentId, params.maxGroups) as Array<Record<string, unknown>>)
						: [];

				return {
					aspect,
					attributeCount: Number(aspectRow.attribute_count ?? 0),
					constraintCount: Number(aspectRow.constraint_count ?? 0),
					groupCount: Number(aspectRow.group_count ?? 0),
					claimCount: Number(aspectRow.claim_count ?? 0),
					groups: groupRows.map((groupRow) => {
						const groupKey = groupRow.group_key as string;
						const claimRows =
							params.depth >= 3
								? (db
										.prepare(
											`SELECT
											   ea.claim_key,
											   COUNT(DISTINCT CASE WHEN ea.kind = 'attribute' THEN ea.id END) AS attribute_count,
											   COUNT(DISTINCT CASE WHEN ea.kind = 'constraint' THEN ea.id END) AS constraint_count,
											   COUNT(DISTINCT CASE WHEN ea.status = 'active' THEN ea.id END) AS active_count,
											   COUNT(DISTINCT CASE WHEN ea.status = 'superseded' THEN ea.id END) AS superseded_count,
											   MAX(ea.updated_at) AS latest_updated_at,
											   (
											     SELECT inner_attr.content
											     FROM entity_attributes inner_attr
											     WHERE inner_attr.aspect_id = ea.aspect_id
											       AND inner_attr.agent_id = ea.agent_id
											       AND COALESCE(inner_attr.group_key, 'general') = COALESCE(ea.group_key, 'general')
											       AND inner_attr.claim_key = ea.claim_key
											       AND inner_attr.status = 'active'
											     ORDER BY inner_attr.importance DESC, inner_attr.updated_at DESC
											     LIMIT 1
											   ) AS preview
											 FROM entity_attributes ea
											 WHERE ea.aspect_id = ?
											   AND ea.agent_id = ?
											   AND COALESCE(ea.group_key, 'general') = ?
											   AND ea.claim_key IS NOT NULL
											   AND ea.status != 'deleted'
											 GROUP BY ea.claim_key, COALESCE(ea.group_key, 'general')
											 ORDER BY active_count DESC, latest_updated_at DESC, ea.claim_key ASC
											 LIMIT ?`,
										)
										.all(aspect.id, params.agentId, groupKey, params.maxClaims) as Array<Record<string, unknown>>)
								: [];

						return {
							groupKey,
							attributeCount: Number(groupRow.attribute_count ?? 0),
							constraintCount: Number(groupRow.constraint_count ?? 0),
							claimCount: Number(groupRow.claim_count ?? 0),
							latestUpdatedAt: typeof groupRow.latest_updated_at === "string" ? groupRow.latest_updated_at : null,
							claims: claimRows.map((claimRow) => ({
								claimKey: claimRow.claim_key as string,
								attributeCount: Number(claimRow.attribute_count ?? 0),
								constraintCount: Number(claimRow.constraint_count ?? 0),
								activeCount: Number(claimRow.active_count ?? 0),
								supersededCount: Number(claimRow.superseded_count ?? 0),
								latestUpdatedAt: typeof claimRow.latest_updated_at === "string" ? claimRow.latest_updated_at : null,
								preview: typeof claimRow.preview === "string" ? claimRow.preview : null,
							})),
						};
					}),
				};
			}),
		};
	});
}

export function listEntityGroups(
	accessor: DbAccessor,
	params: {
		readonly agentId: string;
		readonly entity: string;
		readonly aspect: string;
	},
): { readonly entity: Entity; readonly aspect: EntityAspect; readonly items: readonly EntityGroupSummary[] } | null {
	return accessor.withReadDb((db) => {
		const entity = resolveEntityRecordByName(db, {
			agentId: params.agentId,
			name: params.entity,
		});
		if (!entity) return null;
		const aspect = resolveAspectByName(db, {
			entityId: entity.id,
			agentId: params.agentId,
			aspect: params.aspect,
		});
		if (!aspect) return null;
		const rows = db
			.prepare(
				`SELECT
				   COALESCE(ea.group_key, 'general') AS group_key,
				   COUNT(DISTINCT CASE
				     WHEN ea.kind = 'attribute' AND ea.status = 'active' THEN ea.id
				   END) AS attribute_count,
				   COUNT(DISTINCT CASE
				     WHEN ea.kind = 'constraint' AND ea.status = 'active' THEN ea.id
				   END) AS constraint_count,
				   COUNT(DISTINCT CASE
				     WHEN ea.claim_key IS NOT NULL THEN ea.claim_key
				   END) AS claim_count,
				   MAX(ea.updated_at) AS latest_updated_at
				 FROM entity_attributes ea
				 WHERE ea.aspect_id = ?
				   AND ea.agent_id = ?
				   AND ea.status != 'deleted'
				 GROUP BY COALESCE(ea.group_key, 'general')
				 ORDER BY attribute_count DESC, constraint_count DESC, group_key ASC`,
			)
			.all(aspect.id, params.agentId) as Array<Record<string, unknown>>;
		return {
			entity,
			aspect,
			items: rows.map((row) => ({
				groupKey: row.group_key as string,
				attributeCount: Number(row.attribute_count ?? 0),
				constraintCount: Number(row.constraint_count ?? 0),
				claimCount: Number(row.claim_count ?? 0),
				latestUpdatedAt: typeof row.latest_updated_at === "string" ? row.latest_updated_at : null,
			})),
		};
	});
}

export function listEntityClaims(
	accessor: DbAccessor,
	params: {
		readonly agentId: string;
		readonly entity: string;
		readonly aspect: string;
		readonly group: string;
	},
): { readonly entity: Entity; readonly aspect: EntityAspect; readonly items: readonly EntityClaimSummary[] } | null {
	return accessor.withReadDb((db) => {
		const entity = resolveEntityRecordByName(db, {
			agentId: params.agentId,
			name: params.entity,
		});
		if (!entity) return null;
		const aspect = resolveAspectByName(db, {
			entityId: entity.id,
			agentId: params.agentId,
			aspect: params.aspect,
		});
		if (!aspect) return null;
		const group = toCanonicalName(params.group).replace(/\s+/g, "_");
		const rows = db
			.prepare(
				`SELECT
				   ea.claim_key,
				   ea.group_key,
				   COUNT(DISTINCT CASE WHEN ea.kind = 'attribute' THEN ea.id END) AS attribute_count,
				   COUNT(DISTINCT CASE WHEN ea.kind = 'constraint' THEN ea.id END) AS constraint_count,
				   COUNT(DISTINCT CASE WHEN ea.status = 'active' THEN ea.id END) AS active_count,
				   COUNT(DISTINCT CASE WHEN ea.status = 'superseded' THEN ea.id END) AS superseded_count,
				   MAX(ea.updated_at) AS latest_updated_at,
				   (
				     SELECT inner_attr.content
				     FROM entity_attributes inner_attr
				     WHERE inner_attr.aspect_id = ea.aspect_id
				       AND inner_attr.agent_id = ea.agent_id
				       AND COALESCE(inner_attr.group_key, 'general') = COALESCE(ea.group_key, 'general')
				       AND inner_attr.claim_key = ea.claim_key
				       AND inner_attr.status = 'active'
				     ORDER BY inner_attr.importance DESC, inner_attr.updated_at DESC
				     LIMIT 1
				   ) AS preview
				 FROM entity_attributes ea
				 WHERE ea.aspect_id = ?
				   AND ea.agent_id = ?
				   AND COALESCE(ea.group_key, 'general') = ?
				   AND ea.claim_key IS NOT NULL
				   AND ea.status != 'deleted'
				 GROUP BY ea.claim_key, COALESCE(ea.group_key, 'general')
				 ORDER BY active_count DESC, latest_updated_at DESC, ea.claim_key ASC`,
			)
			.all(aspect.id, params.agentId, group.length > 0 ? group : "general") as Array<Record<string, unknown>>;
		return {
			entity,
			aspect,
			items: rows.map((row) => ({
				claimKey: row.claim_key as string,
				groupKey: typeof row.group_key === "string" ? row.group_key : null,
				attributeCount: Number(row.attribute_count ?? 0),
				constraintCount: Number(row.constraint_count ?? 0),
				activeCount: Number(row.active_count ?? 0),
				supersededCount: Number(row.superseded_count ?? 0),
				latestUpdatedAt: typeof row.latest_updated_at === "string" ? row.latest_updated_at : null,
				preview: typeof row.preview === "string" ? row.preview : null,
			})),
		};
	});
}

export function listEntityAttributesByPath(
	accessor: DbAccessor,
	params: {
		readonly agentId: string;
		readonly entity: string;
		readonly aspect: string;
		readonly group: string;
		readonly claim: string;
		readonly kind?: AttributeKind;
		readonly status?: AttributeStatus | "all";
		readonly limit: number;
		readonly offset: number;
	},
): { readonly entity: Entity; readonly aspect: EntityAspect; readonly items: readonly EntityAttribute[] } | null {
	return accessor.withReadDb((db) => {
		const entity = resolveEntityRecordByName(db, {
			agentId: params.agentId,
			name: params.entity,
		});
		if (!entity) return null;
		const aspect = resolveAspectByName(db, {
			entityId: entity.id,
			agentId: params.agentId,
			aspect: params.aspect,
		});
		if (!aspect) return null;
		const group = toCanonicalName(params.group).replace(/\s+/g, "_");
		const claim = toCanonicalName(params.claim).replace(/\s+/g, "_");
		if (claim.length === 0) return { entity, aspect, items: [] };

		const conditions = [
			"ea.aspect_id = ?",
			"ea.agent_id = ?",
			"COALESCE(ea.group_key, 'general') = ?",
			"ea.claim_key = ?",
		];
		const args: Array<string | number> = [aspect.id, params.agentId, group.length > 0 ? group : "general", claim];
		if (params.kind) {
			conditions.push("ea.kind = ?");
			args.push(params.kind);
		}
		if (params.status && params.status !== "all") {
			conditions.push("ea.status = ?");
			args.push(params.status);
		} else if (!params.status) {
			conditions.push("ea.status = 'active'");
		}

		const rows = db
			.prepare(
				`SELECT ea.*
				 FROM entity_attributes ea
				 WHERE ${conditions.join(" AND ")}
				 ORDER BY ea.created_at DESC, ea.importance DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(...args, params.limit, params.offset) as Array<Record<string, unknown>>;
		return {
			entity,
			aspect,
			items: rows.map(rowToAttribute),
		};
	});
}

export function listKnowledgeEntities(
	accessor: DbAccessor,
	params: {
		readonly agentId: string;
		readonly type?: string;
		readonly query?: string;
		readonly limit: number;
		readonly offset: number;
	},
): readonly KnowledgeEntityListItem[] {
	return accessor.withReadDb((db) => {
		const conditions = ["e.agent_id = ?"];
		const args: Array<string | number> = [params.agentId];
		conditions.push("COALESCE(e.status, 'active') = 'active'");
		if (params.type) {
			conditions.push("e.entity_type = ?");
			args.push(params.type);
		}
		if (params.query) {
			conditions.push("e.canonical_name LIKE ?");
			args.push(`%${params.query.trim().toLowerCase()}%`);
		}

		// Paginate entity IDs first, then compute counts only for the page.
		// This avoids materializing GROUP BY + ORDER BY across every entity in
		// the agent scope before LIMIT can apply, which is prohibitive on graphs
		// with tens of thousands of entities. See Signet-AI/signetai#515.
		const rows = db
			.prepare(
				`WITH page AS (
					SELECT e.id
					FROM entities e
					WHERE ${conditions.join(" AND ")}
					ORDER BY e.pinned DESC, e.pinned_at DESC, e.mentions DESC, e.updated_at DESC, e.name ASC
					LIMIT ? OFFSET ?
				)
				SELECT
					e.*,
					(
						SELECT COUNT(*) FROM entity_aspects asp
						WHERE asp.entity_id = e.id AND asp.agent_id = e.agent_id
						  AND COALESCE(asp.status, 'active') = 'active'
					) AS aspect_count,
					(
						SELECT COUNT(*) FROM entity_attributes attr
						JOIN entity_aspects asp ON asp.id = attr.aspect_id
						WHERE asp.entity_id = e.id
						  AND asp.agent_id = e.agent_id
						  AND COALESCE(asp.status, 'active') = 'active'
						  AND attr.agent_id = e.agent_id
						  AND attr.kind = 'attribute'
						  AND attr.status = 'active'
					) AS attribute_count,
					(
						SELECT COUNT(*) FROM entity_attributes attr
						JOIN entity_aspects asp ON asp.id = attr.aspect_id
						WHERE asp.entity_id = e.id
						  AND asp.agent_id = e.agent_id
						  AND COALESCE(asp.status, 'active') = 'active'
						  AND attr.agent_id = e.agent_id
						  AND attr.kind = 'constraint'
						  AND attr.status = 'active'
					) AS constraint_count,
					(
						SELECT COUNT(*) FROM entity_dependencies dep
						JOIN entities src ON src.id = dep.source_entity_id AND src.agent_id = dep.agent_id
						JOIN entities dst ON dst.id = dep.target_entity_id AND dst.agent_id = dep.agent_id
						WHERE dep.agent_id = e.agent_id
						  AND COALESCE(dep.status, 'active') = 'active'
						  AND COALESCE(src.status, 'active') = 'active'
						  AND COALESCE(dst.status, 'active') = 'active'
						  AND (dep.source_entity_id = e.id OR dep.target_entity_id = e.id)
					) AS dependency_count
				 FROM page p
				 JOIN entities e ON e.id = p.id
				 ORDER BY e.pinned DESC, e.pinned_at DESC, e.mentions DESC, e.updated_at DESC, e.name ASC`,
			)
			.all(...args, params.limit, params.offset) as Array<Record<string, unknown>>;

		return rows.map((row) => ({
			entity: rowToEntity(row),
			aspectCount: Number(row.aspect_count ?? 0),
			attributeCount: Number(row.attribute_count ?? 0),
			constraintCount: Number(row.constraint_count ?? 0),
			dependencyCount: Number(row.dependency_count ?? 0),
		}));
	});
}

export function getKnowledgeEntityDetail(
	accessor: DbAccessor,
	entityId: string,
	agentId: string,
): KnowledgeEntityDetail | null {
	return accessor.withReadDb((db) => {
		// Scalar subqueries per count avoid GROUP BY materialization across
		// the (LEFT JOIN aspects x attributes x dependencies) cartesian, which
		// produces the same pathological shape as listKnowledgeEntities even
		// when filtered to a single entity id. See Signet-AI/signetai#515.
		const row = db
			.prepare(
				`SELECT
					e.*,
					(
						SELECT COUNT(*) FROM entity_aspects asp
						  WHERE asp.entity_id = e.id AND asp.agent_id = e.agent_id
						    AND COALESCE(asp.status, 'active') = 'active'
					) AS aspect_count,
					(
						SELECT COUNT(*) FROM entity_attributes attr
						JOIN entity_aspects asp ON asp.id = attr.aspect_id
						  WHERE asp.entity_id = e.id
						  AND asp.agent_id = e.agent_id
						  AND COALESCE(asp.status, 'active') = 'active'
						  AND attr.agent_id = e.agent_id
						  AND attr.kind = 'attribute'
						  AND attr.status = 'active'
					) AS attribute_count,
					(
						SELECT COUNT(*) FROM entity_attributes attr
						JOIN entity_aspects asp ON asp.id = attr.aspect_id
						  WHERE asp.entity_id = e.id
						  AND asp.agent_id = e.agent_id
						  AND COALESCE(asp.status, 'active') = 'active'
						  AND attr.agent_id = e.agent_id
						  AND attr.kind = 'constraint'
						  AND attr.status = 'active'
					) AS constraint_count,
					(
						SELECT COUNT(*) FROM entity_dependencies dep
						JOIN entities dst ON dst.id = dep.target_entity_id AND dst.agent_id = dep.agent_id
						WHERE dep.agent_id = e.agent_id
						  AND COALESCE(dep.status, 'active') = 'active'
						  AND COALESCE(dst.status, 'active') = 'active'
						  AND dep.source_entity_id = e.id
					) AS outgoing_dependency_count,
					(
						SELECT COUNT(*) FROM entity_dependencies dep
						JOIN entities src ON src.id = dep.source_entity_id AND src.agent_id = dep.agent_id
						WHERE dep.agent_id = e.agent_id
						  AND COALESCE(dep.status, 'active') = 'active'
						  AND COALESCE(src.status, 'active') = 'active'
						  AND dep.target_entity_id = e.id
					) AS incoming_dependency_count
				 FROM entities e
				 WHERE e.id = ? AND e.agent_id = ?
				   AND COALESCE(e.status, 'active') = 'active'`,
			)
			.get(entityId, agentId) as Record<string, unknown> | undefined;

		if (!row) return null;
		const structuralDensity = getStructuralDensity(accessor, entityId, agentId);
		const incomingDependencyCount = Number(row.incoming_dependency_count ?? 0);
		const outgoingDependencyCount = Number(row.outgoing_dependency_count ?? 0);

		return {
			entity: rowToEntity(row),
			aspectCount: Number(row.aspect_count ?? 0),
			attributeCount: Number(row.attribute_count ?? 0),
			constraintCount: Number(row.constraint_count ?? 0),
			dependencyCount: incomingDependencyCount + outgoingDependencyCount,
			structuralDensity,
			incomingDependencyCount,
			outgoingDependencyCount,
		};
	});
}

export function getEntityAspectsWithCounts(
	accessor: DbAccessor,
	entityId: string,
	agentId: string,
): readonly AspectWithCounts[] {
	return accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT
					asp.*,
					COUNT(DISTINCT CASE
						WHEN attr.kind = 'attribute' AND attr.status = 'active' THEN attr.id
					END) AS attribute_count,
					COUNT(DISTINCT CASE
						WHEN attr.kind = 'constraint' AND attr.status = 'active' THEN attr.id
					END) AS constraint_count
				 FROM entity_aspects asp
				 LEFT JOIN entity_attributes attr
				   ON attr.aspect_id = asp.id AND attr.agent_id = asp.agent_id
				 WHERE asp.entity_id = ? AND asp.agent_id = ?
				   AND COALESCE(asp.status, 'active') = 'active'
				 GROUP BY asp.id
				 ORDER BY asp.weight DESC, asp.name ASC`,
			)
			.all(entityId, agentId) as Array<Record<string, unknown>>;

		return rows.map((row) => ({
			aspect: rowToAspect(row),
			attributeCount: Number(row.attribute_count ?? 0),
			constraintCount: Number(row.constraint_count ?? 0),
		}));
	});
}

export function getAttributesForAspectFiltered(
	accessor: DbAccessor,
	params: {
		readonly entityId: string;
		readonly aspectId: string;
		readonly agentId: string;
		readonly kind?: AttributeKind;
		readonly status?: AttributeStatus;
		readonly limit: number;
		readonly offset: number;
	},
): readonly EntityAttribute[] {
	return accessor.withReadDb((db) => {
		const conditions = [
			"asp.entity_id = ?",
			"asp.id = ?",
			"asp.agent_id = ?",
			"ea.agent_id = ?",
			"COALESCE(e.status, 'active') = 'active'",
			"COALESCE(asp.status, 'active') = 'active'",
		];
		const args: Array<string | number> = [params.entityId, params.aspectId, params.agentId, params.agentId];
		if (params.kind) {
			conditions.push("ea.kind = ?");
			args.push(params.kind);
		}
		if (params.status) {
			conditions.push("ea.status = ?");
			args.push(params.status);
		}

		const rows = db
			.prepare(
				`SELECT ea.*
				 FROM entity_attributes ea
				 JOIN entity_aspects asp ON asp.id = ea.aspect_id
				 JOIN entities e ON e.id = asp.entity_id AND e.agent_id = asp.agent_id
				 WHERE ${conditions.join(" AND ")}
				 ORDER BY ea.importance DESC, ea.created_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(...args, params.limit, params.offset) as Array<Record<string, unknown>>;
		return rows.map(rowToAttribute);
	});
}

export function getEntityDependenciesDetailed(
	accessor: DbAccessor,
	params: {
		readonly entityId: string;
		readonly agentId: string;
		readonly direction: "incoming" | "outgoing" | "both";
	},
): readonly KnowledgeDependencyEdge[] {
	return accessor.withReadDb((db) => {
		const directionClauses: string[] = [];
		if (params.direction === "incoming" || params.direction === "both") {
			directionClauses.push("dep.target_entity_id = ?");
		}
		if (params.direction === "outgoing" || params.direction === "both") {
			directionClauses.push("dep.source_entity_id = ?");
		}
		const rows = db
			.prepare(
				`SELECT
					dep.*,
					src.name AS source_entity_name,
					dst.name AS target_entity_name
				 FROM entity_dependencies dep
				 JOIN entities src ON src.id = dep.source_entity_id
				 JOIN entities dst ON dst.id = dep.target_entity_id
				 WHERE dep.agent_id = ?
				   AND (${directionClauses.join(" OR ")})
				   AND COALESCE(dep.status, 'active') = 'active'
				   AND COALESCE(src.status, 'active') = 'active'
				   AND COALESCE(dst.status, 'active') = 'active'
				 ORDER BY dep.strength DESC, dep.updated_at DESC`,
			)
			.all(
				params.agentId,
				...(params.direction === "incoming" || params.direction === "both" ? [params.entityId] : []),
				...(params.direction === "outgoing" || params.direction === "both" ? [params.entityId] : []),
			) as Array<Record<string, unknown>>;

		return rows.map((row) => ({
			id: row.id as string,
			direction: row.source_entity_id === params.entityId ? "outgoing" : "incoming",
			dependencyType: row.dependency_type as string,
			strength: Number(row.strength ?? 0),
			aspectId: (row.aspect_id as string) ?? null,
			reason: typeof row.reason === "string" ? row.reason : null,
			sourceEntityId: row.source_entity_id as string,
			sourceEntityName: row.source_entity_name as string,
			targetEntityId: row.target_entity_id as string,
			targetEntityName: row.target_entity_name as string,
			createdAt: row.created_at as string,
			updatedAt: row.updated_at as string,
		}));
	});
}

export function getKnowledgeStats(accessor: DbAccessor, agentId: string): KnowledgeStats {
	return accessor.withReadDb((db) => {
		// Drive the join from the (narrower) agent-scoped entities side rather
		// than scanning every memory with a correlated EXISTS. Same result,
		// dramatically smaller search space on large corpora.
		// See Signet-AI/signetai#515.
		const scopedMemoryRows = db
			.prepare(
				`SELECT COUNT(DISTINCT mem.memory_id) as n
				 FROM memory_entity_mentions mem
				 JOIN entities e ON e.id = mem.entity_id AND e.agent_id = ?
				 JOIN memories m ON m.id = mem.memory_id AND m.is_deleted = 0
				 WHERE COALESCE(e.status, 'active') = 'active'`,
			)
			.get(agentId) as { n: number };
		const entityCount = db
			.prepare("SELECT COUNT(*) as n FROM entities WHERE agent_id = ? AND COALESCE(status, 'active') = 'active'")
			.get(agentId) as { n: number };
		const aspectCount = db
			.prepare(
				`SELECT COUNT(*) as n
				 FROM entity_aspects asp
				 JOIN entities e ON e.id = asp.entity_id AND e.agent_id = asp.agent_id
				 WHERE asp.agent_id = ?
				   AND COALESCE(e.status, 'active') = 'active'
				   AND COALESCE(asp.status, 'active') = 'active'`,
			)
			.get(agentId) as { n: number };
		const attributeCount = db
			.prepare(
				`SELECT COUNT(*) as n
				 FROM entity_attributes attr
				 JOIN entity_aspects asp ON asp.id = attr.aspect_id AND asp.agent_id = attr.agent_id
				 JOIN entities e ON e.id = asp.entity_id AND e.agent_id = asp.agent_id
				 WHERE attr.agent_id = ?
				   AND attr.kind = 'attribute'
				   AND attr.status = 'active'
				   AND COALESCE(e.status, 'active') = 'active'
				   AND COALESCE(asp.status, 'active') = 'active'`,
			)
			.get(agentId) as { n: number };
		const constraintCount = db
			.prepare(
				`SELECT COUNT(*) as n
				 FROM entity_attributes attr
				 JOIN entity_aspects asp ON asp.id = attr.aspect_id AND asp.agent_id = attr.agent_id
				 JOIN entities e ON e.id = asp.entity_id AND e.agent_id = asp.agent_id
				 WHERE attr.agent_id = ?
				   AND attr.kind = 'constraint'
				   AND attr.status = 'active'
				   AND COALESCE(e.status, 'active') = 'active'
				   AND COALESCE(asp.status, 'active') = 'active'`,
			)
			.get(agentId) as { n: number };
		const dependencyCount = db
			.prepare(
				`SELECT COUNT(*) as n
				 FROM entity_dependencies dep
				 JOIN entities src ON src.id = dep.source_entity_id AND src.agent_id = dep.agent_id
				 JOIN entities dst ON dst.id = dep.target_entity_id AND dst.agent_id = dep.agent_id
				 WHERE dep.agent_id = ?
				   AND COALESCE(dep.status, 'active') = 'active'
				   AND COALESCE(src.status, 'active') = 'active'
				   AND COALESCE(dst.status, 'active') = 'active'`,
			)
			.get(agentId) as { n: number };
		const assignedMemoryCount = db
			.prepare(
				`SELECT COUNT(DISTINCT attr.memory_id) as n
				 FROM entity_attributes attr
				 JOIN entity_aspects asp ON asp.id = attr.aspect_id AND asp.agent_id = attr.agent_id
				 JOIN entities e ON e.id = asp.entity_id AND e.agent_id = asp.agent_id
				 WHERE attr.agent_id = ?
				   AND attr.status = 'active'
				   AND attr.memory_id IS NOT NULL
				   AND COALESCE(e.status, 'active') = 'active'
				   AND COALESCE(asp.status, 'active') = 'active'`,
			)
			.get(agentId) as { n: number };
		const feedbackStats = db
			.prepare(
				`SELECT
					COUNT(*) AS aspect_count,
					COALESCE(AVG(weight), 0) AS avg_weight,
					COUNT(CASE WHEN weight >= 1.0 THEN 1 END) AS max_weight_count,
					COUNT(CASE WHEN weight <= 0.1 THEN 1 END) AS min_weight_count,
					COUNT(CASE
						WHEN asp.updated_at >= datetime('now', '-7 days') THEN 1
					END) AS updated_last_7_days
				 FROM entity_aspects asp
				 JOIN entities e ON e.id = asp.entity_id AND e.agent_id = asp.agent_id
				 WHERE asp.agent_id = ?
				   AND COALESCE(e.status, 'active') = 'active'
				   AND COALESCE(asp.status, 'active') = 'active'`,
			)
			.get(agentId) as {
			aspect_count: number;
			avg_weight: number;
			max_weight_count: number;
			min_weight_count: number;
			updated_last_7_days: number;
		};

		const coveragePercent =
			scopedMemoryRows.n > 0 ? Math.round((assignedMemoryCount.n / scopedMemoryRows.n) * 1000) / 10 : 0;

		return {
			entityCount: entityCount.n,
			aspectCount: aspectCount.n,
			attributeCount: attributeCount.n,
			constraintCount: constraintCount.n,
			dependencyCount: dependencyCount.n,
			unassignedMemoryCount: Math.max(scopedMemoryRows.n - assignedMemoryCount.n, 0),
			coveragePercent,
			feedbackUpdatedAspectCount: Number(feedbackStats.updated_last_7_days ?? 0),
			averageAspectWeight: Math.round(Number(feedbackStats.avg_weight ?? 0) * 1000) / 1000,
			maxWeightAspectCount: Number(feedbackStats.max_weight_count ?? 0),
			minWeightAspectCount: Number(feedbackStats.min_weight_count ?? 0),
		};
	});
}

export function getEntityHealth(
	accessor: DbAccessor,
	agentId: string,
	since?: string,
	minComparisons = 3,
): ReadonlyArray<EntityHealth> {
	return accessor.withReadDb((db) => {
		const args: Array<string | number> = [agentId];
		const sinceClause = typeof since === "string" && since.length > 0 ? " AND created_at >= ?" : "";
		if (sinceClause && since !== undefined) {
			args.push(since);
		}

		const predictorComparisonsExists = db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'predictor_comparisons'")
			.get();
		if (!predictorComparisonsExists) return [];

		const rows = db
			.prepare(
				`SELECT
					focal_entity_id,
					COALESCE(focal_entity_name, '') AS focal_entity_name,
					predictor_won,
					margin,
					created_at
				 FROM predictor_comparisons
				 WHERE agent_id = ?
				   AND focal_entity_id IS NOT NULL
				   ${sinceClause}
				 ORDER BY focal_entity_id ASC, created_at ASC`,
			)
			.all(...args) as Array<Record<string, unknown>>;

		const grouped = new Map<
			string,
			Array<{
				readonly entityName: string;
				readonly predictorWon: number;
				readonly margin: number;
			}>
		>();
		for (const row of rows) {
			if (typeof row.focal_entity_id !== "string") continue;
			const bucket = grouped.get(row.focal_entity_id) ?? [];
			bucket.push({
				entityName:
					typeof row.focal_entity_name === "string" && row.focal_entity_name.length > 0
						? row.focal_entity_name
						: row.focal_entity_id,
				predictorWon: Number(row.predictor_won ?? 0),
				margin: Number(row.margin ?? 0),
			});
			grouped.set(row.focal_entity_id, bucket);
		}

		const health: EntityHealth[] = [];
		for (const [entityId, comparisons] of grouped) {
			if (comparisons.length < minComparisons) continue;

			const wins = comparisons.reduce((total, row) => total + (row.predictorWon > 0 ? 1 : 0), 0);
			const avgMargin = comparisons.reduce((total, row) => total + row.margin, 0) / comparisons.length;
			const midpoint = Math.max(1, Math.floor(comparisons.length / 2));
			const firstHalf = comparisons.slice(0, midpoint);
			const secondHalf = comparisons.slice(midpoint);
			const firstHalfRate =
				firstHalf.reduce((total, row) => total + (row.predictorWon > 0 ? 1 : 0), 0) / firstHalf.length;
			const secondHalfRate =
				secondHalf.length > 0
					? secondHalf.reduce((total, row) => total + (row.predictorWon > 0 ? 1 : 0), 0) / secondHalf.length
					: firstHalfRate;
			const rateDelta = secondHalfRate - firstHalfRate;
			health.push({
				entityId,
				entityName: comparisons[0]?.entityName ?? entityId,
				comparisonCount: comparisons.length,
				winRate: wins / comparisons.length,
				avgMargin,
				trend: rateDelta > 0.1 ? "improving" : rateDelta < -0.1 ? "declining" : "stable",
			});
		}

		health.sort((a, b) => {
			if (b.winRate !== a.winRate) return b.winRate - a.winRate;
			return b.comparisonCount - a.comparisonCount;
		});
		return health;
	});
}

export function propagateMemoryStatus(accessor: DbAccessor, agentId: string): number {
	return accessor.withWriteTx((db) => {
		const stale = db
			.prepare(
				`SELECT id
				 FROM entity_attributes
				 WHERE agent_id = ?
				   AND status = 'active'
				   AND memory_id IS NOT NULL
				   AND memory_id NOT IN (
				     SELECT id FROM memories WHERE is_deleted = 0
				   )`,
			)
			.all(agentId) as Array<Record<string, unknown>>;
		if (stale.length === 0) return 0;

		const ids = stale.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
		if (ids.length === 0) return 0;

		const placeholders = ids.map(() => "?").join(", ");
		db.prepare(
			`UPDATE entity_attributes
			 SET status = 'superseded', updated_at = ?
			 WHERE id IN (${placeholders}) AND agent_id = ?`,
		).run(now(), ...ids, agentId);
		return ids.length;
	});
}

// ---------------------------------------------------------------------------
// Constellation overlay — hierarchical graph
// ---------------------------------------------------------------------------

export interface ConstellationAttribute {
	readonly id: string;
	readonly content: string;
	readonly kind: "attribute" | "constraint";
	readonly importance: number;
	readonly memoryId: string | null;
	readonly status: AttributeStatus;
	readonly version: number;
	readonly versionRootId: string | null;
	readonly previousAttributeId: string | null;
	readonly groupKey: string | null;
	readonly claimKey: string | null;
	readonly sourceKind: string | null;
	readonly sourcePath: string | null;
	readonly proposalId: string | null;
	readonly proposalEvidenceCount: number;
}

export interface ConstellationAspect {
	readonly id: string;
	readonly name: string;
	readonly weight: number;
	readonly status: "active" | "archived";
	readonly proposalId: string | null;
	readonly attributes: readonly ConstellationAttribute[];
}

export interface ConstellationEntity {
	readonly id: string;
	readonly name: string;
	readonly entityType: string;
	readonly mentions: number;
	readonly pinned: boolean;
	readonly status: "active" | "archived";
	readonly proposalId: string | null;
	readonly aspects: readonly ConstellationAspect[];
}

export interface ConstellationDependency {
	readonly sourceEntityId: string;
	readonly targetEntityId: string;
	readonly dependencyType: string;
	readonly strength: number;
	readonly status: "active" | "archived";
	readonly proposalId: string | null;
	readonly proposalEvidenceCount: number;
}

export interface ConstellationProposal {
	readonly id: string;
	readonly operation: string;
	readonly confidence: number;
	readonly rationale: string;
	readonly evidenceCount: number;
	readonly sourceKind: string | null;
	readonly sourcePath: string | null;
	readonly updatedAt: string;
	readonly targetEntityId: string | null;
	readonly targetEntityName: string | null;
	readonly targetAspectName: string | null;
	readonly preview: string | null;
}

export interface ConstellationDreamingSummary {
	readonly tokensSinceLastPass: number;
	readonly consecutiveFailures: number;
	readonly lastPassAt: string | null;
	readonly lastPassId: string | null;
	readonly lastPassMode: string | null;
	readonly latestPass: {
		readonly id: string;
		readonly mode: string;
		readonly status: string;
		readonly completedAt: string | null;
		readonly mutationsApplied: number | null;
		readonly mutationsSkipped: number | null;
		readonly mutationsFailed: number | null;
	} | null;
}

export interface ConstellationProposalSummary {
	readonly pending: number;
	readonly appliedRecent: number;
	readonly failedRecent: number;
}

export interface ConstellationGraph {
	readonly entities: readonly ConstellationEntity[];
	readonly dependencies: readonly ConstellationDependency[];
	readonly proposals: readonly ConstellationProposal[];
	readonly metadata: {
		readonly dreaming: ConstellationDreamingSummary;
		readonly proposals: ConstellationProposalSummary;
	};
}

export interface ConstellationGraphOptions {
	readonly limit?: number;
	readonly maxAspectsPerEntity?: number;
	readonly maxAttributesPerAspect?: number;
	readonly dependencyLimit?: number;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value as number), min), max) : fallback;
}

function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function readStringValue(record: Record<string, unknown>, keys: readonly string[]): string | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return null;
}

function previewFromProposalPayload(payload: Record<string, unknown>): string | null {
	const value = readStringValue(payload, ["value", "content", "name", "target", "reason"]);
	if (!value) return null;
	return value.length > 140 ? `${value.slice(0, 137)}...` : value;
}

function resolveProposalTargetEntity(
	payload: Record<string, unknown>,
	entitiesById: ReadonlyMap<string, string>,
	entitiesByName: ReadonlyMap<string, string>,
): { readonly id: string | null; readonly name: string | null } {
	const id = readStringValue(payload, ["entity_id", "target_entity_id", "target_id"]);
	if (id && entitiesById.has(id)) return { id, name: entitiesById.get(id) ?? null };

	const name = readStringValue(payload, ["entity", "target_entity", "name", "target"]);
	if (!name) return { id: null, name: null };
	return { id: entitiesByName.get(toCanonicalName(name)) ?? null, name };
}

function getConstellationDreamingSummary(db: ReadDb, agentId: string): ConstellationDreamingSummary {
	const state = db
		.prepare(
			`SELECT tokens_since_last_pass, consecutive_failures, last_pass_at, last_pass_id, last_pass_mode
			 FROM dreaming_state WHERE agent_id = ?`,
		)
		.get(agentId) as
		| {
				tokens_since_last_pass: number;
				consecutive_failures: number;
				last_pass_at: string | null;
				last_pass_id: string | null;
				last_pass_mode: string | null;
		  }
		| undefined;
	const latestPass = db
		.prepare(
			`SELECT id, mode, status, completed_at, mutations_applied, mutations_skipped, mutations_failed
			 FROM dreaming_passes
			 WHERE agent_id = ?
			 ORDER BY created_at DESC
			 LIMIT 1`,
		)
		.get(agentId) as
		| {
				id: string;
				mode: string;
				status: string;
				completed_at: string | null;
				mutations_applied: number | null;
				mutations_skipped: number | null;
				mutations_failed: number | null;
		  }
		| undefined;

	return {
		tokensSinceLastPass: Math.max(0, state?.tokens_since_last_pass ?? 0),
		consecutiveFailures: Math.max(0, state?.consecutive_failures ?? 0),
		lastPassAt: state?.last_pass_at ?? null,
		lastPassId: state?.last_pass_id ?? null,
		lastPassMode: state?.last_pass_mode ?? null,
		latestPass: latestPass
			? {
					id: latestPass.id,
					mode: latestPass.mode,
					status: latestPass.status,
					completedAt: latestPass.completed_at,
					mutationsApplied: latestPass.mutations_applied,
					mutationsSkipped: latestPass.mutations_skipped,
					mutationsFailed: latestPass.mutations_failed,
				}
			: null,
	};
}

function getConstellationProposalSummary(db: ReadDb, agentId: string): ConstellationProposalSummary {
	const pending = db
		.prepare("SELECT COUNT(*) AS n FROM ontology_proposals WHERE agent_id = ? AND status = 'pending'")
		.get(agentId) as { n: number } | undefined;
	const applied = db
		.prepare(
			`SELECT COUNT(*) AS n FROM ontology_proposals
			 WHERE agent_id = ? AND status = 'applied' AND updated_at >= datetime('now', '-7 days')`,
		)
		.get(agentId) as { n: number } | undefined;
	const failed = db
		.prepare(
			`SELECT COUNT(*) AS n FROM ontology_proposals
			 WHERE agent_id = ? AND status = 'failed' AND updated_at >= datetime('now', '-7 days')`,
		)
		.get(agentId) as { n: number } | undefined;
	return {
		pending: Math.max(0, pending?.n ?? 0),
		appliedRecent: Math.max(0, applied?.n ?? 0),
		failedRecent: Math.max(0, failed?.n ?? 0),
	};
}

export function getKnowledgeGraphForConstellation(
	accessor: DbAccessor,
	agentId: string,
	options: ConstellationGraphOptions = {},
): ConstellationGraph {
	const limit = boundedInteger(options.limit, 150, 1, 300);
	const maxAspectsPerEntity = boundedInteger(options.maxAspectsPerEntity, 6, 1, 25);
	const maxAttributesPerAspect = boundedInteger(options.maxAttributesPerAspect, 4, 1, 250);
	const dependencyLimit = boundedInteger(options.dependencyLimit, 500, 1, 2000);

	return accessor.withReadDb((db) => {
		// Keep the dashboard read path bounded. The previous implementation loaded
		// every aspect, active attribute, and dependency for the agent, then filtered
		// in JS. Large real workspaces can turn a simple Ontology tab visit into an
		// event-loop/RSS spike big enough for systemd to SIGKILL the daemon.
		const entityRows = db
			.prepare(
				`SELECT e.id, e.name, e.entity_type, e.mentions, e.pinned, e.status, e.proposal_id
				 FROM entities e
				 WHERE e.agent_id = ?
				   AND COALESCE(e.status, 'active') = 'active'
				   AND (e.mentions > 0 OR e.pinned = 1)
				 ORDER BY e.pinned DESC, e.mentions DESC, e.name ASC
				 LIMIT ?`,
			)
			.all(agentId, limit) as Array<Record<string, unknown>>;

		const entityIds = entityRows.map((r) => r.id as string).filter((id) => typeof id === "string");

		if (entityIds.length === 0) {
			return {
				entities: [],
				dependencies: [],
				proposals: [],
				metadata: {
					dreaming: getConstellationDreamingSummary(db, agentId),
					proposals: getConstellationProposalSummary(db, agentId),
				},
			};
		}

		const entityIdSet = new Set(entityIds);
		const entityIdPlaceholders = placeholders(entityIds.length);
		const aspectRows = db
			.prepare(
				`SELECT id, entity_id, name, weight, status, proposal_id
				 FROM (
				   SELECT id, entity_id, name, weight, status, proposal_id,
				          ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY weight DESC, name ASC) AS rn
				   FROM entity_aspects
				   WHERE agent_id = ?
				     AND COALESCE(status, 'active') = 'active'
				     AND entity_id IN (${entityIdPlaceholders})
				 ) ranked_aspects
				 WHERE rn <= ?
				 ORDER BY entity_id ASC, weight DESC, name ASC`,
			)
			.all(agentId, ...entityIds, maxAspectsPerEntity) as Array<Record<string, unknown>>;

		const aspectsByEntity = new Map<
			string,
			Array<{
				id: string;
				name: string;
				weight: number;
				status: "active" | "archived";
				proposalId: string | null;
			}>
		>();
		const aspectIds: string[] = [];

		for (const row of aspectRows) {
			const entityId = row.entity_id as string;
			if (!entityIdSet.has(entityId)) continue;
			const bucket = aspectsByEntity.get(entityId) ?? [];
			if (bucket.length >= maxAspectsPerEntity) continue;
			const aspectId = row.id as string;
			aspectIds.push(aspectId);
			bucket.push({
				id: aspectId,
				name: row.name as string,
				weight: Number(row.weight ?? 0.5),
				status: row.status === "archived" ? "archived" : "active",
				proposalId: typeof row.proposal_id === "string" ? row.proposal_id : null,
			});
			aspectsByEntity.set(entityId, bucket);
		}

		const attrsByAspect = new Map<string, ConstellationAttribute[]>();
		if (aspectIds.length > 0) {
			const aspectIdSet = new Set(aspectIds);
			const aspectIdPlaceholders = placeholders(aspectIds.length);
			const attrRows = db
				.prepare(
					`SELECT id, aspect_id, content, kind, importance, memory_id, status,
					        version, version_root_id, previous_attribute_id,
					        group_key, claim_key, source_kind, source_path,
					        proposal_id, proposal_evidence
					 FROM (
					   SELECT id, aspect_id, content, kind, importance, memory_id, status,
					          version, version_root_id, previous_attribute_id,
					          group_key, claim_key, source_kind, source_path,
					          proposal_id, proposal_evidence,
					          ROW_NUMBER() OVER (PARTITION BY aspect_id ORDER BY importance DESC, id ASC) AS rn
					   FROM entity_attributes
					   WHERE agent_id = ? AND status = 'active' AND aspect_id IN (${aspectIdPlaceholders})
					 ) ranked_attributes
					 WHERE rn <= ?
					 ORDER BY aspect_id ASC, importance DESC`,
				)
				.all(agentId, ...aspectIds, maxAttributesPerAspect) as Array<Record<string, unknown>>;

			for (const row of attrRows) {
				const aspectId = row.aspect_id as string;
				if (!aspectIdSet.has(aspectId)) continue;
				const bucket = attrsByAspect.get(aspectId) ?? [];
				if (bucket.length >= maxAttributesPerAspect) continue;
				bucket.push({
					id: row.id as string,
					content: row.content as string,
					kind: row.kind as "attribute" | "constraint",
					importance: Number(row.importance ?? 0.5),
					memoryId: typeof row.memory_id === "string" ? row.memory_id : null,
					status: row.status as AttributeStatus,
					version: typeof row.version === "number" ? row.version : 1,
					versionRootId: typeof row.version_root_id === "string" ? row.version_root_id : null,
					previousAttributeId: typeof row.previous_attribute_id === "string" ? row.previous_attribute_id : null,
					groupKey: typeof row.group_key === "string" ? row.group_key : null,
					claimKey: typeof row.claim_key === "string" ? row.claim_key : null,
					sourceKind: typeof row.source_kind === "string" ? row.source_kind : null,
					sourcePath: typeof row.source_path === "string" ? row.source_path : null,
					proposalId: typeof row.proposal_id === "string" ? row.proposal_id : null,
					proposalEvidenceCount: parseJsonArray(row.proposal_evidence).length,
				});
				attrsByAspect.set(aspectId, bucket);
			}
		}

		const entitiesById = new Map<string, string>();
		const entitiesByName = new Map<string, string>();
		const entities: ConstellationEntity[] = entityRows.map((row) => {
			const eid = row.id as string;
			const name = row.name as string;
			entitiesById.set(eid, name);
			entitiesByName.set(toCanonicalName(name), eid);
			const aspects: ConstellationAspect[] = (aspectsByEntity.get(eid) ?? []).map((asp) => ({
				id: asp.id,
				name: asp.name,
				weight: asp.weight,
				status: asp.status,
				proposalId: asp.proposalId,
				attributes: attrsByAspect.get(asp.id) ?? [],
			}));
			return {
				id: eid,
				name,
				entityType: row.entity_type as string,
				mentions: typeof row.mentions === "number" ? row.mentions : 0,
				pinned: row.pinned === 1,
				status: row.status === "archived" ? "archived" : "active",
				proposalId: typeof row.proposal_id === "string" ? row.proposal_id : null,
				aspects,
			};
		});

		const depRows = db
			.prepare(
				`SELECT source_entity_id, target_entity_id, dependency_type, strength, status, proposal_id, proposal_evidence
				 FROM entity_dependencies
				 WHERE agent_id = ?
				   AND COALESCE(status, 'active') = 'active'
				   AND source_entity_id IN (${entityIdPlaceholders})
				   AND target_entity_id IN (${entityIdPlaceholders})
				 ORDER BY strength DESC
				 LIMIT ?`,
			)
			.all(agentId, ...entityIds, ...entityIds, dependencyLimit) as Array<Record<string, unknown>>;

		const dependencies: ConstellationDependency[] = depRows.map((row) => ({
			sourceEntityId: row.source_entity_id as string,
			targetEntityId: row.target_entity_id as string,
			dependencyType: row.dependency_type as string,
			strength: Number(row.strength ?? 0.5),
			status: row.status === "archived" ? "archived" : "active",
			proposalId: typeof row.proposal_id === "string" ? row.proposal_id : null,
			proposalEvidenceCount: parseJsonArray(row.proposal_evidence).length,
		}));

		const proposalRows = db
			.prepare(
				`SELECT id, operation, payload, confidence, rationale, evidence,
				        source_kind, source_path, updated_at
				 FROM ontology_proposals
				 WHERE agent_id = ? AND status = 'pending'
				 ORDER BY updated_at DESC
				 LIMIT 80`,
			)
			.all(agentId) as Array<Record<string, unknown>>;
		const proposals: ConstellationProposal[] = proposalRows.map((row) => {
			const payload = parseJsonRecord(row.payload);
			const target = resolveProposalTargetEntity(payload, entitiesById, entitiesByName);
			return {
				id: row.id as string,
				operation: row.operation as string,
				confidence: Number(row.confidence ?? 0),
				rationale: typeof row.rationale === "string" ? row.rationale : "",
				evidenceCount: parseJsonArray(row.evidence).length,
				sourceKind: typeof row.source_kind === "string" ? row.source_kind : null,
				sourcePath: typeof row.source_path === "string" ? row.source_path : null,
				updatedAt: row.updated_at as string,
				targetEntityId: target.id,
				targetEntityName: target.name,
				targetAspectName: readStringValue(payload, ["aspect", "target_aspect", "aspect_name"]),
				preview: previewFromProposalPayload(payload),
			};
		});

		return {
			entities,
			dependencies,
			proposals,
			metadata: {
				dreaming: getConstellationDreamingSummary(db, agentId),
				proposals: getConstellationProposalSummary(db, agentId),
			},
		};
	});
}

export function getStructuralDensity(accessor: DbAccessor, entityId: string, agentId: string): StructuralDensity {
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
