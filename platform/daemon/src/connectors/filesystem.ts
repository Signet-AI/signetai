/**
 * Filesystem connector — ingests local files into the document pipeline.
 *
 * Walks a configured root directory using glob patterns, creates document
 * rows for matching files, and enqueues document_ingest jobs. Chunking,
 * embedding, and indexing are handled downstream by the document worker.
 */

import { constants, access, opendir, open, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type {
	ConnectorConfig,
	ConnectorResource,
	ConnectorRuntime,
	SyncCursor,
	SyncError,
	SyncResult,
} from "@signet/core";
import { yieldEvery } from "../async-yield";
import type { DbAccessor } from "../db-accessor";
import { logger } from "../logger";
import { enqueueDocumentIngestJob } from "../pipeline/document-worker";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_PATTERNS = ["**/*.md", "**/*.txt"];
const DEFAULT_IGNORE = [".git", "node_modules", ".DS_Store"];
const DEFAULT_MAX_FILE_SIZE = 1_048_576; // 1 MB
const FILESYSTEM_LIST_PAGE_SIZE = 100;
const DIRECTORY_ENTRIES_PER_YIELD = 64;
const MAX_FILES_PER_DIRECTORY = 1_000;
const MAX_DISCOVERED_FILES = 50_000;

interface FilesystemSettings {
	readonly rootPath: string;
	readonly patterns: readonly string[];
	readonly ignorePatterns: readonly string[];
	readonly maxFileSize: number;
}

function parseSettings(raw: Readonly<Record<string, unknown>>): FilesystemSettings {
	const rootPath = typeof raw.rootPath === "string" ? raw.rootPath : "";

	const patterns =
		Array.isArray(raw.patterns) && raw.patterns.every((p) => typeof p === "string")
			? (raw.patterns as string[])
			: DEFAULT_PATTERNS;

	const ignorePatterns =
		Array.isArray(raw.ignorePatterns) && raw.ignorePatterns.every((p) => typeof p === "string")
			? (raw.ignorePatterns as string[])
			: DEFAULT_IGNORE;

	const maxFileSize =
		typeof raw.maxFileSize === "number" && raw.maxFileSize > 0 ? raw.maxFileSize : DEFAULT_MAX_FILE_SIZE;

	return { rootPath, patterns, ignorePatterns, maxFileSize };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

interface DiscoveredFile {
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly name: string;
	readonly mtime: Date;
	readonly size: number;
}

interface DiscoveryOptions {
	readonly maxResults?: number;
	readonly skipResults?: number;
	readonly signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Filesystem traversal aborted");
}

function parseCursor(cursor: string | undefined): number {
	if (cursor === undefined || cursor.trim() === "") return 0;
	const offset = Number(cursor);
	return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

async function* walkDir(
	dir: string,
	ignorePatterns: readonly string[],
	relativePrefix = "",
	dot = false,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	let directory: Awaited<ReturnType<typeof opendir>>;
	try {
		directory = await opendir(dir);
	} catch {
		return;
	}
	const yielder = yieldEvery(DIRECTORY_ENTRIES_PER_YIELD);
	let filesInDirectory = 0;
	for await (const entry of directory) {
		throwIfAborted(signal);
		await yielder();
		if (!dot && entry.name.startsWith(".")) continue;
		const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
		if (ignorePatterns.some((p) => entry.name === p || relativePath === p || relativePath.startsWith(`${p}/`)))
			continue;
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkDir(fullPath, ignorePatterns, relativePath, dot, signal);
		} else if (entry.isFile()) {
			filesInDirectory += 1;
			if (filesInDirectory > MAX_FILES_PER_DIRECTORY) {
				throw new Error(
					`Filesystem traversal exceeded the per-directory file budget of ${MAX_FILES_PER_DIRECTORY} at ${dir}`,
				);
			}
			yield fullPath;
		}
	}
}

export function matchGlob(pattern: string, path: string): boolean {
	const regex = globToRegex(pattern);
	return regex.test(path);
}

function hasDotSegment(path: string): boolean {
	return path.split("/").some((part) => part.startsWith("."));
}

function patternAllowsDotSegment(pattern: string): boolean {
	return pattern.split("/").some((part) => part.startsWith("."));
}

export function matchConnectorPattern(pattern: string, path: string): boolean {
	if (hasDotSegment(path) && !patternAllowsDotSegment(pattern)) return false;
	return matchGlob(pattern, path);
}

export function globToRegex(pattern: string): RegExp {
	const normalized = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "{{GLOBSTAR}}")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\/\{\{GLOBSTAR\}\}/g, "(?:/.*)?")
		.replace(/\{\{GLOBSTAR\}\}\//g, "(?:.*/)?")
		.replace(/\{\{GLOBSTAR\}\}/g, ".*");
	return new RegExp(`^${normalized}$`, "i");
}

async function* discoverFileStream(
	settings: FilesystemSettings,
	options: DiscoveryOptions = {},
): AsyncGenerator<DiscoveredFile> {
	const { patterns, ignorePatterns, maxFileSize } = settings;
	const resolvedRoot = resolve(settings.rootPath);
	const seen = new Set<string>();
	const maxResults = options.maxResults ?? Number.POSITIVE_INFINITY;
	const skipResults = Math.max(0, options.skipResults ?? 0);
	let matched = 0;
	let yielded = 0;

	const wantsDot = patterns.some(patternAllowsDotSegment);
	for await (const absolutePath of walkDir(resolvedRoot, ignorePatterns, "", wantsDot, options.signal)) {
		throwIfAborted(options.signal);
		const rel = relative(resolvedRoot, absolutePath);
		if (!rel || rel.startsWith("..")) continue;
		const matches = patterns.some((p) => matchConnectorPattern(p, rel));
		if (!matches) continue;
		if (seen.has(rel)) continue;
		seen.add(rel);
		matched += 1;
		if (matched > MAX_DISCOVERED_FILES) {
			throw new Error(`Filesystem traversal exceeded the total file budget of ${MAX_DISCOVERED_FILES}`);
		}
		if (matched <= skipResults) continue;
		if (yielded >= maxResults) return;

		let fileStat: Awaited<ReturnType<typeof stat>>;
		try {
			fileStat = await stat(absolutePath);
		} catch {
			continue;
		}

		if (!fileStat.isFile()) continue;
		if (fileStat.size > maxFileSize) {
			logger.debug("pipeline", "Discovered oversized file", {
				path: rel,
				size: fileStat.size,
				maxFileSize,
			});
		}

		yielded += 1;
		yield {
			absolutePath,
			relativePath: rel,
			name: basename(rel),
			mtime: fileStat.mtime,
			size: fileStat.size,
		};
	}
}

export async function discoverFiles(
	settings: FilesystemSettings,
	options: DiscoveryOptions = {},
): Promise<readonly DiscoveredFile[]> {
	const results: DiscoveredFile[] = [];
	for await (const file of discoverFileStream(settings, options)) results.push(file);
	return results;
}

// ---------------------------------------------------------------------------
// Document row helpers
// ---------------------------------------------------------------------------

interface ExistingDocRow {
	readonly id: string;
	readonly updated_at: string;
}

async function findDocBySourceUrl(accessor: DbAccessor, sourceUrl: string): Promise<ExistingDocRow | undefined> {
	return await accessor.withReadDbAsync(
		(db) => {
			return db.prepare("SELECT id, updated_at FROM documents WHERE source_url = ? LIMIT 1").get(sourceUrl) as
				| ExistingDocRow
				| undefined;
		},
		{ operation: "connector.filesystem.find-document" },
	);
}

export async function readFileContent(
	file: DiscoveredFile,
	maxFileSize: number,
	signal?: AbortSignal,
): Promise<string | null> {
	if (file.size > maxFileSize) return null;
	try {
		throwIfAborted(signal);
		const handle = await open(file.absolutePath, "r");
		try {
			throwIfAborted(signal);
			const fileStat = await handle.stat();
			if (!fileStat.isFile() || fileStat.size > maxFileSize) return null;

			const buffer = Buffer.alloc(fileStat.size);
			let bytesRead = 0;
			while (bytesRead < fileStat.size) {
				throwIfAborted(signal);
				const result = await handle.read(buffer, bytesRead, fileStat.size - bytesRead, bytesRead);
				bytesRead += result.bytesRead;
				if (result.bytesRead === 0) break;
			}

			const finalStat = await handle.stat();
			if (!finalStat.isFile() || finalStat.size !== fileStat.size || bytesRead !== fileStat.size) return null;
			return buffer.toString("utf-8");
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

/**
 * Insert a new document row and return its id.
 */
async function insertDocument(
	accessor: DbAccessor,
	connectorId: string,
	sourceUrl: string,
	title: string,
	rawContent: string,
): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	await accessor.withWriteTxAsync((db) => {
		db.prepare(
			`INSERT INTO documents
			 (id, source_url, source_type, content_type, title,
			  raw_content, status, error, connector_id,
			  chunk_count, memory_count,
			  metadata_json, created_at, updated_at, completed_at)
			 VALUES (?, ?, 'file', 'text/plain', ?,
			         ?, 'queued', NULL, ?,
			         0, 0, NULL, ?, ?, NULL)`,
		).run(id, sourceUrl, title, rawContent, connectorId, now, now);
	});

	return id;
}

/**
 * Update an existing document row with fresh content and reset to queued.
 */
async function updateDocument(accessor: DbAccessor, docId: string, rawContent: string): Promise<void> {
	const now = new Date().toISOString();

	await accessor.withWriteTxAsync((db) => {
		db.prepare(
			`UPDATE documents
			 SET raw_content = ?, status = 'queued', error = NULL,
			     chunk_count = 0, memory_count = 0,
			     completed_at = NULL, updated_at = ?
			 WHERE id = ?`,
		).run(rawContent, now, docId);
	});
}

// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------

async function processFile(
	accessor: DbAccessor,
	connectorId: string,
	file: DiscoveredFile,
	maxFileSize: number,
	forceUpdate: boolean,
): Promise<{ added: number; updated: number; error: SyncError | null }> {
	const sourceUrl = file.absolutePath;

	const content = await readFileContent(file, maxFileSize);
	if (content === null) {
		return {
			added: 0,
			updated: 0,
			error: {
				resourceId: file.relativePath,
				message: "Failed to read file or file exceeds size limit",
				retryable: false,
			},
		};
	}

	const existing = await findDocBySourceUrl(accessor, sourceUrl);

	if (existing === undefined) {
		const docId = await insertDocument(accessor, connectorId, sourceUrl, file.name, content);
		await enqueueDocumentIngestJob(accessor, docId);
		return { added: 1, updated: 0, error: null };
	}

	// Only update if forced (full sync / replay) or mtime is newer than doc
	const docUpdatedAt = new Date(existing.updated_at);
	const needsUpdate = forceUpdate || file.mtime > docUpdatedAt;

	if (!needsUpdate) {
		return { added: 0, updated: 0, error: null };
	}

	await updateDocument(accessor, existing.id, content);
	await enqueueDocumentIngestJob(accessor, existing.id);
	return { added: 0, updated: 1, error: null };
}

// ---------------------------------------------------------------------------
// ConnectorRuntime implementation
// ---------------------------------------------------------------------------

class FilesystemConnector implements ConnectorRuntime {
	readonly id: string;
	readonly provider = "filesystem" as const;

	private readonly settings: FilesystemSettings;
	private readonly accessor: DbAccessor;

	constructor(config: ConnectorConfig, accessor: DbAccessor) {
		this.id = config.id;
		this.settings = parseSettings(config.settings);
		this.accessor = accessor;
	}

	async authorize(): Promise<{ readonly ok: boolean; readonly error?: string }> {
		const { rootPath } = this.settings;

		if (!rootPath) {
			return { ok: false, error: "rootPath is required in settings" };
		}

		try {
			await access(rootPath, constants.R_OK);
			return { ok: true };
		} catch {
			return {
				ok: false,
				error: `Cannot read rootPath: ${rootPath}`,
			};
		}
	}

	async listResources(cursor?: string): Promise<{
		readonly resources: readonly ConnectorResource[];
		readonly nextCursor?: string;
	}> {
		const offset = parseCursor(cursor);
		const files = await discoverFiles(this.settings, {
			maxResults: FILESYSTEM_LIST_PAGE_SIZE + 1,
			skipResults: offset,
		});
		const hasNextPage = files.length > FILESYSTEM_LIST_PAGE_SIZE;
		const page = hasNextPage ? files.slice(0, FILESYSTEM_LIST_PAGE_SIZE) : files;

		const resources: ConnectorResource[] = page.map((f) => ({
			id: f.relativePath,
			name: f.name,
			updatedAt: f.mtime.toISOString(),
		}));

		return {
			resources,
			...(hasNextPage ? { nextCursor: String(offset + FILESYSTEM_LIST_PAGE_SIZE) } : {}),
		};
	}

	async syncIncremental(cursor: SyncCursor): Promise<SyncResult> {
		const since = new Date(cursor.lastSyncAt);
		let added = 0;
		let updated = 0;
		const errors: SyncError[] = [];

		let filesChecked = 0;
		for await (const file of discoverFileStream(this.settings)) {
			if (file.mtime <= since) continue;
			filesChecked += 1;
			const result = await processFile(this.accessor, this.id, file, this.settings.maxFileSize, false);
			added += result.added;
			updated += result.updated;
			if (result.error !== null) errors.push(result.error);
		}

		logger.info("pipeline", "Filesystem incremental sync complete", {
			connectorId: this.id,
			rootPath: this.settings.rootPath,
			filesChecked,
			added,
			updated,
			errors: errors.length,
		});

		return {
			documentsAdded: added,
			documentsUpdated: updated,
			documentsRemoved: 0,
			errors,
			cursor: { lastSyncAt: new Date().toISOString() },
		};
	}

	async syncFull(): Promise<SyncResult> {
		let added = 0;
		let updated = 0;
		const errors: SyncError[] = [];

		let filesTotal = 0;
		for await (const file of discoverFileStream(this.settings)) {
			filesTotal += 1;
			const result = await processFile(this.accessor, this.id, file, this.settings.maxFileSize, true);
			added += result.added;
			updated += result.updated;
			if (result.error !== null) errors.push(result.error);
		}

		logger.info("pipeline", "Filesystem full sync complete", {
			connectorId: this.id,
			rootPath: this.settings.rootPath,
			filesTotal,
			added,
			updated,
			errors: errors.length,
		});

		return {
			documentsAdded: added,
			documentsUpdated: updated,
			documentsRemoved: 0,
			errors,
			cursor: { lastSyncAt: new Date().toISOString() },
		};
	}

	async replay(resourceId: string): Promise<SyncResult> {
		const resolvedRoot = resolve(this.settings.rootPath);
		const absolutePath = resolve(resolvedRoot, resourceId);
		const rel = relative(resolvedRoot, absolutePath);
		if (!rel || rel.startsWith("..") || resolve(rel) === rel) {
			return {
				documentsAdded: 0,
				documentsUpdated: 0,
				documentsRemoved: 0,
				errors: [{ resourceId, message: "Path escapes connector root", retryable: false }],
				cursor: { lastSyncAt: new Date().toISOString() },
			};
		}

		let fileStat: Awaited<ReturnType<typeof stat>>;
		try {
			fileStat = await stat(absolutePath);
		} catch {
			return {
				documentsAdded: 0,
				documentsUpdated: 0,
				documentsRemoved: 0,
				errors: [
					{
						resourceId,
						message: `File not found: ${absolutePath}`,
						retryable: false,
					},
				],
				cursor: { lastSyncAt: new Date().toISOString() },
			};
		}

		const file: DiscoveredFile = {
			absolutePath,
			relativePath: resourceId,
			name: basename(resourceId),
			mtime: fileStat.mtime,
			size: fileStat.size,
		};

		const result = await processFile(this.accessor, this.id, file, this.settings.maxFileSize, true);

		logger.info("pipeline", "Filesystem replay complete", {
			connectorId: this.id,
			resourceId,
		});

		return {
			documentsAdded: result.added,
			documentsUpdated: result.updated,
			documentsRemoved: 0,
			errors: result.error !== null ? [result.error] : [],
			cursor: { lastSyncAt: new Date().toISOString() },
		};
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFilesystemConnector(config: ConnectorConfig, accessor: DbAccessor): ConnectorRuntime {
	return new FilesystemConnector(config, accessor);
}
