/**
 * Filesystem connector — ingests local files into the document pipeline.
 *
 * Walks a configured root directory using glob patterns, creates document
 * rows for matching files, and enqueues document_ingest jobs. Chunking,
 * embedding, and indexing are handled downstream by the document worker.
 */

import { readFileSync } from "node:fs";
import { access, stat, constants } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { Glob } from "bun";
import type {
	ConnectorConfig,
	ConnectorResource,
	ConnectorRuntime,
	SyncCursor,
	SyncError,
	SyncResult,
} from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import { enqueueDocumentIngestJob } from "../pipeline/document-worker";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_PATTERNS = ["**/*.md", "**/*.txt"];
const DEFAULT_IGNORE = [".git", "node_modules", ".DS_Store"];
const DEFAULT_MAX_FILE_SIZE = 1_048_576; // 1 MB

interface FilesystemSettings {
	readonly rootPath: string;
	readonly patterns: readonly string[];
	readonly ignorePatterns: readonly string[];
	readonly maxFileSize: number;
}

function parseSettings(raw: Readonly<Record<string, unknown>>): FilesystemSettings {
	const rootPath =
		typeof raw.rootPath === "string" ? raw.rootPath : "";

	const patterns =
		Array.isArray(raw.patterns) &&
		raw.patterns.every((p) => typeof p === "string")
			? (raw.patterns as string[])
			: DEFAULT_PATTERNS;

	const ignorePatterns =
		Array.isArray(raw.ignorePatterns) &&
		raw.ignorePatterns.every((p) => typeof p === "string")
			? (raw.ignorePatterns as string[])
			: DEFAULT_IGNORE;

	const maxFileSize =
		typeof raw.maxFileSize === "number" && raw.maxFileSize > 0
			? raw.maxFileSize
			: DEFAULT_MAX_FILE_SIZE;

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

async function discoverFiles(
	settings: FilesystemSettings,
): Promise<readonly DiscoveredFile[]> {
	const { rootPath, patterns, ignorePatterns, maxFileSize } = settings;
	const seen = new Set<string>();
	const results: DiscoveredFile[] = [];

	for (const pattern of patterns) {
		const glob = new Glob(pattern);
		for await (const rel of glob.scan({ cwd: rootPath, dot: false })) {
			if (seen.has(rel)) continue;

			// Check against ignore patterns — skip if any segment matches
			const segments = rel.split("/");
			const ignored = ignorePatterns.some(
				(ig) =>
					segments.some((seg) => seg === ig) ||
					rel.startsWith(ig + "/") ||
					rel === ig,
			);
			if (ignored) continue;

			const absolutePath = join(rootPath, rel);
			let fileStat: Awaited<ReturnType<typeof stat>>;
			try {
				fileStat = await stat(absolutePath);
			} catch {
				// File disappeared between scan and stat — skip
				continue;
			}

			if (!fileStat.isFile()) continue;
			if (fileStat.size > maxFileSize) {
				logger.debug("pipeline", "Skipping oversized file", {
					path: rel,
					size: fileStat.size,
					maxFileSize,
				});
				continue;
			}

			seen.add(rel);
			results.push({
				absolutePath,
				relativePath: rel,
				name: basename(rel),
				mtime: fileStat.mtime,
				size: fileStat.size,
			});
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Document row helpers
// ---------------------------------------------------------------------------

interface ExistingDocRow {
	readonly id: string;
	readonly updated_at: string;
}

function findDocBySourceUrl(
	accessor: DbAccessor,
	sourceUrl: string,
): ExistingDocRow | undefined {
	return accessor.withReadDb((db) => {
		return db
			.prepare(
				"SELECT id, updated_at FROM documents WHERE source_url = ? LIMIT 1",
			)
			.get(sourceUrl) as ExistingDocRow | undefined;
	});
}

function readFileContent(
	absolutePath: string,
	maxFileSize: number,
): string | null {
	try {
		const buf = readFileSync(absolutePath);
		if (buf.length > maxFileSize) return null;
		return buf.toString("utf-8");
	} catch {
		return null;
	}
}

/**
 * Insert a new document row and return its id.
 */
function insertDocument(
	accessor: DbAccessor,
	connectorId: string,
	sourceUrl: string,
	title: string,
	rawContent: string,
): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	accessor.withWriteTx((db) => {
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
function updateDocument(
	accessor: DbAccessor,
	docId: string,
	rawContent: string,
): void {
	const now = new Date().toISOString();

	accessor.withWriteTx((db) => {
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

	const content = readFileContent(file.absolutePath, maxFileSize);
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

	const existing = findDocBySourceUrl(accessor, sourceUrl);

	if (existing === undefined) {
		const docId = insertDocument(
			accessor, connectorId, sourceUrl, file.name, content,
		);
		enqueueDocumentIngestJob(accessor, docId);
		return { added: 1, updated: 0, error: null };
	}

	// Only update if forced (full sync / replay) or mtime is newer than doc
	const docUpdatedAt = new Date(existing.updated_at);
	const needsUpdate = forceUpdate || file.mtime > docUpdatedAt;

	if (!needsUpdate) {
		return { added: 0, updated: 0, error: null };
	}

	updateDocument(accessor, existing.id, content);
	enqueueDocumentIngestJob(accessor, existing.id);
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

	async listResources(
		_cursor?: string,
	): Promise<{
		readonly resources: readonly ConnectorResource[];
		readonly nextCursor?: string;
	}> {
		const files = await discoverFiles(this.settings);

		const resources: ConnectorResource[] = files.map((f) => ({
			id: f.relativePath,
			name: f.name,
			updatedAt: f.mtime.toISOString(),
		}));

		// Filesystem listing is not paginated — return all at once
		return { resources };
	}

	async syncIncremental(cursor: SyncCursor): Promise<SyncResult> {
		const since = new Date(cursor.lastSyncAt);
		const files = await discoverFiles(this.settings);
		const changed = files.filter((f) => f.mtime > since);

		let added = 0;
		let updated = 0;
		const errors: SyncError[] = [];

		for (const file of changed) {
			const result = await processFile(
				this.accessor,
				this.id,
				file,
				this.settings.maxFileSize,
				false,
			);
			added += result.added;
			updated += result.updated;
			if (result.error !== null) errors.push(result.error);
		}

		logger.info("pipeline", "Filesystem incremental sync complete", {
			connectorId: this.id,
			rootPath: this.settings.rootPath,
			filesChecked: changed.length,
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
		const files = await discoverFiles(this.settings);

		let added = 0;
		let updated = 0;
		const errors: SyncError[] = [];

		for (const file of files) {
			const result = await processFile(
				this.accessor,
				this.id,
				file,
				this.settings.maxFileSize,
				true,
			);
			added += result.added;
			updated += result.updated;
			if (result.error !== null) errors.push(result.error);
		}

		logger.info("pipeline", "Filesystem full sync complete", {
			connectorId: this.id,
			rootPath: this.settings.rootPath,
			filesTotal: files.length,
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
		// resourceId is the relative path from listResources
		const absolutePath = join(
			resolve(this.settings.rootPath),
			resourceId,
		);

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

		const result = await processFile(
			this.accessor,
			this.id,
			file,
			this.settings.maxFileSize,
			true,
		);

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

export function createFilesystemConnector(
	config: ConnectorConfig,
	accessor: DbAccessor,
): ConnectorRuntime {
	return new FilesystemConnector(config, accessor);
}
