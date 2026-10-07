import { createHash } from "node:crypto";
import type { WriteDb } from "./db-accessor";
import { getDbAccessor } from "./db-accessor";
import { countChanges } from "./db-helpers";
import { requireDependencyReason } from "./dependency-history";
import { reconcileOntologyContradictionsInTx } from "./ontology-contradictions";
import { purgeAttributeMemoryProjectionsInTx } from "./semantic-memory-projection";
import {
	flagDreamingClaimsForRemovedSourcePathInTx,
	flagDreamingClaimsForSourceRevisionInTx,
} from "./source-claim-review";

export interface IndexSourceArtifactStructureInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourceKind: string;
	readonly sourceRoot: string;
	readonly sourcePath: string;
	readonly sourceParentPath?: string;
	readonly displayName?: string;
	readonly content: string;
}

export interface IndexSourceArtifactStructureResult {
	readonly documentEntityId: string;
	readonly entitiesTouched: number;
	readonly dependenciesTouched: number;
}

export interface PurgeSourceArtifactStructureInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourcePath: string;
}

export interface PurgeSourceArtifactStructureResult {
	readonly entities: number;
	readonly aspects: number;
	readonly attributes: number;
	readonly dependencies: number;
}

function canonicalSegment(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function sourceCanonical(sourceId: string, kind: "source" | "document" | "reference", path: string): string {
	const suffix = canonicalSegment(path);
	return suffix.length > 0 ? `source:${sourceId}:${kind}:${suffix}` : `source:${sourceId}:${kind}:/`;
}

function idFor(...parts: readonly string[]): string {
	return `src_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32)}`;
}

function stripFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---\n")) return normalized;
	const end = normalized.indexOf("\n---\n", 4);
	return end === -1 ? normalized : normalized.slice(end + 5);
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function displayNameFromPath(path: string): string {
	const clean = canonicalSegment(path);
	const tail = clean.split(/[/#]/).filter(Boolean).at(-1);
	return tail ? safeDecodeURIComponent(tail).replace(/\.[a-z0-9]+$/i, "") : path;
}

function displayNameFor(input: IndexSourceArtifactStructureInput): string {
	if (input.displayName?.trim()) return input.displayName.trim();
	const heading = /^(#{1,6})\s+(.+?)\s*$/m.exec(stripFrontmatter(input.content))?.[2]?.trim();
	return heading && heading.length > 0 ? heading : displayNameFromPath(input.sourcePath);
}

function upsertSourceEntity(
	db: WriteDb,
	input: {
		readonly id: string;
		readonly name: string;
		readonly canonicalName: string;
		readonly entityType: string;
		readonly agentId: string;
		readonly sourceId: string;
		readonly sourceKind: string;
		readonly sourceRoot: string;
		readonly sourcePath: string;
		readonly now: string;
	},
): { readonly id: string; readonly inserted: boolean } {
	const uniqueName = `${input.name} - ${input.canonicalName} - ${input.agentId}`;
	const existing = db
		.prepare("SELECT id FROM entities WHERE canonical_name = ? AND agent_id = ? LIMIT 1")
		.get(input.canonicalName, input.agentId) as { id: string } | undefined;
	if (existing) {
		db.prepare(
			`UPDATE entities
			 SET name = ?, entity_type = ?, mentions = MAX(COALESCE(mentions, 0), 1), updated_at = ?,
			     source_id = ?, source_kind = ?, source_path = ?, source_root = ?
			 WHERE id = ?`,
		).run(
			uniqueName,
			input.entityType,
			input.now,
			input.sourceId,
			input.sourceKind,
			input.sourcePath,
			input.sourceRoot,
			existing.id,
		);
		return { id: existing.id, inserted: false };
	}
	db.prepare(
		`INSERT INTO entities
		 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at,
		  source_id, source_kind, source_path, source_root)
		 VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		uniqueName,
		input.canonicalName,
		input.entityType,
		input.agentId,
		input.now,
		input.now,
		input.sourceId,
		input.sourceKind,
		input.sourcePath,
		input.sourceRoot,
	);
	return { id: input.id, inserted: true };
}

function upsertDependency(
	db: WriteDb,
	input: {
		readonly sourceEntityId: string;
		readonly targetEntityId: string;
		readonly agentId: string;
		readonly sourceId: string;
		readonly sourceKind: string;
		readonly sourceRoot: string;
		readonly sourcePath: string;
		readonly reason: string;
		readonly now: string;
	},
): boolean {
	const existing = db
		.prepare(
			`SELECT id FROM entity_dependencies
			 WHERE source_entity_id = ? AND target_entity_id = ? AND dependency_type = 'contains' AND agent_id = ?
			 LIMIT 1`,
		)
		.get(input.sourceEntityId, input.targetEntityId, input.agentId) as { id: string } | undefined;
	if (existing) {
		db.prepare(
			`UPDATE entity_dependencies
			 SET strength = MAX(strength, 1), confidence = MAX(COALESCE(confidence, 0), 1),
			     reason = ?, updated_at = ?, source_id = ?, source_kind = ?, source_path = ?, source_root = ?
			 WHERE id = ?`,
		).run(
			requireDependencyReason("related_to", input.reason),
			input.now,
			input.sourceId,
			input.sourceKind,
			input.sourcePath,
			input.sourceRoot,
			existing.id,
		);
		return false;
	}
	db.prepare(
		`INSERT INTO entity_dependencies
		 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, reason,
		  created_at, updated_at, source_id, source_kind, source_path, source_root)
		 VALUES (?, ?, ?, ?, 'contains', 1, 1, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		idFor("dep", input.agentId, "contains", input.sourceEntityId, input.targetEntityId),
		input.sourceEntityId,
		input.targetEntityId,
		input.agentId,
		requireDependencyReason("related_to", input.reason),
		input.now,
		input.now,
		input.sourceId,
		input.sourceKind,
		input.sourcePath,
		input.sourceRoot,
	);
	return true;
}

export function purgeSourceArtifactStructureInTx(
	db: WriteDb,
	input: PurgeSourceArtifactStructureInput,
): PurgeSourceArtifactStructureResult {
	const removed = removeSourceArtifactStructureInTx(db, input);
	flagDreamingClaimsForRemovedSourcePathInTx(db, input);
	return removed;
}

const SOURCE_OWNED_ROW = "source_root NOT IN ('dreaming', 'dreaming_attention')";

function removeSourceArtifactStructureInTx(
	db: WriteDb,
	input: PurgeSourceArtifactStructureInput,
): PurgeSourceArtifactStructureResult {
	const entityRows = db
		.prepare(
			`SELECT id FROM entities
			 WHERE agent_id = ?
			   AND source_id = ?
			   AND source_path = ?
			   AND entity_type IN ('source_document', 'source_document_reference')`,
		)
		.all(input.agentId, input.sourceId, input.sourcePath) as Array<{ id: string }>;
	const entityIds = entityRows.map((row) => row.id);
	purgeAttributeMemoryProjectionsInTx(db, { ...input, keepDreaming: true });

	const attributes = countChanges(
		db
			.prepare(
				`DELETE FROM entity_attributes WHERE agent_id = ? AND source_id = ? AND source_path = ? AND ${SOURCE_OWNED_ROW}`,
			)
			.run(input.agentId, input.sourceId, input.sourcePath),
	);
	const dependencies = countChanges(
		db
			.prepare(
				`DELETE FROM entity_dependencies WHERE agent_id = ? AND source_id = ? AND source_path = ? AND ${SOURCE_OWNED_ROW}`,
			)
			.run(input.agentId, input.sourceId, input.sourcePath),
	);

	let aspects = 0;
	if (entityIds.length > 0) {
		const stmt = db.prepare(
			`DELETE FROM entity_aspects WHERE agent_id = ? AND entity_id = ?
			 AND NOT EXISTS (SELECT 1 FROM entity_attributes attr WHERE attr.aspect_id = entity_aspects.id)`,
		);
		for (const entityId of entityIds) aspects += countChanges(stmt.run(input.agentId, entityId));
	}

	const entities = countChanges(
		db
			.prepare(
				`DELETE FROM entities
				 WHERE agent_id = ?
				   AND source_id = ?
				   AND source_path = ?
				   AND entity_type IN ('source_document', 'source_document_reference')
				   AND NOT EXISTS (SELECT 1 FROM entity_aspects asp WHERE asp.entity_id = entities.id)`,
			)
			.run(input.agentId, input.sourceId, input.sourcePath),
	);
	reconcileOntologyContradictionsInTx(db, {
		agentId: input.agentId,
		sourceId: input.sourceId,
	});

	return { entities, aspects, attributes, dependencies };
}

export function purgeSourceArtifactStructure(
	input: PurgeSourceArtifactStructureInput,
): PurgeSourceArtifactStructureResult {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return getDbAccessor().withWriteTx(
		(db: import("./db-accessor").WriteDb) => purgeSourceArtifactStructureInTx(db, input),
		"db:source-graph.artifact.purge.write",
	);
}

export async function purgeSourceArtifactStructureAsync(
	input: PurgeSourceArtifactStructureInput,
): Promise<PurgeSourceArtifactStructureResult> {
	const { dbOwnerSourceArtifactPurge } = await import("./db-owner-runtime");
	return (await dbOwnerSourceArtifactPurge(input, {
		operation: "sources.artifacts.graph-purge",
		lane: "write",
		workloadClass: "maintenance",
		deadlineMs: 30_000,
		estimatedWorkUnits: 2,
	})) as PurgeSourceArtifactStructureResult;
}

export function indexSourceArtifactStructure(
	input: IndexSourceArtifactStructureInput,
): IndexSourceArtifactStructureResult {
	const now = new Date().toISOString();
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return getDbAccessor().withWriteTx(
		(db: import("./db-accessor").WriteDb) => indexSourceArtifactStructureInTx(db, input, now),
		"db:source-graph.artifact.index.write",
	);
}

export async function indexSourceArtifactStructureAsync(
	input: IndexSourceArtifactStructureInput,
): Promise<IndexSourceArtifactStructureResult> {
	const { dbOwnerSourceArtifactIndex } = await import("./db-owner-runtime");
	return (await dbOwnerSourceArtifactIndex(input, {
		operation: "sources.artifacts.graph-index",
		lane: "write",
		workloadClass: "maintenance",
		deadlineMs: 30_000,
		estimatedWorkUnits: Math.max(1, Math.ceil(input.content.length / 1024)),
	})) as IndexSourceArtifactStructureResult;
}

export function indexSourceArtifactStructureInTx(
	db: WriteDb,
	input: IndexSourceArtifactStructureInput,
	now = new Date().toISOString(),
): IndexSourceArtifactStructureResult {
	removeSourceArtifactStructureInTx(db, input);
	flagDreamingClaimsForSourceRevisionInTx(db, {
		agentId: input.agentId,
		sourceId: input.sourceId,
		sourcePath: input.sourcePath,
		content: input.content,
	});

	let entitiesTouched = 0;
	let dependenciesTouched = 0;

	const source = upsertSourceEntity(db, {
		id: idFor(input.agentId, input.sourceId, "source", input.sourceRoot),
		name: displayNameFromPath(input.sourceRoot),
		canonicalName: sourceCanonical(input.sourceId, "source", "/"),
		entityType: "source",
		agentId: input.agentId,
		sourceId: input.sourceId,
		sourceKind: input.sourceKind,
		sourceRoot: input.sourceRoot,
		sourcePath: input.sourceRoot,
		now,
	});
	entitiesTouched++;

	let parentEntityId = source.id;
	if (input.sourceParentPath?.trim()) {
		const parentPath = input.sourceParentPath.trim();
		const parent = upsertSourceEntity(db, {
			id: idFor(input.agentId, input.sourceId, "reference", parentPath),
			name: displayNameFromPath(parentPath),
			canonicalName: sourceCanonical(input.sourceId, "reference", parentPath),
			entityType: "source_document_reference",
			agentId: input.agentId,
			sourceId: input.sourceId,
			sourceKind: input.sourceKind,
			sourceRoot: input.sourceRoot,
			sourcePath: parentPath,
			now,
		});
		entitiesTouched++;
		parentEntityId = parent.id;
	}

	const doc = upsertSourceEntity(db, {
		id: idFor(input.agentId, input.sourceId, "document", input.sourcePath),
		name: displayNameFor(input),
		canonicalName: sourceCanonical(input.sourceId, "document", input.sourcePath),
		entityType: "source_document",
		agentId: input.agentId,
		sourceId: input.sourceId,
		sourceKind: input.sourceKind,
		sourceRoot: input.sourceRoot,
		sourcePath: input.sourcePath,
		now,
	});
	entitiesTouched++;

	if (
		upsertDependency(db, {
			sourceEntityId: parentEntityId,
			targetEntityId: doc.id,
			agentId: input.agentId,
			sourceId: input.sourceId,
			sourceKind: input.sourceKind,
			sourceRoot: input.sourceRoot,
			sourcePath: input.sourcePath,
			reason: `Source artifact ${input.sourcePath} belongs to ${input.sourceParentPath ?? input.sourceRoot}`,
			now,
		})
	) {
		dependenciesTouched++;
	}

	return {
		documentEntityId: doc.id,
		entitiesTouched,
		dependenciesTouched,
	};
}
