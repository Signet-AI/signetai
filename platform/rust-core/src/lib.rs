use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Source {
    pub id: String,
    pub agent_id: String,
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

    pub fn create_source(
        &self,
        agent: &str,
        kind: &str,
        name: &str,
        config: Value,
    ) -> Result<Source, CoreError> {
        let agent = required_agent(agent)?;
        let kind = required_id(kind)?;
        let name = required_id(name)?;
        self.call(move |connection| { let id = uuid::Uuid::new_v4().to_string(); let config = serde_json::to_string(&config)?;
            connection.execute("INSERT INTO sources (id, agent_id, kind, name, config, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))", params![id, agent, kind, name, config])?;
            Ok(Source { id, agent_id: agent, kind, name, config: serde_json::from_str(&config)?, created_at: Some(String::new()) }) })
    }

    pub fn list_sources(&self, agent: &str) -> Result<Vec<Source>, CoreError> {
        let agent = required_agent(agent)?;
        self.call(move |c| { let mut s=c.prepare("SELECT id,agent_id,kind,name,config,created_at FROM sources WHERE agent_id=? ORDER BY rowid DESC")?; let rows=s.query_map(params![agent], |r| Ok(Source{id:r.get(0)?,agent_id:r.get(1)?,kind:r.get(2)?,name:r.get(3)?,config:serde_json::from_str(&r.get::<_,String>(4)?).unwrap_or(json!({})),created_at:r.get(5).ok()}))?; Ok(rows.collect::<Result<Vec<_>,_>>()?) })
    }

    pub fn ingest_document(&self, agent: &str, input: DocumentInput) -> Result<String, CoreError> {
        let agent = required_agent(agent)?;
        if input.content.trim().is_empty() {
            return Err(CoreError::InvalidInput("content must not be empty".into()));
        }
        self.call(move |c| { let exists:i64=c.query_row("SELECT count(*) FROM sources WHERE id=? AND agent_id=?",params![input.source_id,agent],|r|r.get(0))?; if exists==0{return Err(CoreError::NotFound)} let id=uuid::Uuid::new_v4().to_string(); let metadata=serde_json::to_string(&input.metadata)?; c.execute("INSERT INTO documents (id,agent_id,source_id,path,content,metadata,created_at) VALUES (?,?,?,?,?,?,datetime('now'))",params![id,agent,input.source_id,input.path,input.content,metadata])?; Ok(id) })
    }

    pub fn submit(&self, operation: Operation) -> Result<Value, CoreError> {
        self.call(move |connection| execute_operation(connection, operation))
    }
}

fn execute_operation(
    connection: &mut Connection,
    operation: Operation,
) -> Result<Value, CoreError> {
    match operation {
        Operation::JobSubmit {
            agent_id,
            kind,
            payload,
            deadline_at,
        } => {
            let agent_id = required_agent(&agent_id)?;
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
            connection.execute("INSERT INTO jobs (id,agent_id,kind,state,payload,deadline_at,created_at,updated_at) VALUES (?,?,?,'queued',?,?,datetime('now'),datetime('now'))", params![id,agent_id,kind,payload,deadline_at])?;
            connection.execute("INSERT INTO job_events (job_id,agent_id,event,data,created_at) VALUES (?,?, 'queued','{}',datetime('now'))", params![id,agent_id])?;
            Ok(json!({"id":id,"state":"queued"}))
        }
        Operation::JobGet { agent_id, id } => {
            let value: Option<String> = connection.query_row("SELECT json_object('id',id,'agent_id',agent_id,'kind',kind,'state',state,'payload',json(payload),'result',CASE WHEN result IS NULL THEN NULL ELSE json(result) END,'error',error,'deadline_at',deadline_at,'created_at',created_at,'updated_at',updated_at) FROM jobs WHERE id=? AND agent_id=?", params![id,agent_id], |r| r.get(0)).optional()?;
            value
                .map(|v| serde_json::from_str(&v))
                .transpose()?
                .ok_or(CoreError::NotFound)
        }
        Operation::JobCancel { agent_id, id } => {
            let changed = connection.execute("UPDATE jobs SET state=CASE WHEN state IN ('queued','running') THEN 'cancelled' ELSE state END, updated_at=datetime('now') WHERE id=? AND agent_id=? AND state IN ('queued','running')", params![id,agent_id])?;
            if changed == 0 {
                return Err(CoreError::NotFound);
            }
            connection.execute("INSERT INTO job_events (job_id,agent_id,event,data,created_at) VALUES (?,?, 'cancelled','{}',datetime('now'))", params![id,agent_id])?;
            Ok(json!({"id":id,"state":"cancelled"}))
        }
        Operation::JobList { agent_id, limit } => {
            let mut s=connection.prepare("SELECT json_object('id',id,'kind',kind,'state',state,'error',error,'created_at',created_at,'updated_at',updated_at) FROM jobs WHERE agent_id=? ORDER BY created_at DESC LIMIT ?")?;
            let rows = s.query_map(params![agent_id, limit.clamp(1, 100) as i64], |r| {
                r.get::<_, String>(0)
            })?;
            let values = rows
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|v| serde_json::from_str(&v))
                .collect::<Result<Vec<Value>, _>>()?;
            Ok(json!(values))
        }
        Operation::JobEvents { agent_id, id } => {
            let mut s=connection.prepare("SELECT json_object('event',event,'data',json(data),'created_at',created_at) FROM job_events WHERE job_id=? AND agent_id=? ORDER BY id")?;
            let rows = s.query_map(params![id, agent_id], |r| r.get::<_, String>(0))?;
            let values = rows
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|v| serde_json::from_str(&v))
                .collect::<Result<Vec<Value>, _>>()?;
            Ok(json!(values))
        }
        Operation::Health => {
            let value: i64 = connection.query_row("SELECT 1", [], |row| row.get(0))?;
            Ok(json!({ "ready": value == 1 }))
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
            let metadata = serde_json::to_string(&metadata)?;
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO memories (id, agent_id, content, metadata, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))",
                params![id, agent_id, content, metadata],
            )?;
            record_history(&transaction, &id, &agent_id, "remember", None)?;
            transaction.commit()?;
            Ok(json!({ "id": id }))
        }
        Operation::List {
            agent_id,
            include_deleted,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let mut statement = connection.prepare(
                "SELECT id, agent_id, content, metadata, deleted, created_at, updated_at
                 FROM memories
                 WHERE COALESCE(agent_id, 'default') = ? AND (? OR deleted = 0)
                 ORDER BY rowid DESC LIMIT 10000",
            )?;
            let rows =
                statement.query_map(params![agent_id, include_deleted as i64], memory_row)?;
            Ok(serde_json::to_value(rows.collect::<Result<Vec<_>, _>>()?)?)
        }
        Operation::Get { agent_id, id } => {
            let agent_id = required_agent(&agent_id)?;
            let id = required_id(&id)?;
            let memory = connection
                .query_row(
                    "SELECT id, agent_id, content, metadata, deleted, created_at, updated_at
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
            let metadata = serde_json::to_string(&metadata)?;
            let transaction = connection.transaction()?;
            let changed = transaction.execute(
                "UPDATE memories SET content = ?, metadata = ?, updated_at = datetime('now')
                 WHERE id = ? AND COALESCE(agent_id, 'default') = ? AND deleted = 0",
                params![content, metadata, id, agent_id],
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
                "SELECT id, agent_id, content, metadata, deleted, created_at, updated_at
                 FROM memories
                 WHERE COALESCE(agent_id, 'default') = ? AND deleted = 0 AND content LIKE ?
                 ORDER BY rowid DESC LIMIT 1000",
            )?;
            let rows = statement.query_map(params![agent_id, format!("%{query}%")], memory_row)?;
            Ok(serde_json::to_value(rows.collect::<Result<Vec<_>, _>>()?)?)
        }
        Operation::CreateSource {
            agent_id,
            kind,
            name,
            config,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let kind = required_id(&kind)?;
            let name = required_id(&name)?;
            let config_text = serde_json::to_string(&config)?;
            let id = uuid::Uuid::new_v4().to_string();
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO sources (id, agent_id, kind, name, config, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
                params![id, agent_id, kind, name, config_text],
            )?;
            let source = transaction.query_row(
                "SELECT id, agent_id, kind, name, config, created_at FROM sources WHERE id = ? AND agent_id = ?",
                params![id, agent_id],
                source_row,
            )?;
            transaction.commit()?;
            Ok(serde_json::to_value(source)?)
        }
        Operation::ListSources { agent_id } => {
            let agent_id = required_agent(&agent_id)?;
            let mut statement = connection.prepare(
                "SELECT id, agent_id, kind, name, config, created_at FROM sources WHERE agent_id = ? ORDER BY rowid DESC",
            )?;
            let rows = statement.query_map(params![agent_id], source_row)?;
            Ok(serde_json::to_value(rows.collect::<Result<Vec<_>, _>>()?)?)
        }
        Operation::IngestDocument {
            agent_id,
            source_id,
            path,
            content,
            metadata,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let source_id = required_id(&source_id)?;
            let path = required_id(&path)?;
            if content.trim().is_empty() {
                return Err(CoreError::InvalidInput("content must not be empty".into()));
            }
            let metadata = serde_json::to_string(&metadata)?;
            let id = uuid::Uuid::new_v4().to_string();
            let transaction = connection.transaction()?;
            let source_exists: i64 = transaction.query_row(
                "SELECT count(*) FROM sources WHERE id = ? AND agent_id = ?",
                params![source_id, agent_id],
                |row| row.get(0),
            )?;
            if source_exists == 0 {
                return Err(CoreError::NotFound);
            }
            transaction.execute(
                "INSERT INTO documents (id, agent_id, source_id, path, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
                params![id, agent_id, source_id, path, content, metadata],
            )?;
            transaction.commit()?;
            Ok(json!({ "id": id }))
        }
        Operation::OntologyList {
            agent_id,
            workspace_id,
            kind,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = required_id(&workspace_id)?;
            let kind = required_id(&kind)?;
            let mut s = connection.prepare("SELECT id, value, created_at, updated_at FROM ontology_records WHERE agent_id=? AND workspace_id=? AND kind=? AND deleted=0 ORDER BY rowid DESC")?;
            let rows = s.query_map(params![agent_id, workspace_id, kind], |r| Ok(json!({"id":r.get::<_,String>(0)?,"value":serde_json::from_str::<Value>(&r.get::<_,String>(1)?).unwrap_or(json!({})),"createdAt":r.get::<_,String>(2)?,"updatedAt":r.get::<_,String>(3)?})))?;
            Ok(serde_json::to_value(rows.collect::<Result<Vec<_>, _>>()?)?)
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
            let workspace_id = required_id(&workspace_id)?;
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
        Operation::KnowledgeEntityCreate {
            agent_id,
            name,
            entity_type,
            metadata,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let name = bounded_text(&name, "entity name", 256)?;
            let entity_type = bounded_text(&entity_type, "entity type", 64)?;
            let metadata = bounded_json(&metadata)?;
            let id = uuid::Uuid::new_v4().to_string();
            let tx = connection.transaction()?;
            tx.execute("INSERT INTO kg_entities(id,agent_id,name,entity_type,metadata,created_at,updated_at) VALUES(?,?,?,?,?,datetime('now'),datetime('now'))",params![id,agent_id,name,entity_type,metadata])?;
            tx.commit()?;
            Ok(json!({"id":id,"agentId":agent_id,"name":name,"type":entity_type}))
        }
        Operation::KnowledgeEntityList {
            agent_id,
            limit,
            offset,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let limit = limit.clamp(1, 200) as i64;
            let offset = offset.min(100_000) as i64;
            let mut s=connection.prepare("SELECT id,name,entity_type,metadata,created_at,updated_at FROM kg_entities WHERE agent_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?")?;
            let rows=s.query_map(params![agent_id,limit,offset],|r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"type":r.get::<_,String>(2)?,"metadata":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(json!({})),"createdAt":r.get::<_,String>(4)?,"updatedAt":r.get::<_,String>(5)?})))?;
            Ok(json!({"items":rows.collect::<Result<Vec<_>,_>>()?,"limit":limit,"offset":offset}))
        }
        Operation::KnowledgeRelationCreate {
            agent_id,
            from_id,
            to_id,
            relation,
            metadata,
        } => {
            let agent_id = required_agent(&agent_id)?;
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
                "SELECT count(*) FROM kg_entities WHERE agent_id=? AND id IN (?,?)",
                params![agent_id, from_id, to_id],
                |r| r.get(0),
            )?;
            if count != 2 {
                return Err(CoreError::NotFound);
            }
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO kg_relations(id,agent_id,from_id,to_id,relation,metadata,created_at) VALUES(?,?,?,?,?,?,datetime('now'))",params![id,agent_id,from_id,to_id,relation,metadata])?;
            tx.commit()?;
            Ok(json!({"id":id,"fromId":from_id,"toId":to_id,"relation":relation}))
        }
        Operation::KnowledgeRelations {
            agent_id,
            entity_id,
            limit,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let entity_id = required_id(&entity_id)?;
            let limit = limit.clamp(1, 200) as i64;
            let mut s=connection.prepare("SELECT id,from_id,to_id,relation,metadata,created_at FROM kg_relations WHERE agent_id=? AND (from_id=? OR to_id=?) ORDER BY rowid DESC LIMIT ?")?;
            let rows=s.query_map(params![agent_id,entity_id,entity_id,limit],|r| Ok(json!({"id":r.get::<_,String>(0)?,"fromId":r.get::<_,String>(1)?,"toId":r.get::<_,String>(2)?,"relation":r.get::<_,String>(3)?,"metadata":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(json!({})),"createdAt":r.get::<_,String>(5)?})))?;
            Ok(json!({"items":rows.collect::<Result<Vec<_>,_>>()?}))
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

const MAX_EVENT_RECORDS: usize = 500;

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
    CreateSource {
        agent_id: String,
        kind: String,
        name: String,
        config: Value,
    },
    ListSources {
        agent_id: String,
    },
    IngestDocument {
        agent_id: String,
        source_id: String,
        path: String,
        content: String,
        metadata: Value,
    },
    JobSubmit {
        agent_id: String,
        kind: String,
        payload: Value,
        deadline_at: Option<String>,
    },
    JobGet {
        agent_id: String,
        id: String,
    },
    JobCancel {
        agent_id: String,
        id: String,
    },
    JobList {
        agent_id: String,
        limit: usize,
    },
    JobEvents {
        agent_id: String,
        id: String,
    },
    OntologyList {
        agent_id: String,
        workspace_id: String,
        kind: String,
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
        name: String,
        entity_type: String,
        metadata: Value,
    },
    KnowledgeEntityList {
        agent_id: String,
        limit: usize,
        offset: usize,
    },
    KnowledgeRelationCreate {
        agent_id: String,
        from_id: String,
        to_id: String,
        relation: String,
        metadata: Value,
    },
    KnowledgeRelations {
        agent_id: String,
        entity_id: String,
        limit: usize,
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

fn bounded_text(value: &str, label: &str, max: usize) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.len() > max {
        return Err(CoreError::InvalidInput(format!(
            "{label} must be 1-{max} bytes"
        )));
    }
    Ok(value.to_owned())
}

fn bounded_json(value: &Value) -> Result<String, CoreError> {
    let text = serde_json::to_string(value)?;
    if text.len() > 65_536 {
        return Err(CoreError::InvalidInput("metadata exceeds 64 KiB".into()));
    }
    Ok(text)
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

fn source_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Source> {
    let config = row.get::<_, String>(4).unwrap_or_else(|_| "{}".into());
    Ok(Source {
        id: row.get(0)?,
        agent_id: row
            .get::<_, Option<String>>(1)?
            .unwrap_or_else(|| "default".into()),
        kind: row.get(2)?,
        name: row.get(3).unwrap_or_default(),
        config: serde_json::from_str(&config).unwrap_or_else(|_| json!({})),
        created_at: row.get(5).ok(),
    })
}

fn migrate(connection: &mut Connection) -> Result<(), CoreError> {
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT, checksum TEXT);
         CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, metadata TEXT NOT NULL DEFAULT '{}');
         CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL DEFAULT 'default', kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}', created_at TEXT);
         CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL DEFAULT 'default', content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT);
         CREATE TABLE IF NOT EXISTS memory_history (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, agent_id TEXT NOT NULL, operation TEXT NOT NULL, content TEXT, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS ontology_records (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS kg_entities (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, entity_type TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS kg_relations (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS kg_entities_scope ON kg_entities(agent_id, name);
         CREATE INDEX IF NOT EXISTS kg_relations_scope ON kg_relations(agent_id, from_id, to_id);
         CREATE INDEX IF NOT EXISTS ontology_scope_idx ON ontology_records(agent_id, workspace_id, kind, deleted);
         CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', result TEXT, error TEXT, deadline_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS jobs_agent_state ON jobs(agent_id, state, created_at);
         CREATE TABLE IF NOT EXISTS job_events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, agent_id TEXT NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS sessions (key TEXT NOT NULL, agent_id TEXT NOT NULL, harness TEXT NOT NULL, runtime_path TEXT, project TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, PRIMARY KEY(key, agent_id));
         CREATE TABLE IF NOT EXISTS event_records (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, session_key TEXT, event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS event_records_scope ON event_records(agent_id, session_key, id);
         SELECT 1;",
    )?;
    ensure_column(&transaction, "schema_migrations", "applied_at", "TEXT")?;
    ensure_column(&transaction, "schema_migrations", "checksum", "TEXT")?;
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
    transaction.execute(
        "UPDATE sources SET agent_id = 'default' WHERE agent_id IS NULL OR trim(agent_id) = ''",
        [],
    )?;
    transaction.execute(
        "UPDATE sources SET config = COALESCE(config, metadata, '{}') WHERE config IS NULL OR trim(config) = ''",
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
