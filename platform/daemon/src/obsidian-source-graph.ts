import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { WriteDb } from "./db-accessor";
import { getDbAccessor } from "./db-accessor";
import { requireDependencyReason } from "./dependency-history";

const OBSIDIAN_SOURCE_KIND = "source_obsidian_markdown";

export interface IndexObsidianSourceStructureInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourceName: string;
	readonly root: string;
	readonly filePath: string;
	readonly content: string;
}

export interface IndexObsidianSourceStructureResult {
	readonly documentEntityId: string;
	readonly folderEntitiesTouched: number;
	readonly documentEntitiesTouched: number;
	readonly communitiesTouched: number;
	readonly dependenciesTouched: number;
	readonly aspectsTouched: number;
	readonly attributesTouched: number;
}

export interface PurgeObsidianSourceStructureInput {
	readonly agentId?: string;
	readonly sourceId: string;
	readonly root: string;
}

export interface PurgeObsidianSourceFileStructureInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly root: string;
	readonly filePath: string;
}

export interface PurgeObsidianSourceStructureResult {
	readonly entities: number;
	readonly attributes: number;
	readonly dependencies: number;
	readonly communities: number;
}

interface HeadingSection {
	readonly heading: string;
	readonly level: number;
	readonly body: string;
}

function normalizedRoot(root: string): string {
	return resolve(root).replace(/\\/g, "/").replace(/\/$/, "");
}

function normalizedPath(path: string): string {
	return resolve(path).replace(/\\/g, "/");
}

function relPath(root: string, path: string): string {
	return relative(root, path).replace(/\\/g, "/");
}

function canonicalSegment(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function sourceCanonical(sourceId: string, kind: "source" | "folder" | "document", rel: string): string {
	const suffix = canonicalSegment(rel);
	return suffix.length > 0 ? `obsidian:${sourceId}:${kind}:${suffix}` : `obsidian:${sourceId}:${kind}:/`;
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

function displayNameForFile(path: string): string {
	return basename(path, extname(path));
}

function folderDisplayName(rel: string, sourceName: string): string {
	return rel.length === 0 ? sourceName : rel;
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
		readonly sourceRoot: string;
		readonly sourcePath: string;
		readonly now: string;
	},
): { readonly id: string; readonly inserted: boolean } {
	// The legacy entities.name constraint is globally unique, so source-native
	// entities get stable, path-qualified display names. Navigation uses
	// canonical_name/source_path for exact vault fidelity.
	const uniqueName = `${input.name} — ${input.canonicalName} — ${input.agentId}`;
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
			OBSIDIAN_SOURCE_KIND,
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
		OBSIDIAN_SOURCE_KIND,
		input.sourcePath,
		input.sourceRoot,
	);
	return { id: input.id, inserted: true };
}

function upsertCommunity(
	db: WriteDb,
	input: {
		readonly id: string;
		readonly name: string;
		readonly agentId: string;
		readonly sourceId: string;
		readonly sourceRoot: string;
		readonly sourcePath: string;
		readonly now: string;
	},
): void {
	db.prepare(
		`INSERT INTO entity_communities
		 (id, agent_id, name, cohesion, member_count, created_at, updated_at, source_id, source_kind, source_path, source_root)
		 VALUES (?, ?, ?, 1.0, 0, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   name = excluded.name,
		   updated_at = excluded.updated_at,
		   source_id = excluded.source_id,
		   source_kind = excluded.source_kind,
		   source_path = excluded.source_path,
		   source_root = excluded.source_root`,
	).run(
		input.id,
		input.agentId,
		input.name,
		input.now,
		input.now,
		input.sourceId,
		OBSIDIAN_SOURCE_KIND,
		input.sourcePath,
		input.sourceRoot,
	);
}

function upsertDependency(
	db: WriteDb,
	input: {
		readonly sourceEntityId: string;
		readonly targetEntityId: string;
		readonly agentId: string;
		readonly type: string;
		readonly strength: number;
		readonly confidence: number;
		readonly reason: string;
		readonly sourceId: string;
		readonly sourceRoot: string;
		readonly sourcePath: string;
		readonly now: string;
	},
): boolean {
	const existing = db
		.prepare(
			`SELECT id FROM entity_dependencies
			 WHERE source_entity_id = ? AND target_entity_id = ? AND dependency_type = ? AND agent_id = ?
			 LIMIT 1`,
		)
		.get(input.sourceEntityId, input.targetEntityId, input.type, input.agentId) as { id: string } | undefined;
	if (existing) {
		db.prepare(
			`UPDATE entity_dependencies
			 SET strength = MAX(strength, ?), confidence = MAX(COALESCE(confidence, 0), ?),
			     reason = ?, updated_at = ?, source_id = ?, source_kind = ?, source_path = ?, source_root = ?
			 WHERE id = ?`,
		).run(
			input.strength,
			input.confidence,
			input.reason,
			input.now,
			input.sourceId,
			OBSIDIAN_SOURCE_KIND,
			input.sourcePath,
			input.sourceRoot,
			existing.id,
		);
		return false;
	}
	const id = idFor("dep", input.agentId, input.type, input.sourceEntityId, input.targetEntityId);
	db.prepare(
		`INSERT INTO entity_dependencies
		 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, reason,
		  created_at, updated_at, source_id, source_kind, source_path, source_root)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		input.sourceEntityId,
		input.targetEntityId,
		input.agentId,
		input.type,
		input.strength,
		input.confidence,
		input.reason,
		input.now,
		input.now,
		input.sourceId,
		OBSIDIAN_SOURCE_KIND,
		input.sourcePath,
		input.sourceRoot,
	);
	return true;
}

function parseMarkdownSections(content: string): HeadingSection[] {
	const lines = content.replace(/\r\n?/g, "\n").split("\n");
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

function stripFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---\n")) return normalized;
	const end = normalized.indexOf("\n---\n", 4);
	return end === -1 ? normalized : normalized.slice(end + 5);
}

function bodyClaims(body: string): string[] {
	return body
		.split(/\n{2,}|\n(?=-\s+)/)
		.map((part) => part.replace(/^[-*]\s+/gm, "").trim())
		.filter((part) => part.length >= 20)
		.slice(0, 12);
}

function wikiLinks(content: string): string[] {
	const links = new Set<string>();
	const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(content))) {
		const target = match[1]?.trim();
		if (target) links.add(target);
	}
	return [...links];
}

function findMarkdownByStem(root: string, target: string): string | null {
	const wanted = slug(target).replace(/_/g, "-");
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if ([".obsidian", ".trash", ".hermes"].includes(entry.name)) continue;
				stack.push(path);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				if (slug(basename(entry.name, ".md")).replace(/_/g, "-") === wanted) return path;
			}
		}
	}
	return null;
}

function folderRelatives(root: string, filePath: string): string[] {
	const relDir = dirname(relPath(root, filePath));
	if (relDir === "." || relDir === "") return [];
	const parts = relDir.split("/").filter(Boolean);
	return parts.map((_part, idx) => parts.slice(0, idx + 1).join("/"));
}

function purgeOrphanedDocumentReferences(db: WriteDb, agentId: string, sourceId: string, root: string): number {
	return db
		.prepare(
			`DELETE FROM entities
			 WHERE agent_id = ?
			   AND source_id = ?
			   AND source_root = ?
			   AND entity_type = 'source_document_reference'
			   AND NOT EXISTS (
			     SELECT 1 FROM entity_dependencies d
			     WHERE d.agent_id = entities.agent_id
			       AND (d.source_entity_id = entities.id OR d.target_entity_id = entities.id)
			   )`,
		)
		.run(agentId, sourceId, root).changes;
}

function purgeObsidianSourceFileStructureInTx(
	db: WriteDb,
	input: PurgeObsidianSourceFileStructureInput,
): PurgeObsidianSourceStructureResult {
	const root = normalizedRoot(input.root);
	const filePath = normalizedPath(input.filePath);
	const fileRel = relPath(root, filePath);
	const documentEntityId = idFor(input.agentId, input.sourceId, "document", fileRel);

	const attributes = db
		.prepare(
			`DELETE FROM entity_attributes
			 WHERE agent_id = ?
			   AND source_id = ?
			   AND source_root = ?
			   AND source_path = ?`,
		)
		.run(input.agentId, input.sourceId, root, filePath).changes;
	const aspects = db
		.prepare("DELETE FROM entity_aspects WHERE agent_id = ? AND entity_id = ?")
		.run(input.agentId, documentEntityId).changes;
	const dependencies = db
		.prepare(
			`DELETE FROM entity_dependencies
			 WHERE agent_id = ?
			   AND source_id = ?
			   AND source_root = ?
			   AND source_path = ?`,
		)
		.run(input.agentId, input.sourceId, root, filePath).changes;
	const entities =
		db
			.prepare(
				`DELETE FROM entities
				 WHERE agent_id = ?
				   AND source_id = ?
				   AND source_root = ?
				   AND source_path = ?
				   AND entity_type IN ('source_document', 'source_document_reference')`,
			)
			.run(input.agentId, input.sourceId, root, filePath).changes +
		purgeOrphanedDocumentReferences(db, input.agentId, input.sourceId, root);
	return { entities, attributes, dependencies, communities: aspects };
}

export function indexObsidianSourceStructure(
	input: IndexObsidianSourceStructureInput,
): IndexObsidianSourceStructureResult {
	const root = normalizedRoot(input.root);
	const filePath = normalizedPath(input.filePath);
	const fileRel = relPath(root, filePath);
	const now = new Date().toISOString();
	const content = stripFrontmatter(input.content);
	return getDbAccessor().withWriteTx((db) => {
		// A source file is authoritative: before rebuilding its projection,
		// remove the prior per-file headings/claims/links so deleted Markdown
		// structure does not linger as stale graph facts.
		purgeObsidianSourceFileStructureInTx(db, input);

		let folderEntitiesTouched = 0;
		let documentEntitiesTouched = 0;
		let communitiesTouched = 0;
		let dependenciesTouched = 0;
		let aspectsTouched = 0;
		let attributesTouched = 0;

		const rootEntity = upsertSourceEntity(db, {
			id: idFor(input.agentId, input.sourceId, "source", root),
			name: input.sourceName,
			canonicalName: sourceCanonical(input.sourceId, "source", "/"),
			entityType: "source",
			agentId: input.agentId,
			sourceId: input.sourceId,
			sourceRoot: root,
			sourcePath: root,
			now,
		});

		let parentEntityId = rootEntity.id;
		let parentCommunityId: string | null = null;
		for (const folderRel of folderRelatives(root, filePath)) {
			const folderPath = join(root, folderRel);
			const folderId = idFor(input.agentId, input.sourceId, "folder", folderRel);
			const communityId = idFor(input.agentId, input.sourceId, "community", folderRel);
			upsertCommunity(db, {
				id: communityId,
				name: folderDisplayName(folderRel, input.sourceName),
				agentId: input.agentId,
				sourceId: input.sourceId,
				sourceRoot: root,
				sourcePath: normalizedPath(folderPath),
				now,
			});
			communitiesTouched++;
			const folder = upsertSourceEntity(db, {
				id: folderId,
				name: folderDisplayName(folderRel, input.sourceName),
				canonicalName: sourceCanonical(input.sourceId, "folder", folderRel),
				entityType: "source_folder",
				agentId: input.agentId,
				sourceId: input.sourceId,
				sourceRoot: root,
				sourcePath: normalizedPath(folderPath),
				now,
			});
			folderEntitiesTouched++;
			db.prepare("UPDATE entities SET community_id = ? WHERE id = ?").run(communityId, folder.id);
			if (parentCommunityId)
				db.prepare("UPDATE entities SET community_id = ? WHERE id = ?").run(parentCommunityId, folder.id);
			if (
				upsertDependency(db, {
					sourceEntityId: parentEntityId,
					targetEntityId: folder.id,
					agentId: input.agentId,
					type: "contains",
					strength: 1,
					confidence: 1,
					reason: requireDependencyReason("related_to", `Obsidian filesystem parent contains ${folderRel}`),
					sourceId: input.sourceId,
					sourceRoot: root,
					sourcePath: filePath,
					now,
				})
			)
				dependenciesTouched++;
			parentEntityId = folder.id;
			parentCommunityId = communityId;
		}

		const doc = upsertSourceEntity(db, {
			id: idFor(input.agentId, input.sourceId, "document", fileRel),
			name: displayNameForFile(filePath),
			canonicalName: sourceCanonical(input.sourceId, "document", fileRel),
			entityType: "source_document",
			agentId: input.agentId,
			sourceId: input.sourceId,
			sourceRoot: root,
			sourcePath: filePath,
			now,
		});
		documentEntitiesTouched++;
		if (parentCommunityId)
			db.prepare("UPDATE entities SET community_id = ? WHERE id = ?").run(parentCommunityId, doc.id);
		if (
			upsertDependency(db, {
				sourceEntityId: parentEntityId,
				targetEntityId: doc.id,
				agentId: input.agentId,
				type: "contains",
				strength: 1,
				confidence: 1,
				reason: requireDependencyReason("related_to", `Obsidian filesystem parent contains ${fileRel}`),
				sourceId: input.sourceId,
				sourceRoot: root,
				sourcePath: filePath,
				now,
			})
		)
			dependenciesTouched++;

		for (const link of wikiLinks(content)) {
			const found = findMarkdownByStem(root, link);
			const targetRel = found ? relPath(root, normalizedPath(found)) : `${link}.md`;
			const targetPath = found ? normalizedPath(found) : join(root, targetRel);
			const target = upsertSourceEntity(db, {
				id: idFor(input.agentId, input.sourceId, "document", targetRel),
				name: displayNameForFile(targetPath),
				canonicalName: sourceCanonical(input.sourceId, "document", targetRel),
				entityType: found ? "source_document" : "source_document_reference",
				agentId: input.agentId,
				sourceId: input.sourceId,
				sourceRoot: root,
				sourcePath: normalizedPath(targetPath),
				now,
			});
			documentEntitiesTouched++;
			if (
				upsertDependency(db, {
					sourceEntityId: doc.id,
					targetEntityId: target.id,
					agentId: input.agentId,
					type: "wiki_link",
					strength: 0.9,
					confidence: found ? 1 : 0.7,
					reason: requireDependencyReason("related_to", `Obsidian wiki link [[${link}]] in ${fileRel}`),
					sourceId: input.sourceId,
					sourceRoot: root,
					sourcePath: filePath,
					now,
				})
			)
				dependenciesTouched++;
		}

		const folderGroup = slug(dirname(fileRel) === "." ? "root" : dirname(fileRel));
		for (const section of parseMarkdownSections(content)) {
			const aspectId = idFor(input.agentId, input.sourceId, "aspect", fileRel, section.heading);
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
				const claimKey = `${aspectCanon}_${claimIndex}`;
				const attrId = idFor(
					input.agentId,
					input.sourceId,
					"attribute",
					fileRel,
					section.heading,
					claimIndex.toString(),
				);
				db.prepare(
					`INSERT INTO entity_attributes
					 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, group_key, claim_key,
					  confidence, importance, status, created_at, updated_at, source_id, source_kind, source_path, source_root)
					 VALUES (?, ?, ?, NULL, 'claim', ?, ?, ?, ?, 0.85, 0.55, 'active', ?, ?, ?, ?, ?, ?)
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
					folderGroup,
					claimKey,
					now,
					now,
					input.sourceId,
					OBSIDIAN_SOURCE_KIND,
					filePath,
					root,
				);
				attributesTouched++;
				claimIndex++;
			}
		}

		db.prepare(
			`UPDATE entity_communities
			 SET member_count = (
			   SELECT COUNT(*) FROM entities e WHERE e.community_id = entity_communities.id
			 ), updated_at = ?
			 WHERE agent_id = ? AND source_id = ?`,
		).run(now, input.agentId, input.sourceId);

		return {
			documentEntityId: doc.id,
			folderEntitiesTouched,
			documentEntitiesTouched,
			communitiesTouched,
			dependenciesTouched,
			aspectsTouched,
			attributesTouched,
		};
	});
}

export function purgeObsidianSourceFileStructure(
	input: PurgeObsidianSourceFileStructureInput,
): PurgeObsidianSourceStructureResult {
	return getDbAccessor().withWriteTx((db) => purgeObsidianSourceFileStructureInTx(db, input));
}

export function purgeObsidianSourceStructure(
	input: PurgeObsidianSourceStructureInput,
): PurgeObsidianSourceStructureResult {
	const root = normalizedRoot(input.root);
	const agentWhere = input.agentId ? "agent_id = ? AND " : "";
	const params = input.agentId ? [input.agentId, input.sourceId, root] : [input.sourceId, root];
	return getDbAccessor().withWriteTx((db) => {
		const attrs = db
			.prepare(`DELETE FROM entity_attributes WHERE ${agentWhere}source_id = ? AND source_root = ?`)
			.run(...params).changes;
		const deps = db
			.prepare(`DELETE FROM entity_dependencies WHERE ${agentWhere}source_id = ? AND source_root = ?`)
			.run(...params).changes;
		const entities = db
			.prepare(`DELETE FROM entities WHERE ${agentWhere}source_id = ? AND source_root = ?`)
			.run(...params).changes;
		const communities = db
			.prepare(`DELETE FROM entity_communities WHERE ${agentWhere}source_id = ? AND source_root = ?`)
			.run(...params).changes;
		return { entities, attributes: attrs, dependencies: deps, communities };
	});
}

export function sourceIdForObsidianRoot(root: string): string {
	return `obsidian:${createHash("sha256").update(normalizedRoot(root)).digest("hex").slice(0, 16)}`;
}
