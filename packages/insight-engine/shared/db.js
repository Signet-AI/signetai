'use strict';
/**
 * shared/db.js
 *
 * Safe SQLite connection to Signet's memories.db.
 * Uses Node.js built-in `node:sqlite` (available since Node v22.5+) — no native
 * build required, works on any platform.
 *
 * This service ONLY writes to NEW tables/columns:
 *   - insights          (new table)
 *   - insight_sources   (new table)
 *   - memories.insight_processed_at  (new nullable column)
 *   - ingestion_jobs    (new rows only)
 *
 * NEVER modifies: memories content, embeddings, entities, relations,
 * memory_jobs, conversations, or any other existing Signet data.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const os   = require('os');
const fs   = require('fs');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.agents', 'memory', 'memories.db');

let _db = null;

function getDb(dbPath = DEFAULT_DB_PATH) {
  if (_db) return _db;

  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `Signet memories.db not found at: ${dbPath}\nIs Signet installed and initialized? Run: signet status`
    );
  }

  _db = new DatabaseSync(dbPath);

  // Set busy timeout so we wait for Signet's write locks rather than crashing
  _db.exec('PRAGMA busy_timeout = 5000;');

  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * node:sqlite's DatabaseSync uses a slightly different API from better-sqlite3.
 * Wrap prepare() so callers get { all(), get(), run() } — same interface.
 *
 * Usage: db.prepare('SELECT ...').all(params)
 *        db.prepare('INSERT ...').run(params)
 */
const _origGetDb = getDb;

// Patch: return a proxy that makes DatabaseSync look like better-sqlite3
function getPatchedDb(dbPath = DEFAULT_DB_PATH) {
  const raw = _origGetDb(dbPath);
  return {
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        all(...args)  { return stmt.all(...args); },
        get(...args)  { return stmt.get(...args); },
        run(...args)  { return stmt.run(...args); },
      };
    },
    exec(sql) { return raw.exec(sql); },
    close()   { raw.close(); _db = null; },

    /**
     * transaction(fn) — mimics better-sqlite3's transaction() API.
     * Wraps `fn` in a BEGIN/COMMIT/ROLLBACK block.
     * Returns a callable function (same pattern as better-sqlite3).
     *
     * Usage: const doWork = db.transaction(() => { ... }); doWork();
     *
     * @param {Function} fn - Function containing DB operations to run atomically
     * @returns {Function} Wrapped function that executes atomically
     */
    transaction(fn) {
      return (...args) => {
        raw.exec('BEGIN');
        try {
          const result = fn(...args);
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          try { raw.exec('ROLLBACK'); } catch (_) { /* ignore rollback errors */ }
          throw err;
        }
      };
    },
  };
}

module.exports = { getDb: getPatchedDb, closeDb, DEFAULT_DB_PATH };
