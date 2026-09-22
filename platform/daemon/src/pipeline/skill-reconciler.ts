import { access, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { watch } from "chokidar";
import type { DbAccessor } from "../db-accessor.js";
import { logger } from "../logger.js";
import type { EmbeddingConfig, PipelineV2Config } from "../memory-config.js";
import { parseSkillFile } from "./skill-frontmatter.js";
import { installSkillNode, skillEmbeddingHash, uninstallSkillNode } from "./skill-graph.js";

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

function skillsDir(agentsDir: string): string {
	return join(agentsDir, "skills");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
const SKILL_BACKOFF_BASE_MS = 10_000;
const SKILL_BACKOFF_MAX_MS = 10 * 60_000;
const SKILL_BACKOFF_FAILURES = 3;

const skillFailureState = new Map<string, { consecutiveFailures: number; nextAttemptAt: number }>();
export function skillBackoffDelayMs(
	consecutiveFailures: number,
	baseMs: number = SKILL_BACKOFF_BASE_MS,
	maxMs: number = SKILL_BACKOFF_MAX_MS,
): number {
	if (consecutiveFailures <= SKILL_BACKOFF_FAILURES) return 0;
	const delay = baseMs * 2 ** (consecutiveFailures - SKILL_BACKOFF_FAILURES - 1);
	return Math.min(delay, maxMs);
}
export function resetSkillFailureState(skillName: string): void {
	skillFailureState.delete(skillName);
}
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
	const diskSkills = new Map<string, string>();
	if (options.scanFilesystem !== false && (await pathExists(dir))) {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const skillMdPath = join(dir, entry.name, "SKILL.md");
			if (await pathExists(skillMdPath)) {
				diskSkills.set(entry.name, skillMdPath);
			}
		}
	}
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
	const graphSkills = await deps.accessor.withReadDbAsync(
		(db: import("../db-accessor").ReadDb) =>
			db
				.prepare("SELECT entity_id, fs_path FROM skill_meta WHERE agent_id = 'default' AND uninstalled_at IS NULL")
				.all() as Array<{ entity_id: string; fs_path: string }>,
		{ siteToken: "pipeline/skill-reconciler.ts:107", operation: "pipeline.skill-reconciler.list-graph-skills" },
	);

	for (const row of graphSkills) {
		if (!(await pathExists(row.fs_path))) {
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
export async function reconcileSkillFile(
	skillName: string,
	mdPath: string,
	deps: ReconcilerDeps,
	options: ReconcileSkillFileOptions = {},
): Promise<ReconcileSkillResult> {
	return withSkillReconciliationLock(deps.agentsDir, skillName, async () => {
		if (options.forceInstall) resetSkillFailureState(skillName);
		const failureState = skillFailureState.get(skillName);
		if (failureState && failureState.nextAttemptAt > Date.now()) {
			return "skipped";
		}

		try {
			if (!(await pathExists(mdPath))) {
				const result = await uninstallSkillNode({ skillName }, deps.accessor);
				resetSkillFailureState(skillName);
				return result.removed ? "removed" : "unchanged";
			}

			const content = await readFile(mdPath, "utf-8");
			const parsed = parseSkillFile(content);
			if (!parsed) return "skipped";

			const entityId = `skill:default:${skillName}`;
			const existing = await deps.accessor.withReadDbAsync(
				(db: import("../db-accessor").ReadDb) =>
					db
						.prepare("SELECT id FROM entities WHERE id = ? OR (name = ? AND agent_id = 'default')")
						.get(entityId, skillName) as { id: string } | undefined,
				{ siteToken: "pipeline/skill-reconciler.ts:174", operation: "pipeline.skill-reconciler.find-entity" },
			);
			const actualId = existing?.id ?? entityId;
			const rawHash = skillEmbeddingHash(actualId, parsed.frontmatter);
			const storedEmb = await deps.accessor.withReadDbAsync(
				(db: import("../db-accessor").ReadDb) =>
					db
						.prepare("SELECT content_hash FROM embeddings WHERE source_type = 'skill' AND source_id = ?")
						.get(actualId) as { content_hash: string } | undefined,
				{ siteToken: "pipeline/skill-reconciler.ts:183", operation: "pipeline.skill-reconciler.find-embedding" },
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
export function reconcileUnlinkedSkill(skillName: string, deps: ReconcilerDeps): Promise<ReconcileSkillResult> {
	return withSkillReconciliationLock(deps.agentsDir, skillName, async () => {
		const result = await uninstallSkillNode({ skillName }, deps.accessor);
		resetSkillFailureState(skillName);
		return result.removed ? "removed" : "unchanged";
	});
}
export function startReconciler(deps: ReconcilerDeps): ReconcilerHandle {
	const intervalMs = deps.pipelineConfig.procedural.reconcileIntervalMs;
	const dir = skillsDir(deps.agentsDir);
	let lastScannedDirMtimeMs: number | null | undefined;
	let activePass: Promise<void> | null = null;
	let stopped = false;

	const directoryMtimeMs = async (): Promise<number | null> => {
		try {
			return (await stat(dir)).mtimeMs;
		} catch {
			return null;
		}
	};

	const reconcileIfChanged = (): Promise<void> => {
		if (stopped) return Promise.resolve();
		if (activePass) return activePass;

		const pass = (async () => {
			const currentMtimeMs = await directoryMtimeMs();
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
	let watcher: ReturnType<typeof watch> | null = null;

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
