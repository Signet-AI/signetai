use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::{
    any::Any,
    fs,
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("sqlite: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("serialization: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("database owner queue is full (capacity {capacity})")]
    QueueFull { capacity: usize },
    #[error("database owner stopped")]
    OwnerStopped,
    #[error("record not found")]
    NotFound,
    #[error("invalid input: {0}")]
    InvalidInput(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Memory {
    pub id: String,
    pub agent_id: String,
    pub content: String,
    pub metadata: serde_json::Value,
    pub deleted: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NewMemory {
    pub content: String,
    pub metadata: serde_json::Value,
}

impl NewMemory {
    pub fn text(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            metadata: serde_json::json!({}),
        }
    }
}

#[derive(Clone, Debug)]
pub struct UpdateMemory {
    pub content: String,
    pub metadata: serde_json::Value,
}

impl UpdateMemory {
    pub fn text(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            metadata: serde_json::json!({}),
        }
    }
}

type JobResult = Result<Box<dyn Any + Send>, CoreError>;
type Job = Box<dyn FnOnce(&mut Connection) -> JobResult + Send + 'static>;

struct Request {
    job: Job,
    reply: mpsc::Sender<JobResult>,
}

#[derive(Clone)]
pub struct Core {
    tx: mpsc::SyncSender<Request>,
    capacity: usize,
}

impl Core {
    pub fn open(path: &Path, capacity: usize) -> Result<Self, CoreError> {
        let capacity = capacity.max(1);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        }
        let (tx, rx) = mpsc::sync_channel::<Request>(capacity);
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), CoreError>>();
        let database_path = path.to_path_buf();
        thread::Builder::new()
            .name("signet-workspace-owner".into())
            .spawn(move || owner_loop(database_path, rx, ready_tx))
            .map_err(|_| CoreError::OwnerStopped)?;
        ready_rx.recv().map_err(|_| CoreError::OwnerStopped)??;
        Ok(Self { tx, capacity })
    }

    fn call<T>(
        &self,
        job: impl FnOnce(&mut Connection) -> Result<T, CoreError> + Send + 'static,
    ) -> Result<T, CoreError>
    where
        T: Send + 'static,
    {
        let (reply_tx, reply_rx) = mpsc::channel();
        let request = Request {
            job: Box::new(move |connection| Ok(Box::new(job(connection)?))),
            reply: reply_tx,
        };
        self.tx.try_send(request).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => CoreError::QueueFull {
                capacity: self.capacity,
            },
            mpsc::TrySendError::Disconnected(_) => CoreError::OwnerStopped,
        })?;
        let result = reply_rx.recv().map_err(|_| CoreError::OwnerStopped)??;
        result
            .downcast::<T>()
            .map(|value| *value)
            .map_err(|_| CoreError::OwnerStopped)
    }

    pub fn initialize(&self) -> Result<(), CoreError> {
        self.call(|connection| {
            migrate(connection)?;
            Ok(())
        })
    }

    pub fn ready(&self) -> Result<bool, CoreError> {
        self.call(|connection| {
            let value: i64 = connection.query_row("SELECT 1", [], |row| row.get(0))?;
            Ok(value == 1)
        })
    }

    pub fn remember(&self, agent: &str, memory: NewMemory) -> Result<String, CoreError> {
        let agent = required_agent(agent)?;
        if memory.content.trim().is_empty() {
            return Err(CoreError::InvalidInput("content must not be empty".into()));
        }
        self.call(move |connection| {
            let id = uuid::Uuid::new_v4().to_string();
            let metadata = serde_json::to_string(&memory.metadata)?;
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO memories (id, agent_id, content, metadata, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))",
                params![id, agent, memory.content, metadata],
            )?;
            record_history(&transaction, &id, &agent, "remember", None)?;
            transaction.commit()?;
            Ok(id)
        })
    }

    pub fn list(&self, agent: &str, include_deleted: bool) -> Result<Vec<Memory>, CoreError> {
        let agent = required_agent(agent)?;
        self.call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT id, agent_id, content, metadata, deleted, created_at, updated_at
                 FROM memories
                 WHERE COALESCE(agent_id, 'default') = ? AND (? OR deleted = 0)
                 ORDER BY rowid DESC LIMIT 10000",
            )?;
            let rows = statement.query_map(params![agent, include_deleted as i64], memory_row)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    pub fn get(&self, agent: &str, id: &str) -> Result<Option<Memory>, CoreError> {
        let agent = required_agent(agent)?;
        let id = required_id(id)?;
        self.call(move |connection| {
            connection
                .query_row(
                    "SELECT id, agent_id, content, metadata, deleted, created_at, updated_at
                     FROM memories
                     WHERE id = ? AND COALESCE(agent_id, 'default') = ? AND deleted = 0",
                    params![id, agent],
                    memory_row,
                )
                .optional()
                .map_err(CoreError::from)
        })
    }

    pub fn recall(&self, agent: &str, query: &str) -> Result<Vec<Memory>, CoreError> {
        let agent = required_agent(agent)?;
        let query = query.trim().to_owned();
        if query.is_empty() {
            return Err(CoreError::InvalidInput("query must not be empty".into()));
        }
        self.call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT id, agent_id, content, metadata, deleted, created_at, updated_at
                 FROM memories
                 WHERE COALESCE(agent_id, 'default') = ? AND deleted = 0 AND content LIKE ?
                 ORDER BY rowid DESC LIMIT 1000",
            )?;
            let rows = statement.query_map(params![agent, format!("%{query}%")], memory_row)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    pub fn update(&self, agent: &str, id: &str, memory: UpdateMemory) -> Result<(), CoreError> {
        let agent = required_agent(agent)?;
        let id = required_id(id)?;
        if memory.content.trim().is_empty() {
            return Err(CoreError::InvalidInput("content must not be empty".into()));
        }
        self.call(move |connection| {
            let metadata = serde_json::to_string(&memory.metadata)?;
            let transaction = connection.transaction()?;
            let changed = transaction.execute(
                "UPDATE memories SET content = ?, metadata = ?, updated_at = datetime('now')
                 WHERE id = ? AND COALESCE(agent_id, 'default') = ? AND deleted = 0",
                params![memory.content, metadata, id, agent],
            )?;
            if changed == 0 {
                return Err(CoreError::NotFound);
            }
            record_history(&transaction, &id, &agent, "update", Some(&memory.content))?;
            transaction.commit()?;
            Ok(())
        })
    }

    pub fn delete(&self, agent: &str, id: &str) -> Result<(), CoreError> {
        let agent = required_agent(agent)?;
        let id = required_id(id)?;
        self.call(move |connection| {
            let transaction = connection.transaction()?;
            let changed = transaction.execute(
                "UPDATE memories SET deleted = 1, updated_at = datetime('now')
                 WHERE id = ? AND COALESCE(agent_id, 'default') = ? AND deleted = 0",
                params![id, agent],
            )?;
            if changed == 0 {
                return Err(CoreError::NotFound);
            }
            record_history(&transaction, &id, &agent, "delete", None)?;
            transaction.commit()?;
            Ok(())
        })
    }

    pub fn recover(&self, agent: &str, id: &str) -> Result<(), CoreError> {
        let agent = required_agent(agent)?;
        let id = required_id(id)?;
        self.call(move |connection| {
            let transaction = connection.transaction()?;
            let changed = transaction.execute(
                "UPDATE memories SET deleted = 0, updated_at = datetime('now')
                 WHERE id = ? AND COALESCE(agent_id, 'default') = ? AND deleted = 1",
                params![id, agent],
            )?;
            if changed == 0 {
                return Err(CoreError::NotFound);
            }
            record_history(&transaction, &id, &agent, "recover", None)?;
            transaction.commit()?;
            Ok(())
        })
    }

    pub fn history(&self, agent: &str, id: &str) -> Result<Vec<Value>, CoreError> {
        let agent = required_agent(agent)?;
        let id = required_id(id)?;
        self.call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT id, memory_id, operation, content, created_at
                 FROM memory_history
                 WHERE memory_id = ? AND agent_id = ?
                 ORDER BY id ASC LIMIT 1000",
            )?;
            let rows = statement.query_map(params![id, agent], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, i64>(0)?,
                    "memoryId": row.get::<_, String>(1)?,
                    "operation": row.get::<_, String>(2)?,
                    "content": row.get::<_, Option<String>>(3)?,
                    "createdAt": row.get::<_, String>(4)?,
                }))
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    pub fn admit(&self, agent: &str, payload: &str) -> Result<(), CoreError> {
        let agent = required_agent(agent)?;
        if payload.trim().is_empty() {
            return Err(CoreError::InvalidInput("payload must not be empty".into()));
        }
        let payload = payload.to_owned();
        let capacity = self.capacity;
        self.call(move |connection| {
            let count: i64 =
                connection.query_row("SELECT count(*) FROM queue", [], |row| row.get(0))?;
            if count >= capacity as i64 {
                return Err(CoreError::QueueFull { capacity });
            }
            connection.execute(
                "INSERT INTO queue (agent_id, payload, created_at) VALUES (?, ?, datetime('now'))",
                params![agent, payload],
            )?;
            Ok(())
        })
    }

    pub fn release_admitted(&self, count: usize) -> Result<usize, CoreError> {
        self.call(move |connection| {
            let changed = connection.execute(
                "DELETE FROM queue WHERE id IN (SELECT id FROM queue ORDER BY id LIMIT ?)",
                [count as i64],
            )?;
            Ok(changed)
        })
    }

    pub async fn submit_async(&self, operation: Operation) -> Result<Value, CoreError> {
        let core = self.clone();
        tokio::task::spawn_blocking(move || core.submit(operation))
            .await
            .map_err(|_| CoreError::OwnerStopped)?
    }

    pub fn submit(&self, operation: Operation) -> Result<Value, CoreError> {
        match operation {
            Operation::Health => Ok(serde_json::json!({ "ready": self.ready()? })),
            Operation::Remember {
                agent_id,
                content,
                metadata,
            } => Ok(serde_json::json!({
                "id": self.remember(&agent_id, NewMemory { content, metadata })?
            })),
            Operation::List {
                agent_id,
                include_deleted,
            } => Ok(serde_json::to_value(
                self.list(&agent_id, include_deleted)?,
            )?),
            Operation::Get { agent_id, id } => Ok(serde_json::to_value(self.get(&agent_id, &id)?)?),
            Operation::Update {
                agent_id,
                id,
                content,
                metadata,
            } => {
                self.update(&agent_id, &id, UpdateMemory { content, metadata })?;
                Ok(serde_json::json!({ "updated": true }))
            }
            Operation::SoftDelete { agent_id, id } => {
                self.delete(&agent_id, &id)?;
                Ok(serde_json::json!({ "deleted": true }))
            }
            Operation::Recover { agent_id, id } => {
                self.recover(&agent_id, &id)?;
                Ok(serde_json::json!({ "recovered": true }))
            }
            Operation::History { agent_id, id } => {
                Ok(serde_json::to_value(self.history(&agent_id, &id)?)?)
            }
            Operation::Recall { agent_id, query } => {
                Ok(serde_json::to_value(self.recall(&agent_id, &query)?)?)
            }
        }
    }
}

pub struct WorkspaceOwner(Core);

impl Clone for WorkspaceOwner {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl WorkspaceOwner {
    pub fn open(path: &Path, queue_capacity: usize) -> Result<Self, CoreError> {
        Core::open(path, queue_capacity).map(Self)
    }

    pub fn submit(&self, operation: Operation) -> Result<Value, CoreError> {
        self.0.submit(operation)
    }

    pub async fn submit_async(&self, operation: Operation) -> Result<Value, CoreError> {
        self.0.submit_async(operation).await
    }
}

pub type Value = serde_json::Value;
pub type OperationResult = Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Operation {
    Health,
    Remember {
        agent_id: String,
        content: String,
        metadata: Value,
    },
    List {
        agent_id: String,
        include_deleted: bool,
    },
    Get {
        agent_id: String,
        id: String,
    },
    Update {
        agent_id: String,
        id: String,
        content: String,
        metadata: Value,
    },
    SoftDelete {
        agent_id: String,
        id: String,
    },
    Recover {
        agent_id: String,
        id: String,
    },
    History {
        agent_id: String,
        id: String,
    },
    Recall {
        agent_id: String,
        query: String,
    },
}

fn owner_loop(
    path: PathBuf,
    rx: mpsc::Receiver<Request>,
    ready: mpsc::Sender<Result<(), CoreError>>,
) {
    let result = Connection::open(path).and_then(|mut connection| {
        connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")?;
        migrate(&mut connection).map_err(|error| match error {
            CoreError::Sql(sql) => sql,
            other => rusqlite::Error::ToSqlConversionFailure(Box::new(other)),
        })?;
        Ok(connection)
    });
    let mut connection = match result {
        Ok(connection) => {
            let _ = ready.send(Ok(()));
            connection
        }
        Err(error) => {
            let _ = ready.send(Err(CoreError::Sql(error)));
            return;
        }
    };
    for request in rx {
        let _ = request.reply.send((request.job)(&mut connection));
    }
}

fn required_agent(agent: &str) -> Result<String, CoreError> {
    let agent = agent.trim();
    if agent.is_empty() {
        return Err(CoreError::InvalidInput("agent identity is required".into()));
    }
    Ok(agent.to_owned())
}

fn required_id(id: &str) -> Result<String, CoreError> {
    let id = id.trim();
    if id.is_empty() {
        return Err(CoreError::InvalidInput("record id is required".into()));
    }
    Ok(id.to_owned())
}

fn memory_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Memory> {
    let metadata = row.get::<_, String>(3).unwrap_or_else(|_| "{}".into());
    Ok(Memory {
        id: row.get(0)?,
        agent_id: row
            .get::<_, Option<String>>(1)?
            .unwrap_or_else(|| "default".into()),
        content: row.get(2)?,
        metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({})),
        deleted: row.get::<_, i64>(4)? != 0,
        created_at: row.get(5).ok(),
        updated_at: row.get(6).ok(),
    })
}

fn migrate(connection: &mut Connection) -> Result<(), CoreError> {
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT, checksum TEXT);
         CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, metadata TEXT NOT NULL DEFAULT '{}');
         CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}');
         CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL DEFAULT 'default', content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT);
         CREATE TABLE IF NOT EXISTS memory_history (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, agent_id TEXT NOT NULL, operation TEXT NOT NULL, content TEXT, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
         SELECT 1;",
    )?;
    ensure_column(&transaction, "schema_migrations", "applied_at", "TEXT")?;
    ensure_column(&transaction, "schema_migrations", "checksum", "TEXT")?;
    ensure_column(
        &transaction,
        "memories",
        "agent_id",
        "TEXT DEFAULT 'default'",
    )?;
    ensure_column(
        &transaction,
        "memories",
        "metadata",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    ensure_column(
        &transaction,
        "memories",
        "deleted",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(&transaction, "memories", "created_at", "TEXT")?;
    ensure_column(&transaction, "memories", "updated_at", "TEXT")?;
    ensure_column(&transaction, "queue", "agent_id", "TEXT DEFAULT 'default'")?;
    ensure_column(&transaction, "queue", "created_at", "TEXT")?;
    if has_column(&transaction, "memories", "is_deleted")? {
        transaction.execute(
            "UPDATE memories SET deleted = COALESCE(is_deleted, 0) WHERE deleted = 0",
            [],
        )?;
    }
    transaction.execute(
        "UPDATE memories SET agent_id = 'default' WHERE agent_id IS NULL OR trim(agent_id) = ''",
        [],
    )?;
    transaction.execute(
        "UPDATE memories SET metadata = '{}' WHERE metadata IS NULL OR trim(metadata) = ''",
        [],
    )?;
    transaction.execute(
        "UPDATE queue SET agent_id = 'default' WHERE agent_id IS NULL OR trim(agent_id) = ''",
        [],
    )?;
    transaction.execute(
        "UPDATE queue SET created_at = datetime('now') WHERE created_at IS NULL OR trim(created_at) = ''",
        [],
    )?;
    transaction.execute_batch(
        "CREATE INDEX IF NOT EXISTS memories_agent_idx ON memories(agent_id, deleted);
         CREATE INDEX IF NOT EXISTS memory_history_scope_idx ON memory_history(memory_id, agent_id, id);
         CREATE INDEX IF NOT EXISTS queue_created_idx ON queue(created_at);",
    )?;
    transaction.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at, checksum) VALUES (1, datetime('now'), 'fresh-rust-core-v1')",
        [],
    )?;
    transaction.commit()?;
    Ok(())
}

fn record_history(
    transaction: &Transaction<'_>,
    memory_id: &str,
    agent_id: &str,
    operation: &str,
    content: Option<&str>,
) -> Result<(), CoreError> {
    transaction.execute(
        "INSERT INTO memory_history (memory_id, agent_id, operation, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
        params![memory_id, agent_id, operation, content],
    )?;
    Ok(())
}

fn has_column(transaction: &Transaction<'_>, table: &str, column: &str) -> Result<bool, CoreError> {
    let sql = format!("PRAGMA table_info({table})");
    let mut statement = transaction.prepare(&sql)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == column))
}

fn ensure_column(
    transaction: &Transaction<'_>,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), CoreError> {
    if has_column(transaction, table, column)? {
        return Ok(());
    }
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
    transaction.execute(&sql, [])?;
    Ok(())
}

pub fn import_current_schema(_path: &Path) -> Result<(), CoreError> {
    Err(CoreError::InvalidInput(
        "schema import is performed by WorkspaceOwner::open; callers cannot bypass the owner"
            .into(),
    ))
}
