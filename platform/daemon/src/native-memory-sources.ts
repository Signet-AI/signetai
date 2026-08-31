import { lstat, readFile, stat } from "node:fs/promises";

import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
	DEFAULT_OBSIDIAN_EXCLUDE_GLOBS,
	LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE,
	SOURCE_CHUNK_SOURCE_TYPE,
	loadSourcesConfig,
	markSourceIndexed,
	resolveHermesHomePath,
} from "@signet/core";
import { resolveDaemonAgentId } from "./agent-id";
import { yieldEvery } from "./async-yield";
import {
	dbOwnerBatch,
	dbOwnerQuery,
	dbOwnerSourceGraphFilePurge,
	dbOwnerSourceGraphPurge,
	dbOwnerSourceNativeMemoryIndex,
	ownerStatement,
} from "./db-owner-runtime";
import { EPISODIC_CAPTURED_AT_FLOOR, timestampMillis } from "./episodic-sources";
import { hasDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { awaitEmbeddingProviderAvailable, recordEmbeddingProviderFailure } from "./embedding-circuit-breaker";
import {
	nativeSourceSyncKey,
	persistNativeSourceSyncState,
	readNativeSourceSyncState,
	clearNativeSourceSyncCheckpoint,
} from "./native-source-sync-state";
import type { EmbeddingConfig } from "./memory-config";
import { hashNormalizedBody, softDeleteArtifactRowsForPath } from "./memory-lineage";
import {
	type SourceEmbeddingFetch,
	type ObsidianSourceChunk,
	buildObsidianSourceChunks,
	indexObsidianSourceEmbeddingsViaOwner,
	purgeObsidianSourceEmbeddingsViaOwner,
	purgeObsidianSourceFileEmbeddingsViaOwner,
	resetObsidianSourceEmbeddingBackoff,
} from "./obsidian-source-embeddings";
import { type ObsidianMarkdownPathIndex, sourceIdForObsidianRoot } from "./obsidian-source-graph";
import {
	createNativeSourceWorker,
	type NativeSourceWorkerPage,
	type NativeSourceWorkerSource,
} from "./native-memory-source-worker";

/** Keep one owner-side source descriptor bounded without using the 5s default. */
export const NATIVE_MEMORY_OWNER_DEADLINE_MS = 60_000;
const EMBEDDING_PROVIDER_PROBE_TEXT = "Signet embedding provider health check.";

export interface NativeMemorySource {
	readonly harness: string;
	readonly displayName: string;
	readonly root: string;
	/** Root used for stable provenance paths when the scan root is a subdirectory. */
	readonly sourceRoot?: string;
	readonly sourceId?: string;
	readonly files: readonly NativeMemoryFilePattern[];
}

export interface NativeMemoryFilePattern {
	readonly glob: string;
	readonly kind: string;
	readonly include?: (path: string, rel: string) => boolean;
	readonly excludeGlobs?: readonly string[];
	readonly excludeBasenames?: readonly string[];
}

export interface NativeMemorySyncSourceResult {
	readonly sourceKey: string;
	readonly sourceId?: string;
	readonly status: "complete" | "paused";
	readonly scanned: number;
	readonly indexed: number;
	readonly resumeFrontier: string | null;
	readonly pauseReason?: string;
}

export interface NativeMemorySyncResult {
	readonly status: "complete" | "paused";
	readonly scanned: number;
	readonly indexed: number;
	readonly pausedSources: readonly NativeMemorySyncSourceResult[];
}

export interface NativeMemoryBridgeHandle {
	readonly syncExisting: (options?: NativeMemoryBridgeSyncOptions) => Promise<number>;
	readonly getLastSyncResult: () => NativeMemorySyncResult;
	/** Kill the active source worker without taking down the parent or DB owner. */
	readonly cancel: () => void;
	readonly close: () => Promise<void>;
}

export interface NativeMemoryBridgeSyncOptions {
	readonly requestResyncIfBusy?: boolean;
	readonly signal?: AbortSignal;
}

export interface NativeMemoryBridgeOptions {
	readonly agentId?: string;
	readonly pollIntervalMs?: number;
	readonly embeddingConfig?: EmbeddingConfig;
	readonly fetchEmbedding?: SourceEmbeddingFetch;
	readonly agentsDir?: string;
	readonly includeConfiguredSources?: boolean;
	readonly yieldEveryFiles?: number;
	readonly sourceFileDelayMs?: number;
	readonly sourceCleanupEnabled?: boolean;
	readonly shouldCleanupSource?: (source: NativeMemorySource) => boolean;
	readonly sourceGraphEnabled?: boolean;
	/** Test and bounded-scan override. Production scans use the 50,000-file cap. */
	readonly maxFilesPerScan?: number;
	/** Production native scans route descriptors through the killable DB owner. */
	readonly workerOwnedIndexing?: boolean;
	/** Test-only event hook used to kill a source worker during traversal. */
	readonly onSourceWorkerScanStarted?: () => void;
	readonly shouldContinue?: (source: NativeMemorySource) => boolean;
	readonly onEmbeddingStatus?: (status: string | undefined) => void;
	readonly onFileIndexed?: (event: NativeMemoryFileIndexEvent) => void;
}

/**
 * Resolve the embeddingConfig/fetchEmbedding bridge options from a memory
 * config, so source providers actually get their content chunked and
 * embedded after sync instead of only writing memory_artifacts rows.
 */
export function resolveEmbeddingBridgeOptions(
	embeddingCfg: EmbeddingConfig,
	fetchEmbedding: SourceEmbeddingFetch,
): Pick<NativeMemoryBridgeOptions, "embeddingConfig" | "fetchEmbedding"> {
	if (embeddingCfg.provider === "none") return {};
	return { embeddingConfig: embeddingCfg, fetchEmbedding };
}

export interface NativeMemoryFileIndexEvent {
	readonly source: NativeMemorySource;
	readonly filePath: string;
	readonly indexed: boolean;
	readonly scanned: number;
	readonly total: number;
	readonly changed: number;
	readonly status?: string;
}

interface IndexedNativeMemory {
	readonly contentHash: string;
}

const indexed = new Map<string, IndexedNativeMemory>();

interface SharedNativeMemorySourceFlight {
	readonly promise: Promise<NativeMemorySyncSourceResult>;
	readonly resolve: (result: NativeMemorySyncSourceResult) => void;
	readonly reject: (error: unknown) => void;
}

const sharedNativeMemorySourceFlights = new Map<string, SharedNativeMemorySourceFlight>();

/** Test-only: drop the in-process content-hash cache so scans behave like a fresh daemon. */
export interface NativeMemorySourcePermissionIssue {
	readonly path: string;
	readonly guidance: string;
}

export interface NativeMemorySourcePermissionHealth {
	readonly status: "clear" | "denied";
	readonly issues: readonly NativeMemorySourcePermissionIssue[];
}

const permissionDeniedPaths = new Map<string, NativeMemorySourcePermissionIssue>();
const TCC_PERMISSION_GUIDANCE =
	"Grant Full Disk Access to ai.signet.daemon (or the Signet app) in System Settings → Privacy & Security → Full Disk Access.";

export type NativeMemoryReadFailureClass = "permission-denied" | "missing" | "transient" | "unknown";

export function isDarwinPermissionDenied(err: unknown, platform = process.platform): boolean {
	if (platform !== "darwin") return false;
	return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "EACCES";
}

export function classifyNativeMemoryReadFailure(
	err: unknown,
	platform = process.platform,
): NativeMemoryReadFailureClass {
	if (isDarwinPermissionDenied(err, platform)) return "permission-denied";
	if (isEnoentError(err)) return "missing";
	if (err instanceof Error || (typeof err === "object" && err !== null)) return "transient";
	return "unknown";
}

export function nativeMemorySourcePermissionHealth(
	source: Pick<NativeMemorySource, "harness" | "root">,
	agentId: string,
): NativeMemorySourcePermissionHealth {
	const prefix = `${agentId}:${source.harness}:`;
	const root = normalizedRoot(source.root);
	const issues = [...permissionDeniedPaths.entries()]
		.filter(([key]) => {
			if (!key.startsWith(prefix)) return false;
			const path = key.slice(prefix.length);
			return path === root || path.startsWith(`${root}/`);
		})
		.map(([, issue]) => issue);
	return { status: issues.length > 0 ? "denied" : "clear", issues };
}

export function nativeMemoryReadBackoffActive(
	source: Pick<NativeMemorySource, "harness">,
	filePath: string,
	agentId: string,
): boolean {
	const cooldownUntil = readFailureBackoffUntil.get(fingerprintKey(source, filePath, agentId));
	return cooldownUntil !== undefined && Date.now() < cooldownUntil;
}

export function recordNativeMemoryPermissionDenied(
	source: Pick<NativeMemorySource, "harness">,
	filePath: string,
	agentId: string,
): void {
	const key = fingerprintKey(source, filePath, agentId);
	readFailureBackoffUntil.set(key, Date.now() + READ_FAILURE_BACKOFF_MS);
	const issue = {
		path: filePath,
		guidance: `${TCC_PERMISSION_GUIDANCE} Path: ${filePath}`,
	};
	const firstDenied = !permissionDeniedPaths.has(key);
	permissionDeniedPaths.set(key, issue);
	if (firstDenied) logger.warn("watcher", issue.guidance, { path: filePath });
}

export function clearNativeMemoryPermissionDenied(
	source: Pick<NativeMemorySource, "harness">,
	filePath: string,
	agentId: string,
): void {
	const key = fingerprintKey(source, filePath, agentId);
	readFailureBackoffUntil.delete(key);
	permissionDeniedPaths.delete(key);
}

export function resetNativeMemoryIndexCache(): void {
	indexed.clear();
	readFailureBackoffUntil.clear();
	permissionDeniedPaths.clear();
	datalessReadFailuresByHarness.clear();
	resetObsidianSourceEmbeddingBackoff();
}
const DEFAULT_OBSIDIAN_SOURCE_FILE_DELAY_MS = 250;
/** A scan keeps at most one discovered file awaiting indexing. */
export const NATIVE_MEMORY_FILE_QUEUE_CAP = 1;

const NATIVE_MEMORY_MAX_FILES_PER_SCAN = 50_000;

// Read failures that are not permanent (ENOENT) enter a per-path cooldown so
// a failing file cannot monopolize the scan loop. ENOENT drops the path from
// the index entirely — the file is gone, retrying it is pointless (#1142).
const READ_FAILURE_BACKOFF_MS = 60_000;
const readFailureBackoffUntil = new Map<string, number>();

// iCloud / sync-evicted (dataless) files fail every read until the OS
// materializes them. Track them per harness so the daemon logs ONE
// consolidated warning per window instead of one line per file per retry
// (#1161).
const DATALESS_WARN_INTERVAL_MS = 60_000;
const datalessReadFailuresByHarness = new Map<string, { count: number; lastLoggedAt: number }>();

export function isDatalessReadError(err: unknown): boolean {
	// The errno code is authoritative. Message matching is only a fallback
	// for errors that carry no code: node embeds the file path in the
	// message, and a path containing "eio" (e.g. "veio", "deionized")
	// would misclassify an ordinary EACCES as dataless and silently drop
	// its per-file diagnostic.
	if (typeof err === "object" && err !== null) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EDEADLK" || code === "EIO") return true;
	}
	const message = err instanceof Error ? err.message : String(err);
	return /\b(?:EDEADLK|EIO)\b/.test(message);
}

function isEnoentError(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(
	path: string,
	source: Pick<NativeMemorySource, "harness">,
	agentId: string,
): Promise<boolean> {
	if (nativeMemoryReadBackoffActive(source, path, agentId)) return false;
	try {
		await stat(path);
		return true;
	} catch (err) {
		if (classifyNativeMemoryReadFailure(err) === "permission-denied") {
			recordNativeMemoryPermissionDenied(source, path, agentId);
		}
		return false;
	}
}

function codexRoot(): string {
	return join(homedir(), ".codex");
}

function claudeCodeRoot(): string {
	return join(homedir(), ".claude");
}

function sourceIdForCodexRoot(root: string): string {
	return `codex_native_memory:${normalizedRoot(root)}`;
}

function sourceIdForHermesRoot(root: string): string {
	return `hermes_native_memory:${normalizedRoot(root)}`;
}

function hermesProfileRoot(root: string): string {
	const normalized = normalizedRoot(root);
	return basename(normalized) === "memories" ? dirname(normalized) : normalized;
}

function hermesProfileId(root: string): string {
	const normalized = normalizedRoot(root);
	const profilesMarker = "/profiles/";
	const markerIndex = normalized.lastIndexOf(profilesMarker);
	if (markerIndex >= 0) {
		const profile = normalized.slice(markerIndex + profilesMarker.length);
		if (profile.length > 0 && !profile.includes("/")) return profile;
	}
	return basename(normalized) === ".hermes" ? "default" : basename(normalized);
}

export function codexNativeMemorySource(root = codexRoot()): NativeMemorySource {
	return {
		harness: "codex",
		displayName: "Codex",
		root,
		sourceId: sourceIdForCodexRoot(root),
		files: [
			{ glob: "memories/memory_summary.md", kind: "native_memory_summary" },
			{ glob: "memories/MEMORY.md", kind: "native_memory_registry" },
			{ glob: "memories/raw_memories.md", kind: "native_raw_memories" },
			{ glob: "memories/rollout_summaries/*.md", kind: "native_rollout_summary" },
			{ glob: "memories/rollout_summaries/*.jsonl", kind: "native_rollout_summary" },
			{ glob: "memories/skills/**/*.md", kind: "native_skill_memory" },
			{ glob: "memories/extensions/ad_hoc/notes/*.md", kind: "native_ad_hoc_note" },
			{ glob: "automations/*/memory.md", kind: "native_automation_memory" },
		],
	};
}

export function claudeCodeNativeMemorySource(root = claudeCodeRoot()): NativeMemorySource {
	return {
		harness: "claude-code",
		displayName: "Claude Code",
		root,
		files: [
			{ glob: "projects/*/memory/MEMORY.md", kind: "native_claude_memory_index" },
			{
				glob: "projects/*/memory/**/*.md",
				kind: "native_claude_memory",
				include: (path) => basename(path) !== "MEMORY.md",
				excludeBasenames: ["MEMORY.md"],
			},
			{ glob: "session-memory/**/*.md", kind: "native_claude_session_memory" },
			{ glob: "agent-memory/*/*.md", kind: "native_claude_agent_memory" },
			{ glob: "agent-memory-local/*/*.md", kind: "native_claude_agent_memory_local" },
		],
	};
}

/**
 * Hermes keeps curated, profile-local memory in two files under HERMES_HOME.
 * Scan only that declared memory directory; the profile root remains the
 * provenance boundary for source IDs and relative paths.
 */
export function hermesNativeMemorySource(root = resolveHermesHomePath()): NativeMemorySource {
	const profileRoot = hermesProfileRoot(root);
	return {
		harness: "hermes-agent",
		displayName: "Hermes Agent",
		root: join(profileRoot, "memories"),
		sourceRoot: profileRoot,
		sourceId: sourceIdForHermesRoot(profileRoot),
		files: [
			{ glob: "MEMORY.md", kind: "native_hermes_memory" },
			{ glob: "USER.md", kind: "native_hermes_user" },
		],
	};
}

export function obsidianNativeMemorySource(
	root: string,
	displayName = "Obsidian",
	sourceId = sourceIdForObsidianRoot(root),
	excludeGlobs: readonly string[] = DEFAULT_OBSIDIAN_EXCLUDE_GLOBS,
): NativeMemorySource {
	return {
		harness: "obsidian",
		displayName,
		root,
		sourceId,
		files: [
			{
				glob: "**/*.md",
				kind: "source_obsidian_markdown",
				include: (_path, rel) => !isExcludedByGlobs(rel, excludeGlobs),
				excludeGlobs,
			},
		],
	};
}

export function configuredNativeMemorySources(agentsDir?: string): NativeMemorySource[] {
	const configured = loadSourcesConfig(agentsDir)
		.sources.filter((source) => source.enabled && source.kind === "obsidian")
		.map((source) => obsidianNativeMemorySource(source.root, source.name, source.id, source.excludeGlobs));
	return [codexNativeMemorySource(), claudeCodeNativeMemorySource(), hermesNativeMemorySource(), ...configured];
}

function matchesPattern(source: NativeMemorySource, filePath: string): NativeMemoryFilePattern | null {
	const normalized = filePath.replace(/\\/g, "/");
	const root = source.root.replace(/\\/g, "/").replace(/\/$/, "");
	const rel = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
	for (const pattern of source.files) {
		if (pattern.include && !pattern.include(normalized, rel)) continue;
		if (matchesGlob(pattern.glob, rel)) return pattern;
	}
	return null;
}

function matchesGlob(glob: string, rel: string): boolean {
	return matchGlobParts(glob.split("/"), rel.split("/"));
}

function isExcludedByGlobs(rel: string, excludeGlobs: readonly string[]): boolean {
	const normalized = rel.replace(/\\/g, "/").replace(/^\.\//, "");
	return excludeGlobs.some((glob) => {
		const normalizedGlob = glob.replace(/\\/g, "/").replace(/^\.\//, "");
		const vaultWideGlob = normalizedGlob.includes("/") ? normalizedGlob : `**/${normalizedGlob}`;
		return matchesGlob(vaultWideGlob, normalized);
	});
}

function matchGlobParts(globParts: readonly string[], relParts: readonly string[]): boolean {
	if (globParts.length === 0) return relParts.length === 0;
	const [globHead, ...globTail] = globParts;
	if (globHead === "**") {
		return matchGlobParts(globTail, relParts) || (relParts.length > 0 && matchGlobParts(globParts, relParts.slice(1)));
	}
	if (relParts.length === 0) return false;
	return matchesGlobSegment(globHead ?? "", relParts[0] ?? "") && matchGlobParts(globTail, relParts.slice(1));
}

function matchesGlobSegment(glob: string, value: string): boolean {
	if (glob === "*") return value.length > 0;
	if (!glob.includes("*")) return glob === value;
	const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	const pattern = `^${escaped.replace(/\*/g, ".*")}$`;
	return new RegExp(pattern).test(value);
}

function resolveBridgeAgentId(agentId?: string): string {
	const trimmed = agentId?.trim();
	return trimmed ? trimmed : resolveDaemonAgentId();
}

function activeBridgeSources(
	baseSources: readonly NativeMemorySource[],
	options: NativeMemoryBridgeOptions,
): NativeMemorySource[] {
	if (!options.includeConfiguredSources) return [...baseSources];
	const configured = loadSourcesConfig(options.agentsDir)
		.sources.filter((source) => source.enabled && source.kind === "obsidian")
		.map((source) => obsidianNativeMemorySource(source.root, source.name, source.id, source.excludeGlobs));
	const byKey = new Map<string, NativeMemorySource>();
	for (const source of [...baseSources, ...configured]) {
		byKey.set(source.sourceId ?? `${source.harness}:${source.root}`, source);
	}
	return [...byKey.values()];
}

function fingerprintKey(source: Pick<NativeMemorySource, "harness">, filePath: string, agentId: string): string {
	return `${agentId}:${source.harness}:${normalizedRoot(filePath)}`;
}

function sourceStateKey(source: NativeMemorySource, agentId: string): string {
	return `${agentId}:${source.harness}:${source.root.replace(/\\/g, "/").replace(/\/$/, "")}`;
}

function sourceFlightKey(source: NativeMemorySource, agentId: string): string {
	return `${agentId}:${nativeSourceSyncKey(source)}:${normalizedRoot(source.root)}`;
}

function contentFingerprint(content: string): string {
	return hashNormalizedBody(content);
}

function sourceLineCount(content: string): number {
	const normalized = content.replace(/\r\n?/g, "\n").replace(/\n$/, "");
	return normalized.length === 0 ? 0 : normalized.split("\n").length;
}

function normalizedRoot(root: string): string {
	return resolve(root).replace(/\\/g, "/").replace(/\/$/, "");
}

function safeRelativePath(root: string, filePath: string): string | null {
	const rootPath = normalizedRoot(root);
	const resolvedPath = resolve(filePath).replace(/\\/g, "/");
	if (resolvedPath !== rootPath && !resolvedPath.startsWith(`${rootPath}/`)) return null;
	const rel = relative(rootPath, resolvedPath).replace(/\\/g, "/");
	if (!rel || rel.startsWith("../") || rel === "..") return null;
	if (rel.split("/").includes(".git")) return null;
	return rel;
}

function sourceRelativePath(root: string, filePath: string): string {
	return relative(normalizedRoot(root), filePath.replace(/\\/g, "/")).replace(/\\/g, "/");
}

function codexSourceMeta(
	source: NativeMemorySource,
	filePath: string,
	metadata: Pick<NativeSourceWorkerPage["files"][number], "lineCount" | "rolloutId">,
): Record<string, unknown> | undefined {
	if (source.harness !== "codex") return undefined;
	const rel = safeRelativePath(source.root, filePath) ?? sourceRelativePath(source.root, filePath);
	return {
		sourceType: "codex_native_memory",
		provider: "codex",
		displayName: source.displayName,
		relativePath: rel,
		lineStart: metadata.lineCount > 0 ? 1 : 0,
		lineEnd: metadata.lineCount,
		...(metadata.rolloutId ? { rolloutId: metadata.rolloutId } : {}),
	};
}

function hermesSourceMeta(
	source: NativeMemorySource,
	filePath: string,
	metadata: Pick<NativeSourceWorkerPage["files"][number], "lineCount" | "contentHash">,
): Record<string, unknown> | undefined {
	if (source.harness !== "hermes-agent") return undefined;
	const profileRoot = normalizedRoot(source.sourceRoot ?? hermesProfileRoot(source.root));
	const rel = safeRelativePath(source.root, filePath) ?? sourceRelativePath(profileRoot, filePath);
	const profileRelativePath = sourceRelativePath(profileRoot, filePath);
	return {
		sourceType: "hermes_native_memory",
		provider: "hermes-agent",
		displayName: source.displayName,
		profileId: hermesProfileId(profileRoot),
		profileRoot,
		relativePath: profileRelativePath,
		memoryFile: rel,
		lineStart: metadata.lineCount > 0 ? 1 : 0,
		lineEnd: metadata.lineCount,
		contentHash: metadata.contentHash,
		visibility: "private",
		project: null,
	};
}

function sourceFileDelayMs(source: NativeMemorySource, options: NativeMemoryBridgeOptions): number {
	if (options.sourceFileDelayMs !== undefined) {
		return Math.max(0, Math.floor(options.sourceFileDelayMs));
	}
	return source.harness === "obsidian" ? DEFAULT_OBSIDIAN_SOURCE_FILE_DELAY_MS : 0;
}

function sleep(ms: number): Promise<void> {
	return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function nativeArtifactContentHash(
	filePath: string,
	agentId: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const sourcePath = filePath.replace(/\\/g, "/");
	try {
		const row = await dbOwnerQuery<{ readonly source_sha256: string } | null>(
			ownerStatement(
				"SELECT source_sha256 FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0 LIMIT 1",
				[agentId, sourcePath],
				"get",
			),
			{ operation: "sources.artifact-hash", lane: "read", signal },
		);
		return row?.source_sha256 ?? null;
	} catch (error) {
		throw new Error(
			`Owner read failed for native artifact hash at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

async function nativeArtifactCapturedAt(
	filePath: string,
	agentId: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const sourcePath = filePath.replace(/\\/g, "/");
	try {
		const row = await dbOwnerQuery<{ readonly captured_at: string } | null>(
			ownerStatement(
				"SELECT captured_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0 LIMIT 1",
				[agentId, sourcePath],
				"get",
			),
			{ operation: "sources.artifact-captured-at", lane: "read", signal },
		);
		return row?.captured_at ?? null;
	} catch (error) {
		throw new Error(
			`Owner read failed for native artifact timestamp at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

/**
 * One-shot heal for rows already stamped with a corrupt pre-epoch captured_at
 * (the DOS epoch 1980 sentinel): they are re-stamped with the index time so
 * they stop blocking backlog termination and get a normal lifecycle. New
 * indexes never mint sentinels (the memory-lineage clamp), so this only fires
 * once per legacy row (#1149).
 */
async function healSentinelCapturedAt(
	filePath: string,
	agentId: string,
	harness: string,
	capturedAt: string,
	signal?: AbortSignal,
): Promise<void> {
	if (timestampMillis(capturedAt) >= Date.parse(EPISODIC_CAPTURED_AT_FLOOR)) return;
	try {
		const stampedAt = new Date().toISOString();
		await dbOwnerBatch(
			[
				ownerStatement(
					`UPDATE memory_artifacts
					 SET captured_at = ?, updated_at = ?
					 WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0`,
					[stampedAt, stampedAt, agentId, filePath.replace(/\\/g, "/")],
				),
			],
			{
				operation: "sources.artifact-heal",
				lane: "write",
				workloadClass: "maintenance",
				estimatedWorkUnits: 1,
				signal,
			},
		);
		logger.warn("watcher", "Healed pre-epoch captured_at on native memory artifact", {
			harness,
			path: filePath,
			was: capturedAt,
		});
	} catch (err) {
		logger.error(
			"watcher",
			"Could not heal pre-epoch captured_at",
			err instanceof Error ? err : new Error(String(err)),
			{
				path: filePath,
			},
		);
		throw err;
	}
}

async function obsidianGraphExists(
	agentId: string,
	sourceId: string,
	filePath: string,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const row = await dbOwnerQuery<{ readonly "1": number } | null>(
			ownerStatement(
				`SELECT 1 FROM entities
				 WHERE agent_id = ?
				   AND source_id = ?
				   AND source_path = ?
				   AND entity_type = 'source_document'
				 LIMIT 1`,
				[agentId, sourceId, filePath.replace(/\\/g, "/")],
				"get",
			),
			{ operation: "sources.graph-exists", lane: "read", signal },
		);
		return row != null;
	} catch (error) {
		throw new Error(
			`Owner read failed for source graph existence at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

async function obsidianEmbeddingsExist(input: {
	readonly agentId: string;
	readonly sourceId: string;
	readonly root: string;
	readonly filePath: string;
	readonly content: string;
	readonly chunks?: readonly ObsidianSourceChunk[];
	readonly signal?: AbortSignal;
}): Promise<boolean> {
	const chunks = input.chunks ?? buildObsidianSourceChunks(input);
	if (chunks.length === 0) return true;
	try {
		const rows = await dbOwnerQuery<readonly { readonly source_id: string }[]>(
			ownerStatement(
				`SELECT source_id FROM embeddings
				 WHERE agent_id = ?
				   AND source_type IN (?, ?)
				   AND source_id IN (${chunks.map(() => "?").join(", ")})`,
				[
					input.agentId,
					SOURCE_CHUNK_SOURCE_TYPE,
					LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE,
					...chunks.map((chunk) => chunk.id),
				],
				"all",
			),
			{ operation: "sources.embeddings-exists", lane: "read", signal: input.signal },
		);
		return new Set(rows.map((row) => row.source_id)).size === chunks.length;
	} catch (error) {
		throw new Error(
			`Owner read failed for source embedding existence at ${input.filePath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

function workerSource(source: NativeMemorySource): NativeSourceWorkerSource {
	return {
		root: source.root,
		sourceRoot: source.sourceRoot,
		harness: source.harness,
		sourceId: source.sourceId,
		files: source.files.map((pattern) => ({
			glob: pattern.glob,
			kind: pattern.kind,
			...(pattern.excludeGlobs ? { excludeGlobs: pattern.excludeGlobs } : {}),
			...(pattern.excludeBasenames ? { excludeBasenames: pattern.excludeBasenames } : {}),
		})),
	};
}

interface NativeSourceSyncCheckpoint {
	readonly cursor: string | null;
	readonly frontier: readonly string[] | null;
	readonly complete: boolean;
}

async function readNativeSourceSyncCheckpoint(
	agentId: string,
	sourceKey: string,
	phase: string,
	signal?: AbortSignal,
): Promise<NativeSourceSyncCheckpoint> {
	const rows = await dbOwnerQuery<
		readonly { readonly cursor: string | null; readonly frontier: string | null; readonly complete: number }[]
	>(
		ownerStatement(
			"SELECT cursor, frontier, complete FROM source_sync_checkpoints WHERE agent_id = ? AND source_key = ? AND phase = ? LIMIT 1",
			[agentId, sourceKey, phase],
			"all",
		),
		{ operation: "sources.sync-checkpoint.read", lane: "read", signal },
	);
	const row = rows[0];
	let frontier: readonly string[] | null = null;
	if (row?.frontier !== null && row?.frontier !== undefined) {
		try {
			const parsed: unknown = JSON.parse(row.frontier);
			if (Array.isArray(parsed) && parsed.every((path): path is string => typeof path === "string")) frontier = parsed;
		} catch {
			frontier = null;
		}
	}
	return { cursor: row?.cursor ?? null, frontier, complete: row?.complete === 1 };
}

async function writeNativeSourceSyncCheckpoint(
	agentId: string,
	sourceKey: string,
	phase: string,
	checkpoint: NativeSourceSyncCheckpoint,
	scanned: number,
	signal?: AbortSignal,
): Promise<void> {
	await dbOwnerBatch(
		[
			ownerStatement(
				`INSERT INTO source_sync_checkpoints
				 (agent_id, source_key, phase, cursor, frontier, scanned, complete, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
				 ON CONFLICT(agent_id, source_key, phase) DO UPDATE SET
				 cursor = excluded.cursor,
				 frontier = excluded.frontier,
				 scanned = excluded.scanned,
				 complete = excluded.complete,
				 updated_at = excluded.updated_at`,
				[
					agentId,
					sourceKey,
					phase,
					checkpoint.cursor,
					checkpoint.frontier === null ? null : JSON.stringify(checkpoint.frontier),
					scanned,
					checkpoint.complete ? 1 : 0,
				],
			),
		],
		{
			operation: "sources.sync-checkpoint.write",
			lane: "write",
			workloadClass: "maintenance",
			estimatedWorkUnits: 1,
			signal,
		},
	);
}

async function activeNativeArtifactPaths(
	source: NativeMemorySource,
	agentId: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const rootPrefix = `${normalizedRoot(source.root)}/`;
	try {
		const rows = await dbOwnerQuery<readonly { readonly source_path: string }[]>(
			ownerStatement(
				`SELECT source_path FROM memory_artifacts
				 WHERE agent_id = ?
				   AND harness = ?
				   AND (
					   source_id = ?
					   OR (source_id IS NULL AND source_path >= ? AND source_path < ?)
				   )
				   AND source_kind IN (${source.files.map(() => "?").join(", ")})
				   AND COALESCE(is_deleted, 0) = 0`,
				[
					agentId,
					source.harness,
					source.sourceId ?? "",
					rootPrefix,
					prefixUpperBound(rootPrefix),
					...source.files.map((file) => file.kind),
				],
				"all",
			),
			{ operation: "sources.active-artifact-paths", lane: "read", signal },
		);
		return rows.map((row) => row.source_path);
	} catch (error) {
		throw new Error(
			`Owner read failed while listing native memory artifacts for ${source.harness}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

export async function indexNativeMemoryFile(
	source: NativeMemorySource,
	filePath: string,
	agentId = resolveDaemonAgentId(),
	options: Pick<
		NativeMemoryBridgeOptions,
		"embeddingConfig" | "fetchEmbedding" | "sourceGraphEnabled" | "onEmbeddingStatus"
	> & {
		readonly markdownPathIndex?: ObsidianMarkdownPathIndex;
		readonly content?: string;
		readonly mtimeMs?: number;
		readonly contentHash?: string;
		readonly lineCount?: number;
		readonly rolloutId?: string;
		readonly chunks?: readonly ObsidianSourceChunk[];
		readonly sourceId?: string;
		readonly workerOwnedIndexing?: boolean;
		readonly syncCheckpoint?: {
			readonly sourceKey: string;
			readonly scanned: number;
			readonly cursor: string | null;
			readonly frontier: readonly string[] | null;
			readonly complete: boolean;
		};
		readonly syncCheckpointOnProviderFailure?: NativeSourceSyncCheckpoint;
		readonly signal?: AbortSignal;
	} = {},
): Promise<boolean> {
	options.signal?.throwIfAborted();
	if (!safeRelativePath(source.root, filePath)) return false;
	const pattern = matchesPattern(source, filePath);
	if (!pattern) return false;
	// Source-worker pages carry the complete descriptor. This fast path is the
	// production bridge boundary: the parent forwards content/hash/mtime to the
	// owner and does not perform file reads or preflight indexing queries.
	const workerDescriptor = options.content !== undefined && options.contentHash !== undefined;

	const key = fingerprintKey(source, filePath, agentId);
	const cooldownUntil = readFailureBackoffUntil.get(key);
	if (cooldownUntil !== undefined && Date.now() < cooldownUntil) return false;

	let content = options.content ?? "";
	let mtimeMs = options.mtimeMs ?? 0;
	if (options.content === undefined) {
		try {
			const linkStat = await lstat(filePath);
			if (linkStat.isSymbolicLink()) return false;
			const fileStat = await stat(filePath);
			if (!fileStat.isFile()) return false;
			mtimeMs = fileStat.mtimeMs;
			// Async reads and stats run in the threadpool: a transiently locked
			// file (EDEADLK from Obsidian or a sync service) or a stalled
			// filesystem must not block the daemon event loop for seconds
			// (#1135, #1142).
			content = await readFile(filePath, "utf-8");
		} catch (err) {
			if (isEnoentError(err)) {
				// The file vanished between the scan listing and the read — it is
				// gone. Drop it from the index so later scans stop retrying the
				// same ENOENT on every pass instead of accumulating stale
				// artifact rows that desync the FTS index (#1142).
				readFailureBackoffUntil.delete(key);
				permissionDeniedPaths.delete(key);
				await removeNativeMemoryFile(source, filePath, agentId);
				logger.debug("watcher", "Dropped vanished native memory artifact", {
					harness: source.harness,
					path: filePath,
				});
				return false;
			}
			if (classifyNativeMemoryReadFailure(err) === "permission-denied") {
				readFailureBackoffUntil.set(key, Date.now() + READ_FAILURE_BACKOFF_MS);
				const issue = {
					path: filePath,
					guidance: `${TCC_PERMISSION_GUIDANCE} Path: ${filePath}`,
				};
				const firstDenied = !permissionDeniedPaths.has(key);
				permissionDeniedPaths.set(key, issue);
				if (firstDenied) logger.warn("watcher", issue.guidance, { path: filePath });
				return false;
			}
			// Transient failures (locks, permission flaps) back off instead of
			// being re-attempted on every scan iteration.
			readFailureBackoffUntil.set(key, Date.now() + READ_FAILURE_BACKOFF_MS);
			const failureMessage = err instanceof Error ? err.message : String(err);
			if (isDatalessReadError(err)) {
				// Dataless/locked-file reads consolidate into a single warning
				// per harness per window; the files are skipped (with backoff)
				// until the OS materializes them.
				const now = Date.now();
				const prev = datalessReadFailuresByHarness.get(source.harness) ?? { count: 0, lastLoggedAt: 0 };
				const next = { count: prev.count + 1, lastLoggedAt: prev.lastLoggedAt };
				datalessReadFailuresByHarness.set(source.harness, next);
				if (now - prev.lastLoggedAt >= DATALESS_WARN_INTERVAL_MS) {
					next.lastLoggedAt = now;
					logger.warn(
						"watcher",
						`Skipped ${next.count} native artifact read(s) on ${source.harness} that failed with a dataless/locked-file error (${failureMessage}) — likely iCloud-evicted files; retrying in ${Math.round(READ_FAILURE_BACKOFF_MS / 1000)}s`,
						{ path: filePath },
					);
				}
			} else {
				logger.warn("watcher", "Failed reading native memory artifact", {
					harness: source.harness,
					path: filePath,
					error: failureMessage,
				});
			}
			return false;
		}
	}
	readFailureBackoffUntil.delete(key);
	permissionDeniedPaths.delete(key);
	if (!workerDescriptor && !content.trim()) {
		await removeNativeMemoryFile(source, filePath, agentId);
		return false;
	}

	const hash = options.contentHash ?? contentFingerprint(content);
	let persistedHash: string | null;
	if (workerDescriptor) {
		persistedHash = null;
	} else {
		try {
			persistedHash = await nativeArtifactContentHash(filePath, agentId, options.signal);
		} catch (error) {
			logger.error(
				"watcher",
				"Cannot read native memory artifact persistence state",
				error instanceof Error ? error : new Error(String(error)),
				{ path: filePath },
			);
			return false;
		}
	}
	const obsidian = source.harness === "obsidian" && pattern.kind === "source_obsidian_markdown";
	const hermes = source.harness === "hermes-agent";
	const sourceId = obsidian
		? (options.sourceId ?? source.sourceId ?? sourceIdForObsidianRoot(source.root))
		: (options.sourceId ?? source.sourceId ?? null);
	const graphRequested = obsidian && (options.sourceGraphEnabled ?? true);
	const embeddingRequested =
		obsidian &&
		options.embeddingConfig?.provider !== "none" &&
		options.embeddingConfig !== undefined &&
		options.fetchEmbedding !== undefined;
	let semanticComplete = true;
	if (obsidian && !workerDescriptor) {
		const graphExists =
			!graphRequested || (await obsidianGraphExists(agentId, sourceId ?? "", filePath, options.signal));
		const embeddingsExist =
			!embeddingRequested ||
			(await obsidianEmbeddingsExist({
				agentId,
				sourceId: sourceId ?? "",
				root: source.root,
				filePath,
				content,
				chunks: options.chunks,
				signal: options.signal,
			}));
		semanticComplete = graphExists && embeddingsExist;
	}
	const cached = indexed.get(key);
	if (!workerDescriptor && cached?.contentHash === hash) {
		if (persistedHash === hash && semanticComplete) return false;
		indexed.delete(key);
	}
	if (!workerDescriptor && persistedHash === hash && semanticComplete) {
		// One-shot heal for legacy rows with a corrupt pre-epoch captured_at:
		// they stay permanently pending otherwise (no watermark can reach
		// 1980), keeping content passes from ever early-exiting (#1149).
		const persistedCapturedAt = await nativeArtifactCapturedAt(filePath, agentId, options.signal);
		if (persistedCapturedAt !== null) {
			await healSentinelCapturedAt(filePath, agentId, source.harness, persistedCapturedAt, options.signal);
		}
		indexed.set(key, { contentHash: hash });
		return false;
	}

	try {
		const provenanceRoot = source.sourceRoot ?? source.root;
		const externalId =
			obsidian || source.harness === "codex" || hermes ? sourceRelativePath(provenanceRoot, filePath) : null;
		const sourceMeta = obsidian
			? {
					provider: "obsidian",
					displayName: source.displayName,
				}
			: (codexSourceMeta(source, filePath, {
					lineCount: options.lineCount ?? sourceLineCount(content),
					rolloutId: options.rolloutId,
				}) ??
				hermesSourceMeta(source, filePath, {
					lineCount: options.lineCount ?? sourceLineCount(content),
					contentHash: hash,
				}));
		const ownerResult = await dbOwnerSourceNativeMemoryIndex(
			{
				agentId,
				sourcePath: filePath,
				sourceHash: hash,
				sourceKind: pattern.kind,
				harness: source.harness,
				content,
				sourceMtimeMs: mtimeMs,
				sourceId,
				sourceRoot: obsidian || source.harness === "codex" || hermes ? normalizedRoot(provenanceRoot) : null,
				sourceExternalId: externalId,
				sourceParentPath: externalId ? dirname(externalId).replace(/^\.$/, "") : null,
				sourceMetaJson: sourceMeta === undefined ? null : JSON.stringify(sourceMeta),
				displayName: source.displayName,
				...(options.syncCheckpoint && !(workerDescriptor && embeddingRequested && !options.workerOwnedIndexing)
					? { checkpoint: options.syncCheckpoint }
					: {}),
				...(options.syncCheckpoint && options.syncCheckpointOnProviderFailure && options.workerOwnedIndexing
					? {
							checkpointOnProviderFailure: {
								sourceKey: options.syncCheckpoint.sourceKey,
								scanned: options.syncCheckpoint.scanned,
								cursor: options.syncCheckpointOnProviderFailure.cursor,
								frontier: options.syncCheckpointOnProviderFailure.frontier,
								complete: options.syncCheckpointOnProviderFailure.complete,
							},
						}
					: {}),
				...(options.workerOwnedIndexing && obsidian && sourceId && options.embeddingConfig && options.chunks
					? { embedding: { config: options.embeddingConfig, chunks: options.chunks } }
					: {}),
				...(obsidian && sourceId && graphRequested
					? {
							graph: {
								sourceId,
								sourceName: source.displayName,
								root: source.root,
							},
						}
					: {}),
			},
			{
				operation: "sources.native-memory.owner.index",
				lane: "write",
				workloadClass: "maintenance",
				deadlineMs: NATIVE_MEMORY_OWNER_DEADLINE_MS,
				estimatedWorkUnits: Math.max(1, Math.ceil(content.length / 1024)),
				signal: options.signal,
			},
		);
		let semanticIndexed = ownerResult.graphIndexed;
		let embeddingProviderUnavailable = ownerResult.embeddingProviderUnavailable;
		if (options.workerOwnedIndexing && embeddingProviderUnavailable)
			options.onEmbeddingStatus?.("embeddings pending - provider down");
		if (obsidian && sourceId && !options.workerOwnedIndexing) {
			if (options.embeddingConfig && options.fetchEmbedding) {
				const embeddingResult = await indexObsidianSourceEmbeddingsViaOwner({
					agentId,
					sourceId,
					root: source.root,
					filePath,
					content,
					chunks: options.chunks,
					checkpoint: options.syncCheckpoint,
					embeddingConfig: options.embeddingConfig,
					fetchEmbedding: options.fetchEmbedding,
					signal: options.signal,
				});
				options.onEmbeddingStatus?.(embeddingResult.status);
				embeddingProviderUnavailable = embeddingResult.providerUnavailable;
				if (embeddingProviderUnavailable) {
					logger.warn("watcher", "embeddings pending - provider down", {
						path: filePath,
						retryAfterMs: embeddingResult.retryAfterMs,
					});
				}
				if (embeddingResult.embedded > 0) {
					logger.info("watcher", "Embedded Obsidian source chunks", {
						path: filePath,
						chunks: embeddingResult.chunks,
						embedded: embeddingResult.embedded,
						skipped: embeddingResult.skipped,
					});
				}
				semanticIndexed = !embeddingProviderUnavailable;
			}
		}
		indexed.set(key, { contentHash: hash });
		if (ownerResult.artifactChanged) {
			logger.info("watcher", "Indexed native memory artifact", {
				harness: source.harness,
				kind: pattern.kind,
				path: filePath,
			});
		}
		return ownerResult.artifactChanged || semanticIndexed;
	} catch (err) {
		logger.error(
			"watcher",
			"Failed indexing native memory artifact",
			err instanceof Error ? err : new Error(String(err)),
			{
				harness: source.harness,
				path: filePath,
			},
		);
		throw err;
	}
}

export async function removeNativeMemoryFile(
	source: NativeMemorySource,
	filePath: string,
	agentId = resolveDaemonAgentId(),
	signal?: AbortSignal,
): Promise<void> {
	indexed.delete(fingerprintKey(source, filePath, agentId));
	await softDeleteArtifactRowsForPath(filePath, agentId, undefined, { signal });
	if (source.harness === "obsidian") {
		const sourceId = source.sourceId ?? sourceIdForObsidianRoot(source.root);
		await purgeObsidianSourceFileEmbeddingsViaOwner({
			sourceId,
			agentId,
			root: source.root,
			filePath,
			signal,
		});
		await dbOwnerSourceGraphFilePurge(
			{
				agentId,
				sourceId,
				root: source.root,
				filePath,
			},
			{
				operation: "sources.graph.owner.file-purge",
				lane: "write",
				workloadClass: "maintenance",
				estimatedWorkUnits: 6,
				signal,
			},
		);
	}
}

export async function purgeNativeMemorySourceArtifacts(source: NativeMemorySource, agentId?: string): Promise<number> {
	const rootPrefix = `${normalizedRoot(source.root)}/`;
	for (const key of indexed.keys()) {
		const parts = key.split(":");
		const cachedAgentId = parts[0];
		const cachedHarness = parts[1];
		const cachedPath = parts.slice(2).join(":").replace(/\\/g, "/");
		if (
			(!agentId || cachedAgentId === agentId) &&
			cachedHarness === source.harness &&
			cachedPath.startsWith(rootPrefix)
		)
			indexed.delete(key);
	}
	const agentWhere = agentId ? "agent_id = ? AND " : "";
	const rootUpperBound = prefixUpperBound(rootPrefix);
	const params = agentId
		? [
				agentId,
				source.harness,
				source.sourceId ?? "",
				rootPrefix,
				rootUpperBound,
				...source.files.map((file) => file.kind),
			]
		: [source.harness, source.sourceId ?? "", rootPrefix, rootUpperBound, ...source.files.map((file) => file.kind)];
	const [artifactResult] = await dbOwnerBatch(
		[
			ownerStatement(
				`DELETE FROM memory_artifacts
				 WHERE ${agentWhere}harness = ?
				   AND (
					   source_id = ?
					   OR (source_id IS NULL AND source_path >= ? AND source_path < ?)
				   )
				   AND source_kind IN (${source.files.map(() => "?").join(", ")})`,
				params,
			),
		],
		{ operation: "sources.artifacts.purge", lane: "write", workloadClass: "maintenance", estimatedWorkUnits: 4 },
	);
	const artifactRows = (artifactResult as { readonly changes: number }).changes;
	let embeddingRows = 0;
	if (source.harness === "obsidian") {
		embeddingRows = await purgeObsidianSourceEmbeddingsViaOwner({
			sourceId: source.sourceId ?? sourceIdForObsidianRoot(source.root),
			agentId: agentId ?? undefined,
		});
		await dbOwnerSourceGraphPurge(
			{
				agentId,
				sourceId: source.sourceId ?? sourceIdForObsidianRoot(source.root),
				root: source.root,
			},
			{
				operation: "sources.graph.owner.purge",
				lane: "write",
				workloadClass: "maintenance",
				estimatedWorkUnits: 10,
			},
		);
	}
	return artifactRows + embeddingRows;
}

function prefixUpperBound(prefix: string): string {
	return `${prefix}\uffff`;
}

function sourceCleanupEnabledFor(source: NativeMemorySource, options: NativeMemoryBridgeOptions): boolean {
	return (options.sourceCleanupEnabled ?? true) && (options.shouldCleanupSource?.(source) ?? true);
}

function sourceNeedsProvider(source: NativeMemorySource, options: NativeMemoryBridgeOptions): boolean {
	return (
		source.harness === "obsidian" &&
		options.embeddingConfig !== undefined &&
		options.embeddingConfig.provider !== "none" &&
		options.fetchEmbedding !== undefined
	);
}

async function sourceProviderGate(
	agentId: string,
	options: Pick<NativeMemoryBridgeOptions, "embeddingConfig" | "fetchEmbedding">,
	signal?: AbortSignal,
): Promise<{ readonly available: boolean; readonly retryAfterMs?: number }> {
	const embeddingConfig = options.embeddingConfig;
	const fetchEmbedding = options.fetchEmbedding;
	if (!embeddingConfig || !fetchEmbedding || embeddingConfig.provider === "none") return { available: true };
	const providerKey = `${embeddingConfig.provider}:${embeddingConfig.model}:${embeddingConfig.base_url ?? ""}`;
	let providerFailed = false;
	const result = await awaitEmbeddingProviderAvailable(
		providerKey,
		async () => {
			signal?.throwIfAborted();
			providerFailed = false;
			const probe = await fetchEmbedding(EMBEDDING_PROVIDER_PROBE_TEXT, embeddingConfig, "document", {
				usage: { source: "artifact-index", agentId },
				onFailure: (cause) => {
					providerFailed = cause === "provider_unavailable" || cause === "timeout";
				},
			});
			return Boolean(probe?.length) && !providerFailed;
		},
		10_000,
	);
	signal?.throwIfAborted();
	return result;
}

export function startNativeMemoryBridge(
	sources: readonly NativeMemorySource[] = [
		codexNativeMemorySource(),
		claudeCodeNativeMemorySource(),
		hermesNativeMemorySource(),
	],
	options: NativeMemoryBridgeOptions = {},
): NativeMemoryBridgeHandle {
	const agentId = resolveBridgeAgentId(options.agentId);
	const known = new Map<string, Set<string>>();
	const sourceWorker = createNativeSourceWorker({
		onScanStarted: () => options.onSourceWorkerScanStarted?.(),
	});
	const workerOwnedProviderFailures = new Set<string>();
	let cancelRequested = false;
	let lastSyncResult: NativeMemorySyncResult = { status: "complete", scanned: 0, indexed: 0, pausedSources: [] };

	const runScan = async (signal: AbortSignal): Promise<number> => {
		signal.throwIfAborted();
		let count = 0;
		let totalScanned = 0;
		let totalIndexed = 0;
		const pausedSources: NativeMemorySyncSourceResult[] = [];
		const yielder = yieldEvery(options.yieldEveryFiles ?? 20);
		for (const source of activeBridgeSources(sources, options)) {
			if (options.shouldContinue && !options.shouldContinue(source)) continue;
			const flightKey = sourceFlightKey(source, agentId);
			const existingFlight = sharedNativeMemorySourceFlights.get(flightKey);
			if (existingFlight) {
				const joined = await existingFlight.promise;
				count += joined.indexed;
				totalScanned += joined.scanned;
				totalIndexed += joined.indexed;
				if (joined.status === "paused") pausedSources.push(joined);
				continue;
			}
			let resolveFlight!: (result: NativeMemorySyncSourceResult) => void;
			let rejectFlight!: (error: unknown) => void;
			const flightPromise = new Promise<NativeMemorySyncSourceResult>((resolve, reject) => {
				resolveFlight = resolve;
				rejectFlight = reject;
			});
			void flightPromise.catch(() => {});
			sharedNativeMemorySourceFlights.set(flightKey, {
				promise: flightPromise,
				resolve: resolveFlight,
				reject: rejectFlight,
			});
			let sourceResult: NativeMemorySyncSourceResult | undefined;
			let sourceFailure: unknown;
			try {
				let changedCount = 0;
				let scanned = 0;
				const key = sourceStateKey(source, agentId);
				const durableKey = nativeSourceSyncKey(source);
				const rootExists = await pathExists(source.root, source, agentId);
				const dbAvailable = hasDbAccessor();
				const syncState = rootExists && dbAvailable ? await readNativeSourceSyncState(agentId, source, signal) : null;
				if (
					sourceNeedsProvider(source, options) &&
					options.workerOwnedIndexing &&
					workerOwnedProviderFailures.has(durableKey)
				) {
					const embeddingConfig = options.embeddingConfig;
					const providerKey = `${embeddingConfig?.provider}:${embeddingConfig?.model}:${embeddingConfig?.base_url ?? ""}`;
					const provider = await awaitEmbeddingProviderAvailable(providerKey, undefined, 10_000);
					if (!provider.available) {
						await persistNativeSourceSyncState({
							agentId,
							source,
							status: "paused",
							pauseReason: "provider_unavailable",
							signal,
						});
						sourceResult = {
							sourceKey: durableKey,
							sourceId: source.sourceId,
							status: "paused",
							scanned: 0,
							indexed: 0,
							resumeFrontier: syncState?.checkpointPath ?? null,
							pauseReason: "provider_unavailable",
						};
						pausedSources.push(sourceResult);
						continue;
					}
					workerOwnedProviderFailures.delete(durableKey);
				}
				if (sourceNeedsProvider(source, options) && !options.workerOwnedIndexing) {
					const provider = await sourceProviderGate(agentId, options, signal);
					if (!provider.available) {
						await persistNativeSourceSyncState({
							agentId,
							source,
							status: "paused",
							pauseReason: "provider_unavailable",
							signal,
						});
						pausedSources.push({
							sourceKey: durableKey,
							sourceId: source.sourceId,
							status: "paused",
							scanned: 0,
							indexed: 0,
							resumeFrontier: syncState?.checkpointPath ?? null,
							pauseReason: "provider_unavailable",
						});
						sourceResult = pausedSources[pausedSources.length - 1];
						continue;
					}
					if (syncState?.status === "paused") {
						await persistNativeSourceSyncState({ agentId, source, status: "running", signal });
					}
				}
				const current = new Set<string>();
				const resumePath = syncState?.status === "paused" ? syncState.checkpointPath : null;
				let resumeCheckpointPath = resumePath;
				const maxFilesPerScan = options.maxFilesPerScan ?? NATIVE_MEMORY_MAX_FILES_PER_SCAN;
				let scanComplete = true;
				let sourcePaused = false;
				if (rootExists) {
					const fileDelayMs = sourceFileDelayMs(source, options);
					const checkpoint = dbAvailable
						? await readNativeSourceSyncCheckpoint(agentId, key, "content", signal)
						: { cursor: null, frontier: null, complete: true };
					let cursor = checkpoint.complete ? null : checkpoint.cursor;
					let frontier = checkpoint.complete ? null : checkpoint.frontier;
					let pageComplete = false;
					while (scanned < maxFilesPerScan && !pageComplete) {
						const page: NativeSourceWorkerPage = await sourceWorker.scan({
							source: workerSource(source),
							cursor,
							frontier,
							pageSize: Math.min(100, maxFilesPerScan - scanned),
						});
						for (const path of page.permissionDeniedPaths) {
							recordNativeMemoryPermissionDenied(source, path, agentId);
						}
						if (cancelRequested) throw new Error("native source sync cancelled");
						if (page.files.length === 0 && page.complete) {
							pageComplete = true;
							cursor = null;
							if (dbAvailable) {
								await writeNativeSourceSyncCheckpoint(
									agentId,
									key,
									"content",
									{ cursor: null, frontier: null, complete: true },
									scanned,
									signal,
								);
							}
							break;
						}
						const pageScannedBefore = scanned;
						for (const [fileIndex, file] of page.files.entries()) {
							if (cancelRequested) throw new Error("native source sync cancelled");
							if (resumePath && file.path.replace(/\\/g, "/") <= resumePath.replace(/\\/g, "/")) {
								current.add(file.path);
								continue;
							}
							if (scanned >= maxFilesPerScan) break;
							scanned++;
							let embeddingStatus: string | undefined;
							const retryCheckpoint: NativeSourceSyncCheckpoint = {
								cursor,
								frontier: [
									...page.frontier,
									...page.files
										.slice(fileIndex)
										.map((next) => next.path)
										.reverse(),
								],
								complete: false,
							};
							const changed = await indexNativeMemoryFile(source, file.path, agentId, {
								...options,
								signal,
								content: file.content,
								chunks: file.chunks,
								mtimeMs: file.mtimeMs,
								contentHash: file.contentHash,
								sourceId: file.sourceId,
								lineCount: file.lineCount,
								rolloutId: file.rolloutId,
								syncCheckpoint: {
									sourceKey: key,
									scanned,
									cursor: file.path.replace(/\\/g, "/"),
									frontier: [
										...page.frontier,
										...page.files
											.slice(fileIndex + 1)
											.map((next) => next.path)
											.reverse(),
									],
									complete: page.complete && fileIndex === page.files.length - 1,
								},
								syncCheckpointOnProviderFailure: retryCheckpoint,
								onEmbeddingStatus: (status) => {
									embeddingStatus = status;
									if (status === "embeddings pending - provider down" && options.workerOwnedIndexing) {
										const embeddingConfig = options.embeddingConfig;
										if (embeddingConfig !== undefined) {
											const providerKey = `${embeddingConfig.provider}:${embeddingConfig.model}:${embeddingConfig.base_url ?? ""}`;
											recordEmbeddingProviderFailure(providerKey, 10_000);
											workerOwnedProviderFailures.add(durableKey);
										}
									}
									options.onEmbeddingStatus?.(status);
								},
							});
							if (changed) {
								count++;
								changedCount++;
							}
							current.add(file.path);
							options.onFileIndexed?.({
								source,
								filePath: file.path,
								indexed: changed,
								scanned,
								total: page.total,
								changed: changedCount,
								...(embeddingStatus ? { status: embeddingStatus } : {}),
							});
							if (embeddingStatus === "embeddings pending - provider down") {
								sourcePaused = true;
								scanComplete = false;
								if (dbAvailable && !options.workerOwnedIndexing) {
									await writeNativeSourceSyncCheckpoint(
										agentId,
										key,
										"content",
										retryCheckpoint,
										Math.max(0, scanned - 1),
										signal,
									);
								}
								await persistNativeSourceSyncState({
									agentId,
									source,
									status: "paused",
									...(resumeCheckpointPath === null ? {} : { checkpointPath: resumeCheckpointPath }),
									pauseReason: "provider_unavailable",
									signal,
								});
								break;
							}
							resumeCheckpointPath = file.path.replace(/\\/g, "/");
							await yielder();
							await sleep(fileDelayMs);
						}
						if (sourcePaused) break;
						cursor = page.nextCursor;
						frontier = page.frontier;
						pageComplete = page.complete;
						if (dbAvailable && scanned === pageScannedBefore) {
							await writeNativeSourceSyncCheckpoint(
								agentId,
								key,
								"content",
								{
									cursor: pageComplete ? null : cursor,
									frontier: pageComplete ? null : frontier,
									complete: pageComplete,
								},
								scanned,
								signal,
							);
						}
					}
					scanComplete = pageComplete;
					if (!pageComplete && scanned >= maxFilesPerScan) {
						logger.warn("watcher", "Native memory scan reached its file budget", {
							harness: source.harness,
							root: source.root,
							cap: maxFilesPerScan,
						});
					}
				}
				totalScanned += scanned;
				totalIndexed += changedCount;
				if (sourcePaused) {
					sourceResult = {
						sourceKey: durableKey,
						sourceId: source.sourceId,
						status: "paused",
						scanned,
						indexed: changedCount,
						resumeFrontier: resumeCheckpointPath,
						pauseReason: "provider_unavailable",
					};
					pausedSources.push(sourceResult);
				} else if (sourceNeedsProvider(source, options) && rootExists && scanComplete) {
					await clearNativeSourceSyncCheckpoint({ agentId, source, signal });
				}
				if (!sourceResult) {
					sourceResult = {
						sourceKey: durableKey,
						sourceId: source.sourceId,
						status: "complete",
						scanned,
						indexed: changedCount,
						resumeFrontier: null,
					};
				}
				const cleanupAllowed =
					sourceCleanupEnabledFor(source, options) &&
					(!rootExists || scanComplete) &&
					nativeMemorySourcePermissionHealth(source, agentId).status !== "denied";
				if (cleanupAllowed) {
					const currentPaths = new Set([...current].map((file) => file.replace(/\\/g, "/")));
					for (const file of await activeNativeArtifactPaths(source, agentId, signal)) {
						if (!currentPaths.has(file.replace(/\\/g, "/")))
							await removeNativeMemoryFile(source, file, agentId, signal);
					}
				}
				const previous = known.get(key);
				if (previous && cleanupAllowed) {
					for (const file of previous) {
						if (!current.has(file)) await removeNativeMemoryFile(source, file, agentId, signal);
					}
				}
				known.set(key, current);
				if (
					rootExists &&
					scanComplete &&
					source.sourceId &&
					(!options.shouldContinue || options.shouldContinue(source))
				) {
					markSourceIndexed(source.sourceId, undefined, options.agentsDir);
				}
			} catch (error) {
				sourceFailure = error;
				throw error;
			} finally {
				sharedNativeMemorySourceFlights.delete(flightKey);
				if (sourceFailure !== undefined) rejectFlight(sourceFailure);
				else if (sourceResult !== undefined) resolveFlight(sourceResult);
			}
		}
		lastSyncResult = {
			status: pausedSources.length > 0 ? "paused" : "complete",
			scanned: totalScanned,
			indexed: totalIndexed,
			pausedSources,
		};
		return count;
	};

	let syncInFlight: Promise<number> | null = null;
	let activeController: AbortController | null = null;
	let bridgeClosed = false;
	let resyncRequested = false;
	const syncExisting = async (syncOptions: NativeMemoryBridgeSyncOptions = {}): Promise<number> => {
		if (bridgeClosed) throw new Error("native source bridge closed");
		if (syncInFlight) {
			if (syncOptions.requestResyncIfBusy ?? true) resyncRequested = true;
			if (syncOptions.signal) {
				if (syncOptions.signal.aborted) activeController?.abort(syncOptions.signal.reason);
				else
					syncOptions.signal.addEventListener("abort", () => activeController?.abort(syncOptions.signal?.reason), {
						once: true,
					});
			}
			return syncInFlight;
		}
		cancelRequested = false;
		const controller = new AbortController();
		activeController = controller;
		const forwardAbort = (): void => controller.abort(syncOptions.signal?.reason);
		if (syncOptions.signal?.aborted) forwardAbort();
		else syncOptions.signal?.addEventListener("abort", forwardAbort, { once: true });
		syncInFlight = Promise.resolve()
			.then(async () => {
				let total = 0;
				do {
					resyncRequested = false;
					total += await runScan(controller.signal);
				} while (resyncRequested);
				return total;
			})
			.finally(() => {
				syncOptions.signal?.removeEventListener("abort", forwardAbort);
				activeController = null;
				syncInFlight = null;
			});
		void syncInFlight.catch(() => {});
		return syncInFlight;
	};
	const pollIntervalMs = options.pollIntervalMs ?? 10_000;
	const pollTimer =
		pollIntervalMs > 0
			? setInterval(() => {
					syncExisting({ requestResyncIfBusy: false }).catch((err) => {
						logger.warn("watcher", "Failed polling native memory sources", {
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}, pollIntervalMs)
			: null;
	pollTimer?.unref?.();

	return {
		syncExisting,
		getLastSyncResult: () => lastSyncResult,
		cancel: () => {
			cancelRequested = true;
			activeController?.abort(new Error("native source sync cancelled"));
			sourceWorker.cancel();
		},
		async close(): Promise<void> {
			bridgeClosed = true;
			if (pollTimer) clearInterval(pollTimer);
			const inFlight = syncInFlight;
			cancelRequested = true;
			sourceWorker.cancel();
			if (inFlight) await inFlight.catch(() => 0);
			if (syncInFlight && syncInFlight !== inFlight) await syncInFlight.catch(() => 0);
			await sourceWorker.close();
		},
	};
}
