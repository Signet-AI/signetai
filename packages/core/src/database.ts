/**
 * SQLite database wrapper for Signet
 * Runtime-detecting: uses bun:sqlite under Bun, better-sqlite3 under Node.js
 */

import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { arch, platform } from "process";
import { SCHEMA_VERSION } from "./constants";
import type { Memory, Conversation, Embedding } from "./types";

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
	];

	for (const searchPath of searchPaths) {
		// Handle glob-like patterns for bun's versioned directories
		if (searchPath.includes("*")) {
			const baseDir = dirname(searchPath.replace(/\*.*$/, ""));
			const pattern = searchPath.split("*")[1];
			try {
				const entries = existsSync(baseDir)
					? require("fs").readdirSync(baseDir)
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

// Load sqlite-vec extension with fallback handling
function loadSqliteVec(db: any): boolean {
	const extPath = findSqliteVecExtension();
	if (!extPath) {
		console.warn(
			"sqlite-vec extension not found - vector search will be disabled",
		);
		return false;
	}

	try {
		db.loadExtension(extPath);
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
		const isBun = typeof (globalThis as any).Bun !== "undefined";

		if (isBun) {
			// Bun runtime - use built-in bun:sqlite
			// Bun's sqlite uses different options: { create: true, readwrite: true } instead of { readonly: false }
			const { Database: BunDatabase } = await import("bun:sqlite");
			const bunOpts = this.options?.readonly
				? { readonly: true }
				: { readwrite: true, create: true };
			this.db = new BunDatabase(
				this.dbPath,
				bunOpts,
			) as unknown as SQLiteDatabase;
		} else {
			// Node.js runtime - use better-sqlite3
			const BetterSqlite3 = (await import("better-sqlite3")).default;
			this.db = new BetterSqlite3(this.dbPath, {
				readonly: this.options?.readonly,
			}) as SQLiteDatabase;
		}

		// Load sqlite-vec extension for vector search capabilities
		this.vecEnabled = loadSqliteVec(this.db);

		// Enable WAL mode (skip for readonly)
		// Note: bun:sqlite uses exec() for pragmas, better-sqlite3 uses pragma()
		if (!this.options?.readonly) {
			if (isBun) {
				this.db!.exec("PRAGMA journal_mode = WAL");
			} else {
				(this.db as any).pragma("journal_mode = WAL");
			}
		}

		// Run migrations
		await this.migrate();
	}

	private async migrate(): Promise<void> {
		const currentVersion = this.getSchemaVersion();

		if (currentVersion < SCHEMA_VERSION) {
			// Create tables
			this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL,
          checksum TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          harness TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          summary TEXT,
          topics TEXT,
          decisions TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          vector_clock TEXT NOT NULL DEFAULT '{}',
          version INTEGER DEFAULT 1,
          manual_override INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          category TEXT,
          content TEXT NOT NULL,
          confidence REAL DEFAULT 1.0,
          source_id TEXT,
          source_type TEXT,
          tags TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          vector_clock TEXT NOT NULL DEFAULT '{}',
          version INTEGER DEFAULT 1,
          manual_override INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS embeddings (
          id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL UNIQUE,
          vector BLOB NOT NULL,
          dimensions INTEGER NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          chunk_text TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_harness ON conversations(harness);
        CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
        CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
        CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
        CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON embeddings(content_hash);
      `);

			// Create vec0 virtual table for vector similarity search
			// rowid corresponds to the source embedding id for efficient joins
			this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
          embedding FLOAT[768]
        )
      `);

			// Record migration
			this.db
				.prepare(`
        INSERT OR REPLACE INTO schema_migrations (version, applied_at, checksum)
        VALUES (?, ?, ?)
      `)
				.run(SCHEMA_VERSION, new Date().toISOString(), "initial");
		}
	}

	private getSchemaVersion(): number {
		try {
			const row = this.db
				.prepare("SELECT MAX(version) as version FROM schema_migrations")
				.get();
			return (row?.version as number) || 0;
		} catch {
			return 0;
		}
	}

	// Memory operations
	addMemory(
		memory: Omit<Memory, "id" | "createdAt" | "updatedAt" | "version">,
	): string {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		this.db
			.prepare(`
      INSERT INTO memories (id, type, category, content, confidence, source_id, source_type, tags, created_at, updated_at, updated_by, vector_clock, manual_override)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
			.run(
				id,
				memory.type,
				memory.category || null,
				memory.content,
				memory.confidence,
				memory.sourceId || null,
				memory.sourceType || null,
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
			? this.db.prepare(query).all(type)
			: this.db.prepare(query).all();

		return rows.map(this.rowToMemory);
	}

	private rowToMemory(row: any): Memory {
		return {
			id: row.id,
			type: row.type,
			category: row.category,
			content: row.content,
			confidence: row.confidence,
			sourceId: row.source_id,
			sourceType: row.source_type,
			tags: JSON.parse(row.tags || "[]"),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			updatedBy: row.updated_by,
			vectorClock: JSON.parse(row.vector_clock || "{}"),
			version: row.version,
			manualOverride: !!row.manual_override,
		};
	}

	close(): void {
		if (this.db) {
			this.db.close();
		}
	}
}
