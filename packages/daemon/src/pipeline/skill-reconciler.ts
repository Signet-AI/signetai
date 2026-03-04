/**
 * Skill filesystem reconciler for procedural memory P1.
 *
 * Ensures the knowledge graph stays in sync with the skills directory:
 * - Startup backfill: creates graph nodes for installed skills missing from DB
 * - Periodic reconciler: same scan on configurable interval
 * - File watcher: low-latency reconciliation via chokidar
 * - Orphan cleanup: removes graph nodes when SKILL.md files are deleted
 *
 * Idempotent — matched by canonical name + frontmatter content hash.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { watch } from "chokidar";
import type { DbAccessor } from "../db-accessor.js";
import type { EmbeddingConfig, PipelineV2Config } from "../memory-config.js";
import type { LlmProvider } from "./provider.js";
import { parseSkillFile } from "./skill-frontmatter.js";
import { installSkillNode, uninstallSkillNode } from "./skill-graph.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconcilerDeps {
	readonly accessor: DbAccessor;
	readonly pipelineConfig: PipelineV2Config;
	readonly embeddingConfig: EmbeddingConfig;
	readonly fetchEmbedding: (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>;
	readonly getProvider: () => LlmProvider | null;
	readonly agentsDir: string;
}

export interface ReconcilerHandle {
	stop(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skillsDir(agentsDir: string): string {
	return join(agentsDir, "skills");
}

// ---------------------------------------------------------------------------
// Reconciliation logic
// ---------------------------------------------------------------------------

/**
 * Single reconciliation pass:
 * 1. Scan filesystem for installed skills
 * 2. For each skill with SKILL.md:
 *    - If entity missing → install
 *    - If entity exists but frontmatter changed → re-install
 * 3. For each skill_meta row with no matching file → uninstall
 */
export async function reconcileOnce(deps: ReconcilerDeps): Promise<{
	installed: number;
	updated: number;
	removed: number;
}> {
	const dir = skillsDir(deps.agentsDir);
	let installed = 0;
	let updated = 0;
	let removed = 0;

	if (!existsSync(dir)) {
		return { installed, updated, removed };
	}

	// 1. Scan filesystem
	const diskSkills = new Map<string, string>(); // name → SKILL.md path
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillMdPath = join(dir, entry.name, "SKILL.md");
		if (existsSync(skillMdPath)) {
			diskSkills.set(entry.name, skillMdPath);
		}
	}

	// 2. Check each disk skill against the graph
	for (const [name, mdPath] of diskSkills) {
		try {
			const content = readFileSync(mdPath, "utf-8");
			const parsed = parseSkillFile(content);
			if (!parsed) continue;

			const entityId = `skill:default:${name}`;
			const fingerprint = buildFrontmatterFingerprint(
				parsed.frontmatter.name,
				parsed.frontmatter.description,
				parsed.frontmatter.triggers,
			);

			// Check if entity already exists
			const existing = deps.accessor.withReadDb((db) =>
				db.prepare("SELECT id FROM entities WHERE id = ?")
					.get(entityId) as { id: string } | undefined,
			);

			if (!existing) {
				// Missing from graph — install
				await installSkillNode(
					{
						frontmatter: parsed.frontmatter,
						body: parsed.body,
						source: "reconciler",
						fsPath: mdPath,
					},
					deps.accessor,
					deps.pipelineConfig,
					deps.embeddingConfig,
					deps.fetchEmbedding,
					deps.getProvider(),
				);
				installed++;
				logger.info("reconciler", "Backfilled skill node", { skill: name });
			} else {
				// Entity exists — check if frontmatter changed
				const storedEmb = deps.accessor.withReadDb((db) =>
					db.prepare(
						"SELECT chunk_text FROM embeddings WHERE source_type = 'skill' AND source_id = ?",
					).get(entityId) as { chunk_text: string } | undefined,
				);

				// Compare fingerprints: if the embedding text would be different,
				// the skill has been updated on disk
				const currentEmbText = [
					parsed.frontmatter.name,
					parsed.frontmatter.description,
					...(parsed.frontmatter.triggers && parsed.frontmatter.triggers.length > 0
						? [parsed.frontmatter.triggers.join(", ")]
						: []),
				].join(" — ");

				if (storedEmb && storedEmb.chunk_text !== currentEmbText) {
					await installSkillNode(
						{
							frontmatter: parsed.frontmatter,
							body: parsed.body,
							source: "reconciler",
							fsPath: mdPath,
						},
						deps.accessor,
						deps.pipelineConfig,
						deps.embeddingConfig,
						deps.fetchEmbedding,
						deps.getProvider(),
					);
					updated++;
					logger.info("reconciler", "Updated changed skill node", { skill: name });
				}
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			logger.warn("reconciler", "Failed to reconcile skill", {
				skill: name,
				error: msg,
			});
		}
	}

	// 3. Check for orphaned graph nodes (file removed from disk)
	const graphSkills = deps.accessor.withReadDb((db) =>
		db.prepare(
			"SELECT entity_id, fs_path FROM skill_meta WHERE agent_id = 'default' AND uninstalled_at IS NULL",
		).all() as Array<{ entity_id: string; fs_path: string }>,
	);

	for (const row of graphSkills) {
		if (!existsSync(row.fs_path)) {
			// Extract skill name from entity_id: "skill:default:{name}"
			const parts = row.entity_id.split(":");
			const skillName = parts.slice(2).join(":");
			if (skillName) {
				uninstallSkillNode({ skillName }, deps.accessor);
				removed++;
				logger.info("reconciler", "Removed orphaned skill node", {
					skill: skillName,
					entityId: row.entity_id,
				});
			}
		}
	}

	if (installed > 0 || updated > 0 || removed > 0) {
		logger.info("reconciler", "Reconciliation complete", {
			installed,
			updated,
			removed,
		});
	}

	return { installed, updated, removed };
}

// ---------------------------------------------------------------------------
// Reconciler lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the skill reconciler:
 * 1. Run an immediate backfill pass
 * 2. Set up periodic reconciliation on interval
 * 3. Watch the skills directory for file changes
 */
export function startReconciler(deps: ReconcilerDeps): ReconcilerHandle {
	const intervalMs = deps.pipelineConfig.procedural.reconcileIntervalMs;
	const dir = skillsDir(deps.agentsDir);

	// Immediate backfill (async, doesn't block startup)
	reconcileOnce(deps).catch((e) => {
		logger.error("reconciler", "Startup backfill failed", e instanceof Error ? e : undefined, {
			error: String(e),
		});
	});

	// Periodic reconciliation
	const timer = setInterval(() => {
		reconcileOnce(deps).catch((e) => {
			logger.error("reconciler", "Periodic reconciliation failed", e instanceof Error ? e : undefined, {
				error: String(e),
			});
		});
	}, intervalMs);

	// File watcher for low-latency reconciliation
	let watcher: ReturnType<typeof watch> | null = null;

	if (existsSync(dir)) {
		watcher = watch(join(dir, "*", "SKILL.md"), {
			ignoreInitial: true,
			awaitWriteFinish: { stabilityThreshold: 500 },
		});

		watcher.on("add", (filePath) => {
			const skillName = basename(dirname(filePath));
			logger.info("reconciler", "SKILL.md added", { skill: skillName });
			reconcileSkill(skillName, filePath, deps);
		});

		watcher.on("change", (filePath) => {
			const skillName = basename(dirname(filePath));
			logger.info("reconciler", "SKILL.md changed", { skill: skillName });
			reconcileSkill(skillName, filePath, deps);
		});

		watcher.on("unlink", (filePath) => {
			const skillName = basename(dirname(filePath));
			logger.info("reconciler", "SKILL.md removed", { skill: skillName });
			uninstallSkillNode({ skillName }, deps.accessor);
		});
	}

	logger.info("reconciler", "Skill reconciler started", {
		intervalMs,
		skillsDir: dir,
		watcherActive: watcher !== null,
	});

	return {
		stop() {
			clearInterval(timer);
			if (watcher) {
				watcher.close();
				watcher = null;
			}
			logger.info("reconciler", "Skill reconciler stopped");
		},
	};
}

/**
 * Reconcile a single skill by name (triggered by file watcher).
 */
async function reconcileSkill(
	skillName: string,
	mdPath: string,
	deps: ReconcilerDeps,
): Promise<void> {
	try {
		if (!existsSync(mdPath)) {
			uninstallSkillNode({ skillName }, deps.accessor);
			return;
		}

		const content = readFileSync(mdPath, "utf-8");
		const parsed = parseSkillFile(content);
		if (!parsed) return;

		// Skip if frontmatter hasn't changed (avoid redundant embedding work)
		const entityId = `skill:default:${skillName}`;
		const currentEmbText = [
			parsed.frontmatter.name,
			parsed.frontmatter.description,
			...(parsed.frontmatter.triggers && parsed.frontmatter.triggers.length > 0
				? [parsed.frontmatter.triggers.join(", ")]
				: []),
		].join(" — ");

		const storedEmb = deps.accessor.withReadDb((db) =>
			db.prepare(
				"SELECT chunk_text FROM embeddings WHERE source_type = 'skill' AND source_id = ?",
			).get(entityId) as { chunk_text: string } | undefined,
		);

		if (storedEmb && storedEmb.chunk_text === currentEmbText) {
			logger.debug("reconciler", "Skill unchanged, skipping", { skill: skillName });
			return;
		}

		await installSkillNode(
			{
				frontmatter: parsed.frontmatter,
				body: parsed.body,
				source: "reconciler",
				fsPath: mdPath,
			},
			deps.accessor,
			deps.pipelineConfig,
			deps.embeddingConfig,
			deps.fetchEmbedding,
			deps.getProvider(),
		);

		logger.debug("reconciler", "Skill reconciled via watcher", { skill: skillName });
	} catch (e) {
		logger.warn("reconciler", "Watcher reconciliation failed", {
			skill: skillName,
			error: e instanceof Error ? e.message : String(e),
		});
	}
}
