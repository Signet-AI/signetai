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

#[derive(Debug, Clone)]
struct EntityContext {
    name: String,
    agent_id: String,
    aspects: Vec<String>,
}

#[derive(Debug, Clone)]
struct MemoryFact {
    id: String,
    content: String,
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
        let aspect_entity_id = entity_id.clone();
        let context = pool
            .read(move |conn| {
                let (name, agent_id): (String, String) = conn
                    .query_row(
                        "SELECT name, COALESCE(agent_id, 'default') FROM entities WHERE id = ?1",
                        rusqlite::params![eid],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .unwrap_or_else(|_| (String::new(), "default".to_string()));

                let mut stmt = conn.prepare_cached(
                    "SELECT canonical_name FROM entity_aspects WHERE entity_id = ?1",
                )?;
                let eid2 = aspect_entity_id;
                let aspects: Vec<String> = stmt
                    .query_map(rusqlite::params![eid2], |r| r.get(0))?
                    .filter_map(|r| r.ok())
                    .collect();

                Ok(EntityContext {
                    name,
                    agent_id,
                    aspects,
                })
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

        let facts = load_memory_facts(pool, &memory_ids).await?;

        if facts.is_empty() {
            for job in &entity_jobs {
                let _ = complete_structural_job(pool, &job.id, "no facts found").await;
            }
            continue;
        }

        // Call LLM for classification
        let fact_contents = facts
            .iter()
            .map(|fact| fact.content.clone())
            .collect::<Vec<_>>();
        let prompt = build_classify_prompt(&context.name, &context.aspects, &fact_contents);
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
        aspects_created +=
            persist_classify_results(pool, &entity_id, &context, &facts, &parsed).await?;

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
async fn load_memory_facts(pool: &DbPool, ids: &[String]) -> Result<Vec<MemoryFact>, String> {
    let mids: Vec<String> = ids.to_vec();
    pool.read(move |conn| {
        let mut facts = Vec::new();
        let mut stmt = conn.prepare_cached(
            "SELECT id, content FROM memories
             WHERE id = ?1 AND COALESCE(is_deleted, 0) = 0",
        )?;
        for id in mids {
            if let Ok(fact) = stmt.query_row(rusqlite::params![id], |row| {
                Ok(MemoryFact {
                    id: row.get(0)?,
                    content: row.get(1)?,
                })
            }) {
                facts.push(fact);
            }
        }
        Ok(facts)
    })
    .await
    .map_err(|e| e.to_string())
}

fn canonical_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn normalized_content(value: &str) -> String {
    canonical_name(value)
}

async fn persist_classify_results(
    pool: &DbPool,
    entity_id: &str,
    context: &EntityContext,
    facts: &[MemoryFact],
    items: &[ClassifyItem],
) -> Result<usize, String> {
    let entity_id = entity_id.to_string();
    let agent_id = context.agent_id.clone();
    let facts = facts.to_vec();
    let items = items.to_vec();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        let mut written = 0usize;
        for item in items {
            let aspect_name = item.aspect.trim();
            if aspect_name.is_empty() {
                continue;
            }
            let Some(fact) = item
                .fact_index
                .checked_sub(1)
                .and_then(|index| facts.get(index))
            else {
                continue;
            };
            let canonical = canonical_name(aspect_name);
            let aspect_id = match conn.query_row(
                "SELECT id FROM entity_aspects WHERE entity_id = ?1 AND canonical_name = ?2",
                rusqlite::params![entity_id, canonical],
                |row| row.get::<_, String>(0),
            ) {
                Ok(id) => id,
                Err(rusqlite::Error::QueryReturnedNoRows) => {
                    let id = uuid::Uuid::new_v4().to_string();
                    conn.execute(
                        "INSERT INTO entity_aspects
                         (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, 0.6, ?6, ?6)",
                        rusqlite::params![id, entity_id, agent_id, aspect_name, canonical, ts],
                    )?;
                    id
                }
                Err(error) => return Err(error.into()),
            };
            conn.execute(
                "UPDATE entity_aspects SET name = ?1, updated_at = ?2
                 WHERE id = ?3",
                rusqlite::params![aspect_name, ts, aspect_id],
            )?;
            let kind = if item.kind.trim().eq_ignore_ascii_case("constraint") {
                "constraint"
            } else {
                "attribute"
            };
            let normalized = normalized_content(&fact.content);
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM entity_attributes
                 WHERE aspect_id = ?1
                   AND memory_id = ?2
                   AND normalized_content = ?3
                   AND status = 'active'",
                rusqlite::params![aspect_id, fact.id, normalized],
                |row| row.get(0),
            )?;
            if exists > 0 {
                continue;
            }
            conn.execute(
                "INSERT INTO entity_attributes
                 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
                  confidence, importance, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0.7, 0.5, 'active', ?8, ?8)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    aspect_id,
                    agent_id,
                    fact.id,
                    kind,
                    fact.content,
                    normalized,
                    ts
                ],
            )?;
            written += 1;
        }
        Ok(serde_json::json!({ "written": written }))
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|value| {
        value
            .get("written")
            .and_then(|value| value.as_u64())
            .map(|value| value as usize)
            .ok_or_else(|| "classify persistence result missing written count".to_string())
    })
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

        let facts = load_memory_facts(pool, &memory_ids).await?;
        let fact_contents = facts
            .iter()
            .map(|fact| fact.content.clone())
            .collect::<Vec<_>>();

        // Call LLM for dependency extraction
        let prompt = build_dependency_prompt(&entity_name, &fact_contents);
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
        deps_created += persist_dependency_results(pool, &entity_id, &parsed).await?;

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

async fn persist_dependency_results(
    pool: &DbPool,
    entity_id: &str,
    items: &[DependencyItem],
) -> Result<usize, String> {
    let entity_id = entity_id.to_string();
    let items = items.to_vec();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        let (source_name, agent_id): (String, String) = conn.query_row(
            "SELECT name, COALESCE(agent_id, 'default') FROM entities WHERE id = ?1",
            rusqlite::params![entity_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut written = 0usize;
        for item in items {
            let relationship = item.relationship.trim();
            if !DEPENDENCY_TYPES.contains(&relationship) {
                continue;
            }
            let target_name = item.target.trim();
            if target_name.is_empty() || target_name.eq_ignore_ascii_case(&source_name) {
                continue;
            }
            let target_canonical = canonical_name(target_name);
            let target_id = match conn.query_row(
                "SELECT id FROM entities WHERE name = ?1 OR canonical_name = ?2 LIMIT 1",
                rusqlite::params![target_name, target_canonical],
                |row| row.get::<_, String>(0),
            ) {
                Ok(id) => id,
                Err(rusqlite::Error::QueryReturnedNoRows) => {
                    let id = uuid::Uuid::new_v4().to_string();
                    conn.execute(
                        "INSERT INTO entities
                         (id, name, entity_type, description, created_at, updated_at,
                          agent_id, canonical_name)
                         VALUES (?1, ?2, 'unknown', NULL, ?3, ?3, ?4, ?5)",
                        rusqlite::params![id, target_name, ts, agent_id, target_canonical],
                    )?;
                    id
                }
                Err(error) => return Err(error.into()),
            };
            let incoming = item
                .direction
                .as_deref()
                .is_some_and(|direction| direction.eq_ignore_ascii_case("incoming"));
            let (source_entity_id, target_entity_id) = if incoming {
                (target_id, entity_id.clone())
            } else {
                (entity_id.clone(), target_id)
            };
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM entity_dependencies
                 WHERE source_entity_id = ?1
                   AND target_entity_id = ?2
                   AND agent_id = ?3
                   AND dependency_type = ?4",
                rusqlite::params![source_entity_id, target_entity_id, agent_id, relationship],
                |row| row.get(0),
            )?;
            if exists > 0 {
                conn.execute(
                    "UPDATE entity_dependencies
                     SET reason = COALESCE(?1, reason),
                         confidence = COALESCE(confidence, 0.7),
                         updated_at = ?2
                     WHERE source_entity_id = ?3
                       AND target_entity_id = ?4
                       AND agent_id = ?5
                       AND dependency_type = ?6",
                    rusqlite::params![
                        item.reason.as_deref(),
                        ts,
                        source_entity_id,
                        target_entity_id,
                        agent_id,
                        relationship
                    ],
                )?;
                continue;
            }
            conn.execute(
                "INSERT INTO entity_dependencies
                 (id, source_entity_id, target_entity_id, agent_id, dependency_type,
                  strength, confidence, reason, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0.7, 0.7, ?6, ?7, ?7)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    source_entity_id,
                    target_entity_id,
                    agent_id,
                    relationship,
                    item.reason.as_deref(),
                    ts
                ],
            )?;
            written += 1;
        }
        Ok(serde_json::json!({ "written": written }))
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|value| {
        value
            .get("written")
            .and_then(|value| value.as_u64())
            .map(|value| value as usize)
            .ok_or_else(|| "dependency persistence result missing written count".to_string())
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

#[derive(Debug, Clone, Deserialize)]
struct ClassifyItem {
    fact_index: usize,
    aspect: String,
    kind: String,
}

#[derive(Debug, Clone, Deserialize)]
struct DependencyItem {
    target: String,
    relationship: String,
    direction: Option<String>,
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
    use signet_core::db::Priority;

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

    fn open_test_pool() -> (DbPool, tokio::task::JoinHandle<()>) {
        let path =
            std::env::temp_dir().join(format!("signet-structural-{}.db", uuid::Uuid::new_v4()));
        DbPool::open(&path).expect("open test db")
    }

    #[tokio::test]
    async fn classify_persistence_writes_aspects_and_attributes() {
        let (pool, handle) = open_test_pool();
        pool.write(Priority::High, |conn| {
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO entities
                 (id, name, entity_type, created_at, updated_at, agent_id, canonical_name)
                 VALUES ('entity-user', 'User', 'person', ?1, ?1, 'agent-a', 'user')",
                rusqlite::params![now],
            )?;
            conn.execute(
                "INSERT INTO memories
                 (id, type, content, created_at, updated_at, updated_by, vector_clock,
                  agent_id, is_deleted)
                 VALUES ('memory-preference', 'fact', 'User prefers quiet tools.', ?1, ?1,
                         'test', '{}', 'agent-a', 0)",
                rusqlite::params![now],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("seed classify fixtures");

        let count = persist_classify_results(
            &pool,
            "entity-user",
            &EntityContext {
                name: "User".to_string(),
                agent_id: "agent-a".to_string(),
                aspects: vec![],
            },
            &[MemoryFact {
                id: "memory-preference".to_string(),
                content: "User prefers quiet tools.".to_string(),
            }],
            &[ClassifyItem {
                fact_index: 1,
                aspect: "Preferences".to_string(),
                kind: "attribute".to_string(),
            }],
        )
        .await
        .expect("persist classify results");
        assert_eq!(count, 1);

        let counts = pool
            .read(|conn| {
                let aspects: i64 =
                    conn.query_row("SELECT COUNT(*) FROM entity_aspects", [], |row| row.get(0))?;
                let attrs: i64 =
                    conn.query_row("SELECT COUNT(*) FROM entity_attributes", [], |row| {
                        row.get(0)
                    })?;
                let kind: String =
                    conn.query_row("SELECT kind FROM entity_attributes", [], |row| row.get(0))?;
                Ok(serde_json::json!({
                    "aspects": aspects,
                    "attrs": attrs,
                    "kind": kind,
                }))
            })
            .await
            .expect("read classify rows");
        assert_eq!(counts["aspects"], 1);
        assert_eq!(counts["attrs"], 1);
        assert_eq!(counts["kind"], "attribute");

        let duplicate_count = persist_classify_results(
            &pool,
            "entity-user",
            &EntityContext {
                name: "User".to_string(),
                agent_id: "agent-a".to_string(),
                aspects: vec!["preferences".to_string()],
            },
            &[MemoryFact {
                id: "memory-preference".to_string(),
                content: "User prefers quiet tools.".to_string(),
            }],
            &[ClassifyItem {
                fact_index: 1,
                aspect: "Preferences".to_string(),
                kind: "attribute".to_string(),
            }],
        )
        .await
        .expect("persist duplicate classify results");
        assert_eq!(duplicate_count, 0);

        drop(pool);
        handle.abort();
    }

    #[tokio::test]
    async fn dependency_persistence_writes_target_and_upserts_edge() {
        let (pool, handle) = open_test_pool();
        pool.write(Priority::High, |conn| {
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO entities
                 (id, name, entity_type, created_at, updated_at, agent_id, canonical_name)
                 VALUES ('entity-service', 'Service', 'system', ?1, ?1, 'agent-a', 'service')",
                rusqlite::params![now],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("seed dependency fixtures");

        let count = persist_dependency_results(
            &pool,
            "entity-service",
            &[DependencyItem {
                target: "Database".to_string(),
                relationship: "requires".to_string(),
                direction: Some("outgoing".to_string()),
                reason: Some("Service reads stored state.".to_string()),
            }],
        )
        .await
        .expect("persist dependency results");
        assert_eq!(count, 1);

        let rows = pool
            .read(|conn| {
                let target_name: String = conn.query_row(
                    "SELECT e.name FROM entity_dependencies d
                     JOIN entities e ON e.id = d.target_entity_id
                     WHERE d.source_entity_id = 'entity-service'",
                    [],
                    |row| row.get(0),
                )?;
                let reason: String =
                    conn.query_row("SELECT reason FROM entity_dependencies", [], |row| {
                        row.get(0)
                    })?;
                Ok(serde_json::json!({
                    "target": target_name,
                    "reason": reason,
                }))
            })
            .await
            .expect("read dependency rows");
        assert_eq!(rows["target"], "Database");
        assert_eq!(rows["reason"], "Service reads stored state.");

        let duplicate_count = persist_dependency_results(
            &pool,
            "entity-service",
            &[DependencyItem {
                target: "Database".to_string(),
                relationship: "requires".to_string(),
                direction: Some("outgoing".to_string()),
                reason: Some("Updated reason.".to_string()),
            }],
        )
        .await
        .expect("persist duplicate dependency results");
        assert_eq!(duplicate_count, 0);

        let reason = pool
            .read(|conn| {
                let reason: String =
                    conn.query_row("SELECT reason FROM entity_dependencies", [], |row| {
                        row.get(0)
                    })?;
                Ok(serde_json::json!(reason))
            })
            .await
            .expect("read updated dependency");
        assert_eq!(reason, "Updated reason.");

        drop(pool);
        handle.abort();
    }
}
