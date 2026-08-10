import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
	LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE,
	SOURCE_CHUNK_SOURCE_TYPE,
	type SignetSourceEntry,
	addDiscordSource,
	addGitHubSource,
	addObsidianSource,
	loadSourcesConfig,
	markSourceIndexed,
	removeSource,
} from "@signet/core";
import type { Hono } from "hono";
import { resolveDaemonAgentId } from "../agent-id";
import { type ReadDb, getDbAccessor } from "../db-accessor";
import { fetchEmbedding } from "../embedding-fetch";
import { logger } from "../logger";
import { loadMemoryConfig } from "../memory-config";
import {
	type NativeMemoryBridgeHandle,
	purgeNativeMemorySourceArtifacts,
	resolveEmbeddingBridgeOptions,
	startNativeMemoryBridge,
} from "../native-memory-sources";
import {
	type SourceIndexJob,
	beginSourceIndexJob,
	cancelSourceIndexJob,
	clearSourceIndexInFlight,
	completeSourceIndexJob,
	consumeCanceledSourceIndexJob,
	failSourceIndexJob,
	getSourceIndexJob,
	invalidateSourceIndexJob,
	isCurrentSourceIndexJob,
	isSourceIndexInFlight,
	markSourceIndexInFlight,
	markSourceIndexJobRunning,
	updateSourceIndexJobProgress,
} from "../source-index-progress";
import {
	recordSourceConnected,
	recordSourceConnectionFailure,
	recordSourceFreshness,
	recordSourceIndexOperation,
	recordSourceReadiness,
	removeSourceLifecycleState,
	sourceFailureClass,
	sourceHasSearchableArtifacts,
	sourceModeFor,
} from "../source-lifecycle-telemetry";
import { getSourceProvider } from "../source-providers";
import { exportSourceSnapshot, importSourceSnapshot } from "../source-snapshots";

interface SourceIndexJobInput {
	readonly source: SignetSourceEntry;
	readonly agentsDir: string;
	readonly startBridge: typeof startNativeMemoryBridge;
	readonly purgeNativeSource: typeof purgeNativeMemorySourceArtifacts;
}

interface SourceDeletionTombstone {
	readonly id: string;
	readonly source: SignetSourceEntry;
	readonly agentId: string;
	readonly deletedAt: string;
}

const execFileAsync = promisify(execFile);

interface AddObsidianSourceBody {
	readonly path?: string;
	readonly root?: string;
	readonly name?: string;
	readonly excludeGlobs?: readonly string[];
}

interface AddDiscordSourceBody {
	readonly guildIds?: readonly string[];
	readonly guildId?: string;
	readonly tokenRef?: string;
	readonly name?: string;
	readonly desktopCachePath?: string;
	readonly desktopCacheFullScan?: boolean;
	readonly channelFilter?: readonly string[];
	readonly channels?: readonly string[];
	readonly maxMessagesPerChannel?: number;
	readonly includeThreads?: boolean;
	readonly includeArchivedThreads?: boolean;
	readonly includePrivateArchivedThreads?: boolean;
	readonly includeMembers?: boolean;
	readonly includeAttachments?: boolean;
	readonly includeAttachmentText?: boolean;
	readonly maxAttachmentTextBytes?: number;
	readonly includeEmbeds?: boolean;
	readonly includePolls?: boolean;
	readonly includeThreadMembers?: boolean;
	readonly since?: string;
	readonly syncMode?: "rest" | "gateway-tail" | "desktop-cache";
}

interface AddGitHubSourceBody {
	readonly repos?: readonly string[];
	readonly repo?: string;
	readonly tokenRef?: string;
	readonly name?: string;
	readonly resourceTypes?: readonly ("issues" | "pulls" | "discussions" | "docs")[];
	readonly state?: "open" | "closed" | "all";
	readonly includeComments?: boolean;
	readonly labels?: readonly string[];
	readonly docPaths?: readonly string[];
	readonly maxItemsPerRepo?: number;
}

interface PickDirectoryBody {
	readonly title?: string;
}

export interface RegisterSourcesRoutesDeps {
	readonly agentsDir?: string;
	readonly startBridge?: typeof startNativeMemoryBridge;
	readonly purgeNativeSource?: typeof purgeNativeMemorySourceArtifacts;
}

const sourceIndexRuns = new Set<{ readonly sourceId: string; readonly jobId: string; readonly run: Promise<void> }>();
const sourceIndexTimers = new Set<ReturnType<typeof setTimeout>>();
const routeSourceJobs = new Map<string, { readonly job: SourceIndexJob; readonly input: SourceIndexJobInput }>();
let sourceIndexStopping = false;

/** Stop route-owned source work before the daemon closes telemetry and SQLite. */
export async function stopSourceIndexJobs(): Promise<void> {
	sourceIndexStopping = true;
	for (const timer of sourceIndexTimers) clearTimeout(timer);
	sourceIndexTimers.clear();
	for (const [sourceId, routeJob] of routeSourceJobs) {
		const current = getSourceIndexJob(sourceId);
		if (current?.id !== routeJob.job.id || (current.status !== "queued" && current.status !== "running")) continue;
		recordSourceIndexOperation({
			source: routeJob.input.source,
			agentId: resolveDaemonAgentId(),
			discovered: current.total ?? current.scanned ?? 0,
			accepted: current.indexed ?? 0,
			durationMs: Math.max(0, Date.now() - Date.parse(current.startedAt ?? current.queuedAt)),
			outcome: "cancelled",
			failureClass: "cancelled",
			searchable: false,
		});
		invalidateSourceIndexJob(sourceId);
	}
	await Promise.allSettled([...sourceIndexRuns].map(({ run }) => run));
	sourceIndexRuns.clear();
	routeSourceJobs.clear();
}

export function registerSourcesRoutes(app: Hono, deps: RegisterSourcesRoutesDeps = {}): void {
	const agentsDir = deps.agentsDir ?? process.env.SIGNET_PATH ?? `${homedir()}/.agents`;
	const startBridge = deps.startBridge ?? startNativeMemoryBridge;
	const purgeNativeSource = deps.purgeNativeSource ?? purgeNativeMemorySourceArtifacts;
	app.get("/api/sources", (c) => {
		const config = loadSourcesConfig(agentsDir);
		const agentId = resolveDaemonAgentId();
		return c.json({
			version: config.version,
			sources: config.sources.map((source) => {
				const stats = sourceStats(source, agentId);
				return {
					...source,
					stats,
					health: sourceHealth(source, agentId, stats),
					indexJob: getSourceIndexJob(source.id),
				};
			}),
		});
	});

	app.post("/api/sources/pick-directory", async (c) => {
		let body: PickDirectoryBody = {};
		try {
			body = (await c.req.json().catch(() => ({}))) as PickDirectoryBody;
		} catch {
			body = {};
		}

		const result = await pickDirectory(body.title ?? "Choose folder");
		if (result.ok === false) return c.json({ error: result.error }, 501);
		return c.json({ path: result.path });
	});

	app.post("/api/sources/obsidian", async (c) => {
		let body: AddObsidianSourceBody = {};
		try {
			body = (await c.req.json()) as AddObsidianSourceBody;
		} catch {
			recordSourceConnectionFailure("obsidian", "invalid configuration");
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const root = body.root ?? body.path ?? "";
		const excludeGlobs = Array.isArray(body.excludeGlobs)
			? body.excludeGlobs.filter((entry) => typeof entry === "string")
			: undefined;
		const result = addObsidianSource({ root, name: body.name, excludeGlobs }, agentsDir);
		if (result.ok === false) {
			recordSourceConnectionFailure("obsidian", result.error);
			return c.json({ error: result.error }, 400);
		}
		recordSourceConnected(result.source, resolveDaemonAgentId());

		const job = enqueueSourceIndexJob({
			source: result.source,
			agentsDir,
			startBridge,
			purgeNativeSource,
		});

		return c.json({ source: result.source, created: result.created, indexed: 0, queued: true, job }, 202);
	});

	app.post("/api/sources/discord", async (c) => {
		let body: AddDiscordSourceBody = {};
		try {
			body = (await c.req.json()) as AddDiscordSourceBody;
		} catch {
			recordSourceConnectionFailure("discord", "invalid configuration");
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const guildIds = Array.isArray(body.guildIds)
			? body.guildIds.filter((entry): entry is string => typeof entry === "string")
			: typeof body.guildId === "string"
				? [body.guildId]
				: [];
		const channelFilter = Array.isArray(body.channelFilter)
			? body.channelFilter.filter((entry): entry is string => typeof entry === "string")
			: Array.isArray(body.channels)
				? body.channels.filter((entry): entry is string => typeof entry === "string")
				: undefined;
		const result = addDiscordSource(
			{
				guildIds,
				tokenRef: typeof body.tokenRef === "string" ? body.tokenRef : "",
				name: body.name,
				desktopCachePath: typeof body.desktopCachePath === "string" ? body.desktopCachePath : undefined,
				desktopCacheFullScan: body.desktopCacheFullScan,
				channelFilter,
				maxMessagesPerChannel: body.maxMessagesPerChannel,
				includeThreads: body.includeThreads,
				includeArchivedThreads: body.includeArchivedThreads,
				includePrivateArchivedThreads: body.includePrivateArchivedThreads,
				includeMembers: body.includeMembers,
				includeAttachments: body.includeAttachments,
				includeAttachmentText: body.includeAttachmentText,
				maxAttachmentTextBytes: body.maxAttachmentTextBytes,
				includeEmbeds: body.includeEmbeds,
				includePolls: body.includePolls,
				includeThreadMembers: body.includeThreadMembers,
				since: body.since,
				syncMode: body.syncMode,
			},
			agentsDir,
		);
		if (result.ok === false) {
			recordSourceConnectionFailure("discord", result.error);
			return c.json({ error: result.error }, 400);
		}
		recordSourceConnected(result.source, resolveDaemonAgentId());

		const job = enqueueSourceIndexJob({
			source: result.source,
			agentsDir,
			startBridge,
			purgeNativeSource,
		});

		return c.json({ source: result.source, created: result.created, indexed: 0, queued: true, job }, 202);
	});

	app.get("/api/sources/:sourceId/snapshot", (c) => {
		const sourceId = c.req.param("sourceId");
		const source = findConfiguredSource(sourceId, agentsDir);
		if (!source) return c.json({ error: "Source not found" }, 404);
		const includeLocalDiscord = c.req.query("includeLocalDiscord") === "true";
		return c.json(
			exportSourceSnapshot({
				source,
				agentId: resolveDaemonAgentId(),
				includeLocalDiscord,
			}),
		);
	});

	app.get("/api/sources/:sourceId/health", (c) => {
		const sourceId = c.req.param("sourceId");
		const source = findConfiguredSource(sourceId, agentsDir);
		if (!source) return c.json({ error: "Source not found" }, 404);
		const agentId = resolveDaemonAgentId();
		const stats = sourceStats(source, agentId);
		return c.json({ source, stats, health: sourceHealth(source, agentId, stats) });
	});

	app.post("/api/sources/:sourceId/snapshot/import", async (c) => {
		const startedAt = Date.now();
		const sourceId = c.req.param("sourceId");
		const source = findConfiguredSource(sourceId, agentsDir);
		if (!source) return c.json({ error: "Source not found" }, 404);
		if (isSourceImportBlocked(source.id)) {
			return c.json({ error: "Source snapshot import cannot run while source indexing is queued or running" }, 409);
		}
		markSourceIndexInFlight(source.id);
		try {
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				recordSourceIndexOperation({
					source,
					agentId: resolveDaemonAgentId(),
					discovered: 0,
					accepted: 0,
					failed: 1,
					durationMs: Date.now() - startedAt,
					outcome: "failed",
					failureClass: "parse",
					updateFreshness: false,
					searchable: false,
				});
				return c.json({ error: "Invalid JSON body" }, 400);
			}
			const result = importSourceSnapshot({
				source,
				agentId: resolveDaemonAgentId(),
				snapshot: body,
				includeLocalDiscord: c.req.query("includeLocalDiscord") === "true",
			});
			if (result.ok === false) {
				recordSourceIndexOperation({
					source,
					agentId: resolveDaemonAgentId(),
					discovered: 0,
					accepted: 0,
					failed: 1,
					durationMs: Date.now() - startedAt,
					outcome: "failed",
					failureClass: sourceFailureClass(result.error),
					updateFreshness: false,
					searchable: false,
				});
				return c.json({ error: result.error }, 400);
			}
			markSourceIndexed(source.id, undefined, agentsDir);
			recordSourceIndexOperation({
				source,
				agentId: resolveDaemonAgentId(),
				discovered: result.imported + result.skipped.localDiscordArtifacts,
				accepted: result.imported,
				skipped: result.skipped.localDiscordArtifacts,
				durationMs: Date.now() - startedAt,
				outcome: "success",
				updateFreshness: false,
				searchable: sourceHasSearchableArtifacts(source, resolveDaemonAgentId()),
			});
			return c.json(result);
		} finally {
			clearSourceIndexInFlight(source.id);
		}
	});

	app.post("/api/sources/github", async (c) => {
		let body: AddGitHubSourceBody = {};
		try {
			body = (await c.req.json()) as AddGitHubSourceBody;
		} catch {
			recordSourceConnectionFailure("github", "invalid configuration");
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const repos = Array.isArray(body.repos)
			? body.repos.filter((entry): entry is string => typeof entry === "string")
			: typeof body.repo === "string"
				? [body.repo]
				: [];
		const result = addGitHubSource(
			{
				repos,
				tokenRef: typeof body.tokenRef === "string" ? body.tokenRef : undefined,
				name: body.name,
				resourceTypes: body.resourceTypes,
				state: body.state,
				includeComments: body.includeComments,
				labels: Array.isArray(body.labels)
					? body.labels.filter((entry): entry is string => typeof entry === "string")
					: undefined,
				docPaths: Array.isArray(body.docPaths)
					? body.docPaths.filter((entry): entry is string => typeof entry === "string")
					: undefined,
				maxItemsPerRepo: body.maxItemsPerRepo,
			},
			agentsDir,
		);
		if (result.ok === false) {
			recordSourceConnectionFailure("github", result.error);
			return c.json({ error: result.error }, 400);
		}
		recordSourceConnected(result.source, resolveDaemonAgentId());

		const job = enqueueSourceIndexJob({
			source: result.source,
			agentsDir,
			startBridge,
			purgeNativeSource,
		});

		return c.json({ source: result.source, created: result.created, indexed: 0, queued: true, job }, 202);
	});

	app.delete("/api/sources/:sourceId", (c) => {
		const sourceId = c.req.param("sourceId");
		const result = removeSource(sourceId, agentsDir);
		if (result.ok === false) return c.json({ error: result.error }, 404);
		cancelSourceIndexJob(result.source.id);

		const sourceAgentId = resolveDaemonAgentId();
		removeSourceLifecycleState(result.source, sourceAgentId);
		recordSourceDeletionTombstone(result.source, sourceAgentId, agentsDir);
		const provider = getSourceProvider(result.source.kind);
		const purged = provider ? purgeSource(provider, result.source, sourceAgentId, purgeNativeSource) : 0;
		if (!isSourceIndexInFlight(result.source.id))
			clearSourceDeletionTombstone(result.source.id, sourceAgentId, agentsDir);
		return c.json({ source: result.source, purged });
	});
}

function findConfiguredSource(sourceId: string, agentsDir: string): SignetSourceEntry | undefined {
	return loadSourcesConfig(agentsDir).sources.find((source) => source.id === sourceId);
}

function isSourceImportBlocked(sourceId: string): boolean {
	const job = getSourceIndexJob(sourceId);
	return isSourceIndexInFlight(sourceId) || job?.status === "queued" || job?.status === "running";
}

function enqueueSourceIndexJob(input: SourceIndexJobInput): SourceIndexJob {
	const job = beginSourceIndexJob(input.source.id);
	if (job.id.startsWith("source-index:")) routeSourceJobs.set(input.source.id, { job, input });
	scheduleSourceIndexJob(input, job, 0);
	return job;
}

async function runSourceIndexJob(input: SourceIndexJobInput, job: SourceIndexJob): Promise<void> {
	const startedAt = Date.now();
	const agentId = resolveDaemonAgentId();
	if (isSourceIndexInFlight(input.source.id)) {
		scheduleSourceIndexJob(input, job, 50);
		return;
	}
	markSourceIndexInFlight(input.source.id);
	if (!markSourceIndexJobRunning(input.source.id, job.id)) {
		clearSourceIndexInFlight(input.source.id);
		return;
	}

	let bridge: NativeMemoryBridgeHandle | null = null;
	let lastRecurringFreshnessAt = 0;

	try {
		const provider = getSourceProvider(input.source.kind);
		if (!provider) throw new Error(`Unsupported source provider: ${input.source.kind}`);
		if (provider.sync) {
			const result = await provider.sync({
				source: input.source,
				agentsDir: input.agentsDir,
				agentId,
				shouldContinue: () => isCurrentSourceIndexJob(input.source.id, job.id),
				onProgress: (event) => {
					if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
					updateSourceIndexJobProgress(input.source.id, job.id, event);
					const recurring = sourceModeFor(input.source) === "recurring";
					if (recurring && event.currentPath !== "discord://gateway") recordSourceReadiness(input.source, agentId);
					if (recurring && Date.now() - lastRecurringFreshnessAt >= 5 * 60 * 1_000) {
						lastRecurringFreshnessAt = Date.now();
						recordSourceFreshness(input.source, agentId);
					}
				},
			});
			if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
			if (result.failures.length > 0) {
				const accepted = Math.max(0, result.indexed - result.failures.length);
				const discovered = Math.max(result.scanned, result.indexed);
				recordSourceIndexOperation({
					source: input.source,
					agentId,
					discovered,
					accepted,
					failed: result.failures.length,
					durationMs: Date.now() - startedAt,
					outcome: accepted > 0 ? "partial" : "failed",
					failureClass: sourceFailureClass(result.failures[0]),
					searchable: accepted > 0,
				});
				failSourceIndexJob(
					input.source.id,
					job.id,
					`${input.source.kind} source sync completed with ${result.failures.length} failure(s)`,
				);
			} else {
				const discovered = Math.max(result.scanned, result.indexed);
				markSourceIndexed(input.source.id, undefined, input.agentsDir);
				recordSourceIndexOperation({
					source: input.source,
					agentId,
					discovered,
					accepted: result.indexed,
					durationMs: Date.now() - startedAt,
					outcome: "success",
				});
				completeSourceIndexJob(input.source.id, job.id, result.indexed);
			}
			return;
		}
		if (!provider.toNativeSource) throw new Error(`Source provider has no sync implementation: ${input.source.kind}`);
		const memoryCfg = loadMemoryConfig(input.agentsDir);
		bridge = input.startBridge([provider.toNativeSource(input.source)], {
			pollIntervalMs: 0,
			agentsDir: input.agentsDir,
			yieldEveryFiles: 1,
			sourceCleanupEnabled: false,
			sourceGraphEnabled: false,
			...resolveEmbeddingBridgeOptions(memoryCfg.embedding, fetchEmbedding),
			onFileIndexed: (event) => {
				if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
				updateSourceIndexJobProgress(input.source.id, job.id, {
					scanned: event.scanned,
					total: event.total,
					indexed: event.changed,
					currentPath: event.filePath,
				});
			},
			shouldContinue: () => isCurrentSourceIndexJob(input.source.id, job.id),
		});
		const indexed = await bridge.syncExisting();
		if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
		markSourceIndexed(input.source.id, undefined, input.agentsDir);
		const progress = getSourceIndexJob(input.source.id);
		recordSourceIndexOperation({
			source: input.source,
			agentId,
			discovered: progress?.scanned ?? indexed,
			accepted: indexed,
			durationMs: Date.now() - startedAt,
			outcome: "success",
		});
		completeSourceIndexJob(input.source.id, job.id, indexed);
	} catch (err) {
		if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
		recordSourceIndexOperation({
			source: input.source,
			agentId,
			discovered: getSourceIndexJob(input.source.id)?.scanned ?? 0,
			accepted: getSourceIndexJob(input.source.id)?.indexed ?? 0,
			failed: 1,
			durationMs: Date.now() - startedAt,
			outcome: "failed",
			failureClass: sourceFailureClass(err),
			searchable: false,
		});
		failSourceIndexJob(input.source.id, job.id, err);
	} finally {
		await bridge?.close().catch(() => undefined);
		if (consumeCanceledSourceIndexJob(job.id) && !sourceIndexStopping) {
			const provider = getSourceProvider(input.source.kind);
			if (provider) purgeSource(provider, input.source, resolveDaemonAgentId(), input.purgeNativeSource);
			clearSourceDeletionTombstone(input.source.id, resolveDaemonAgentId(), input.agentsDir);
		}
		clearSourceIndexInFlight(input.source.id);
	}
}

function scheduleSourceIndexJob(input: SourceIndexJobInput, job: SourceIndexJob, delayMs: number): void {
	if (sourceIndexStopping) return;
	const timer = setTimeout(() => {
		sourceIndexTimers.delete(timer);
		if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
		const run = runSourceIndexJob(input, job);
		const activeRun = { sourceId: input.source.id, jobId: job.id, run };
		sourceIndexRuns.add(activeRun);
		void run.finally(() => {
			sourceIndexRuns.delete(activeRun);
		});
	}, delayMs);
	sourceIndexTimers.add(timer);
	timer.unref?.();
}

/**
 * Purge artifacts of sources deleted while the daemon was down and drop their
 * tombstones. Runs in the daemon startup sequence AFTER the DB accessor is
 * initialized (#1143): route registration executes before DB init, so it must
 * not trigger this — the old placement crashed the daemon with "DbAccessor not
 * initialised" whenever a tombstone existed at boot.
 *
 * A failed purge is logged and its tombstone is kept for the next boot:
 * tombstone processing must never brick startup.
 */
export function cleanupSourceDeletionTombstones(
	agentsDir = process.env.SIGNET_PATH ?? `${homedir()}/.agents`,
	purgeNativeSource: typeof purgeNativeMemorySourceArtifacts = purgeNativeMemorySourceArtifacts,
): void {
	const tombstones = loadSourceDeletionTombstones(agentsDir);
	if (tombstones.length === 0) return;
	const configuredIds = new Set(loadSourcesConfig(agentsDir).sources.map((source) => source.id));
	const remaining: SourceDeletionTombstone[] = [];
	for (const tombstone of tombstones) {
		if (configuredIds.has(tombstone.source.id)) continue;
		removeSourceLifecycleState(tombstone.source, tombstone.agentId);
		const provider = getSourceProvider(tombstone.source.kind);
		if (!provider) continue;
		try {
			purgeSource(provider, tombstone.source, tombstone.agentId, purgeNativeSource);
		} catch (err) {
			remaining.push(tombstone);
			logger.warn(
				"system",
				`Source-deletion tombstone purge failed for source ${tombstone.source.id}; deferring to next boot`,
				{ error: err instanceof Error ? err.message : String(err) },
			);
		}
	}
	saveSourceDeletionTombstones(remaining, agentsDir);
}

function purgeSource(
	provider: NonNullable<ReturnType<typeof getSourceProvider>>,
	source: SignetSourceEntry,
	agentId: string,
	purgeNativeSource: typeof purgeNativeMemorySourceArtifacts,
): number {
	if (provider.toNativeSource) return purgeNativeSource(provider.toNativeSource(source), agentId);
	return provider.purge(source, agentId);
}

function recordSourceDeletionTombstone(source: SignetSourceEntry, agentId: string, agentsDir: string): void {
	const tombstones = loadSourceDeletionTombstones(agentsDir);
	const next = tombstones.filter((entry) => entry.source.id !== source.id || entry.agentId !== agentId);
	saveSourceDeletionTombstones(
		[
			...next,
			{
				id: randomUUID(),
				source,
				agentId,
				deletedAt: new Date().toISOString(),
			},
		],
		agentsDir,
	);
}

function clearSourceDeletionTombstone(sourceId: string, agentId: string, agentsDir: string): void {
	const tombstones = loadSourceDeletionTombstones(agentsDir);
	const next = tombstones.filter((entry) => entry.source.id !== sourceId || entry.agentId !== agentId);
	if (next.length !== tombstones.length) saveSourceDeletionTombstones(next, agentsDir);
}

function loadSourceDeletionTombstones(agentsDir: string): readonly SourceDeletionTombstone[] {
	const path = sourceDeletionTombstonesPath(agentsDir);
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isSourceDeletionTombstone);
	} catch {
		return [];
	}
}

function saveSourceDeletionTombstones(tombstones: readonly SourceDeletionTombstone[], agentsDir: string): void {
	const path = sourceDeletionTombstonesPath(agentsDir);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	writeFileSync(tmp, `${JSON.stringify(tombstones, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

function sourceDeletionTombstonesPath(agentsDir: string): string {
	return `${agentsDir.replace(/\/$/, "")}/.daemon/source-deletion-tombstones.json`;
}

function isSourceDeletionTombstone(value: unknown): value is SourceDeletionTombstone {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SourceDeletionTombstone>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.agentId === "string" &&
		typeof candidate.deletedAt === "string" &&
		!!candidate.source &&
		typeof candidate.source === "object" &&
		typeof candidate.source.id === "string" &&
		typeof candidate.source.kind === "string"
	);
}

interface SourceStats {
	readonly artifacts: number;
	readonly chunks: number;
	readonly indexed: number;
}

interface SourceHealth {
	readonly status: "healthy" | "degraded" | "unhealthy" | "empty";
	readonly generatedAt: string;
	readonly error?: string;
	readonly latestArtifactAt: string | null;
	readonly latestCheckpointAt: string | null;
	readonly chunkCoverage: number;
	readonly failures: {
		readonly total: number;
		readonly recoverable: number;
	};
	readonly checkpoints: {
		readonly total: number;
		readonly partial: number;
		readonly stale: number;
	};
	readonly purge: {
		readonly deletedArtifacts: number;
		readonly orphanChunks: number;
	};
	readonly semantic: {
		readonly entities: number;
		readonly attributes: number;
		readonly dependencies: number;
		readonly communities: number;
		readonly total: number;
	};
}

function sourceStats(source: SignetSourceEntry, agentId: string): SourceStats {
	const rootPrefix = `${source.root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
	const chunkPrefix = `${source.id}:`;
	try {
		return getDbAccessor().withReadDb((db) => {
			const artifacts =
				source.kind === "obsidian"
					? countRow(
							db
								.prepare(
									`SELECT COUNT(*) AS n FROM memory_artifacts
									 WHERE agent_id = ?
									   AND (
										   source_id = ?
										   OR (
											   harness = 'obsidian'
											   AND source_id IS NULL
											   AND source_path >= ?
											   AND source_path < ?
										   )
									   )
									   AND COALESCE(is_deleted, 0) = 0`,
								)
								.get(agentId, source.id, rootPrefix, `${rootPrefix}\uffff`),
						)
					: countRow(
							db
								.prepare(
									`SELECT COUNT(*) AS n FROM memory_artifacts
									 WHERE agent_id = ?
									   AND source_id = ?
									   AND COALESCE(is_deleted, 0) = 0`,
								)
								.get(agentId, source.id),
						);
			const chunks = countRow(
				db
					.prepare(
						`SELECT COUNT(*) AS n FROM embeddings
						 WHERE agent_id = ?
						   AND source_type IN (?, ?)
						   AND source_id >= ?
						   AND source_id < ?`,
					)
					.get(
						agentId,
						SOURCE_CHUNK_SOURCE_TYPE,
						LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE,
						chunkPrefix,
						`${chunkPrefix}\uffff`,
					),
			);
			return { artifacts, chunks, indexed: artifacts };
		});
	} catch {
		return { artifacts: 0, chunks: 0, indexed: 0 };
	}
}

function sourceHealth(source: SignetSourceEntry, agentId: string, stats: SourceStats): SourceHealth {
	const generatedAt = new Date().toISOString();
	try {
		const artifactSummary = artifactHealthSummary(source, agentId);
		const discordSummary = discordHealthSummary(source, agentId);
		const semantic = semanticHealthSummary(source, agentId);
		const orphanChunks = sourceOrphanChunks(source, agentId);
		const hasDegradation =
			discordSummary.failures.total > 0 ||
			discordSummary.checkpoints.partial > 0 ||
			discordSummary.checkpoints.stale > 0 ||
			artifactSummary.deletedArtifacts > 0 ||
			orphanChunks > 0;
		const status = hasDegradation ? "degraded" : stats.artifacts === 0 && stats.chunks === 0 ? "empty" : "healthy";
		return {
			status,
			generatedAt,
			latestArtifactAt: artifactSummary.latestArtifactAt,
			latestCheckpointAt: discordSummary.latestCheckpointAt,
			chunkCoverage: stats.artifacts > 0 ? Math.min(1, stats.chunks / stats.artifacts) : stats.chunks > 0 ? 1 : 0,
			failures: discordSummary.failures,
			checkpoints: discordSummary.checkpoints,
			purge: {
				deletedArtifacts: artifactSummary.deletedArtifacts,
				orphanChunks,
			},
			semantic,
		};
	} catch (err) {
		return {
			status: "unhealthy",
			error: `Source health diagnostics failed: ${err instanceof Error ? err.message : String(err)}`,
			generatedAt,
			latestArtifactAt: null,
			latestCheckpointAt: null,
			chunkCoverage: stats.artifacts > 0 ? Math.min(1, stats.chunks / stats.artifacts) : stats.chunks > 0 ? 1 : 0,
			failures: { total: 0, recoverable: 0 },
			checkpoints: { total: 0, partial: 0, stale: 0 },
			purge: { deletedArtifacts: 0, orphanChunks: stats.artifacts === 0 ? stats.chunks : 0 },
			semantic: { entities: 0, attributes: 0, dependencies: 0, communities: 0, total: 0 },
		};
	}
}

function sourceOrphanChunks(source: SignetSourceEntry, agentId: string): number {
	const chunkPrefix = `${source.id}:`;
	return getDbAccessor().withReadDb((db) => {
		const livePaths = liveSourceArtifactPaths(db, source, agentId);
		const chunks = db
			.prepare(
				`SELECT source_id, chunk_text
				   FROM embeddings
				  WHERE agent_id = ?
				    AND source_type IN (?, ?)
				    AND source_id >= ?
				    AND source_id < ?`,
			)
			.all(
				agentId,
				SOURCE_CHUNK_SOURCE_TYPE,
				LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE,
				chunkPrefix,
				`${chunkPrefix}\uffff`,
			) as SourceChunkHealthRow[];
		return chunks.filter((chunk) => !sourceChunkMatchesLiveArtifact(source, chunk, livePaths)).length;
	});
}

function liveSourceArtifactPaths(db: ReadDb, source: SignetSourceEntry, agentId: string): ReadonlySet<string> {
	if (source.kind === "obsidian") {
		const rootPrefix = `${source.root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
		const rows = db
			.prepare(
				`SELECT source_path
				   FROM memory_artifacts
				  WHERE agent_id = ?
				    AND COALESCE(is_deleted, 0) = 0
				    AND (
					    source_id = ?
					    OR (
						    harness = 'obsidian'
						    AND source_id IS NULL
						    AND source_path >= ?
						    AND source_path < ?
					    )
				    )`,
			)
			.all(agentId, source.id, rootPrefix, `${rootPrefix}\uffff`) as SourcePathHealthRow[];
		return new Set(rows.map((row) => normalizeSourcePath(row.source_path)));
	}
	const rows = db
		.prepare(
			`SELECT source_path
			   FROM memory_artifacts
			  WHERE agent_id = ?
			    AND source_id = ?
			    AND COALESCE(is_deleted, 0) = 0`,
		)
		.all(agentId, source.id) as SourcePathHealthRow[];
	return new Set(rows.map((row) => normalizeSourcePath(row.source_path)));
}

interface SourceChunkHealthRow {
	readonly source_id: string;
	readonly chunk_text: string | null;
}

interface SourcePathHealthRow {
	readonly source_path: string;
}

function sourceChunkMatchesLiveArtifact(
	source: SignetSourceEntry,
	chunk: SourceChunkHealthRow,
	livePaths: ReadonlySet<string>,
): boolean {
	const explicitPath = sourcePathFromChunkText(chunk.chunk_text);
	if (explicitPath && livePaths.has(normalizeSourcePath(explicitPath))) return true;
	const localPath = sourceLocalPathFromChunkId(source.id, chunk.source_id);
	if (!localPath) return false;
	return sourcePathCandidates(source, localPath).some((candidate) => livePaths.has(candidate));
}

function sourcePathFromChunkText(chunkText: string | null): string | null {
	if (!chunkText) return null;
	const line = chunkText.split("\n").find((part) => part.trimStart().toLowerCase().startsWith("source_path:"));
	return line ? normalizeSourcePath(line.trimStart().slice("source_path:".length).trim()) : null;
}

function sourceLocalPathFromChunkId(sourceId: string, chunkSourceId: string): string | null {
	const prefix = `${sourceId}:`;
	if (!chunkSourceId.startsWith(prefix)) return null;
	const localWithAnchor = chunkSourceId.slice(prefix.length);
	const anchorIndex = localWithAnchor.indexOf("#");
	const localPath = anchorIndex >= 0 ? localWithAnchor.slice(0, anchorIndex) : localWithAnchor;
	return localPath ? normalizeSourcePath(localPath) : null;
}

function sourcePathCandidates(source: SignetSourceEntry, localPath: string): readonly string[] {
	const normalized = normalizeSourcePath(localPath);
	const root = normalizeSourcePath(source.root).replace(/\/$/, "");
	return [normalized, `${root}/${normalized}`, `discord://${normalized}`, `discord-cache://${normalized}`].map(
		normalizeSourcePath,
	);
}

function normalizeSourcePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/([^:])\/{2,}/g, "$1/");
}

function artifactHealthSummary(
	source: SignetSourceEntry,
	agentId: string,
): {
	readonly latestArtifactAt: string | null;
	readonly deletedArtifacts: number;
} {
	return getDbAccessor().withReadDb((db) => {
		if (source.kind === "obsidian") {
			const rootPrefix = `${source.root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
			const row = db
				.prepare(
					`SELECT MAX(updated_at) AS latestArtifactAt,
					        SUM(CASE WHEN COALESCE(is_deleted, 0) = 1 THEN 1 ELSE 0 END) AS deletedArtifacts
					   FROM memory_artifacts
					  WHERE agent_id = ?
					    AND (
						    source_id = ?
						    OR (
							    harness = 'obsidian'
							    AND source_id IS NULL
							    AND source_path >= ?
							    AND source_path < ?
						    )
					    )`,
				)
				.get(agentId, source.id, rootPrefix, `${rootPrefix}\uffff`) as HealthAggregateRow | null;
			return {
				latestArtifactAt: stringOrNull(row?.latestArtifactAt),
				deletedArtifacts: numberOrZero(row?.deletedArtifacts),
			};
		}
		const row = db
			.prepare(
				`SELECT MAX(updated_at) AS latestArtifactAt,
				        SUM(CASE WHEN COALESCE(is_deleted, 0) = 1 THEN 1 ELSE 0 END) AS deletedArtifacts
				   FROM memory_artifacts
				  WHERE agent_id = ?
				    AND source_id = ?`,
			)
			.get(agentId, source.id) as HealthAggregateRow | null;
		return {
			latestArtifactAt: stringOrNull(row?.latestArtifactAt),
			deletedArtifacts: numberOrZero(row?.deletedArtifacts),
		};
	});
}

interface DiscordHealthSummary {
	readonly latestCheckpointAt: string | null;
	readonly failures: {
		readonly total: number;
		readonly recoverable: number;
	};
	readonly checkpoints: {
		readonly total: number;
		readonly partial: number;
		readonly stale: number;
	};
}

function discordHealthSummary(source: SignetSourceEntry, agentId: string): DiscordHealthSummary {
	if (source.kind !== "discord") {
		return {
			latestCheckpointAt: null,
			failures: { total: 0, recoverable: 0 },
			checkpoints: { total: 0, partial: 0, stale: 0 },
		};
	}
	return getDbAccessor().withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT source_kind, source_meta_json, updated_at
				   FROM memory_artifacts
				  WHERE agent_id = ?
				    AND source_id = ?
				    AND source_kind IN ('source_discord_failure', 'source_discord_checkpoint')
				    AND COALESCE(is_deleted, 0) = 0`,
			)
			.all(agentId, source.id) as DiscordHealthRow[];
		let failures = 0;
		let recoverable = 0;
		let checkpoints = 0;
		let partial = 0;
		let stale = 0;
		let latestCheckpointAt: string | null = null;
		for (const row of rows) {
			const meta = parseJsonObject(row.source_meta_json);
			if (row.source_kind === "source_discord_failure") {
				failures++;
				if (meta?.recoverable === true) recoverable++;
				continue;
			}
			checkpoints++;
			if (meta?.status === "partial") partial++;
			if (isStaleCheckpoint(row.updated_at, source.lastIndexedAt)) stale++;
			latestCheckpointAt = maxIsoTimestamp(latestCheckpointAt, stringOrNull(row.updated_at));
		}
		return {
			latestCheckpointAt,
			failures: { total: failures, recoverable },
			checkpoints: { total: checkpoints, partial, stale },
		};
	});
}

function semanticHealthSummary(source: SignetSourceEntry, agentId: string): SourceHealth["semantic"] {
	return getDbAccessor().withReadDb((db) => {
		const entities = countSourceRows(db, "entities", agentId, source.id);
		const attributes = countSourceRows(db, "entity_attributes", agentId, source.id);
		const dependencies = countSourceRows(db, "entity_dependencies", agentId, source.id);
		const communities = countSourceRows(db, "entity_communities", agentId, source.id);
		return {
			entities,
			attributes,
			dependencies,
			communities,
			total: entities + attributes + dependencies + communities,
		};
	});
}

function countSourceRows(
	db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } },
	table: string,
	agentId: string,
	sourceId: string,
): number {
	return countRow(
		db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE agent_id = ? AND source_id = ?`).get(agentId, sourceId),
	);
}

interface HealthAggregateRow {
	readonly latestArtifactAt?: unknown;
	readonly deletedArtifacts?: unknown;
}

interface DiscordHealthRow {
	readonly source_kind: string;
	readonly source_meta_json: string | null;
	readonly updated_at: string | null;
}

function parseJsonObject(value: string | null): Readonly<Record<string, unknown>> | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Readonly<Record<string, unknown>>)
			: null;
	} catch {
		return null;
	}
}

function isStaleCheckpoint(updatedAt: string | null, lastIndexedAt: string | undefined): boolean {
	if (!updatedAt || !lastIndexedAt) return false;
	const updatedMs = Date.parse(updatedAt);
	const indexedMs = Date.parse(lastIndexedAt);
	if (!Number.isFinite(updatedMs) || !Number.isFinite(indexedMs)) return false;
	return indexedMs - updatedMs > 60_000;
}

function maxIsoTimestamp(left: string | null, right: string | null): string | null {
	if (!right) return left;
	if (!left) return right;
	return Date.parse(right) > Date.parse(left) ? right : left;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function countRow(row: unknown): number {
	return typeof row === "object" && row !== null && "n" in row && typeof (row as { n?: unknown }).n === "number"
		? (row as { n: number }).n
		: 0;
}

async function pickDirectory(title: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	const trimmedTitle = title.trim() || "Choose folder";
	const candidates = pickerCommands(trimmedTitle);
	const errors: string[] = [];

	for (const candidate of candidates) {
		try {
			const { stdout } = await execFileAsync(candidate.command, candidate.args, { timeout: 120_000 });
			const path = stdout.trim();
			if (path) return { ok: true, path };
		} catch (err) {
			errors.push(`${candidate.command}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return {
		ok: false,
		error: `No native folder picker is available for this daemon environment. Tried: ${errors.join("; ")}`,
	};
}

function pickerCommands(title: string): Array<{ command: string; args: string[] }> {
	if (process.env.SIGNET_DIRECTORY_PICKER) {
		return [{ command: process.env.SIGNET_DIRECTORY_PICKER, args: [] }];
	}

	if (process.platform === "darwin") {
		return [
			{
				command: "osascript",
				args: ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(title)})`],
			},
		];
	}

	if (process.platform === "win32") {
		return [
			{
				command: "powershell.exe",
				args: [
					"-NoProfile",
					"-Command",
					`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = ${JSON.stringify(title)}; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`,
				],
			},
		];
	}

	return [
		{ command: "zenity", args: ["--file-selection", "--directory", "--title", title] },
		{ command: "kdialog", args: ["--title", title, "--getexistingdirectory", homedir()] },
	];
}
