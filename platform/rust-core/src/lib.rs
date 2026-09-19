use rusqlite::{params, Connection, OptionalExtension, Transaction};
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
        Operation::TranscriptImportCreate {
            agent_id,
            schema_id,
            duplicate_mode,
            files,
        } => {
            let agent_id = required_agent(&agent_id)?;
            if schema_id != "signet-export"
                || !matches!(duplicate_mode.as_str(), "skip" | "replace" | "reimport")
            {
                return Err(CoreError::InvalidInput(
                    "unsupported import schema or duplicate mode".into(),
                ));
            }
            let files = files
                .as_array()
                .ok_or_else(|| CoreError::InvalidInput("files must be an array".into()))?;
            if files.is_empty() || files.len() > 25 {
                return Err(CoreError::InvalidInput(
                    "files must contain 1-25 entries".into(),
                ));
            }
            let id = uuid::Uuid::new_v4().to_string();
            connection.execute("INSERT INTO transcript_import_jobs (id,agent_id,schema_id,duplicate_mode,state,files,created_at,updated_at) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))", params![id,agent_id,schema_id,duplicate_mode, "staging", serde_json::to_string(files)?])?;
            Ok(json!({"id":id,"jobId":id,"agentId":agent_id,"state":"staging","files":files}))
        }
        Operation::TranscriptImportGet { agent_id, id } => {
            let value: Option<String> = connection.query_row("SELECT json_object('id',id,'agentId',agent_id,'schemaId',schema_id,'duplicateMode',duplicate_mode,'state',state,'files',json(files),'createdAt',created_at,'updatedAt',updated_at) FROM transcript_import_jobs WHERE id=? AND agent_id=?", params![id, required_agent(&agent_id)?], |r| r.get(0)).optional()?;
            value
                .map(|v| serde_json::from_str(&v))
                .transpose()?
                .ok_or(CoreError::NotFound)
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
            connection.execute("INSERT INTO session_transcripts (session_key,agent_id,harness,project,content,content_hash,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT(agent_id,session_key) DO UPDATE SET content=excluded.content,content_hash=excluded.content_hash,updated_at=datetime('now')", params![session_key,agent_id,harness,project,content,hash,idempotency_key])?;
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
        Operation::JobSubmit {
            agent_id,
            workspace_id,
            kind,
            payload,
            deadline_at,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = bounded_text(&workspace_id, "workspace id", 256)?;
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
            let transaction = connection.transaction()?;
            transaction.execute("INSERT INTO jobs (id,agent_id,workspace_id,kind,state,payload,deadline_at,created_at,updated_at) VALUES (?,?,?,? ,'queued',?,?,datetime('now'),datetime('now'))", params![id,agent_id,workspace_id,kind,payload,deadline_at])?;
            transaction.execute("INSERT INTO job_events (job_id,agent_id,event,data,created_at) VALUES (?,?, 'queued','{}',datetime('now'))", params![id,agent_id])?;
            transaction.commit()?;
            Ok(json!({"id":id,"state":"queued","workspaceId":workspace_id}))
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
            let tx = connection.transaction()?;
            let state: Option<String> = tx
                .query_row(
                    "SELECT state FROM jobs WHERE id=? AND agent_id=? AND workspace_id=?",
                    params![id, agent_id, workspace_id],
                    |r| r.get(0),
                )
                .optional()?;
            let state = state.ok_or(CoreError::NotFound)?;
            let final_state = if matches!(state.as_str(), "queued" | "running") {
                tx.execute("UPDATE jobs SET state='cancelled', updated_at=datetime('now') WHERE id=? AND agent_id=? AND workspace_id=? AND state IN ('queued','running')", params![id,agent_id,workspace_id])?;
                tx.execute("INSERT INTO job_events (job_id,agent_id,event,data,created_at) VALUES (?,?,'cancelled',?,datetime('now'))", params![id,agent_id,serde_json::to_string(&json!({"actor":actor,"reason":reason}))?])?;
                "cancelled"
            } else {
                state.as_str()
            };
            let actor = bounded_text(&actor, "actor", 256)?;
            let reason = bounded_text(&reason, "reason", 256)?;
            if state != "cancelled" {
                tx.execute("INSERT INTO job_cancellations(job_id,agent_id,actor,reason,provenance,created_at) VALUES(?,?,?,?,?,datetime('now'))", params![id,agent_id,actor,reason,"api"])?;
            }
            tx.commit()?;
            Ok(
                json!({"id":id,"state":final_state,"cancellation":{"actor":actor,"reason":reason,"provenance":"api"}}),
            )
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
            let row: Option<(String, i64)> = connection
                .query_row(
                    "SELECT state, paused FROM pipeline_state WHERE agent_id=?",
                    params![agent_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let (state, paused) = row.unwrap_or_else(|| ("idle".into(), 0));
            Ok(json!({"agentId":agent_id,"state":state,"paused":paused != 0}))
        }
        Operation::PipelineSetPaused { agent_id, paused } => {
            let agent_id = required_agent(&agent_id)?;
            let tx = connection.transaction()?;
            tx.execute("INSERT INTO pipeline_state(agent_id,state,paused,updated_at) VALUES(?, 'idle', ?, datetime('now')) ON CONFLICT(agent_id) DO UPDATE SET paused=excluded.paused, updated_at=datetime('now')", params![agent_id, paused as i64])?;
            tx.commit()?;
            Ok(json!({"agentId":agent_id,"state":"idle","paused":paused}))
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
        Operation::DreamTrigger { agent_id, payload } => {
            let agent_id = required_agent(&agent_id)?;
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
            tx.execute("INSERT INTO jobs(id,agent_id,kind,state,payload,created_at,updated_at) VALUES(?,?, 'dream.trigger','queued',?,datetime('now'),datetime('now'))", params![id,agent_id,payload])?;
            tx.execute("INSERT INTO job_events(job_id,agent_id,event,data,created_at) VALUES(?,?, 'queued','{}',datetime('now'))", params![id,agent_id])?;
            tx.commit()?;
            Ok(json!({"id":id,"agentId":agent_id,"kind":"dream.trigger","state":"queued"}))
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
            let source_generation: i64 = tx
                .query_row(
                    "SELECT generation FROM sources WHERE id=? AND agent_id=?",
                    params![source_id, agent_id],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or(CoreError::NotFound)?;
            if generation.is_some_and(|g| g != source_generation) {
                return Err(CoreError::NotFound);
            }
            let existing: Option<(String,String)> = tx.query_row("SELECT id,content_hash FROM documents WHERE agent_id=? AND source_id=? AND path=?", params![agent_id,source_id,path], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((existing_id, existing_hash)) = existing {
                if mode == "skip" {
                    return Ok(
                        json!({"id":existing_id,"status":"skipped","contentHash":existing_hash,"duplicateMode":"skip","generation":source_generation}),
                    );
                }
                if mode == "replace" {
                    tx.execute("UPDATE documents SET content=?,metadata=?,content_hash=?,updated_at=datetime('now') WHERE id=?", params![content,metadata,content_hash,existing_id])?;
                    tx.commit()?;
                    return Ok(
                        json!({"id":existing_id,"status":"replaced","contentHash":content_hash,"duplicateMode":"replace","generation":source_generation}),
                    );
                }
            }
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO documents (id,agent_id,source_id,path,content,metadata,content_hash,generation,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,datetime('now'),datetime('now'))", params![id,agent_id,source_id,path,content,metadata,content_hash,source_generation])?;
            tx.commit()?;
            Ok(
                json!({"id":id,"status":if mode=="reimport" {"reimported"} else {"stored"},"contentHash":content_hash,"duplicateMode":mode,"generation":source_generation}),
            )
        }
        Operation::DeleteSource {
            agent_id,
            source_id,
        } => {
            let generation: Option<i64> = None;
            let tx = connection.transaction()?;
            let current: Option<i64> = tx
                .query_row(
                    "SELECT generation FROM sources WHERE agent_id=? AND id=?",
                    params![agent_id, source_id],
                    |r| r.get(0),
                )
                .optional()?;
            let current = current.ok_or(CoreError::NotFound)?;
            if generation.is_some_and(|g| g != current) {
                return Err(CoreError::NotFound);
            }
            let changed = tx.execute(
                "DELETE FROM documents WHERE agent_id=? AND source_id=?",
                params![agent_id, source_id],
            )?;
            tx.execute("INSERT INTO source_tombstones(agent_id,source_id,generation,deleted_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(agent_id,source_id) DO UPDATE SET generation=excluded.generation,deleted_at=excluded.deleted_at", params![agent_id,source_id,current+1])?;
            tx.execute(
                "DELETE FROM sources WHERE agent_id=? AND id=?",
                params![agent_id, source_id],
            )?;
            tx.commit()?;
            Ok(json!({"deleted":true,"documentsDeleted":changed,"generation":current+1}))
        }
        Operation::DeleteSourceWithGeneration {
            agent_id,
            source_id,
            generation,
        } => {
            let tx = connection.transaction()?;
            let current: Option<i64> = tx
                .query_row(
                    "SELECT generation FROM sources WHERE agent_id=? AND id=?",
                    params![agent_id, source_id],
                    |r| r.get(0),
                )
                .optional()?;
            let current = current.ok_or(CoreError::NotFound)?;
            if generation.is_some_and(|g| g != current) {
                return Err(CoreError::NotFound);
            }
            let changed = tx.execute(
                "DELETE FROM documents WHERE agent_id=? AND source_id=?",
                params![agent_id, source_id],
            )?;
            tx.execute("INSERT INTO source_tombstones(agent_id,source_id,generation,deleted_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(agent_id,source_id) DO UPDATE SET generation=excluded.generation,deleted_at=excluded.deleted_at", params![agent_id,source_id,current+1])?;
            tx.execute(
                "DELETE FROM sources WHERE agent_id=? AND id=?",
                params![agent_id, source_id],
            )?;
            tx.commit()?;
            Ok(json!({"deleted":true,"documentsDeleted":changed,"generation":current+1}))
        }
        Operation::SourceHealth {
            agent_id,
            source_id,
        } => {
            let exists: Option<i64> = connection
                .query_row(
                    "SELECT 1 FROM sources WHERE agent_id = ? AND id = ?",
                    params![agent_id, source_id],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Err(CoreError::NotFound);
            }
            let documents: i64 = connection.query_row(
                "SELECT count(*) FROM documents WHERE agent_id = ? AND source_id = ?",
                params![agent_id, source_id],
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
        Operation::KnowledgeAspectCreate {
            agent_id,
            workspace_id,
            entity_id,
            name,
            weight,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = required_id(&workspace_id)?;
            let entity_id = required_id(&entity_id)?;
            let name = bounded_text(&name, "aspect name", 256)?;
            let weight = weight.clamp(0.0, 1.0);
            let tx = connection.transaction()?;
            let entity_ok: i64 = tx.query_row("SELECT count(*) FROM kg_entities WHERE id=? AND agent_id=? AND workspace_id=? AND deleted=0", params![entity_id, agent_id, workspace_id], |r| r.get(0))?;
            if entity_ok != 1 {
                return Err(CoreError::NotFound);
            }
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO kg_aspects(id,agent_id,workspace_id,entity_id,name,canonical_name,weight,created_at,updated_at) VALUES(?,?,?,?,?,?,?,datetime('now'),datetime('now'))", params![id,agent_id,workspace_id,entity_id,name,name.to_lowercase(),weight])?;
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
            let workspace_id = required_id(&workspace_id)?;
            let aspect_id = required_id(&aspect_id)?;
            let kind = bounded_text(&kind, "attribute kind", 64)?;
            let content = bounded_text(&content, "attribute content", 4096)?;
            let tx = connection.transaction()?;
            let ok: i64 = tx.query_row(
                "SELECT count(*) FROM kg_aspects WHERE id=? AND agent_id=? AND workspace_id=?",
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
            tx.execute("INSERT INTO kg_attributes(id,agent_id,workspace_id,aspect_id,memory_id,kind,content,normalized_content,claim_key,group_key,confidence,importance,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'active',datetime('now'),datetime('now'))",params![id,agent_id,workspace_id,aspect_id,memory_id,kind,content,content.to_lowercase(),claim_key,group_key,confidence.clamp(0.0,1.0),importance.clamp(0.0,1.0)])?;
            tx.commit()?;
            Ok(
                json!({"id":id,"aspectId":aspect_id,"kind":kind,"content":content,"status":"active"}),
            )
        }
        Operation::KnowledgeTree {
            agent_id,
            workspace_id,
            entity_id,
            depth,
            max_aspects,
            max_attributes,
        } => {
            let agent_id = required_agent(&agent_id)?;
            let workspace_id = required_id(&workspace_id)?;
            let entity_id = required_id(&entity_id)?;
            let mut s=connection.prepare("SELECT id,name,weight FROM kg_aspects WHERE agent_id=? AND workspace_id=? AND entity_id=? ORDER BY weight DESC LIMIT ?")?;
            let aspects=s.query_map(params![agent_id,workspace_id,entity_id,max_aspects.clamp(1,100) as i64],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"weight":r.get::<_,f64>(2)?})))?;
            let mut out = Vec::new();
            for a in aspects {
                let mut v = a?;
                let aid = v["id"].as_str().unwrap_or_default().to_string();
                let mut q=connection.prepare("SELECT id,kind,content,status FROM kg_attributes WHERE agent_id=? AND workspace_id=? AND aspect_id=? AND status='active' ORDER BY importance DESC LIMIT ?")?;
                let rows=q.query_map(params![agent_id,workspace_id,aid,max_attributes.clamp(1,200) as i64],|r|Ok(json!({"id":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"content":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?})))?;
                v["attributes"] = json!(rows.collect::<Result<Vec<_>, _>>()?);
                out.push(v);
            }
            Ok(json!({"entityId":entity_id,"aspects":out,"depth":depth.min(3)}))
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
            let workspace_id = bounded_text(&workspace_id, "workspace id", 256)?;
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
            let workspace_id = bounded_text(&workspace_id, "workspace id", 256)?;
            let mut s = connection.prepare("SELECT id,sender_agent_id,recipient_agent_id,kind,payload,created_at FROM cross_agent_messages WHERE workspace_id=? AND recipient_agent_id=? AND id>? ORDER BY id ASC LIMIT ?")?;
            let rows = s.query_map(params![workspace_id,agent_id,after_id,limit.clamp(1,MAX_EVENT_RECORDS) as i64], |r| Ok(json!({"id":r.get::<_,i64>(0)?,"senderAgentId":r.get::<_,String>(1)?,"recipientAgentId":r.get::<_,String>(2)?,"kind":r.get::<_,String>(3)?,"payload":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(json!({})),"createdAt":r.get::<_,String>(5)?})))?;
            Ok(json!({"messages":rows.collect::<Result<Vec<_>,_>>()?}))
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

    pub fn initialize(&self) -> Result<(), CoreError> {
        self.0.initialize()
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
    DeleteSource {
        agent_id: String,
        source_id: String,
    },
    DeleteSourceWithGeneration {
        agent_id: String,
        source_id: String,
        generation: Option<i64>,
    },
    SourceHealth {
        agent_id: String,
        source_id: String,
    },
    TranscriptImportCreate {
        agent_id: String,
        schema_id: String,
        duplicate_mode: String,
        files: Value,
    },
    TranscriptImportGet {
        agent_id: String,
        id: String,
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
        payload: Value,
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
    KnowledgeTree {
        agent_id: String,
        workspace_id: String,
        entity_id: String,
        depth: usize,
        max_aspects: usize,
        max_attributes: usize,
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

fn validate_deadline(value: &str) -> Result<String, CoreError> {
    let value = bounded_text(value, "deadline_at", 64)?;
    let bytes = value.as_bytes();
    let valid_shape = bytes.len() >= 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && (bytes.ends_with(b"Z") || bytes[19] == b'+' || bytes[19] == b'-');
    if !valid_shape {
        return Err(CoreError::InvalidInput(
            "deadline_at must be RFC3339".into(),
        ));
    }
    Ok(value)
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
         CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', content_hash TEXT NOT NULL DEFAULT '', generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT);
         CREATE TABLE IF NOT EXISTS source_tombstones (agent_id TEXT NOT NULL, source_id TEXT NOT NULL, generation INTEGER NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY(agent_id,source_id));
         CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL DEFAULT 'default', content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, superseded_by TEXT, superseded_at TEXT, superseded_reason TEXT, created_at TEXT, updated_at TEXT);
         CREATE TABLE IF NOT EXISTS memory_history (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, agent_id TEXT NOT NULL, operation TEXT NOT NULL, content TEXT, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS ontology_records (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS kg_entities (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL, entity_type TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS kg_relations (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'default', from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS kg_aspects (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, entity_id TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.5, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(agent_id,workspace_id,entity_id,canonical_name));
         CREATE TABLE IF NOT EXISTS kg_attributes (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, aspect_id TEXT NOT NULL, memory_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, normalized_content TEXT NOT NULL, claim_key TEXT, group_key TEXT, confidence REAL NOT NULL DEFAULT 0, importance REAL NOT NULL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'active', superseded_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS kg_entities_scope ON kg_entities(agent_id, name);
         CREATE INDEX IF NOT EXISTS kg_relations_scope ON kg_relations(agent_id, from_id, to_id);
         CREATE INDEX IF NOT EXISTS ontology_scope_idx ON ontology_records(agent_id, workspace_id, kind, deleted);
         CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'default', kind TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', result TEXT, error TEXT, deadline_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS jobs_agent_state ON jobs(agent_id, state, created_at);
         CREATE TABLE IF NOT EXISTS job_cancellations (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, agent_id TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, provenance TEXT NOT NULL, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS job_events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, agent_id TEXT NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS pipeline_state (agent_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'idle', paused INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS sessions (key TEXT NOT NULL, agent_id TEXT NOT NULL, harness TEXT NOT NULL, runtime_path TEXT, project TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, PRIMARY KEY(key, agent_id));
         CREATE TABLE IF NOT EXISTS event_records (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, session_key TEXT, event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS transcript_import_jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, schema_id TEXT NOT NULL, duplicate_mode TEXT NOT NULL, state TEXT NOT NULL, files TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS session_transcripts (session_key TEXT NOT NULL, agent_id TEXT NOT NULL, harness TEXT NOT NULL, project TEXT, content TEXT NOT NULL, content_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, PRIMARY KEY(agent_id, session_key));
         CREATE UNIQUE INDEX IF NOT EXISTS session_transcripts_idempotency ON session_transcripts(agent_id, idempotency_key);
         CREATE INDEX IF NOT EXISTS event_records_scope ON event_records(agent_id, session_key, id);
         CREATE TABLE IF NOT EXISTS hook_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_key TEXT, hook TEXT NOT NULL, checkpoint TEXT, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, UNIQUE(agent_id, receipt_id));
         CREATE INDEX IF NOT EXISTS hook_receipts_scope ON hook_receipts(agent_id, session_key, id);
         CREATE TABLE IF NOT EXISTS cross_agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, sender_agent_id TEXT NOT NULL, recipient_agent_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS cross_agent_messages_scope ON cross_agent_messages(workspace_id, recipient_agent_id, id);
         CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, prefix TEXT NOT NULL UNIQUE, name TEXT NOT NULL, key_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'agent', scope_json TEXT NOT NULL DEFAULT '{}', permissions_json TEXT NOT NULL DEFAULT '[]', connector TEXT, harness TEXT, agent_id TEXT, allowed_projects_json TEXT, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, expires_at TEXT);
         CREATE INDEX IF NOT EXISTS api_keys_scope ON api_keys(agent_id, revoked_at, expires_at);
         SELECT 1;",
    )?;
    ensure_column(&transaction, "schema_migrations", "applied_at", "TEXT")?;
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
    ensure_column(&transaction, "api_keys", "allowed_projects_json", "TEXT")?;
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
    transaction.execute(
        "CREATE INDEX IF NOT EXISTS documents_source_path ON documents(agent_id,source_id,path)",
        [],
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
