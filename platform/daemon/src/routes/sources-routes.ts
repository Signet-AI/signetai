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
	addWebSource,
	loadSourcesConfig,
	markSourceIndexed,
	removeSourceIfGeneration,
	resolveDefaultBasePath,
} from "@signet/core";
import type { Context, Hono } from "hono";
import { resolveDaemonAgentId } from "../agent-id";
import { getPeerAddress } from "../auth/middleware";
import { dbOwnerQuery, dbOwnerSourceEvidenceEligibility } from "../db-owner-runtime";
import { fetchEmbedding } from "../embedding-fetch";
import { type ImportExtractionOutcome, readImportedSourceOutcome } from "../imported-source-outcome";
import { logger } from "../logger";
import { loadMemoryConfig } from "../memory-config";
import {
	type NativeMemoryBridgeHandle,
	nativeMemorySourcePermissionHealth,
	purgeNativeMemorySourceArtifacts,
	resolveEmbeddingBridgeOptions,
	startNativeMemoryBridge,
} from "../native-memory-sources";

import { getActiveTelemetry } from "../telemetry";
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
	pauseSourceIndexJob,
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
	trackSourceLifecycleWrite,
} from "../source-lifecycle-telemetry";
import { getSourceProvider } from "../source-providers";
import { exportSourceSnapshot, importSourceSnapshot } from "../source-snapshots";
import { purgeSourceOwnedRows } from "../source-purge";
import { getTranscriptImportPlatformError, TRANSCRIPT_IMPORT_SUPPORTED_PLATFORMS } from "../transcript-import-safe-fs";

interface SourceIndexJobInput {
	readonly source: SignetSourceEntry;
	readonly agentsDir: string;
	readonly startBridge: typeof startNativeMemoryBridge;
	readonly purgeNativeSource: typeof purgeNativeMemorySourceArtifacts;
	readonly recordIndexOperation: typeof recordSourceIndexOperation;
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

interface AddWebSourceBody {
	readonly url?: string;
	readonly name?: string;
}

interface PickDirectoryBody {
	readonly title?: string;
}

type PickerExecFile = (
	command: string,
	args: string[],
	options: { readonly timeout: number },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export interface RegisterSourcesRoutesDeps {
	readonly agentsDir?: string;
	readonly startBridge?: typeof startNativeMemoryBridge;
	readonly purgeNativeSource?: typeof purgeNativeMemorySourceArtifacts;
	readonly pickerExecFile?: PickerExecFile;
	readonly pickerPlatform?: NodeJS.Platform;
	readonly platform?: NodeJS.Platform;
	readonly recordIndexOperation?: typeof recordSourceIndexOperation;
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
		await recordSourceIndexOperation({
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
	const agentsDir = deps.agentsDir ?? resolveDefaultBasePath();
	const startBridge = deps.startBridge ?? startNativeMemoryBridge;
	const purgeNativeSource = deps.purgeNativeSource ?? purgeNativeMemorySourceArtifacts;
	const recordIndexOperation = deps.recordIndexOperation ?? recordSourceIndexOperation;
	const pickerExecFile = deps.pickerExecFile ?? execFileAsync;
	const pickerPlatform = deps.pickerPlatform ?? process.platform;
	const transcriptImportPlatform = deps.platform ?? process.platform;
	app.get("/api/sources", async (c) => {
		const config = loadSourcesConfig(agentsDir);
		const agentId = resolveDaemonAgentId();
		const tombstonedSourceGenerations = loadTombstonedSourceGenerations(agentsDir, agentId);
		const sources = await Promise.all(
			config.sources
				.filter(
					(source) =>
						isSourceVisibleToAgent(source, agentId) &&
						!isSourceGenerationTombstoned(source, tombstonedSourceGenerations),
				)
				.map(async (source) => {
					const stats = await sourceStats(source, agentId);
					return {
						...source,
						stats,
						health: await sourceHealth(source, agentId, stats),
						indexJob: getSourceIndexJob(source.id),
					};
				}),
		);
		return c.json({
			version: config.version,
			sources,
		});
	});

	app.post("/api/sources/pick-directory", async (c) => {
		let body: PickDirectoryBody = {};
		try {
			body = (await c.req.json().catch(() => ({}))) as PickDirectoryBody;
		} catch {
			body = {};
		}

		const result = await pickDirectory(body.title ?? "Choose folder", pickerPlatform, pickerExecFile);
		if (result.ok === false) return c.json({ error: result.error }, 501);
		return c.json({ path: result.path });
	});

	app.post("/api/sources/pick-files", async (c) => {
		if (!isLoopbackRequest(c)) return c.json({ error: "Native file picking is local-only" }, 400);
		let body: PickDirectoryBody = {};
		try {
			body = (await c.req.json().catch(() => ({}))) as PickDirectoryBody;
		} catch {
			body = {};
		}

		const result = await pickFiles(body.title ?? "Choose files", pickerPlatform, pickerExecFile);
		if (result.ok === false) return c.json({ error: result.error }, 501);
		return c.json({ paths: result.paths });
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
		await recordSourceConnected(result.source, resolveDaemonAgentId());

		const job = enqueueSourceIndexJob({
			source: result.source,
			agentsDir,
			startBridge,
			purgeNativeSource,
			recordIndexOperation,
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
		await recordSourceConnected(result.source, resolveDaemonAgentId());

		const job = enqueueSourceIndexJob({
			source: result.source,
			agentsDir,
			startBridge,
			purgeNativeSource,
			recordIndexOperation,
		});

		return c.json({ source: result.source, created: result.created, indexed: 0, queued: true, job }, 202);
	});

	app.get("/api/sources/:sourceId/snapshot", (c) => {
		const sourceId = c.req.param("sourceId");
		const source = findConfiguredSource(sourceId, agentsDir, resolveDaemonAgentId());
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

	app.get("/api/sources/:sourceId/health", async (c) => {
		const sourceId = c.req.param("sourceId");
		const source = findConfiguredSource(sourceId, agentsDir, resolveDaemonAgentId());
		if (!source) return c.json({ error: "Source not found" }, 404);
		const agentId = resolveDaemonAgentId();
		const stats = await sourceStats(source, agentId);
		return c.json({ source, stats, health: await sourceHealth(source, agentId, stats) });
	});

	app.post("/api/sources/:sourceId/snapshot/import", async (c) => {
		const startedAt = Date.now();
		const sourceId = c.req.param("sourceId");
		const source = findConfiguredSource(sourceId, agentsDir, resolveDaemonAgentId());
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
				await recordSourceIndexOperation({
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
			const result = await importSourceSnapshot({
				source,
				agentId: resolveDaemonAgentId(),
				snapshot: body,
				includeLocalDiscord: c.req.query("includeLocalDiscord") === "true",
			});
			if (result.ok === false) {
				await recordSourceIndexOperation({
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
			await recordSourceIndexOperation({
				source,
				agentId: resolveDaemonAgentId(),
				discovered: result.imported + result.skipped.localDiscordArtifacts,
				accepted: result.imported,
				skipped: result.skipped.localDiscordArtifacts,
				durationMs: Date.now() - startedAt,
				outcome: "success",
				updateFreshness: false,
				searchable: await sourceHasSearchableArtifacts(source, resolveDaemonAgentId()),
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
		await recordSourceConnected(result.source, resolveDaemonAgentId());

		const job = enqueueSourceIndexJob({
			source: result.source,
			agentsDir,
			startBridge,
			purgeNativeSource,
			recordIndexOperation,
		});

		return c.json({ source: result.source, created: result.created, indexed: 0, queued: true, job }, 202);
	});

	app.post("/api/sources/web", async (c) => {
		let body: AddWebSourceBody = {};
		try {
			const parsed = (await c.req.json()) as unknown;
			body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AddWebSourceBody) : {};
		} catch {
			recordSourceConnectionFailure("web", "invalid configuration");
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const result = addWebSource(
			{
				url: typeof body.url === "string" ? body.url : "",
				name: typeof body.name === "string" ? body.name : undefined,
			},
			agentsDir,
		);
		if (result.ok === false) {
			recordSourceConnectionFailure("web", result.error);
			return c.json({ error: result.error }, 400);
		}
		await recordSourceConnected(result.source, resolveDaemonAgentId());
		const job = enqueueSourceIndexJob({
			source: result.source,
			agentsDir,
			startBridge,
			purgeNativeSource,
			recordIndexOperation,
		});
		return c.json({ source: result.source, created: result.created, indexed: 0, queued: true, job }, 202);
	});

	app.delete("/api/sources/:sourceId", async (c) => {
		const sourceId = c.req.param("sourceId");
		const source = findConfiguredSource(sourceId, agentsDir, resolveDaemonAgentId(), { includeTombstoned: true });
		if (source === undefined) return c.json({ error: "Source not found" }, 404);
		const sourceAgentId = resolveDaemonAgentId();
		if (source.kind === "import" && source.providerSettings?.agentId !== sourceAgentId)
			return c.json({ error: "Source not found" }, 404);
		if (source.kind === "import") {
			const unsupported = getTranscriptImportPlatformError(transcriptImportPlatform);
			if (unsupported !== undefined)
				return c.json(
					{
						error: unsupported.message,
						code: unsupported.code,
						platform: unsupported.platform,
						supportedPlatforms: [...TRANSCRIPT_IMPORT_SUPPORTED_PLATFORMS],
					},
					501,
				);
		}
		// Keep the configured source until lifecycle state and provider artifacts
		// are gone. The config is the durable retry handle when an owner or purge
		// operation fails partway through deletion.
		cancelSourceIndexJob(source.id);
		recordSourceDeletionTombstone(source, sourceAgentId, agentsDir);
		await removeSourceLifecycleState(source, sourceAgentId);
		const provider = getSourceProvider(source.kind);
		const purged =
			(await purgeSourceOwnedRows({ sourceId: source.id, agentId: sourceAgentId })) +
			(provider ? await purgeSource(provider, source, sourceAgentId, purgeNativeSource) : 0);
		const result = removeSourceIfGeneration(sourceId, source.generation, agentsDir);
		if (result.ok === false) return c.json({ error: result.error }, 500);
		if (!isSourceIndexInFlight(source.id)) clearSourceDeletionTombstone(source, sourceAgentId, agentsDir);
		return c.json({ source: result.source ?? source, purged });
	});
}

function findConfiguredSource(
	sourceId: string,
	agentsDir: string,
	agentId: string,
	options: { readonly includeTombstoned?: boolean } = {},
): SignetSourceEntry | undefined {
	const tombstonedSourceGenerations = loadTombstonedSourceGenerations(agentsDir, agentId);
	return loadSourcesConfig(agentsDir).sources.find(
		(source: SignetSourceEntry) =>
			source.id === sourceId &&
			isSourceVisibleToAgent(source, agentId) &&
			(options.includeTombstoned === true || !isSourceGenerationTombstoned(source, tombstonedSourceGenerations)),
	);
}

function isSourceGenerationTombstoned(source: SignetSourceEntry, generations: ReadonlySet<string>): boolean {
	const key = sourceGenerationKey(source);
	return key !== undefined && generations.has(key);
}

function loadTombstonedSourceGenerations(agentsDir: string, agentId: string): ReadonlySet<string> {
	return new Set(
		loadSourceDeletionTombstones(agentsDir)
			.filter((tombstone) => tombstone.agentId === agentId)
			.map((tombstone) => sourceGenerationKey(tombstone.source))
			.filter((generation): generation is string => generation !== undefined),
	);
}

function sourceGenerationKey(source: SignetSourceEntry): string | undefined {
	return source.generation === undefined ? undefined : `${source.id}\u0000${source.generation}`;
}

function isSourceVisibleToAgent(source: SignetSourceEntry, agentId: string): boolean {
	return source.kind !== "import" || source.providerSettings?.agentId === agentId;
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

async function recordSourceIndexTelemetryBestEffort(
	recordIndexOperation: typeof recordSourceIndexOperation,
	input: Parameters<typeof recordSourceIndexOperation>[0],
): Promise<void> {
	try {
		await recordIndexOperation(input);
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		logger.error("telemetry", "Source index lifecycle telemetry persistence failed", failure);
		const telemetry = getActiveTelemetry();
		if (!telemetry) return;
		try {
			const properties = { type: "SourceLifecycleTelemetryFailure", operation: "source-index" } as const;
			if (telemetry.recordDeferred) telemetry.recordDeferred("error.occurred", properties);
			else telemetry.record("error.occurred", properties);
		} catch (signalError) {
			logger.error(
				"telemetry",
				"Failed to signal source index lifecycle telemetry failure",
				signalError instanceof Error ? signalError : new Error(String(signalError)),
			);
		}
	}
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
					if (recurring && event.currentPath !== "discord://gateway") {
						void trackSourceLifecycleWrite(recordSourceReadiness(input.source, agentId));
					}
					if (recurring && Date.now() - lastRecurringFreshnessAt >= 5 * 60 * 1_000) {
						lastRecurringFreshnessAt = Date.now();
						void trackSourceLifecycleWrite(recordSourceFreshness(input.source, agentId));
					}
				},
			});
			if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
			if (result.failures.length > 0) {
				const accepted = Math.max(0, result.indexed - result.failures.length);
				const discovered = Math.max(result.scanned, result.indexed);
				failSourceIndexJob(
					input.source.id,
					job.id,
					`${input.source.kind} source sync completed with ${result.failures.length} failure(s)`,
				);
				await recordSourceIndexTelemetryBestEffort(input.recordIndexOperation, {
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
			} else {
				const discovered = Math.max(result.scanned, result.indexed);
				markSourceIndexed(input.source.id, undefined, input.agentsDir);
				completeSourceIndexJob(input.source.id, job.id, result.indexed);
				await recordSourceIndexTelemetryBestEffort(input.recordIndexOperation, {
					source: input.source,
					agentId,
					discovered,
					accepted: result.indexed,
					durationMs: Date.now() - startedAt,
					outcome: "success",
				});
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
			sourceGraphEnabled: true,
			...resolveEmbeddingBridgeOptions(memoryCfg.embedding, fetchEmbedding),
			onFileIndexed: (event) => {
				if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
				updateSourceIndexJobProgress(input.source.id, job.id, {
					scanned: event.scanned,
					total: event.total,
					indexed: event.changed,
					currentPath: event.filePath,
					statusMessage: event.status,
				});
			},
			shouldContinue: () => isCurrentSourceIndexJob(input.source.id, job.id),
		});
		const indexed = await bridge.syncExisting();
		if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
		const syncResult = bridge.getLastSyncResult?.();
		const paused = syncResult?.pausedSources.find((result) => result.sourceId === input.source.id);
		if (syncResult?.status === "paused" && paused) {
			pauseSourceIndexJob(input.source.id, job.id, {
				pauseReason: paused.pauseReason ?? "provider_unavailable",
				resumeFrontier: paused.resumeFrontier,
				scanned: paused.scanned,
				indexed: paused.indexed,
			});
			await recordSourceIndexTelemetryBestEffort(input.recordIndexOperation, {
				source: input.source,
				agentId,
				discovered: syncResult.scanned,
				accepted: syncResult.indexed,
				durationMs: Date.now() - startedAt,
				outcome: "partial",
				failureClass: sourceFailureClass(new Error("network provider unavailable")),
				searchable: syncResult.indexed > 0,
				updateFreshness: false,
			});
			return;
		}
		markSourceIndexed(input.source.id, undefined, input.agentsDir);
		const progress = getSourceIndexJob(input.source.id);
		completeSourceIndexJob(input.source.id, job.id, indexed);
		await recordSourceIndexTelemetryBestEffort(input.recordIndexOperation, {
			source: input.source,
			agentId,
			discovered: progress?.scanned ?? indexed,
			accepted: indexed,
			durationMs: Date.now() - startedAt,
			outcome: "success",
		});
	} catch (err) {
		if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
		failSourceIndexJob(input.source.id, job.id, err);
		await recordSourceIndexTelemetryBestEffort(input.recordIndexOperation, {
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
	} finally {
		await bridge?.close().catch(() => undefined);
		if (consumeCanceledSourceIndexJob(job.id) && !sourceIndexStopping) {
			const provider = getSourceProvider(input.source.kind);
			if (provider) await purgeSource(provider, input.source, resolveDaemonAgentId(), input.purgeNativeSource);
			clearSourceDeletionTombstone(input.source, resolveDaemonAgentId(), input.agentsDir);
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
 * tombstones. Runs in the post-ready deferred lane AFTER the DB accessor is
 * initialized (#1143): route registration executes before DB init, so it must
 * not trigger this — the old placement crashed the daemon with "DbAccessor not
 * initialised" whenever a tombstone existed at boot.
 *
 * A failed lifecycle cleanup or purge is logged and its tombstone is kept for
 * the next boot: tombstone processing must never brick startup.
 */
export async function cleanupSourceDeletionTombstones(
	agentsDir = resolveDefaultBasePath(),
	purgeNativeSource: typeof purgeNativeMemorySourceArtifacts = purgeNativeMemorySourceArtifacts,
): Promise<void> {
	const tombstones = loadSourceDeletionTombstones(agentsDir);
	if (tombstones.length === 0) return;
	const configuredSources = loadSourcesConfig(agentsDir).sources;
	const remaining: SourceDeletionTombstone[] = [];
	for (const tombstone of tombstones) {
		const configured = configuredSources.find((source: SignetSourceEntry) => source.id === tombstone.source.id);
		if (configured !== undefined) {
			// Artifact purge is keyed by source id rather than generation. Retain
			// every tombstone while that id is configured: this avoids deleting a
			// deliberately re-added source, while generation-specific route
			// filtering leaves a newer source generation visible.
			remaining.push(tombstone);
			continue;
		}
		const provider = getSourceProvider(tombstone.source.kind);
		try {
			await removeSourceLifecycleState(tombstone.source, tombstone.agentId);
			if (provider) await purgeSource(provider, tombstone.source, tombstone.agentId, purgeNativeSource);
		} catch (err) {
			remaining.push(tombstone);
			logger.warn(
				"system",
				`Source-deletion tombstone cleanup failed for source ${tombstone.source.id}; deferring to next boot`,
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
): Promise<number> {
	if (provider.toNativeSource) return purgeNativeSource(provider.toNativeSource(source), agentId);
	return Promise.resolve(provider.purge(source, agentId));
}

function recordSourceDeletionTombstone(source: SignetSourceEntry, agentId: string, agentsDir: string): void {
	const tombstones = loadSourceDeletionTombstones(agentsDir);
	const next = tombstones.filter(
		(entry) =>
			entry.source.id !== source.id || entry.agentId !== agentId || entry.source.generation !== source.generation,
	);
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

function clearSourceDeletionTombstone(source: SignetSourceEntry, agentId: string, agentsDir: string): void {
	// The canceled-index cleanup path can run after a failed config write. Keep
	// the marker for the same source generation, but allow a deliberate
	// reconnect to replace that generation and become live again.
	const configured = loadSourcesConfig(agentsDir).sources.find((entry) => entry.id === source.id);
	if (configured?.generation === source.generation) return;
	const tombstones = loadSourceDeletionTombstones(agentsDir);
	const next = tombstones.filter(
		(entry) =>
			entry.source.id !== source.id || entry.agentId !== agentId || entry.source.generation !== source.generation,
	);
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
	/** Whether canonical visible source evidence still has an eligible undelivered fragment. */
	readonly hasEligibleUnconsumedEvidence: boolean;
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
		readonly aspects: number;
		readonly attributes: number;
		readonly dependencies: number;
		readonly communities: number;
		readonly total: number;
		readonly documentEntityId: string | null;
	};
	readonly importExtraction?: ImportExtractionOutcome;
	readonly permission: {
		readonly status: "clear" | "denied";
		readonly issues: readonly { readonly path: string; readonly guidance: string }[];
	};
}

async function sourceStats(source: SignetSourceEntry, agentId: string): Promise<SourceStats> {
	const rootPrefix = `${source.root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
	const chunkPrefix = `${source.id}:`;
	try {
		const artifactSql =
			source.kind === "obsidian"
				? `SELECT COUNT(*) AS n FROM memory_artifacts
				 WHERE agent_id = ? AND (source_id = ? OR (harness = 'obsidian' AND source_id IS NULL AND source_path >= ? AND source_path < ?))
				   AND COALESCE(is_deleted, 0) = 0`
				: `SELECT COUNT(*) AS n FROM memory_artifacts
				 WHERE agent_id = ? AND source_id = ? AND COALESCE(is_deleted, 0) = 0`;
		const artifactParams =
			source.kind === "obsidian" ? [agentId, source.id, rootPrefix, `${rootPrefix}\uffff`] : [agentId, source.id];
		const [artifactRow, chunkRow, hasEligibleUnconsumedEvidence] = await Promise.all([
			dbOwnerQuery<{ n: number }>(
				{ sql: artifactSql, params: artifactParams, result: "get" },
				{ operation: "sources.stats_artifacts", lane: "read", deadlineMs: 3_000 },
			),
			dbOwnerQuery<{ n: number }>(
				{
					sql: `SELECT COUNT(*) AS n FROM embeddings WHERE agent_id = ? AND source_type IN (?, ?) AND source_id >= ? AND source_id < ?`,
					params: [
						agentId,
						SOURCE_CHUNK_SOURCE_TYPE,
						LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE,
						chunkPrefix,
						`${chunkPrefix}\uffff`,
					],
					result: "get",
				},
				{ operation: "sources.stats_chunks", lane: "read", deadlineMs: 3_000 },
			),
			dbOwnerSourceEvidenceEligibility(
				{ agentId, sourceEntryId: source.id, legacyObsidianRoot: source.kind === "obsidian" ? source.root : undefined },
				{ operation: "sources.stats_evidence", deadlineMs: 3_000 },
			),
		]);
		const artifacts = Number(artifactRow?.n ?? 0);
		const chunks = Number(chunkRow?.n ?? 0);
		return { artifacts, chunks, indexed: artifacts, hasEligibleUnconsumedEvidence };
	} catch {
		return { artifacts: 0, chunks: 0, indexed: 0, hasEligibleUnconsumedEvidence: false };
	}
}

async function sourceHealth(source: SignetSourceEntry, agentId: string, stats: SourceStats): Promise<SourceHealth> {
	const generatedAt = new Date().toISOString();
	try {
		const permission =
			source.kind === "obsidian" || source.kind === "discord"
				? nativeMemorySourcePermissionHealth(
						{ harness: source.kind === "discord" ? "discord" : "obsidian", root: source.root },
						agentId,
					)
				: { status: "clear" as const, issues: [] };
		const [artifactSummary, discordSummary, semantic, orphanChunks] = await Promise.all([
			artifactHealthSummary(source, agentId),
			discordHealthSummary(source, agentId),
			semanticHealthSummary(source, agentId),
			sourceOrphanChunks(source, agentId),
		]);
		const sourceFailures = source.kind === "discord" ? { total: 0, recoverable: 0 } : artifactSummary.failures;
		const importExtraction = source.kind === "import" ? readImportedSourceOutcome(source.id, agentId) : undefined;
		const hasDegradation =
			permission.status === "denied" ||
			sourceFailures.total > 0 ||
			discordSummary.checkpoints.partial > 0 ||
			discordSummary.checkpoints.stale > 0 ||
			artifactSummary.deletedArtifacts > 0 ||
			orphanChunks > 0;
		const status =
			permission.status === "denied"
				? "unhealthy"
				: hasDegradation
					? "degraded"
					: stats.artifacts === 0 && stats.chunks === 0
						? "empty"
						: "healthy";
		return {
			status,
			generatedAt,
			latestArtifactAt: artifactSummary.latestArtifactAt,
			latestCheckpointAt: discordSummary.latestCheckpointAt,
			chunkCoverage: stats.artifacts > 0 ? Math.min(1, stats.chunks / stats.artifacts) : stats.chunks > 0 ? 1 : 0,
			failures: source.kind === "discord" ? discordSummary.failures : sourceFailures,
			checkpoints: discordSummary.checkpoints,
			purge: {
				deletedArtifacts: artifactSummary.deletedArtifacts,
				orphanChunks,
			},
			semantic,
			...(importExtraction ? { importExtraction } : {}),
			permission,
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
			semantic: {
				entities: 0,
				aspects: 0,
				attributes: 0,
				dependencies: 0,
				communities: 0,
				total: 0,
				documentEntityId: null,
			},
			permission: { status: "clear", issues: [] },
		};
	}
}

async function sourceOrphanChunks(source: SignetSourceEntry, agentId: string): Promise<number> {
	const chunkPrefix = `${source.id}:`;
	const [livePaths, chunks] = await Promise.all([
		liveSourceArtifactPaths(source, agentId),
		dbOwnerQuery<SourceChunkHealthRow[]>(
			{
				sql: `SELECT source_id, chunk_text FROM embeddings
				 WHERE agent_id = ? AND source_type IN (?, ?) AND source_id >= ? AND source_id < ?`,
				params: [
					agentId,
					SOURCE_CHUNK_SOURCE_TYPE,
					LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE,
					chunkPrefix,
					`${chunkPrefix}\uffff`,
				],
				result: "all",
			},
			{ operation: "sources.health_orphan_chunks", lane: "read", deadlineMs: 5_000 },
		),
	]);
	return chunks.filter((chunk) => !sourceChunkMatchesLiveArtifact(source, chunk, livePaths)).length;
}

async function liveSourceArtifactPaths(source: SignetSourceEntry, agentId: string): Promise<ReadonlySet<string>> {
	if (source.kind === "obsidian") {
		const rootPrefix = `${source.root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
		const rows = await dbOwnerQuery<SourcePathHealthRow[]>(
			{
				sql: `SELECT source_path FROM memory_artifacts
				 WHERE agent_id = ? AND COALESCE(is_deleted, 0) = 0
				   AND (source_id = ? OR (harness = 'obsidian' AND source_id IS NULL AND source_path >= ? AND source_path < ?))`,
				params: [agentId, source.id, rootPrefix, `${rootPrefix}\uffff`],
				result: "all",
			},
			{ operation: "sources.health_live_paths", lane: "read", deadlineMs: 5_000 },
		);
		return new Set(rows.map((row) => normalizeSourcePath(row.source_path)));
	}
	const rows = await dbOwnerQuery<SourcePathHealthRow[]>(
		{
			sql: `SELECT source_path FROM memory_artifacts
			 WHERE agent_id = ? AND source_id = ? AND COALESCE(is_deleted, 0) = 0`,
			params: [agentId, source.id],
			result: "all",
		},
		{ operation: "sources.health_live_paths", lane: "read", deadlineMs: 5_000 },
	);
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

async function artifactHealthSummary(
	source: SignetSourceEntry,
	agentId: string,
): Promise<{
	readonly latestArtifactAt: string | null;
	readonly deletedArtifacts: number;
	readonly failures: {
		readonly total: number;
		readonly recoverable: number;
	};
}> {
	const rootPrefix = `${source.root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
	const sql =
		source.kind === "obsidian"
			? `SELECT MAX(updated_at) AS latestArtifactAt,
			        SUM(CASE WHEN COALESCE(is_deleted, 0) = 1 THEN 1 ELSE 0 END) AS deletedArtifacts
			   FROM memory_artifacts WHERE agent_id = ?
			     AND (source_id = ? OR (harness = 'obsidian' AND source_id IS NULL AND source_path >= ? AND source_path < ?))`
			: `SELECT MAX(updated_at) AS latestArtifactAt,
			        SUM(CASE WHEN COALESCE(is_deleted, 0) = 1 THEN 1 ELSE 0 END) AS deletedArtifacts
			   FROM memory_artifacts WHERE agent_id = ? AND source_id = ?`;
	const params =
		source.kind === "obsidian" ? [agentId, source.id, rootPrefix, `${rootPrefix}\uffff`] : [agentId, source.id];
	const [row, failures] = await Promise.all([
		dbOwnerQuery<HealthAggregateRow | undefined>(
			{ sql, params, result: "get" },
			{ operation: "sources.health_artifacts", lane: "read", deadlineMs: 3_000 },
		),
		sourceFailureHealthFromDb(source, agentId),
	]);
	return {
		latestArtifactAt: stringOrNull(row?.latestArtifactAt),
		deletedArtifacts: numberOrZero(row?.deletedArtifacts),
		failures,
	};
}

async function sourceFailureHealthFromDb(
	source: SignetSourceEntry,
	agentId: string,
): Promise<{ readonly total: number; readonly recoverable: number }> {
	const rows = await dbOwnerQuery<Array<{ readonly source_meta_json: string | null }>>(
		{
			sql: `SELECT source_meta_json
			   FROM memory_artifacts
			  WHERE agent_id = ? AND source_id = ?
			    AND source_kind = ? AND COALESCE(is_deleted, 0) = 0`,
			params: [agentId, source.id, `source_${source.kind}_failure`],
			result: "all",
		},
		{ operation: "sources.health_failures", lane: "read", deadlineMs: 3_000 },
	);
	let recoverable = 0;
	for (const row of rows) if (parseJsonObject(row.source_meta_json)?.recoverable === true) recoverable++;
	return { total: rows.length, recoverable };
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

async function discordHealthSummary(source: SignetSourceEntry, agentId: string): Promise<DiscordHealthSummary> {
	if (source.kind !== "discord") {
		return {
			latestCheckpointAt: null,
			failures: { total: 0, recoverable: 0 },
			checkpoints: { total: 0, partial: 0, stale: 0 },
		};
	}
	const rows = await dbOwnerQuery<DiscordHealthRow[]>(
		{
			sql: `SELECT source_kind, source_meta_json, updated_at FROM memory_artifacts WHERE agent_id = ? AND source_id = ? AND source_kind IN ('source_discord_failure', 'source_discord_checkpoint') AND COALESCE(is_deleted, 0) = 0`,
			params: [agentId, source.id],
			result: "all",
		},
		{ operation: "sources.health_discord", lane: "read", deadlineMs: 5_000 },
	);
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
}

async function semanticHealthSummary(source: SignetSourceEntry, agentId: string): Promise<SourceHealth["semantic"]> {
	const [entityRow, documentEntity, aspectsRow, attributesRow, dependenciesRow, communitiesRow] = await Promise.all([
		dbOwnerQuery<{ n: number }>(
			{
				sql: "SELECT COUNT(*) AS n FROM entities WHERE agent_id = ? AND source_id = ?",
				params: [agentId, source.id],
				result: "get",
			},
			{ operation: "sources.health_entities", lane: "read", deadlineMs: 3_000 },
		),
		dbOwnerQuery<{ id: string } | undefined>(
			{
				sql: "SELECT id FROM entities WHERE agent_id = ? AND source_id = ? AND entity_type = 'source_document' ORDER BY updated_at DESC LIMIT 1",
				params: [agentId, source.id],
				result: "get",
			},
			{ operation: "sources.health_document_entity", lane: "read", deadlineMs: 3_000 },
		),
		dbOwnerQuery<{ n: number }>(
			{
				sql: "SELECT COUNT(*) AS n FROM entity_aspects AS a JOIN entities AS e ON e.id = a.entity_id AND e.agent_id = a.agent_id WHERE a.agent_id = ? AND e.source_id = ?",
				params: [agentId, source.id],
				result: "get",
			},
			{ operation: "sources.health_aspects", lane: "read", deadlineMs: 3_000 },
		),
		dbOwnerQuery<{ n: number }>(
			{
				sql: "SELECT COUNT(*) AS n FROM entity_attributes WHERE agent_id = ? AND source_id = ?",
				params: [agentId, source.id],
				result: "get",
			},
			{ operation: "sources.health_attributes", lane: "read", deadlineMs: 3_000 },
		),
		dbOwnerQuery<{ n: number }>(
			{
				sql: "SELECT COUNT(*) AS n FROM entity_dependencies WHERE agent_id = ? AND source_id = ?",
				params: [agentId, source.id],
				result: "get",
			},
			{ operation: "sources.health_dependencies", lane: "read", deadlineMs: 3_000 },
		),
		dbOwnerQuery<{ n: number }>(
			{
				sql: "SELECT COUNT(*) AS n FROM entity_communities WHERE agent_id = ? AND source_id = ?",
				params: [agentId, source.id],
				result: "get",
			},
			{ operation: "sources.health_communities", lane: "read", deadlineMs: 3_000 },
		),
	]);
	const entities = Number(entityRow?.n ?? 0);
	const aspects = Number(aspectsRow?.n ?? 0);
	const attributes = Number(attributesRow?.n ?? 0);
	const dependencies = Number(dependenciesRow?.n ?? 0);
	const communities = Number(communitiesRow?.n ?? 0);
	return {
		entities,
		aspects,
		attributes,
		dependencies,
		communities,
		total: entities + aspects + attributes + dependencies + communities,
		documentEntityId: documentEntity?.id ?? null,
	};
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

async function pickFiles(
	title: string,
	platform: NodeJS.Platform,
	execFileForPicker: PickerExecFile,
): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
	const trimmedTitle = title.trim() || "Choose files";
	const errors: string[] = [];
	const preflightError = await osascriptPickerPreflight(platform, execFileForPicker, "file");
	if (preflightError) return { ok: false, error: preflightError };

	for (const candidate of filePickerCommands(trimmedTitle, platform)) {
		try {
			const { stdout } = await execFileForPicker(candidate.command, candidate.args, { timeout: 120_000 });
			const paths = stdout
				.split(/\r?\n|\|/)
				.map((path) => path.trim())
				.filter((path) => path.length > 0);
			if (paths.length > 0) return { ok: true, paths };
		} catch (err) {
			errors.push(`${candidate.command}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return {
		ok: false,
		error: `No native file picker is available for this daemon environment. Tried: ${errors.join("; ")}`,
	};
}

function isLoopbackRequest(c: Context): boolean {
	const peer = getPeerAddress(c);
	if (peer === null) return false;
	const normalized = peer
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	return (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized === "::ffff:127.0.0.1"
	);
}

function filePickerCommands(title: string, platform: NodeJS.Platform): Array<{ command: string; args: string[] }> {
	if (process.env.SIGNET_FILE_PICKER) {
		return [{ command: process.env.SIGNET_FILE_PICKER, args: [] }];
	}

	if (platform === "darwin") {
		return [
			{
				command: "osascript",
				args: [
					"-e",
					`set picked to choose file with prompt ${JSON.stringify(title)} with multiple selections allowed\nset output to ""\nrepeat with itemRef in picked\nset output to output & POSIX path of itemRef & linefeed\nend repeat\nreturn output`,
				],
			},
		];
	}

	if (platform === "win32") {
		return [
			{
				command: "powershell.exe",
				args: [
					"-NoProfile",
					"-Command",
					`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Multiselect = $true; $d.Title = ${JSON.stringify(title)}; if ($d.ShowDialog() -eq 'OK') { $d.FileNames -join [Environment]::NewLine }`,
				],
			},
		];
	}

	return [
		{ command: "zenity", args: ["--file-selection", "--multiple", "--separator=|", "--title", title] },
		{
			command: "kdialog",
			args: ["--getopenfilename", homedir(), "*", "--multiple", "--separate-output", "--title", title],
		},
	];
}

async function pickDirectory(
	title: string,
	platform: NodeJS.Platform,
	execFileForPicker: PickerExecFile,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	const trimmedTitle = title.trim() || "Choose folder";
	const preflightError = await osascriptPickerPreflight(platform, execFileForPicker, "folder");
	if (preflightError) return { ok: false, error: preflightError };
	const candidates = pickerCommands(trimmedTitle, platform);
	const errors: string[] = [];

	for (const candidate of candidates) {
		try {
			const { stdout } = await execFileForPicker(candidate.command, candidate.args, { timeout: 120_000 });
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

function pickerCommands(title: string, platform: NodeJS.Platform): Array<{ command: string; args: string[] }> {
	if (process.env.SIGNET_DIRECTORY_PICKER) {
		return [{ command: process.env.SIGNET_DIRECTORY_PICKER, args: [] }];
	}

	if (platform === "darwin") {
		return [
			{
				command: "osascript",
				args: ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(title)})`],
			},
		];
	}

	if (platform === "win32") {
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

async function osascriptPickerPreflight(
	platform: NodeJS.Platform,
	execFileForPicker: PickerExecFile,
	kind: "file" | "folder",
): Promise<string | null> {
	if (platform !== "darwin") return null;
	const override = kind === "file" ? process.env.SIGNET_FILE_PICKER : process.env.SIGNET_DIRECTORY_PICKER;
	if (override) return null;

	const guiError = `Native macOS ${kind} picking requires an active GUI session (Aqua). Run the desktop app in a logged-in macOS session, or configure a non-interactive picker override.`;
	try {
		const { stdout } = await execFileForPicker("launchctl", ["managername"], { timeout: 3_000 });
		if (stdout.trim() !== "Aqua") return guiError;
	} catch {
		return guiError;
	}

	try {
		await execFileForPicker("osascript", ["-e", 'tell application "System Events" to return name'], { timeout: 5_000 });
		return null;
	} catch {
		return `Native macOS ${kind} picking requires Automation permission for osascript. Grant access in System Settings → Privacy & Security → Automation, or configure a non-interactive picker override.`;
	}
}
