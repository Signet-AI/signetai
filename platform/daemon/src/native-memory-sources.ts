import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
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
import { getDbAccessor } from "./db-accessor";
import { EPISODIC_CAPTURED_AT_FLOOR, timestampMillis } from "./episodic-sources";
import { logger } from "./logger";
import type { EmbeddingConfig } from "./memory-config";
import { hashNormalizedBody, indexExternalMemoryArtifact, softDeleteArtifactRowsForPath } from "./memory-lineage";
import {
	type SourceEmbeddingFetch,
	buildObsidianSourceChunks,
	indexObsidianSourceEmbeddings,
	purgeObsidianSourceEmbeddings,
	purgeObsidianSourceFileEmbeddings,
} from "./obsidian-source-embeddings";
import {
	type ObsidianMarkdownPathIndex,
	buildObsidianMarkdownPathIndex,
	indexObsidianSourceStructure,
	purgeObsidianSourceFileStructure,
	purgeObsidianSourceStructure,
	sourceIdForObsidianRoot,
} from "./obsidian-source-graph";

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
}

export interface NativeMemoryBridgeHandle {
	readonly syncExisting: (options?: NativeMemoryBridgeSyncOptions) => Promise<number>;
	readonly close: () => Promise<void>;
}

export interface NativeMemoryBridgeSyncOptions {
	readonly requestResyncIfBusy?: boolean;
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
	readonly shouldContinue?: (source: NativeMemorySource) => boolean;
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
}

interface IndexedNativeMemory {
	readonly contentHash: string;
}

const indexed = new Map<string, IndexedNativeMemory>();

/** Test-only: drop the in-process content-hash cache so scans behave like a fresh daemon. */
export function resetNativeMemoryIndexCache(): void {
	indexed.clear();
}
const DEFAULT_OBSIDIAN_SOURCE_FILE_DELAY_MS = 250;

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

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
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
	return `codex_native_memory:${createHash("sha256").update(normalizedRoot(root)).digest("hex").slice(0, 16)}`;
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

function sourceIdForHermesRoot(root: string): string {
	return `hermes_native_memory:${createHash("sha256").update(normalizedRoot(root)).digest("hex").slice(0, 16)}`;
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

async function* walkNativeMemoryFiles(dir: string): AsyncGenerator<string> {
	if (!(await pathExists(dir))) return;
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === ".git") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkNativeMemoryFiles(path);
		} else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".jsonl"))) {
			yield path;
		}
	}
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

function fingerprintKey(source: NativeMemorySource, filePath: string, agentId: string): string {
	return `${agentId}:${source.harness}:${filePath}`;
}

function sourceStateKey(source: NativeMemorySource, agentId: string): string {
	return `${agentId}:${source.harness}:${source.root.replace(/\\/g, "/").replace(/\/$/, "")}`;
}

function contentFingerprint(content: string): string {
	return hashNormalizedBody(content);
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
	content: string,
): Record<string, unknown> | undefined {
	if (source.harness !== "codex") return undefined;
	const rel = safeRelativePath(source.root, filePath) ?? sourceRelativePath(source.root, filePath);
	const normalized = content.replace(/\r\n?/g, "\n").replace(/\n$/, "");
	const lineCount = normalized.length === 0 ? 0 : normalized.split("\n").length;
	const rolloutId = content.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0];
	return {
		sourceType: "codex_native_memory",
		provider: "codex",
		displayName: source.displayName,
		relativePath: rel,
		lineStart: lineCount > 0 ? 1 : 0,
		lineEnd: lineCount,
		...(rolloutId ? { rolloutId } : {}),
	};
}

function hermesSourceMeta(
	source: NativeMemorySource,
	filePath: string,
	content: string,
): Record<string, unknown> | undefined {
	if (source.harness !== "hermes-agent") return undefined;
	const profileRoot = normalizedRoot(source.sourceRoot ?? hermesProfileRoot(source.root));
	const rel = safeRelativePath(source.root, filePath) ?? sourceRelativePath(profileRoot, filePath);
	const profileRelativePath = sourceRelativePath(profileRoot, filePath);
	const normalized = content.replace(/\r\n?/g, "\n").replace(/\n$/, "");
	const lineCount = normalized.length === 0 ? 0 : normalized.split("\n").length;
	return {
		sourceType: "hermes_native_memory",
		provider: "hermes-agent",
		displayName: source.displayName,
		profileId: hermesProfileId(profileRoot),
		profileRoot,
		relativePath: profileRelativePath,
		memoryFile: rel,
		lineStart: lineCount > 0 ? 1 : 0,
		lineEnd: lineCount,
		contentHash: contentFingerprint(content),
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

function nativeArtifactContentHash(filePath: string, agentId: string): string | null {
	const sourcePath = filePath.replace(/\\/g, "/");
	try {
		return getDbAccessor().withReadDb((db) => {
			const row = db
				.prepare(
					"SELECT source_sha256 FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0 LIMIT 1",
				)
				.get(agentId, sourcePath) as { source_sha256: string } | undefined;
			return row?.source_sha256 ?? null;
		});
	} catch {
		return null;
	}
}

function nativeArtifactCapturedAt(filePath: string, agentId: string): string | null {
	const sourcePath = filePath.replace(/\\/g, "/");
	try {
		return getDbAccessor().withReadDb((db) => {
			const row = db
				.prepare(
					"SELECT captured_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0 LIMIT 1",
				)
				.get(agentId, sourcePath) as { captured_at: string } | undefined;
			return row?.captured_at ?? null;
		});
	} catch {
		return null;
	}
}

/**
 * One-shot heal for rows already stamped with a corrupt pre-epoch captured_at
 * (the DOS epoch 1980 sentinel): they are re-stamped with the index time so
 * they stop blocking backlog termination and get a normal lifecycle. New
 * indexes never mint sentinels (the memory-lineage clamp), so this only fires
 * once per legacy row (#1149).
 */
function healSentinelCapturedAt(filePath: string, agentId: string, harness: string, capturedAt: string): void {
	if (timestampMillis(capturedAt) >= Date.parse(EPISODIC_CAPTURED_AT_FLOOR)) return;
	try {
		const stampedAt = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`UPDATE memory_artifacts
				 SET captured_at = ?, updated_at = ?
				 WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0`,
			).run(stampedAt, stampedAt, agentId, filePath.replace(/\\/g, "/"));
		});
		logger.warn("watcher", "Healed pre-epoch captured_at on native memory artifact", {
			harness,
			path: filePath,
			was: capturedAt,
		});
	} catch (err) {
		logger.warn("watcher", "Could not heal pre-epoch captured_at", {
			path: filePath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

function obsidianGraphExists(agentId: string, sourceId: string, filePath: string): boolean {
	try {
		return getDbAccessor().withReadDb((db) => {
			const row = db
				.prepare(
					`SELECT 1 FROM entities
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND source_path = ?
					   AND entity_type = 'source_document'
					 LIMIT 1`,
				)
				.get(agentId, sourceId, filePath.replace(/\\/g, "/")) as { "1": number } | undefined;
			return row !== undefined;
		});
	} catch {
		return false;
	}
}

function obsidianEmbeddingsExist(input: {
	readonly agentId: string;
	readonly sourceId: string;
	readonly root: string;
	readonly filePath: string;
	readonly content: string;
}): boolean {
	const chunks = buildObsidianSourceChunks(input);
	if (chunks.length === 0) return true;
	try {
		return getDbAccessor().withReadDb((db) => {
			const rows = db
				.prepare(
					`SELECT source_id FROM embeddings
					 WHERE agent_id = ?
					   AND source_type IN (?, ?)
					   AND source_id IN (${chunks.map(() => "?").join(", ")})`,
				)
				.all(
					input.agentId,
					SOURCE_CHUNK_SOURCE_TYPE,
					LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE,
					...chunks.map((chunk) => chunk.id),
				) as Array<{
				source_id: string;
			}>;
			return new Set(rows.map((row) => row.source_id)).size === chunks.length;
		});
	} catch {
		return false;
	}
}

function activeNativeArtifactPaths(source: NativeMemorySource, agentId: string): string[] {
	const rootPrefix = `${normalizedRoot(source.root)}/`;
	try {
		return getDbAccessor().withReadDb((db) => {
			const rows = db
				.prepare(
					`SELECT source_path FROM memory_artifacts
					 WHERE agent_id = ?
					   AND harness = ?
					   AND (
						   source_id = ?
						   OR (source_id IS NULL AND source_path >= ? AND source_path < ?)
					   )
					   AND source_kind IN (${source.files.map(() => "?").join(", ")})
					   AND COALESCE(is_deleted, 0) = 0`,
				)
				.all(
					agentId,
					source.harness,
					source.sourceId ?? "",
					rootPrefix,
					prefixUpperBound(rootPrefix),
					...source.files.map((file) => file.kind),
				) as Array<{
				source_path: string;
			}>;
			return rows.map((row) => row.source_path);
		});
	} catch (err) {
		logger.warn("watcher", "Failed listing active native memory artifacts", {
			harness: source.harness,
			root: source.root,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
}

export async function indexNativeMemoryFile(
	source: NativeMemorySource,
	filePath: string,
	agentId = resolveDaemonAgentId(),
	options: Pick<NativeMemoryBridgeOptions, "embeddingConfig" | "fetchEmbedding" | "sourceGraphEnabled"> & {
		readonly markdownPathIndex?: ObsidianMarkdownPathIndex;
	} = {},
): Promise<boolean> {
	if (!safeRelativePath(source.root, filePath)) return false;
	const pattern = matchesPattern(source, filePath);
	if (!pattern) return false;

	const key = fingerprintKey(source, filePath, agentId);
	const cooldownUntil = readFailureBackoffUntil.get(key);
	if (cooldownUntil !== undefined && Date.now() < cooldownUntil) return false;

	let content = "";
	let mtimeMs = 0;
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
			removeNativeMemoryFile(source, filePath, agentId);
			logger.debug("watcher", "Dropped vanished native memory artifact", {
				harness: source.harness,
				path: filePath,
			});
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
	readFailureBackoffUntil.delete(key);
	if (!content.trim()) return false;

	const hash = contentFingerprint(content);
	const persistedHash = nativeArtifactContentHash(filePath, agentId);
	const obsidian = source.harness === "obsidian" && pattern.kind === "source_obsidian_markdown";
	const hermes = source.harness === "hermes-agent";
	const sourceId = obsidian ? (source.sourceId ?? sourceIdForObsidianRoot(source.root)) : (source.sourceId ?? null);
	const graphRequested = obsidian && (options.sourceGraphEnabled ?? true);
	const embeddingRequested =
		obsidian &&
		options.embeddingConfig?.provider !== "none" &&
		options.embeddingConfig !== undefined &&
		options.fetchEmbedding !== undefined;
	const semanticComplete =
		!obsidian ||
		((!graphRequested || obsidianGraphExists(agentId, sourceId ?? "", filePath)) &&
			(!embeddingRequested ||
				obsidianEmbeddingsExist({
					agentId,
					sourceId: sourceId ?? "",
					root: source.root,
					filePath,
					content,
				})));
	const cached = indexed.get(key);
	if (cached?.contentHash === hash) {
		if (persistedHash === hash && semanticComplete) return false;
		indexed.delete(key);
	}
	if (persistedHash === hash && semanticComplete) {
		// One-shot heal for legacy rows with a corrupt pre-epoch captured_at:
		// they stay permanently pending otherwise (no watermark can reach
		// 1980), keeping content passes from ever early-exiting (#1149).
		const persistedCapturedAt = nativeArtifactCapturedAt(filePath, agentId);
		if (persistedCapturedAt !== null) {
			healSentinelCapturedAt(filePath, agentId, source.harness, persistedCapturedAt);
		}
		indexed.set(key, { contentHash: hash });
		return false;
	}

	try {
		const artifactChanged = persistedHash !== hash;
		if (artifactChanged) {
			const provenanceRoot = source.sourceRoot ?? source.root;
			const externalId =
				obsidian || source.harness === "codex" || hermes ? sourceRelativePath(provenanceRoot, filePath) : null;
			indexExternalMemoryArtifact({
				agentId,
				sourcePath: filePath,
				sourceKind: pattern.kind,
				harness: source.harness,
				content,
				sourceMtimeMs: mtimeMs,
				sourceId,
				sourceRoot: obsidian || source.harness === "codex" || hermes ? normalizedRoot(provenanceRoot) : null,
				sourceExternalId: externalId,
				sourceParentPath: externalId ? dirname(externalId).replace(/^\.$/, "") : null,
				sourceMeta: obsidian
					? {
							provider: "obsidian",
							displayName: source.displayName,
						}
					: (codexSourceMeta(source, filePath, content) ?? hermesSourceMeta(source, filePath, content)),
			});
		}
		let semanticIndexed = false;
		if (obsidian && sourceId) {
			if (options.sourceGraphEnabled ?? true) {
				indexObsidianSourceStructure({
					agentId,
					sourceId,
					sourceName: source.displayName,
					root: source.root,
					filePath,
					content,
					markdownPathIndex: options.markdownPathIndex,
				});
				semanticIndexed = true;
			}
			if (options.embeddingConfig && options.fetchEmbedding) {
				const embeddingResult = await indexObsidianSourceEmbeddings({
					agentId,
					sourceId,
					root: source.root,
					filePath,
					content,
					embeddingConfig: options.embeddingConfig,
					fetchEmbedding: options.fetchEmbedding,
				});
				if (embeddingResult.embedded > 0) {
					logger.info("watcher", "Embedded Obsidian source chunks", {
						path: filePath,
						chunks: embeddingResult.chunks,
						embedded: embeddingResult.embedded,
						skipped: embeddingResult.skipped,
					});
				}
				semanticIndexed = true;
			}
		}
		indexed.set(key, { contentHash: hash });
		if (artifactChanged) {
			logger.info("watcher", "Indexed native memory artifact", {
				harness: source.harness,
				kind: pattern.kind,
				path: filePath,
			});
		}
		return artifactChanged || semanticIndexed;
	} catch (err) {
		logger.warn("watcher", "Failed indexing native memory artifact", {
			harness: source.harness,
			path: filePath,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

export function removeNativeMemoryFile(
	source: NativeMemorySource,
	filePath: string,
	agentId = resolveDaemonAgentId(),
): void {
	indexed.delete(fingerprintKey(source, filePath, agentId));
	softDeleteArtifactRowsForPath(filePath, agentId);
	if (source.harness === "obsidian") {
		const sourceId = source.sourceId ?? sourceIdForObsidianRoot(source.root);
		purgeObsidianSourceFileEmbeddings({
			sourceId,
			agentId,
			root: source.root,
			filePath,
		});
		purgeObsidianSourceFileStructure({
			agentId,
			sourceId,
			root: source.root,
			filePath,
		});
	}
}

export function purgeNativeMemorySourceArtifacts(source: NativeMemorySource, agentId?: string): number {
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
	const artifactRows = getDbAccessor().withWriteTx((db) => {
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
		const result = db
			.prepare(
				`DELETE FROM memory_artifacts
				 WHERE ${agentWhere}harness = ?
				   AND (
					   source_id = ?
					   OR (source_id IS NULL AND source_path >= ? AND source_path < ?)
				   )
				   AND source_kind IN (${source.files.map(() => "?").join(", ")})`,
			)
			.run(...params);
		return result.changes;
	});
	let embeddingRows = 0;
	if (source.harness === "obsidian") {
		embeddingRows = purgeObsidianSourceEmbeddings({
			sourceId: source.sourceId ?? sourceIdForObsidianRoot(source.root),
			agentId: agentId ?? undefined,
		});
		purgeObsidianSourceStructure({
			agentId,
			sourceId: source.sourceId ?? sourceIdForObsidianRoot(source.root),
			root: source.root,
		});
	}
	return artifactRows + embeddingRows;
}

function prefixUpperBound(prefix: string): string {
	return `${prefix}\uffff`;
}

function sourceCleanupEnabledFor(source: NativeMemorySource, options: NativeMemoryBridgeOptions): boolean {
	return (options.sourceCleanupEnabled ?? true) && (options.shouldCleanupSource?.(source) ?? true);
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

	const runScan = async (): Promise<number> => {
		let count = 0;
		const yielder = yieldEvery(options.yieldEveryFiles ?? 20);
		for (const source of activeBridgeSources(sources, options)) {
			if (options.shouldContinue && !options.shouldContinue(source)) continue;
			let changedCount = 0;
			let scanned = 0;
			const key = sourceStateKey(source, agentId);
			const current = new Set<string>();
			const rootExists = await pathExists(source.root);
			if (rootExists) {
				const files: string[] = [];
				for await (const file of walkNativeMemoryFiles(source.root)) {
					if (!matchesPattern(source, file)) continue;
					files.push(file);
					await yielder();
				}
				const total = files.length;
				const fileDelayMs = sourceFileDelayMs(source, options);
				const markdownPathIndex =
					source.harness === "obsidian" && (options.sourceGraphEnabled ?? true)
						? buildObsidianMarkdownPathIndex(source.root, files)
						: undefined;
				for (const file of files) {
					if (options.shouldContinue && !options.shouldContinue(source)) break;
					scanned++;
					const changed = await indexNativeMemoryFile(source, file, agentId, {
						...options,
						markdownPathIndex,
					});
					if (changed) {
						count++;
						changedCount++;
					}
					current.add(file);
					options.onFileIndexed?.({ source, filePath: file, indexed: changed, scanned, total, changed: changedCount });
					await yielder();
					await sleep(fileDelayMs);
				}
				if (sourceCleanupEnabledFor(source, options)) {
					const currentPaths = new Set([...current].map((file) => file.replace(/\\/g, "/")));
					for (const file of activeNativeArtifactPaths(source, agentId)) {
						if (!currentPaths.has(file.replace(/\\/g, "/"))) removeNativeMemoryFile(source, file, agentId);
					}
				}
			}
			const previous = known.get(key);
			if (previous && sourceCleanupEnabledFor(source, options)) {
				for (const file of previous) {
					if (!current.has(file)) removeNativeMemoryFile(source, file, agentId);
				}
			}
			known.set(key, current);
			if (rootExists && source.sourceId && (!options.shouldContinue || options.shouldContinue(source))) {
				markSourceIndexed(source.sourceId, undefined, options.agentsDir);
			}
		}
		return count;
	};

	let syncInFlight: Promise<number> | null = null;
	let resyncRequested = false;
	const syncExisting = async (syncOptions: NativeMemoryBridgeSyncOptions = {}): Promise<number> => {
		if (syncInFlight) {
			if (syncOptions.requestResyncIfBusy ?? true) resyncRequested = true;
			return syncInFlight;
		}
		syncInFlight = Promise.resolve()
			.then(async () => {
				let total = 0;
				do {
					resyncRequested = false;
					total += await runScan();
				} while (resyncRequested);
				return total;
			})
			.finally(() => {
				syncInFlight = null;
			});
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
		async close(): Promise<void> {
			if (pollTimer) clearInterval(pollTimer);
			if (syncInFlight) await syncInFlight.catch(() => 0);
		},
	};
}
