//! Prospective memory indexing.
//!
//! Rust parity for `platform/daemon/src/pipeline/prospective-index.ts`:
//! build a hint prompt, parse/filter LLM output into useful future-query cues,
//! and enqueue/process durable `prospective_index` memory jobs.

use crate::provider::{GenerateOpts, LlmProvider, ProviderError};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Generation knobs matching the TS `PipelineHintsConfig` fields used by
/// `generateHints` (`max`, `timeout`, `maxTokens`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HintGenerationConfig {
    pub max: usize,
    pub timeout_ms: u64,
    pub max_tokens: u32,
}

impl Default for HintGenerationConfig {
    fn default() -> Self {
        Self {
            max: 5,
            timeout_ms: 5_000,
            max_tokens: 256,
        }
    }
}

/// Leased prospective-index job row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HintJobRow {
    pub id: String,
    pub memory_id: String,
    pub payload: String,
    pub attempts: i64,
    pub max_attempts: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HintJobOutcome {
    NoJob,
    Completed {
        memory_id: String,
        hints: usize,
    },
    Failed {
        memory_id: Option<String>,
        error: String,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum ProspectiveIndexError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("provider error: {0}")]
    Provider(#[from] ProviderError),
    #[error("invalid payload")]
    InvalidPayload,
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct HintPayload {
    memory_id: String,
    content: String,
}

/// Build the exact prompt used by the TS prospective indexer.
pub fn build_prompt(content: &str, max: usize) -> String {
    [
        "Given this fact stored in a personal memory system:".to_string(),
        format!("\"{content}\""),
        String::new(),
        format!(
            "Generate {max} diverse questions or cues a user might use in the future when this fact would be helpful. Include:"
        ),
        "- Direct questions (\"Where does X live?\")".to_string(),
        "- Temporal questions (\"When did X happen?\")".to_string(),
        "- Relational questions (\"Who is X's partner?\")".to_string(),
        "- Indirect/conversational cues (\"Tell me about X's move\")".to_string(),
        String::new(),
        "Return ONLY the questions, one per line. No numbering, no bullets.".to_string(),
    ]
    .join("\n")
}

fn strip_think_blocks(raw: &str) -> String {
    let mut rest = raw;
    let mut out = String::with_capacity(raw.len());
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        let after_start = &rest[start + "<think>".len()..];
        if let Some(end) = after_start.find("</think>") {
            rest = &after_start[end + "</think>".len()..];
        } else {
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

fn strip_number_or_bullet_prefix(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut idx = 0usize;
    while idx < bytes.len() && bytes[idx].is_ascii_digit() {
        idx += 1;
    }
    if idx > 0 && idx < bytes.len() && matches!(bytes[idx], b'.' | b')') {
        idx += 1;
        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        return &line[idx..];
    }

    if matches!(bytes.first(), Some(b'-' | b'*')) {
        idx = 1;
        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        return &line[idx..];
    }

    line
}

fn contains_prompt_residue(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("however")
        || lower.contains("but note")
        || lower.contains("alternatively")
        || lower.contains("the problem says")
        || lower.contains("the fact says")
        || lower.contains("diverse question")
        || lower.contains("diverse cue")
        || lower.contains("we need to")
        || lower.contains("let's")
        || lower.contains("lets")
        || lower.contains("make sure")
}

fn has_generic_label_prefix(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let Some((prefix, _)) = lower.split_once(':') else {
        return false;
    };
    matches!(
        prefix.trim(),
        "who requested"
            | "when"
            | "current status"
            | "what is the current status"
            | "direct"
            | "temporal"
            | "relational"
            | "indirect"
            | "conversational"
    )
}

/// Check whether a parsed line looks like a useful question/cue rather than
/// prompt residue. Mirrors TS `isHintLine`.
pub fn is_hint_line(line: &str) -> bool {
    if contains_prompt_residue(line) || has_generic_label_prefix(line) {
        return false;
    }
    if line.ends_with('?') {
        return true;
    }

    let first = line
        .split(|c: char| !c.is_ascii_alphabetic())
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        first.as_str(),
        "tell"
            | "describe"
            | "explain"
            | "show"
            | "what"
            | "who"
            | "where"
            | "when"
            | "why"
            | "how"
            | "which"
            | "does"
            | "did"
            | "is"
            | "are"
            | "can"
            | "could"
            | "has"
            | "have"
            | "will"
            | "would"
    )
}

/// Parse and filter raw LLM output into prospective hints.
pub fn parse_hints(raw: &str) -> Vec<String> {
    strip_think_blocks(raw)
        .lines()
        .map(strip_number_or_bullet_prefix)
        .map(str::trim)
        .filter(|line| line.len() > 10 && line.len() < 300 && is_hint_line(line))
        .map(ToOwned::to_owned)
        .collect()
}

/// Generate prospective hints using the provided LLM provider.
pub async fn generate_hints(
    provider: &dyn LlmProvider,
    content: &str,
    cfg: HintGenerationConfig,
) -> Result<Vec<String>, ProviderError> {
    let prompt = build_prompt(content, cfg.max);
    let raw = provider
        .generate(
            &prompt,
            &GenerateOpts {
                timeout_ms: Some(cfg.timeout_ms),
                max_tokens: Some(cfg.max_tokens.max(1024)),
            },
        )
        .await?;
    Ok(parse_hints(&raw.text))
}

/// Enqueue a `prospective_index` memory job.
pub fn enqueue_hints_job(
    conn: &Connection,
    memory_id: &str,
    content: &str,
) -> Result<String, ProspectiveIndexError> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let payload = serde_json::to_string(&HintPayload {
        memory_id: memory_id.to_string(),
        content: content.to_string(),
    })?;
    conn.execute(
        "INSERT INTO memory_jobs
         (id, memory_id, job_type, status, payload, attempts, max_attempts, created_at, updated_at)
         VALUES (?1, ?2, 'prospective_index', 'pending', ?3, 0, 3, ?4, ?4)",
        params![id, memory_id, payload, now],
    )?;
    Ok(id)
}

/// Lease the oldest eligible prospective-index job, respecting the TS retry
/// backoff predicate.
pub fn lease_hint_job(
    conn: &Connection,
    max_attempts: i64,
) -> Result<Option<HintJobRow>, ProspectiveIndexError> {
    let epoch = Utc::now().timestamp();
    let mut stmt = conn.prepare(
        "SELECT id, memory_id, payload, attempts, max_attempts
         FROM memory_jobs
         WHERE job_type = 'prospective_index'
           AND status = 'pending'
           AND attempts < ?1
           AND (failed_at IS NULL
                OR (?2 - CAST(strftime('%s', failed_at) AS INTEGER))
                   > MIN((1 << attempts) * 5, 120))
         ORDER BY created_at ASC
         LIMIT 1",
    )?;
    let row = stmt
        .query_row(params![max_attempts, epoch], |row| {
            Ok(HintJobRow {
                id: row.get(0)?,
                memory_id: row.get(1)?,
                payload: row.get(2)?,
                attempts: row.get(3)?,
                max_attempts: row.get(4)?,
            })
        })
        .optional()?;

    let Some(mut job) = row else {
        return Ok(None);
    };

    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE memory_jobs
         SET status = 'leased', leased_at = ?1, attempts = attempts + 1, updated_at = ?1
         WHERE id = ?2",
        params![now, job.id],
    )?;
    job.attempts += 1;
    Ok(Some(job))
}

pub fn complete_hint_job(conn: &Connection, job_id: &str) -> Result<(), ProspectiveIndexError> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE memory_jobs SET status = 'completed', completed_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, job_id],
    )?;
    Ok(())
}

pub fn fail_hint_job(
    conn: &Connection,
    job_id: &str,
    error: &str,
) -> Result<(), ProspectiveIndexError> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE memory_jobs
         SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
             failed_at = ?1, updated_at = ?1,
             payload = json_set(COALESCE(payload, '{}'), '$.lastError', ?2)
         WHERE id = ?3",
        params![now, error, job_id],
    )?;
    Ok(())
}

/// Persist hints for a memory. SQLite's `UNIQUE(memory_id, hint)` enforces TS
/// deduplication semantics via `INSERT OR IGNORE`.
pub fn write_hints(
    conn: &Connection,
    memory_id: &str,
    agent_id: &str,
    hints: &[String],
) -> Result<usize, ProspectiveIndexError> {
    let now = Utc::now().to_rfc3339();
    let mut attempted = 0usize;
    for hint in hints {
        conn.execute(
            "INSERT OR IGNORE INTO memory_hints (id, memory_id, agent_id, hint, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![Uuid::new_v4().to_string(), memory_id, agent_id, hint, now],
        )?;
        attempted += 1;
    }
    Ok(attempted)
}

/// Lease and process one prospective-index job. This helper keeps generation
/// outside any caller-managed transaction, matching the TS worker's DB-lock
/// boundary.
pub async fn process_next_hint_job(
    conn: &Connection,
    provider: &dyn LlmProvider,
    cfg: HintGenerationConfig,
    agent_id: &str,
) -> Result<HintJobOutcome, ProspectiveIndexError> {
    let Some(job) = lease_hint_job(conn, 3)? else {
        return Ok(HintJobOutcome::NoJob);
    };

    let payload = match serde_json::from_str::<HintPayload>(&job.payload) {
        Ok(payload) => payload,
        Err(_) => {
            fail_hint_job(conn, &job.id, "invalid payload")?;
            return Ok(HintJobOutcome::Failed {
                memory_id: Some(job.memory_id),
                error: "invalid payload".to_string(),
            });
        }
    };

    match generate_hints(provider, &payload.content, cfg).await {
        Ok(hints) => {
            let count = hints.len();
            if !hints.is_empty() {
                write_hints(conn, &payload.memory_id, agent_id, &hints)?;
            }
            complete_hint_job(conn, &job.id)?;
            Ok(HintJobOutcome::Completed {
                memory_id: payload.memory_id,
                hints: count,
            })
        }
        Err(err) => {
            let message = err.to_string();
            fail_hint_job(conn, &job.id, &message)?;
            Ok(HintJobOutcome::Failed {
                memory_id: Some(payload.memory_id),
                error: message,
            })
        }
    }
}
