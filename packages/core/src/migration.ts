/**
 * Schema migration system for Signet
 * Detects and migrates between different memory database schemas
 */

export type SchemaType = "python" | "cli-v1" | "core" | "unknown";

export interface SchemaInfo {
	type: SchemaType;
	version: number;
	hasMemories: boolean;
	hasConversations: boolean;
	hasEmbeddings: boolean;
	hasFts: boolean;
	memoryCount: number;
	columns: string[];
}

export interface MigrationResult {
	migrated: boolean;
	fromSchema: SchemaType;
	toSchema: SchemaType;
	memoriesMigrated: number;
	errors: string[];
}

/**
 * Detect the current schema type by examining table structure
 */
export function detectSchema(db: {
	prepare(sql: string): {
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
	exec?(sql: string): void;
}): SchemaInfo {
	let columns: string[] = [];
	let hasMemories = false;
	let hasConversations = false;
	let hasEmbeddings = false;
	let hasFts = false;
	let memoryCount = 0;

	try {
		// Check if memories table exists and get its columns
		const tableInfo = db.prepare("PRAGMA table_info(memories)").all() as Array<{
			name: string;
			type: string;
		}>;
		hasMemories = tableInfo.length > 0;
		columns = tableInfo.map((col) => col.name);

		// Get memory count
		if (hasMemories) {
			const countResult = db
				.prepare("SELECT COUNT(*) as count FROM memories")
				.get() as { count: number } | undefined;
			memoryCount = countResult?.count || 0;
		}
	} catch {
		hasMemories = false;
	}

	try {
		const convInfo = db
			.prepare("PRAGMA table_info(conversations)")
			.all() as Array<{ name: string }>;
		hasConversations = convInfo.length > 0;
	} catch {
		hasConversations = false;
	}

	try {
		const embInfo = db.prepare("PRAGMA table_info(embeddings)").all() as Array<{
			name: string;
		}>;
		hasEmbeddings = embInfo.length > 0;
	} catch {
		hasEmbeddings = false;
	}

	try {
		db.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'",
		).get();
		hasFts = true;
	} catch {
		hasFts = false;
	}

	// Detect schema type based on column patterns
	let type: SchemaType = "unknown";

	if (hasMemories) {
		// Python schema: has 'who', 'why', 'project', 'session_id', INTEGER id
		const hasPythonColumns = columns.includes("who") && columns.includes("why");

		// CLI-v1 schema: has 'source', 'accessed_at', TEXT id
		const hasCliV1Columns =
			columns.includes("source") && columns.includes("accessed_at");

		// Core schema: has 'category', 'confidence', 'source_id', 'source_type', 'updated_by', 'vector_clock'
		const hasCoreColumns =
			columns.includes("category") &&
			columns.includes("confidence") &&
			columns.includes("source_id") &&
			columns.includes("vector_clock");

		if (hasCoreColumns) {
			type = "core";
		} else if (hasPythonColumns) {
			type = "python";
		} else if (hasCliV1Columns) {
			type = "cli-v1";
		}
	}

	// Get version from schema_migrations if it exists
	let version = 0;
	try {
		const versionResult = db
			.prepare("SELECT MAX(version) as version FROM schema_migrations")
			.get() as { version: number } | undefined;
		version = versionResult?.version || 0;
	} catch {
		version = 0;
	}

	return {
		type,
		version,
		hasMemories,
		hasConversations,
		hasEmbeddings,
		hasFts,
		memoryCount,
		columns,
	};
}

/**
 * Ensure schema_migrations table has all required columns
 * Handles migration from old schema that was missing checksum column
 */
export function ensureMigrationsTableSchema(db: {
	exec(sql: string): void;
	prepare(sql: string): {
		all(...args: unknown[]): Record<string, unknown>[];
	};
}): void {
	// Create table if it doesn't exist
	db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    )
  `);

	// Check if checksum column exists (migrate old schema)
	try {
		const columns = db
			.prepare("PRAGMA table_info(schema_migrations)")
			.all() as Array<{ name: string }>;
		const hasChecksum = columns.some((col) => col.name === "checksum");

		if (!hasChecksum) {
			// Old schema without checksum - add the column with a default
			db.exec(
				"ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT 'migrated'",
			);
		}
	} catch {
		// Table doesn't exist or other error - the CREATE above should handle it
	}
}

/**
 * The unified schema that all migrations target
 */
export const UNIFIED_SCHEMA = `
  -- Schema version tracking
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL
  );

  -- Conversations table
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

  -- Unified memories table with all fields from all schemas
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'fact',
    category TEXT,
    content TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    importance REAL DEFAULT 0.5,
    source_id TEXT,
    source_type TEXT,
    tags TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    last_accessed TEXT,
    access_count INTEGER DEFAULT 0,
    vector_clock TEXT NOT NULL DEFAULT '{}',
    version INTEGER DEFAULT 1,
    manual_override INTEGER DEFAULT 0,
    pinned INTEGER DEFAULT 0
  );

  -- Embeddings table
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

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_harness ON conversations(harness);
  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned);
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
  CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON embeddings(content_hash);
`;

/**
 * Migrate from Python schema to unified schema
 */
function migrateFromPython(
	db: {
		exec(sql: string): void;
		prepare(sql: string): {
			run(...args: unknown[]): void;
			all(...args: unknown[]): Record<string, unknown>[];
		};
	},
	schemaInfo: SchemaInfo,
): number {
	// Create backup of old data
	const oldMemories = db
		.prepare(`
    SELECT id, content, who, why, created_at, project, session_id,
           importance, last_accessed, access_count, type, tags, pinned
    FROM memories
  `)
		.all() as Array<Record<string, unknown>>;

	// Drop old table and create new one
	db.exec(`DROP TABLE IF EXISTS memories`);
	db.exec(`DROP TABLE IF EXISTS memories_fts`);
	db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'fact',
      category TEXT,
      content TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      importance REAL DEFAULT 0.5,
      source_id TEXT,
      source_type TEXT,
      tags TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      last_accessed TEXT,
      access_count INTEGER DEFAULT 0,
      vector_clock TEXT NOT NULL DEFAULT '{}',
      version INTEGER DEFAULT 1,
      manual_override INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0
    )
  `);

	// Migrate data
	const insert = db.prepare(`
    INSERT INTO memories (id, type, category, content, confidence, importance,
                         source_id, source_type, tags, created_at, updated_at,
                         updated_by, last_accessed, access_count, pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

	let migrated = 0;
	for (const row of oldMemories) {
		const oldId = row.id;
		const newId = `migrated_${oldId}`;

		// Map fields
		const content = String(row.content || "");
		const type = String(row.type || "fact");
		const category = row.project ? String(row.project) : null;
		const importance =
			typeof row.importance === "number" ? row.importance : 0.5;
		const sourceId = row.session_id ? String(row.session_id) : null;
		const sourceType = row.session_id ? "session" : null;
		const updatedAt =
			row.last_accessed || row.created_at || new Date().toISOString();
		const updatedBy = row.who ? String(row.who) : "migration";
		const lastAccessed = row.last_accessed ? String(row.last_accessed) : null;
		const accessCount =
			typeof row.access_count === "number" ? row.access_count : 0;
		const pinned = row.pinned ? 1 : 0;
		const createdAt = row.created_at
			? String(row.created_at)
			: new Date().toISOString();

		// Build tags including 'why' if present
		let tags: string[] = [];
		if (row.tags) {
			try {
				tags =
					typeof row.tags === "string"
						? row.tags.split(",").map((t) => t.trim())
						: [];
			} catch {
				tags = [];
			}
		}
		if (row.why) {
			tags.push(`why:${row.why}`);
		}
		const tagsJson = JSON.stringify(tags);

		insert.run(
			newId,
			type,
			category,
			content,
			1.0,
			importance,
			sourceId,
			sourceType,
			tagsJson,
			createdAt,
			updatedAt,
			updatedBy,
			lastAccessed,
			accessCount,
			pinned,
		);
		migrated++;
	}

	// Recreate FTS
	db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content=memories,
      content_rowid=rowid
    )
  `);

	// Populate FTS
	if (migrated > 0) {
		db.exec(`
      INSERT INTO memories_fts(rowid, content)
      SELECT rowid, content FROM memories
    `);
	}

	// Create triggers for FTS sync
	db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES('delete', old.rowid, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);

	return migrated;
}

/**
 * Migrate from CLI-v1 schema to unified schema
 */
function migrateFromCliV1(
	db: {
		exec(sql: string): void;
		prepare(sql: string): {
			run(...args: unknown[]): void;
			all(...args: unknown[]): Record<string, unknown>[];
		};
	},
	schemaInfo: SchemaInfo,
): number {
	// Get old data
	const oldMemories = db
		.prepare(`
    SELECT id, content, type, source, importance, tags, created_at, updated_at, accessed_at, access_count
    FROM memories
  `)
		.all() as Array<Record<string, unknown>>;

	// Drop and recreate
	db.exec(`DROP TABLE IF EXISTS memories`);
	db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'fact',
      category TEXT,
      content TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      importance REAL DEFAULT 0.5,
      source_id TEXT,
      source_type TEXT,
      tags TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      last_accessed TEXT,
      access_count INTEGER DEFAULT 0,
      vector_clock TEXT NOT NULL DEFAULT '{}',
      version INTEGER DEFAULT 1,
      manual_override INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0
    )
  `);

	const insert = db.prepare(`
    INSERT INTO memories (id, type, category, content, confidence, importance,
                         source_id, source_type, tags, created_at, updated_at,
                         updated_by, last_accessed, access_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

	let migrated = 0;
	for (const row of oldMemories) {
		const id = String(row.id);
		const content = String(row.content || "");
		const type = String(row.type || "fact");
		const importance =
			typeof row.importance === "number" ? row.importance : 0.5;
		const sourceId = row.source ? String(row.source) : null;
		const sourceType = row.source ? "import" : null;
		const tags = row.tags ? String(row.tags) : "[]";
		const createdAt = row.created_at
			? String(row.created_at)
			: new Date().toISOString();
		const updatedAt = row.updated_at ? String(row.updated_at) : createdAt;
		const updatedBy = "migration";
		const lastAccessed = row.accessed_at ? String(row.accessed_at) : null;
		const accessCount =
			typeof row.access_count === "number" ? row.access_count : 0;

		insert.run(
			id,
			type,
			null,
			content,
			1.0,
			importance,
			sourceId,
			sourceType,
			tags,
			createdAt,
			updatedAt,
			updatedBy,
			lastAccessed,
			accessCount,
		);
		migrated++;
	}

	// Create FTS if not exists
	db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content=memories,
      content_rowid=rowid
    )
  `);

	if (migrated > 0) {
		db.exec(
			`INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories`,
		);
	}

	return migrated;
}

/**
 * Ensure database has the unified schema, migrating if necessary
 */
export function ensureUnifiedSchema(db: {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...args: unknown[]): void;
		all(...args: unknown[]): Record<string, unknown>[];
		get(...args: unknown[]): Record<string, unknown> | undefined;
	};
}): MigrationResult {
	const result: MigrationResult = {
		migrated: false,
		fromSchema: "unknown",
		toSchema: "core",
		memoriesMigrated: 0,
		errors: [],
	};

	try {
		const schemaInfo = detectSchema(db);
		result.fromSchema = schemaInfo.type;

		// Already on core schema
		if (schemaInfo.type === "core") {
			// Just ensure all tables exist (idempotent)
			db.exec(UNIFIED_SCHEMA);
			// Ensure schema_migrations has checksum column (migrate old schema)
			ensureMigrationsTableSchema(db);
			return result;
		}

		// No memories table yet - just create schema
		if (!schemaInfo.hasMemories) {
			db.exec(UNIFIED_SCHEMA);
			ensureMigrationsTableSchema(db);
			return result;
		}

		// Migrate from Python schema
		if (schemaInfo.type === "python") {
			result.memoriesMigrated = migrateFromPython(db, schemaInfo);
			result.migrated = true;

			// Create remaining tables
			db.exec(`
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
        CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
        CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON embeddings(content_hash);
      `);
			return result;
		}

		// Migrate from CLI-v1 schema
		if (schemaInfo.type === "cli-v1") {
			result.memoriesMigrated = migrateFromCliV1(db, schemaInfo);
			result.migrated = true;

			// Create remaining tables
			db.exec(`
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
        CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
        CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON embeddings(content_hash);
      `);
			return result;
		}

		// Unknown schema with memories - attempt to preserve data
		if (schemaInfo.hasMemories && schemaInfo.memoryCount > 0) {
			result.errors.push(
				`Unknown schema with ${schemaInfo.memoryCount} memories - manual migration may be needed`,
			);
		}

		// Create unified schema anyway
		db.exec(UNIFIED_SCHEMA);
	} catch (err) {
		result.errors.push(err instanceof Error ? err.message : String(err));
	}

	return result;
}
