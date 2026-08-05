/**
 * Skill graph operations for procedural memory P1.
 *
 * Handles creating and removing skill nodes in the knowledge graph
 * when skills are installed or uninstalled. Each skill gets:
 * - An entity row (entity_type = 'skill') — source/native topology
 * - A skill_meta row with installation metadata
 * - An embedding from the authored frontmatter
 *
 * Skill nodes are source topology: the SKILL.md frontmatter is the
 * authoritative source, and this module writes the skill entity and its
 * metadata directly. It does NOT perform LLM-driven semantic extraction
 * from the SKILL.md body — semantic entity writes are owned by the
 * audited Dreaming apply path, so cross-skill relations are never
 * authored here (see #946 semantic-writer cutover).
 */

import { createHash } from "node:crypto";
import type { DbAccessor } from "../db-accessor";
import { syncVecDeleteByEmbeddingIds, syncVecInsert, vectorToBlob } from "../db-helpers";
import { isActiveEmbeddingConfig, resolveActiveEmbeddingConfig } from "../embedding-index-state";
import { logger } from "../logger";
import type { EmbeddingConfig, PipelineV2Config } from "../memory-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillFrontmatter {
	readonly name: string;
	readonly description: string;
	readonly version?: string;
	readonly author?: string;
	readonly license?: string;
	readonly triggers?: readonly string[];
	readonly tags?: readonly string[];
	readonly permissions?: readonly string[];
	readonly role?: string;
}

export interface SkillInstallInput {
	readonly frontmatter: SkillFrontmatter;
	readonly body: string;
	readonly source: string;
	readonly fsPath: string;
	readonly agentId?: string;
}

export interface SkillInstallResult {
	readonly entityId: string;
	readonly embeddingCreated: boolean;
}

export interface SkillUninstallInput {
	readonly skillName: string;
	readonly agentId?: string;
}

export interface SkillUninstallResult {
	readonly removed: boolean;
	readonly entityId: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skillEntityId(agentId: string, name: string): string {
	return `skill:${agentId}:${name}`;
}

function buildEmbeddingText(fm: SkillFrontmatter): string {
	const parts = [fm.name];
	if (fm.description) parts.push(fm.description);
	if (fm.triggers && fm.triggers.length > 0) {
		parts.push(fm.triggers.join(", "));
	}
	return parts.join(" — ");
}

function normalizeList(values: readonly string[] | undefined): readonly string[] {
	if (!values || values.length === 0) return [];
	return [...values];
}

export function skillFingerprint(fm: SkillFrontmatter): string {
	return JSON.stringify({
		name: fm.name,
		description: fm.description,
		version: fm.version ?? null,
		author: fm.author ?? null,
		license: fm.license ?? null,
		triggers: normalizeList(fm.triggers),
		tags: normalizeList(fm.tags),
		permissions: normalizeList(fm.permissions),
		role: fm.role ?? null,
	});
}

export function skillFingerprintHash(fm: SkillFrontmatter): string {
	return contentHash(skillFingerprint(fm));
}

export function skillEmbeddingHash(entityId: string, fm: SkillFrontmatter): string {
	return contentHash(`${entityId}\n${skillFingerprint(fm)}`);
}

function contentHash(text: string): string {
	const h = createHash("sha256");
	h.update(text);
	return h.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Install: create entity + skill_meta + embedding
// ---------------------------------------------------------------------------

export async function installSkillNode(
	input: SkillInstallInput,
	accessor: DbAccessor,
	config: PipelineV2Config,
	embeddingCfg: EmbeddingConfig,
	fetchEmbedding: (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>,
): Promise<SkillInstallResult> {
	const agentId = input.agentId ?? "default";
	let entityId = skillEntityId(agentId, input.frontmatter.name);
	const now = new Date().toISOString();
	const procCfg = config.procedural;

	const fm = input.frontmatter;

	// Step 1: Create entity + skill_meta in a write transaction
	accessor.withWriteTx((db) => {
		// Check if entity already exists by id or name (idempotent)
		const existing = db
			.prepare("SELECT id FROM entities WHERE id = ? OR (name = ? AND agent_id = ?)")
			.get(entityId, fm.name, agentId) as { id: string } | undefined;

		if (existing) {
			// If matched by name (collision), adopt that entity's id
			if (existing.id !== entityId) {
				entityId = existing.id;
			}
			// Update existing entity
			db.prepare(`UPDATE entities SET entity_type = 'skill', description = ?, updated_at = ? WHERE id = ?`).run(
				fm.description,
				now,
				entityId,
			);

			// Upsert skill_meta (may not exist if entity was from extraction)
			db.prepare(
				`INSERT INTO skill_meta
				 (entity_id, agent_id, version, author, license, source,
				  role, triggers, tags, permissions, enriched,
				  installed_at, importance, decay_rate, fs_path)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(entity_id) DO UPDATE SET
					version = excluded.version, author = excluded.author,
					license = excluded.license, source = excluded.source,
					role = excluded.role, triggers = excluded.triggers,
					tags = excluded.tags, permissions = excluded.permissions,
					enriched = excluded.enriched, fs_path = excluded.fs_path,
					uninstalled_at = NULL, updated_at = ?`,
			).run(
				entityId,
				agentId,
				fm.version ?? null,
				fm.author ?? null,
				fm.license ?? null,
				input.source,
				fm.role ?? "utility",
				fm.triggers ? JSON.stringify(fm.triggers) : null,
				fm.tags ? JSON.stringify(fm.tags) : null,
				fm.permissions ? JSON.stringify(fm.permissions) : null,
				0,
				now,
				procCfg.importanceOnInstall,
				procCfg.decayRate,
				input.fsPath,
				now,
			);
		} else {
			// Insert new entity (catch name UNIQUE collision from extraction pipeline)
			try {
				db.prepare(
					`INSERT INTO entities
					 (id, name, canonical_name, entity_type, agent_id, description, mentions, created_at, updated_at)
					 VALUES (?, ?, ?, 'skill', ?, ?, 0, ?, ?)`,
				).run(entityId, fm.name, fm.name.toLowerCase(), agentId, fm.description, now, now);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (!msg.includes("UNIQUE constraint")) throw e;

				// Name collision — an extracted entity already owns this name.
				// Claim it as a skill entity and reuse its id.
				const collision = db
					.prepare("SELECT id FROM entities WHERE name = ? AND agent_id = ? LIMIT 1")
					.get(fm.name, agentId) as { id: string } | undefined;

				if (!collision) throw e;

				db.prepare(`UPDATE entities SET entity_type = 'skill', description = ?, updated_at = ? WHERE id = ?`).run(
					fm.description,
					now,
					collision.id,
				);
				entityId = collision.id;
			}

			// Upsert skill_meta. Reconciler startup, periodic passes, and watcher
			// can overlap; avoid UNIQUE(entity_id) races under concurrent installs.
			db.prepare(
				`INSERT INTO skill_meta
				 (entity_id, agent_id, version, author, license, source,
				  role, triggers, tags, permissions, enriched,
				  installed_at, importance, decay_rate, fs_path)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(entity_id) DO UPDATE SET
					version = excluded.version, author = excluded.author,
					license = excluded.license, source = excluded.source,
					role = excluded.role, triggers = excluded.triggers,
					tags = excluded.tags, permissions = excluded.permissions,
					enriched = excluded.enriched, fs_path = excluded.fs_path,
					uninstalled_at = NULL, updated_at = ?`,
			).run(
				entityId,
				agentId,
				fm.version ?? null,
				fm.author ?? null,
				fm.license ?? null,
				input.source,
				fm.role ?? "utility",
				fm.triggers ? JSON.stringify(fm.triggers) : null,
				fm.tags ? JSON.stringify(fm.tags) : null,
				fm.permissions ? JSON.stringify(fm.permissions) : null,
				0,
				now,
				procCfg.importanceOnInstall,
				procCfg.decayRate,
				input.fsPath,
				now,
			);
		}
	});

	// Step 2: Generate embedding from the authored frontmatter
	let embeddingCreated = false;
	const embeddingText = buildEmbeddingText(fm);
	const writeConfig = accessor.withReadDb((db) => resolveActiveEmbeddingConfig(db, embeddingCfg));
	const embVec = await fetchEmbedding(embeddingText, writeConfig);

	if (embVec && embVec.length > 0) {
		const embId = crypto.randomUUID();
		const blob = vectorToBlob(embVec);
		const embHash = skillEmbeddingHash(entityId, input.frontmatter);

		embeddingCreated = accessor.withWriteTx((db) => {
			if (!isActiveEmbeddingConfig(db, writeConfig)) return false;
			// Remove any old skill embeddings
			const oldEmbs = db
				.prepare(`SELECT id FROM embeddings WHERE source_type = 'skill' AND source_id = ?`)
				.all(entityId) as Array<{ id: string }>;

			if (oldEmbs.length > 0) {
				syncVecDeleteByEmbeddingIds(
					db,
					oldEmbs.map((e) => e.id),
				);
				db.prepare(`DELETE FROM embeddings WHERE source_type = 'skill' AND source_id = ?`).run(entityId);
			}

			// Insert new embedding (ON CONFLICT may keep the existing row id)
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
				 VALUES (?, ?, ?, ?, 'skill', ?, ?, ?)
				 ON CONFLICT(content_hash) DO UPDATE SET
				   vector = excluded.vector,
				   dimensions = excluded.dimensions,
				   source_id = excluded.source_id,
				   chunk_text = excluded.chunk_text`,
			).run(embId, embHash, blob, embVec.length, entityId, embeddingText, now);

			// Query back the actual row id — on conflict SQLite keeps the
			// existing id, not the one we generated above.
			const actualRow = db.prepare("SELECT id FROM embeddings WHERE content_hash = ?").get(embHash) as { id: string };
			syncVecInsert(db, actualRow.id, embVec);
			return true;
		});
	}

	logger.info("pipeline", "Skill node installed", {
		skill: fm.name,
		entityId,
		embeddingCreated,
	});

	return { entityId, embeddingCreated };
}

// ---------------------------------------------------------------------------
// Uninstall: remove entity + skill_meta + embeddings + relations
// ---------------------------------------------------------------------------

export function uninstallSkillNode(input: SkillUninstallInput, accessor: DbAccessor): SkillUninstallResult {
	const agentId = input.agentId ?? "default";
	const entityId = skillEntityId(agentId, input.skillName);

	const exists = accessor.withReadDb(
		(db) => db.prepare("SELECT id FROM entities WHERE id = ?").get(entityId) as { id: string } | undefined,
	);

	if (!exists) {
		return { removed: false, entityId: null };
	}

	accessor.withWriteTx((db) => {
		// 1. Remove skill relation edges
		db.prepare(
			`DELETE FROM relations
			 WHERE source_entity_id = ? OR target_entity_id = ?`,
		).run(entityId, entityId);

		// 2. Remove skill mention links
		db.prepare("DELETE FROM memory_entity_mentions WHERE entity_id = ?").run(entityId);

		// 3. Remove embeddings + vec sync
		const embRows = db
			.prepare(`SELECT id FROM embeddings WHERE source_type = 'skill' AND source_id = ?`)
			.all(entityId) as Array<{ id: string }>;

		if (embRows.length > 0) {
			syncVecDeleteByEmbeddingIds(
				db,
				embRows.map((e) => e.id),
			);
			db.prepare(`DELETE FROM embeddings WHERE source_type = 'skill' AND source_id = ?`).run(entityId);
		}

		// 4. Hard-delete skill_meta + entity in same transaction
		db.prepare("DELETE FROM skill_meta WHERE entity_id = ?").run(entityId);
		db.prepare("DELETE FROM entities WHERE id = ?").run(entityId);
	});

	logger.info("pipeline", "Skill node uninstalled", {
		skill: input.skillName,
		entityId,
	});

	return { removed: true, entityId };
}
