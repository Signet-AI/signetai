use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    any::Any,
    fs,
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
};
use thiserror::Error;
use time::{format_description::well_known::Rfc3339, Date, Month, OffsetDateTime};
use unicode_normalization::UnicodeNormalization;

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
    #[error("unsupported migration history: {0}")]
    UnsupportedMigrationHistory(String),
    #[error("remote owner error: {0}")]
    Remote(String),
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
    #[serde(rename = "sourceId")]
    pub source_id: Option<String>,
    #[serde(rename = "sourceType")]
    pub source_type: Option<String>,
    #[serde(rename = "sourcePath")]
    pub source_path: Option<String>,
    #[serde(rename = "runtimePath")]
    pub runtime_path: Option<String>,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    #[serde(rename = "memoryKind")]
    pub memory_kind: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NewMemory {
    pub content: String,
    pub metadata: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Source {
    pub id: String,
    pub agent_id: String,
    pub workspace_id: String,
    pub kind: String,
    pub name: String,
    pub config: Value,
    pub created_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DocumentInput {
    pub source_id: String,
    pub path: String,
    pub content: String,
    pub metadata: Value,
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
            let tx = connection.transaction()?;
            tx.execute("INSERT INTO job_events (job_id,agent_id,event,data,created_at) SELECT j.id,j.agent_id,'recovered','{\"from\":\"running\",\"to\":\"queued\"}',datetime('now') FROM jobs j WHERE j.state='running' AND NOT EXISTS (SELECT 1 FROM job_events e WHERE e.job_id=j.id AND e.event='recovered')", [])?;
            tx.execute("UPDATE jobs SET state='queued', updated_at=datetime('now') WHERE state='running'", [])?;
            tx.commit()?;
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
                "SELECT id, agent_id, content, metadata, deleted, created_at, updated_at, source_id, source_type, source_path, runtime_path, idempotency_key, memory_kind
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
                    "SELECT id, agent_id, content, metadata, deleted, created_at, updated_at, source_id, source_type, source_path, runtime_path, idempotency_key, memory_kind
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
                "SELECT id, agent_id, content, metadata, deleted, created_at, updated_at, source_id, source_type, source_path, runtime_path, idempotency_key, memory_kind
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

    pub async fn worker_claim_async(&self) -> Result<Option<WorkerJob>, CoreError> {
        let core = self.clone();
        tokio::task::spawn_blocking(move || core.worker_claim())
            .await
            .map_err(|_| CoreError::OwnerStopped)?
    }

    pub fn create_source(
        &self,
        agent: &str,
        workspace: &str,
        kind: &str,
        name: &str,
        config: Value,
    ) -> Result<Source, CoreError> {
        let agent = required_agent(agent)?;
        let workspace = required_id(workspace)?;
        let kind = required_id(kind)?;
        let name = required_id(name)?;
        self.call(move |connection| { let id = uuid::Uuid::new_v4().to_string(); let config = serde_json::to_string(&config)?;
            connection.execute("INSERT INTO sources (id, agent_id, workspace_id, kind, name, config, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))", params![id, agent, workspace, kind, name, config])?;
            Ok(Source { id, agent_id: agent, workspace_id: workspace, kind, name, config: serde_json::from_str(&config)?, created_at: Some(String::new()) }) })
    }

    pub fn list_sources(&self, agent: &str, workspace: &str) -> Result<Vec<Source>, CoreError> {
        let agent = required_agent(agent)?;
        let workspace = required_id(workspace)?;
        self.call(move |c| { let mut s=c.prepare("SELECT id,agent_id,workspace_id,kind,name,config,created_at FROM sources WHERE agent_id=? AND workspace_id=? ORDER BY rowid DESC")?; let rows=s.query_map(params![agent,workspace], |r| Ok(Source{id:r.get(0)?,agent_id:r.get(1)?,workspace_id:r.get(2)?,kind:r.get(3)?,name:r.get(4)?,config:serde_json::from_str(&r.get::<_,String>(5)?).unwrap_or(json!({})),created_at:r.get(6).ok()}))?; Ok(rows.collect::<Result<Vec<_>,_>>()?) })
    }

    pub fn ingest_document(&self, agent: &str, input: DocumentInput) -> Result<String, CoreError> {
        let agent = required_agent(agent)?;
        if input.content.trim().is_empty() {
            return Err(CoreError::InvalidInput("content must not be empty".into()));
        }
        self.call(move |c| {
            let mut metadata = match input.metadata {
                Value::Null => json!({}),
                Value::Object(_) => input.metadata,
                _ => return Err(CoreError::InvalidInput("metadata must be an object".into())),
            };
            let workspace = metadata
                .get("_workspaceId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("default")
                .to_owned();
            metadata["_workspaceId"] = Value::String(workspace.clone());
            let (source_workspace, generation): (String, i64) = c
                .query_row(
                    "SELECT COALESCE(NULLIF(trim(workspace_id), ''), 'default'), generation FROM sources WHERE id=? AND agent_id=? AND workspace_id=?",
                    params![input.source_id, agent, workspace],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .ok_or(CoreError::NotFound)?;
            let id = uuid::Uuid::new_v4().to_string();
            let mut hash = Sha256::new();
            hash.update(input.content.as_bytes());
            let content_hash = format!("{:x}", hash.finalize());
            let metadata = serde_json::to_string(&metadata)?;
            c.execute("INSERT INTO documents (id,agent_id,workspace_id,source_id,path,content,metadata,content_hash,generation,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))", params![id, agent, source_workspace, input.source_id, input.path, input.content, metadata, content_hash, generation])?;
            Ok(id)
        })
    }

    pub fn submit(&self, operation: Operation) -> Result<Value, CoreError> {
        self.call(move |connection| execute_operation(connection, operation))
    }

    pub fn database_schema(&self) -> Result<Value, CoreError> {
        self.call(|connection| database_schema(connection))
    }

    pub fn database_sample(
        &self,
        table: String,
        limit: usize,
        offset: usize,
        agent: Option<String>,
        workspace: Option<String>,
    ) -> Result<Value, CoreError> {
        self.call(move |connection| {
            database_sample(
                connection,
                &table,
                limit,
                offset,
                agent.as_deref(),
                workspace.as_deref(),
            )
        })
    }

    /// Claim exactly one executable job on the workspace-owner thread.
    pub fn worker_claim(&self) -> Result<Option<WorkerJob>, CoreError> {
        self.call(|connection| {
            let tx = connection.transaction()?;
            tx.execute("UPDATE jobs SET state='expired',error='deadline exceeded',updated_at=datetime('now') WHERE state='queued' AND deadline_at IS NOT NULL AND julianday(deadline_at) <= julianday('now')", [])?;
            {
                let mut expired = tx.prepare("SELECT id,agent_id FROM jobs WHERE state='expired' AND error='deadline exceeded' AND NOT EXISTS (SELECT 1 FROM job_events e WHERE e.job_id=jobs.id AND e.event='expired')")?;
                let rows = expired.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
                for row in rows {
                    let (id, agent_id) = row?;
                    tx.execute("INSERT INTO job_events(job_id,agent_id,event,data,created_at) VALUES(?,?, 'expired',?,datetime('now'))", params![id, agent_id, serde_json::to_string(&json!({"reason":"deadline exceeded"}))?])?;
                }
            }
            let row: Option<(String, String, Option<String>, String, String)> = tx.query_row(
                "SELECT j.id,j.agent_id,j.workspace_id,j.kind,j.payload FROM jobs j LEFT JOIN pipeline_state p ON p.agent_id=j.agent_id WHERE j.state='queued' AND (j.deadline_at IS NULL OR julianday(j.deadline_at) > julianday('now')) AND COALESCE(p.paused,0)=0 AND j.kind IN ('dream.trigger','dream.pass','dreaming') ORDER BY j.created_at,j.id LIMIT 1",
                [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
            let Some((id,agent_id,workspace_id,kind,payload)) = row else { tx.commit()?; return Ok(None); };
            let changed = tx.execute("UPDATE jobs SET state='running',updated_at=datetime('now') WHERE id=? AND agent_id=? AND workspace_id IS ? AND state='queued'", params![id,agent_id,workspace_id])?;
            if changed == 0 { tx.commit()?; return Ok(None); }
            tx.execute("INSERT INTO job_events(job_id,agent_id,event,data,created_at) VALUES(?,?, 'running',?,datetime('now'))", params![id,agent_id,serde_json::to_string(&json!({"from":"queued","to":"running"}))?])?;
            tx.commit()?;
            Ok(Some(WorkerJob { id, agent_id, workspace_id, kind, payload }))
        })
    }

    pub fn worker_finish(
        &self,
        job: WorkerJob,
        state: &str,
        error: Option<&str>,
    ) -> Result<(), CoreError> {
        let state = state.to_owned();
        let error = error.map(str::to_owned);
        self.call(move |connection| {
            if !matches!(state.as_str(), "completed" | "failed") { return Err(CoreError::InvalidInput("invalid worker terminal state".into())); }
            let tx = connection.transaction()?;
            let expired = tx.execute("UPDATE jobs SET state='expired',error='deadline exceeded',updated_at=datetime('now') WHERE id=? AND agent_id=? AND workspace_id IS ? AND state='running' AND deadline_at IS NOT NULL AND julianday(deadline_at) <= julianday('now')", params![job.id,job.agent_id,job.workspace_id])?;
            if expired > 0 {
                tx.execute("INSERT INTO job_events(job_id,agent_id,event,data,created_at) SELECT ?,?, 'expired',?,datetime('now') WHERE NOT EXISTS (SELECT 1 FROM job_events WHERE job_id=? AND agent_id=? AND event='expired')", params![job.id,job.agent_id,serde_json::to_string(&json!({"reason":"deadline exceeded"}))?,job.id,job.agent_id])?;
                tx.commit()?;
                return Ok(());
            }
            let changed = tx.execute("UPDATE jobs SET state=?,error=?,updated_at=datetime('now') WHERE id=? AND agent_id=? AND workspace_id IS ? AND state='running'", params![state, error, job.id, job.agent_id, job.workspace_id])?;
            if changed == 0 { return Ok(()); }
            tx.execute("INSERT INTO job_events(job_id,agent_id,event,data,created_at) VALUES(?,?,?, ?,datetime('now'))", params![job.id,job.agent_id,state,serde_json::to_string(&json!({"error":error}))?])?;
            tx.commit()?;
            Ok(())
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkerJob {
    pub id: String,
    pub agent_id: String,
    pub workspace_id: Option<String>,
    pub kind: String,
    pub payload: String,
}

fn retrieval_tokens(query: &str) -> Vec<String> {
    query
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .map(|s| s.to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

fn execute_memory_search(
    connection: &mut Connection,
    agent_id: String,
    query: String,
    limit: usize,
) -> Result<Value, CoreError> {
    let agent_id = required_agent(&agent_id)?;
    let tokens = retrieval_tokens(query.trim());
    if tokens.is_empty() {
        return Err(CoreError::InvalidInput(
            "query must contain at least one token".into(),
        ));
    }
    let limit = limit.clamp(1, 100) as i64;
    let has_fts: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories_fts')",
        [],
        |r| r.get(0),
    )?;
    let mut rows = Vec::new();
    if has_fts {
        let match_query = tokens
            .iter()
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");
        let mut stmt = connection.prepare("SELECT m.id,m.agent_id,m.content,m.metadata,m.deleted,m.created_at,m.updated_at,m.source_id,m.source_type,m.source_path,m.runtime_path,m.idempotency_key,m.memory_kind,bm25(memories_fts) FROM memories_fts JOIN memories m ON memories_fts.rowid=m.rowid WHERE memories_fts MATCH ? AND m.agent_id=? AND m.deleted=0 AND m.superseded_by IS NULL ORDER BY bm25(memories_fts), m.rowid DESC LIMIT ?")?;
        let mapped = stmt.query_map(params![match_query, agent_id, limit], memory_search_row)?;
        rows = mapped.collect::<Result<Vec<_>, _>>()?;
    } else {
        // Compatibility fallback is deliberately token-aware and marked partial;
        // it is not presented as an FTS result.
        let mut stmt = connection.prepare("SELECT id,agent_id,content,metadata,deleted,created_at,updated_at,source_id,source_type,source_path,runtime_path,idempotency_key,memory_kind FROM memories WHERE agent_id=? AND deleted=0 AND superseded_by IS NULL ORDER BY rowid DESC LIMIT 1000")?;
        let candidates = stmt.query_map(params![agent_id], memory_row)?;
        for memory in candidates {
            let memory = memory?;
            let words = retrieval_tokens(&memory.content);
            if tokens.iter().all(|t| words.iter().any(|w| w == t)) {
                rows.push(json!({"id":memory.id,"agentId":memory.agent_id,"content":memory.content,"metadata":memory.metadata,"deleted":memory.deleted,"createdAt":memory.created_at,"updatedAt":memory.updated_at,"score":0.0}));
            }
            if rows.len() >= limit as usize {
                break;
            }
        }
    }
    // Integrated graph recall is backed by durable, scoped knowledge attributes.
    let mut graph_ids = Vec::new();
    for token in &tokens {
        let pattern = format!("%{}%", token);
        let mut stmt = connection.prepare("SELECT DISTINCT a.memory_id FROM kg_attributes a JOIN memories m ON m.id=a.memory_id WHERE a.agent_id=? AND a.status='active' AND a.memory_id IS NOT NULL AND m.agent_id=? AND m.deleted=0 AND m.superseded_by IS NULL AND (a.normalized_content LIKE ? OR a.content LIKE ?) ORDER BY a.updated_at DESC LIMIT ?")?;
        let ids = stmt.query_map(
            params![agent_id, agent_id, pattern, pattern, limit],
            |row| row.get::<_, String>(0),
        )?;
        graph_ids.extend(ids.collect::<Result<Vec<_>, _>>()?);
    }
    graph_ids.sort();
    graph_ids.dedup();
    for id in &graph_ids {
        if rows
            .iter()
            .any(|row| row.get("id").and_then(Value::as_str) == Some(id))
        {
            continue;
        }
        if rows.len() >= limit as usize {
            break;
        }
        let mut stmt = connection.prepare("SELECT id,agent_id,content,metadata,deleted,created_at,updated_at,source_id,source_type,source_path,runtime_path,idempotency_key,memory_kind FROM memories WHERE id=? AND agent_id=? AND deleted=0 AND superseded_by IS NULL")?;
        if let Ok(memory) = stmt.query_row(params![id, agent_id], memory_row) {
            rows.push(json!({"id":memory.id,"agentId":memory.agent_id,"content":memory.content,"metadata":memory.metadata,"deleted":memory.deleted,"createdAt":memory.created_at,"updatedAt":memory.updated_at,"score":0.5,"source":"graph"}));
        }
    }
    let graph_count = graph_ids.len();
    Ok(
        json!({"results":rows,"query":query,"method":"keyword","meta":{"totalReturned":rows.len(),"noHits":rows.is_empty(),"lexical":{"available":has_fts,"completeness":if has_fts {"complete"} else {"partial"}},"channels":{"vector":{"supported":false,"reason":"embedding_runtime_unavailable"},"graph":{"supported":true,"resultCount":graph_count,"bounded":true},"aggregate":{"supported":false,"reason":"aggregate_provider_unavailable"}}}}),
    )
}

fn normalize_import_files(files: &Value) -> Result<Vec<Value>, CoreError> {
    let files = files
        .as_array()
        .ok_or_else(|| CoreError::InvalidInput("files must be an array".into()))?;
    if files.is_empty() || files.len() > 25 {
        return Err(CoreError::InvalidInput(
            "files must contain 1-25 entries".into(),
        ));
    }
    let mut total_content_bytes = 0usize;
    files
        .iter()
        .map(|file| {
            let object = file.as_object().ok_or_else(|| {
                CoreError::InvalidInput("file descriptors must be objects".into())
            })?;
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty() && name.len() <= 512)
                .ok_or_else(|| CoreError::InvalidInput("file name is required".into()))?;
            let mut normalized = object.clone();
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            normalized.insert("id".into(), Value::String(id));
            normalized.insert("name".into(), Value::String(name.to_owned()));
            let content_bytes = object
                .get("content")
                .and_then(Value::as_str)
                .map(str::len)
                .unwrap_or(0);
            if content_bytes > 8 * 1024 * 1024 {
                return Err(CoreError::InvalidInput("file content exceeds 8 MiB".into()));
            }
            total_content_bytes = total_content_bytes.saturating_add(content_bytes);
            if total_content_bytes > 32 * 1024 * 1024 {
                return Err(CoreError::InvalidInput(
                    "import content exceeds 32 MiB".into(),
                ));
            }
            Ok(Value::Object(normalized))
        })
        .collect()
}

fn valid_daily_log_date(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".md") else {
        return false;
    };
    if stem.len() != 10
        || !stem.is_ascii()
        || stem.as_bytes()[4] != b'-'
        || stem.as_bytes()[7] != b'-'
    {
        return false;
    }
    if !stem.as_bytes()[0..4]
        .iter()
        .chain(&stem.as_bytes()[5..7])
        .chain(&stem.as_bytes()[8..10])
        .all(u8::is_ascii_digit)
    {
        return false;
    }
    let year = stem[0..4].parse::<i32>().ok();
    let month = stem[5..7]
        .parse::<u8>()
        .ok()
        .and_then(|m| Month::try_from(m).ok());
    let day = stem[8..10].parse::<u8>().ok();
    match (year, month, day) {
        (Some(y), Some(m), Some(d)) => Date::from_calendar_date(y, m, d).is_ok(),
        _ => false,
    }
}

fn import_chunks(content: &str) -> impl Iterator<Item = &str> {
    content
        .split("\n\n")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .flat_map(|paragraph| {
            let boundaries: Vec<usize> = paragraph
                .char_indices()
                .map(|(i, _)| i)
                .chain(std::iter::once(paragraph.len()))
                .collect();
            (0..boundaries.len() - 1).step_by(2048).map(move |index| {
                &paragraph[boundaries[index]..boundaries[(index + 2048).min(boundaries.len() - 1)]]
            })
        })
}

fn pin_entity(
    connection: &mut Connection,
    agent: &str,
    workspace: &str,
    entity_id: &str,
    actor: &str,
    pinned: bool,
) -> Result<Value, CoreError> {
    let agent = required_agent(agent)?;
    let workspace = canonical_workspace(workspace)?;
    let entity_id = required_id(entity_id)?;
    let actor = if actor.trim().is_empty() {
        "operator"
    } else {
        actor.trim()
    };
    let tx = connection.transaction()?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS ontology_proposals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL DEFAULT 'default', operation TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.0, rationale TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '[]', risk TEXT, source_kind TEXT, source_id TEXT, source_path TEXT, source_root TEXT, created_by TEXT NOT NULL DEFAULT 'ontology-proposal', applied_by TEXT, rejected_by TEXT, result TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), applied_at TEXT, rejected_at TEXT)")?;
    let exists: i64 = tx.query_row("SELECT count(*) FROM entities WHERE id=? AND agent_id=? AND workspace_id=? AND COALESCE(status,'active')='active'", params![entity_id, agent, workspace], |r| r.get(0))?;
    if exists != 1 {
        return Err(CoreError::NotFound);
    }
    let proposal_id = uuid::Uuid::new_v4().to_string();
    let payload = json!({"id": entity_id});
    let evidence = json!([]);
    let now = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|e| CoreError::InvalidInput(e.to_string()))?;
    tx.execute("INSERT INTO ontology_proposals (id,agent_id,operation,status,payload,rationale,evidence,created_by,applied_by,result,created_at,updated_at,applied_at) VALUES (?,?,?,'applied',?,?,? ,?,?,?, ?,?,?)", params![proposal_id, agent, if pinned {"pin_entity"} else {"unpin_entity"}, payload.to_string(), "", evidence.to_string(), actor, actor, json!({"entityId":entity_id,"pinned":pinned}).to_string(), now, now, now])?;
    let pinned_at: Option<String> = if pinned { Some(now.clone()) } else { None };
    tx.execute("UPDATE entities SET pinned=?, pinned_at=?, proposal_id=?, proposal_evidence=?, updated_at=? WHERE id=? AND agent_id=? AND workspace_id=?", params![pinned as i64, pinned_at, proposal_id, evidence.to_string(), now, entity_id, agent, workspace])?;
    tx.commit()?;
    let mut result = json!({"entityId":entity_id,"pinned":pinned});
    if pinned {
        result["pinnedAt"] = json!(now);
    }
    Ok(result)
}

fn execute_operation(
    connection: &mut Connection,
    operation: Operation,
) -> Result<Value, CoreError> {
    match operation {
        Operation::LegacyMarkdownImport {
            agent_id,
            workspace_id,
            files,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let files = normalize_import_files(&files)?;
            let transaction = connection.transaction()?;
            let mut imported = 0usize;
            let mut skipped = 0usize;
            let mut errors = Vec::new();
            for file in files {
                let Some(object) = file.as_object() else {
                    return Err(CoreError::InvalidInput(
                        "file descriptors must be objects".into(),
                    ));
                };
                let name = object.get("name").and_then(Value::as_str).unwrap_or("");
                if name.starts_with("TEMPLATE") {
                    skipped += 1;
                    continue;
                }
                let valid_date = valid_daily_log_date(name);
                if !valid_date {
                    skipped += 1;
                    errors.push(format!(
                        "Invalid filename format (expected YYYY-MM-DD.md): {name}"
                    ));
                    continue;
                }
                let content = object.get("content").and_then(Value::as_str).unwrap_or("");
                if content.trim().is_empty() {
                    skipped += 1;
                    continue;
                }
                let content_hash = format!("{:x}", Sha256::digest(content.as_bytes()));
                for (chunk_index, chunk) in import_chunks(content).enumerate() {
                    let metadata = json!({"type":"daily-log","category":&name[..10],"sourceType":"import","sourceId":name,"tags":["imported","daily-log"],"updatedBy":"signet-import","_workspaceId":workspace_id,"_importChunk":chunk_index,"_contentHash":content_hash});
                    let metadata_text = serde_json::to_string(&metadata)?;
                    let exists: i64 = transaction.query_row("SELECT count(*) FROM memories WHERE agent_id=? AND deleted=0 AND metadata=?", params![agent_id, metadata_text], |r| r.get(0))?;
                    if exists > 0 {
                        skipped += 1;
                        continue;
                    }
                    let id = uuid::Uuid::new_v4().to_string();
                    transaction.execute("INSERT INTO memories(id,agent_id,content,metadata,deleted,created_at,updated_at) VALUES(?,?,?,?,0,datetime('now'),datetime('now'))", params![id,agent_id,chunk,metadata_text])?;
                    imported += 1;
                }
            }
            transaction.commit()?;
            Ok(json!({"imported":imported,"skipped":skipped,"errors":errors}))
        }
        Operation::Cancellation {
            agent_id,
            action,
            operation_id,
            content,
            fault,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let operation_id = bounded_text(&operation_id, "operation id", 256)?;
            match action.as_str() {
                "begin" => {
                    let existing: Option<(String, Option<String>)> = connection.query_row(
                        "SELECT outcome,content FROM cancellation_operations WHERE agent_id=? AND operation_id=?",
                        params![agent_id, operation_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
                    if let Some((outcome, stored)) = existing {
                        return Ok(
                            json!({"operationId":operation_id,"outcome":outcome,"content":stored}),
                        );
                    }
                    let outcome = if fault.as_deref() == Some("commit_before_reply") {
                        "unknown"
                    } else {
                        "committed"
                    };
                    let tx = connection.transaction()?;
                    tx.execute("INSERT INTO cancellation_operations(agent_id,operation_id,outcome,content,created_at) VALUES(?,?,?,?,datetime('now'))", params![agent_id, operation_id, outcome, content])?;
                    tx.commit()?;
                    Ok(json!({"operationId":operation_id,"outcome":outcome,"content":content}))
                }
                "cancel" => {
                    let tx = connection.transaction()?;
                    let changed = tx.execute("UPDATE cancellation_operations SET outcome='cancelled' WHERE agent_id=? AND operation_id=? AND outcome='queued'", params![agent_id, operation_id])?;
                    if changed == 0 {
                        tx.execute("INSERT OR IGNORE INTO cancellation_operations(agent_id,operation_id,outcome,content,created_at) VALUES(?,?, 'cancelled',NULL,datetime('now'))", params![agent_id, operation_id])?;
                    }
                    tx.commit()?;
                    Ok(json!({"operationId":operation_id,"outcome":"cancelled"}))
                }
                "get" => {
                    let row: (String, Option<String>) = connection.query_row("SELECT outcome,content FROM cancellation_operations WHERE agent_id=? AND operation_id=?", params![agent_id, operation_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or(CoreError::NotFound)?;
                    Ok(json!({"operationId":operation_id,"outcome":row.0,"content":row.1}))
                }
                _ => Err(CoreError::InvalidInput(
                    "unknown cancellation action".into(),
                )),
            }
        }
        Operation::ReflectionList { agent_id, limit } => {
            let agent_id = required_agent(&agent_id)?;
            let limit = limit.clamp(1, 100);
            let mut statement = connection.prepare("SELECT id,date,summary,patterns,question,answer,answer_memory_id,created_at,answered_at FROM daily_reflections WHERE agent_id=? ORDER BY created_at DESC LIMIT ?")?;
            let rows = statement.query_map(params![agent_id, limit as i64], reflection_row)?;
            Ok(json!({"reflections": rows.collect::<Result<Vec<_>, _>>()?}))
        }
        Operation::ReflectionToday {
            agent_id,
            date,
            limit,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let limit = limit.clamp(1, 100);
            let mut statement = connection.prepare("SELECT id,date,summary,patterns,question,answer,answer_memory_id,created_at,answered_at FROM daily_reflections WHERE agent_id=? AND date=? ORDER BY created_at DESC LIMIT ?")?;
            let rows =
                statement.query_map(params![agent_id, date, limit as i64], reflection_row)?;
            let reflections = rows.collect::<Result<Vec<_>, _>>()?;
            Ok(
                json!({"reflection": reflections.first().cloned().unwrap_or(Value::Null), "reflections": reflections}),
            )
        }
        Operation::TranscriptImportCreate {
            agent_id,
            workspace_id,
            schema_id,
            duplicate_mode,
            files,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let files = normalize_import_files(&files)?;
            let mut ids = std::collections::HashSet::new();
            for f in &files {
                if !ids.insert(f["id"].as_str().unwrap_or_default()) {
                    return Err(CoreError::InvalidInput("duplicate file id".into()));
                }
            }
            let id = uuid::Uuid::new_v4().to_string();
            let tx = connection.transaction()?;
            tx.execute("INSERT INTO transcript_import_jobs (id,agent_id,workspace_id,schema_id,duplicate_mode,state,files,created_at,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))",params![id,agent_id,workspace_id,schema_id,duplicate_mode,"staging",serde_json::to_string(&files)?])?;
            for (ordinal, file) in files.iter().enumerate() {
                tx.execute("INSERT INTO transcript_import_files (id,job_id,agent_id,workspace_id,ordinal,name,state,storage_state,upload_generation,upload_offset,upload_digest,size_bytes,content,created_at,updated_at) VALUES (?,?,?,?,?,?,'staging','uploading',0,0,'',0,x'',datetime('now'),datetime('now'))",params![file["id"].as_str(),id,agent_id,workspace_id,ordinal as i64,file["name"].as_str()])?;
            }
            tx.commit()?;
            Ok(
                json!({"id":id,"jobId":id,"agentId":agent_id,"workspaceId":workspace_id,"schemaId":schema_id,"duplicateMode":duplicate_mode,"state":"staging","files":files}),
            )
        }
        Operation::TranscriptImportGet {
            agent_id,
            workspace_id,
            id,
        } => {
            let v:Option<String>=connection.query_row("SELECT json_object('id',id,'jobId',id,'agentId',agent_id,'workspaceId',workspace_id,'schemaId',schema_id,'duplicateMode',duplicate_mode,'state',state,'files',json(files),'createdAt',created_at,'updatedAt',updated_at) FROM transcript_import_jobs WHERE id=? AND agent_id=? AND workspace_id=?",params![id,required_agent(&agent_id)?,workspace_id],|r|r.get(0)).optional()?;
            v.map(|x| serde_json::from_str(&x))
                .transpose()?
                .ok_or(CoreError::NotFound)
        }
        Operation::TranscriptImportList {
            agent_id,
            workspace_id,
            limit,
        } => {
            let mut s=connection.prepare("SELECT json_object('id',id,'jobId',id,'agentId',agent_id,'workspaceId',workspace_id,'schemaId',schema_id,'duplicateMode',duplicate_mode,'state',state,'files',json(files),'createdAt',created_at,'updatedAt',updated_at) FROM transcript_import_jobs WHERE agent_id=? AND workspace_id=? AND state='completed' ORDER BY created_at DESC LIMIT ?")?;
            let rows = s.query_map(
                params![
                    required_agent(&agent_id)?,
                    workspace_id,
                    limit.clamp(1, 100) as i64
                ],
                |r| r.get::<_, String>(0),
            )?;
            Ok(
                json!({"imports":rows.map(|r|Ok(serde_json::from_str::<Value>(&r?)?)).collect::<Result<Vec<_>,CoreError>>()?}),
            )
        }
        Operation::TranscriptImportFile {
            agent_id,
            workspace_id,
            job_id,
            file_id,
            generation,
            action,
            offset,
            length,
            checksum,
            content,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let tx = connection.transaction()?;
            let row:Option<(String,i64,Option<i64>,i64,Vec<u8>,String)>=tx.query_row("SELECT storage_state,upload_generation,upload_size,upload_offset,content,upload_digest FROM transcript_import_files WHERE id=? AND job_id=? AND agent_id=? AND workspace_id=?",params![file_id,job_id,agent_id,workspace_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
            let Some((state, gen, size, pos, bytes, _digest)) = row else {
                return Err(CoreError::NotFound);
            };
            if gen != generation {
                return Err(CoreError::InvalidInput("upload generation mismatch".into()));
            }
            if content.len() > 8 * 1024 * 1024 {
                return Err(CoreError::InvalidInput("upload exceeds 8 MiB".into()));
            }
            let sha = |b: &[u8]| format!("{:x}", Sha256::digest(b));
            let valid_checksum = |c: &str, d: &str| c == d || c == format!("sha256:{d}");
            match action.as_str() {
                "begin" => {
                    let n = length.ok_or_else(|| {
                        CoreError::InvalidInput("upload length is required".into())
                    })?;
                    if n < 0 || n > 8 * 1024 * 1024 {
                        return Err(CoreError::InvalidInput(
                            "upload length exceeds 8 MiB".into(),
                        ));
                    };
                    if state == "sealed" {
                        return Ok(
                            json!({"fileId":file_id,"state":"sealed","generation":gen,"offset":pos}),
                        );
                    };
                    tx.execute("UPDATE transcript_import_files SET upload_size=?,upload_offset=0,upload_digest='',content_hash=NULL,size_bytes=0,storage_state='uploading',state='staging',content=x'',updated_at=datetime('now') WHERE id=?",params![n,file_id])?;
                }
                "append" => {
                    if state != "uploading" {
                        return Err(CoreError::InvalidInput("file is not uploading".into()));
                    };
                    let o = offset.ok_or_else(|| {
                        CoreError::InvalidInput("upload offset is required".into())
                    })?;
                    if o != pos {
                        return Err(CoreError::InvalidInput("upload offset mismatch".into()));
                    };
                    let n = size.ok_or_else(|| {
                        CoreError::InvalidInput("upload length is required".into())
                    })?;
                    if pos + content.len() as i64 > n {
                        return Err(CoreError::InvalidInput(
                            "upload exceeds declared length".into(),
                        ));
                    };
                    if let Some(c) = checksum.as_deref() {
                        if !valid_checksum(c, &sha(&content)) {
                            return Err(CoreError::InvalidInput("upload checksum mismatch".into()));
                        }
                    };
                    let all = [bytes.as_slice(), content.as_slice()].concat();
                    let d = sha(&all);
                    tx.execute("UPDATE transcript_import_files SET content=?,upload_offset=?,upload_digest=?,size_bytes=?,updated_at=datetime('now') WHERE id=?",params![all,pos+content.len() as i64,d,pos+content.len() as i64,file_id])?;
                }
                "finalize" => {
                    if state == "sealed" {
                        return Ok(
                            json!({"fileId":file_id,"state":"sealed","generation":gen,"offset":pos}),
                        );
                    };
                    if size != Some(pos) {
                        return Err(CoreError::InvalidInput("upload is incomplete".into()));
                    };
                    if let Some(c) = checksum.as_deref() {
                        if !valid_checksum(c, &sha(&bytes)) {
                            return Err(CoreError::InvalidInput("final checksum mismatch".into()));
                        }
                    };
                    let d = sha(&bytes);
                    tx.execute("UPDATE transcript_import_files SET storage_state='sealed',state='ready',content_hash=?,updated_at=datetime('now') WHERE id=?",params![d,file_id])?;
                }
                "reset" => {
                    let ng = gen + 1;
                    tx.execute("UPDATE transcript_import_files SET storage_state='uploading',state='staging',upload_generation=?,upload_offset=0,upload_size=NULL,upload_digest='',content_hash=NULL,size_bytes=0,content=x'',updated_at=datetime('now') WHERE id=?",params![ng,file_id])?;
                }
                "content" => {
                    if state != "sealed" {
                        return Err(CoreError::NotFound);
                    };
                    tx.commit()?;
                    return Ok(
                        json!({"contentBytes":bytes,"contentType":"application/octet-stream","generation":gen,"offset":pos}),
                    );
                }
                _ => return Err(CoreError::InvalidInput("unsupported file action".into())),
            }
            let v: (i64,i64,String)=tx.query_row("SELECT upload_generation,upload_offset,storage_state FROM transcript_import_files WHERE id=?",params![file_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            tx.commit()?;
            Ok(json!({"fileId":file_id,"state":v.2,"generation":v.0,"offset":v.1}))
        }
        Operation::TranscriptImportControl {
            agent_id,
            workspace_id,
            job_id,
            action,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let tx = connection.transaction()?;
            let files_json: String = tx.query_row(
                "SELECT files FROM transcript_import_jobs WHERE id=? AND agent_id=? AND workspace_id=?",
                params![job_id, agent_id, workspace_id], |r| r.get(0)).optional()?.ok_or(CoreError::NotFound)?;
            let mut files: Vec<Value> = serde_json::from_str(&files_json)?;
            let current: String = tx.query_row(
                "SELECT state FROM transcript_import_jobs WHERE id=?",
                params![job_id],
                |r| r.get(0),
            )?;
            if action == "cancel" {
                if current != "completed" {
                    tx.execute("UPDATE transcript_import_jobs SET state='canceled',updated_at=datetime('now') WHERE id=?", params![job_id])?;
                }
                tx.commit()?;
                return Ok(
                    json!({"jobId":job_id,"state":"canceled","files":files,"imported":0,"rejected":0,"pending":0}),
                );
            }
            if action == "pause" {
                if current == "running" {
                    tx.execute("UPDATE transcript_import_jobs SET state='paused',updated_at=datetime('now') WHERE id=?", params![job_id])?;
                }
                tx.commit()?;
                return Ok(json!({"jobId":job_id,"state":"paused"}));
            }
            if action == "resume" || action == "retry" || action == "start" {
                if current == "completed" && action == "start" {
                    tx.commit()?;
                    return Ok(
                        json!({"jobId":job_id,"state":"completed","imported":files.iter().filter(|f| f.get("state")==Some(&json!("completed"))).count(),"rejected":0,"pending":0}),
                    );
                }
                tx.execute("UPDATE transcript_import_jobs SET state='running',updated_at=datetime('now') WHERE id=?", params![job_id])?;
                let mut imported = 0usize;
                let mut rejected = 0usize;
                let mut pending = 0usize;
                for file in files.iter_mut() {
                    let fid = file
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    let (state, bytes): (String, Vec<u8>) = tx.query_row(
                        "SELECT state,content FROM transcript_import_files WHERE id=? AND job_id=?",
                        params![fid, job_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )?;
                    if state == "completed" {
                        imported += 1;
                        continue;
                    }
                    if state != "ready" {
                        pending += 1;
                        file["state"] = json!(state);
                        continue;
                    }
                    let name = file.get("name").and_then(Value::as_str).unwrap_or("");
                    if !name.ends_with(".jsonl") {
                        rejected += 1;
                        file["state"] = json!("rejected");
                        file["rejection"] = json!(
                            "unsupported format; only newline-delimited JSON (.jsonl) is supported"
                        );
                        tx.execute("UPDATE transcript_import_files SET state='rejected',updated_at=datetime('now') WHERE id=?",params![fid])?;
                        continue;
                    }
                    let mut bad = 0usize;
                    let mut good = 0usize;
                    for line in bytes.split(|b| *b == b'\n') {
                        if line.iter().all(u8::is_ascii_whitespace) {
                            continue;
                        }
                        match serde_json::from_slice::<Value>(line) {
                            Ok(v) => {
                                let session = v
                                    .get("sessionKey")
                                    .or_else(|| v.get("session_id"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                let harness =
                                    v.get("harness").and_then(Value::as_str).unwrap_or("");
                                let content =
                                    v.get("content").and_then(Value::as_str).unwrap_or("");
                                let idem = v
                                    .get("idempotencyKey")
                                    .or_else(|| v.get("idempotency_key"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                if session.is_empty()
                                    || harness.is_empty()
                                    || content.is_empty()
                                    || idem.is_empty()
                                {
                                    bad += 1;
                                } else {
                                    let mut h = Sha256::new();
                                    h.update(content.as_bytes());
                                    let hash = format!("{:x}", h.finalize());
                                    tx.execute("INSERT INTO session_transcripts (session_key,agent_id,harness,project,content,content_hash,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT(agent_id,idempotency_key) DO NOTHING",params![session,agent_id,harness,v.get("project").and_then(Value::as_str),content,hash,idem])?;
                                    good += 1;
                                }
                            }
                            Err(_) => bad += 1,
                        }
                    }
                    if good == 0 && bad > 0 {
                        rejected += 1;
                        file["state"] = json!("rejected");
                        file["rejection"] = json!("no valid transcript records");
                        tx.execute(
                            "UPDATE transcript_import_files SET state='rejected' WHERE id=?",
                            params![fid],
                        )?;
                    } else {
                        imported += 1;
                        file["state"] = json!("completed");
                        file["importedRecords"] = json!(good);
                        file["rejectedRecords"] = json!(bad);
                        tx.execute(
                            "UPDATE transcript_import_files SET state='completed' WHERE id=?",
                            params![fid],
                        )?;
                    }
                }
                let final_state = if rejected > 0 && imported == 0 {
                    "failed"
                } else if pending > 0 {
                    "paused"
                } else {
                    "completed"
                };
                tx.execute("UPDATE transcript_import_jobs SET state=?,files=?,updated_at=datetime('now') WHERE id=?",params![final_state,serde_json::to_string(&files)?,job_id])?;
                tx.commit()?;
                return Ok(
                    json!({"jobId":job_id,"state":final_state,"files":files,"imported":imported,"rejected":rejected,"pending":pending}),
                );
            }
            Err(CoreError::InvalidInput(
                "unsupported transcript import action".into(),
            ))
        }
        Operation::TranscriptUpsert {
            agent_id,
            session_key,
            harness,
            project,
            content,
            idempotency_key,
        } => {
            let agent_id = required_agent(&agent_id)?;
            if session_key.trim().is_empty()
                || harness.trim().is_empty()
                || content.len() > 16 * 1024 * 1024
                || idempotency_key.trim().is_empty()
            {
                return Err(CoreError::InvalidInput(
                    "invalid or oversized transcript".into(),
                ));
            }
            let mut hasher = Sha256::new();
            hasher.update(content.as_bytes());
            let hash = format!("{:x}", hasher.finalize());
            let transaction = connection.transaction()?;
            if let Some((session_key, content_hash)) = transaction
                .query_row(
                    "SELECT session_key,content_hash FROM session_transcripts WHERE agent_id=? AND idempotency_key=?",
                    params![agent_id, idempotency_key],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
            {
                transaction.commit()?;
                return Ok(json!({"sessionKey":session_key,"agentId":agent_id,"contentHash":content_hash,"state":"stored"}));
            }
            transaction.execute("INSERT INTO session_transcripts (session_key,agent_id,harness,project,content,content_hash,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT(agent_id,session_key) DO UPDATE SET content=excluded.content,content_hash=excluded.content_hash,updated_at=datetime('now')", params![session_key,agent_id,harness,project,content,hash,idempotency_key])?;
            transaction.commit()?;
            Ok(
                json!({"sessionKey":session_key,"agentId":agent_id,"contentHash":hash,"state":"stored"}),
            )
        }
        Operation::TranscriptList { agent_id, limit } => {
            let mut s=connection.prepare("SELECT json_object('sessionKey',session_key,'agentId',agent_id,'harness',harness,'project',project,'content',content,'contentHash',content_hash,'createdAt',created_at,'updatedAt',updated_at,'completedAt',completed_at) FROM session_transcripts WHERE agent_id=? ORDER BY created_at DESC LIMIT ?")?;
            let rows = s.query_map(
                params![required_agent(&agent_id)?, limit.clamp(1, 100)],
                |r| r.get::<_, String>(0),
            )?;
            Ok(Value::Array(
                rows.map(|r| Ok(serde_json::from_str(&r?)?))
                    .collect::<Result<Vec<Value>, CoreError>>()?,
            ))
        }
        Operation::QueueDiagnostics {
            agent_id,
            workspace_id,
            cursor,
            limit,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let limit = bounded_page_limit(Some(limit))?;
            let admitted: i64 = connection.query_row(
                "SELECT count(*) FROM queue WHERE agent_id=?",
                params![agent_id],
                |r| r.get(0),
            )?;
            let mut s = connection.prepare("SELECT json_object('id',id,'agentId',agent_id,'workspaceId',workspace_id,'kind',kind,'state',state,'createdAt',created_at,'updatedAt',updated_at) FROM jobs WHERE agent_id=? AND workspace_id=? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?")?;
            let rows = s.query_map(
                params![agent_id, workspace_id, cursor, cursor, limit as i64],
                |r| r.get::<_, String>(0),
            )?;
            let items = rows
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|v| serde_json::from_str(&v))
                .collect::<Result<Vec<Value>, _>>()?;
            let next_cursor = items.last().and_then(|v| v.get("id")).cloned();
            let jobs: i64 = connection.query_row(
                "SELECT count(*) FROM jobs WHERE agent_id=? AND workspace_id=?",
                params![agent_id, workspace_id],
                |r| r.get(0),
            )?;
            let events: i64 = connection.query_row("SELECT count(*) FROM job_events e JOIN jobs j ON j.id=e.job_id AND j.agent_id=e.agent_id WHERE e.agent_id=? AND j.workspace_id=?", params![agent_id, workspace_id], |r| r.get(0))?;
            Ok(
                json!({"agentId":agent_id,"workspaceId":workspace_id,"admission":{"queued":admitted},"jobs":{"count":jobs,"items":items,"nextCursor":next_cursor},"jobEvents":{"count":events}}),
            )
        }
        Operation::IntegrityVerify {
            agent_id,
            workspace_id,
            project_id,
            visibility,
            budget,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let visibility = bounded_text(&visibility, "visibility", 32)?;
            if visibility != "private" && visibility != "shared" {
                return Err(CoreError::InvalidInput(
                    "visibility must be private or shared".into(),
                ));
            }
            let project_id = project_id
                .map(|value| bounded_text(&value, "project", 256))
                .transpose()?;
            let project_key = project_id.clone().unwrap_or_default();
            let budget = budget.clamp(1, 32);
            let schema_hash = {
                let mut s = connection.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'memories_fts%' AND name != 'integrity_checkpoints' ORDER BY type,name")?;
                let rows = s.query_map([], |r| {
                    Ok(format!(
                        "{}:{}:{}\n",
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?
                    ))
                })?;
                let mut hasher = Sha256::new();
                for row in rows {
                    hasher.update(row?.as_bytes());
                }
                format!("{:x}", hasher.finalize())
            };
            connection.execute("CREATE TABLE IF NOT EXISTS integrity_checkpoints (agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL, schema_hash TEXT NOT NULL, next_table TEXT, completed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(agent_id,workspace_id,project_id,visibility))", [])?;
            // The first version allowed NULL project IDs. Normalize that legacy
            // representation before using the scope as an upsert key; otherwise
            // SQLite's NULL primary-key semantics permit duplicate default scopes.
            connection.execute("DELETE FROM integrity_checkpoints WHERE rowid NOT IN (SELECT MIN(rowid) FROM integrity_checkpoints GROUP BY agent_id,workspace_id,COALESCE(project_id,''),visibility)", [])?;
            connection.execute(
                "UPDATE integrity_checkpoints SET project_id='' WHERE project_id IS NULL",
                [],
            )?;
            let old: Option<(String, i64)> = connection.query_row("SELECT schema_hash,completed FROM integrity_checkpoints WHERE agent_id=? AND workspace_id=? AND project_id=? AND visibility=?", params![agent_id, workspace_id, project_key, visibility], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
            let reset = old.as_ref().is_none_or(|(hash, _)| hash != &schema_hash);
            let tables = ["documents", "memories", "jobs"];
            let start = if reset {
                0
            } else {
                old.as_ref().and_then(|_| connection.query_row("SELECT CASE next_table WHEN 'documents' THEN 0 WHEN 'memories' THEN 1 WHEN 'jobs' THEN 2 ELSE 3 END FROM integrity_checkpoints WHERE agent_id=? AND workspace_id=? AND project_id=? AND visibility=?", params![agent_id,workspace_id,project_key,visibility], |r| r.get::<_,i64>(0)).optional().ok().flatten()).unwrap_or(0) as usize
            };
            let end = (start + budget).min(tables.len());
            let mut checked_tables = Vec::new();
            for table in &tables[start..end] {
                let count: i64 =
                    connection
                        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?;
                checked_tables.push(json!({"table": table, "rows": count}));
            }
            let integrity_check: String =
                connection.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            if integrity_check != "ok" {
                return Err(CoreError::InvalidInput(format!(
                    "integrity check failed: {integrity_check}"
                )));
            }
            let completed = end == tables.len();
            let next = if completed {
                None
            } else {
                Some(tables[end].to_owned())
            };
            connection.execute("INSERT INTO integrity_checkpoints(agent_id,workspace_id,project_id,visibility,schema_hash,next_table,completed,updated_at) VALUES(?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(agent_id,workspace_id,project_id,visibility) DO UPDATE SET schema_hash=excluded.schema_hash,next_table=excluded.next_table,completed=excluded.completed,updated_at=excluded.updated_at", params![agent_id,workspace_id,project_key,visibility,schema_hash,next,completed as i64])?;
            Ok(
                json!({"status":"verified","agentId":agent_id,"workspaceId":workspace_id,"projectId":project_id,"visibility":visibility,"fts":"skipped","integrityCheck":integrity_check,"checkedTables":checked_tables,"checkpoint":{"nextTable":next,"completed":completed,"schemaHash":schema_hash}}),
            )
        }
        Operation::RepairRequeueRunning {
            agent_id,
            workspace_id,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let integrity_check: String =
                connection.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            if integrity_check != "ok" {
                return Err(CoreError::InvalidInput(
                    "repair refused: database integrity check failed".into(),
                ));
            }
            let tx = connection.transaction()?;
            let changed: Vec<(String, String)> = {
                let mut updated = tx.prepare("UPDATE jobs SET state='queued', updated_at=datetime('now'), error=NULL WHERE agent_id=? AND workspace_id=? AND state='running' RETURNING id,agent_id")?;
                let rows = updated.query_map(params![agent_id, workspace_id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            let count = changed.len();
            let event_data = serde_json::to_string(&json!({"source":"repair"}))?;
            for (job_id, job_agent_id) in changed {
                tx.execute("INSERT INTO job_events (job_id,agent_id,event,data,created_at) VALUES (?,?,'requeued',?,datetime('now'))", params![job_id, job_agent_id, event_data])?;
            }
            tx.commit()?;
            Ok(
                json!({"action":"requeue_running","agentId":agent_id,"workspaceId":workspace_id,"requeued":count}),
            )
        }
        Operation::JobSubmit {
            agent_id,
            workspace_id,
            kind,
            payload,
            deadline_at,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let deadline_at = deadline_at
                .map(|value| validate_deadline(&value))
                .transpose()?;
            if kind.trim().is_empty() || kind.len() > 64 {
                return Err(CoreError::InvalidInput(
                    "job kind must be 1-64 bytes".into(),
                ));
            }
            let id = uuid::Uuid::new_v4().to_string();
            let payload = serde_json::to_string(&payload)?;
            if payload.len() > 1_048_576 {
                return Err(CoreError::InvalidInput("job payload exceeds 1 MiB".into()));
            }
            let expired = deadline_at.as_deref().is_some_and(|value| {
                connection
                    .query_row(
                        "SELECT julianday(?) <= julianday('now')",
                        params![value],
                        |row| row.get(0),
                    )
                    .unwrap_or(false)
            });
            let (state, event, error) =
                if !matches!(kind.as_str(), "dream.trigger" | "dream.pass" | "dreaming") {
                    (
                        "unsupported",
                        "unsupported",
                        Some(format!("unsupported job kind: {kind}")),
                    )
                } else if expired {
                    ("expired", "expired", Some("deadline exceeded".to_owned()))
                } else {
                    ("queued", "queued", None)
                };
            let transaction = connection.transaction()?;
            transaction.execute("INSERT INTO jobs (id,agent_id,workspace_id,kind,state,payload,deadline_at,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))", params![id,agent_id,workspace_id,kind,state,payload,deadline_at,error])?;
            transaction.execute("INSERT INTO job_events (job_id,agent_id,event,data,created_at) VALUES (?,?, ?,?,datetime('now'))", params![id,agent_id,event,serde_json::to_string(&json!({"error":error}))?])?;
            transaction.commit()?;
            Ok(json!({"id":id,"state":state,"workspaceId":workspace_id,"error":error}))
        }
        Operation::JobGet {
            agent_id,
            workspace_id,
            id,
        } => {
            let value: Option<String> = connection.query_row("SELECT json_object('id',id,'agentId',agent_id,'workspaceId',workspace_id,'kind',kind,'state',state,'payload',json(payload),'result',CASE WHEN result IS NULL THEN NULL ELSE json(result) END,'error',error,'deadlineAt',deadline_at,'createdAt',created_at,'updatedAt',updated_at) FROM jobs WHERE id=? AND agent_id=? AND workspace_id=?", params![id,agent_id,workspace_id], |r| r.get(0)).optional()?;
            value
                .map(|v| serde_json::from_str(&v))
                .transpose()?
                .ok_or(CoreError::NotFound)
        }
        Operation::JobCancel {
            agent_id,
            workspace_id,
            id,
            actor,
            reason,
        } => {
            let actor = bounded_text(&actor, "actor", 256)?;
            let reason = bounded_text(&reason, "reason", 256)?;
            let tx = connection.transaction()?;
            let state: Option<String> = tx
                .query_row(
                    "SELECT state FROM jobs WHERE id=? AND agent_id=? AND workspace_id=?",
                    params![id, agent_id, workspace_id],
                    |r| r.get(0),
                )
                .optional()?;
            let state = state.ok_or(CoreError::NotFound)?;
            let prior_cancellation: Option<(String, String, String)> = tx
                .query_row(
                    "SELECT actor,reason,provenance FROM job_cancellations WHERE job_id=? AND agent_id=? ORDER BY id LIMIT 1",
                    params![id, agent_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let final_state = if matches!(state.as_str(), "queued" | "running") {
                tx.execute("UPDATE jobs SET state='cancelled', updated_at=datetime('now') WHERE id=? AND agent_id=? AND workspace_id=? AND state IN ('queued','running')", params![id,agent_id,workspace_id])?;
                tx.execute("INSERT INTO job_events (job_id,agent_id,event,data,created_at) VALUES (?,?,'cancelled',?,datetime('now'))", params![id,agent_id,serde_json::to_string(&json!({"actor":actor,"reason":reason}))?])?;
                "cancelled"
            } else {
                state.as_str()
            };
            if prior_cancellation.is_none() {
                tx.execute("INSERT INTO job_cancellations(job_id,agent_id,actor,reason,provenance,created_at) VALUES(?,?,?,?,?,datetime('now'))", params![id,agent_id,actor,reason,"api"])?;
            }
            let (response_actor, response_reason, response_provenance) =
                prior_cancellation.unwrap_or_else(|| (actor.clone(), reason.clone(), "api".into()));
            tx.commit()?;
            Ok(json!({
                "id":id,
                "state":final_state,
                "cancellation":{
                    "actor":response_actor,
                    "reason":response_reason,
                    "provenance":response_provenance
                }
            }))
        }
        Operation::JobList {
            agent_id,
            workspace_id,
            cursor,
            limit,
        } => {
            let mut s=connection.prepare("SELECT json_object('id',id,'agentId',agent_id,'workspaceId',workspace_id,'kind',kind,'state',state,'error',error,'createdAt',created_at,'updatedAt',updated_at) FROM jobs WHERE agent_id=? AND workspace_id=? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?")?;
            let rows = s.query_map(
                params![
                    agent_id,
                    workspace_id,
                    cursor,
                    cursor,
                    limit.clamp(1, 100) as i64
                ],
                |r| r.get::<_, String>(0),
            )?;
            let values = rows
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|v| serde_json::from_str(&v))
                .collect::<Result<Vec<Value>, _>>()?;
            let next_cursor = values.last().and_then(|value| value.get("id")).cloned();
            Ok(json!({"items":values,"cursor":next_cursor}))
        }
        Operation::JobEvents {
            agent_id,
            workspace_id,
            id,
            cursor,
            limit,
        } => {
            let mut s=connection.prepare("SELECT json_object('cursor',e.id,'event',e.event,'data',json(e.data),'createdAt',e.created_at) FROM job_events e JOIN jobs j ON j.id=e.job_id AND j.agent_id=e.agent_id WHERE e.job_id=? AND e.agent_id=? AND j.workspace_id=? AND e.id>? ORDER BY e.id LIMIT ?")?;
            let rows = s.query_map(
                params![
                    id,
                    agent_id,
                    workspace_id,
                    cursor,
                    limit.clamp(1, 1000) as i64
                ],
                |r| r.get::<_, String>(0),
            )?;
            let values = rows
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|v| serde_json::from_str(&v))
                .collect::<Result<Vec<Value>, _>>()?;
            Ok(json!(values))
        }
        Operation::PipelineStatus { agent_id } => {
            let agent_id = required_agent(&agent_id)?;
            let row: Option<(i64, i64)> = connection
                .query_row(
                    "SELECT COALESCE(SUM(state='queued'),0), COALESCE(SUM(state='running'),0) FROM jobs WHERE agent_id=? AND kind LIKE 'dream.%'",
                    params![agent_id], |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let paused: i64 = connection
                .query_row(
                    "SELECT paused FROM pipeline_state WHERE agent_id=?",
                    params![agent_id],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(0);
            let (queued, running) = row.unwrap_or((0, 0));
            let state = if paused != 0 {
                "paused"
            } else if running > 0 {
                "running"
            } else if queued > 0 {
                "queued"
            } else {
                "idle"
            };
            Ok(json!({"agentId":agent_id,"state":state,"paused":paused != 0}))
        }
        Operation::PipelineSetPaused { agent_id, paused } => {
            let agent_id = required_agent(&agent_id)?;
            let tx = connection.transaction()?;
            tx.execute("INSERT INTO pipeline_state(agent_id,state,paused,updated_at) VALUES(?, 'idle', ?, datetime('now')) ON CONFLICT(agent_id) DO UPDATE SET paused=excluded.paused, updated_at=datetime('now')", params![agent_id, paused as i64])?;
            tx.commit()?;
            let state = if paused { "paused" } else { "idle" };
            Ok(json!({"agentId":agent_id,"state":state,"paused":paused}))
        }
        Operation::DreamStatus { agent_id } => {
            let status = execute_operation(
                connection,
                Operation::PipelineStatus {
                    agent_id: agent_id.clone(),
                },
            )?;
            Ok(
                json!({"agentId":agent_id,"status":if status.get("paused").and_then(Value::as_bool).unwrap_or(false) {"paused"} else {"ready"},"pipeline":status}),
            )
        }
        Operation::DreamActivePasses { agent_id } => {
            let agent_id = required_agent(&agent_id)?;
            let mut s = connection.prepare("SELECT json_object('id',id,'kind',kind,'state',state,'createdAt',created_at,'updatedAt',updated_at) FROM jobs WHERE agent_id=? AND kind LIKE 'dream.%' AND state IN ('queued','running') ORDER BY created_at LIMIT 100")?;
            let rows = s.query_map(params![agent_id], |r| r.get::<_, String>(0))?;
            let values = rows
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|v| serde_json::from_str(&v))
                .collect::<Result<Vec<Value>, _>>()?;
            Ok(json!({"agentId":agent_id,"passes":values}))
        }
        Operation::WorkerClaim => {
            let job = claim_worker_connection(connection)?;
            Ok(job.map_or(Value::Null, |job| {
                serde_json::to_value(job).unwrap_or(Value::Null)
            }))
        }
        Operation::WorkerFinish {
            job,
            state,
            error,
            result,
        } => {
            finish_worker_connection(connection, &job, &state, error.as_deref(), result)?;
            Ok(json!({"ok":true}))
        }
        Operation::DreamTrigger {
            agent_id,
            workspace_id,
            payload,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let payload = bounded_json(&payload)?;
            let paused: i64 = connection
                .query_row(
                    "SELECT paused FROM pipeline_state WHERE agent_id=?",
                    params![agent_id],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(0);
            if paused != 0 {
                return Err(CoreError::InvalidInput("pipeline is paused".into()));
            }
            let count: i64 = connection.query_row(
                "SELECT count(*) FROM jobs WHERE agent_id=? AND state IN ('queued','running')",
                params![agent_id],
                |r| r.get(0),
            )?;
            if count >= 100 {
                return Err(CoreError::QueueFull { capacity: 100 });
            }
            let id = uuid::Uuid::new_v4().to_string();
            let tx = connection.transaction()?;
            tx.execute("INSERT INTO jobs(id,agent_id,workspace_id,kind,state,payload,created_at,updated_at) VALUES(?,?,?, 'dream.trigger','queued',?,datetime('now'),datetime('now'))", params![id,agent_id,workspace_id,payload])?;
            tx.execute("INSERT INTO job_events(job_id,agent_id,event,data,created_at) VALUES(?,?, 'queued','{}',datetime('now'))", params![id,agent_id])?;
            tx.commit()?;
            Ok(
                json!({"id":id,"jobId":id,"agentId":agent_id,"workspaceId":workspace_id,"kind":"dream.trigger","state":"queued"}),
            )
        }
        Operation::AuthKeyCreate {
            agent_id,
            name,
            role,
            scope,
            permissions,
            connector,
            harness,
            allowed_projects,
            expires_at,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let name = bounded_text(&name, "name", 256)?;
            if !["admin", "operator", "agent", "readonly"].contains(&role.as_str()) {
                return Err(CoreError::InvalidInput("invalid role".into()));
            }
            if let Some(expires_at) = expires_at.as_deref() {
                let valid: bool = connection.query_row(
                    "SELECT julianday(?) IS NOT NULL",
                    params![expires_at],
                    |row| row.get(0),
                )?;
                if !valid {
                    return Err(CoreError::InvalidInput(
                        "expires_at must be a valid SQLite date-time".into(),
                    ));
                }
            }
            let scope_json = bounded_json(&scope)?;
            let permissions_json = bounded_json(&permissions)?;
            let allowed_projects_json = bounded_json(&allowed_projects)?;
            let connector = connector
                .as_deref()
                .map(|value| bounded_text(value, "connector", 128))
                .transpose()?;
            let harness = harness
                .as_deref()
                .map(|value| bounded_text(value, "harness", 128))
                .transpose()?;
            let id = format!("key_{}", uuid::Uuid::new_v4());
            let prefix = uuid::Uuid::new_v4().simple().to_string()[..12].to_owned();
            let secret = format!("sig_sk_{}_{}", prefix, uuid::Uuid::new_v4());
            let digest = format!("{:x}", sha2::Sha256::digest(secret.as_bytes()));
            let tx = connection.transaction()?;
            let created_at: String =
                tx.query_row("SELECT datetime('now')", [], |row| row.get(0))?;
            tx.execute("INSERT INTO api_keys(id,prefix,name,key_hash,role,scope_json,permissions_json,connector,harness,agent_id,allowed_projects_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", params![id,prefix,name,digest,role,scope_json,permissions_json,connector,harness,agent_id,allowed_projects_json,created_at,expires_at])?;
            tx.commit()?;
            Ok(
                json!({"id":id,"prefix":prefix,"name":name,"role":role,"agentId":agent_id,"scope":scope,"permissions":permissions,"connector":connector,"harness":harness,"allowedProjects":allowed_projects,"createdAt":created_at,"lastUsedAt":null,"revokedAt":null,"expiresAt":expires_at,"key":secret}),
            )
        }
        Operation::AuthKeyList { agent_id } => {
            let agent_id = required_agent(&agent_id)?;
            let mut s = connection.prepare("SELECT id,prefix,name,role,scope_json,permissions_json,connector,harness,allowed_projects_json,created_at,last_used_at,revoked_at,expires_at,agent_id FROM api_keys WHERE agent_id=? ORDER BY created_at DESC")?;
            let rows = s.query_map(params![agent_id], |r| {
                let scope: String = r.get(4)?;
                let permissions: String = r.get(5)?;
                let allowed_projects: Option<String> = r.get(8)?;
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "prefix": r.get::<_, String>(1)?,
                    "name": r.get::<_, String>(2)?,
                    "role": r.get::<_, String>(3)?,
                    "scope": serde_json::from_str::<Value>(&scope).unwrap_or(json!({})),
                    "permissions": serde_json::from_str::<Value>(&permissions).unwrap_or(json!([])),
                    "connector": r.get::<_, Option<String>>(6)?,
                    "harness": r.get::<_, Option<String>>(7)?,
                    "allowedProjects": allowed_projects
                        .as_deref()
                        .and_then(|value| serde_json::from_str::<Value>(value).ok())
                        .unwrap_or(json!([])),
                    "createdAt": r.get::<_, String>(9)?,
                    "lastUsedAt": r.get::<_, Option<String>>(10)?,
                    "revokedAt": r.get::<_, Option<String>>(11)?,
                    "expiresAt": r.get::<_, Option<String>>(12)?,
                    "agentId": r.get::<_, String>(13)?
                }))
            })?;
            Ok(json!(rows.collect::<Result<Vec<_>, _>>()?))
        }
        Operation::AuthKeyRevoke { agent_id, id } => {
            let agent_id = required_agent(&agent_id)?;
            let id = required_id(&id)?;
            let changed = connection.execute(
                "UPDATE api_keys SET revoked_at=COALESCE(revoked_at,datetime('now')) WHERE (id=? OR prefix=?) AND agent_id=?",
                params![id, id, agent_id],
            )?;
            if changed == 0 {
                return Err(CoreError::NotFound);
            }
            Ok(json!({"id":id,"revoked":true}))
        }
        Operation::AuthKeyVerify { token } => {
            let parts: Vec<&str> = token.splitn(3, '_').collect();
            if parts.len() != 3 || parts[0] != "sig" || parts[1] != "sk" {
                return Ok(json!({"authenticated":false,"error":"malformed api key"}));
            }
            let prefix = parts[2].split('_').next().unwrap_or("");
            let digest = format!("{:x}", sha2::Sha256::digest(token.as_bytes()));
            let row: Option<(
                String,
                String,
                Option<String>,
                Option<String>,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
                String,
            )> = connection
                .query_row(
                    "SELECT agent_id,role,revoked_at,expires_at,scope_json,permissions_json,connector,harness,allowed_projects_json,id FROM api_keys WHERE prefix=? AND key_hash=?",
                    params![prefix, digest],
                    |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                            r.get(7)?,
                            r.get(8)?,
                            r.get(9)?,
                        ))
                    },
                )
                .optional()?;
            let Some((
                agent_id,
                role,
                revoked,
                expires,
                scope,
                permissions,
                connector,
                harness,
                allowed_projects,
                id,
            )) = row
            else {
                return Ok(json!({"authenticated":false,"error":"invalid api key"}));
            };
            if revoked.is_some() {
                return Ok(json!({"authenticated":false,"error":"api key revoked"}));
            }
            let expired = expires
                .as_deref()
                .map(|expires_at| {
                    connection.query_row(
                        "SELECT julianday(?) <= julianday('now')",
                        params![expires_at],
                        |row| row.get::<_, bool>(0),
                    )
                })
                .transpose()?
                .unwrap_or(false);
            if expired {
                return Ok(json!({"authenticated":false,"error":"api key expired"}));
            }
            connection.execute(
                "UPDATE api_keys SET last_used_at=datetime('now') WHERE id=?",
                params![id],
            )?;
            Ok(json!({
                "authenticated": true,
                "agentId": agent_id,
                "role": role,
                "scope": serde_json::from_str::<Value>(&scope).unwrap_or(json!({})),
                "permissions": permissions
                    .as_deref()
                    .and_then(|value| serde_json::from_str::<Value>(value).ok())
                    .unwrap_or(json!([])),
                "connector": connector,
                "harness": harness,
                "allowedProjects": allowed_projects
                    .as_deref()
                    .and_then(|value| serde_json::from_str::<Value>(value).ok())
                    .unwrap_or(json!([])),
            }))
        }
        Operation::MemoryAdvanced {
            agent_id,
            action,
            id,
            payload,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let tx = connection.transaction()?;
            let result = match action.as_str() {
                "feedback" => {
                    let memory_id =
                        id.ok_or_else(|| CoreError::InvalidInput("memory id is required".into()))?;
                    let rating = payload
                        .get("rating")
                        .and_then(Value::as_str)
                        .unwrap_or("neutral");
                    if !matches!(rating, "positive" | "negative" | "neutral") {
                        return Err(CoreError::InvalidInput(
                            "rating must be positive, negative, or neutral".into(),
                        ));
                    }
                    tx.execute("CREATE TABLE IF NOT EXISTS memory_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, agent_id TEXT NOT NULL, rating TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL)", [])?;
                    let exists: i64 = tx.query_row(
                        "SELECT count(*) FROM memories WHERE id=? AND agent_id=? AND deleted=0",
                        params![memory_id, agent_id],
                        |r| r.get(0),
                    )?;
                    if exists == 0 {
                        return Err(CoreError::NotFound);
                    }
                    tx.execute("INSERT INTO memory_feedback(memory_id,agent_id,rating,note,created_at) VALUES(?,?,?,?,datetime('now'))", params![memory_id, agent_id, rating, payload.get("note").and_then(Value::as_str)])?;
                    record_history(
                        &tx,
                        &memory_id,
                        &agent_id,
                        "feedback",
                        payload.get("note").and_then(Value::as_str),
                    )?;
                    json!({"recorded":1,"memoryId":memory_id,"rating":rating})
                }
                "forget" | "tombstone" => {
                    let memory_id =
                        id.ok_or_else(|| CoreError::InvalidInput("memory id is required".into()))?;
                    let changed = tx.execute("UPDATE memories SET deleted=1, updated_at=datetime('now') WHERE id=? AND agent_id=? AND deleted=0", params![memory_id, agent_id])?;
                    if changed == 0 {
                        return Err(CoreError::NotFound);
                    }
                    record_history(
                        &tx,
                        &memory_id,
                        &agent_id,
                        "tombstone",
                        payload.get("reason").and_then(Value::as_str),
                    )?;
                    json!({"id":memory_id,"status":"tombstoned"})
                }
                "modify" => {
                    let memory_id =
                        id.ok_or_else(|| CoreError::InvalidInput("memory id is required".into()))?;
                    let content = payload
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| CoreError::InvalidInput("content is required".into()))?;
                    if content.trim().is_empty() {
                        return Err(CoreError::InvalidInput("content must not be empty".into()));
                    }
                    let changed = tx.execute("UPDATE memories SET content=?, updated_at=datetime('now') WHERE id=? AND agent_id=? AND deleted=0", params![content, memory_id, agent_id])?;
                    if changed == 0 {
                        return Err(CoreError::NotFound);
                    }
                    record_history(&tx, &memory_id, &agent_id, "modify", Some(content))?;
                    json!({"id":memory_id,"content":content})
                }
                "timeline" | "lineage" | "review" => {
                    if let Some(memory_id) = id {
                        let exists: i64 = tx.query_row(
                            "SELECT count(*) FROM memories WHERE id=? AND agent_id=?",
                            params![memory_id, agent_id],
                            |r| r.get(0),
                        )?;
                        if exists == 0 {
                            return Err(CoreError::NotFound);
                        }
                        let mut stmt = tx.prepare("SELECT operation,content,created_at FROM memory_history WHERE memory_id=? AND agent_id=? ORDER BY id")?;
                        let rows = stmt.query_map(params![memory_id, agent_id], |r| Ok(json!({"operation":r.get::<_,String>(0)?,"content":r.get::<_,Option<String>>(1)?,"createdAt":r.get::<_,String>(2)?})))?;
                        json!({"id":memory_id,"items":rows.collect::<Result<Vec<_>,_>>()?})
                    } else if action == "timeline" {
                        let mut stmt = tx.prepare("SELECT memory_id,operation,content,created_at FROM memory_history WHERE agent_id=? ORDER BY id DESC LIMIT 1000")?;
                        let rows = stmt.query_map(params![agent_id], |r| Ok(json!({"memoryId":r.get::<_,String>(0)?,"operation":r.get::<_,String>(1)?,"content":r.get::<_,Option<String>>(2)?,"createdAt":r.get::<_,String>(3)?})))?;
                        json!({"items":rows.collect::<Result<Vec<_>,_>>()?})
                    } else {
                        return Err(CoreError::InvalidInput("memory id is required".into()));
                    }
                }
                "review-queue" => {
                    let mut stmt = tx.prepare("SELECT h.id,h.memory_id,h.operation,h.content,h.created_at FROM memory_history h WHERE h.agent_id=? AND h.operation IN ('DEDUP','REVIEW_NEEDED','BLOCKED_DESTRUCTIVE') ORDER BY h.id DESC LIMIT 100")?;
                    let rows = stmt.query_map(params![agent_id], |r| Ok(json!({"eventId":r.get::<_,i64>(0)?,"memoryId":r.get::<_,String>(1)?,"event":r.get::<_,String>(2)?,"content":r.get::<_,Option<String>>(3)?,"createdAt":r.get::<_,String>(4)?})))?;
                    json!({"items":rows.collect::<Result<Vec<_>,_>>()?})
                }
                "supersede" => {
                    let old_id =
                        id.ok_or_else(|| CoreError::InvalidInput("memory id is required".into()))?;
                    let new_id = payload
                        .get("supersededBy")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            CoreError::InvalidInput("supersededBy is required".into())
                        })?;
                    if new_id == old_id || required_id(new_id).is_err() {
                        return Err(CoreError::InvalidInput(
                            "supersededBy must be a different valid memory id".into(),
                        ));
                    }
                    let target_exists: i64 = tx.query_row(
                        "SELECT count(*) FROM memories WHERE id=? AND agent_id=? AND deleted=0",
                        params![new_id, agent_id],
                        |r| r.get(0),
                    )?;
                    if target_exists == 0 {
                        return Err(CoreError::NotFound);
                    }
                    let changed = tx.execute("UPDATE memories SET deleted=1, superseded_by=?, superseded_at=datetime('now'), superseded_reason=?, updated_at=datetime('now') WHERE id=? AND agent_id=? AND deleted=0", params![new_id, payload.get("reason").or_else(||payload.get("supersededReason")).and_then(Value::as_str), old_id, agent_id])?;
                    if changed == 0 {
                        return Err(CoreError::NotFound);
                    }
                    let reason = payload
                        .get("reason")
                        .or_else(|| payload.get("supersededReason"))
                        .and_then(Value::as_str);
                    record_history(
                        &tx,
                        &old_id,
                        &agent_id,
                        "supersede",
                        reason.or(Some(new_id)),
                    )?;
                    let superseded_at: String = tx.query_row(
                        "SELECT superseded_at FROM memories WHERE id=? AND agent_id=?",
                        params![old_id, agent_id],
                        |r| r.get(0),
                    )?;
                    json!({"id":old_id,"status":"superseded","supersededBy":new_id,"supersededAt":superseded_at,"supersededReason":reason})
                }
                "native-note" => {
                    let content = payload
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| CoreError::InvalidInput("content is required".into()))?;
                    let memory_id = uuid::Uuid::new_v4().to_string();
                    tx.execute("INSERT INTO memories(id,agent_id,content,metadata,deleted,created_at,updated_at) VALUES(?,?,?,? ,0,datetime('now'),datetime('now'))", params![memory_id, agent_id, content, serde_json::to_string(&payload)?])?;
                    record_history(&tx, &memory_id, &agent_id, "native-note", None)?;
                    json!({"id":memory_id,"recorded":true})
                }
                _ => {
                    return Err(CoreError::InvalidInput(
                        "unsupported advanced memory action".into(),
                    ))
                }
            };
            tx.commit()?;
            Ok(result)
        }
        Operation::SecretList {
            agent_id,
            workspace_id,
            limit,
        } => {
            let agent_id = bounded_text(&agent_id, "agent id", 256)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let limit = bounded_page_limit(Some(limit))?;
            let mut stmt = connection.prepare("SELECT name,provider,created_at,updated_at FROM secrets WHERE agent_id=? AND workspace_id=? AND deleted=0 ORDER BY rowid DESC LIMIT ?")?;
            let rows = stmt.query_map(params![agent_id, workspace_id, limit as i64], |r| Ok(json!({"name":r.get::<_,String>(0)?,"provider":r.get::<_,String>(1)?,"createdAt":r.get::<_,String>(2)?,"updatedAt":r.get::<_,String>(3)?})))?;
            Ok(json!({"items": rows.collect::<Result<Vec<_>,_>>()?}))
        }
        Operation::SecretUpsert {
            agent_id,
            workspace_id,
            name,
            value,
        } => {
            let agent_id = bounded_text(&agent_id, "agent id", 256)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let name = bounded_text(&name, "secret name", 256)?;
            let value = bounded_text(&value, "secret value", 64 * 1024)?;
            let id = uuid::Uuid::new_v4().to_string();
            connection.execute("INSERT INTO secrets(id,agent_id,workspace_id,name,provider,value,deleted,created_at,updated_at) VALUES(?,?,?,?, 'local', ?,0,datetime('now'),datetime('now')) ON CONFLICT(agent_id,workspace_id,name) DO UPDATE SET value=excluded.value,deleted=0,updated_at=datetime('now')", params![id,agent_id,workspace_id,name,value])?;
            Ok(json!({"name":name,"provider":"local"}))
        }
        Operation::SecretDelete {
            agent_id,
            workspace_id,
            name,
        } => {
            let changed = connection.execute("UPDATE secrets SET deleted=1,updated_at=datetime('now') WHERE agent_id=? AND workspace_id=? AND name=? AND deleted=0", params![bounded_text(&agent_id,"agent id",256)?,canonical_workspace(&workspace_id)?,bounded_text(&name,"secret name",256)?])?;
            Ok(json!({"deleted": changed > 0}))
        }
        Operation::Health => {
            let value: i64 = connection.query_row("SELECT 1", [], |row| row.get(0))?;
            let migrations: i64 = connection.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('memories','jobs','pipeline_state')",
                [],
                |row| row.get(0),
            )?;
            Ok(json!({
                "ready": value == 1 && migrations == 3,
                "database": "ready",
                "migrations": { "status": if migrations == 3 { "complete" } else { "incomplete" }, "expected": 3, "present": migrations },
                "owner": { "status": "ready" }
            }))
        }
        Operation::Remember {
            agent_id,
            content,
            metadata,
        } => {
            let agent_id = required_agent(&agent_id)?;
            if content.trim().is_empty() {
                return Err(CoreError::InvalidInput("content must not be empty".into()));
            }
            let id = uuid::Uuid::new_v4().to_string();
            let metadata_value = metadata.clone();
            let metadata = serde_json::to_string(&metadata)?;
            let memory_kind =
                classify_memory_kind(metadata_value.get("sourceType").and_then(Value::as_str));
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO memories (id, agent_id, content, metadata, deleted, created_at, updated_at, source_id, source_type, source_path, runtime_path, idempotency_key, memory_kind) VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'), ?, ?, ?, ?, ?, ?)",
                params![id, agent_id, content, metadata, metadata_value.get("sourceId").and_then(Value::as_str), metadata_value.get("sourceType").and_then(Value::as_str), metadata_value.get("sourcePath").and_then(Value::as_str), metadata_value.get("runtimePath").and_then(Value::as_str), metadata_value.get("idempotencyKey").and_then(Value::as_str), memory_kind],
            )?;
            record_history(&transaction, &id, &agent_id, "remember", None)?;
            transaction.commit()?;
            let mut result = json!({ "id": id });
            if let Value::Object(fields) = metadata_value {
                for key in [
                    "sourceId",
                    "sourceType",
                    "sourcePath",
                    "runtimePath",
                    "idempotencyKey",
                ] {
                    if let Some(value) = fields.get(key) {
                        result[key] = value.clone();
                    }
                }
                if memory_kind.is_some() {
                    result["memoryKind"] = json!("episodic");
                }
            }
            Ok(result)
        }
        Operation::List {
            agent_id,
            include_deleted,
            limit,
            cursor,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let limit = bounded_page_limit(limit)?;
            let cursor = parse_cursor(cursor)?;
            let mut statement = connection.prepare(
                "SELECT id, agent_id, content, metadata, deleted, created_at, updated_at, source_id, source_type, source_path, runtime_path, idempotency_key, memory_kind, rowid
                 FROM memories
                 WHERE COALESCE(agent_id, 'default') = ? AND (? OR deleted = 0) AND (? IS NULL OR rowid < ?)
                 ORDER BY rowid DESC LIMIT ?",
            )?;
            let mut rows = statement.query(params![
                agent_id,
                include_deleted as i64,
                cursor,
                cursor,
                (limit + 1) as i64
            ])?;
            let mut items = Vec::with_capacity(limit);
            let mut next_cursor = None;
            let mut last_rowid = None;
            while let Some(row) = rows.next()? {
                let item = memory_row(row)?;
                let rowid: i64 = row.get(13)?;
                if items.len() == limit {
                    next_cursor = last_rowid.map(|value: i64| value.to_string());
                    break;
                }
                items.push(item);
                last_rowid = Some(rowid);
            }
            Ok(
                json!({"items": items, "nextCursor": next_cursor, "complete": next_cursor.is_none()}),
            )
        }
        Operation::Get { agent_id, id } => {
            let agent_id = required_agent(&agent_id)?;
            let id = required_id(&id)?;
            let memory = connection
                .query_row(
                    "SELECT id, agent_id, content, metadata, deleted, created_at, updated_at, source_id, source_type, source_path, runtime_path, idempotency_key, memory_kind
                     FROM memories
                     WHERE id = ? AND COALESCE(agent_id, 'default') = ? AND deleted = 0",
                    params![id, agent_id],
                    memory_row,
                )
                .optional()?;
            Ok(serde_json::to_value(memory)?)
        }
        Operation::Update {
            agent_id,
            id,
            content,
            metadata,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let id = required_id(&id)?;
            if content.trim().is_empty() {
                return Err(CoreError::InvalidInput("content must not be empty".into()));
            }
            let metadata_value = metadata.clone();
            let metadata = serde_json::to_string(&metadata)?;
            let memory_kind =
                classify_memory_kind(metadata_value.get("sourceType").and_then(Value::as_str));
            let transaction = connection.transaction()?;
            let changed = transaction.execute(
                "UPDATE memories SET content = ?, metadata = ?, source_id = ?, source_type = ?, source_path = ?, runtime_path = ?, idempotency_key = ?, memory_kind = ?, updated_at = datetime('now')
                 WHERE id = ? AND COALESCE(agent_id, 'default') = ? AND deleted = 0",
                params![content, metadata, metadata_value.get("sourceId").and_then(Value::as_str), metadata_value.get("sourceType").and_then(Value::as_str), metadata_value.get("sourcePath").and_then(Value::as_str), metadata_value.get("runtimePath").and_then(Value::as_str), metadata_value.get("idempotencyKey").and_then(Value::as_str), memory_kind, id, agent_id],
            )?;
            if changed == 0 {
                return Err(CoreError::NotFound);
            }
            record_history(&transaction, &id, &agent_id, "update", Some(&content))?;
            transaction.commit()?;
            Ok(json!({ "updated": true }))
        }
        Operation::SoftDelete { agent_id, id } => {
            let agent_id = required_agent(&agent_id)?;
            let id = required_id(&id)?;
            let transaction = connection.transaction()?;
            let changed = transaction.execute(
                "UPDATE memories SET deleted = 1, updated_at = datetime('now')
                 WHERE id = ? AND COALESCE(agent_id, 'default') = ? AND deleted = 0",
                params![id, agent_id],
            )?;
            if changed == 0 {
                return Err(CoreError::NotFound);
            }
            record_history(&transaction, &id, &agent_id, "delete", None)?;
            transaction.commit()?;
            Ok(json!({ "deleted": true }))
        }
        Operation::Recover { agent_id, id } => {
            let agent_id = required_agent(&agent_id)?;
            let id = required_id(&id)?;
            let transaction = connection.transaction()?;
            let changed = transaction.execute(
                "UPDATE memories SET deleted = 0, updated_at = datetime('now')
                 WHERE id = ? AND COALESCE(agent_id, 'default') = ? AND deleted = 1",
                params![id, agent_id],
            )?;
            if changed == 0 {
                return Err(CoreError::NotFound);
            }
            record_history(&transaction, &id, &agent_id, "recover", None)?;
            transaction.commit()?;
            Ok(json!({ "recovered": true }))
        }
        Operation::History { agent_id, id } => {
            let agent_id = required_agent(&agent_id)?;
            let id = required_id(&id)?;
            let mut statement = connection.prepare(
                "SELECT id, memory_id, operation, content, created_at
                 FROM memory_history
                 WHERE memory_id = ? AND agent_id = ?
                 ORDER BY id ASC LIMIT 1000",
            )?;
            let rows = statement.query_map(params![id, agent_id], |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "memoryId": row.get::<_, String>(1)?,
                    "operation": row.get::<_, String>(2)?,
                    "content": row.get::<_, Option<String>>(3)?,
                    "createdAt": row.get::<_, String>(4)?,
                }))
            })?;
            Ok(serde_json::to_value(rows.collect::<Result<Vec<_>, _>>()?)?)
        }
        Operation::Recall { agent_id, query } => {
            let agent_id = required_agent(&agent_id)?;
            let query = query.trim();
            if query.is_empty() {
                return Err(CoreError::InvalidInput("query must not be empty".into()));
            }
            let mut statement = connection.prepare(
                "SELECT id, agent_id, content, metadata, deleted, created_at, updated_at, source_id, source_type, source_path, runtime_path, idempotency_key, memory_kind
                 FROM memories
                 WHERE COALESCE(agent_id, 'default') = ? AND deleted = 0 AND content LIKE ?
                 ORDER BY rowid DESC LIMIT 1000",
            )?;
            let rows = statement.query_map(params![agent_id, format!("%{query}%")], memory_row)?;
            Ok(serde_json::to_value(rows.collect::<Result<Vec<_>, _>>()?)?)
        }
        Operation::MemorySearch {
            agent_id,
            query,
            limit,
        } => execute_memory_search(connection, agent_id, query, limit),
        Operation::CreateSource {
            agent_id,
            workspace_id,
            kind,
            name,
            config,
            source_id,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let kind = required_id(&kind)?;
            let name = required_id(&name)?;
            let config_text = serde_json::to_string(&config)?;
            let id = source_id
                .map(|id| required_id(&id))
                .transpose()?
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let transaction = connection.transaction()?;
            if transaction
                .query_row(
                    "SELECT 1 FROM sources WHERE id=? AND agent_id=? AND workspace_id=?",
                    params![id, agent_id, workspace_id],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
                .is_some()
            {
                return Err(CoreError::InvalidInput("source id already exists".into()));
            }
            let generation: i64 = transaction.query_row("SELECT generation FROM source_tombstones WHERE agent_id=? AND workspace_id=? AND source_id=?", params![agent_id, workspace_id, id], |r| r.get(0)).optional()?.unwrap_or(0).max(0);
            transaction.execute(
                "INSERT INTO sources (id, agent_id, workspace_id, kind, name, config, generation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
                params![id, agent_id, workspace_id, kind, name, config_text, generation],
            )?;
            let source = transaction.query_row(
                "SELECT id, agent_id, workspace_id, kind, name, config, created_at FROM sources WHERE id = ? AND agent_id = ? AND workspace_id = ?",
                params![id, agent_id, workspace_id],
                source_row,
            )?;
            transaction.commit()?;
            Ok(serde_json::to_value(source)?)
        }
        Operation::ListSources {
            agent_id,
            workspace_id,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let mut statement = connection.prepare(
                "SELECT id, agent_id, workspace_id, kind, name, config, created_at FROM sources WHERE agent_id = ? AND workspace_id = ? ORDER BY rowid DESC",
            )?;
            let rows = statement.query_map(params![agent_id, workspace_id], source_row)?;
            Ok(serde_json::to_value(rows.collect::<Result<Vec<_>, _>>()?)?)
        }
        Operation::IngestDocument {
            agent_id,
            workspace_id,
            source_id,
            path,
            content,
            metadata,
        } => {
            let workspace_id = canonical_workspace(&workspace_id)?;
            let mut metadata = match metadata {
                Value::Null => json!({}),
                Value::Object(_) => metadata,
                _ => return Err(CoreError::InvalidInput("metadata must be an object".into())),
            };
            let metadata_workspace = metadata.get("_workspaceId");
            if let Some(value) = metadata_workspace {
                if !value.is_null()
                    && (!value.is_string() || !value.as_str().unwrap_or("").trim().is_empty())
                    && value.as_str().map(str::trim) != Some(workspace_id.as_str())
                {
                    return Err(CoreError::InvalidInput(
                        "metadata _workspaceId conflicts with workspace_id".into(),
                    ));
                }
            }
            metadata["_workspaceId"] = Value::String(workspace_id.clone());
            let generation = metadata.get("_generation").and_then(Value::as_i64);
            let duplicate_mode = metadata
                .get("_duplicateMode")
                .and_then(Value::as_str)
                .unwrap_or("skip")
                .to_owned();
            let agent_id = bounded_text(&agent_id, "agent id", 256)?;
            let source_id = bounded_text(&source_id, "source id", 256)?;
            let path = bounded_text(&path, "path", 4096)?;
            if content.trim().is_empty() || content.len() > 16 * 1024 * 1024 {
                return Err(CoreError::InvalidInput(
                    "content must be 1-16777216 bytes".into(),
                ));
            }
            let mode = if duplicate_mode.trim().is_empty() {
                "skip"
            } else {
                duplicate_mode.as_str()
            };
            if !matches!(mode, "skip" | "replace" | "reimport") {
                return Err(CoreError::InvalidInput(
                    "duplicateMode must be skip, replace, or reimport".into(),
                ));
            }
            let mut hash = Sha256::new();
            hash.update(content.as_bytes());
            let content_hash = format!("{:x}", hash.finalize());
            let metadata = bounded_json(&metadata)?;
            let tx = connection.transaction()?;
            if tx.query_row("SELECT 1 FROM source_removal_leases WHERE agent_id=? AND workspace_id=? AND source_id=? AND status='pending'", params![agent_id, workspace_id, source_id], |r| r.get::<_, i64>(0)).optional()?.is_some() {
                return Err(CoreError::InvalidInput("source removal pending".into()));
            }
            let source_generation: i64 = tx
                .query_row(
                    "SELECT generation FROM sources WHERE id=? AND agent_id=? AND workspace_id=?",
                    params![source_id, agent_id, workspace_id],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or(CoreError::NotFound)?;
            if generation.is_some_and(|g| g != source_generation) {
                return Err(CoreError::NotFound);
            }
            let existing: Option<(String,String)> = tx.query_row("SELECT id,content_hash FROM documents WHERE agent_id=? AND workspace_id=? AND source_id=? AND path=?", params![agent_id,workspace_id,source_id,path], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((existing_id, existing_hash)) = existing {
                if mode == "skip" {
                    return Ok(
                        json!({"id":existing_id,"status":"skipped","contentHash":existing_hash,"duplicateMode":"skip","generation":source_generation}),
                    );
                }
                if mode == "replace" {
                    tx.execute("UPDATE documents SET content=?,metadata=?,workspace_id=?,content_hash=?,updated_at=datetime('now') WHERE id=?", params![content,metadata,workspace_id,content_hash,existing_id])?;
                    tx.commit()?;
                    return Ok(
                        json!({"id":existing_id,"status":"replaced","contentHash":content_hash,"duplicateMode":"replace","generation":source_generation}),
                    );
                }
            }
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO documents (id,agent_id,workspace_id,source_id,path,content,metadata,content_hash,generation,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?, ?,datetime('now'),datetime('now'))", params![id,agent_id,workspace_id,source_id,path,content,metadata,content_hash,source_generation])?;
            tx.commit()?;
            Ok(
                json!({"id":id,"status":if mode=="reimport" {"reimported"} else {"stored"},"contentHash":content_hash,"duplicateMode":mode,"generation":source_generation}),
            )
        }
        Operation::DocumentList {
            agent_id,
            workspace_id,
            limit,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let limit = bounded_page_limit(Some(limit))? as i64;
            let mut statement = connection.prepare("SELECT id,agent_id,source_id,path,content,metadata,content_hash,generation,created_at,updated_at FROM documents WHERE agent_id=? AND workspace_id=? ORDER BY rowid DESC LIMIT ?")?;
            let rows =
                statement.query_map(params![agent_id, workspace_id, limit], document_json_row)?;
            Ok(
                json!({"items":rows.collect::<Result<Vec<_>,_>>()?,"limit":limit,"complete":true,"unsupported":{"persistentChunks":true}}),
            )
        }
        Operation::DocumentGet {
            agent_id,
            workspace_id,
            id,
        } => {
            let value = connection.query_row("SELECT id,agent_id,source_id,path,content,metadata,content_hash,generation,created_at,updated_at FROM documents WHERE id=? AND agent_id=? AND workspace_id=?", params![required_id(&id)?,required_agent(&agent_id)?,canonical_workspace(&workspace_id)?], document_json_row).optional()?;
            Ok(value.unwrap_or(Value::Null))
        }
        Operation::DocumentChunks {
            agent_id,
            workspace_id,
            id,
            limit,
        } => {
            let content: String = connection
                .query_row(
                    "SELECT content FROM documents WHERE id=? AND agent_id=? AND workspace_id=?",
                    params![
                        required_id(&id)?,
                        required_agent(&agent_id)?,
                        canonical_workspace(&workspace_id)?
                    ],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or(CoreError::NotFound)?;
            let limit = limit.clamp(1, 100);
            let items = content.as_bytes().chunks(4096).take(limit).enumerate().map(|(index, bytes)| json!({"index":index,"content":String::from_utf8_lossy(bytes)})).collect::<Vec<_>>();
            Ok(
                json!({"items":items,"limit":limit,"complete":true,"unsupported":{"persistentChunks":true}}),
            )
        }
        Operation::DocumentDelete {
            agent_id,
            workspace_id,
            id,
        } => {
            let changed = connection.execute(
                "DELETE FROM documents WHERE id=? AND agent_id=? AND workspace_id=?",
                params![
                    required_id(&id)?,
                    required_agent(&agent_id)?,
                    canonical_workspace(&workspace_id)?
                ],
            )?;
            Ok(json!({"id":id,"status":"deleted","deleted":changed > 0,"idempotent":true}))
        }
        Operation::DeleteSource {
            agent_id,
            workspace_id,
            source_id,
        } => {
            let workspace_id = canonical_workspace(&workspace_id)?;
            let generation: Option<i64> = None;
            let tx = connection.transaction()?;
            let current: Option<i64> = tx
                .query_row(
                    "SELECT generation FROM sources WHERE agent_id=? AND workspace_id=? AND id=?",
                    params![agent_id, workspace_id, source_id],
                    |r| r.get(0),
                )
                .optional()?;
            let current = current.ok_or(CoreError::NotFound)?;
            if generation.is_some_and(|g| g != current) {
                return Err(CoreError::NotFound);
            }
            if tx.query_row("SELECT 1 FROM source_removal_leases WHERE agent_id=? AND workspace_id=? AND source_id=? AND status='pending'", params![agent_id, workspace_id, source_id], |r| r.get::<_, i64>(0)).optional()?.is_some() {
                return Err(CoreError::InvalidInput("source removal pending".into()));
            }
            let changed = tx.execute(
                "DELETE FROM documents WHERE agent_id=? AND source_id=? AND workspace_id=?",
                params![agent_id, source_id, workspace_id],
            )?;
            tx.execute("INSERT INTO source_tombstones(agent_id,workspace_id,source_id,generation,deleted_at) VALUES(?,?,?,?,datetime('now')) ON CONFLICT(agent_id,workspace_id,source_id) DO UPDATE SET generation=excluded.generation,deleted_at=excluded.deleted_at", params![agent_id,workspace_id,source_id,current+1])?;
            tx.execute(
                "DELETE FROM sources WHERE agent_id=? AND workspace_id=? AND id=?",
                params![agent_id, workspace_id, source_id],
            )?;
            tx.commit()?;
            Ok(json!({"deleted":true,"documentsDeleted":changed,"generation":current+1}))
        }
        Operation::DeleteSourceWithGeneration {
            agent_id,
            workspace_id,
            source_id,
            generation,
        } => {
            let workspace_id = canonical_workspace(&workspace_id)?;
            let tx = connection.transaction()?;
            let current: Option<i64> = tx
                .query_row(
                    "SELECT generation FROM sources WHERE agent_id=? AND workspace_id=? AND id=?",
                    params![agent_id, workspace_id, source_id],
                    |r| r.get(0),
                )
                .optional()?;
            let current = current.ok_or(CoreError::NotFound)?;
            if generation.is_some_and(|g| g != current) {
                return Err(CoreError::NotFound);
            }
            if tx.query_row("SELECT 1 FROM source_removal_leases WHERE agent_id=? AND workspace_id=? AND source_id=? AND status='pending'", params![agent_id, workspace_id, source_id], |r| r.get::<_, i64>(0)).optional()?.is_some() {
                return Err(CoreError::InvalidInput("source removal pending".into()));
            }
            let changed = tx.execute(
                "DELETE FROM documents WHERE agent_id=? AND source_id=? AND workspace_id=?",
                params![agent_id, source_id, workspace_id],
            )?;
            tx.execute("INSERT INTO source_tombstones(agent_id,workspace_id,source_id,generation,deleted_at) VALUES(?,?,?,?,datetime('now')) ON CONFLICT(agent_id,workspace_id,source_id) DO UPDATE SET generation=excluded.generation,deleted_at=excluded.deleted_at", params![agent_id,workspace_id,source_id,current+1])?;
            tx.execute(
                "DELETE FROM sources WHERE agent_id=? AND workspace_id=? AND id=?",
                params![agent_id, workspace_id, source_id],
            )?;
            tx.commit()?;
            Ok(json!({"deleted":true,"documentsDeleted":changed,"generation":current+1}))
        }
        Operation::AcquireSourceRemovalLease {
            agent_id,
            workspace_id,
            source_id,
            generation,
        } => {
            let workspace_id = canonical_workspace(&workspace_id)?;
            let tx = connection.transaction()?;
            let current: i64 = tx
                .query_row(
                    "SELECT generation FROM sources WHERE agent_id=? AND workspace_id=? AND id=?",
                    params![agent_id, workspace_id, source_id],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or(CoreError::NotFound)?;
            if generation.is_some_and(|g| g != current) {
                return Err(CoreError::NotFound);
            }
            if tx.query_row("SELECT 1 FROM source_removal_leases WHERE agent_id=? AND workspace_id=? AND source_id=? AND status='pending'", params![agent_id,workspace_id,source_id], |r| r.get::<_,i64>(0)).optional()?.is_some() { return Err(CoreError::InvalidInput("source removal already pending".into())); }
            let token = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO source_removal_leases(agent_id,workspace_id,source_id,generation,lease_token,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',datetime('now'),datetime('now'))", params![agent_id,workspace_id,source_id,current,token])?;
            tx.commit()?;
            Ok(
                json!({"status":"pending","outcome":"retryable","leaseToken":token,"generation":current}),
            )
        }
        Operation::FinalizeSourceRemoval {
            agent_id,
            workspace_id,
            source_id,
            generation,
            lease_token,
        } => {
            let workspace_id = canonical_workspace(&workspace_id)?;
            let tx = connection.transaction()?;
            let valid: Option<i64> = tx.query_row("SELECT generation FROM source_removal_leases WHERE agent_id=? AND workspace_id=? AND source_id=? AND generation=? AND lease_token=? AND status='pending'", params![agent_id,workspace_id,source_id,generation,lease_token], |r| r.get(0)).optional()?;
            if valid.is_none() {
                return Err(CoreError::NotFound);
            }
            let changed = tx.execute("DELETE FROM documents WHERE agent_id=? AND workspace_id=? AND source_id=? AND generation=?", params![agent_id,workspace_id,source_id,generation])?;
            tx.execute("INSERT INTO source_tombstones(agent_id,workspace_id,source_id,generation,deleted_at) VALUES(?,?,?,?,datetime('now')) ON CONFLICT(agent_id,workspace_id,source_id) DO UPDATE SET generation=excluded.generation,deleted_at=excluded.deleted_at", params![agent_id,workspace_id,source_id,generation+1])?;
            tx.execute(
                "DELETE FROM sources WHERE agent_id=? AND workspace_id=? AND id=? AND generation=?",
                params![agent_id, workspace_id, source_id, generation],
            )?;
            tx.execute("UPDATE source_removal_leases SET status='completed',updated_at=datetime('now') WHERE agent_id=? AND workspace_id=? AND source_id=? AND lease_token=?", params![agent_id,workspace_id,source_id,lease_token])?;
            tx.commit()?;
            Ok(
                json!({"outcome":"success","deleted":true,"documentsDeleted":changed,"generation":generation+1}),
            )
        }
        Operation::SourceHealth {
            agent_id,
            workspace_id,
            source_id,
        } => {
            let workspace_id = canonical_workspace(&workspace_id)?;
            let exists: Option<i64> = connection
                .query_row(
                    "SELECT 1 FROM sources WHERE agent_id = ? AND workspace_id = ? AND id = ?",
                    params![agent_id, workspace_id, source_id],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Err(CoreError::NotFound);
            }
            let documents: i64 = connection.query_row(
                "SELECT count(*) FROM documents WHERE agent_id = ? AND source_id = ? AND workspace_id = ?",
                params![agent_id, source_id, workspace_id],
                |r| r.get(0),
            )?;
            Ok(
                json!({"status":"ready", "database":"ready", "source":"present", "documents":documents, "externalProvider":"not_checked"}),
            )
        }
        Operation::OntologyList {
            agent_id,
            workspace_id,
            kind,
            limit,
            cursor,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let kind = required_id(&kind)?;
            let limit = bounded_page_limit(limit)?;
            let cursor = parse_cursor(cursor)?;
            let mut s = connection.prepare("SELECT id, value, created_at, updated_at, rowid FROM ontology_records WHERE agent_id=? AND workspace_id=? AND kind=? AND deleted=0 AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?")?;
            let mut rows = s.query(params![
                agent_id,
                workspace_id,
                kind,
                cursor,
                cursor,
                (limit + 1) as i64
            ])?;
            let mut items = Vec::with_capacity(limit);
            let mut next_cursor = None;
            let mut last_rowid = None;
            while let Some(r) = rows.next()? {
                let rowid: i64 = r.get(4)?;
                let item = json!({"id":r.get::<_,String>(0)?,"value":serde_json::from_str::<Value>(&r.get::<_,String>(1)?).unwrap_or(json!({})),"createdAt":r.get::<_,String>(2)?,"updatedAt":r.get::<_,String>(3)?});
                if items.len() == limit {
                    next_cursor = last_rowid.map(|value: i64| value.to_string());
                    break;
                }
                items.push(item);
                last_rowid = Some(rowid);
            }
            Ok(
                json!({"items": items, "nextCursor": next_cursor, "complete": next_cursor.is_none()}),
            )
        }
        Operation::OntologyGet {
            agent_id,
            workspace_id,
            kind,
            id,
        } => {
            let row = connection.query_row("SELECT id,value,created_at,updated_at FROM ontology_records WHERE agent_id=? AND workspace_id=? AND kind=? AND id=? AND deleted=0", params![required_agent(&agent_id)?,required_id(&workspace_id)?,required_id(&kind)?,required_id(&id)?], |r| Ok(json!({"id":r.get::<_,String>(0)?,"value":serde_json::from_str::<Value>(&r.get::<_,String>(1)?).unwrap_or(json!({})),"createdAt":r.get::<_,String>(2)?,"updatedAt":r.get::<_,String>(3)?}))).optional()?;
            Ok(row.unwrap_or(Value::Null))
        }
        Operation::OntologyUpsert {
            agent_id,
            workspace_id,
            kind,
            id,
            value,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let kind = required_id(&kind)?;
            let id = id
                .map(|v| required_id(&v))
                .transpose()?
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let text = serde_json::to_string(&value)?;
            let tx = connection.transaction()?;
            let existing: Option<(String, String, String)> = tx
                .query_row(
                    "SELECT agent_id,workspace_id,kind FROM ontology_records WHERE id=?",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if let Some((existing_agent, existing_workspace, existing_kind)) = existing {
                if existing_agent != agent_id
                    || existing_workspace != workspace_id
                    || existing_kind != kind
                {
                    return Err(CoreError::InvalidInput(
                        "ontology record belongs to another scope".into(),
                    ));
                }
            }
            tx.execute("INSERT INTO ontology_records(id,agent_id,workspace_id,kind,value,deleted,created_at,updated_at) VALUES(?,?,?,?,?,0,datetime('now'),datetime('now')) ON CONFLICT(id) DO UPDATE SET value=excluded.value, updated_at=datetime('now'), deleted=0",params![id,agent_id,workspace_id,kind,text])?;
            tx.commit()?;
            Ok(json!({"id":id,"value":value}))
        }
        Operation::OntologyDelete {
            agent_id,
            workspace_id,
            kind,
            id,
        } => {
            let tx = connection.transaction()?;
            let n=tx.execute("UPDATE ontology_records SET deleted=1,updated_at=datetime('now') WHERE agent_id=? AND workspace_id=? AND kind=? AND id=? AND deleted=0",params![required_agent(&agent_id)?,required_id(&workspace_id)?,required_id(&kind)?,required_id(&id)?])?;
            if n == 0 {
                return Err(CoreError::NotFound);
            }
            tx.commit()?;
            Ok(json!({"deleted":true,"id":id}))
        }
        Operation::KnowledgeSessionExpand {
            agent_id,
            workspace_id,
            project_id,
            entity_name,
            session_id,
            time_range,
            max_results,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let entity_name = bounded_text(&entity_name, "entity name", 256)?;
            if entity_name.trim().is_empty() {
                return Err(CoreError::InvalidInput("entityName is required".into()));
            }
            let canonical = canonical_key(&entity_name);
            let entity: Option<(String, String)> = connection.query_row(
                "SELECT id,name FROM entities WHERE agent_id=? AND workspace_id=? AND COALESCE(status,'active')='active' AND (LOWER(COALESCE(canonical_name,name))=? OR LOWER(name)=?) ORDER BY CASE WHEN LOWER(COALESCE(canonical_name,name))=? THEN 0 ELSE 1 END, mentions DESC, updated_at DESC LIMIT 1",
                params![agent_id, workspace_id, canonical, canonical, canonical],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ).optional()?;
            let Some((entity_id, resolved_name)) = entity else {
                return Ok(json!({"entityName": entity_name, "summaries": [], "total": 0}));
            };
            let max_results = max_results.clamp(1, 50) as i64;
            let mut conditions = vec![
                "ss.agent_id=?".to_owned(),
                "ss.kind='session'".to_owned(),
                "COALESCE(ss.source_type,'summary')='summary'".to_owned(),
            ];
            let mut args: Vec<SqlValue> = vec![agent_id.clone().into()];
            if let Some(project) = project_id.filter(|v| !v.trim().is_empty()) {
                conditions.push("ss.project=?".into());
                args.push(project.into());
            }
            if let Some(session) = session_id.filter(|v| !v.trim().is_empty()) {
                conditions.push("ss.session_key=?".into());
                args.push(session.into());
            }
            if time_range.as_deref() == Some("last_week") {
                conditions.push("ss.latest_at >= datetime('now','-7 days')".into());
            } else if time_range.as_deref() == Some("last_month") {
                conditions.push("ss.latest_at >= datetime('now','-30 days')".into());
            } else if let Some(range) = time_range.filter(|v| !v.trim().is_empty()) {
                conditions.push("ss.latest_at >= ?".into());
                args.push(range.into());
            }
            let text = format!("% {} %", canonical.replace('%', "\\%"));
            // Keep the historical query order and LIMIT semantics: select the bounded
            // session projection first, then apply content safety to that projection.
            let has_safety = if connection
                .query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_content_safety'", [], |_| Ok(1))
                .optional()?.is_some()
            {
                true
            } else { false };
            let sql = format!("SELECT DISTINCT ss.id,ss.content,ss.session_key,ss.harness,ss.earliest_at,ss.latest_at FROM session_summaries ss WHERE {} AND (EXISTS (SELECT 1 FROM session_summary_memories ssm JOIN memory_entity_mentions mem ON mem.memory_id=ssm.memory_id WHERE ssm.summary_id=ss.id AND mem.entity_id=?) OR LOWER(' '||replace(replace(replace(ss.content,'.',' '),',',' '),'-',' ')||' ') LIKE ? ESCAPE '\\\\') ORDER BY ss.latest_at DESC LIMIT ?", conditions.join(" AND "));
            args.push(entity_id.into());
            args.push(text.into());
            args.push(max_results.into());
            let mut stmt = connection.prepare(&sql)?;
            let rows: Vec<Value> = stmt
                .query_map(rusqlite::params_from_iter(args), |r| Ok(json!({"id":r.get::<_,String>(0)?,"sessionKey":r.get::<_,Option<String>>(2)?,"harness":r.get::<_,Option<String>>(3)?,"earliestAt":r.get::<_,String>(4)?,"latestAt":r.get::<_,String>(5)?,"content":r.get::<_,String>(1)?})))?
                .filter_map(|row| row.ok())
                .collect();
            drop(stmt);
            let summaries: Vec<Value> = rows
                .into_iter()
                .filter(|summary| {
                    let content_ok = summary.get("content").and_then(Value::as_str).is_none_or(memory_content_context_eligible);
                    let ledger_ok = !has_safety || connection.query_row("SELECT 1 FROM memory_content_safety WHERE agent_id=? AND source_kind='summary' AND source_id=? AND status='clean' AND context_eligible=1", params![agent_id, summary["id"].as_str().unwrap_or("")], |_| Ok(1)).optional().ok().flatten().is_some();
                    content_ok && ledger_ok
                })
                .collect();
            Ok(
                json!({"entityName": resolved_name, "summaries": summaries, "total": summaries.len()}),
            )
        }
        Operation::KnowledgeNavigationEntity {
            agent_id,
            workspace_id,
            name,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let name = bounded_text(&name, "entity name", 256)?;
            let canonical = name
                .trim()
                .to_lowercase()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if canonical.is_empty() {
                return Err(CoreError::InvalidInput("entity name is required".into()));
            }
            let escaped = canonical
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let starts = format!("{escaped}%");
            let contains = format!("%{escaped}%");
            let row: Option<Value> = connection
                .query_row(
                    "SELECT id,name,canonical_name,entity_type,description,mentions,pinned,pinned_at,status,archived_at,archived_by,archive_reason,proposal_id,proposal_evidence,created_at,updated_at FROM entities WHERE agent_id=? AND workspace_id=? AND COALESCE(status,'active')='active' AND (COALESCE(canonical_name,LOWER(name))=? OR LOWER(name)=? OR COALESCE(canonical_name,LOWER(name)) LIKE ? ESCAPE '\\' OR LOWER(name) LIKE ? ESCAPE '\\' OR COALESCE(canonical_name,LOWER(name)) LIKE ? ESCAPE '\\' OR LOWER(name) LIKE ? ESCAPE '\\') ORDER BY CASE WHEN COALESCE(canonical_name,LOWER(name))=? THEN 0 WHEN LOWER(name)=? THEN 1 WHEN COALESCE(canonical_name,LOWER(name)) LIKE ? ESCAPE '\\' THEN 2 WHEN LOWER(name) LIKE ? ESCAPE '\\' THEN 3 WHEN COALESCE(canonical_name,LOWER(name)) LIKE ? ESCAPE '\\' THEN 4 ELSE 5 END, mentions DESC, updated_at DESC, name ASC LIMIT 1",
                    params![agent_id, workspace_id, canonical, canonical, starts, starts, contains, contains, canonical, canonical, starts, starts, contains],
                    |r| {
                        let evidence: String = r.get(13)?;
                        Ok(json!({"entity":{"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"canonicalName":r.get::<_,Option<String>>(2)?,"entityType":r.get::<_,String>(3)?,"description":r.get::<_,Option<String>>(4)?,"mentions":r.get::<_,Option<i64>>(5)?,"pinned":r.get::<_,i64>(6)? != 0,"pinnedAt":r.get::<_,Option<String>>(7)?,"status":r.get::<_,Option<String>>(8)?.unwrap_or_else(|| "active".into()),"archivedAt":r.get::<_,Option<String>>(9)?,"archivedBy":r.get::<_,Option<String>>(10)?,"archiveReason":r.get::<_,Option<String>>(11)?,"proposalId":r.get::<_,Option<String>>(12)?,"proposalEvidence":serde_json::from_str::<Value>(&evidence).unwrap_or(json!([])),"agentId":agent_id,"createdAt":r.get::<_,String>(14)?,"updatedAt":r.get::<_,String>(15)?},"aspectCount":connection.query_row("SELECT count(*) FROM entity_aspects WHERE entity_id=? AND agent_id=? AND workspace_id=? AND COALESCE(status,'active')='active'",params![r.get::<_,String>(0)?,agent_id,workspace_id],|x|x.get::<_,i64>(0))?,"attributeCount":connection.query_row("SELECT count(*) FROM entity_attributes a JOIN entity_aspects p ON p.id=a.aspect_id WHERE p.entity_id=? AND a.agent_id=? AND a.workspace_id=? AND COALESCE(a.status,'active')='active' AND a.kind='attribute'",params![r.get::<_,String>(0)?,agent_id,workspace_id],|x|x.get::<_,i64>(0))?,"constraintCount":connection.query_row("SELECT count(*) FROM entity_attributes a JOIN entity_aspects p ON p.id=a.aspect_id WHERE p.entity_id=? AND a.agent_id=? AND a.workspace_id=? AND COALESCE(a.status,'active')='active' AND a.kind='constraint'",params![r.get::<_,String>(0)?,agent_id,workspace_id],|x|x.get::<_,i64>(0))?,"dependencyCount":connection.query_row("SELECT count(*) FROM entity_dependencies WHERE (source_entity_id=? OR target_entity_id=?) AND agent_id=? AND workspace_id=? AND COALESCE(status,'active')='active'",params![r.get::<_,String>(0)?,r.get::<_,String>(0)?,agent_id,workspace_id],|x|x.get::<_,i64>(0))?,"structuralDensity":0,"incomingDependencyCount":0,"outgoingDependencyCount":0}))
                    },
                )
                .optional()?;
            row.ok_or(CoreError::NotFound)
        }
        Operation::KnowledgeEntityCreate {
            agent_id,
            workspace_id,
            name,
            entity_type,
            metadata,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let name = bounded_text(&name, "entity name", 256)?;
            let entity_type = bounded_text(&entity_type, "entity type", 64)?;
            let metadata = bounded_json(&metadata)?;
            let id = uuid::Uuid::new_v4().to_string();
            let tx = connection.transaction()?;
            let canonical_name = canonical_key(&name);
            let description = serde_json::from_str::<Value>(&metadata).ok().and_then(|v| {
                v.get("description")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            tx.execute("INSERT INTO entities(id,agent_id,workspace_id,name,canonical_name,entity_type,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'active',datetime('now'),datetime('now'))",params![id,agent_id,workspace_id,name,canonical_name,entity_type,description])?;
            tx.execute("INSERT INTO kg_entities(id,agent_id,workspace_id,name,entity_type,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,datetime('now'),datetime('now'))",params![id,agent_id,workspace_id,name,entity_type,metadata])?;
            tx.commit()?;
            Ok(json!({"id":id,"agentId":agent_id,"name":name,"type":entity_type}))
        }
        Operation::KnowledgePinnedEntities {
            agent_id,
            workspace_id,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let mut statement = connection.prepare("SELECT id,name,pinned_at FROM entities WHERE agent_id=? AND workspace_id=? AND pinned=1 AND COALESCE(status,'active')='active' ORDER BY pinned_at DESC, updated_at DESC, name ASC")?;
            let rows = statement.query_map(params![agent_id, workspace_id], |r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"pinnedAt":r.get::<_,Option<String>>(2)?.unwrap_or_default()})))?;
            Ok(json!(rows.collect::<Result<Vec<_>, _>>()?))
        }
        Operation::KnowledgeEntityPin {
            agent_id,
            workspace_id,
            entity_id,
            actor,
        } => pin_entity(
            connection,
            &agent_id,
            &workspace_id,
            &entity_id,
            &actor,
            true,
        ),
        Operation::KnowledgeEntityUnpin {
            agent_id,
            workspace_id,
            entity_id,
            actor,
        } => pin_entity(
            connection,
            &agent_id,
            &workspace_id,
            &entity_id,
            &actor,
            false,
        ),
        Operation::KnowledgeEntityList {
            agent_id,
            workspace_id,
            limit,
            offset,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let limit = limit.clamp(1, 200) as i64;
            let offset = offset.min(100_000) as i64;
            let mut s=connection.prepare("SELECT id,name,entity_type,metadata,created_at,updated_at FROM kg_entities WHERE agent_id=? AND workspace_id=? AND deleted=0 ORDER BY rowid DESC LIMIT ? OFFSET ?")?;
            let rows=s.query_map(params![agent_id,workspace_id,limit,offset],|r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"type":r.get::<_,String>(2)?,"metadata":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(json!({})),"createdAt":r.get::<_,String>(4)?,"updatedAt":r.get::<_,String>(5)?})))?;
            Ok(json!({"items":rows.collect::<Result<Vec<_>,_>>()?,"limit":limit,"offset":offset}))
        }
        Operation::KnowledgeRelationCreate {
            agent_id,
            workspace_id,
            from_id,
            to_id,
            relation,
            metadata,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let from_id = required_id(&from_id)?;
            let to_id = required_id(&to_id)?;
            let relation = bounded_text(&relation, "relation", 128)?;
            let metadata = bounded_json(&metadata)?;
            if from_id == to_id {
                return Err(CoreError::InvalidInput(
                    "relation endpoints must differ".into(),
                ));
            }
            let tx = connection.transaction()?;
            let count: i64 = tx.query_row(
                "SELECT count(*) FROM kg_entities WHERE agent_id=? AND workspace_id=? AND deleted=0 AND id IN (?,?)",
                params![agent_id, workspace_id, from_id, to_id],
                |r| r.get(0),
            )?;
            if count != 2 {
                return Err(CoreError::NotFound);
            }
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO kg_relations(id,agent_id,workspace_id,from_id,to_id,relation,metadata,created_at) VALUES(?,?,?,?,?,?,?,datetime('now'))",params![id,agent_id,workspace_id,from_id,to_id,relation,metadata])?;
            tx.commit()?;
            Ok(json!({"id":id,"fromId":from_id,"toId":to_id,"relation":relation}))
        }
        Operation::KnowledgeRelations {
            agent_id,
            workspace_id,
            entity_id,
            limit,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let entity_id = required_id(&entity_id)?;
            let limit = limit.clamp(1, 200) as i64;
            let mut s=connection.prepare("SELECT id,from_id,to_id,relation,metadata,created_at FROM kg_relations WHERE agent_id=? AND workspace_id=? AND deleted=0 AND (from_id=? OR to_id=?) ORDER BY rowid DESC LIMIT ?")?;
            let rows=s.query_map(params![agent_id,workspace_id,entity_id,entity_id,limit],|r| Ok(json!({"id":r.get::<_,String>(0)?,"fromId":r.get::<_,String>(1)?,"toId":r.get::<_,String>(2)?,"relation":r.get::<_,String>(3)?,"metadata":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(json!({})),"createdAt":r.get::<_,String>(5)?})))?;
            Ok(json!({"items":rows.collect::<Result<Vec<_>,_>>()?}))
        }
        Operation::KnowledgeDependencies {
            agent_id,
            workspace_id,
            entity_id,
            limit,
            direction,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let entity_id = required_id(&entity_id)?;
            let limit = limit.clamp(1, 200) as i64;
            let direction = if matches!(direction.as_str(), "incoming" | "outgoing") {
                direction.as_str()
            } else {
                "both"
            };
            let entity_exists: i64 = connection.query_row("SELECT count(*) FROM entities WHERE id=? AND agent_id=? AND workspace_id=? AND COALESCE(status,'active')='active'", params![entity_id, agent_id, workspace_id], |r| r.get(0))?;
            if entity_exists != 1 {
                return Err(CoreError::NotFound);
            }
            let clause = match direction {
                "incoming" => "dep.target_entity_id=?",
                "outgoing" => "dep.source_entity_id=?",
                _ => "(dep.source_entity_id=? OR dep.target_entity_id=?)",
            };
            let sql = format!("SELECT dep.id,dep.source_entity_id,dep.target_entity_id,dep.dependency_type,dep.strength,dep.aspect_id,dep.reason,dep.status,dep.updated_at,src.name,dst.name FROM entity_dependencies dep JOIN entities src ON src.id=dep.source_entity_id AND src.agent_id=dep.agent_id AND src.workspace_id=dep.workspace_id AND COALESCE(src.status,'active')='active' JOIN entities dst ON dst.id=dep.target_entity_id AND dst.agent_id=dep.agent_id AND dst.workspace_id=dep.workspace_id AND COALESCE(dst.status,'active')='active' WHERE dep.agent_id=? AND dep.workspace_id=? AND COALESCE(dep.status,'active')='active' AND {} ORDER BY dep.strength DESC, dep.updated_at DESC LIMIT ?", clause);
            let mut stmt = connection.prepare(&sql)?;
            let map = |r: &rusqlite::Row<'_>| {
                let source: String = r.get(1)?;
                Ok(
                    json!({"id":r.get::<_,String>(0)?,"direction":if direction == "incoming" {"incoming"} else if direction == "outgoing" {"outgoing"} else if source == entity_id {"outgoing"} else {"incoming"},"dependencyType":r.get::<_,String>(3)?,"strength":r.get::<_,f64>(4)?,"aspectId":r.get::<_,Option<String>>(5)?,"reason":r.get::<_,Option<String>>(6)?,"status":r.get::<_,String>(7)?,"sourceEntityId":source,"sourceEntityName":r.get::<_,String>(9)?,"targetEntityId":r.get::<_,String>(2)?,"targetEntityName":r.get::<_,String>(10)?,"updatedAt":r.get::<_,String>(8)?}),
                )
            };
            let rows = if direction == "both" {
                stmt.query_map(
                    params![agent_id, workspace_id, entity_id, entity_id, limit],
                    map,
                )?
            } else {
                stmt.query_map(params![agent_id, workspace_id, entity_id, limit], map)?
            };
            Ok(json!({"items":rows.collect::<Result<Vec<_>,_>>()?,"limit":limit}))
        }
        Operation::KnowledgeAspectCreate {
            agent_id,
            workspace_id,
            entity_id,
            name,
            weight,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let entity_id = required_id(&entity_id)?;
            let name = bounded_text(&name, "aspect name", 256)?;
            let weight = weight.clamp(0.0, 1.0);
            let tx = connection.transaction()?;
            let entity_ok: i64 = tx.query_row("SELECT count(*) FROM entities WHERE id=? AND agent_id=? AND workspace_id=? AND COALESCE(status,'active')='active'", params![entity_id, agent_id, workspace_id], |r| r.get(0))?;
            if entity_ok != 1 {
                return Err(CoreError::NotFound);
            }
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO entity_aspects(id,agent_id,workspace_id,entity_id,name,canonical_name,weight,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'active',datetime('now'),datetime('now'))", params![id,agent_id,workspace_id,entity_id,name,canonical_key(&name),weight])?;
            tx.execute("INSERT INTO kg_aspects(id,agent_id,workspace_id,entity_id,name,canonical_name,weight,created_at,updated_at) VALUES(?,?,?,?,?,?,?,datetime('now'),datetime('now'))", params![id,agent_id,workspace_id,entity_id,name,canonical_key(&name),weight])?;
            tx.commit()?;
            Ok(json!({"id":id,"entityId":entity_id,"name":name,"weight":weight}))
        }
        Operation::KnowledgeAttributeCreate {
            agent_id,
            workspace_id,
            aspect_id,
            kind,
            content,
            claim_key,
            group_key,
            confidence,
            importance,
            memory_id,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let aspect_id = required_id(&aspect_id)?;
            let kind = bounded_text(&kind, "attribute kind", 64)?;
            let content = bounded_text(&content, "attribute content", 4096)?;
            let tx = connection.transaction()?;
            let ok: i64 = tx.query_row(
                "SELECT count(*) FROM entity_aspects WHERE id=? AND agent_id=? AND workspace_id=? AND COALESCE(status,'active')='active'",
                params![aspect_id, agent_id, workspace_id],
                |r| r.get(0),
            )?;
            if ok != 1 {
                return Err(CoreError::NotFound);
            }
            if let Some(ref mid) = memory_id {
                let n: i64 = tx.query_row(
                    "SELECT count(*) FROM memories WHERE id=? AND agent_id=? AND deleted=0",
                    params![mid, agent_id],
                    |r| r.get(0),
                )?;
                if n != 1 {
                    return Err(CoreError::NotFound);
                }
            }
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO entity_attributes(id,agent_id,workspace_id,aspect_id,memory_id,kind,content,normalized_content,claim_key,group_key,confidence,importance,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'active',datetime('now'),datetime('now'))",params![id,agent_id,workspace_id,aspect_id,memory_id,kind,content,content.to_lowercase(),claim_key,group_key,confidence.clamp(0.0,1.0),importance.clamp(0.0,1.0)])?;
            tx.execute("INSERT INTO kg_attributes(id,agent_id,workspace_id,aspect_id,memory_id,kind,content,normalized_content,claim_key,group_key,confidence,importance,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'active',datetime('now'),datetime('now'))",params![id,agent_id,workspace_id,aspect_id,memory_id,kind,content,content.to_lowercase(),claim_key,group_key,confidence.clamp(0.0,1.0),importance.clamp(0.0,1.0)])?;
            tx.commit()?;
            Ok(
                json!({"id":id,"aspectId":aspect_id,"kind":kind,"content":content,"status":"active"}),
            )
        }
        Operation::KnowledgeStats {
            agent_id,
            workspace_id,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let scoped = |sql: &str| -> Result<i64, CoreError> {
                Ok(connection.query_row(sql, params![&agent_id, &workspace_id], |r| r.get(0))?)
            };
            let agent_only = |sql: &str| -> Result<i64, CoreError> {
                Ok(connection.query_row(sql, params![&agent_id], |r| r.get(0))?)
            };
            let entity_count = scoped(
                "SELECT count(*) FROM kg_entities WHERE agent_id=? AND workspace_id=? AND deleted=0",
            )?;
            let aspect_count = scoped(
                "SELECT count(*) FROM kg_aspects a JOIN kg_entities e ON e.id=a.entity_id AND e.agent_id=a.agent_id AND e.workspace_id=a.workspace_id AND e.deleted=0 WHERE a.agent_id=? AND a.workspace_id=? AND a.deleted=0",
            )?;
            let attribute_count = scoped(
                "SELECT count(*) FROM kg_attributes a JOIN kg_aspects p ON p.id=a.aspect_id AND p.agent_id=a.agent_id AND p.workspace_id=a.workspace_id AND p.deleted=0 JOIN kg_entities e ON e.id=p.entity_id AND e.agent_id=p.agent_id AND e.workspace_id=p.workspace_id AND e.deleted=0 WHERE a.agent_id=? AND a.workspace_id=? AND a.kind='attribute' AND a.status='active'",
            )?;
            let constraint_count = scoped(
                "SELECT count(*) FROM kg_attributes a JOIN kg_aspects p ON p.id=a.aspect_id AND p.agent_id=a.agent_id AND p.workspace_id=a.workspace_id AND p.deleted=0 JOIN kg_entities e ON e.id=p.entity_id AND e.agent_id=p.agent_id AND e.workspace_id=p.workspace_id AND e.deleted=0 WHERE a.agent_id=? AND a.workspace_id=? AND a.kind='constraint' AND a.status='active'",
            )?;
            let dependency_count = 0_i64;
            let scoped_memory_count = agent_only(
                "SELECT count(*) FROM memories WHERE agent_id=? AND deleted=0 AND superseded_by IS NULL",
            )?;
            let assigned_memory_count = scoped(
                "SELECT count(DISTINCT a.memory_id) FROM kg_attributes a JOIN kg_aspects p ON p.id=a.aspect_id AND p.agent_id=a.agent_id AND p.workspace_id=a.workspace_id AND p.deleted=0 JOIN kg_entities e ON e.id=p.entity_id AND e.agent_id=p.agent_id AND e.workspace_id=p.workspace_id AND e.deleted=0 WHERE a.agent_id=? AND a.workspace_id=? AND a.status='active' AND a.memory_id IS NOT NULL",
            )?;
            let unassigned_memory_count = (scoped_memory_count - assigned_memory_count).max(0);
            let coverage_percent = if scoped_memory_count > 0 {
                ((assigned_memory_count as f64 / scoped_memory_count as f64) * 1000.0).round()
                    / 10.0
            } else {
                0.0
            };
            let feedback_updated_aspect_count: i64 = connection.query_row(
                "SELECT count(*) FROM kg_aspects a JOIN kg_entities e ON e.id=a.entity_id AND e.agent_id=a.agent_id AND e.workspace_id=a.workspace_id AND e.deleted=0 WHERE a.agent_id=? AND a.workspace_id=? AND a.deleted=0 AND a.updated_at >= datetime('now','-7 days')",
                params![&agent_id, &workspace_id],
                |r| r.get(0),
            )?;
            let average_aspect_weight: f64 = connection.query_row(
                "SELECT coalesce(avg(a.weight),0) FROM kg_aspects a JOIN kg_entities e ON e.id=a.entity_id AND e.agent_id=a.agent_id AND e.workspace_id=a.workspace_id AND e.deleted=0 WHERE a.agent_id=? AND a.workspace_id=? AND a.deleted=0",
                params![&agent_id, &workspace_id],
                |r| r.get(0),
            )?;
            let max_weight_aspect_count: i64 = connection.query_row(
                "SELECT count(*) FROM kg_aspects a JOIN kg_entities e ON e.id=a.entity_id AND e.agent_id=a.agent_id AND e.workspace_id=a.workspace_id AND e.deleted=0 WHERE a.agent_id=? AND a.workspace_id=? AND a.deleted=0 AND a.weight >= 1.0",
                params![&agent_id, &workspace_id],
                |r| r.get(0),
            )?;
            let min_weight_aspect_count: i64 = connection.query_row(
                "SELECT count(*) FROM kg_aspects a JOIN kg_entities e ON e.id=a.entity_id AND e.agent_id=a.agent_id AND e.workspace_id=a.workspace_id AND e.deleted=0 WHERE a.agent_id=? AND a.workspace_id=? AND a.deleted=0 AND a.weight <= 0.1",
                params![&agent_id, &workspace_id],
                |r| r.get(0),
            )?;
            Ok(json!({
                "entityCount": entity_count,
                "aspectCount": aspect_count,
                "attributeCount": attribute_count,
                "constraintCount": constraint_count,
                "dependencyCount": dependency_count,
                "unassignedMemoryCount": unassigned_memory_count,
                "coveragePercent": coverage_percent,
                "feedbackUpdatedAspectCount": feedback_updated_aspect_count,
                "averageAspectWeight": (average_aspect_weight * 1000.0).round() / 1000.0,
                "maxWeightAspectCount": max_weight_aspect_count,
                "minWeightAspectCount": min_weight_aspect_count,
            }))
        }
        Operation::KnowledgeConstellation {
            agent_id,
            workspace_id,
            limit,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let limit = limit.clamp(1, 1000) as i64;
            let mut s = connection.prepare("SELECT id,name,entity_type,metadata FROM kg_entities WHERE agent_id=? AND workspace_id=? AND deleted=0 ORDER BY rowid DESC LIMIT ?")?;
            let rows = s.query_map(params![&agent_id, &workspace_id, limit], |r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"type":r.get::<_,String>(2)?,"metadata":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(json!({}))})))?;
            let entities = rows.collect::<Result<Vec<_>, _>>()?;
            let mut s = connection.prepare("SELECT id,from_id,to_id,relation,metadata FROM kg_relations WHERE agent_id=? AND workspace_id=? AND deleted=0 ORDER BY rowid DESC LIMIT ?")?;
            let rows = s.query_map(params![&agent_id, &workspace_id, limit], |r| Ok(json!({"id":r.get::<_,String>(0)?,"fromId":r.get::<_,String>(1)?,"toId":r.get::<_,String>(2)?,"relation":r.get::<_,String>(3)?,"metadata":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(json!({}))})))?;
            Ok(json!({"entities":entities,"relations":rows.collect::<Result<Vec<_>, _>>()?}))
        }
        Operation::KnowledgeEntityDetail {
            agent_id,
            workspace_id,
            entity_id,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let entity_id = required_id(&entity_id)?;
            connection.query_row("SELECT id,name,entity_type,metadata,created_at,updated_at FROM kg_entities WHERE id=? AND agent_id=? AND workspace_id=? AND deleted=0", params![entity_id,agent_id,workspace_id], |r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"type":r.get::<_,String>(2)?,"metadata":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(json!({})),"createdAt":r.get::<_,String>(4)?,"updatedAt":r.get::<_,String>(5)?}))).optional()?.ok_or(CoreError::NotFound)
        }
        Operation::KnowledgeAspects {
            agent_id,
            workspace_id,
            entity_id,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let entity_id = required_id(&entity_id)?;
            let mut s=connection.prepare("SELECT p.id,p.name,p.weight FROM kg_aspects p JOIN kg_entities e ON e.id=p.entity_id AND e.agent_id=p.agent_id AND e.workspace_id=p.workspace_id AND e.deleted=0 WHERE p.agent_id=? AND p.workspace_id=? AND p.entity_id=? AND p.deleted=0 ORDER BY p.weight DESC LIMIT 100")?;
            let rows=s.query_map(params![agent_id,workspace_id,entity_id],|r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"weight":r.get::<_,f64>(2)?})))?;
            Ok(json!({"items":rows.collect::<Result<Vec<_>,_>>()?}))
        }
        Operation::KnowledgeAttributes {
            agent_id,
            workspace_id,
            entity_id,
            aspect_id,
            limit,
            offset,
            kind,
            status,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let entity_id = required_id(&entity_id)?;
            let aspect_id = required_id(&aspect_id)?;
            let limit = limit.clamp(1, 200) as i64;
            let offset = offset.min(100_000) as i64;
            let mut s=connection.prepare("SELECT a.id,a.kind,a.content,a.status FROM kg_attributes a JOIN kg_aspects p ON p.id=a.aspect_id AND p.deleted=0 JOIN kg_entities e ON e.id=p.entity_id AND e.agent_id=p.agent_id AND e.workspace_id=p.workspace_id AND e.deleted=0 WHERE a.agent_id=? AND a.workspace_id=? AND p.entity_id=? AND a.aspect_id=? AND (? IS NOT NULL OR a.status != 'deleted') AND (? IS NULL OR a.kind=?) AND (? IS NULL OR a.status=?) ORDER BY a.importance DESC LIMIT ? OFFSET ?")?;
            let rows=s.query_map(params![agent_id,workspace_id,entity_id,aspect_id,status,status,kind,kind,status,limit,offset],|r| Ok(json!({"id":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"content":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?})))?;
            Ok(json!({"items":rows.collect::<Result<Vec<_>,_>>()?,"limit":limit,"offset":offset}))
        }
        Operation::KnowledgeNavigationAspects {
            agent_id,
            workspace_id,
            entity,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let entity = bounded_text(&entity, "entity", 256)?;
            let (eid,ename):(String,String)=connection.query_row("SELECT id,name FROM entities WHERE agent_id=? AND workspace_id=? AND COALESCE(status,'active')='active' AND (COALESCE(canonical_name,lower(name))=lower(?) OR lower(name)=lower(?)) ORDER BY name LIMIT 1",params![&agent_id,&workspace_id,&entity,&entity],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or(CoreError::NotFound)?;
            let mut q=connection.prepare("SELECT p.id,p.name,p.canonical_name,p.weight,p.created_at,p.updated_at, count(DISTINCT CASE WHEN a.kind='attribute' AND a.status='active' THEN a.id END), count(DISTINCT CASE WHEN a.kind='constraint' AND a.status='active' THEN a.id END) FROM entity_aspects p LEFT JOIN entity_attributes a ON a.aspect_id=p.id AND a.agent_id=p.agent_id AND a.workspace_id=p.workspace_id WHERE p.entity_id=? AND p.agent_id=? AND p.workspace_id=? AND COALESCE(p.status,'active')='active' GROUP BY p.id ORDER BY p.weight DESC,p.name ASC")?;
            let items=q.query_map(params![&eid,&agent_id,&workspace_id],|r|Ok(json!({"aspect":{"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"canonicalName":r.get::<_,Option<String>>(2)?,"weight":r.get::<_,f64>(3)?,"createdAt":r.get::<_,String>(4)?,"updatedAt":r.get::<_,String>(5)?},"attributeCount":r.get::<_,i64>(6)?,"constraintCount":r.get::<_,i64>(7)?})))?.collect::<Result<Vec<_>,_>>()?;
            Ok(json!({"entity":{"id":eid,"name":ename},"items":items}))
        }
        Operation::KnowledgeNavigationGroups {
            agent_id,
            workspace_id,
            entity,
            aspect,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let entity = bounded_text(&entity, "entity", 256)?;
            let aspect = bounded_text(&aspect, "aspect", 256)?;
            let (eid,ename):(String,String)=connection.query_row("SELECT id,name FROM entities WHERE agent_id=? AND workspace_id=? AND COALESCE(status,'active')='active' AND (lower(name)=lower(?) OR lower(COALESCE(canonical_name, name))=lower(?)) ORDER BY CASE WHEN lower(COALESCE(canonical_name,name))=lower(?) THEN 0 ELSE 1 END,name LIMIT 1",params![&agent_id,&workspace_id,&entity,&entity,&entity],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or(CoreError::NotFound)?;
            let (aid,aname):(String,String)=connection.query_row("SELECT p.id,p.name FROM entity_aspects p WHERE p.entity_id=? AND p.agent_id=? AND p.workspace_id=? AND COALESCE(p.status,'active')='active' AND (lower(p.name)=lower(?) OR lower(COALESCE(p.canonical_name,p.name))=lower(?)) ORDER BY CASE WHEN lower(COALESCE(p.canonical_name,p.name))=lower(?) THEN 0 ELSE 1 END,p.name LIMIT 1",params![&eid,&agent_id,&workspace_id,&aspect,&aspect,&aspect],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or(CoreError::NotFound)?;
            let mut q=connection.prepare("SELECT min(coalesce(a.group_key,'general')),count(CASE WHEN a.kind='attribute' AND a.status='active' THEN 1 END),count(CASE WHEN a.kind='constraint' AND a.status='active' THEN 1 END),count(DISTINCT a.claim_key),max(a.updated_at) FROM entity_attributes a WHERE a.aspect_id=? AND a.agent_id=? AND a.workspace_id=? AND a.status!='deleted' GROUP BY replace(lower(trim(coalesce(a.group_key,'general'))),' ','_') ORDER BY 2 DESC,3 DESC,4 DESC,1 ASC")?;
            let items=q.query_map(params![&aid,&agent_id,&workspace_id],|r|Ok(json!({"groupKey":r.get::<_,String>(0)?,"attributeCount":r.get::<_,i64>(1)?,"constraintCount":r.get::<_,i64>(2)?,"claimCount":r.get::<_,i64>(3)?,"latestUpdatedAt":r.get::<_,Option<String>>(4)?})))?.collect::<Result<Vec<_>,_>>()?;
            Ok(
                json!({"entity":{"id":eid,"name":ename},"aspect":{"id":aid,"name":aname},"items":items}),
            )
        }
        Operation::KnowledgeNavigationClaims {
            agent_id,
            workspace_id,
            entity,
            aspect,
            group,
        } => {
            let base = execute_operation(
                connection,
                Operation::KnowledgeNavigationGroups {
                    agent_id: agent_id.clone(),
                    workspace_id: workspace_id.clone(),
                    entity: entity.clone(),
                    aspect: aspect.clone(),
                },
            )?;
            let aid = base["aspect"]["id"].as_str().unwrap().to_string();
            let group_raw = group.trim().to_lowercase();
            let group = canonical_key(&group);
            let mut q=connection.prepare("SELECT a.claim_key,lower(coalesce(a.group_key,'general')),count(CASE WHEN a.kind='attribute' THEN 1 END),count(CASE WHEN a.kind='constraint' THEN 1 END),count(CASE WHEN a.status='active' THEN 1 END),count(CASE WHEN a.status='superseded' THEN 1 END),max(a.updated_at),(SELECT x.content FROM entity_attributes x WHERE x.aspect_id=a.aspect_id AND x.agent_id=a.agent_id AND x.workspace_id=a.workspace_id AND (replace(lower(trim(coalesce(x.group_key,'general'))),' ','_')=? OR replace(lower(trim(coalesce(x.group_key,'general'))),' ','_')=?) AND x.claim_key=a.claim_key AND x.status='active' ORDER BY x.importance DESC,x.updated_at DESC LIMIT 1) FROM entity_attributes a WHERE a.aspect_id=? AND a.agent_id=? AND a.workspace_id=? AND (replace(lower(trim(coalesce(a.group_key,'general'))),' ','_')=? OR replace(lower(trim(coalesce(a.group_key,'general'))),' ','_')=?) AND a.claim_key IS NOT NULL AND a.status!='deleted' GROUP BY a.claim_key,coalesce(a.group_key,'general') ORDER BY 5 DESC,7 DESC,1 ASC")?;
            let items=q.query_map(params![&group,&group_raw,&aid,&agent_id,&workspace_id,&group,&group_raw],|r|Ok(json!({"claimKey":r.get::<_,String>(0)?,"groupKey":r.get::<_,String>(1)?,"attributeCount":r.get::<_,i64>(2)?,"constraintCount":r.get::<_,i64>(3)?,"activeCount":r.get::<_,i64>(4)?,"supersededCount":r.get::<_,i64>(5)?,"latestUpdatedAt":r.get::<_,Option<String>>(6)?,"preview":r.get::<_,Option<String>>(7)?})))?.collect::<Result<Vec<_>,_>>()?;
            Ok(
                json!({"entity":base["entity"].clone(),"aspect":base["aspect"].clone(),"items":items}),
            )
        }
        Operation::KnowledgeNavigationAttributes {
            agent_id,
            workspace_id,
            entity,
            aspect,
            group,
            claim,
            limit,
            offset,
            kind,
            status,
        } => {
            let limit = bounded_page_limit(Some(limit))? as i64;
            let offset = bounded_offset(offset)? as i64;
            let base = execute_operation(
                connection,
                Operation::KnowledgeNavigationGroups {
                    agent_id: agent_id.clone(),
                    workspace_id: workspace_id.clone(),
                    entity: entity.clone(),
                    aspect: aspect.clone(),
                },
            )?;
            let aid = base["aspect"]["id"].as_str().unwrap().to_string();
            let group_raw = group.trim().to_lowercase();
            let claim_raw = claim.trim().to_lowercase();
            let group = canonical_key(&group);
            let claim = canonical_key(&claim);
            if claim.is_empty() {
                return Ok(
                    json!({"entity":base["entity"],"aspect":base["aspect"],"items":[],"limit":limit,"offset":offset}),
                );
            }
            let status_clause = if status.as_deref() == Some("all") {
                ""
            } else if let Some(s) = status.as_deref() {
                s
            } else {
                "active"
            };
            let projection = attribute_projection(connection)?;
            let sql = if status_clause.is_empty() {
                format!("SELECT {projection} FROM entity_attributes WHERE aspect_id=? AND agent_id=? AND workspace_id=? AND (replace(lower(trim(coalesce(group_key,'general'))),' ','_')=? OR replace(lower(trim(coalesce(group_key,'general'))),' ','_')=?) AND (replace(lower(trim(claim_key)),' ','_')=? OR replace(lower(trim(claim_key)),' ','_')=?) AND status!='deleted' AND (? IS NULL OR kind=?) ORDER BY created_at DESC,importance DESC LIMIT ? OFFSET ?")
            } else {
                format!("SELECT {projection} FROM entity_attributes WHERE aspect_id=? AND agent_id=? AND workspace_id=? AND (replace(lower(trim(coalesce(group_key,'general'))),' ','_')=? OR replace(lower(trim(coalesce(group_key,'general'))),' ','_')=?) AND (replace(lower(trim(claim_key)),' ','_')=? OR replace(lower(trim(claim_key)),' ','_')=?) AND status=? AND (? IS NULL OR kind=?) ORDER BY created_at DESC,importance DESC LIMIT ? OFFSET ?")
            };
            let mut q = connection.prepare(&sql)?;
            let items = if status_clause.is_empty() {
                q.query_map(
                    params![
                        &aid,
                        &agent_id,
                        &workspace_id,
                        &group,
                        &group_raw,
                        &claim,
                        &claim_raw,
                        &kind,
                        &kind,
                        limit,
                        offset
                    ],
                    attr_json,
                )?
                .collect::<Result<Vec<_>, _>>()?
            } else {
                q.query_map(
                    params![
                        &aid,
                        &agent_id,
                        &workspace_id,
                        &group,
                        &group_raw,
                        &claim,
                        &claim_raw,
                        status_clause,
                        &kind,
                        &kind,
                        limit,
                        offset
                    ],
                    attr_json,
                )?
                .collect::<Result<Vec<_>, _>>()?
            };
            Ok(
                json!({"entity":base["entity"],"aspect":base["aspect"],"groupKey":group,"claimKey":claim,"items":items,"limit":limit,"offset":offset}),
            )
        }
        Operation::KnowledgeTree {
            agent_id,
            workspace_id,
            entity_id,
            depth,
            max_aspects,
            max_groups,
            max_claims,
            max_attributes: _,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let name = bounded_text(&entity_id, "entity", 256)?;
            let key = name.to_lowercase();
            let escaped_key = key
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let like = format!("%{}%", escaped_key);
            let entity=connection.query_row("SELECT id,name,canonical_name,entity_type,description,created_at,updated_at FROM entities WHERE agent_id=? AND workspace_id=? AND COALESCE(status,'active')='active' AND (id=? OR lower(COALESCE(canonical_name,lower(name)))=? OR lower(name)=? OR lower(COALESCE(canonical_name,lower(name))) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\') ORDER BY CASE WHEN id=? THEN 0 WHEN lower(COALESCE(canonical_name,lower(name)))=? THEN 1 WHEN lower(name)=? THEN 2 WHEN lower(COALESCE(canonical_name,lower(name))) LIKE ? ESCAPE '\\' THEN 3 ELSE 4 END,updated_at DESC,name ASC LIMIT 1",params![&agent_id,&workspace_id,&name,&key,&key,&like,&like,&name,&key,&key,&like],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"canonicalName":r.get::<_,Option<String>>(2)?,"entityType":r.get::<_,String>(3)?,"description":r.get::<_,Option<String>>(4)?,"createdAt":r.get::<_,String>(5)?,"updatedAt":r.get::<_,String>(6)?}))).optional()?.ok_or(CoreError::NotFound)?;
            let eid = entity["id"].as_str().unwrap().to_string();
            let group_lim = max_groups.clamp(1, 200) as i64;
            let claim_lim = max_claims.clamp(1, 200) as i64;
            let mut items = Vec::new();
            let mut q=connection.prepare("SELECT id,name,canonical_name,weight,created_at,updated_at FROM entity_aspects WHERE entity_id=? AND agent_id=? AND workspace_id=? AND COALESCE(status,'active')='active' ORDER BY weight DESC,name ASC LIMIT ?")?;
            for r in q.query_map(
                params![
                    &eid,
                    &agent_id,
                    &workspace_id,
                    max_aspects.clamp(1, 100) as i64
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, f64>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                },
            )? {
                let (aid, aname, canon, weight, created, updated) = r?;
                let (attribute_count, constraint_count, claim_count): (i64, i64, i64) = connection.query_row(
                    "SELECT count(CASE WHEN kind='attribute' AND status='active' THEN 1 END), count(CASE WHEN kind='constraint' AND status='active' THEN 1 END), count(DISTINCT CASE WHEN status!='deleted' AND claim_key IS NOT NULL THEN claim_key END) FROM entity_attributes WHERE aspect_id=? AND agent_id=? AND workspace_id=?",
                    params![&aid, &agent_id, &workspace_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                let mut v = json!({"aspect":{"id":aid,"name":aname,"canonicalName":canon,"weight":weight,"createdAt":created,"updatedAt":updated},"attributeCount":attribute_count,"constraintCount":constraint_count,"groupCount":0,"claimCount":claim_count,"groups":[]});
                let mut gq=connection.prepare("SELECT min(COALESCE(group_key,'general')),count(CASE WHEN kind='attribute' AND status='active' THEN 1 END),count(CASE WHEN kind='constraint' AND status='active' THEN 1 END),count(DISTINCT claim_key),max(updated_at) FROM entity_attributes WHERE aspect_id=? AND agent_id=? AND workspace_id=? AND status!='deleted' GROUP BY replace(lower(trim(coalesce(group_key,'general'))),' ','_') ORDER BY 2 DESC,3 DESC,4 DESC,1 ASC LIMIT ?")?;
                let mut gs = Vec::new();
                for g in gq.query_map(params![&aid,&agent_id,&workspace_id,group_lim],|r|Ok(json!({"groupKey":r.get::<_,String>(0)?,"attributeCount":r.get::<_,i64>(1)?,"constraintCount":r.get::<_,i64>(2)?,"claimCount":r.get::<_,i64>(3)?,"latestUpdatedAt":r.get::<_,Option<String>>(4)?,"claims":[]})))? {
                    let mut group = g?;
                    if depth.min(3) >= 3 {
                        let group_key = group["groupKey"].as_str().unwrap_or("general").to_string();
                        let mut cq = connection.prepare("SELECT claim_key,count(CASE WHEN kind='attribute' THEN 1 END),count(CASE WHEN kind='constraint' THEN 1 END),count(CASE WHEN status='active' THEN 1 END),count(CASE WHEN status='superseded' THEN 1 END),max(updated_at),(SELECT content FROM entity_attributes z WHERE z.aspect_id=? AND z.agent_id=? AND z.workspace_id=? AND replace(lower(trim(coalesce(z.group_key,'general'))),' ','_')=replace(lower(trim(?)),' ','_') AND z.claim_key=ea.claim_key AND z.status='active' ORDER BY z.importance DESC,z.updated_at DESC LIMIT 1) FROM entity_attributes ea WHERE ea.aspect_id=? AND ea.agent_id=? AND ea.workspace_id=? AND replace(lower(trim(coalesce(ea.group_key,'general'))),' ','_')=replace(lower(trim(?)),' ','_') AND ea.claim_key IS NOT NULL AND ea.status!='deleted' GROUP BY claim_key ORDER BY 4 DESC,6 DESC,1 ASC LIMIT ?")?;
                        let claims: Vec<Value> = cq.query_map(params![&aid,&agent_id,&workspace_id,&group_key,&aid,&agent_id,&workspace_id,&group_key,claim_lim], |r| Ok(json!({"claimKey":r.get::<_,String>(0)?,"attributeCount":r.get::<_,i64>(1)?,"constraintCount":r.get::<_,i64>(2)?,"activeCount":r.get::<_,i64>(3)?,"supersededCount":r.get::<_,i64>(4)?,"latestUpdatedAt":r.get::<_,Option<String>>(5)?,"preview":r.get::<_,Option<String>>(6)?})))?.collect::<Result<_,_>>()?;
                        group["claims"] = json!(claims);
                    }
                    gs.push(group);
                }
                let group_count: i64 = connection.query_row("SELECT count(*) FROM (SELECT 1 FROM entity_attributes WHERE aspect_id=? AND agent_id=? AND workspace_id=? AND status!='deleted' GROUP BY replace(lower(trim(coalesce(group_key,'general'))),' ','_'))", params![&aid,&agent_id,&workspace_id], |r| r.get(0))?;
                v["groupCount"] = json!(group_count);
                if depth.min(3) >= 2 {
                    v["groups"] = json!(gs);
                }
                items.push(v);
            }
            Ok(
                json!({"entity":entity,"limits":{"maxAspects":max_aspects,"maxGroups":max_groups,"maxClaims":max_claims,"depth":depth.min(3)},"items":items}),
            )
        }
        Operation::SessionStart {
            agent_id,
            key,
            harness,
            runtime_path,
            project,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let key = bounded_text(&key, "session key", 512)?;
            let harness = bounded_text(&harness, "harness", 128)?;
            let tx = connection.transaction()?;
            tx.execute("INSERT INTO sessions(key,agent_id,harness,runtime_path,project,status,started_at) VALUES(?,?,?,?,?,'active',datetime('now')) ON CONFLICT(key,agent_id) DO UPDATE SET harness=excluded.harness,runtime_path=excluded.runtime_path,project=excluded.project,status='active',ended_at=NULL", params![key,agent_id,harness,runtime_path,project])?;
            tx.execute("INSERT INTO event_records(agent_id,session_key,event,payload,created_at) VALUES(?,?,?,?,datetime('now'))", params![agent_id,key,"session-start",serde_json::to_string(&json!({"harness":harness}))?])?;
            tx.commit()?;
            Ok(json!({"key":key,"agentId":agent_id,"status":"active"}))
        }
        Operation::SessionEnd { agent_id, key } => {
            let agent_id = required_agent(&agent_id)?;
            let key = required_id(&key)?;
            let tx = connection.transaction()?;
            let changed = tx.execute("UPDATE sessions SET status='ended',ended_at=datetime('now') WHERE key=? AND agent_id=? AND status='active'", params![key,agent_id])?;
            if changed == 0 {
                return Err(CoreError::NotFound);
            }
            tx.execute("INSERT INTO event_records(agent_id,session_key,event,payload,created_at) VALUES(?,?,?,?,datetime('now'))", params![agent_id,key,"session-end","{}"])?;
            tx.commit()?;
            Ok(json!({"key":key,"status":"ended"}))
        }
        Operation::SessionList { agent_id, limit } => {
            let agent_id = required_agent(&agent_id)?;
            let mut s=connection.prepare("SELECT key,agent_id,harness,runtime_path,project,status,started_at,ended_at FROM sessions WHERE agent_id=? ORDER BY started_at DESC LIMIT ?")?;
            let rows=s.query_map(params![agent_id,limit.clamp(1,MAX_EVENT_RECORDS) as i64],|r| Ok(json!({"key":r.get::<_,String>(0)?,"agentId":r.get::<_,String>(1)?,"harness":r.get::<_,String>(2)?,"runtimePath":r.get::<_,Option<String>>(3)?,"project":r.get::<_,Option<String>>(4)?,"status":r.get::<_,String>(5)?,"startedAt":r.get::<_,String>(6)?,"endedAt":r.get::<_,Option<String>>(7)?})))?;
            Ok(json!({"sessions":rows.collect::<Result<Vec<_>,_>>()?}))
        }
        Operation::HookDeliver {
            agent_id,
            key,
            hook,
            payload,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let hook = bounded_text(&hook, "hook", 128)?;
            let payload = bounded_json(&payload)?;
            connection.execute("INSERT INTO event_records(agent_id,session_key,event,payload,created_at) VALUES(?,?,?,?,datetime('now'))",params![agent_id,key,hook,payload])?;
            Ok(json!({"delivered":true}))
        }
        Operation::EventList {
            agent_id,
            key,
            limit,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let limit = limit.clamp(1, MAX_EVENT_RECORDS) as i64;
            let mut s=connection.prepare("SELECT id,event,payload,created_at FROM event_records WHERE agent_id=? AND (? IS NULL OR session_key=?) ORDER BY id DESC LIMIT ?")?;
            let rows=s.query_map(params![agent_id,key,key,limit],|r| Ok(json!({"id":r.get::<_,i64>(0)?,"event":r.get::<_,String>(1)?,"payload":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(json!({})),"createdAt":r.get::<_,String>(3)?})))?;
            Ok(json!({"events":rows.collect::<Result<Vec<_>,_>>()?}))
        }
        Operation::TelemetryRecord {
            agent_id,
            workspace_id,
            event,
            payload,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let event = bounded_text(&event, "event", 128)?;
            let payload = bounded_json(&payload)?;
            let tx = connection.transaction()?;
            tx.execute("INSERT INTO telemetry_events(agent_id,workspace_id,event,payload,created_at) VALUES(?,?,?,?,datetime('now'))", params![agent_id,workspace_id,event,payload])?;
            let id = tx.last_insert_rowid();
            tx.commit()?;
            Ok(
                json!({"id":id,"agentId":agent_id,"workspaceId":workspace_id,"event":event,"payload":serde_json::from_str::<Value>(&payload).unwrap_or(json!({}))}),
            )
        }
        Operation::TelemetryList {
            agent_id,
            workspace_id,
            event,
            since,
            until,
            cursor,
            limit,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let limit = limit.clamp(1, 10_000) as i64;
            let mut s = connection.prepare("SELECT id,agent_id,workspace_id,event,payload,created_at FROM telemetry_events WHERE agent_id=? AND workspace_id=? AND (? IS NULL OR event=?) AND (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<=?) AND (? IS NULL OR id>?) ORDER BY id ASC LIMIT ?")?;
            let rows = s.query_map(params![agent_id,workspace_id,event,event,since,since,until,until,cursor,cursor,limit], |r| Ok(json!({"id":r.get::<_,i64>(0)?,"agentId":r.get::<_,String>(1)?,"workspaceId":r.get::<_,String>(2)?,"event":r.get::<_,String>(3)?,"payload":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(json!({})),"createdAt":r.get::<_,String>(5)?})))?;
            let events = rows.collect::<Result<Vec<_>, _>>()?;
            let next = events.last().and_then(|v| v.get("id")).cloned();
            Ok(json!({"events":events,"nextCursor":next,"limit":limit,"complete":next.is_none()}))
        }
        Operation::HookReceipt {
            agent_id,
            receipt_id,
            checkpoint,
            hook,
            session_key,
            payload,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let receipt_id = bounded_text(&receipt_id, "receipt id", 128)?;
            let hook = bounded_text(&hook, "hook", 128)?;
            let payload = bounded_json(&payload)?;
            let tx = connection.transaction()?;
            tx.execute("INSERT INTO hook_receipts(receipt_id,agent_id,session_key,hook,checkpoint,payload,created_at) VALUES(?,?,?,?,?,?,datetime('now')) ON CONFLICT(agent_id,receipt_id) DO UPDATE SET checkpoint=excluded.checkpoint,payload=excluded.payload", params![receipt_id,agent_id,session_key,hook,checkpoint,payload])?;
            tx.commit()?;
            Ok(json!({"receiptId":receipt_id,"durable":true,"checkpoint":checkpoint}))
        }
        Operation::HookReceipts {
            agent_id,
            session_key,
            after_id,
            limit,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let mut s = connection.prepare("SELECT id,receipt_id,session_key,hook,checkpoint,payload,created_at FROM hook_receipts WHERE agent_id=? AND id>? AND (? IS NULL OR session_key=?) ORDER BY id ASC LIMIT ?")?;
            let rows = s.query_map(params![agent_id,after_id,session_key,session_key,limit.clamp(1,MAX_EVENT_RECORDS) as i64], |r| Ok(json!({"id":r.get::<_,i64>(0)?,"receiptId":r.get::<_,String>(1)?,"sessionKey":r.get::<_,Option<String>>(2)?,"hook":r.get::<_,String>(3)?,"checkpoint":r.get::<_,Option<String>>(4)?,"payload":serde_json::from_str::<Value>(&r.get::<_,String>(5)?).unwrap_or(json!({})),"createdAt":r.get::<_,String>(6)?})))?;
            Ok(json!({"receipts":rows.collect::<Result<Vec<_>,_>>()?}))
        }
        Operation::CrossAgentSend {
            agent_id,
            workspace_id,
            recipient_agent_id,
            kind,
            payload,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let recipient_agent_id = required_agent(&recipient_agent_id)?;
            let kind = bounded_text(&kind, "message kind", 128)?;
            let payload = bounded_json(&payload)?;
            let tx = connection.transaction()?;
            tx.execute("INSERT INTO cross_agent_messages(workspace_id,sender_agent_id,recipient_agent_id,kind,payload,created_at) VALUES(?,?,?,?,?,datetime('now'))", params![workspace_id,agent_id,recipient_agent_id,kind,payload])?;
            let id = tx.last_insert_rowid();
            tx.commit()?;
            Ok(json!({"id":id,"workspaceId":workspace_id,"delivered":true}))
        }
        Operation::CrossAgentList {
            agent_id,
            workspace_id,
            after_id,
            limit,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = canonical_workspace(&workspace_id)?;
            let mut s = connection.prepare("SELECT id,sender_agent_id,recipient_agent_id,kind,payload,created_at FROM cross_agent_messages WHERE workspace_id=? AND recipient_agent_id=? AND id>? ORDER BY id ASC LIMIT ?")?;
            let rows = s.query_map(params![workspace_id,agent_id,after_id,limit.clamp(1,MAX_EVENT_RECORDS) as i64], |r| Ok(json!({"id":r.get::<_,i64>(0)?,"senderAgentId":r.get::<_,String>(1)?,"recipientAgentId":r.get::<_,String>(2)?,"kind":r.get::<_,String>(3)?,"payload":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(json!({})),"createdAt":r.get::<_,String>(5)?})))?;
            Ok(json!({"messages":rows.collect::<Result<Vec<_>,_>>()?}))
        }
    }
}

fn database_schema(connection: &Connection) -> Result<Value, CoreError> {
    let mut stmt = connection.prepare("SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name COLLATE BINARY")?;
    let mut tables = Vec::new();
    for row in stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })? {
        let (name, kind, sql) = row?;
        let columns = table_column_metadata(connection, &name)?;
        let indexes = table_indexes(connection, &name)?;
        let foreign_keys = table_foreign_keys(connection, &name)?;
        let count: i64 = connection.query_row(
            &format!("SELECT count(*) FROM {}", quote_identifier(&name)),
            [],
            |r| r.get(0),
        )?;
        tables.push(json!({"name":name,"type":kind,"sql":sql,"columns":columns,"indexes":indexes,"foreignKeys":foreign_keys,"rowCount":count}));
    }
    Ok(
        json!({"tables":tables,"groups":[],"sample":{"supported":true,"defaultLimit":25,"maxLimit":100,"scope":"native-schema-only"},"complete":true,"unsupported":[]}),
    )
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, CoreError> {
    let pragma = format!("PRAGMA table_info({})", quote_identifier(table));
    Ok(connection
        .prepare(&pragma)?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?)
}

fn table_column_metadata(connection: &Connection, table: &str) -> Result<Vec<Value>, CoreError> {
    let pragma = format!("PRAGMA table_info({})", quote_identifier(table));
    Ok(connection.prepare(&pragma)?.query_map([], |r| Ok(json!({"name":r.get::<_,String>(1)?,"type":r.get::<_,String>(2)?,"notNull":r.get::<_,i64>(3)? != 0,"default":r.get::<_,Option<String>>(4)?,"primaryKey":r.get::<_,i64>(5)? != 0})))?.collect::<Result<Vec<_>,_>>()?)
}

fn table_indexes(connection: &Connection, table: &str) -> Result<Vec<Value>, CoreError> {
    let pragma = format!("PRAGMA index_list({})", quote_identifier(table));
    let indexes = connection
        .prepare(&pragma)?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)? != 0,
                r.get::<_, String>(3).unwrap_or_default(),
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    indexes
        .into_iter()
        .map(|(name, unique, origin)| {
            let info = format!("PRAGMA index_info({})", quote_identifier(&name));
            let columns = connection
                .prepare(&info)?
                .query_map([], |r| {
                    Ok(json!({"seq":r.get::<_,i64>(0)?,"name":r.get::<_,Option<String>>(2)?}))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({"name":name,"unique":unique,"origin":origin,"columns":columns}))
        })
        .collect()
}

fn table_foreign_keys(connection: &Connection, table: &str) -> Result<Vec<Value>, CoreError> {
    let pragma = format!("PRAGMA foreign_key_list({})", quote_identifier(table));
    Ok(connection.prepare(&pragma)?.query_map([], |r| Ok(json!({"id":r.get::<_,i64>(0)?,"seq":r.get::<_,i64>(1)?,"table":r.get::<_,String>(2)?,"from":r.get::<_,String>(3)?,"to":r.get::<_,Option<String>>(4)?,"onUpdate":r.get::<_,String>(5)?,"onDelete":r.get::<_,String>(6)?})))?.collect::<Result<Vec<_>,_>>()?)
}

fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn database_sample(
    connection: &Connection,
    table: &str,
    limit: usize,
    offset: usize,
    agent: Option<&str>,
    workspace: Option<&str>,
) -> Result<Value, CoreError> {
    if !(1..=100).contains(&limit) {
        return Err(CoreError::InvalidInput(
            "limit must be an integer from 1 to 100".into(),
        ));
    }
    if table.starts_with("sqlite_")
        || table.contains("_fts")
        || table.ends_with("_content")
        || table.ends_with("_data")
        || table.ends_with("_idx")
        || table.ends_with("_docsize")
        || table.ends_with("_config")
    {
        return Err(CoreError::InvalidInput("table is not sampleable".into()));
    }
    let exists: Option<String> = connection
        .query_row(
            "SELECT name FROM sqlite_master WHERE name=? AND type IN ('table','view')",
            [table],
            |r| r.get(0),
        )
        .optional()?;
    let Some(name) = exists else {
        return Err(CoreError::NotFound);
    };
    let names = table_columns(connection, &name)?;
    let has_agent = names.iter().any(|column| column == "agent_id");
    let has_workspace = names.iter().any(|column| column == "workspace_id");
    if agent.is_some() && !has_agent {
        return Err(CoreError::InvalidInput(
            "table has no agent_id scope column".into(),
        ));
    }
    if workspace.is_some() && !has_workspace {
        return Err(CoreError::InvalidInput(
            "table has no workspace_id scope column".into(),
        ));
    }
    let mut predicates = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();
    if let Some(value) = agent {
        predicates.push(format!("{} = ?", quote_identifier("agent_id")));
        values.push(SqlValue::Text(value.to_owned()));
    }
    if let Some(value) = workspace {
        predicates.push(format!("{} = ?", quote_identifier("workspace_id")));
        values.push(SqlValue::Text(value.to_owned()));
    }
    let where_clause = if predicates.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", predicates.join(" AND "))
    };
    let sql = format!(
        "SELECT * FROM {}{} LIMIT ? OFFSET ?",
        quote_identifier(&name),
        where_clause
    );
    let mut stmt = connection.prepare(&sql)?;
    values.push(SqlValue::Integer(limit as i64));
    values.push(SqlValue::Integer(offset as i64));
    let mut rows_out = Vec::new();
    let mut rows = stmt.query(rusqlite::params_from_iter(values.iter()))?;
    while let Some(row) = rows.next()? {
        let mut obj = serde_json::Map::new();
        for (i, n) in names.iter().enumerate() {
            let v: SqlValue = row.get(i)?;
            obj.insert(
                n.clone(),
                match v {
                    SqlValue::Null => Value::Null,
                    SqlValue::Integer(v) => json!(v),
                    SqlValue::Real(v) => json!(v),
                    SqlValue::Text(v) => json!(v),
                    SqlValue::Blob(v) => json!(format!("[blob:{} bytes]", v.len())),
                },
            );
        }
        rows_out.push(Value::Object(obj));
    }
    let scope = json!({"agent":agent.is_some(),"workspace":workspace.is_some(),"isolated":!predicates.is_empty()});
    Ok(
        json!({"table":name,"limit":limit,"offset":offset,"columns":names,"rows":rows_out,"complete":rows_out.len()<limit,"scope":scope}),
    )
}

fn claim_worker_connection(connection: &mut Connection) -> Result<Option<WorkerJob>, CoreError> {
    let tx = connection.transaction()?;
    tx.execute("UPDATE jobs SET state='expired',error='deadline exceeded',updated_at=datetime('now') WHERE state='queued' AND deadline_at IS NOT NULL AND julianday(deadline_at) <= julianday('now')", [])?;
    let row: Option<(String,String,String,String,String)> = tx.query_row("SELECT id,agent_id,workspace_id,kind,payload FROM jobs WHERE state='queued' AND (deadline_at IS NULL OR julianday(deadline_at)>julianday('now')) AND kind IN ('dream.trigger','dream.pass','dreaming') ORDER BY created_at,id LIMIT 1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let Some((id, agent_id, workspace_id, kind, payload)) = row else {
        tx.commit()?;
        return Ok(None);
    };
    if tx.execute("UPDATE jobs SET state='running',updated_at=datetime('now') WHERE id=? AND agent_id=? AND workspace_id=? AND state='queued'", params![id,agent_id,workspace_id])? == 0 { tx.commit()?; return Ok(None) }
    tx.execute("INSERT INTO job_events(job_id,agent_id,event,data,created_at) VALUES(?,?, 'running','{\"from\":\"queued\",\"to\":\"running\"}',datetime('now'))", params![id,agent_id])?;
    tx.commit()?;
    Ok(Some(WorkerJob {
        id,
        agent_id,
        workspace_id: Some(workspace_id),
        kind,
        payload,
    }))
}

fn finish_worker_connection(
    connection: &mut Connection,
    job: &WorkerJob,
    state: &str,
    error: Option<&str>,
    result: Option<Value>,
) -> Result<(), CoreError> {
    if !matches!(state, "completed" | "failed") {
        return Err(CoreError::InvalidInput(
            "invalid worker terminal state".into(),
        ));
    }
    let result_text = result.as_ref().map(serde_json::to_string).transpose()?;
    let tx = connection.transaction()?;
    let changed = tx.execute("UPDATE jobs SET state=?,error=?,result=?,updated_at=datetime('now') WHERE id=? AND agent_id=? AND workspace_id=? AND state='running' AND (deadline_at IS NULL OR julianday(deadline_at)>julianday('now'))", params![state,error,result_text,job.id,job.agent_id,job.workspace_id])?;
    if changed > 0 {
        tx.execute("INSERT INTO job_events(job_id,agent_id,event,data,created_at) VALUES(?,?,?, ?,datetime('now'))", params![job.id,job.agent_id,state,serde_json::to_string(&json!({"error":error,"result":result}))?])?;
    }
    tx.commit()?;
    Ok(())
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

    pub fn initialize(&self) -> Result<(), CoreError> {
        self.0.initialize()
    }

    pub async fn submit_async(&self, operation: Operation) -> Result<Value, CoreError> {
        self.0.submit_async(operation).await
    }

    pub fn worker_claim(&self) -> Result<Option<WorkerJob>, CoreError> {
        self.0.worker_claim()
    }
    pub async fn worker_claim_async(&self) -> Result<Option<WorkerJob>, CoreError> {
        self.0.worker_claim_async().await
    }
    pub fn database_schema(&self) -> Result<Value, CoreError> {
        self.0.database_schema()
    }

    pub fn database_sample(
        &self,
        table: String,
        limit: usize,
        offset: usize,
        agent: Option<String>,
        workspace: Option<String>,
    ) -> Result<Value, CoreError> {
        self.0
            .database_sample(table, limit, offset, agent, workspace)
    }

    pub fn finish_worker_job(
        &self,
        job: WorkerJob,
        state: &str,
        error: Option<&str>,
    ) -> Result<(), CoreError> {
        self.0.worker_finish(job, state, error)
    }
}

pub type Value = serde_json::Value;
pub type OperationResult = Value;

const MAX_EVENT_RECORDS: usize = 500;
const MAX_LIST_PAGE: usize = 100;

fn canonical_key(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("_")
}
fn bounded_offset(value: usize) -> Result<usize, CoreError> {
    if value > 100_000 {
        Err(CoreError::InvalidInput("offset is too large".into()))
    } else {
        Ok(value)
    }
}
fn attribute_projection(connection: &rusqlite::Connection) -> rusqlite::Result<String> {
    let mut stmt = connection.prepare("PRAGMA table_info(entity_attributes)")?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<std::collections::HashSet<_>, _>>()?;
    let optional = [
        "normalized_content",
        "group_key",
        "claim_key",
        "superseded_by",
        "version",
        "version_root_id",
        "previous_attribute_id",
        "archived_at",
        "archived_by",
        "archive_reason",
        "source_kind",
        "source_id",
        "source_path",
        "source_root",
        "proposal_id",
        "proposal_evidence",
    ];
    let mut projection =
        "id,kind,content,status,confidence,importance,memory_id,created_at,updated_at".to_string();
    for column in optional {
        projection.push_str(", ");
        if columns.contains(column) {
            projection.push_str(column);
        } else {
            projection.push_str("NULL");
        }
        projection.push_str(" AS ");
        projection.push_str(column);
    }
    Ok(projection)
}

fn attr_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let text = |index| r.get::<_, Option<String>>(index);
    let evidence = text(24)?
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_else(|| json!([]));
    Ok(json!({
        "id": r.get::<_, String>(0)?, "kind": r.get::<_, String>(1)?, "content": r.get::<_, String>(2)?,
        "status": r.get::<_, String>(3)?, "confidence": r.get::<_, f64>(4)?, "importance": r.get::<_, f64>(5)?,
        "memoryId": r.get::<_, Option<String>>(6)?, "createdAt": r.get::<_, String>(7)?, "updatedAt": r.get::<_, String>(8)?,
        "normalizedContent": text(9)?, "groupKey": text(10)?, "claimKey": text(11)?, "supersededBy": text(12)?,
        "version": r.get::<_, Option<i64>>(13)?.unwrap_or(1), "versionRootId": text(14)?.unwrap_or_else(|| r.get::<_, String>(0).unwrap()),
        "previousAttributeId": text(15)?, "archivedAt": text(16)?, "archivedBy": text(17)?, "archiveReason": text(18)?,
        "sourceKind": text(19)?, "sourceId": text(20)?, "sourcePath": text(21)?, "sourceRoot": text(22)?,
        "proposalId": text(23)?, "proposalEvidence": evidence
    }))
}

fn bounded_page_limit(limit: Option<usize>) -> Result<usize, CoreError> {
    let value = limit.unwrap_or(MAX_LIST_PAGE);
    if value == 0 || value > MAX_LIST_PAGE {
        return Err(CoreError::InvalidInput(format!(
            "limit must be between 1 and {MAX_LIST_PAGE}"
        )));
    }
    Ok(value)
}

fn parse_cursor(cursor: Option<String>) -> Result<Option<i64>, CoreError> {
    cursor
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| CoreError::InvalidInput("cursor must be a valid integer".into()))
        })
        .transpose()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionRecord {
    pub key: String,
    pub agent_id: String,
    pub harness: String,
    pub runtime_path: Option<String>,
    pub project: Option<String>,
    pub status: String,
    pub started_at: String,
    pub ended_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Operation {
    LegacyMarkdownImport {
        agent_id: String,
        workspace_id: String,
        files: Value,
    },
    Cancellation {
        agent_id: String,
        action: String,
        operation_id: String,
        content: Option<String>,
        fault: Option<String>,
    },
    Health,
    ReflectionList {
        agent_id: String,
        limit: usize,
    },
    ReflectionToday {
        agent_id: String,
        date: String,
        limit: usize,
    },
    SecretList {
        agent_id: String,
        workspace_id: String,
        limit: usize,
    },
    SecretUpsert {
        agent_id: String,
        workspace_id: String,
        name: String,
        value: String,
    },
    SecretDelete {
        agent_id: String,
        workspace_id: String,
        name: String,
    },
    MemoryAdvanced {
        agent_id: String,
        action: String,
        id: Option<String>,
        payload: Value,
    },
    AuthKeyCreate {
        agent_id: String,
        name: String,
        role: String,
        scope: Value,
        permissions: Value,
        connector: Option<String>,
        harness: Option<String>,
        allowed_projects: Value,
        expires_at: Option<String>,
    },
    AuthKeyList {
        agent_id: String,
    },
    AuthKeyRevoke {
        agent_id: String,
        id: String,
    },
    AuthKeyVerify {
        token: String,
    },
    Remember {
        agent_id: String,
        content: String,
        metadata: Value,
    },
    List {
        agent_id: String,
        include_deleted: bool,
        limit: Option<usize>,
        cursor: Option<String>,
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
    MemorySearch {
        agent_id: String,
        query: String,
        limit: usize,
    },
    CreateSource {
        agent_id: String,
        workspace_id: String,
        kind: String,
        name: String,
        config: Value,
        source_id: Option<String>,
    },
    ListSources {
        agent_id: String,
        workspace_id: String,
    },
    IngestDocument {
        agent_id: String,
        workspace_id: String,
        source_id: String,
        path: String,
        content: String,
        metadata: Value,
    },
    DocumentList {
        agent_id: String,
        workspace_id: String,
        limit: usize,
    },
    DocumentGet {
        agent_id: String,
        workspace_id: String,
        id: String,
    },
    DocumentChunks {
        agent_id: String,
        workspace_id: String,
        id: String,
        limit: usize,
    },
    DocumentDelete {
        agent_id: String,
        workspace_id: String,
        id: String,
    },
    DeleteSource {
        agent_id: String,
        workspace_id: String,
        source_id: String,
    },
    DeleteSourceWithGeneration {
        agent_id: String,
        workspace_id: String,
        source_id: String,
        generation: Option<i64>,
    },
    AcquireSourceRemovalLease {
        agent_id: String,
        workspace_id: String,
        source_id: String,
        generation: Option<i64>,
    },
    FinalizeSourceRemoval {
        agent_id: String,
        workspace_id: String,
        source_id: String,
        generation: i64,
        lease_token: String,
    },
    SourceHealth {
        agent_id: String,
        workspace_id: String,
        source_id: String,
    },
    TranscriptImportCreate {
        agent_id: String,
        workspace_id: String,
        schema_id: String,
        duplicate_mode: String,
        files: Value,
    },
    TranscriptImportGet {
        agent_id: String,
        workspace_id: String,
        id: String,
    },
    TranscriptImportList {
        agent_id: String,
        workspace_id: String,
        limit: usize,
    },
    TranscriptImportFile {
        agent_id: String,
        workspace_id: String,
        job_id: String,
        file_id: String,
        generation: i64,
        action: String,
        offset: Option<i64>,
        length: Option<i64>,
        checksum: Option<String>,
        content: Vec<u8>,
    },
    TranscriptImportControl {
        agent_id: String,
        workspace_id: String,
        job_id: String,
        action: String,
    },
    TranscriptUpsert {
        agent_id: String,
        session_key: String,
        harness: String,
        project: Option<String>,
        content: String,
        idempotency_key: String,
    },
    TranscriptList {
        agent_id: String,
        limit: usize,
    },
    QueueDiagnostics {
        agent_id: String,
        workspace_id: String,
        cursor: Option<String>,
        limit: usize,
    },
    RepairRequeueRunning {
        agent_id: String,
        workspace_id: String,
    },
    IntegrityVerify {
        agent_id: String,
        workspace_id: String,
        project_id: Option<String>,
        visibility: String,
        budget: usize,
    },
    JobSubmit {
        agent_id: String,
        workspace_id: String,
        kind: String,
        payload: Value,
        deadline_at: Option<String>,
    },
    JobGet {
        agent_id: String,
        workspace_id: String,
        id: String,
    },
    JobCancel {
        agent_id: String,
        workspace_id: String,
        id: String,
        actor: String,
        reason: String,
    },
    JobList {
        agent_id: String,
        workspace_id: String,
        cursor: Option<String>,
        limit: usize,
    },
    JobEvents {
        agent_id: String,
        workspace_id: String,
        id: String,
        cursor: i64,
        limit: usize,
    },
    PipelineStatus {
        agent_id: String,
    },
    PipelineSetPaused {
        agent_id: String,
        paused: bool,
    },
    DreamStatus {
        agent_id: String,
    },
    DreamActivePasses {
        agent_id: String,
    },
    DreamTrigger {
        agent_id: String,
        workspace_id: String,
        payload: Value,
    },
    WorkerClaim,
    WorkerFinish {
        job: WorkerJob,
        state: String,
        error: Option<String>,
        result: Option<Value>,
    },
    OntologyList {
        agent_id: String,
        workspace_id: String,
        kind: String,
        limit: Option<usize>,
        cursor: Option<String>,
    },
    OntologyGet {
        agent_id: String,
        workspace_id: String,
        kind: String,
        id: String,
    },
    OntologyUpsert {
        agent_id: String,
        workspace_id: String,
        kind: String,
        id: Option<String>,
        value: Value,
    },
    OntologyDelete {
        agent_id: String,
        workspace_id: String,
        kind: String,
        id: String,
    },
    KnowledgeEntityCreate {
        agent_id: String,
        workspace_id: String,
        name: String,
        entity_type: String,
        metadata: Value,
    },
    KnowledgePinnedEntities {
        agent_id: String,
        workspace_id: String,
    },
    KnowledgeEntityPin {
        agent_id: String,
        workspace_id: String,
        entity_id: String,
        actor: String,
    },
    KnowledgeEntityUnpin {
        agent_id: String,
        workspace_id: String,
        entity_id: String,
        actor: String,
    },
    KnowledgeEntityList {
        agent_id: String,
        workspace_id: String,
        limit: usize,
        offset: usize,
    },
    KnowledgeSessionExpand {
        agent_id: String,
        workspace_id: String,
        project_id: Option<String>,
        entity_name: String,
        session_id: Option<String>,
        time_range: Option<String>,
        max_results: usize,
    },
    KnowledgeNavigationEntity {
        agent_id: String,
        workspace_id: String,
        name: String,
    },
    KnowledgeRelationCreate {
        agent_id: String,
        workspace_id: String,
        from_id: String,
        to_id: String,
        relation: String,
        metadata: Value,
    },
    KnowledgeRelations {
        agent_id: String,
        workspace_id: String,
        entity_id: String,
        limit: usize,
    },
    KnowledgeDependencies {
        agent_id: String,
        workspace_id: String,
        entity_id: String,
        limit: usize,
        direction: String,
    },
    KnowledgeAspectCreate {
        agent_id: String,
        workspace_id: String,
        entity_id: String,
        name: String,
        weight: f64,
    },
    KnowledgeAttributeCreate {
        agent_id: String,
        workspace_id: String,
        aspect_id: String,
        kind: String,
        content: String,
        claim_key: Option<String>,
        group_key: Option<String>,
        confidence: f64,
        importance: f64,
        memory_id: Option<String>,
    },
    KnowledgeEntityDetail {
        agent_id: String,
        workspace_id: String,
        entity_id: String,
    },
    KnowledgeAspects {
        agent_id: String,
        workspace_id: String,
        entity_id: String,
    },
    KnowledgeAttributes {
        agent_id: String,
        workspace_id: String,
        entity_id: String,
        aspect_id: String,
        limit: usize,
        offset: usize,
        kind: Option<String>,
        status: Option<String>,
    },
    KnowledgeStats {
        agent_id: String,
        workspace_id: String,
    },
    KnowledgeConstellation {
        agent_id: String,
        workspace_id: String,
        limit: usize,
    },
    KnowledgeTree {
        agent_id: String,
        workspace_id: String,
        entity_id: String,
        depth: usize,
        max_aspects: usize,
        max_groups: usize,
        max_claims: usize,
        max_attributes: usize,
    },
    KnowledgeNavigationAspects {
        agent_id: String,
        workspace_id: String,
        entity: String,
    },
    KnowledgeNavigationGroups {
        agent_id: String,
        workspace_id: String,
        entity: String,
        aspect: String,
    },
    KnowledgeNavigationClaims {
        agent_id: String,
        workspace_id: String,
        entity: String,
        aspect: String,
        group: String,
    },
    KnowledgeNavigationAttributes {
        agent_id: String,
        workspace_id: String,
        entity: String,
        aspect: String,
        group: String,
        claim: String,
        limit: usize,
        offset: usize,
        kind: Option<String>,
        status: Option<String>,
    },
    SessionStart {
        agent_id: String,
        key: String,
        harness: String,
        runtime_path: Option<String>,
        project: Option<String>,
    },
    SessionEnd {
        agent_id: String,
        key: String,
    },
    SessionList {
        agent_id: String,
        limit: usize,
    },
    HookDeliver {
        agent_id: String,
        key: Option<String>,
        hook: String,
        payload: Value,
    },
    EventList {
        agent_id: String,
        key: Option<String>,
        limit: usize,
    },
    TelemetryRecord {
        agent_id: String,
        workspace_id: String,
        event: String,
        payload: Value,
    },
    TelemetryList {
        agent_id: String,
        workspace_id: String,
        event: Option<String>,
        since: Option<String>,
        until: Option<String>,
        cursor: Option<i64>,
        limit: usize,
    },
    HookReceipt {
        agent_id: String,
        receipt_id: String,
        checkpoint: Option<String>,
        hook: String,
        session_key: Option<String>,
        payload: Value,
    },
    HookReceipts {
        agent_id: String,
        session_key: Option<String>,
        after_id: i64,
        limit: usize,
    },
    CrossAgentSend {
        agent_id: String,
        workspace_id: String,
        recipient_agent_id: String,
        kind: String,
        payload: Value,
    },
    CrossAgentList {
        agent_id: String,
        workspace_id: String,
        after_id: i64,
        limit: usize,
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

pub fn memory_content_context_eligible(content: &str) -> bool {
    let invisible = content.chars().any(|c| matches!(c, '\u{034f}' | '\u{00ad}' | '\u{061c}' | '\u{070f}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}' | '\u{2066}'..='\u{206f}' | '\u{feff}' | '\u{e0000}'..='\u{e007f}'));
    if invisible { return false; }
    let normalized: String = content.nfkc().collect();
    let lower = normalized.to_lowercase();
    let prompt = lower.contains("ignore previous instructions")
        || lower.contains("disregard prior instructions")
        || lower.contains("override the system")
        || lower.contains("new system instructions")
        || lower.contains("<system") || lower.contains("<developer") || lower.contains("<tool_call")
        || lower.contains("call the ") && lower.contains(" tool");
    let exfil = (lower.contains("reveal") || lower.contains("show") || lower.contains("send") || lower.contains("dump") || lower.contains("export"))
        && (lower.contains("system prompt") || lower.contains("secret") || lower.contains("password") || lower.contains("api key") || lower.contains("token") || lower.contains(".env") || lower.contains("/etc/passwd"));
    let creds = (lower.contains("enter") || lower.contains("paste") || lower.contains("provide") || lower.contains("share") || lower.contains("submit"))
        && (lower.contains("password") || lower.contains("api key") || lower.contains("token") || lower.contains("credential") || lower.contains("secret"));
    let shell = (lower.contains("curl ") || lower.contains("wget ")) && (lower.contains("| sh") || lower.contains("| bash"))
        || lower.contains("rm -rf /") || lower.contains("cat ~/.ssh/")
        || (lower.contains("printenv") && (lower.contains("curl") || lower.contains("wget") || lower.contains("upload")));
    if !(prompt || exfil || creds || shell) { return true; }
    let reporting = ["security guidance", "security analysis", "threat model", "defensive"];
    if reporting.iter().any(|m| lower.contains(m)) { return true; }
    if let Some(pos) = ["example", "illustration", "sample", "quoted", "detector", "scanner", "classification"].iter().filter_map(|m| lower.find(m)).min() {
        let before = &lower[..pos];
        let after = &lower[pos..];
        if (after.contains("says") || after.contains("should") || after.contains("flag") || after.contains("detect")) && before.len() < lower.len() { return true; }
    }
    false
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

fn canonical_workspace(value: &str) -> Result<String, CoreError> {
    bounded_text(
        if value.trim().is_empty() {
            "default"
        } else {
            value
        },
        "workspace id",
        256,
    )
}

fn bounded_text(value: &str, label: &str, max: usize) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.len() > max {
        return Err(CoreError::InvalidInput(format!(
            "{label} must be 1-{max} bytes"
        )));
    }
    Ok(value.to_owned())
}

fn validate_deadline(value: &str) -> Result<String, CoreError> {
    let value = bounded_text(value, "deadline_at", 64)?;
    let parsed = OffsetDateTime::parse(&value, &Rfc3339)
        .map_err(|_| CoreError::InvalidInput("deadline_at must be RFC3339".into()))?;
    parsed
        .format(&Rfc3339)
        .map_err(|_| CoreError::InvalidInput("deadline_at must be RFC3339".into()))
}

fn bounded_json(value: &Value) -> Result<String, CoreError> {
    let text = serde_json::to_string(value)?;
    if text.len() > 65_536 {
        return Err(CoreError::InvalidInput("metadata exceeds 64 KiB".into()));
    }
    Ok(text)
}

fn memory_search_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let memory = memory_row(row)?;
    let score: f64 = row.get(13)?;
    Ok(
        json!({"id":memory.id,"agentId":memory.agent_id,"content":memory.content,"metadata":memory.metadata,"deleted":memory.deleted,"createdAt":memory.created_at,"updatedAt":memory.updated_at,"sourceId":memory.source_id,"sourceType":memory.source_type,"sourcePath":memory.source_path,"runtimePath":memory.runtime_path,"idempotencyKey":memory.idempotency_key,"memoryKind":memory.memory_kind,"score":1.0/(1.0+score.abs())}),
    )
}

fn classify_memory_kind(source_type: Option<&str>) -> Option<&'static str> {
    match source_type {
        Some("extract" | "aggregate-recall" | "session_end" | "checkpoint" | "dreaming") => None,
        _ => Some("episodic"),
    }
}

fn optional_text(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<String>> {
    Ok(row.get::<_, String>(index).ok())
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
        source_id: optional_text(row, 7)?,
        source_type: optional_text(row, 8)?,
        source_path: optional_text(row, 9)?,
        runtime_path: optional_text(row, 10)?,
        idempotency_key: optional_text(row, 11)?,
        memory_kind: optional_text(row, 12)?,
    })
}

fn document_json_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let metadata: String = row.get(5)?;
    Ok(
        json!({"id":row.get::<_,String>(0)?,"agentId":row.get::<_,String>(1)?,"sourceId":row.get::<_,String>(2)?,"path":row.get::<_,String>(3)?,"content":row.get::<_,String>(4)?,"metadata":serde_json::from_str::<Value>(&metadata).unwrap_or(json!({})),"contentHash":row.get::<_,String>(6)?,"generation":row.get::<_,i64>(7)?,"status":"completed","createdAt":row.get::<_,Option<String>>(8)?,"updatedAt":row.get::<_,Option<String>>(9)?,"completeness":{"content":"complete","chunks":"derived","sourceIdentity":"complete"}}),
    )
}

fn source_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Source> {
    let config = row.get::<_, String>(5).unwrap_or_else(|_| "{}".into());
    Ok(Source {
        id: row.get(0)?,
        agent_id: row
            .get::<_, Option<String>>(1)?
            .unwrap_or_else(|| "default".into()),
        workspace_id: row
            .get::<_, Option<String>>(2)?
            .unwrap_or_else(|| "default".into()),
        kind: row.get(3)?,
        name: row.get(4).unwrap_or_default(),
        config: serde_json::from_str(&config).unwrap_or_else(|_| json!({})),
        created_at: row.get(6).ok(),
    })
}

fn reflection_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let patterns: String = row.get(3)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?, "date": row.get::<_, String>(1)?,
        "summary": row.get::<_, String>(2)?,
        "patterns": serde_json::from_str::<Value>(&patterns).unwrap_or_else(|_| json!([])),
        "question": row.get::<_, Option<String>>(4)?, "answer": row.get::<_, Option<String>>(5)?,
        "answerMemoryId": row.get::<_, Option<String>>(6)?, "createdAt": row.get::<_, String>(7)?,
        "answeredAt": row.get::<_, Option<String>>(8)?,
    }))
}

fn migrate(connection: &mut Connection) -> Result<(), CoreError> {
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT, checksum TEXT);
         CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, metadata TEXT NOT NULL DEFAULT '{}');
         CREATE TABLE IF NOT EXISTS cancellation_operations (agent_id TEXT NOT NULL, operation_id TEXT NOT NULL, outcome TEXT NOT NULL, content TEXT, created_at TEXT NOT NULL, PRIMARY KEY(agent_id,operation_id));
         CREATE TABLE IF NOT EXISTS sources (id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT 'default', workspace_id TEXT NOT NULL DEFAULT 'default', kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}', generation INTEGER NOT NULL DEFAULT 0, created_at TEXT, PRIMARY KEY(agent_id,workspace_id,id));
         CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', content_hash TEXT NOT NULL DEFAULT '', generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT);
         CREATE TABLE IF NOT EXISTS source_tombstones (agent_id TEXT NOT NULL, source_id TEXT NOT NULL, generation INTEGER NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY(agent_id,source_id));
         CREATE TABLE IF NOT EXISTS source_removal_leases (agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'default', source_id TEXT NOT NULL, generation INTEGER NOT NULL, lease_token TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(agent_id,workspace_id,source_id,status));
         CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL DEFAULT 'default', content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, superseded_by TEXT, superseded_at TEXT, superseded_reason TEXT, created_at TEXT, updated_at TEXT);
         CREATE TABLE IF NOT EXISTS memory_history (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, agent_id TEXT NOT NULL, operation TEXT NOT NULL, content TEXT, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS ontology_records (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS kg_entities (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL, entity_type TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS kg_relations (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'default', from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
         CREATE TABLE IF NOT EXISTS entity_aspects (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT 'default', workspace_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL, canonical_name TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS entity_attributes (id TEXT PRIMARY KEY, aspect_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT 'default', workspace_id TEXT NOT NULL DEFAULT 'default', memory_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, normalized_content TEXT NOT NULL, group_key TEXT, claim_key TEXT, confidence REAL NOT NULL DEFAULT 0, importance REAL NOT NULL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'active', superseded_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS entity_dependencies (id TEXT PRIMARY KEY, source_entity_id TEXT NOT NULL, target_entity_id TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'default', dependency_type TEXT NOT NULL, strength REAL NOT NULL, aspect_id TEXT, reason TEXT, status TEXT NOT NULL DEFAULT 'active', updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS kg_aspects (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, entity_id TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.5, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(agent_id,workspace_id,entity_id,canonical_name));
         CREATE TABLE IF NOT EXISTS kg_attributes (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, aspect_id TEXT NOT NULL, memory_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, normalized_content TEXT NOT NULL, claim_key TEXT, group_key TEXT, confidence REAL NOT NULL DEFAULT 0, importance REAL NOT NULL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'active', superseded_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS kg_entities_scope ON kg_entities(agent_id, name);
         CREATE INDEX IF NOT EXISTS kg_relations_scope ON kg_relations(agent_id, from_id, to_id);

         CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'default', kind TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', result TEXT, error TEXT, deadline_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS jobs_agent_state ON jobs(agent_id, state, created_at);
         CREATE TABLE IF NOT EXISTS job_cancellations (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, agent_id TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, provenance TEXT NOT NULL, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS job_events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, agent_id TEXT NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS pipeline_state (agent_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'idle', paused INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS sessions (key TEXT NOT NULL, agent_id TEXT NOT NULL, harness TEXT NOT NULL, runtime_path TEXT, project TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, PRIMARY KEY(key, agent_id));
         CREATE TABLE IF NOT EXISTS event_records (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, session_key TEXT, event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS telemetry_events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS transcript_import_jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'default', schema_id TEXT NOT NULL, duplicate_mode TEXT NOT NULL, state TEXT NOT NULL, files TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS transcript_import_files (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'default', ordinal INTEGER NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, storage_state TEXT NOT NULL, upload_generation INTEGER NOT NULL DEFAULT 0, upload_offset INTEGER NOT NULL DEFAULT 0, upload_size INTEGER, upload_digest TEXT NOT NULL DEFAULT '', content_hash TEXT, size_bytes INTEGER NOT NULL DEFAULT 0, content BLOB NOT NULL DEFAULT x'', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS transcript_import_files_scope ON transcript_import_files(job_id,agent_id,ordinal);
         CREATE TABLE IF NOT EXISTS session_transcripts (session_key TEXT NOT NULL, agent_id TEXT NOT NULL, harness TEXT NOT NULL, project TEXT, content TEXT NOT NULL, content_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, PRIMARY KEY(agent_id, session_key));
         CREATE TABLE IF NOT EXISTS session_summaries (id TEXT PRIMARY KEY, project TEXT, depth INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, content TEXT NOT NULL, token_count INTEGER, earliest_at TEXT NOT NULL, latest_at TEXT NOT NULL, session_key TEXT, harness TEXT, agent_id TEXT NOT NULL DEFAULT 'default', source_type TEXT, source_ref TEXT, meta_json TEXT, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS session_summary_memories (summary_id TEXT NOT NULL, memory_id TEXT NOT NULL, PRIMARY KEY(summary_id,memory_id));
         CREATE TABLE IF NOT EXISTS memory_entity_mentions (memory_id TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY(memory_id,entity_id));
         CREATE INDEX IF NOT EXISTS event_records_scope ON event_records(agent_id, session_key, id);
         CREATE TABLE IF NOT EXISTS hook_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_key TEXT, hook TEXT NOT NULL, checkpoint TEXT, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, UNIQUE(agent_id, receipt_id));
         CREATE INDEX IF NOT EXISTS hook_receipts_scope ON hook_receipts(agent_id, session_key, id);
         CREATE TABLE IF NOT EXISTS cross_agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, sender_agent_id TEXT NOT NULL, recipient_agent_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS daily_reflections (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL DEFAULT 'default', date TEXT NOT NULL, summary TEXT NOT NULL, patterns TEXT NOT NULL DEFAULT '[]', question TEXT, answer TEXT, answer_memory_id TEXT, memory_ids TEXT NOT NULL DEFAULT '[]', summary_ids TEXT NOT NULL DEFAULT '[]', model TEXT, created_at TEXT NOT NULL, answered_at TEXT, content_key TEXT);
         CREATE INDEX IF NOT EXISTS daily_reflections_agent_created ON daily_reflections(agent_id, created_at DESC);
         CREATE INDEX IF NOT EXISTS daily_reflections_agent_date ON daily_reflections(agent_id, date, created_at DESC);

         CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, prefix TEXT NOT NULL UNIQUE, name TEXT NOT NULL, key_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'agent', scope_json TEXT NOT NULL DEFAULT '{}', permissions_json TEXT NOT NULL DEFAULT '[]', connector TEXT, harness TEXT, agent_id TEXT, allowed_projects_json TEXT, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, expires_at TEXT);
         CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, value TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(agent_id,workspace_id,name));
         SELECT 1;",
    )?;
    let max_schema_version: Option<i64> =
        transaction.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })?;
    if max_schema_version.unwrap_or(0) > 2 {
        return Err(CoreError::UnsupportedMigrationHistory(format!(
            "schema_migrations version {} is newer than Rust core compatibility (2)",
            max_schema_version.unwrap()
        )));
    }

    // Legacy TypeScript-era knowledge tables may predate scope and query columns.
    // Add/backfill them before creating dependent indexes or serving queries.
    ensure_column(
        &transaction,
        "entities",
        "agent_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    ensure_column(
        &transaction,
        "entities",
        "workspace_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    ensure_column(
        &transaction,
        "entities",
        "status",
        "TEXT NOT NULL DEFAULT 'active'",
    )?;
    ensure_column(&transaction, "entities", "canonical_name", "TEXT")?;
    ensure_column(
        &transaction,
        "entities",
        "entity_type",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(&transaction, "entities", "description", "TEXT")?;
    ensure_column(
        &transaction,
        "entities",
        "mentions",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &transaction,
        "entities",
        "pinned",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(&transaction, "entities", "pinned_at", "TEXT")?;
    ensure_column(&transaction, "entities", "archived_at", "TEXT")?;
    ensure_column(&transaction, "entities", "archived_by", "TEXT")?;
    ensure_column(&transaction, "entities", "archive_reason", "TEXT")?;
    ensure_column(&transaction, "entities", "proposal_id", "TEXT")?;
    ensure_column(
        &transaction,
        "entities",
        "proposal_evidence",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(
        &transaction,
        "entities",
        "created_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &transaction,
        "entities",
        "updated_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &transaction,
        "entity_dependencies",
        "agent_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    ensure_column(
        &transaction,
        "entity_dependencies",
        "workspace_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    ensure_column(&transaction, "entity_dependencies", "aspect_id", "TEXT")?;
    ensure_column(&transaction, "entity_dependencies", "reason", "TEXT")?;
    ensure_column(
        &transaction,
        "entity_dependencies",
        "status",
        "TEXT NOT NULL DEFAULT 'active'",
    )?;
    ensure_column(
        &transaction,
        "entity_dependencies",
        "updated_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    transaction.execute(
        "UPDATE entities SET agent_id='default' WHERE agent_id IS NULL OR trim(agent_id)=''",
        [],
    )?;
    transaction.execute("UPDATE entities SET workspace_id='default' WHERE workspace_id IS NULL OR trim(workspace_id)=''", [])?;
    transaction.execute(
        "UPDATE entities SET status='active' WHERE status IS NULL OR trim(status)=''",
        [],
    )?;
    transaction.execute("UPDATE entity_dependencies SET agent_id='default' WHERE agent_id IS NULL OR trim(agent_id)=''", [])?;
    transaction.execute("UPDATE entity_dependencies SET workspace_id='default' WHERE workspace_id IS NULL OR trim(workspace_id)=''", [])?;
    transaction.execute(
        "UPDATE entity_dependencies SET status='active' WHERE status IS NULL OR trim(status)=''",
        [],
    )?;
    transaction.execute(
        "UPDATE entity_dependencies SET updated_at='1970-01-01T00:00:00Z' WHERE updated_at IS NULL OR trim(updated_at)=''",
        [],
    )?;
    transaction.execute("CREATE INDEX IF NOT EXISTS entity_dependencies_scope ON entity_dependencies(agent_id,workspace_id,source_entity_id,target_entity_id)", [])?;
    ensure_column(&transaction, "schema_migrations", "applied_at", "TEXT")?;
    ensure_column(
        &transaction,
        "telemetry_events",
        "agent_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    ensure_column(
        &transaction,
        "telemetry_events",
        "workspace_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    ensure_column(
        &transaction,
        "telemetry_events",
        "payload",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    ensure_column(
        &transaction,
        "telemetry_events",
        "created_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    if has_column(&transaction, "telemetry_events", "timestamp")? {
        transaction.execute(
            "UPDATE telemetry_events SET created_at=timestamp WHERE created_at='' AND timestamp IS NOT NULL",
            [],
        )?;
    }
    transaction.execute_batch(
        "CREATE INDEX IF NOT EXISTS telemetry_events_scope ON telemetry_events(agent_id,workspace_id,id);",
    )?;
    ensure_column(&transaction, "sources", "workspace_id", "TEXT")?;
    ensure_column(
        &transaction,
        "jobs",
        "workspace_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    ensure_column(
        &transaction,
        "kg_entities",
        "workspace_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    ensure_column(
        &transaction,
        "kg_entities",
        "deleted",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &transaction,
        "kg_relations",
        "workspace_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    ensure_column(
        &transaction,
        "kg_relations",
        "deleted",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &transaction,
        "ontology_records",
        "workspace_id",
        "TEXT DEFAULT 'default'",
    )?;
    ensure_column(
        &transaction,
        "kg_aspects",
        "workspace_id",
        "TEXT DEFAULT 'default'",
    )?;
    ensure_column(
        &transaction,
        "kg_attributes",
        "workspace_id",
        "TEXT DEFAULT 'default'",
    )?;
    ensure_column(
        &transaction,
        "cross_agent_messages",
        "workspace_id",
        "TEXT DEFAULT 'default'",
    )?;
    transaction.execute("UPDATE ontology_records SET workspace_id='default' WHERE workspace_id IS NULL OR trim(workspace_id)=''", [])?;
    transaction.execute("UPDATE kg_aspects SET workspace_id='default' WHERE workspace_id IS NULL OR trim(workspace_id)=''", [])?;
    transaction.execute("UPDATE kg_attributes SET workspace_id='default' WHERE workspace_id IS NULL OR trim(workspace_id)=''", [])?;
    transaction.execute("UPDATE cross_agent_messages SET workspace_id='default' WHERE workspace_id IS NULL OR trim(workspace_id)=''", [])?;
    transaction.execute("CREATE INDEX IF NOT EXISTS ontology_scope_idx ON ontology_records(agent_id, workspace_id, kind, deleted)", [])?;
    transaction.execute("CREATE INDEX IF NOT EXISTS cross_agent_messages_scope ON cross_agent_messages(workspace_id, recipient_agent_id, id)", [])?;
    ensure_column(
        &transaction,
        "session_transcripts",
        "idempotency_key",
        "TEXT",
    )?;
    transaction.execute(
        "UPDATE session_transcripts
         SET idempotency_key = CASE
           WHEN idempotency_key IS NOT NULL AND trim(idempotency_key) <> ''
                AND NOT EXISTS (SELECT 1 FROM session_transcripts prior
                                WHERE prior.agent_id=session_transcripts.agent_id
                                  AND prior.idempotency_key=session_transcripts.idempotency_key
                                  AND prior.rowid < session_transcripts.rowid)
             THEN trim(idempotency_key)
           ELSE printf('legacy:%lld', rowid)
         END
         WHERE idempotency_key IS NULL OR trim(idempotency_key) = ''
            OR EXISTS (SELECT 1 FROM session_transcripts prior
                       WHERE prior.agent_id=session_transcripts.agent_id
                         AND prior.idempotency_key=session_transcripts.idempotency_key
                         AND prior.rowid < session_transcripts.rowid)",
        [],
    )?;
    transaction.execute("CREATE UNIQUE INDEX IF NOT EXISTS session_transcripts_idempotency ON session_transcripts(agent_id, idempotency_key)", [])?;
    transaction.execute("CREATE TABLE IF NOT EXISTS kg_aspects (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, entity_id TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.5, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(agent_id,workspace_id,entity_id,canonical_name))", [])?;
    transaction.execute("CREATE TABLE IF NOT EXISTS kg_attributes (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, aspect_id TEXT NOT NULL, memory_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, normalized_content TEXT NOT NULL, claim_key TEXT, group_key TEXT, confidence REAL NOT NULL DEFAULT 0, importance REAL NOT NULL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'active', superseded_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)", [])?;
    transaction.execute("CREATE INDEX IF NOT EXISTS kg_aspects_scope ON kg_aspects(agent_id,workspace_id,entity_id)", [])?;
    transaction.execute("CREATE INDEX IF NOT EXISTS kg_attributes_scope ON kg_attributes(agent_id,workspace_id,aspect_id,status)", [])?;
    transaction.execute("UPDATE kg_entities SET workspace_id='default' WHERE workspace_id IS NULL OR trim(workspace_id)=''", [])?;
    transaction.execute("UPDATE kg_relations SET workspace_id='default' WHERE workspace_id IS NULL OR trim(workspace_id)=''", [])?;
    transaction.execute("UPDATE kg_entities SET deleted=0 WHERE deleted IS NULL", [])?;
    transaction.execute(
        "UPDATE kg_relations SET deleted=0 WHERE deleted IS NULL",
        [],
    )?;
    ensure_column(&transaction, "memories", "source_id", "TEXT")?;
    ensure_column(&transaction, "memories", "source_type", "TEXT")?;
    ensure_column(&transaction, "memories", "source_path", "TEXT")?;
    ensure_column(&transaction, "memories", "runtime_path", "TEXT")?;
    ensure_column(&transaction, "memories", "idempotency_key", "TEXT")?;
    ensure_column(&transaction, "memories", "memory_kind", "TEXT")?;
    ensure_column(
        &transaction,
        "memories",
        "metadata",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    // Preserve provenance from legacy TypeScript column names before serving rows.
    if has_column(&transaction, "memories", "source")? {
        transaction.execute("UPDATE memories SET source_id=COALESCE(NULLIF(source_id,''),source) WHERE source IS NOT NULL", [])?;
    }
    if has_column(&transaction, "memories", "accessed_at")? {
        transaction.execute("UPDATE memories SET source_path=COALESCE(NULLIF(source_path,''),accessed_at) WHERE accessed_at IS NOT NULL", [])?;
    }
    transaction.execute("UPDATE memories SET source_id=COALESCE(NULLIF(source_id,''),json_extract(metadata,'$.sourceId'),json_extract(metadata,'$.source_id')), source_type=COALESCE(NULLIF(source_type,''),json_extract(metadata,'$.sourceType'),json_extract(metadata,'$.source_type')), source_path=COALESCE(NULLIF(source_path,''),json_extract(metadata,'$.sourcePath'),json_extract(metadata,'$.source_path')), runtime_path=COALESCE(NULLIF(runtime_path,''),json_extract(metadata,'$.runtimePath'),json_extract(metadata,'$.runtime_path')), idempotency_key=COALESCE(NULLIF(idempotency_key,''),json_extract(metadata,'$.idempotencyKey'),json_extract(metadata,'$.idempotency_key')) WHERE metadata IS NOT NULL", [])?;
    transaction.execute("UPDATE memories SET memory_kind=CASE WHEN source_type IN ('extract','aggregate-recall','session_end','checkpoint','dreaming') THEN NULL ELSE 'episodic' END WHERE memory_kind IS NULL", [])?;
    if has_table(&transaction, "entity_attributes")?
        && has_column(&transaction, "entity_attributes", "memory_id")?
    {
        transaction.execute(
            "UPDATE memories SET memory_kind='derived' WHERE id IN (SELECT memory_id FROM entity_attributes WHERE memory_id IS NOT NULL)",
            [],
        )?;
    }
    ensure_column(&transaction, "schema_migrations", "checksum", "TEXT")?;
    ensure_column(&transaction, "memories", "superseded_by", "TEXT")?;
    ensure_column(&transaction, "memories", "superseded_at", "TEXT")?;
    ensure_column(&transaction, "memories", "superseded_reason", "TEXT")?;
    ensure_column(
        &transaction,
        "api_keys",
        "permissions_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(&transaction, "api_keys", "connector", "TEXT")?;
    ensure_column(&transaction, "api_keys", "harness", "TEXT")?;
    ensure_column(&transaction, "api_keys", "agent_id", "TEXT")?;
    ensure_column(&transaction, "api_keys", "revoked_at", "TEXT")?;
    ensure_column(&transaction, "api_keys", "expires_at", "TEXT")?;
    ensure_column(&transaction, "api_keys", "allowed_projects_json", "TEXT")?;
    ensure_column(
        &transaction,
        "secrets",
        "deleted",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    transaction.execute(
        "CREATE INDEX IF NOT EXISTS api_keys_scope ON api_keys(agent_id, revoked_at, expires_at)",
        [],
    )?;
    transaction.execute(
        "CREATE INDEX IF NOT EXISTS secrets_scope ON secrets(agent_id,workspace_id,deleted)",
        [],
    )?;
    ensure_column(
        &transaction,
        "sources",
        "agent_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    ensure_column(&transaction, "sources", "name", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(
        &transaction,
        "sources",
        "config",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    ensure_column(
        &transaction,
        "sources",
        "metadata",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    ensure_column(
        &transaction,
        "sources",
        "generation",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &transaction,
        "documents",
        "content_hash",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &transaction,
        "documents",
        "generation",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(&transaction, "documents", "updated_at", "TEXT")?;
    ensure_column(
        &transaction,
        "documents",
        "workspace_id",
        "TEXT DEFAULT 'default'",
    )?;
    const DOCUMENT_SCOPE_BACKFILL_CHECKSUM: &str = "document-workspace-backfill-v1";
    let document_scope_backfill: Option<String> = transaction
        .query_row(
            "SELECT checksum FROM schema_migrations WHERE version=2",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let documents_need_scope_backfill: i64 = transaction.query_row(
        "SELECT count(*) FROM documents WHERE workspace_id IS NULL OR trim(workspace_id) = ''",
        [],
        |row| row.get(0),
    )?;
    if document_scope_backfill.as_deref() != Some(DOCUMENT_SCOPE_BACKFILL_CHECKSUM)
        || documents_need_scope_backfill > 0
    {
        transaction.execute(
            "UPDATE documents SET workspace_id = CASE WHEN json_valid(metadata) AND json_type(metadata,'$._workspaceId')='text' AND trim(json_extract(metadata,'$._workspaceId')) <> '' THEN trim(json_extract(metadata,'$._workspaceId')) ELSE 'default' END",
            [],
        )?;
        transaction.execute(
            "INSERT INTO schema_migrations(version, applied_at, checksum) VALUES (2, datetime('now'), 'document-workspace-backfill-v1') ON CONFLICT(version) DO UPDATE SET applied_at=excluded.applied_at, checksum=excluded.checksum",
            [],
        )?;
    }
    ensure_column(&transaction, "sources", "created_at", "TEXT")?;
    ensure_column(
        &transaction,
        "documents",
        "agent_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    ensure_column(
        &transaction,
        "documents",
        "path",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &transaction,
        "documents",
        "content",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &transaction,
        "documents",
        "metadata",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    ensure_column(&transaction, "documents", "created_at", "TEXT")?;
    transaction.execute("CREATE INDEX IF NOT EXISTS documents_source_path ON documents(agent_id,workspace_id,source_id,path)", [])?;
    let source_identity_dirty: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM sources WHERE agent_id IS NULL OR trim(agent_id) = '' OR workspace_id IS NULL OR trim(workspace_id) = '')",
        [],
        |row| row.get::<_, i64>(0),
    )? != 0;
    let source_pk: Vec<String> = {
        let mut stmt = transaction.prepare("PRAGMA table_info(sources)")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .filter(|(pk, _)| *pk > 0)
            .map(|(_, name)| name)
            .collect()
    };
    let mut actual_source_pk = source_pk;
    actual_source_pk.sort();
    let mut required_source_pk = vec![
        "agent_id".to_owned(),
        "workspace_id".to_owned(),
        "id".to_owned(),
    ];
    required_source_pk.sort();
    let source_has_metadata: bool = {
        let mut stmt = transaction.prepare("PRAGMA table_info(sources)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        columns.iter().any(|name| name == "metadata")
    };
    if actual_source_pk != required_source_pk || source_identity_dirty {
        transaction.execute_batch(
            "ALTER TABLE sources RENAME TO sources_legacy;
             CREATE TABLE sources (id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT 'default', workspace_id TEXT NOT NULL DEFAULT 'default', kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}', generation INTEGER NOT NULL DEFAULT 0, created_at TEXT, PRIMARY KEY(agent_id,workspace_id,id));",
        )?;
        let config_expression = if source_has_metadata {
            "COALESCE(NULLIF(trim(s.config),''), NULLIF(trim(s.metadata),''), (SELECT NULLIF(trim(l.metadata),'') FROM sources_legacy l WHERE l.id=s.id AND COALESCE(NULLIF(trim(l.agent_id),''),'default')=COALESCE(NULLIF(trim(s.agent_id),''),'default') AND COALESCE(NULLIF(trim(l.workspace_id),''),'default')=COALESCE(NULLIF(trim(s.workspace_id),''),'default') AND NULLIF(trim(l.metadata),'') IS NOT NULL ORDER BY COALESCE(l.generation,0) DESC, l.created_at DESC, l.rowid DESC LIMIT 1), '{}')"
        } else {
            "COALESCE(NULLIF(trim(s.config),''), '{}')"
        };
        transaction.execute(
            &format!(
                "WITH ranked AS (SELECT s.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(NULLIF(trim(agent_id),''),'default'), COALESCE(NULLIF(trim(workspace_id),''),'default'), id ORDER BY COALESCE(generation,0) DESC, created_at DESC, rowid DESC) AS rn FROM sources_legacy s)
                 INSERT INTO sources(id,agent_id,workspace_id,kind,name,config,generation,created_at)
                 SELECT id,COALESCE(NULLIF(trim(agent_id),''),'default'),COALESCE(NULLIF(trim(workspace_id),''),'default'),kind,COALESCE(name,''),{},COALESCE(generation,0),created_at FROM ranked s WHERE rn=1",
                config_expression
            ),
            [],
        )?;
        transaction.execute_batch("DROP TABLE sources_legacy;")?;
    }

    ensure_column(
        &transaction,
        "source_tombstones",
        "workspace_id",
        "TEXT DEFAULT 'default'",
    )?;

    let tombstone_pk: Vec<String> = {
        let mut stmt = transaction.prepare("PRAGMA table_info(source_tombstones)")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .filter(|(pk, _)| *pk > 0)
            .map(|(_, name)| name)
            .collect()
    };
    let tombstones_dirty: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM source_tombstones WHERE workspace_id IS NULL OR trim(workspace_id)='')", [], |r| r.get::<_, i64>(0))? != 0;
    let mut actual_pk = tombstone_pk.clone();
    actual_pk.sort();
    let mut required_pk = vec![
        "agent_id".to_owned(),
        "workspace_id".to_owned(),
        "source_id".to_owned(),
    ];
    required_pk.sort();
    if actual_pk != required_pk || tombstones_dirty {
        transaction.execute_batch("ALTER TABLE source_tombstones RENAME TO source_tombstones_legacy; CREATE TABLE source_tombstones (agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'default', source_id TEXT NOT NULL, generation INTEGER NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY(agent_id,workspace_id,source_id));")?;
        transaction.execute("INSERT INTO source_tombstones(agent_id,workspace_id,source_id,generation,deleted_at) SELECT agent_id,COALESCE(NULLIF(trim(workspace_id),''),'default'),source_id,MAX(generation),MAX(deleted_at) FROM source_tombstones_legacy GROUP BY agent_id,COALESCE(NULLIF(trim(workspace_id),''),'default'),source_id", [])?;
        transaction.execute("DROP TABLE source_tombstones_legacy", [])?;
    }

    transaction.execute(
        "UPDATE sources SET config = COALESCE(config, '{}') WHERE config IS NULL OR trim(config) = ''",
        [],
    )?;
    transaction.execute(
        "UPDATE sources SET created_at = datetime('now') WHERE created_at IS NULL OR trim(created_at) = ''",
        [],
    )?;
    transaction.execute(
        "UPDATE documents SET agent_id = 'default' WHERE agent_id IS NULL OR trim(agent_id) = ''",
        [],
    )?;
    transaction.execute(
        "UPDATE documents SET metadata = '{}' WHERE metadata IS NULL OR trim(metadata) = ''",
        [],
    )?;
    transaction.execute(
        "UPDATE documents SET created_at = datetime('now') WHERE created_at IS NULL OR trim(created_at) = ''",
        [],
    )?;
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
    let max_schema_version: Option<i64> =
        transaction.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })?;
    if max_schema_version.unwrap_or(0) > 2 {
        return Err(CoreError::UnsupportedMigrationHistory(format!(
            "schema_migrations version {} is newer than Rust core compatibility (2)",
            max_schema_version.unwrap()
        )));
    }
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

fn has_table(transaction: &Transaction<'_>, table: &str) -> Result<bool, CoreError> {
    Ok(transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
        [table],
        |row| row.get::<_, i64>(0),
    )? != 0)
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

#[cfg(test)]
mod daily_log_date_tests {
    use super::valid_daily_log_date;

    #[test]
    fn accepts_year_zero_from_typescript_contract() {
        assert!(valid_daily_log_date("0000-01-01.md"));
    }

    #[test]
    fn rejects_non_decimal_date_fields() {
        for name in [
            "+001-01-01.md",
            "202a-01-01.md",
            "2024-0a-01.md",
            "2024-01-0a.md",
        ] {
            assert!(!valid_daily_log_date(name), "accepted {name}");
        }
    }
}
