//! Structural workers: entity classification and dependency extraction.
//!
//! Pass 2a (classify): Classify facts into entity aspects and kinds.
//! Pass 2b (dependency): Extract entity relationships and dependencies.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tracing::{info, warn};

use signet_core::constants::DEPENDENCY_TYPES;
use signet_core::db::DbPool;

use crate::provider::{GenerateOpts, LlmProvider, LlmSemaphore};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Configuration for structural workers.
#[derive(Debug, Clone)]
pub struct StructuralConfig {
    pub poll_ms: u64,
    pub max_retries: u32,
    pub timeout_ms: u64,
    pub max_tokens: u32,
    pub batch_size: usize,
}

impl Default for StructuralConfig {
    fn default() -> Self {
        Self {
            poll_ms: 2_000,
            max_retries: 3,
            timeout_ms: 60_000,
            max_tokens: 2048,
            batch_size: 10,
        }
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// One-line descriptions for each dependency type (mirrors structural-dependency.ts).
/// Parallel to DEPENDENCY_TYPES — indices must match.
pub const DEP_DESCRIPTIONS: &[&str] = &[
    "actively calls or consumes at runtime",              // uses
    "cannot function without (hard prerequisite)",        // requires
    "maintained or governed by",                          // owned_by
    "owns, controls, or is responsible for",              // owns
    "prevents progress of",                               // blocks
    "sends data or signals to",                           // informs
    "keeps operational, updated, or healthy",             // maintains
    "provides the concrete implementation for",           // implements
    "was created or constructed by",                      // built
    "needs but does not directly call (soft dependency)", // depends_on
    "associated loosely, no directional dependency",      // related_to
    "acquired knowledge from",                            // learned_from
    "transfers knowledge to",                             // teaches
    "is aware of or references",                          // knows
    "presupposes as true without verifying",              // assumes
    "provides evidence for a claim",                      // supports_claim
    "was written or authored by",                         // authored_by
    "links or points to another source",                  // links_to
    "contains or encloses as a child item",               // contains
    "contains a note, document, or knowledge artifact",   // contains_note
    "conflicts with or negates",                          // contradicts
    "replaces or obsoletes",                              // supersedes
    "is a component or subset of",                        // part_of
    "created a concrete artifact as evidence or output",  // produced_artifact
    "must happen before (temporal)",                      // precedes
    "happens after (temporal)",                           // follows
    "causes to start or execute",                         // triggers
    "is permitted or capable of executing",               // may_execute
    "needs approval from the named actor or policy",      // requires_approval_from
    "change here affects (blast radius)",                 // impacts
    "generates as output",                                // produces
    "takes as input",                                     // consumes
];

/// A structural job (classify or dependency).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StructuralJob {
    id: String,
    entity_id: Option<String>,
    memory_id: Option<String>,
    job_type: String,
    payload: Option<String>,
    attempts: i64,
}

/// Result of structural processing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralResult {
    pub aspects_created: usize,
    pub dependencies_created: usize,
    pub jobs_processed: usize,
}

// ---------------------------------------------------------------------------
// Classify worker
// ---------------------------------------------------------------------------

pub struct ClassifyHandle {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl ClassifyHandle {
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

pub fn start_classify(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: StructuralConfig,
) -> ClassifyHandle {
    let (tx, rx) = watch::channel(false);
    let handle = tokio::spawn(classify_loop(pool, provider, semaphore, config, rx));
    ClassifyHandle {
        shutdown: tx,
        handle,
    }
}

async fn classify_loop(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: StructuralConfig,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut failures: u32 = 0;
    let base = Duration::from_millis(config.poll_ms);
    let max = Duration::from_secs(120);

    info!(
        poll_ms = config.poll_ms,
        "structural classify worker started"
    );

    loop {
        if *shutdown.borrow() {
            info!("structural classify worker shutting down");
            break;
        }

        let delay = if failures > 0 {
            (base * 2u32.pow(failures.min(6))).min(max)
        } else {
            base
        };

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown.changed() => {
                info!("structural classify worker shutting down");
                break;
            }
        }

        let batch_size = config.batch_size;
        let max_retries = config.max_retries;
        let jobs = match lease_structural_jobs(
            &pool,
            "structural_classify",
            batch_size,
            max_retries,
        )
        .await
        {
            Ok(jobs) if jobs.is_empty() => continue,
            Ok(jobs) => jobs,
            Err(e) => {
                warn!(err = %e, "failed to lease classify jobs");
                failures += 1;
                continue;
            }
        };

        info!(count = jobs.len(), "processing classify batch");

        match process_classify(&pool, &jobs, &provider, &semaphore, &config).await {
            Ok(result) => {
                failures = 0;
                info!(
                    aspects = result.aspects_created,
                    processed = result.jobs_processed,
                    "classify batch completed"
                );
            }
            Err(e) => {
                failures += 1;
                warn!(err = %e, "classify batch failed");
            }
        }
    }
}

async fn process_classify(
    pool: &DbPool,
    jobs: &[StructuralJob],
    provider: &Arc<dyn LlmProvider>,
    semaphore: &Arc<LlmSemaphore>,
    config: &StructuralConfig,
) -> Result<StructuralResult, String> {
    let mut aspects_created = 0;
    let job_count = jobs.len();

    // Group by entity_id (owned data to avoid lifetime issues across await)
    let mut by_entity: std::collections::HashMap<String, Vec<StructuralJob>> =
        std::collections::HashMap::new();
    for job in jobs {
        if let Some(eid) = &job.entity_id {
            by_entity.entry(eid.clone()).or_default().push(job.clone());
        }
    }

    for (entity_id, entity_jobs) in by_entity {
        // Load entity context and existing aspects
        let eid = entity_id.clone();
        let context = pool
            .read(move |conn| {
                let name: String = conn
                    .query_row(
                        "SELECT name FROM entities WHERE id = ?1",
                        rusqlite::params![eid],
                        |r| r.get(0),
                    )
                    .unwrap_or_default();

                let mut stmt =
                    conn.prepare_cached("SELECT name FROM entity_aspects WHERE entity_id = ?1")?;
                let eid2 = entity_id;
                let aspects: Vec<String> = stmt
                    .query_map(rusqlite::params![eid2], |r| r.get(0))?
                    .filter_map(|r| r.ok())
                    .collect();

                Ok((name, aspects))
            })
            .await
            .map_err(|e| e.to_string())?;

        // Build fact list from memory content
        let memory_ids: Vec<String> = entity_jobs
            .iter()
            .filter_map(|j| j.memory_id.clone())
            .collect();

        if memory_ids.is_empty() {
            continue;
        }

        let facts = load_memory_content(pool, &memory_ids).await?;

        if facts.is_empty() {
            for job in &entity_jobs {
                let _ = complete_structural_job(pool, &job.id, "no facts found").await;
            }
            continue;
        }

        // Call LLM for classification
        let prompt = build_classify_prompt(&context.0, &context.1, &facts);
        let opts = GenerateOpts {
            timeout_ms: Some(config.timeout_ms),
            max_tokens: Some(config.max_tokens),
        };

        let p = provider.clone();
        let raw = semaphore
            .run(async { p.generate(&prompt, &opts).await })
            .await
            .map_err(|e| format!("LLM classify failed: {e}"))?;

        let parsed = parse_classify_output(&raw.text);
        aspects_created += parsed.len();

        // TODO: Create/update entity_aspects rows, update entity_attributes

        for job in &entity_jobs {
            let _ = complete_structural_job(pool, &job.id, "classified").await;
        }
    }

    Ok(StructuralResult {
        aspects_created,
        dependencies_created: 0,
        jobs_processed: job_count,
    })
}

/// Load memory content for a set of memory IDs.
async fn load_memory_content(pool: &DbPool, ids: &[String]) -> Result<Vec<String>, String> {
    let mids: Vec<String> = ids.to_vec();
    pool.read(move |conn| {
        let placeholders: Vec<String> = (0..mids.len()).map(|i| format!("?{}", i + 1)).collect();
        let sql = format!(
            "SELECT content FROM memories WHERE id IN ({}) AND deleted = 0",
            placeholders.join(",")
        );
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::types::ToSql> = mids
            .iter()
            .map(|s| s as &dyn rusqlite::types::ToSql)
            .collect();
        let facts: Vec<String> = stmt
            .query_map(params.as_slice(), |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(facts)
    })
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Dependency worker
// ---------------------------------------------------------------------------

pub struct DependencyHandle {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl DependencyHandle {
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

pub fn start_dependency(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: StructuralConfig,
) -> DependencyHandle {
    let (tx, rx) = watch::channel(false);
    let handle = tokio::spawn(dependency_loop(pool, provider, semaphore, config, rx));
    DependencyHandle {
        shutdown: tx,
        handle,
    }
}

async fn dependency_loop(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: StructuralConfig,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut failures: u32 = 0;
    let base = Duration::from_millis(config.poll_ms);
    let max = Duration::from_secs(120);

    info!(
        poll_ms = config.poll_ms,
        "structural dependency worker started"
    );

    loop {
        if *shutdown.borrow() {
            info!("structural dependency worker shutting down");
            break;
        }

        let delay = if failures > 0 {
            (base * 2u32.pow(failures.min(6))).min(max)
        } else {
            base
        };

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown.changed() => {
                info!("structural dependency worker shutting down");
                break;
            }
        }

        let batch_size = config.batch_size;
        let max_retries = config.max_retries;
        let jobs =
            match lease_structural_jobs(&pool, "structural_dependency", batch_size, max_retries)
                .await
            {
                Ok(jobs) if jobs.is_empty() => continue,
                Ok(jobs) => jobs,
                Err(e) => {
                    warn!(err = %e, "failed to lease dependency jobs");
                    failures += 1;
                    continue;
                }
            };

        info!(count = jobs.len(), "processing dependency batch");

        match process_dependency(&pool, &jobs, &provider, &semaphore, &config).await {
            Ok(result) => {
                failures = 0;
                info!(
                    deps = result.dependencies_created,
                    processed = result.jobs_processed,
                    "dependency batch completed"
                );
            }
            Err(e) => {
                failures += 1;
                warn!(err = %e, "dependency batch failed");
            }
        }
    }
}

async fn process_dependency(
    pool: &DbPool,
    jobs: &[StructuralJob],
    provider: &Arc<dyn LlmProvider>,
    semaphore: &Arc<LlmSemaphore>,
    config: &StructuralConfig,
) -> Result<StructuralResult, String> {
    let mut deps_created = 0;
    let job_count = jobs.len();

    // Group by entity_id (owned data)
    let mut by_entity: std::collections::HashMap<String, Vec<StructuralJob>> =
        std::collections::HashMap::new();
    for job in jobs {
        if let Some(eid) = &job.entity_id {
            by_entity.entry(eid.clone()).or_default().push(job.clone());
        }
    }

    for (entity_id, entity_jobs) in by_entity {
        let eid = entity_id.clone();
        let entity_name: String = pool
            .read(move |conn| {
                Ok(conn
                    .query_row(
                        "SELECT name FROM entities WHERE id = ?1",
                        rusqlite::params![eid],
                        |r| r.get(0),
                    )
                    .unwrap_or_default())
            })
            .await
            .map_err(|e| e.to_string())?;

        let memory_ids: Vec<String> = entity_jobs
            .iter()
            .filter_map(|j| j.memory_id.clone())
            .collect();

        if memory_ids.is_empty() {
            for job in &entity_jobs {
                let _ = complete_structural_job(pool, &job.id, "no memory ids").await;
            }
            continue;
        }

        let facts = load_memory_content(pool, &memory_ids).await?;

        // Call LLM for dependency extraction
        let prompt = build_dependency_prompt(&entity_name, &facts);
        let opts = GenerateOpts {
            timeout_ms: Some(config.timeout_ms),
            max_tokens: Some(config.max_tokens),
        };

        let p = provider.clone();
        let raw = semaphore
            .run(async { p.generate(&prompt, &opts).await })
            .await
            .map_err(|e| format!("LLM dependency failed: {e}"))?;

        let parsed = parse_dependency_output(&raw.text);
        deps_created += parsed.len();

        // TODO: Create entity_dependencies rows with validated types

        for job in &entity_jobs {
            let _ = complete_structural_job(pool, &job.id, "dependencies extracted").await;
        }
    }

    Ok(StructuralResult {
        aspects_created: 0,
        dependencies_created: deps_created,
        jobs_processed: job_count,
    })
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

fn build_classify_prompt(
    entity_name: &str,
    existing_aspects: &[String],
    facts: &[String],
) -> String {
    let aspects_str = if existing_aspects.is_empty() {
        "none yet".to_string()
    } else {
        existing_aspects.join(", ")
    };

    let facts_str: String = facts
        .iter()
        .enumerate()
        .map(|(i, f)| format!("{}. {}", i + 1, f))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"Classify the following facts about the entity "{entity_name}" into aspects (dimensions of knowledge).

Existing aspects: {aspects_str}

Facts:
{facts_str}

For each fact, return a JSON array of objects with:
- "fact_index": number (1-based)
- "aspect": string (dimension name, e.g. "preferences", "architecture", "behavior")
- "kind": "attribute" or "constraint"

Reuse existing aspect names when the fact fits. Create new aspects only when necessary.
Respond with only the JSON array."#
    )
}

fn build_dependency_prompt(entity_name: &str, facts: &[String]) -> String {
    let facts_str: String = facts
        .iter()
        .enumerate()
        .map(|(i, f)| format!("{}. {}", i + 1, f))
        .collect::<Vec<_>>()
        .join("\n");

    let type_list: String = DEPENDENCY_TYPES
        .iter()
        .zip(DEP_DESCRIPTIONS.iter())
        .map(|(t, d)| format!("- {t}: {d}"))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"Extract entity relationships from facts about "{entity_name}".

Facts:
{facts_str}

Dependency types:
{type_list}

For each relationship found, return a JSON array of objects with:
- "target": string (target entity name)
- "relationship": one of the dependency types above
- "reason": brief explanation of why this dependency exists
- "direction": "outgoing" or "incoming"

Only extract clear, explicit relationships. Respond with only the JSON array."#
    )
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ClassifyItem {
    #[allow(dead_code)]
    fact_index: usize,
    #[allow(dead_code)]
    aspect: String,
    #[allow(dead_code)]
    kind: String,
}

#[derive(Debug, Deserialize)]
struct DependencyItem {
    #[allow(dead_code)]
    target: String,
    #[allow(dead_code)]
    relationship: String,
    #[allow(dead_code)]
    direction: Option<String>,
    #[allow(dead_code)]
    reason: Option<String>,
}

fn parse_classify_output(raw: &str) -> Vec<ClassifyItem> {
    let cleaned = crate::extraction::parse_json_array(raw);
    serde_json::from_str::<Vec<ClassifyItem>>(&cleaned).unwrap_or_default()
}

fn parse_dependency_output(raw: &str) -> Vec<DependencyItem> {
    let cleaned = crate::extraction::parse_json_array(raw);
    serde_json::from_str::<Vec<DependencyItem>>(&cleaned).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

async fn lease_structural_jobs(
    pool: &DbPool,
    job_type: &str,
    batch_size: usize,
    max_attempts: u32,
) -> Result<Vec<StructuralJob>, String> {
    let jt = job_type.to_string();
    let val = pool
        .write(signet_core::db::Priority::Low, move |conn| {
            let ts = chrono::Utc::now().to_rfc3339();
            let mut stmt = conn.prepare_cached(
                "UPDATE memory_jobs SET status = 'leased', leased_at = ?1, updated_at = ?1, attempts = attempts + 1
                 WHERE id IN (
                    SELECT id FROM memory_jobs
                    WHERE status = 'pending' AND job_type = ?2 AND attempts < ?3
                    ORDER BY created_at ASC LIMIT ?4
                 ) RETURNING id, entity_id, memory_id, job_type, payload, attempts",
            )?;

            let jobs: Vec<serde_json::Value> = stmt
                .query_map(
                    rusqlite::params![ts, jt, max_attempts, batch_size],
                    |row| {
                        Ok(serde_json::json!({
                            "id": row.get::<_, String>(0)?,
                            "entity_id": row.get::<_, Option<String>>(1)?,
                            "memory_id": row.get::<_, Option<String>>(2)?,
                            "job_type": row.get::<_, String>(3)?,
                            "payload": row.get::<_, Option<String>>(4)?,
                            "attempts": row.get::<_, i64>(5)?,
                        }))
                    },
                )?
                .filter_map(|r| r.ok())
                .collect();

            Ok(serde_json::json!(jobs))
        })
        .await
        .map_err(|e| e.to_string())?;

    serde_json::from_value(val).map_err(|e| e.to_string())
}

async fn complete_structural_job(pool: &DbPool, job_id: &str, result: &str) -> Result<(), String> {
    let id = job_id.to_string();
    let result = result.to_string();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE memory_jobs SET status = 'completed', result = ?1, completed_at = ?2, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![result, ts, id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_dependency_types() {
        assert_eq!(DEPENDENCY_TYPES.len(), 32);
        assert!(DEPENDENCY_TYPES.contains(&"uses"));
        assert!(DEPENDENCY_TYPES.contains(&"informs"));
        assert!(DEPENDENCY_TYPES.contains(&"consumes"));
        assert!(DEPENDENCY_TYPES.contains(&"produces"));
        assert_eq!(DEP_DESCRIPTIONS.len(), DEPENDENCY_TYPES.len());
    }

    #[test]
    fn classify_prompt_includes_entity() {
        let prompt =
            build_classify_prompt("UserService", &["preferences".into()], &["fact1".into()]);
        assert!(prompt.contains("UserService"));
        assert!(prompt.contains("preferences"));
        assert!(prompt.contains("fact1"));
    }

    #[test]
    fn dependency_prompt_valid_types() {
        let prompt = build_dependency_prompt("Database", &["uses connection pool".into()]);
        assert!(prompt.contains("Database"));
        assert!(prompt.contains("uses"));
        assert!(prompt.contains("requires"));
    }
}
