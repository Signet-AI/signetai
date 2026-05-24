import { createHash } from "node:crypto";
import type { WriteDb } from "./db-accessor";
import { getDbAccessor } from "./db-accessor";
import { countChanges } from "./db-helpers";
import { requireDependencyReason } from "./dependency-history";

interface HeadingSection {
	readonly heading: string;
	readonly level: number;
	readonly body: string;
}

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
	readonly aspectsTouched: number;
	readonly attributesTouched: number;
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

function slug(value: string): string {
	const out = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/_{2,}/g, "_");
	return out || "general";
}

function stripFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---\n")) return normalized;
	const end = normalized.indexOf("\n---\n", 4);
	return end === -1 ? normalized : normalized.slice(end + 5);
}

function parseSections(content: string): HeadingSection[] {
	const lines = stripFrontmatter(content).split("\n");
	const sections: Array<{ heading: string; level: number; lines: string[] }> = [];
	let current: { heading: string; level: number; lines: string[] } = { heading: "Overview", level: 0, lines: [] };
	for (const line of lines) {
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (match) {
			if (current.lines.join("\n").trim().length > 0 || current.heading !== "Overview") sections.push(current);
			current = { heading: match[2] ?? "Untitled", level: match[1]?.length ?? 1, lines: [] };
			continue;
		}
		current.lines.push(line);
	}
	if (current.lines.join("\n").trim().length > 0 || current.heading !== "Overview") sections.push(current);
	return sections.map((section) => ({
		heading: section.heading,
		level: section.level,
		body: section.lines.join("\n"),
	}));
}

function bodyClaims(body: string): string[] {
	return body
		.split(/\n{2,}|\n(?=-\s+)/)
		.map((part) => part.replace(/^[-*]\s+/gm, "").trim())
		.filter((part) => part.length >= 20)
		.slice(0, 12);
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
	const tail = clean.split(/[\/#]/).filter(Boolean).at(-1);
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

function purgeSourceArtifactStructureInTx(
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

	const attributes = countChanges(
		db
			.prepare("DELETE FROM entity_attributes WHERE agent_id = ? AND source_id = ? AND source_path = ?")
			.run(input.agentId, input.sourceId, input.sourcePath),
	);
	const dependencies = countChanges(
		db
			.prepare("DELETE FROM entity_dependencies WHERE agent_id = ? AND source_id = ? AND source_path = ?")
			.run(input.agentId, input.sourceId, input.sourcePath),
	);

	let aspects = 0;
	if (entityIds.length > 0) {
		const stmt = db.prepare("DELETE FROM entity_aspects WHERE agent_id = ? AND entity_id = ?");
		for (const entityId of entityIds) aspects += countChanges(stmt.run(input.agentId, entityId));
	}

	const entities = countChanges(
		db
			.prepare(
				`DELETE FROM entities
				 WHERE agent_id = ?
				   AND source_id = ?
				   AND source_path = ?
				   AND entity_type IN ('source_document', 'source_document_reference')`,
			)
			.run(input.agentId, input.sourceId, input.sourcePath),
	);

	return { entities, aspects, attributes, dependencies };
}

export function purgeSourceArtifactStructure(
	input: PurgeSourceArtifactStructureInput,
): PurgeSourceArtifactStructureResult {
	return getDbAccessor().withWriteTx((db) => purgeSourceArtifactStructureInTx(db, input));
}

export function indexSourceArtifactStructure(
	input: IndexSourceArtifactStructureInput,
): IndexSourceArtifactStructureResult {
	const now = new Date().toISOString();
	return getDbAccessor().withWriteTx((db) => {
		purgeSourceArtifactStructureInTx(db, input);

		let entitiesTouched = 0;
		let dependenciesTouched = 0;
		let aspectsTouched = 0;
		let attributesTouched = 0;

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

		for (const section of parseSections(input.content)) {
			const aspectId = idFor(input.agentId, input.sourceId, "aspect", input.sourcePath, section.heading);
			const aspectCanon = slug(section.heading);
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(entity_id, canonical_name) DO UPDATE SET updated_at = excluded.updated_at, name = excluded.name`,
			).run(aspectId, doc.id, input.agentId, section.heading, aspectCanon, section.level === 1 ? 0.9 : 0.7, now, now);
			aspectsTouched++;

			let claimIndex = 0;
			for (const claim of bodyClaims(section.body)) {
				const attrId = idFor(
					input.agentId,
					input.sourceId,
					"attribute",
					input.sourcePath,
					section.heading,
					claimIndex.toString(),
				);
				db.prepare(
					`INSERT INTO entity_attributes
					 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, group_key, claim_key,
					  confidence, importance, status, created_at, updated_at, source_id, source_kind, source_path, source_root)
					 VALUES (?, ?, ?, NULL, 'claim', ?, ?, ?, ?, 0.8, 0.5, 'active', ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET
					   content = excluded.content,
					   normalized_content = excluded.normalized_content,
					   updated_at = excluded.updated_at,
					   source_id = excluded.source_id,
					   source_kind = excluded.source_kind,
					   source_path = excluded.source_path,
					   source_root = excluded.source_root`,
				).run(
					attrId,
					aspectId,
					input.agentId,
					claim,
					claim.toLowerCase(),
					slug(input.sourceKind),
					`${aspectCanon}_${claimIndex}`,
					now,
					now,
					input.sourceId,
					input.sourceKind,
					input.sourcePath,
					input.sourceRoot,
				);
				attributesTouched++;
				claimIndex++;
			}
		}

		return {
			documentEntityId: doc.id,
			entitiesTouched,
			dependenciesTouched,
			aspectsTouched,
			attributesTouched,
		};
	});
}
