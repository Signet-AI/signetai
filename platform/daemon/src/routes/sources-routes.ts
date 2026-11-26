import { namedReadOperation, type NamedReadOperation } from "../named-content-reads";
import { readPointerMiddleware } from "../read-pointers";
import { contentRead } from "../content-read";
import { type ReadScope, audienceSubjectFromPrincipal } from "../read-scope";
import { resolveRouteReadScope } from "./read-scope";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	addDiscordSource,
	addGitHubSource,
	addNotionSource,
	addObsidianSource,
	addWebSource,
	DEFAULT_DISCORD_DESKTOP_CACHE_PATH,
	execFileHidden as execFile,
	LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE,
	loadSourcesConfig,
	markSourceIndexed,
	normalizePublicWebUrl,
	notionSourceId,
	parseDiscordSettings,
	parseGitHubSettings,
	removeSourceIfGeneration,
	resolveDefaultBasePath,
	resolveWorkspaceLayout,
	type SignetSourceEntry,
	SOURCE_CHUNK_SOURCE_TYPE,
} from "@signet/core";
import type { Context, Hono } from "hono";
import { resolveDaemonAgentId } from "../agent-id";
import { type Permission, requirePermission } from "../auth";
import { getPeerAddress } from "../auth/middleware";
import type { DbOwnerParameter } from "../db-owner-protocol";
import { type dbOwnerQuery, dbOwnerSourceEvidenceEligibility } from "../db-owner-runtime";
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
import { jsonBody } from "../request-body";
import {
	beginSourceDeletion,
	beginSourceMutation,
	isSourceDeletionInFlight,
	SOURCE_DELETION_IN_PROGRESS_ERROR,
	SOURCE_OPERATION_IN_PROGRESS_ERROR,
} from "../source-deletion-lock";
import {
	beginSourceIndexJob,
	cancelSourceIndexJob,
	clearSourceIndexInFlight,
	completeSourceIndexJob,
	consumeCanceledSourceIndexJob,
	failSourceIndexJob,
	getSourceIndexJob,
	getSourceIndexRuns,
	invalidateSourceIndexJob,
	isCurrentSourceIndexJob,
	isSourceIndexInFlight,
	markSourceIndexInFlight,
	markSourceIndexJobRunning,
	pauseSourceIndexJob,
	type SourceIndexJob,
	trackSourceIndexRun,
	updateSourceIndexJobProgress,
	waitForSourceIndexRuns,
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
import { purgeSourceOwnedRows } from "../source-purge";
import { importSourceSnapshot } from "../source-snapshots";
import { getActiveTelemetry } from "../telemetry";
import { exposesWorkspacePrivatePath } from "../workspace-private-paths";
import { authConfig } from "./state.js";
import { resolveScopedAgentId } from "./utils";
import { currentWritePrincipal, withWritePrincipal } from "@signet/core";
import { admitWriteDestination } from "../auth/write-destination";

function resolveSourceAgentId(c: Context) {
	if (c.get("organization") && !c.get("principal")) return { agentId: "", error: "principal_required" };
	return resolveScopedAgentId(c, undefined, resolveDaemonAgentId());
}

function resolveSourceWriteIdentity(c: import("hono").Context) {
	const resolved = resolveSourceAgentId(c);
	if (resolved.error) return { ok: false as const, error: resolved.error };
	const author = c.get("author");
	if (!author) return { ok: false as const, error: "author_required" };
	return {
		ok: true as const,
		author,
		identity: { agentId: resolved.agentId, authorUserId: author.userId, authorCredential: author.credential },
	};
}

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
	readonly importSourceSnapshot?: typeof importSourceSnapshot;
}

const sourceIndexTimers = new Set<ReturnType<typeof setTimeout>>();
const routeSourceJobs = new Map<string, { readonly job: SourceIndexJob; readonly input: SourceIndexJobInput }>();
let sourceIndexStopping = false;
export async function stopSourceIndexJobs(): Promise<void> {
	sourceIndexStopping = true;
	for (const timer of sourceIndexTimers) clearTimeout(timer);
	sourceIndexTimers.clear();
	for (const [sourceId, routeJob] of routeSourceJobs) {
		const current = getSourceIndexJob(sourceId);
		if (current?.id !== routeJob.job.id || (current.status !== "queued" && current.status !== "running")) continue;
		const agentId = routeJob.input.source.writeIdentity?.agentId;
		if (!agentId) {
			invalidateSourceIndexJob(sourceId);
			continue;
		}
		await recordSourceIndexOperation({
			source: routeJob.input.source,
			agentId,
			discovered: current.total ?? current.scanned ?? 0,
			accepted: current.indexed ?? 0,
			durationMs: Math.max(0, Date.now() - Date.parse(current.startedAt ?? current.queuedAt)),
			outcome: "cancelled",
			failureClass: "cancelled",
			searchable: false,
		});
		invalidateSourceIndexJob(sourceId);
	}
	await waitForSourceIndexRuns("route");
	routeSourceJobs.clear();
}

async function sourceReadable(
	c: Context,
	source: SignetSourceEntry,
	agentId: string,
	scope: ReadScope,
): Promise<boolean> {
	const principal = c.get("principal");
	return contentRead<boolean>({
		op: "source_access",
		sourceId: source.id,
		agentId: source.writeIdentity?.agentId
			? source.writeIdentity.agentId
			: source.kind === "import" && typeof source.providerSettings?.agentId === "string"
				? source.providerSettings.agentId
				: agentId,
		scope,
		subject: principal ? audienceSubjectFromPrincipal(principal) : { local: true, userId: null, groupIds: [] },
	});
}

async function sourceReadQuery<T>(
	scope: ReadScope | undefined,
	operation: string,
	parameters: readonly DbOwnerParameter[],
	options: { readonly deadlineMs?: number },
): Promise<T> {
	if (!scope) throw new Error("Source read scope missing");
	return contentRead<T>({ op: namedReadOperation(operation), scope, parameters }, undefined, {
		deadlineMs: options?.deadlineMs,
	});
}

export function registerSourcesRoutes(app: Hono, deps: RegisterSourcesRoutesDeps = {}): void {
	app.use("*", readPointerMiddleware);
	const agentsDir = deps.agentsDir ?? resolveDefaultBasePath();
	const startBridge = deps.startBridge ?? startNativeMemoryBridge;
	const purgeNativeSource = deps.purgeNativeSource ?? purgeNativeMemorySourceArtifacts;
	const recordIndexOperation = deps.recordIndexOperation ?? recordSourceIndexOperation;
	const importSnapshot = deps.importSourceSnapshot ?? importSourceSnapshot;
	const pickerExecFile = deps.pickerExecFile ?? execFileAsync;
	const pickerPlatform = deps.pickerPlatform ?? process.platform;
	const gate = (permission: Permission) => async (c: Context, next: () => Promise<void>) =>
		requirePermission(permission, authConfig)(c, next);
	app.use("/api/sources/pick-directory", gate("admin"));
	app.use("/api/sources/pick-files", gate("admin"));
	app.use("/api/sources/obsidian", gate("admin"));
	app.use("/api/sources/discord", gate("connectors"));
	app.use("/api/sources/github", gate("connectors"));
	app.use("/api/sources/notion", gate("connectors"));
	app.use("/api/sources/web", gate("connectors"));
	app.use("/api/sources/:sourceId/snapshot", gate("connectors"));
	app.use("/api/sources/:sourceId/snapshot/import", gate("connectors"));
	app.use("/api/sources/:sourceId", async (c, next) =>
		c.req.method === "DELETE" ? requirePermission("connectors", authConfig)(c, next) : next(),
	);
	app.get("/api/sources", async (c) => {
		const resolved = await resolveRouteReadScope(c, { allowAllAgents: true });
		if (resolved instanceof Response) return resolved;
		const config = loadSourcesConfig(agentsDir);

		const agentId = resolved.agentId;
		const tombstonedSourceGenerations = loadTombstonedSourceGenerations(agentsDir, agentId);
		const sources = await Promise.all(
			config.sources
				.filter(
					(source) =>
						(resolved.scope.reach.kind === "all" || isSourceVisibleToAgent(source, agentId)) &&
						!legacySourceMutationDenied(c, source) &&
						!isSourceGenerationTombstoned(source, tombstonedSourceGenerations),
				)
				.map(async (source) => {
					if (!(await sourceReadable(c, source, agentId, resolved.scope))) return null;
					const stats = await sourceStats(source, agentId, resolved.scope);
					const health = await sourceHealth(source, agentId, stats, resolved.scope);
					return {
						...publicSource(source),
						...(c.get("organization") ? { lastIndexedAt: health.latestArtifactAt ?? undefined } : {}),
						stats,
						health,
						indexJob: c.get("organization") ? null : getSourceIndexJob(source.id),
					};
				}),
		);
		return c.json({
			version: config.version,
			sources: sources.filter((source) => source !== null),
		});
	});

	app.post("/api/sources/pick-directory", async (c) => {
		let body: PickDirectoryBody = {};
		try {
			body = (await jsonBody(c)().catch((): Record<string, unknown> => ({}))) as PickDirectoryBody;
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
			body = (await jsonBody(c)().catch((): Record<string, unknown> => ({}))) as PickDirectoryBody;
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
			body = (await jsonBody(c)()) as AddObsidianSourceBody;
		} catch {
			recordSourceConnectionFailure("obsidian", "invalid configuration");
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const root = body.root ?? body.path ?? "";
		if (
			typeof root === "string" &&
			root.trim() &&
			exposesWorkspacePrivatePath(root, agentsDir, { skipsHiddenPaths: true })
		) {
			recordSourceConnectionFailure("obsidian", "private workspace path");
			return c.json({ error: "Folder includes Signet's private workspace data" }, 400);
		}
		const excludeGlobs = Array.isArray(body.excludeGlobs)
			? body.excludeGlobs.filter((entry) => typeof entry === "string")
			: undefined;
		const releaseSourceMutation = await beginSourceMutationLease(c, agentsDir, sourceIdForObsidian(root));
		if (typeof releaseSourceMutation !== "function") return releaseSourceMutation;
		try {
			const writeScope = resolveSourceWriteIdentity(c);
			if (!writeScope.ok) return c.json({ error: writeScope.error }, 403);
			const result = addObsidianSource(
				{ root, name: body.name, excludeGlobs, writeIdentity: writeScope.identity },
				agentsDir,
			);
			if (result.ok === false) {
				recordSourceConnectionFailure("obsidian", result.error);
				return c.json({ error: result.error }, 400);
			}
			await recordSourceConnected(result.source, writeScope.identity.agentId);

			const job = enqueueSourceIndexJob({
				source: result.source,
				agentsDir,
				startBridge,
				purgeNativeSource,
				recordIndexOperation,
			});

			return c.json(
				{ source: publicSource(result.source), created: result.created, indexed: 0, queued: true, job },
				202,
			);
		} finally {
			releaseSourceMutation();
		}
	});

	app.post("/api/sources/discord", async (c) => {
		let body: AddDiscordSourceBody = {};
		try {
			body = (await jsonBody(c)()) as AddDiscordSourceBody;
		} catch {
			recordSourceConnectionFailure("discord", "invalid configuration");
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const desktopCachePath =
			typeof body.desktopCachePath === "string" && body.desktopCachePath.trim() ? body.desktopCachePath : undefined;
		if (body.syncMode === "desktop-cache" || desktopCachePath !== undefined) {
			const denied = await requirePermission("admin", authConfig)(c, () => Promise.resolve());
			if (denied) return denied;
		}
		if (
			desktopCachePath !== undefined &&
			exposesWorkspacePrivatePath(desktopCachePath, agentsDir, { skipsHiddenPaths: false })
		) {
			recordSourceConnectionFailure("discord", "private workspace path");
			return c.json({ error: "Folder includes Signet's private workspace data" }, 400);
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
		const releaseSourceMutation = await beginSourceMutationLease(c, agentsDir, sourceIdForDiscord(body, guildIds));
		if (typeof releaseSourceMutation !== "function") return releaseSourceMutation;
		try {
			const writeScope = resolveSourceWriteIdentity(c);
			if (!writeScope.ok) return c.json({ error: writeScope.error }, 403);
			const result = addDiscordSource(
				{
					writeIdentity: writeScope.identity,
					guildIds,
					tokenRef: typeof body.tokenRef === "string" ? body.tokenRef : "",
					name: body.name,
					desktopCachePath,
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
			await recordSourceConnected(result.source, writeScope.identity.agentId);

			const job = enqueueSourceIndexJob({
				source: result.source,
				agentsDir,
				startBridge,
				purgeNativeSource,
				recordIndexOperation,
			});

			return c.json(
				{ source: publicSource(result.source), created: result.created, indexed: 0, queued: true, job },
				202,
			);
		} finally {
			releaseSourceMutation();
		}
	});

	app.get("/api/sources/:sourceId/snapshot", async (c) => {
		const resolved = await resolveRouteReadScope(c, { allowAllAgents: true });
		if (resolved instanceof Response) return resolved;
		const source = loadSourcesConfig(agentsDir).sources.find(
			(entry) =>
				entry.id === c.req.param("sourceId") &&
				!isSourceGenerationTombstoned(
					entry,
					loadTombstonedSourceGenerations(
						agentsDir,
						typeof entry.providerSettings?.agentId === "string"
							? entry.providerSettings.agentId
							: resolveDaemonAgentId(),
					),
				),
		);
		if (
			!source ||
			legacySourceMutationDenied(c, source) ||
			!(await sourceReadable(c, source, resolved.agentId, resolved.scope))
		)
			return c.json({ error: "Source not found" }, 404);
		return c.json(
			await contentRead<import("../source-snapshots").SourceSnapshot>(
				{
					op: "source_snapshot",
					source,
					agentId: resolved.agentId,
					scope: resolved.scope,
					includeLocalDiscord: c.req.query("includeLocalDiscord") === "true",
				},
				c.req.raw.signal,
			),
		);
	});

	app.get("/api/sources/:sourceId/health", async (c) => {
		const resolved = await resolveRouteReadScope(c, { allowAllAgents: true });
		if (resolved instanceof Response) return resolved;
		const source = loadSourcesConfig(agentsDir).sources.find(
			(entry) =>
				entry.id === c.req.param("sourceId") &&
				!isSourceGenerationTombstoned(
					entry,
					loadTombstonedSourceGenerations(
						agentsDir,
						typeof entry.providerSettings?.agentId === "string"
							? entry.providerSettings.agentId
							: resolveDaemonAgentId(),
					),
				),
		);
		if (
			!source ||
			legacySourceMutationDenied(c, source) ||
			!(await sourceReadable(c, source, resolved.agentId, resolved.scope))
		)
			return c.json({ error: "Source not found" }, 404);
		const stats = await sourceStats(source, resolved.agentId, resolved.scope);
		const health = await sourceHealth(source, resolved.agentId, stats, resolved.scope);
		return c.json({
			source: {
				...publicSource(source),
				...(c.get("organization") ? { lastIndexedAt: health.latestArtifactAt ?? undefined } : {}),
			},
			stats,
			health,
		});
	});

	app.post("/api/sources/:sourceId/snapshot/import", async (c) => {
		const startedAt = Date.now();
		const writeScope = resolveSourceWriteIdentity(c);
		if (!writeScope.ok) return c.json({ error: writeScope.error }, 403);
		const sourceId = c.req.param("sourceId");
		const source = findConfiguredSource(sourceId, agentsDir, writeScope.identity.agentId);
		if (!source || (source.writeIdentity && source.writeIdentity.agentId !== writeScope.identity.agentId))
			return c.json({ error: "Source not found" }, 404);
		if (legacySourceMutationDenied(c, source)) return c.json({ error: "permission", required: "admin" }, 403);
		if (isSourceImportBlocked(source.id)) {
			return c.json({ error: "Source snapshot import cannot run while source indexing is queued or running" }, 409);
		}
		const releaseSourceMutation = beginSourceMutation(source.id);
		if (releaseSourceMutation === undefined) return c.json({ error: SOURCE_OPERATION_IN_PROGRESS_ERROR }, 409);
		markSourceIndexInFlight(source.id);
		try {
			let body: unknown;
			try {
				body = await jsonBody(c)();
			} catch {
				await recordSourceIndexOperation({
					source,
					agentId: writeScope.identity.agentId,
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
			const result = await importSnapshot({
				author: writeScope.author,
				source,
				agentId: writeScope.identity.agentId,
				snapshot: body,
				includeLocalDiscord: c.req.query("includeLocalDiscord") === "true",
			});
			if (result.ok === false) {
				await recordSourceIndexOperation({
					source,
					agentId: writeScope.identity.agentId,
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
				agentId: writeScope.identity.agentId,
				discovered: result.imported + result.skipped.localDiscordArtifacts,
				accepted: result.imported,
				skipped: result.skipped.localDiscordArtifacts,
				durationMs: Date.now() - startedAt,
				outcome: "success",
				updateFreshness: false,
				searchable: await sourceHasSearchableArtifacts(source, writeScope.identity.agentId),
			});
			return c.json(result);
		} finally {
			clearSourceIndexInFlight(source.id);
			releaseSourceMutation();
		}
	});

	app.post("/api/sources/github", async (c) => {
		let body: AddGitHubSourceBody = {};
		try {
			body = (await jsonBody(c)()) as AddGitHubSourceBody;
		} catch {
			recordSourceConnectionFailure("github", "invalid configuration");
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const repos = Array.isArray(body.repos)
			? body.repos.filter((entry): entry is string => typeof entry === "string")
			: typeof body.repo === "string"
				? [body.repo]
				: [];
		const releaseSourceMutation = await beginSourceMutationLease(c, agentsDir, sourceIdForGitHub(repos));
		if (typeof releaseSourceMutation !== "function") return releaseSourceMutation;
		try {
			const writeScope = resolveSourceWriteIdentity(c);
			if (!writeScope.ok) return c.json({ error: writeScope.error }, 403);
			const result = addGitHubSource(
				{
					writeIdentity: writeScope.identity,
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
			await recordSourceConnected(result.source, writeScope.identity.agentId);

			const job = enqueueSourceIndexJob({
				source: result.source,
				agentsDir,
				startBridge,
				purgeNativeSource,
				recordIndexOperation,
			});

			return c.json(
				{ source: publicSource(result.source), created: result.created, indexed: 0, queued: true, job },
				202,
			);
		} finally {
			releaseSourceMutation();
		}
	});

	app.post("/api/sources/notion", async (c) => {
		let parsed: unknown;
		try {
			parsed = await jsonBody(c)();
		} catch {
			recordSourceConnectionFailure("notion", "invalid configuration");
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const body = parseAddNotionSourceBody(parsed);
		if ("error" in body) {
			recordSourceConnectionFailure("notion", "invalid configuration");
			return c.json({ error: body.error }, 400);
		}
		const releaseSourceMutation = await beginSourceMutationLease(c, agentsDir, notionSourceId(body.tokenRef));
		if (typeof releaseSourceMutation !== "function") return releaseSourceMutation;
		try {
			const writeScope = resolveSourceWriteIdentity(c);
			if (!writeScope.ok) return c.json({ error: writeScope.error }, 403);
			const result = addNotionSource({ ...body, writeIdentity: writeScope.identity }, agentsDir);
			if (result.ok === false) {
				recordSourceConnectionFailure("notion", result.error);
				return c.json({ error: result.error }, 400);
			}
			await recordSourceConnected(result.source, writeScope.identity.agentId);
			const job = enqueueSourceIndexJob({
				source: result.source,
				agentsDir,
				startBridge,
				purgeNativeSource,
				recordIndexOperation,
			});
			return c.json(
				{ source: publicSource(result.source), created: result.created, indexed: 0, queued: true, job },
				202,
			);
		} finally {
			releaseSourceMutation();
		}
	});

	app.post("/api/sources/web", async (c) => {
		let body: AddWebSourceBody = {};
		try {
			const parsed = (await jsonBody(c)()) as unknown;
			body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AddWebSourceBody) : {};
		} catch {
			recordSourceConnectionFailure("web", "invalid configuration");
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const releaseSourceMutation = await beginSourceMutationLease(c, agentsDir, sourceIdForWeb(body.url));
		if (typeof releaseSourceMutation !== "function") return releaseSourceMutation;
		try {
			const writeScope = resolveSourceWriteIdentity(c);
			if (!writeScope.ok) return c.json({ error: writeScope.error }, 403);
			const result = addWebSource(
				{
					writeIdentity: writeScope.identity,
					url: typeof body.url === "string" ? body.url : "",
					name: typeof body.name === "string" ? body.name : undefined,
				},
				agentsDir,
			);
			if (result.ok === false) {
				recordSourceConnectionFailure("web", result.error);
				return c.json({ error: result.error }, 400);
			}
			await recordSourceConnected(result.source, writeScope.identity.agentId);
			const job = enqueueSourceIndexJob({
				source: result.source,
				agentsDir,
				startBridge,
				purgeNativeSource,
				recordIndexOperation,
			});
			return c.json(
				{ source: publicSource(result.source), created: result.created, indexed: 0, queued: true, job },
				202,
			);
		} finally {
			releaseSourceMutation();
		}
	});

	app.delete("/api/sources/:sourceId", async (c) => {
		const sourceId = c.req.param("sourceId");
		const writeScope = resolveSourceWriteIdentity(c);
		if (!writeScope.ok) return c.json({ error: writeScope.error }, 403);
		const source = findConfiguredSource(sourceId, agentsDir, writeScope.identity.agentId, { includeTombstoned: true });
		if (source === undefined || (source.writeIdentity && source.writeIdentity.agentId !== writeScope.identity.agentId))
			return c.json({ error: "Source not found" }, 404);
		if (legacySourceMutationDenied(c, source)) return c.json({ error: "permission", required: "admin" }, 403);
		const sourceAgentId = writeScope.identity.agentId;
		if (source.kind === "import" && source.providerSettings?.agentId !== sourceAgentId)
			return c.json({ error: "Source not found" }, 404);
		const releaseSourceDeletion = beginSourceDeletion(source.id);
		if (releaseSourceDeletion === undefined) {
			const error = isSourceDeletionInFlight(source.id)
				? SOURCE_DELETION_IN_PROGRESS_ERROR
				: SOURCE_OPERATION_IN_PROGRESS_ERROR;
			return c.json({ error }, 409);
		}
		let deferRelease = false;
		try {
			cancelSourceIndexJob(source.id);
			recordSourceDeletionTombstone(source, sourceAgentId, agentsDir);
			const provider = getSourceProvider(source.kind);
			let purged = 0;
			try {
				await removeSourceLifecycleState(source, sourceAgentId);
				purged += await purgeSourceOwnedRows({ sourceId: source.id, agentId: sourceAgentId });
				if (provider) purged += await purgeSource(provider, source, sourceAgentId, purgeNativeSource);
			} catch (error) {
				deferRelease = true;
				return sourceDeletionPending(c, source, purged, error);
			}
			const result = removeSourceIfGeneration(sourceId, source.generation, agentsDir);
			if (result.ok === false) {
				deferRelease = true;
				return sourceDeletionPending(c, source, purged, new Error(result.error));
			}
			const cleanupPending = isSourceIndexInFlight(source.id);
			if (!cleanupPending) {
				try {
					clearSourceDeletionTombstone(source, sourceAgentId, agentsDir);
				} catch (error) {
					logger.warn("system", `Source deletion completed for ${source.id}; cleanup marker remains for retry`, {
						error: error instanceof Error ? error.message : String(error),
					});
					return c.json({ source: publicSource(result.source ?? source), purged, cleanupPending: true });
				}
			}
			if (cleanupPending) {
				deferRelease = true;
				return c.json({ source: publicSource(result.source ?? source), purged, cleanupPending: true });
			}
			return c.json({ source: publicSource(result.source ?? source), purged });
		} finally {
			if (deferRelease) releaseSourceDeletionAfterIndexRuns(source.id, releaseSourceDeletion);
			else releaseSourceDeletion();
		}
	});
}

function sourceDeletionPending(c: Context, source: SignetSourceEntry, purged: number, error: unknown): Response {
	logger.warn("system", `Source deletion deferred for ${source.id}; retry remains available`, {
		error: error instanceof Error ? error.message : String(error),
	});
	return c.json({ source: publicSource(source), purged, pending: true }, 202);
}

function legacySourceMutationDenied(c: Context, source: SignetSourceEntry): boolean {
	return Boolean(c.get("organization")) && !source.writeIdentity && c.get("principal")?.role !== "admin";
}

function publicSource(source: SignetSourceEntry) {
	return {
		id: source.id,
		kind: source.kind,
		name: source.name,
		root: source.root,
		enabled: source.enabled,
		mode: source.mode,
		createdAt: source.createdAt,
		updatedAt: source.updatedAt,
		lastIndexedAt: source.lastIndexedAt,
		excludeGlobs: source.excludeGlobs,
		providerSettings: publicSourceSettings(source.providerSettings),
	};
}

function publicSourceSettings(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(publicSourceSettings);
	if (typeof value !== "object" || value === null) return value;
	const internal = new Set([
		"writeidentity",
		"authorcredential",
		"authoruserid",
		"agentid",
		"generation",
		"contenthash",
		"importkey",
		"compartmentid",
		"normalizedcontent",
		"vectorclock",
		"idempotencykey",
		"rowid",
	]);
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !internal.has(key.replaceAll("_", "").toLowerCase()))
			.map(([key, entry]) => [key, publicSourceSettings(entry)]),
	);
}

async function beginSourceMutationLease(
	c: Context,
	agentsDir: string,
	sourceId: string | undefined,
): Promise<(() => void) | Response> {
	if (sourceId === undefined) return () => {};
	const source = loadSourcesConfig(agentsDir).sources.find((entry) => entry.id === sourceId);
	if (source && legacySourceMutationDenied(c, source)) return c.json({ error: "permission", required: "admin" }, 403);
	if (currentWritePrincipal()) {
		const writeScope = resolveSourceWriteIdentity(c);
		if (writeScope.ok === false) return c.json({ error: writeScope.error }, 401);
		await admitWriteDestination(writeScope.identity.agentId, { sourceId }, c.req.path, undefined);
	}
	const release = beginSourceMutation(sourceId);
	if (release === undefined) return c.json({ error: SOURCE_OPERATION_IN_PROGRESS_ERROR }, 409);
	return release;
}

function sourceIdForObsidian(root: string): string | undefined {
	if (typeof root !== "string") return undefined;
	const trimmed = root.trim();
	const normalized = trimmed ? resolve(trimmed) : root;
	return `obsidian:${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

function sourceIdForWeb(url: string | undefined): string | undefined {
	if (url === undefined) return undefined;
	const normalized = normalizePublicWebUrl(url);
	return normalized === null ? undefined : `web:${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

function sourceIdForDiscord(body: AddDiscordSourceBody, guildIds: readonly string[]): string {
	const settings = parseDiscordSettings({
		guildIds,
		desktopCachePath: body.desktopCachePath,
		syncMode: body.syncMode,
	});
	const root =
		settings.syncMode === "desktop-cache"
			? (settings.desktopCachePath ?? DEFAULT_DISCORD_DESKTOP_CACHE_PATH)
			: `discord://guilds/${settings.guildIds.slice().sort().join(",")}`;
	return settings.syncMode === "desktop-cache"
		? `discord-cache:${createHash("sha256").update(root).digest("hex").slice(0, 16)}`
		: `discord:${createHash("sha256").update(settings.guildIds.slice().sort().join(",")).digest("hex").slice(0, 16)}`;
}

function parseAddNotionSourceBody(
	value: unknown,
): { readonly tokenRef: string; readonly name?: string; readonly maxPages?: number } | { readonly error: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Request body must be an object" };
	const body = value as Record<string, unknown>;
	if (typeof body.tokenRef !== "string") return { error: "Notion tokenRef is required" };
	if (body.name !== undefined && typeof body.name !== "string") return { error: "Notion name must be a string" };
	if (body.maxPages !== undefined && typeof body.maxPages !== "number")
		return { error: "Notion maxPages must be a number" };
	return {
		tokenRef: body.tokenRef,
		...(typeof body.name === "string" ? { name: body.name } : {}),
		...(typeof body.maxPages === "number" ? { maxPages: body.maxPages } : {}),
	};
}

function sourceIdForGitHub(repos: readonly string[]): string {
	const settings = parseGitHubSettings({ repos });
	return `github:${createHash("sha256").update(settings.repos.slice().sort().join(",")).digest("hex").slice(0, 16)}`;
}

function releaseSourceDeletionAfterIndexRuns(sourceId: string, release: () => void): void {
	const runs = getSourceIndexRuns(sourceId).map((activeRun) => activeRun.run);
	if (runs.length === 0) {
		release();
		return;
	}
	void Promise.allSettled(runs).then(release);
}

export async function finalizeCancelledSourceIndexJob(input: {
	readonly source: SignetSourceEntry;
	readonly jobId: string;
	readonly agentsDir: string;
	readonly agentId: string;
	readonly purgeNativeSource?: typeof purgeNativeMemorySourceArtifacts;
}): Promise<void> {
	if (!consumeCanceledSourceIndexJob(input.jobId) || sourceIndexStopping) return;
	const tombstone = loadSourceDeletionTombstones(input.agentsDir).find(
		(entry) =>
			entry.source.id === input.source.id &&
			entry.source.generation === input.source.generation &&
			entry.agentId === input.agentId,
	);
	if (!tombstone) return;
	const configuredSource = loadSourcesConfig(input.agentsDir).sources.find(
		(configured) => configured.id === input.source.id,
	);
	if (configuredSource !== undefined && configuredSource.generation !== input.source.generation) return;
	const provider = getSourceProvider(input.source.kind);
	try {
		await removeSourceLifecycleState(input.source, input.agentId);
		await purgeSourceOwnedRows({ sourceId: input.source.id, agentId: input.agentId });
		if (provider) {
			await purgeSource(
				provider,
				input.source,
				input.agentId,
				input.purgeNativeSource ?? purgeNativeMemorySourceArtifacts,
			);
		}
		const removed = removeSourceIfGeneration(input.source.id, input.source.generation, input.agentsDir);
		if (!removed.ok) throw new Error(removed.error);
		clearSourceDeletionTombstone(input.source, input.agentId, input.agentsDir);
	} catch (error) {
		logger.warn("system", `Source deletion finalization failed for source ${input.source.id}; deferring to next boot`, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
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
	return source.writeIdentity
		? source.writeIdentity.agentId === agentId
		: source.kind !== "import" || source.providerSettings?.agentId === agentId;
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
	return withWritePrincipal(undefined, () => executeSourceIndexJob(input, job));
}

async function executeSourceIndexJob(input: SourceIndexJobInput, job: SourceIndexJob): Promise<void> {
	const startedAt = Date.now();
	const agentId = input.source.writeIdentity?.agentId;
	if (!agentId) {
		failSourceIndexJob(input.source.id, job.id, new Error("source_identity_required"));
		return;
	}
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
		bridge = input.startBridge(
			[{ ...provider.toNativeSource(input.source), writeIdentity: input.source.writeIdentity }],
			{
				agentId,
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
			},
		);
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
		try {
			await finalizeCancelledSourceIndexJob({
				source: input.source,
				jobId: job.id,
				agentsDir: input.agentsDir,
				agentId,
				purgeNativeSource: input.purgeNativeSource,
			});
		} finally {
			clearSourceIndexInFlight(input.source.id);
		}
	}
}

function scheduleSourceIndexJob(input: SourceIndexJobInput, job: SourceIndexJob, delayMs: number): void {
	if (sourceIndexStopping) return;
	const timer = setTimeout(() => {
		sourceIndexTimers.delete(timer);
		if (!isCurrentSourceIndexJob(input.source.id, job.id)) return;
		const run = runSourceIndexJob(input, job);
		trackSourceIndexRun({ sourceId: input.source.id, jobId: job.id, kind: "route", run });
	}, delayMs);
	sourceIndexTimers.add(timer);
	timer.unref?.();
}
export async function cleanupSourceDeletionTombstones(
	agentsDir = resolveDefaultBasePath(),
	purgeNativeSource: typeof purgeNativeMemorySourceArtifacts = purgeNativeMemorySourceArtifacts,
): Promise<void> {
	const tombstones = loadSourceDeletionTombstones(agentsDir);
	if (tombstones.length === 0) return;
	const remaining: SourceDeletionTombstone[] = [];
	const processedTombstoneIds = new Set<string>();
	const releaseSourceDeletions: Array<() => void> = [];
	try {
		for (const tombstone of tombstones) {
			const releaseSourceDeletion = beginSourceDeletion(tombstone.source.id);
			if (releaseSourceDeletion === undefined) {
				remaining.push(tombstone);
				continue;
			}
			releaseSourceDeletions.push(releaseSourceDeletion);
			const configured = loadSourcesConfig(agentsDir).sources.find(
				(source: SignetSourceEntry) => source.id === tombstone.source.id,
			);
			if (configured !== undefined && configured.generation !== tombstone.source.generation) {
				remaining.push(tombstone);
				continue;
			}
			const provider = getSourceProvider(tombstone.source.kind);
			try {
				await removeSourceLifecycleState(tombstone.source, tombstone.agentId);
				await purgeSourceOwnedRows({ sourceId: tombstone.source.id, agentId: tombstone.agentId });
				if (provider) await purgeSource(provider, tombstone.source, tombstone.agentId, purgeNativeSource);
				const removed = removeSourceIfGeneration(tombstone.source.id, tombstone.source.generation, agentsDir);
				if (!removed.ok) throw new Error(removed.error);
				processedTombstoneIds.add(tombstone.id);
			} catch (err) {
				remaining.push(tombstone);
				logger.warn(
					"system",
					`Source-deletion tombstone cleanup failed for source ${tombstone.source.id}; deferring to next boot`,
					{ error: err instanceof Error ? err.message : String(err) },
				);
			}
		}
		const latest = loadSourceDeletionTombstones(agentsDir);
		const merged = new Map<string, SourceDeletionTombstone>();
		for (const tombstone of remaining) merged.set(tombstone.id, tombstone);
		for (const tombstone of latest) {
			if (!processedTombstoneIds.has(tombstone.id)) merged.set(tombstone.id, tombstone);
		}
		saveSourceDeletionTombstones([...merged.values()], agentsDir);
	} finally {
		for (const releaseSourceDeletion of releaseSourceDeletions.reverse()) releaseSourceDeletion();
	}
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
	return join(resolveWorkspaceLayout(agentsDir).runtime, "source-deletion-tombstones.json");
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
	readonly hasEligibleUnconsumedEvidence: boolean;
}

interface SourceHealth {
	readonly status: "healthy" | "degraded" | "unhealthy" | "empty" | "unknown";
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

async function sourceStats(source: SignetSourceEntry, agentId: string, scope?: ReadScope): Promise<SourceStats> {
	const rootPrefix = `${source.root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
	const chunkPrefix = `${source.id}:`;
	try {
		const artifactParams =
			source.kind === "obsidian" ? [agentId, source.id, rootPrefix, `${rootPrefix}\uffff`] : [agentId, source.id];
		const [artifactRow, chunkRow, hasEligibleUnconsumedEvidence] = await Promise.all([
			sourceReadQuery<{ n: number }>(scope, "sources.stats_artifacts", artifactParams, { deadlineMs: 3_000 }),
			sourceReadQuery<{ n: number }>(
				scope,
				"sources.stats_chunks",
				[agentId, SOURCE_CHUNK_SOURCE_TYPE, LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE, chunkPrefix, `${chunkPrefix}\uffff`],
				{ deadlineMs: 3_000 },
			),
			scope
				? contentRead<boolean>({
						op: "source_eligibility",
						scope,
						sourceId: source.id,
						legacyRoot: source.kind === "obsidian" ? source.root : undefined,
					})
				: dbOwnerSourceEvidenceEligibility(
						{
							agentId,
							sourceEntryId: source.id,
							legacyObsidianRoot: source.kind === "obsidian" ? source.root : undefined,
						},
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

async function sourceHealth(
	source: SignetSourceEntry,
	agentId: string,
	stats: SourceStats,
	scope?: ReadScope,
): Promise<SourceHealth> {
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
			artifactHealthSummary(source, agentId, scope),
			discordHealthSummary(source, agentId, scope),
			semanticHealthSummary(source, agentId, scope),
			sourceOrphanChunks(source, agentId, scope),
		]);
		const sourceFailures = source.kind === "discord" ? { total: 0, recoverable: 0 } : artifactSummary.failures;
		const importExtraction =
			(!scope || scope.compartments === "all") && source.kind === "import"
				? readImportedSourceOutcome(source.id, agentId)
				: undefined;
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
			status: "unknown",
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
const SOURCE_HEALTH_PAGE_ROWS = 500;

async function pagedSourceHealthRows<Row extends { readonly rowid: number }>(
	params: readonly DbOwnerParameter[],
	operation: NamedReadOperation,
	visit: (rows: readonly Row[]) => void,
	scope?: ReadScope,
): Promise<void> {
	let cursor = 0;
	for (let page = 0; page < 20; page++) {
		const rows = await sourceReadQuery<Row[]>(scope, operation, [...params, cursor, SOURCE_HEALTH_PAGE_ROWS], {
			deadlineMs: 5_000,
		});
		visit(rows);
		const last = rows.at(-1);
		if (!last || rows.length < SOURCE_HEALTH_PAGE_ROWS) return;
		cursor = last.rowid;
	}
	throw new Error("Source health exceeds the 10000-row admission limit");
}

async function sourceOrphanChunks(source: SignetSourceEntry, agentId: string, scope?: ReadScope): Promise<number> {
	const chunkPrefix = `${source.id}:`;
	const livePaths = await liveSourceArtifactPaths(source, agentId, scope);
	let orphans = 0;
	await pagedSourceHealthRows<SourceChunkHealthRow>(
		[agentId, SOURCE_CHUNK_SOURCE_TYPE, LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE, chunkPrefix, `${chunkPrefix}\uffff`],
		"sources.health_orphan_chunks",
		(rows) => {
			for (const chunk of rows) if (!sourceChunkMatchesLiveArtifact(source, chunk, livePaths)) orphans++;
		},
		scope,
	);
	return orphans;
}

async function liveSourceArtifactPaths(
	source: SignetSourceEntry,
	agentId: string,
	scope?: ReadScope,
): Promise<ReadonlySet<string>> {
	const paths = new Set<string>();
	const collect = (rows: readonly SourcePathHealthRow[]): void => {
		for (const row of rows) paths.add(normalizeSourcePath(row.source_path));
	};
	if (source.kind === "obsidian") {
		const rootPrefix = `${source.root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
		await pagedSourceHealthRows<SourcePathHealthRow>(
			[agentId, source.id, rootPrefix, `${rootPrefix}\uffff`],
			"sources.health_live_paths",
			collect,
			scope,
		);
		return paths;
	}
	await pagedSourceHealthRows<SourcePathHealthRow>([agentId, source.id], "sources.health_live_paths", collect, scope);
	return paths;
}

interface SourceChunkHealthRow {
	readonly rowid: number;
	readonly source_id: string;
	readonly chunk_text: string | null;
}

interface SourcePathHealthRow {
	readonly rowid: number;
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
	scope?: ReadScope,
): Promise<{
	readonly latestArtifactAt: string | null;
	readonly deletedArtifacts: number;
	readonly failures: {
		readonly total: number;
		readonly recoverable: number;
	};
}> {
	const rootPrefix = `${source.root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
	const params =
		source.kind === "obsidian" ? [agentId, source.id, rootPrefix, `${rootPrefix}\uffff`] : [agentId, source.id];
	const [row, failures] = await Promise.all([
		sourceReadQuery<HealthAggregateRow | undefined>(scope, "sources.health_artifacts", params, { deadlineMs: 3_000 }),
		sourceFailureHealthFromDb(source, agentId, scope),
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
	scope?: ReadScope,
): Promise<{ readonly total: number; readonly recoverable: number }> {
	const rows = await sourceReadQuery<Array<{ readonly source_meta_json: string | null }>>(
		scope,
		"sources.health_failures",
		[agentId, source.id, `source_${source.kind}_failure`],
		{ deadlineMs: 3_000 },
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

async function discordHealthSummary(
	source: SignetSourceEntry,
	agentId: string,
	scope?: ReadScope,
): Promise<DiscordHealthSummary> {
	if (source.kind !== "discord") {
		return {
			latestCheckpointAt: null,
			failures: { total: 0, recoverable: 0 },
			checkpoints: { total: 0, partial: 0, stale: 0 },
		};
	}
	const rows = await sourceReadQuery<DiscordHealthRow[]>(scope, "sources.health_discord", [agentId, source.id], {
		deadlineMs: 5_000,
	});
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

async function semanticHealthSummary(
	source: SignetSourceEntry,
	agentId: string,
	scope?: ReadScope,
): Promise<SourceHealth["semantic"]> {
	const [entityRow, documentEntity, aspectsRow, attributesRow, dependenciesRow, communitiesRow] = await Promise.all([
		sourceReadQuery<{ n: number }>(scope, "sources.health_entities", [agentId, source.id], { deadlineMs: 3_000 }),
		sourceReadQuery<{ id: string } | undefined>(scope, "sources.health_document_entity", [agentId, source.id], {
			deadlineMs: 3_000,
		}),
		sourceReadQuery<{ n: number }>(scope, "sources.health_aspects", [agentId, source.id], { deadlineMs: 3_000 }),
		sourceReadQuery<{ n: number }>(scope, "sources.health_attributes", [agentId, source.id], { deadlineMs: 3_000 }),
		sourceReadQuery<{ n: number }>(scope, "sources.health_dependencies", [agentId, source.id], { deadlineMs: 3_000 }),
		sourceReadQuery<{ n: number }>(scope, "sources.health_communities", [agentId, source.id], { deadlineMs: 3_000 }),
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
