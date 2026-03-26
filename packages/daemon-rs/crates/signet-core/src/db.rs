use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use std::path::Path;
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

use crate::constants::{HIGH_PRIORITY_CAPACITY, LOW_PRIORITY_CAPACITY, READ_POOL_SIZE};
use crate::error::CoreError;
use crate::migrations;

// ---------------------------------------------------------------------------
// Vec extension registration (call once before any connection opens)
// ---------------------------------------------------------------------------

pub fn register_vec_extension() {
    // Rust parity note: unlike the TypeScript daemon on macOS, the rust
    // daemon does not rely on Apple/Homebrew/custom SQLite dylib selection.
    // rusqlite is built with bundled SQLite and sqlite-vec is registered as an
    // auto-extension before any connection opens. Keep this invariant in sync
    // with the TS daemon's startup contract so shadow mode does not diverge.
    // SAFETY: sqlite3_vec_init is the canonical SQLite extension entry point for
    // sqlite-vec. sqlite3_auto_extension DOES call this pointer during connection
    // init, passing (sqlite3*, char**, sqlite3_api_routines*). The transmute is
    // a type-level fiction required by rusqlite's FFI boundary: the sqlite_vec
    // crate exposes the symbol as `fn()` but the underlying C function has the
    // correct signature `int(sqlite3*, char**, sqlite3_api_routines*)` that
    // sqlite3_auto_extension expects. The runtime ABI is correct; only the Rust
    // type representation differs.
    unsafe {
        let func: unsafe extern "C" fn() = sqlite_vec::sqlite3_vec_init;
        #[allow(clippy::missing_transmute_annotations)]
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(func)));
    }
}

fn configure_pragmas(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;",
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Writer task — two-lane bounded channel
// ---------------------------------------------------------------------------

type WriteFn = Box<dyn FnOnce(&Connection) -> Result<serde_json::Value, CoreError> + Send>;

struct WriteRequest {
    op: WriteFn,
    reply: oneshot::Sender<Result<serde_json::Value, CoreError>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    High,
    Low,
}

// ---------------------------------------------------------------------------
// DbPool — the public interface
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct DbPool {
    high_tx: mpsc::Sender<WriteRequest>,
    low_tx: mpsc::Sender<WriteRequest>,
    read_pool: Pool<SqliteConnectionManager>,
    /// Wakes the writer thread whenever work is enqueued on either lane.
    notify_tx: std::sync::mpsc::SyncSender<()>,
}

impl DbPool {
    /// Open the database, run migrations, start the writer task.
    /// Returns `DbPool` and a `JoinHandle` for the writer task.
    pub fn open(path: &Path) -> Result<(Self, tokio::task::JoinHandle<()>), CoreError> {
        // Ensure parent directory exists
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }

        // Register sqlite-vec globally
        register_vec_extension();

        // Open write connection and configure
        let write_conn = Connection::open(path)?;
        configure_pragmas(&write_conn)?;
        verify_vec(&write_conn)?;

        // Run migrations
        migrations::run(&write_conn)?;

        // Ensure FTS and vec tables
        ensure_fts(&write_conn)?;
        ensure_vec_table(&write_conn)?;

        // Build read pool
        let manager = SqliteConnectionManager::file(path).with_flags(
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        );
        let read_pool = Pool::builder().max_size(READ_POOL_SIZE).build(manager)?;

        // Configure read pool connections
        for _ in 0..READ_POOL_SIZE {
            if let Ok(conn) = read_pool.get() {
                let _ = conn.execute_batch("PRAGMA busy_timeout = 5000;");
            }
        }

        // Create writer channels
        let (high_tx, high_rx) = mpsc::channel::<WriteRequest>(HIGH_PRIORITY_CAPACITY);
        let (low_tx, low_rx) = mpsc::channel::<WriteRequest>(LOW_PRIORITY_CAPACITY);

        // Notification channel: capacity 1 — a pending token is enough to wake the writer.
        let (notify_tx, notify_rx) = std::sync::mpsc::sync_channel::<()>(1);

        // Spawn writer task
        let handle = tokio::task::spawn_blocking(move || {
            writer_loop(write_conn, high_rx, low_rx, notify_rx);
        });

        let pool = Self {
            high_tx,
            low_tx,
            read_pool,
            notify_tx,
        };
        Ok((pool, handle))
    }

    /// Execute a write operation with the given priority.
    /// Returns the JSON result from the operation.
    pub async fn write<F>(&self, priority: Priority, op: F) -> Result<serde_json::Value, CoreError>
    where
        F: FnOnce(&Connection) -> Result<serde_json::Value, CoreError> + Send + 'static,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        let req = WriteRequest {
            op: Box::new(op),
            reply: reply_tx,
        };

        let send_result = match priority {
            Priority::High => self.high_tx.send(req).await,
            Priority::Low => self.low_tx.send(req).await,
        };

        send_result.map_err(|_| CoreError::ChannelClosed)?;
        // Wake the writer thread regardless of which lane received work.
        let _ = self.notify_tx.try_send(());
        reply_rx.await.map_err(|_| CoreError::ChannelClosed)?
    }

    /// Execute a write in a transaction (BEGIN IMMEDIATE ... COMMIT/ROLLBACK).
    pub async fn write_tx<F>(
        &self,
        priority: Priority,
        op: F,
    ) -> Result<serde_json::Value, CoreError>
    where
        F: FnOnce(&Connection) -> Result<serde_json::Value, CoreError> + Send + 'static,
    {
        self.write(priority, move |conn| {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            match op(conn) {
                Ok(val) => {
                    conn.execute_batch("COMMIT")?;
                    Ok(val)
                }
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(e)
                }
            }
        })
        .await
    }

    /// Execute a read-only operation on the pool.
    pub async fn read<F, T>(&self, op: F) -> Result<T, CoreError>
    where
        F: FnOnce(&Connection) -> Result<T, CoreError> + Send + 'static,
        T: Send + 'static,
    {
        let pool = self.read_pool.clone();
        tokio::task::spawn_blocking(move || {
            let conn = pool.get()?;
            op(&conn)
        })
        .await
        .map_err(|e| CoreError::Migration(format!("join error: {e}")))?
    }

    /// Get a reference to the read pool for direct access.
    pub fn read_pool(&self) -> &Pool<SqliteConnectionManager> {
        &self.read_pool
    }
}

// ---------------------------------------------------------------------------
// Writer event loop — drains high before low
// ---------------------------------------------------------------------------
//
// Shutdown contract:
//   DbPool is Clone; the writer loop runs until ALL clones are dropped, because
//   both mpsc senders (high_tx, low_tx) and the notify_tx are embedded in DbPool
//   and drop together. When all DbPool clones drop:
//     - high_tx / low_tx drop → high_rx / low_rx report Disconnected on try_recv
//     - notify_tx drops → notify_rx.recv() returns Err
//   The loop checks Disconnected on both try_recv paths and Err on notify_rx.recv(),
//   so it exits cleanly regardless of which signal fires first.
//
//   Pending requests at shutdown: callers hold a oneshot::Receiver for their reply.
//   If the writer exits before sending a reply, the oneshot closes and callers get
//   ChannelClosed. No silent data loss — all in-flight high-priority work is either
//   completed or returns an error to the caller.

fn writer_loop(
    conn: Connection,
    mut high_rx: mpsc::Receiver<WriteRequest>,
    mut low_rx: mpsc::Receiver<WriteRequest>,
    notify_rx: std::sync::mpsc::Receiver<()>,
) {
    loop {
        // Drain all high-priority first
        loop {
            match high_rx.try_recv() {
                Ok(req) => process_write(&conn, req),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => return,
            }
        }

        // Process one low-priority if available
        match low_rx.try_recv() {
            Ok(req) => {
                process_write(&conn, req);
                continue; // Re-check high after each low
            }
            Err(mpsc::error::TryRecvError::Empty) => {}
            Err(mpsc::error::TryRecvError::Disconnected) => return,
        }

        // Both queues empty — block until either lane receives work.
        // notify_rx is driven by DbPool::write() regardless of priority.
        // When the pool is dropped, notify_tx drops too and recv() returns Err.
        match notify_rx.recv() {
            Ok(()) => {} // re-check both queues
            Err(_) => return,
        }
    }
}

fn process_write(conn: &Connection, req: WriteRequest) {
    let result = (req.op)(conn);
    let _ = req.reply.send(result);
}

// ---------------------------------------------------------------------------
// Table helpers (self-healing on startup)
// ---------------------------------------------------------------------------

fn verify_vec(conn: &Connection) -> Result<(), CoreError> {
    let version: String = conn.query_row("SELECT vec_version()", [], |r| r.get(0))?;
    info!(version = %version, "sqlite-vec loaded");
    Ok(())
}

fn ensure_fts(conn: &Connection) -> Result<(), CoreError> {
    let exists: bool = conn
        .prepare("SELECT name FROM sqlite_master WHERE name = 'memories_fts' AND type = 'table'")?
        .exists([])?;

    if exists {
        return Ok(());
    }

    info!("memories_fts missing — recreating FTS5 table");

    conn.execute_batch(
        "CREATE VIRTUAL TABLE memories_fts USING fts5(
            content,
            content='memories',
            content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
            INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
        END;",
    )?;

    // Backfill
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0))?;
    if count > 0 {
        conn.execute_batch(
            "INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories",
        )?;
        info!(count, "backfilled rows into memories_fts");
    }

    Ok(())
}

fn ensure_vec_table(conn: &Connection) -> Result<(), CoreError> {
    let existing: Option<String> = conn
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_embeddings' AND type = 'table'")?
        .query_row([], |r| r.get(0))
        .ok();

    match existing {
        Some(sql) if sql.contains("id TEXT") => return Ok(()),
        Some(_) => {
            warn!("vec_embeddings has old schema — dropping and recreating");
            conn.execute_batch("DROP TABLE vec_embeddings")?;
        }
        None => {}
    }

    // Detect dimensions from existing embeddings
    let dims: usize = conn
        .query_row("SELECT dimensions FROM embeddings LIMIT 1", [], |r| {
            r.get::<_, usize>(0)
        })
        .unwrap_or(crate::constants::DEFAULT_EMBEDDING_DIMENSIONS);

    conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE vec_embeddings USING vec0(
            id TEXT PRIMARY KEY,
            embedding FLOAT[{dims}] distance_metric=cosine
        );"
    ))?;

    info!(dims, "created vec_embeddings table");

    // Backfill missing embeddings
    backfill_vec(conn)?;

    Ok(())
}

fn backfill_vec(conn: &Connection) -> Result<(), CoreError> {
    let vec_count: i64 = conn.query_row("SELECT count(*) FROM vec_embeddings", [], |r| r.get(0))?;
    let emb_count: i64 = conn.query_row("SELECT count(*) FROM embeddings", [], |r| r.get(0))?;

    if emb_count == 0 || vec_count >= emb_count {
        return Ok(());
    }

    let mut stmt = conn.prepare(
        "SELECT e.id, e.vector FROM embeddings e
         LEFT JOIN vec_embeddings v ON v.id = e.id
         WHERE v.id IS NULL",
    )?;

    let rows: Vec<(String, Vec<u8>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    if rows.is_empty() {
        return Ok(());
    }

    let mut insert = conn
        .prepare_cached("INSERT OR REPLACE INTO vec_embeddings (id, embedding) VALUES (?1, ?2)")?;

    conn.execute_batch("BEGIN")?;
    let mut migrated = 0;
    for (id, blob) in &rows {
        // The blob is already in f32 LE format from the TS daemon
        if insert.execute(rusqlite::params![id, blob]).is_ok() {
            migrated += 1;
        }
    }
    conn.execute_batch("COMMIT")?;

    if migrated > 0 {
        info!(
            migrated,
            total = rows.len(),
            "backfilled embeddings into vec_embeddings"
        );
    }

    // Clean orphans
    let orphans: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vec_embeddings v
             LEFT JOIN embeddings e ON e.id = v.id
             WHERE e.id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    if orphans > 0 {
        conn.execute(
            "DELETE FROM vec_embeddings WHERE id NOT IN (SELECT id FROM embeddings)",
            [],
        )?;
        info!(orphans, "cleaned orphaned vec_embeddings rows");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Test-only public wrappers for internal helpers
// ---------------------------------------------------------------------------

#[doc(hidden)]
pub fn configure_pragmas_pub(conn: &Connection) -> Result<(), CoreError> {
    configure_pragmas(conn)
}

#[doc(hidden)]
pub fn ensure_fts_pub(conn: &Connection) -> Result<(), CoreError> {
    ensure_fts(conn)
}

#[doc(hidden)]
pub fn ensure_vec_table_pub(conn: &Connection) -> Result<(), CoreError> {
    ensure_vec_table(conn)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_in_memory() {
        let tmp = std::env::temp_dir().join("signet_db_test.db");
        let _ = std::fs::remove_file(&tmp);

        let (pool, _handle) = DbPool::open(&tmp).expect("failed to open DB");

        // Write a value
        let result = pool
            .write(Priority::High, |conn| {
                conn.execute(
                    "INSERT INTO memories (id, content, created_at, updated_at, updated_by, type)
                     VALUES ('test1', 'hello world', datetime('now'), datetime('now'), 'test', 'fact')",
                    [],
                )?;
                Ok(serde_json::json!({"inserted": true}))
            })
            .await
            .expect("write failed");

        assert_eq!(result["inserted"], true);

        // Read it back
        let content: String = pool
            .read(|conn| {
                let val =
                    conn.query_row("SELECT content FROM memories WHERE id = 'test1'", [], |r| {
                        r.get(0)
                    })?;
                Ok(val)
            })
            .await
            .expect("read failed");

        assert_eq!(content, "hello world");

        // Cleanup
        let _ = std::fs::remove_file(&tmp);
    }

    #[tokio::test]
    async fn existing_db_compat() {
        // Test against the real DB if available
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".into());
        let db_path = std::path::PathBuf::from(&home).join(".agents/memory/memories.db");

        if !db_path.exists() {
            return; // Skip if no real DB
        }

        // Open read-only via pool (don't run migrations on real DB in tests)
        register_vec_extension();
        let manager = SqliteConnectionManager::file(&db_path).with_flags(
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        );
        let pool = Pool::builder().max_size(1).build(manager).unwrap();
        let conn = pool.get().unwrap();

        let count: i64 = conn
            .query_row("SELECT count(*) FROM memories", [], |r| r.get(0))
            .unwrap();
        assert!(count > 0, "real DB should have memories");

        let version: String = conn
            .query_row("SELECT vec_version()", [], |r| r.get(0))
            .unwrap();
        assert!(version.starts_with("v"), "vec_version should start with v");
    }

    #[test]
    fn vec_is_available_without_external_sqlite_selection() {
        register_vec_extension();
        let conn = Connection::open_in_memory().expect("open in-memory db");
        let version: String = conn
            .query_row("SELECT vec_version()", [], |r| r.get(0))
            .expect("sqlite-vec should be available without external dylib selection");
        assert!(
            version.starts_with('v'),
            "vec_version should start with v, got {version}"
        );
    }
}
