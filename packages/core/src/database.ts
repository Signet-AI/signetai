/**
 * SQLite database wrapper for Signet
 */

import { SCHEMA_VERSION } from './constants';
import type { Memory, Conversation, Embedding } from './types';

export class Database {
  private dbPath: string;
  private db: any = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    // Dynamic import for better-sqlite3
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    this.db = new BetterSqlite3(this.dbPath);
    
    // Enable WAL mode
    this.db.pragma('journal_mode = WAL');
    
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

      // Record migration
      this.db.prepare(`
        INSERT OR REPLACE INTO schema_migrations (version, applied_at, checksum)
        VALUES (?, ?, ?)
      `).run(SCHEMA_VERSION, new Date().toISOString(), 'initial');
    }
  }

  private getSchemaVersion(): number {
    try {
      const row = this.db.prepare(
        'SELECT MAX(version) as version FROM schema_migrations'
      ).get();
      return row?.version || 0;
    } catch {
      return 0;
    }
  }

  // Memory operations
  addMemory(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'version'>): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    
    this.db.prepare(`
      INSERT INTO memories (id, type, category, content, confidence, source_id, source_type, tags, created_at, updated_at, updated_by, vector_clock, manual_override)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
      memory.manualOverride ? 1 : 0
    );
    
    return id;
  }

  getMemories(type?: string): Memory[] {
    let query = 'SELECT * FROM memories';
    if (type) query += ' WHERE type = ?';
    query += ' ORDER BY created_at DESC';
    
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
      tags: JSON.parse(row.tags || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      vectorClock: JSON.parse(row.vector_clock || '{}'),
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
