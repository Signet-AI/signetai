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
	addObsidianSource,
	loadSourcesConfig,
	markSourceIndexed,
	removeSource,
} from "@signet/core";
import type { Hono } from "hono";
import { resolveDaemonAgentId } from "../agent-id";
import { getDbAccessor } from "../db-accessor";
import {
	type NativeMemoryBridgeHandle,
	purgeNativeMemorySourceArtifacts,
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
	isCurrentSourceIndexJob,
	isSourceIndexInFlight,
	markSourceIndexInFlight,
	markSourceIndexJobRunning,
	updateSourceIndexJobProgress,
} from "../source-index-progress";
import { getSourceProvider } from "../source-providers";

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
	readonly includeEmbeds?: boolean;
	readonly includePolls?: boolean;
	readonly includeThreadMembers?: boolean;
	readonly since?: string;
	readonly syncMode?: "rest" | "gateway-tail" | "desktop-cache";
}

interface PickDirectoryBody {
	readonly title?: string;
}

export interface RegisterSourcesRoutesDeps {
	readonly agentsDir?: string;
	readonly startBridge?: typeof startNativeMemoryBridge;
	readonly purgeNativeSource?: typeof purgeNativeMemorySourceArtifacts;
}

export function registerSourcesRoutes(app: Hono, deps: RegisterSourcesRoutesDeps = {}): void {
	const agentsDir = deps.agentsDir ?? process.env.SIGNET_PATH ?? `${homedir()}/.agents`;
	const startBridge = deps.startBridge ?? startNativeMemoryBridge;
	const purgeNativeSource = deps.purgeNativeSource ?? purgeNativeMemorySourceArtifacts;
	cleanupSourceDeletionTombstones(agentsDir, purgeNativeSource);
	app.get("/api/sources", (c) => {
		const config = loadSourcesConfig(agentsDir);
		const agentId = resolveDaemonAgentId();
		return c.json({
			version: config.version,
			sources: config.sources.map((source) => ({
				...source,
				stats: sourceStats(source, agentId),
				indexJob: getSourceIndexJob(source.id),
			})),
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
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const root = body.root ?? body.path ?? "";
		const excludeGlobs = Array.isArray(body.excludeGlobs)
			? body.excludeGlobs.filter((entry) => typeof entry === "string")
			: undefined;
		const result = addObsidianSource({ root, name: body.name, excludeGlobs }, agentsDir);
		if (result.ok === false) return c.json({ error: result.error }, 400);

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
				includeEmbeds: body.includeEmbeds,
				includePolls: body.includePolls,
				includeThreadMembers: body.includeThreadMembers,
				since: body.since,
				syncMode: body.syncMode,
			},
			agentsDir,
		);
		if (result.ok === false) return c.json({ error: result.error }, 400);

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
		recordSourceDeletionTombstone(result.source, sourceAgentId, agentsDir);
		const provider = getSourceProvider(result.source.kind);
		const purged = provider ? purgeSource(provider, result.source, sourceAgentId, purgeNativeSource) : 0;
		if (!isSourceIndexInFlight(result.source.id))
			clearSourceDeletionTombstone(result.source.id, sourceAgentId, agentsDir);
		return c.json({ source: result.source, purged });
	});
}

function enqueueSourceIndexJob(input: SourceIndexJobInput): SourceIndexJob {
	const job = beginSourceIndexJob(input.source.id);
	scheduleSourceIndexJob(input, job, 0);
	return job;
}

async function runSourceIndexJob(input: SourceIndexJobInput, job: SourceIndexJob): Promise<void> {
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

	try {
		const provider = getSourceProvider(input.source.kind);
		if (!provider) throw new Error(`Unsupported source provider: ${input.source.kind}`);
		if (provider.sync) {
			const result = await provider.sync({
				source: input.source,
				agentsDir: input.agentsDir,
				agentId: resolveDaemonAgentId(),
				shouldContinue: () => isCurrentSourceIndexJob(input.source.id, job.id),
				onProgress: (event) => {
					if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
					updateSourceIndexJobProgress(input.source.id, job.id, event);
				},
			});
			if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
			markSourceIndexed(input.source.id, undefined, input.agentsDir);
			completeSourceIndexJob(input.source.id, job.id, result.indexed);
			return;
		}
		if (!provider.toNativeSource) throw new Error(`Source provider has no sync implementation: ${input.source.kind}`);
		bridge = input.startBridge([provider.toNativeSource(input.source)], {
			pollIntervalMs: 0,
			agentsDir: input.agentsDir,
			yieldEveryFiles: 1,
			sourceCleanupEnabled: false,
			sourceGraphEnabled: false,
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
		completeSourceIndexJob(input.source.id, job.id, indexed);
	} catch (err) {
		if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
		failSourceIndexJob(input.source.id, job.id, err);
	} finally {
		await bridge?.close().catch(() => undefined);
		if (consumeCanceledSourceIndexJob(job.id)) {
			const provider = getSourceProvider(input.source.kind);
			if (provider) purgeSource(provider, input.source, resolveDaemonAgentId(), input.purgeNativeSource);
			clearSourceDeletionTombstone(input.source.id, resolveDaemonAgentId(), input.agentsDir);
		}
		clearSourceIndexInFlight(input.source.id);
	}
}

function scheduleSourceIndexJob(input: SourceIndexJobInput, job: SourceIndexJob, delayMs: number): void {
	setTimeout(() => {
		if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
		void runSourceIndexJob(input, job);
	}, delayMs).unref?.();
}

function cleanupSourceDeletionTombstones(
	agentsDir: string,
	purgeNativeSource: typeof purgeNativeMemorySourceArtifacts,
): void {
	const tombstones = loadSourceDeletionTombstones(agentsDir);
	if (tombstones.length === 0) return;
	const configuredIds = new Set(loadSourcesConfig(agentsDir).sources.map((source) => source.id));
	const remaining: SourceDeletionTombstone[] = [];
	for (const tombstone of tombstones) {
		if (configuredIds.has(tombstone.source.id)) continue;
		const provider = getSourceProvider(tombstone.source.kind);
		if (provider) purgeSource(provider, tombstone.source, tombstone.agentId, purgeNativeSource);
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
