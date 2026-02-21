/**
 * SQLite database wrapper for Signet
 * Runtime-detecting: uses bun:sqlite under Bun, better-sqlite3 under Node.js
 */

import { existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { arch, platform } from "process";
import { runMigrations } from "./migrations/index";
import type { Memory, Conversation, Embedding } from "./types";
import type { MemoryHistory, MemoryJob } from "./types";

// Platform-specific extension suffix
function getExtensionSuffix(): string {
	if (platform === "win32") return "dll";
	if (platform === "darwin") return "dylib";
	return "so";
}

// Get the platform-specific package name
function getPlatformPackageName(): string {
	const os = platform === "win32" ? "windows" : platform;
	return `sqlite-vec-${os}-${arch === "x64" ? "x64" : arch}`;
}

// Find the sqlite-vec extension path
// Handles bun's hoisted node_modules structure where platform packages
// are in separate .bun directories
function findSqliteVecExtension(): string | null {
	const platformPkg = getPlatformPackageName();
	const extFile = `vec0.${getExtensionSuffix()}`;

	// Try common locations in order
	const searchPaths = [
		// Standard npm/yarn layout
		join(__dirname, "..", "..", platformPkg, extFile),
		// Bun's hoisted structure (multiple possible locations)
		join(
			__dirname,
			"..",
			"..",
			"..",
			".bun",
			`${platformPkg}@*`,
			"node_modules",
			platformPkg,
			extFile,
		),
		// When running from dist/
		join(__dirname, "node_modules", platformPkg, extFile),
		// Monorepo root node_modules
		join(__dirname, "..", "..", "..", "node_modules", platformPkg, extFile),
		// Monorepo root with bun structure
		join(
			__dirname,
			"..",
			"..",
			"..",
			"node_modules",
			".bun",
			`${platformPkg}@*`,
			"node_modules",
			platformPkg,
			extFile,
		),
		// Bun global install cache (~/.bun/install/cache/)
		join(
			homedir(),
			".bun",
			"install",
			"cache",
			`${platformPkg}@*`,
			extFile,
		),
	];

	for (const searchPath of searchPaths) {
		// Handle glob-like patterns for bun's versioned directories
		if (searchPath.includes("*")) {
			const baseDir = dirname(searchPath.replace(/\*.*$/, ""));
			const pattern = searchPath.split("*")[1];
			try {
				const entries = existsSync(baseDir)
					? readdirSync(baseDir)
					: [];
				for (const entry of entries) {
					const candidate = join(
						baseDir,
						entry,
						pattern?.replace(/^\//, "") || "",
					);
					if (existsSync(candidate)) {
						return candidate;
					}
				}
			} catch {}
		} else if (existsSync(searchPath)) {
			return searchPath;
		}
	}

	return null;
}

/** Find the sqlite-vec native extension path, or null if unavailable. */
export { findSqliteVecExtension };

/**
 * Load sqlite-vec extension onto a database connection.
 * Returns true if the extension was loaded successfully.
 */
export function loadSqliteVec(db: unknown): boolean {
	const extPath = findSqliteVecExtension();
	if (!extPath) {
		console.warn(
			"sqlite-vec extension not found - vector search will be disabled",
		);
		return false;
	}

	try {
		(db as { loadExtension(p: string): void }).loadExtension(extPath);
		return true;
	} catch (e) {
		console.warn("Failed to load sqlite-vec extension:", e);
		return false;
	}
}

// Common SQLite interface shared by both implementations
interface SQLiteDatabase {
	pragma(pragma: string): void;
	exec(sql: string): void;
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
	close(): void;
}

export class Database {
	private dbPath: string;
	private db: SQLiteDatabase | null = null;
	private options?: { readonly?: boolean };
	private vecEnabled: boolean = false;

	constructor(dbPath: string, options?: { readonly?: boolean }) {
		this.dbPath = dbPath;
		this.options = options;
	}

	async init(): Promise<void> {
		// Detect runtime and load appropriate SQLite implementation
		const isBun =
			typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

		if (isBun) {
			const { Database: BunDatabase } = await import("bun:sqlite");
			const bunOpts = this.options?.readonly
				? { readonly: true }
				: { readwrite: true, create: true };
			this.db = new BunDatabase(
				this.dbPath,
				bunOpts,
			) as unknown as SQLiteDatabase;
		} else {
			const BetterSqlite3 = (await import("better-sqlite3")).default;
			this.db = new BetterSqlite3(this.dbPath, {
				readonly: this.options?.readonly,
			}) as SQLiteDatabase;
		}

		// Load sqlite-vec extension for vector search capabilities
		this.vecEnabled = loadSqliteVec(this.db);

		// Enable WAL mode (skip for readonly)
		if (!this.options?.readonly) {
			if (isBun) {
				this.getDb().exec("PRAGMA journal_mode = WAL");
			} else {
				(this.getDb() as { pragma(s: string): void }).pragma(
					"journal_mode = WAL",
				);
			}
		}

		// Run migrations
		runMigrations(this.getDb());
	}

	/** Safe accessor that throws if db isn't initialized. */
	private getDb(): SQLiteDatabase {
		if (this.db === null) {
			throw new Error("Database not initialized — call init() first");
		}
		return this.db;
	}

	// -- Memory CRUD --

	addMemory(
		memory: Omit<Memory, "id" | "createdAt" | "updatedAt" | "version">,
	): string {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		this.getDb()
			.prepare(
				`INSERT INTO memories
				 (id, type, category, content, confidence, source_id,
				  source_type, tags, created_at, updated_at, updated_by,
				  vector_clock, manual_override)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				memory.type,
				memory.category ?? null,
				memory.content,
				memory.confidence,
				memory.sourceId ?? null,
				memory.sourceType ?? null,
				JSON.stringify(memory.tags),
				now,
				now,
				memory.updatedBy,
				JSON.stringify(memory.vectorClock),
				memory.manualOverride ? 1 : 0,
			);

		return id;
	}

	getMemories(type?: string): Memory[] {
		let query = "SELECT * FROM memories";
		if (type) query += " WHERE type = ?";
		query += " ORDER BY created_at DESC";

		const rows = type
			? this.getDb().prepare(query).all(type)
			: this.getDb().prepare(query).all();

		return rows.map(rowToMemory);
	}

	getMemoryById(id: string): Memory | null {
		const row = this.getDb()
			.prepare("SELECT * FROM memories WHERE id = ?")
			.get(id);
		if (row === undefined) return null;
		return rowToMemory(row);
	}

	updateMemory(id: string, updates: Partial<Memory>): void {
		const sets: string[] = [];
		const values: unknown[] = [];

		const fieldMap: Record<string, string> = {
			type: "type",
			category: "category",
			content: "content",
			confidence: "confidence",
			importance: "importance",
			pinned: "pinned",
			contentHash: "content_hash",
			normalizedContent: "normalized_content",
			extractionStatus: "extraction_status",
			embeddingModel: "embedding_model",
			extractionModel: "extraction_model",
			who: "who",
		};

		for (const [key, col] of Object.entries(fieldMap)) {
			if (key in updates) {
				sets.push(`${col} = ?`);
				const val = updates[key as keyof Memory];
				if (key === "pinned") {
					values.push(val ? 1 : 0);
				} else {
					values.push(val ?? null);
				}
			}
		}

		if (updates.tags !== undefined) {
			sets.push("tags = ?");
			values.push(JSON.stringify(updates.tags));
		}

		if (sets.length === 0) return;

		sets.push("updated_at = ?");
		values.push(new Date().toISOString());

		sets.push("update_count = COALESCE(update_count, 0) + 1");

		values.push(id);

		this.getDb()
			.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`)
			.run(...values);
	}

	softDeleteMemory(id: string, deletedBy: string, reason?: string): void {
		const now = new Date().toISOString();

		// Grab old content for history
		const existing = this.getMemoryById(id);
		if (existing === null) return;

		this.getDb()
			.prepare(
				`UPDATE memories
				 SET is_deleted = 1, deleted_at = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(now, now, id);

		this.addHistoryEvent({
			memoryId: id,
			event: "deleted",
			oldContent: existing.content,
			changedBy: deletedBy,
			reason,
		});
	}

	recoverMemory(id: string, recoveredBy: string): void {
		const now = new Date().toISOString();

		this.getDb()
			.prepare(
				`UPDATE memories
				 SET is_deleted = 0, deleted_at = NULL, updated_at = ?
				 WHERE id = ?`,
			)
			.run(now, id);

		this.addHistoryEvent({
			memoryId: id,
			event: "recovered",
			changedBy: recoveredBy,
		});
	}

	// -- History --

	addHistoryEvent(event: Omit<MemoryHistory, "id" | "createdAt">): string {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		this.getDb()
			.prepare(
				`INSERT INTO memory_history
				 (id, memory_id, event, old_content, new_content,
				  changed_by, reason, metadata, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				event.memoryId,
				event.event,
				event.oldContent ?? null,
				event.newContent ?? null,
				event.changedBy,
				event.reason ?? null,
				event.metadata ?? null,
				now,
			);

		return id;
	}

	getHistory(memoryId: string): MemoryHistory[] {
		const rows = this.getDb()
			.prepare(
				`SELECT * FROM memory_history
				 WHERE memory_id = ?
				 ORDER BY created_at ASC`,
			)
			.all(memoryId);

		return rows.map(rowToHistory);
	}

	// -- Job queue --

	enqueueJob(
		job: Omit<MemoryJob, "id" | "createdAt" | "updatedAt" | "attempts">,
	): string {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		this.getDb()
			.prepare(
				`INSERT INTO memory_jobs
				 (id, memory_id, job_type, status, payload, result,
				  max_attempts, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				job.memoryId,
				job.jobType,
				job.status,
				job.payload ?? null,
				job.result ?? null,
				job.maxAttempts,
				now,
				now,
			);

		return id;
	}

	leaseJob(jobType: string): MemoryJob | null {
		const now = new Date().toISOString();

		// Find the oldest pending job of this type
		const row = this.getDb()
			.prepare(
				`SELECT * FROM memory_jobs
				 WHERE job_type = ? AND status = 'pending'
				 ORDER BY created_at ASC
				 LIMIT 1`,
			)
			.get(jobType);

		if (row === undefined) return null;

		const id = row.id as string;

		this.getDb()
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'leased',
				     leased_at = ?,
				     attempts = COALESCE(attempts, 0) + 1,
				     updated_at = ?
				 WHERE id = ?`,
			)
			.run(now, now, id);

		// Return the updated row
		const updated = this.getDb()
			.prepare("SELECT * FROM memory_jobs WHERE id = ?")
			.get(id);
		if (updated === undefined) return null;
		return rowToJob(updated);
	}

	completeJob(id: string, result?: string): void {
		const now = new Date().toISOString();
		this.getDb()
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'completed',
				     completed_at = ?,
				     result = ?,
				     updated_at = ?
				 WHERE id = ?`,
			)
			.run(now, result ?? null, now, id);
	}

	failJob(id: string, error: string): void {
		const now = new Date().toISOString();

		// Check if we've exceeded max_attempts
		const row = this.getDb()
			.prepare("SELECT attempts, max_attempts FROM memory_jobs WHERE id = ?")
			.get(id);

		const attempts = row !== undefined ? (row.attempts as number) : 0;
		const maxAttempts = row !== undefined ? (row.max_attempts as number) : 3;
		const nextStatus = attempts >= maxAttempts ? "dead" : "failed";

		this.getDb()
			.prepare(
				`UPDATE memory_jobs
				 SET status = ?,
				     failed_at = ?,
				     error = ?,
				     updated_at = ?
				 WHERE id = ?`,
			)
			.run(nextStatus, now, error, now, id);
	}

	requeueDead(): number {
		const now = new Date().toISOString();
		this.getDb()
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'pending',
				     attempts = 0,
				     error = NULL,
				     failed_at = NULL,
				     updated_at = ?
				 WHERE status = 'dead'`,
			)
			.run(now);

		const count = this.getDb().prepare("SELECT changes() as n").get();
		return count !== undefined ? (count.n as number) : 0;
	}

	close(): void {
		if (this.db) {
			this.db.close();
		}
	}
}

// -- Row mappers (module-level, no `this`) --

function rowToMemory(row: Record<string, unknown>): Memory {
	return {
		id: row.id as string,
		type: row.type as Memory["type"],
		category: row.category as string | undefined,
		content: row.content as string,
		confidence: row.confidence as number,
		sourceId: row.source_id as string | undefined,
		sourceType: row.source_type as string | undefined,
		tags: JSON.parse((row.tags as string) || "[]"),
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
		updatedBy: row.updated_by as string,
		vectorClock: JSON.parse((row.vector_clock as string) || "{}"),
		version: row.version as number,
		manualOverride: Boolean(row.manual_override),
		// v2 optional fields
		contentHash: row.content_hash as string | undefined,
		normalizedContent: row.normalized_content as string | undefined,
		isDeleted: row.is_deleted === 1,
		deletedAt: row.deleted_at as string | undefined,
		pinned: row.pinned === 1,
		importance: row.importance as number | undefined,
		extractionStatus: row.extraction_status as
			| Memory["extractionStatus"]
			| undefined,
		embeddingModel: row.embedding_model as string | undefined,
		extractionModel: row.extraction_model as string | undefined,
		updateCount: row.update_count as number | undefined,
		accessCount: row.access_count as number | undefined,
		lastAccessed: row.last_accessed as string | undefined,
		who: row.who as string | undefined,
	};
}

function rowToHistory(row: Record<string, unknown>): MemoryHistory {
	return {
		id: row.id as string,
		memoryId: row.memory_id as string,
		event: row.event as MemoryHistory["event"],
		oldContent: row.old_content as string | undefined,
		newContent: row.new_content as string | undefined,
		changedBy: row.changed_by as string,
		reason: row.reason as string | undefined,
		metadata: row.metadata as string | undefined,
		createdAt: row.created_at as string,
	};
}

function rowToJob(row: Record<string, unknown>): MemoryJob {
	return {
		id: row.id as string,
		memoryId: row.memory_id as string,
		jobType: row.job_type as string,
		status: row.status as MemoryJob["status"],
		payload: row.payload as string | undefined,
		result: row.result as string | undefined,
		attempts: row.attempts as number,
		maxAttempts: row.max_attempts as number,
		leasedAt: row.leased_at as string | undefined,
		completedAt: row.completed_at as string | undefined,
		failedAt: row.failed_at as string | undefined,
		error: row.error as string | undefined,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}
