//! Summary worker: session-end summarization and lineage writes.
//!
//! Polls `summary_jobs`, uses the configured LLM to generate a markdown
//! summary plus durable facts, persists canonical summary artifacts, updates
//! the session DAG, and regenerates MEMORY.md from the deterministic
//! projection.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tracing::{info, warn};

use signet_core::db::{DbPool, Priority};
use signet_services::transactions;

use crate::memory_lineage::{
    ArtifactKind, MemorySentence, SummaryArtifactInput, SummaryFact, resolve_memory_sentence,
    write_memory_projection, write_summary_artifact, write_summary_to_dag,
};
use crate::provider::{GenerateOpts, LlmProvider, LlmSemaphore};

const RECOVER_BATCH: i64 = 100;
const CHUNK_TARGET_CHARS: usize = 20_000;
const WORKER_ACTOR: &str = "summary-worker";

#[derive(Debug, Clone)]
pub struct SummaryConfig {
    pub poll_ms: u64,
    pub max_retries: u32,
    pub max_tokens: u32,
    pub timeout_ms: u64,
    pub min_message_count: usize,
    pub chunk_size: usize,
    pub agents_dir: PathBuf,
}

impl Default for SummaryConfig {
    fn default() -> Self {
        let agents_dir = std::env::var("SIGNET_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                std::env::var("HOME")
                    .map(|value| PathBuf::from(value).join(".agents"))
                    .unwrap_or_else(|_| PathBuf::from("~/.agents"))
            });
        Self {
            poll_ms: 5_000,
            max_retries: 3,
            max_tokens: 4_096,
            timeout_ms: 120_000,
            min_message_count: 3,
            chunk_size: CHUNK_TARGET_CHARS,
            agents_dir,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryJob {
    pub id: String,
    pub session_key: Option<String>,
    pub session_id: String,
    pub harness: String,
    pub project: Option<String>,
    pub agent_id: String,
    pub transcript: String,
    pub trigger: String,
    pub captured_at: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub attempts: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryResult {
    pub facts_extracted: usize,
    pub summary_length: usize,
    pub chunks_processed: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RecoveryBatch {
    selected: usize,
    updated: usize,
}

#[derive(Debug, Clone)]
struct ProcessedSummary {
    summary: String,
    facts: Vec<SummaryFact>,
    leaves: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct LlmSummaryEnvelope {
    summary: String,
    #[serde(default)]
    facts: Vec<SummaryFact>,
}

pub struct SummaryHandle {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl SummaryHandle {
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

pub fn start(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: SummaryConfig,
) -> SummaryHandle {
    let (tx, rx) = watch::channel(false);
    let handle = tokio::spawn(worker_loop(pool, provider, semaphore, config, rx));
    SummaryHandle {
        shutdown: tx,
        handle,
    }
}

async fn worker_loop(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: SummaryConfig,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut failures = 0u32;
    let base = Duration::from_millis(config.poll_ms);
    let max = Duration::from_secs(120);
    let mut recovered = false;

    info!(poll_ms = config.poll_ms, "summary worker started");

    loop {
        if *shutdown.borrow() {
            info!("summary worker shutting down");
            break;
        }

        if !recovered {
            match recover_summary_jobs(&pool, RECOVER_BATCH).await {
                Ok(batch) => {
                    if batch.updated > 0 {
                        info!(
                            updated = batch.updated,
                            "summary crash recovery reset stuck job(s)"
                        );
                    }
                    if batch.selected >= RECOVER_BATCH as usize {
                        tokio::task::yield_now().await;
                        continue;
                    }
                    recovered = true;
                }
                Err(err) => {
                    warn!(err = %err, "summary crash recovery failed");
                    recovered = true;
                }
            }
        }

        let delay = if failures > 0 {
            (base * 2u32.pow(failures.min(6))).min(max)
        } else {
            base
        };

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown.changed() => {
                info!("summary worker shutting down");
                break;
            }
        }

        let Some(job) = (match lease_summary_job(&pool, config.max_retries).await {
            Ok(job) => job,
            Err(err) => {
                warn!(err = %err, "failed to lease summary job");
                failures += 1;
                continue;
            }
        }) else {
            continue;
        };

        info!(job_id = %job.id, session = ?job.session_key, "processing summary job");

        match process_summary(&pool, &provider, &semaphore, &config, &job).await {
            Ok(result) => {
                failures = 0;
                let json = serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string());
                if let Err(err) = complete_summary_job(&pool, &job.id, &json).await {
                    warn!(err = %err, job_id = %job.id, "failed to complete summary job");
                }
                info!(
                    job_id = %job.id,
                    facts = result.facts_extracted,
                    length = result.summary_length,
                    "summary completed"
                );
            }
            Err(err) => {
                failures += 1;
                warn!(err = %err, job_id = %job.id, "summary job failed");
                if let Err(fail) = fail_summary_job(&pool, &job.id, &err).await {
                    warn!(err = %fail, "failed to record summary failure");
                }
            }
        }
    }
}

async fn process_summary(
    pool: &DbPool,
    provider: &Arc<dyn LlmProvider>,
    semaphore: &Arc<LlmSemaphore>,
    config: &SummaryConfig,
    job: &SummaryJob,
) -> Result<SummaryResult, String> {
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let processed = if job.transcript.trim().len() < 50 {
        ProcessedSummary {
            summary: format!(
                "# {today} Session Notes\n\n## Short Session\n\nThis session ended before enough durable context accumulated for a full summary."
            ),
            facts: Vec::new(),
            leaves: Vec::new(),
        }
    } else if job.transcript.len() > config.chunk_size {
        process_chunked(provider, semaphore, config, &job.transcript, &today).await?
    } else {
        process_single(provider, semaphore, config, &job.transcript, &today).await?
    };

    let sentence = if job.trigger == "session_end" {
        resolve_memory_sentence(
            &processed.summary,
            job.project.as_deref(),
            Some(job.harness.as_str()),
            ArtifactKind::Summary,
            Some(provider),
            Some(semaphore),
        )
        .await
    } else {
        MemorySentence {
            text: processed
                .summary
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string())
                .unwrap_or_else(|| {
                    "Checkpoint summary captured durable context for later MEMORY.md projection."
                        .to_string()
                }),
            quality: "fallback".to_string(),
            generated_at: Utc::now().to_rfc3339(),
        }
    };

    let agent_id = job.agent_id.clone();
    let session_key = job.session_key.clone();
    let session_id = job.session_id.clone();
    let harness = job.harness.clone();
    let project = job.project.clone();
    let created_at = job.created_at.clone();
    let latest_at = job
        .ended_at
        .clone()
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let trigger = job.trigger.clone();
    let summary = processed.summary.clone();
    let leaves = processed.leaves.clone();
    let facts = processed.facts.clone();
    let facts_len = facts.len();
    let root = config.agents_dir.clone();
    let captured_at = job
        .captured_at
        .clone()
        .unwrap_or_else(|| created_at.clone());
    let started_at = job.started_at.clone();
    let ended_at = job.ended_at.clone();

    pool.write(Priority::High, move |conn| {
        if trigger == "session_end" {
            let _ = write_summary_artifact(
                conn,
                &root,
                SummaryArtifactInput {
                    agent_id: agent_id.clone(),
                    session_id: session_id.clone(),
                    session_key: session_key.clone(),
                    project: project.clone(),
                    harness: Some(harness.clone()),
                    captured_at,
                    started_at,
                    ended_at,
                    summary: summary.clone(),
                },
                sentence,
            )
            .map_err(signet_core::error::CoreError::Migration)?;
        }

        for fact in &facts {
            if fact.content.trim().is_empty() {
                continue;
            }
            let _ = transactions::ingest(
                conn,
                &transactions::IngestInput {
                    content: &fact.content,
                    memory_type: fact.kind.as_deref().unwrap_or("fact"),
                    tags: fact
                        .tags
                        .as_deref()
                        .map(|value| {
                            value
                                .split(',')
                                .map(str::trim)
                                .filter(|item| !item.is_empty())
                                .map(ToOwned::to_owned)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default(),
                    who: None,
                    why: None,
                    project: project.as_deref(),
                    importance: fact.importance.unwrap_or(0.3).clamp(0.0, 0.5),
                    pinned: false,
                    source_type: Some("session_end"),
                    source_id: session_key.as_deref(),
                    idempotency_key: None,
                    runtime_path: None,
                    actor: WORKER_ACTOR,
                    agent_id: &agent_id,
                    visibility: "global",
                    scope: None,
                },
            );
        }

        let _ = write_summary_to_dag(
            conn,
            &agent_id,
            session_key.as_deref(),
            project.as_deref(),
            Some(harness.as_str()),
            &created_at,
            &latest_at,
            &trigger,
            &summary,
            &leaves,
        )
        .map_err(signet_core::error::CoreError::Migration)?;

        let _ = write_memory_projection(conn, &root, &agent_id)
            .map_err(signet_core::error::CoreError::Migration)?;

        Ok(serde_json::json!({
            "facts": facts_len,
            "summaryLength": summary.len(),
            "chunks": leaves.len().max(1),
        }))
    })
    .await
    .map_err(|err| err.to_string())?;

    Ok(SummaryResult {
        facts_extracted: facts_len,
        summary_length: processed.summary.len(),
        chunks_processed: processed.leaves.len().max(1),
    })
}

async fn process_single(
    provider: &Arc<dyn LlmProvider>,
    semaphore: &Arc<LlmSemaphore>,
    config: &SummaryConfig,
    transcript: &str,
    date: &str,
) -> Result<ProcessedSummary, String> {
    let raw = generate(provider, semaphore, &build_prompt(transcript, date), config).await?;
    let parsed = parse_llm_response(&raw)?;
    Ok(ProcessedSummary {
        leaves: vec![parsed.summary.clone()],
        summary: parsed.summary,
        facts: parsed.facts,
    })
}

async fn process_chunked(
    provider: &Arc<dyn LlmProvider>,
    semaphore: &Arc<LlmSemaphore>,
    config: &SummaryConfig,
    transcript: &str,
    date: &str,
) -> Result<ProcessedSummary, String> {
    let chunks = chunk_transcript(transcript, config.chunk_size);
    let mut leaves = Vec::new();
    let mut facts = Vec::new();

    for (idx, chunk) in chunks.iter().enumerate() {
        let raw = generate(
            provider,
            semaphore,
            &build_chunk_prompt(chunk, idx, chunks.len(), date),
            config,
        )
        .await?;
        let parsed = parse_llm_response(&raw)?;
        leaves.push(parsed.summary.clone());
        facts.extend(parsed.facts);
    }

    let raw = generate(
        provider,
        semaphore,
        &build_combine_prompt(&leaves, &facts, date),
        config,
    )
    .await?;
    let parsed = parse_llm_response(&raw)?;
    Ok(ProcessedSummary {
        summary: parsed.summary,
        facts: parsed.facts,
        leaves,
    })
}

async fn generate(
    provider: &Arc<dyn LlmProvider>,
    semaphore: &Arc<LlmSemaphore>,
    prompt: &str,
    config: &SummaryConfig,
) -> Result<String, String> {
    let opts = GenerateOpts {
        timeout_ms: Some(config.timeout_ms),
        max_tokens: Some(config.max_tokens),
    };
    let raw = semaphore
        .run(async { provider.generate(prompt, &opts).await })
        .await
        .map_err(|err| err.to_string())?;
    Ok(raw.text)
}

fn strip_llm_wrappers(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    if let Some(start) = text.find("```")
        && let Some(end) = text.rfind("```")
        && end > start
    {
        text = text[(start + 3)..end].trim().to_string();
        if let Some(stripped) = text.strip_prefix("json") {
            text = stripped.trim().to_string();
        }
    }
    while let Some(start) = text.find("<think>") {
        let Some(end) = text.find("</think>") else {
            break;
        };
        text.replace_range(start..(end + 8), "");
    }
    text.trim().to_string()
}

fn parse_llm_response(raw: &str) -> Result<LlmSummaryEnvelope, String> {
    let cleaned = strip_llm_wrappers(raw);
    serde_json::from_str::<LlmSummaryEnvelope>(&cleaned).map_err(|err| err.to_string())
}

fn build_prompt(transcript: &str, date: &str) -> String {
    format!(
        "You are a session librarian. Summarize this coding session as a dated markdown note and extract key durable facts.\n\nReturn ONLY a JSON object:\n{{\n  \"summary\": \"# {date} Session Notes\\n\\n## Topic Name\\n\\nProse summary...\",\n  \"facts\": [{{\"content\": \"...\", \"importance\": 0.3, \"tags\": \"tag1,tag2\", \"type\": \"fact\"}}]\n}}\n\nSummary guidelines:\n- Start with \"# {date} Session Notes\"\n- Use ## headings for distinct topics\n- Include what was worked on, key decisions, and open threads\n- Be concise but complete\n\nFact guidelines:\n- durable, self-contained knowledge only\n- include concrete subject names in every fact\n- max 15 facts\n\nConversation:\n{transcript}"
    )
}

fn build_chunk_prompt(chunk: &str, idx: usize, total: usize, date: &str) -> String {
    format!(
        "You are a session librarian. This is chunk {} of {} from a long coding session on {}. Summarize this segment and extract key durable facts.\n\nReturn ONLY a JSON object:\n{{\n  \"summary\": \"Prose summary of this segment...\",\n  \"facts\": [{{\"content\": \"...\", \"importance\": 0.3, \"tags\": \"tag1,tag2\", \"type\": \"fact\"}}]\n}}\n\nConversation segment:\n{}",
        idx + 1,
        total,
        date,
        chunk
    )
}

fn build_combine_prompt(leaves: &[String], facts: &[SummaryFact], date: &str) -> String {
    let summary_blocks = leaves
        .iter()
        .enumerate()
        .map(|(idx, leaf)| format!("--- Segment {} ---\n{}", idx + 1, leaf))
        .collect::<Vec<_>>()
        .join("\n\n");
    let fact_lines = facts
        .iter()
        .take(30)
        .map(|fact| format!("- {}", fact.content))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "You are a session librarian. Combine the segment summaries below into one session summary for {} and deduplicate the durable facts.\n\nReturn ONLY a JSON object:\n{{\n  \"summary\": \"# {} Session Notes\\n\\n## Topic Name\\n\\nProse summary...\",\n  \"facts\": [{{\"content\": \"...\", \"importance\": 0.3, \"tags\": \"tag1,tag2\", \"type\": \"fact\"}}]\n}}\n\nSegment summaries:\n{}\n\nFacts:\n{}",
        date, date, summary_blocks, fact_lines
    )
}

fn chunk_transcript(transcript: &str, target: usize) -> Vec<String> {
    let hard_cap = target * 3;
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    let mut chars = 0usize;

    for line in transcript.lines() {
        if line.len() + 1 >= hard_cap {
            if !current.is_empty() {
                chunks.push(current.join("\n"));
                current.clear();
                chars = 0;
            }
            for start in (0..line.len()).step_by(hard_cap) {
                chunks.push(line[start..line.len().min(start + hard_cap)].to_string());
            }
            continue;
        }
        let new_turn = line.starts_with("User: ") || line.starts_with("Assistant: ");
        if !current.is_empty() && ((new_turn && chars >= target) || chars >= hard_cap) {
            chunks.push(current.join("\n"));
            current.clear();
            chars = 0;
        }
        current.push(line.to_string());
        chars += line.len() + 1;
    }

    if !current.is_empty() {
        chunks.push(current.join("\n"));
    }

    if chunks.is_empty() {
        vec![transcript.to_string()]
    } else {
        chunks
    }
}

async fn lease_summary_job(pool: &DbPool, max_attempts: u32) -> Result<Option<SummaryJob>, String> {
    let val = pool
        .write(Priority::Low, move |conn| {
            let ts = Utc::now().to_rfc3339();
            let mut stmt = conn.prepare_cached(
                "UPDATE summary_jobs SET status = 'leased', leased_at = ?1, updated_at = ?1, attempts = attempts + 1
                 WHERE id = (
                    SELECT id FROM summary_jobs
                    WHERE status = 'pending' AND attempts < ?2
                    ORDER BY created_at ASC LIMIT 1
                 ) RETURNING id, session_key, session_id, harness, project, agent_id, transcript,
                            trigger, captured_at, started_at, ended_at, attempts, created_at",
            )?;

            let job = stmt
                .query_row(params![ts, max_attempts], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "session_key": row.get::<_, Option<String>>(1)?,
                        "session_id": row.get::<_, String>(2)?,
                        "harness": row.get::<_, String>(3)?,
                        "project": row.get::<_, Option<String>>(4)?,
                        "agent_id": row.get::<_, String>(5)?,
                        "transcript": row.get::<_, String>(6)?,
                        "trigger": row.get::<_, String>(7)?,
                        "captured_at": row.get::<_, Option<String>>(8)?,
                        "started_at": row.get::<_, Option<String>>(9)?,
                        "ended_at": row.get::<_, Option<String>>(10)?,
                        "attempts": row.get::<_, i64>(11)?,
                        "created_at": row.get::<_, String>(12)?,
                    }))
                })
                .ok();

            Ok(job.unwrap_or(serde_json::Value::Null))
        })
        .await
        .map_err(|err| err.to_string())?;

    if val.is_null() {
        Ok(None)
    } else {
        serde_json::from_value(val)
            .map(Some)
            .map_err(|err| err.to_string())
    }
}

async fn recover_summary_jobs(pool: &DbPool, limit: i64) -> Result<RecoveryBatch, String> {
    let val = pool
        .write_tx(Priority::Low, move |conn| {
            let rows = {
                let mut stmt = conn.prepare_cached(
                    "SELECT id, attempts, max_attempts
                     FROM summary_jobs
                     WHERE status IN ('processing', 'leased')
                     ORDER BY created_at ASC
                     LIMIT ?1",
                )?;
                let rows = stmt.query_map(params![limit], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };

            if rows.is_empty() {
                return Ok(serde_json::json!({ "selected": 0, "updated": 0 }));
            }

            let mut updated = 0usize;
            for (id, attempts, max_attempts) in &rows {
                let status = if *attempts >= *max_attempts {
                    "dead"
                } else {
                    "pending"
                };
                updated += conn
                    .execute(
                        "UPDATE summary_jobs
                         SET status = ?1,
                             result = NULL
                         WHERE id = ?2 AND status IN ('processing', 'leased')",
                        params![status, id],
                    )
                    .unwrap_or(0);
            }

            Ok(serde_json::json!({
                "selected": rows.len(),
                "updated": updated,
            }))
        })
        .await
        .map_err(|err| err.to_string())?;

    Ok(RecoveryBatch {
        selected: val
            .get("selected")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as usize,
        updated: val
            .get("updated")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as usize,
    })
}

async fn complete_summary_job(pool: &DbPool, id: &str, result: &str) -> Result<(), String> {
    let id = id.to_string();
    let result = result.to_string();
    pool.write(Priority::Low, move |conn| {
        let ts = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE summary_jobs SET status = 'completed', result = ?1, completed_at = ?2, updated_at = ?2 WHERE id = ?3",
            params![result, ts, id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

async fn fail_summary_job(pool: &DbPool, id: &str, error: &str) -> Result<(), String> {
    let id = id.to_string();
    let error = error.to_string();
    pool.write(Priority::Low, move |conn| {
        let ts = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE summary_jobs SET status = 'pending', error = ?1, failed_at = ?2, updated_at = ?2 WHERE id = ?3",
            params![error, ts, id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use signet_core::db::Priority;

    fn test_db(name: &str) -> std::path::PathBuf {
        let pid = std::process::id();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|v| v.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("signet-summary-{name}-{pid}-{now}.db"))
    }

    #[tokio::test]
    async fn recovers_leased_summary_jobs_in_batches() {
        let path = test_db("recover");
        let (pool, handle) = DbPool::open(&path).expect("failed to open DB");

        let now = Utc::now().to_rfc3339();
        pool.write(Priority::Low, move |conn| {
            let tx = conn.unchecked_transaction()?;
            {
                let mut stmt = tx.prepare_cached(
                    "INSERT INTO summary_jobs
                     (id, session_key, session_id, harness, project, agent_id, transcript, trigger, status, attempts, max_attempts, created_at)
                     VALUES (?1, ?2, ?3, 'codex', NULL, 'default', 'transcript', 'session_end', ?4, ?5, ?6, ?7)",
                )?;
                for i in 0..205 {
                    let attempts = (i % 3) as i64;
                    let status = if i % 2 == 0 { "processing" } else { "leased" };
                    stmt.execute(params![
                        format!("job-{i}"),
                        format!("session-{i}"),
                        format!("session-{i}"),
                        status,
                        attempts,
                        2i64,
                        &now,
                    ])?;
                }
            }
            tx.commit()?;
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("failed to seed summary jobs");

        assert_eq!(
            recover_summary_jobs(&pool, 100)
                .await
                .expect("first recovery failed"),
            RecoveryBatch {
                selected: 100,
                updated: 100,
            }
        );
        assert_eq!(
            recover_summary_jobs(&pool, 100)
                .await
                .expect("second recovery failed"),
            RecoveryBatch {
                selected: 100,
                updated: 100,
            }
        );
        assert_eq!(
            recover_summary_jobs(&pool, 100)
                .await
                .expect("third recovery failed"),
            RecoveryBatch {
                selected: 5,
                updated: 5,
            }
        );
        assert_eq!(
            recover_summary_jobs(&pool, 100)
                .await
                .expect("empty recovery failed"),
            RecoveryBatch {
                selected: 0,
                updated: 0,
            }
        );

        let inflight: i64 = pool
            .read(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM summary_jobs WHERE status IN ('processing', 'leased')",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .await
            .expect("failed to count in-flight jobs");
        assert_eq!(inflight, 0);

        let dead: i64 = pool
            .read(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM summary_jobs WHERE status = 'dead'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .await
            .expect("failed to count dead jobs");
        assert!(dead > 0);

        drop(pool);
        handle.await.expect("writer task join failed");
        let _ = std::fs::remove_file(path);
    }
}
