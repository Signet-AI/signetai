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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { watch } from "chokidar";
import type { DbAccessor } from "../db-accessor.js";
import { logger } from "../logger.js";
import type { EmbeddingConfig, PipelineV2Config } from "../memory-config.js";
import { parseSkillFile } from "./skill-frontmatter.js";
import { installSkillNode, skillEmbeddingHash, uninstallSkillNode } from "./skill-graph.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconcilerDeps {
	readonly accessor: DbAccessor;
	readonly pipelineConfig: PipelineV2Config;
	readonly embeddingConfig: EmbeddingConfig;
	readonly fetchEmbedding: (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>;
	readonly agentsDir: string;
}

export interface ReconcilerHandle {
	stop(): void;
}

export interface ReconcileOptions {
	readonly scanFilesystem?: boolean;
}

export type ReconcileSkillResult = "installed" | "updated" | "unchanged" | "removed" | "skipped" | "failed";

// Every trigger that can reconcile a skill uses this queue. The lock is keyed
// by workspace and skill so a startup/periodic scan, watcher event, and
// post-install hook cannot observe the same stale embedding concurrently.
const skillReconcileFlights = new Map<string, Promise<unknown>>();

export function withSkillReconciliationLock<T>(
	agentsDir: string,
	skillName: string,
	fn: () => Promise<T> | T,
): Promise<T> {
	const key = `${agentsDir}\u0000${skillName}`;
	const previous = skillReconcileFlights.get(key) ?? Promise.resolve();
	const next = previous.then(fn, fn).finally(() => {
		if (skillReconcileFlights.get(key) === next) {
			skillReconcileFlights.delete(key);
		}
	});
	skillReconcileFlights.set(key, next);
	return next;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skillsDir(agentsDir: string): string {
	return join(agentsDir, "skills");
}

// ---------------------------------------------------------------------------
// Per-skill failure backoff
// ---------------------------------------------------------------------------

/**
 * A skill whose reconcile fails deterministically (schema conflict, provider
 * outage, unreadable file) must not re-run the full install pipeline every
 * interval: each attempt re-reads the file, rewrites the graph, and can
 * saturate the daemon event loop (Signet-AI/signetai#1086). After
 * SKILL_BACKOFF_FAILURES consecutive failures the skill is skipped until its
 * backoff window elapses; the window doubles per subsequent failure up to
 * SKILL_BACKOFF_MAX_MS. Any pass that completes without throwing clears the
 * state, as does a watcher event (new content is a fresh signal).
 */
const SKILL_BACKOFF_BASE_MS = 10_000;
const SKILL_BACKOFF_MAX_MS = 10 * 60_000;
const SKILL_BACKOFF_FAILURES = 3;

const skillFailureState = new Map<string, { consecutiveFailures: number; nextAttemptAt: number }>();

/** Backoff delay after `consecutiveFailures` failures (0 until the threshold). */
export function skillBackoffDelayMs(
	consecutiveFailures: number,
	baseMs: number = SKILL_BACKOFF_BASE_MS,
	maxMs: number = SKILL_BACKOFF_MAX_MS,
): number {
	if (consecutiveFailures <= SKILL_BACKOFF_FAILURES) return 0;
	const delay = baseMs * 2 ** (consecutiveFailures - SKILL_BACKOFF_FAILURES - 1);
	return Math.min(delay, maxMs);
}

/** Clear a skill's failure state after a successful pass or watcher event. */
export function resetSkillFailureState(skillName: string): void {
	skillFailureState.delete(skillName);
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
export async function reconcileOnce(
	deps: ReconcilerDeps,
	options: ReconcileOptions = {},
): Promise<{
	installed: number;
	updated: number;
	removed: number;
}> {
	const dir = skillsDir(deps.agentsDir);
	let installed = 0;
	let updated = 0;
	let removed = 0;

	// 1. Scan filesystem
	const diskSkills = new Map<string, string>(); // name → SKILL.md path
	if (options.scanFilesystem !== false && existsSync(dir)) {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const skillMdPath = join(dir, entry.name, "SKILL.md");
			if (existsSync(skillMdPath)) {
				diskSkills.set(entry.name, skillMdPath);
			}
		}
	}

	// 2. Check each disk skill against the graph. The per-skill helper is
	// shared with watcher and explicit post-install triggers, so all callers
	// re-check the embedding state after acquiring the same single-flight lock.
	for (const [name, mdPath] of diskSkills) {
		const result = await reconcileSkillFile(name, mdPath, deps);
		if (result === "installed") {
			installed++;
			logger.info("reconciler", "Backfilled skill node", { skill: name });
		} else if (result === "updated") {
			updated++;
			logger.info("reconciler", "Updated changed skill node", { skill: name });
		}
	}

	// 3. Check for orphaned graph nodes (file removed from disk)
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	const graphSkills = deps.accessor.withReadDb(
		(db: import("../db-accessor").ReadDb) =>
			db
				.prepare("SELECT entity_id, fs_path FROM skill_meta WHERE agent_id = 'default' AND uninstalled_at IS NULL")
				.all() as Array<{ entity_id: string; fs_path: string }>,
	);

	for (const row of graphSkills) {
		if (!existsSync(row.fs_path)) {
			// Prefer the namespace id, but retain the filesystem name for legacy
			// rows whose entity_id does not use the skill namespace.
			const parts = row.entity_id.split(":");
			const skillName = parts[0] === "skill" ? parts.slice(2).join(":") : basename(dirname(row.fs_path));
			if (skillName) {
				const result = await withSkillReconciliationLock(deps.agentsDir, skillName, () =>
					uninstallSkillNode({ skillName, entityId: row.entity_id }, deps.accessor),
				);
				if (!result.removed) continue;

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

export interface ReconcileSkillFileOptions {
	readonly forceInstall?: boolean;
	readonly source?: string;
}

/**
 * Reconcile one skill through the shared per-skill flight. The state check is
 * deliberately inside the lock: a queued trigger must observe the embedding
 * written by the first trigger instead of issuing a duplicate provider call.
 */
export async function reconcileSkillFile(
	skillName: string,
	mdPath: string,
	deps: ReconcilerDeps,
	options: ReconcileSkillFileOptions = {},
): Promise<ReconcileSkillResult> {
	return withSkillReconciliationLock(deps.agentsDir, skillName, async () => {
		// A watcher or explicit install is a fresh signal. Reset only after
		// entering the flight so an older in-flight failure cannot overwrite
		// this reset before the queued trigger starts.
		if (options.forceInstall) resetSkillFailureState(skillName);
		const failureState = skillFailureState.get(skillName);
		if (failureState && failureState.nextAttemptAt > Date.now()) {
			return "skipped";
		}

		try {
			if (!existsSync(mdPath)) {
				const result = uninstallSkillNode({ skillName }, deps.accessor);
				resetSkillFailureState(skillName);
				return result.removed ? "removed" : "unchanged";
			}

			const content = readFileSync(mdPath, "utf-8");
			const parsed = parseSkillFile(content);
			if (!parsed) return "skipped";

			const entityId = `skill:default:${skillName}`;
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
			const existing = deps.accessor.withReadDb(
				(db: import("../db-accessor").ReadDb) =>
					db
						.prepare("SELECT id FROM entities WHERE id = ? OR (name = ? AND agent_id = 'default')")
						.get(entityId, skillName) as { id: string } | undefined,
			);
			const actualId = existing?.id ?? entityId;
			const rawHash = skillEmbeddingHash(actualId, parsed.frontmatter);
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
			const storedEmb = deps.accessor.withReadDb(
				(db: import("../db-accessor").ReadDb) =>
					db
						.prepare("SELECT content_hash FROM embeddings WHERE source_type = 'skill' AND source_id = ?")
						.get(actualId) as { content_hash: string } | undefined,
			);

			const shouldInstall =
				!existing ||
				(Boolean(storedEmb) && storedEmb?.content_hash !== rawHash) ||
				(Boolean(options.forceInstall) && !storedEmb);
			if (!shouldInstall) {
				resetSkillFailureState(skillName);
				logger.debug("reconciler", "Skill unchanged, skipping", { skill: skillName });
				return "unchanged";
			}

			await installSkillNode(
				{
					frontmatter: parsed.frontmatter,
					body: parsed.body,
					source: options.source ?? "reconciler",
					fsPath: mdPath,
				},
				deps.accessor,
				deps.pipelineConfig,
				deps.embeddingConfig,
				deps.fetchEmbedding,
			);
			resetSkillFailureState(skillName);
			return existing ? "updated" : "installed";
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			logger.warn("reconciler", "Failed to reconcile skill", {
				skill: skillName,
				error: msg,
			});

			const consecutiveFailures = (failureState?.consecutiveFailures ?? 0) + 1;
			const backoffMs = skillBackoffDelayMs(consecutiveFailures);
			skillFailureState.set(skillName, { consecutiveFailures, nextAttemptAt: Date.now() + backoffMs });
			if (backoffMs > 0) {
				logger.warn("reconciler", "Skill reconcile failed repeatedly; entering backoff", {
					skill: skillName,
					consecutiveFailures,
					backoffMs,
				});
			}
			return "failed";
		}
	});
}

/**
 * Remove one skill through the shared per-skill flight. This is the watcher
 * unlink path and must use the workspace key, not the skills directory path.
 */
export function reconcileUnlinkedSkill(skillName: string, deps: ReconcilerDeps): Promise<ReconcileSkillResult> {
	return withSkillReconciliationLock(deps.agentsDir, skillName, () => {
		const result = uninstallSkillNode({ skillName }, deps.accessor);
		resetSkillFailureState(skillName);
		return result.removed ? "removed" : "unchanged";
	});
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
	let lastScannedDirMtimeMs: number | null | undefined;
	let activePass: Promise<void> | null = null;
	let stopped = false;

	const directoryMtimeMs = (): number | null => {
		try {
			return statSync(dir).mtimeMs;
		} catch {
			return null;
		}
	};

	const reconcileIfChanged = (): Promise<void> => {
		if (stopped) return Promise.resolve();
		if (activePass) return activePass;

		const pass = (async () => {
			const currentMtimeMs = directoryMtimeMs();
			const scanFilesystem = currentMtimeMs !== lastScannedDirMtimeMs;
			await reconcileOnce(deps, { scanFilesystem });
			lastScannedDirMtimeMs = currentMtimeMs;
		})();
		const guardedPass = pass.finally(() => {
			if (activePass === guardedPass) activePass = null;
		});
		activePass = guardedPass;
		return guardedPass;
	};

	// Immediate backfill and periodic scans share one pass flight. A periodic
	// tick that arrives during startup coalesces onto the startup pass.
	reconcileIfChanged().catch((e) => {
		logger.error("reconciler", "Startup backfill failed", e instanceof Error ? e : undefined, {
			error: String(e),
		});
	});

	const timer = setInterval(() => {
		reconcileIfChanged().catch((e) => {
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
			reconcileSkillFile(skillName, filePath, deps, { forceInstall: true }).catch((e) => {
				logger.error("reconciler", "Watcher reconciliation failed", e instanceof Error ? e : undefined, {
					skill: skillName,
					error: String(e),
				});
			});
		});

		watcher.on("change", (filePath) => {
			const skillName = basename(dirname(filePath));
			logger.info("reconciler", "SKILL.md changed", { skill: skillName });
			reconcileSkillFile(skillName, filePath, deps, { forceInstall: true }).catch((e) => {
				logger.error("reconciler", "Watcher reconciliation failed", e instanceof Error ? e : undefined, {
					skill: skillName,
					error: String(e),
				});
			});
		});

		watcher.on("unlink", (filePath) => {
			const skillName = basename(dirname(filePath));
			logger.info("reconciler", "SKILL.md removed", { skill: skillName });
			reconcileUnlinkedSkill(skillName, deps).catch((e) => {
				logger.error("reconciler", "Watcher uninstall failed", e instanceof Error ? e : undefined, {
					skill: skillName,
					error: String(e),
				});
			});
		});
	}

	logger.info("reconciler", "Skill reconciler started", {
		intervalMs,
		skillsDir: dir,
		watcherActive: watcher !== null,
	});

	return {
		stop() {
			stopped = true;
			clearInterval(timer);
			if (watcher) {
				watcher.close();
				watcher = null;
			}
			logger.info("reconciler", "Skill reconciler stopped");
		},
	};
}
