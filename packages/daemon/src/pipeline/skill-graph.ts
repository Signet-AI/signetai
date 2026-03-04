/**
 * Skill graph operations for procedural memory P1.
 *
 * Handles creating and removing skill nodes in the knowledge graph
 * when skills are installed or uninstalled. Each skill gets:
 * - An entity row (entity_type = 'skill')
 * - A skill_meta row with installation metadata
 * - An embedding from enriched frontmatter
 * - Entity extraction from the SKILL.md body
 */

import type { DbAccessor, WriteDb } from "../db-accessor";
import type { EmbeddingConfig, PipelineV2Config } from "../memory-config";
import type { LlmProvider } from "./provider";
import { enrichSkillFrontmatter } from "./skill-enrichment";
import { extractFactsAndEntities } from "./extraction";
import { txPersistEntities } from "./graph-transactions";
import { vectorToBlob, syncVecInsert, syncVecDeleteByEmbeddingIds } from "../db-helpers";
import { logger } from "../logger";

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
	readonly enriched: boolean;
	readonly embeddingCreated: boolean;
	readonly entitiesExtracted: number;
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

function contentHash(text: string): string {
	const h = new Bun.CryptoHasher("sha256");
	h.update(text);
	return h.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Install: create entity + skill_meta + embedding + extraction
// ---------------------------------------------------------------------------

export async function installSkillNode(
	input: SkillInstallInput,
	accessor: DbAccessor,
	config: PipelineV2Config,
	embeddingCfg: EmbeddingConfig,
	fetchEmbedding: (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>,
	provider: LlmProvider | null,
): Promise<SkillInstallResult> {
	const agentId = input.agentId ?? "default";
	const entityId = skillEntityId(agentId, input.frontmatter.name);
	const now = new Date().toISOString();
	const procCfg = config.procedural;

	let fm = input.frontmatter;
	let enriched = false;

	// Step 1: Enrich if needed
	const needsEnrichment =
		fm.description.length < procCfg.enrichMinDescription ||
		!fm.triggers || fm.triggers.length === 0;

	if (procCfg.enrichOnInstall && needsEnrichment && provider === null) {
		logger.warn("pipeline", "Skill enrichment skipped — LLM provider not available", {
			skill: fm.name,
			descriptionLength: fm.description.length,
			hasTriggers: Boolean(fm.triggers && fm.triggers.length > 0),
		});
	}

	if (procCfg.enrichOnInstall && needsEnrichment && provider !== null) {
		const enrichResult = await enrichSkillFrontmatter(
			{ name: fm.name, description: fm.description, body: input.body },
			provider,
		);
		if (enrichResult) {
			fm = {
				...fm,
				description: enrichResult.description || fm.description,
				triggers: enrichResult.triggers.length > 0
					? enrichResult.triggers
					: fm.triggers,
				tags: enrichResult.tags.length > 0
					? enrichResult.tags
					: fm.tags,
			};
			enriched = true;
		}
	}

	// Step 2: Create entity + skill_meta in a write transaction
	accessor.withWriteTx((db) => {
		// Check if entity already exists (idempotent)
		const existing = db.prepare(
			"SELECT id FROM entities WHERE id = ?",
		).get(entityId) as { id: string } | undefined;

		if (existing) {
			// Update existing entity
			db.prepare(
				`UPDATE entities SET description = ?, updated_at = ? WHERE id = ?`,
			).run(fm.description, now, entityId);

			// Update skill_meta
			db.prepare(
				`UPDATE skill_meta SET
					version = ?, author = ?, license = ?, source = ?,
					role = ?, triggers = ?, tags = ?, permissions = ?,
					enriched = ?, fs_path = ?, uninstalled_at = NULL,
					updated_at = ?
				 WHERE entity_id = ?`,
			).run(
				fm.version ?? null,
				fm.author ?? null,
				fm.license ?? null,
				input.source,
				fm.role ?? "utility",
				fm.triggers ? JSON.stringify(fm.triggers) : null,
				fm.tags ? JSON.stringify(fm.tags) : null,
				fm.permissions ? JSON.stringify(fm.permissions) : null,
				enriched ? 1 : 0,
				input.fsPath,
				now,
				entityId,
			);
		} else {
			// Insert new entity
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, description, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, 'skill', ?, 0, ?, ?)`,
			).run(entityId, fm.name, fm.name.toLowerCase(), fm.description, now, now);

			// Insert skill_meta
			db.prepare(
				`INSERT INTO skill_meta
				 (entity_id, agent_id, version, author, license, source,
				  role, triggers, tags, permissions, enriched,
				  installed_at, importance, decay_rate, fs_path)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				enriched ? 1 : 0,
				now,
				procCfg.importanceOnInstall,
				procCfg.decayRate,
				input.fsPath,
			);
		}
	});

	// Step 3: Generate embedding from enriched frontmatter
	let embeddingCreated = false;
	const embeddingText = buildEmbeddingText(fm);
	const embVec = await fetchEmbedding(embeddingText, embeddingCfg);

	if (embVec && embVec.length > 0) {
		const embId = crypto.randomUUID();
		const hash = contentHash(embeddingText);
		const blob = vectorToBlob(embVec);

		accessor.withWriteTx((db) => {
			// Remove any old skill embeddings
			const oldEmbs = db.prepare(
				`SELECT id FROM embeddings WHERE source_type = 'skill' AND source_id = ?`,
			).all(entityId) as Array<{ id: string }>;

			if (oldEmbs.length > 0) {
				syncVecDeleteByEmbeddingIds(db, oldEmbs.map((e) => e.id));
				db.prepare(
					`DELETE FROM embeddings WHERE source_type = 'skill' AND source_id = ?`,
				).run(entityId);
			}

			// Insert new embedding
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
				 VALUES (?, ?, ?, ?, 'skill', ?, ?, ?)
				 ON CONFLICT(content_hash) DO UPDATE SET
				   vector = excluded.vector,
				   dimensions = excluded.dimensions,
				   source_id = excluded.source_id,
				   chunk_text = excluded.chunk_text`,
			).run(embId, hash, blob, embVec.length, entityId, embeddingText, now);

			syncVecInsert(db, embId, embVec);
		});

		embeddingCreated = true;
	}

	// Step 4: Extract entities from SKILL.md body for graph relations
	let entitiesExtracted = 0;
	if (config.graph.enabled && provider !== null && input.body.trim().length >= 20) {
		try {
			const extraction = await extractFactsAndEntities(input.body, provider);
			if (extraction.entities.length > 0) {
				accessor.withWriteTx((db) => {
					const result = txPersistEntities(db, {
						entities: extraction.entities,
						sourceMemoryId: entityId,
						extractedAt: now,
					});
					entitiesExtracted = result.entitiesInserted + result.entitiesUpdated;
				});
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			logger.warn("pipeline", "Skill body extraction failed", {
				skill: fm.name,
				error: msg,
			});
		}
	}

	logger.info("pipeline", "Skill node installed", {
		skill: fm.name,
		entityId,
		enriched,
		embeddingCreated,
		entitiesExtracted,
	});

	return { entityId, enriched, embeddingCreated, entitiesExtracted };
}

// ---------------------------------------------------------------------------
// Uninstall: remove entity + skill_meta + embeddings + relations
// ---------------------------------------------------------------------------

export function uninstallSkillNode(
	input: SkillUninstallInput,
	accessor: DbAccessor,
): SkillUninstallResult {
	const agentId = input.agentId ?? "default";
	const entityId = skillEntityId(agentId, input.skillName);

	const exists = accessor.withReadDb((db) =>
		db.prepare("SELECT id FROM entities WHERE id = ?")
			.get(entityId) as { id: string } | undefined,
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
		db.prepare(
			`DELETE FROM memory_entity_mentions WHERE entity_id = ?`,
		).run(entityId);

		// 3. Remove embeddings + vec sync
		const embRows = db.prepare(
			`SELECT id FROM embeddings WHERE source_type = 'skill' AND source_id = ?`,
		).all(entityId) as Array<{ id: string }>;

		if (embRows.length > 0) {
			syncVecDeleteByEmbeddingIds(db, embRows.map((e) => e.id));
			db.prepare(
				`DELETE FROM embeddings WHERE source_type = 'skill' AND source_id = ?`,
			).run(entityId);
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
