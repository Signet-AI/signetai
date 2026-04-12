//! Cross-entity dependency synthesis worker.
//!
//! Polling worker that discovers connections between entities by presenting
//! the LLM with an entity's facts alongside the top entities from the graph.
//! Separate from the structural-dependency worker which only sees facts from
//! a single memory at a time.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use signet_core::config::StructuralConfig;
use signet_core::constants::DEPENDENCY_TYPES;
use signet_core::db::{DbPool, Priority};
use tokio::sync::watch;
use tracing::{info, warn};

use crate::provider::{GenerateOpts, LlmProvider, LlmSemaphore};
use crate::structural::DEP_DESCRIPTIONS;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct StaleEntity {
    id: String,
    name: String,
    entity_type: String,
}

#[derive(Debug)]
struct GraphEntity {
    name: String,
    entity_type: String,
    mentions: i64,
}

#[derive(Debug)]
struct SynthesisResult {
    target: String,
    dep_type: String,
    reason: String,
}

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

pub struct DepSynthesisHandle {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl DepSynthesisHandle {
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

pub fn start(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: StructuralConfig,
    agent_id: String,
) -> DepSynthesisHandle {
    let (tx, rx) = watch::channel(false);
    let handle = tokio::spawn(worker_loop(pool, provider, semaphore, config, agent_id, rx));
    DepSynthesisHandle {
        shutdown: tx,
        handle,
    }
}

async fn worker_loop(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: StructuralConfig,
    agent_id: String,
    mut shutdown: watch::Receiver<bool>,
) {
    let interval = Duration::from_millis(config.synthesis_interval_ms);

    info!(
        interval_ms = config.synthesis_interval_ms,
        top_entities = config.synthesis_top_entities,
        max_facts = config.synthesis_max_facts,
        max_stall_ms = config.synthesis_max_stall_ms,
        "dep-synthesis worker started"
    );

    loop {
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = shutdown.changed() => {
                info!("dep-synthesis worker shutting down");
                break;
            }
        }

        if *shutdown.borrow() {
            break;
        }

        if let Err(e) = tick(&pool, &provider, &semaphore, &config, &agent_id).await {
            warn!(err = %e, "dep-synthesis tick error");
        }
    }
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

async fn tick(
    pool: &DbPool,
    provider: &Arc<dyn LlmProvider>,
    semaphore: &Arc<LlmSemaphore>,
    config: &StructuralConfig,
    agent_id: &str,
) -> Result<(), String> {
    if let Some(stalled_ms) =
        extraction_stalled_ms(pool, agent_id, config.synthesis_max_stall_ms).await?
    {
        tracing::debug!(
            stalled_ms,
            max_stall_ms = config.synthesis_max_stall_ms,
            "skipping dep-synthesis tick while extraction pipeline is stalled"
        );
        return Ok(());
    }

    let batch = config.dependency_batch_size;
    let stale = find_stale_entities(pool, agent_id, batch).await?;
    if stale.is_empty() {
        return Ok(());
    }

    for entity in stale {
        let facts = load_facts(pool, agent_id, &entity.id, config.synthesis_max_facts).await?;

        if facts.is_empty() {
            mark_synthesized(pool, agent_id, &entity.id).await;
            continue;
        }

        let candidates =
            load_top_entities(pool, agent_id, &entity.id, config.synthesis_top_entities).await?;

        if candidates.is_empty() {
            mark_synthesized(pool, agent_id, &entity.id).await;
            continue;
        }

        let existing = load_existing_targets(pool, agent_id, &entity.id).await?;
        let prompt = build_prompt(&entity, &facts, &candidates, &existing);

        let opts = GenerateOpts {
            timeout_ms: Some(60_000),
            max_tokens: Some(1024),
        };

        let p = provider.clone();
        let raw = match semaphore
            .run(async { p.generate(&prompt, &opts).await })
            .await
        {
            Ok(r) => r,
            Err(e) => {
                warn!(entity = %entity.name, err = %e, "dep-synthesis LLM call failed");
                continue;
            }
        };

        let results = parse_results(&raw.text);
        let mut created = 0usize;
        let agent_id_owned = agent_id.to_string();

        for result in &results {
            let canonical = result.target.trim().to_lowercase();
            let canonical = canonical.split_whitespace().collect::<Vec<_>>().join(" ");

            let target_id =
                match lookup_entity_by_canonical(pool, agent_id, &canonical, &entity.id).await {
                    Ok(Some(id)) => id,
                    Ok(None) => continue,
                    Err(e) => {
                        warn!(err = %e, "dep-synthesis entity lookup failed");
                        continue;
                    }
                };

            let src = entity.id.clone();
            let tgt = target_id;
            let agent_id = agent_id_owned.clone();
            let dep_type = result.dep_type.clone();
            // Mirror TS normalization: trim before fallback check so whitespace-only
            // model output doesn't bypass the related_to reason enforcement.
            let raw = result.reason.trim().to_string();
            let reason = if dep_type == "related_to" && raw.is_empty() {
                format!(
                    "llm synthesized a loose association from {} to {}",
                    entity.name, result.target
                )
            } else {
                raw
            };
            let reason_opt: Option<String> = if reason.is_empty() {
                None
            } else {
                Some(reason)
            };

            let res = pool
                .write(Priority::Low, move |conn| {
                    signet_services::graph::upsert_dependency(
                        conn,
                        signet_services::graph::UpsertDepInput {
                            source_entity_id: &src,
                            target_entity_id: &tgt,
                            agent_id: &agent_id,
                            aspect_id: None,
                            dependency_type: &dep_type,
                            strength: Some(0.5),
                            confidence: None,
                            reason: reason_opt.as_deref(),
                        },
                    )?;
                    Ok(serde_json::Value::Null)
                })
                .await;

            match res {
                Ok(_) => created += 1,
                Err(e) => warn!(
                    entity = %entity.name,
                    target = %result.target,
                    err = %e,
                    "dep-synthesis upsert failed"
                ),
            }
        }

        // Only stamp synthesized if nothing to do, or at least one upsert succeeded
        if results.is_empty() || created > 0 {
            mark_synthesized(pool, agent_id, &entity.id).await;
        }

        info!(
            entity = %entity.name,
            candidates = candidates.len(),
            results = results.len(),
            created,
            "dep-synthesis entity processed"
        );
    }

    Ok(())
}

fn should_run_dependency_synthesis(
    now_ms: i64,
    last_extraction_progress_at_ms: Option<i64>,
    max_stall_ms: u64,
) -> bool {
    if max_stall_ms == 0 {
        return true;
    }
    let Some(last_progress_at) = last_extraction_progress_at_ms else {
        return true;
    };
    if last_progress_at <= 0 {
        return true;
    }
    now_ms.saturating_sub(last_progress_at) <= max_stall_ms as i64
}

async fn extraction_stalled_ms(
    pool: &DbPool,
    agent_id: &str,
    max_stall_ms: u64,
) -> Result<Option<i64>, String> {
    if max_stall_ms == 0 {
        return Ok(None);
    }

    let last_progress = latest_extraction_progress_ms(pool, agent_id).await?;
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    let now_ms = i64::try_from(elapsed.as_millis())
        .map_err(|_| "system time milliseconds overflowed i64".to_string())?;

    if should_run_dependency_synthesis(now_ms, last_progress, max_stall_ms) {
        return Ok(None);
    }

    let Some(last_progress) = last_progress else {
        // Defensive fallback: the stall predicate only returns false for Some timestamps.
        return Ok(None);
    };
    Ok(Some(now_ms.saturating_sub(last_progress)))
}

async fn latest_extraction_progress_ms(
    pool: &DbPool,
    agent_id: &str,
) -> Result<Option<i64>, String> {
    let agent_id = agent_id.to_string();
    pool.read(move |conn| {
        Ok(conn.query_row(
            "SELECT MAX(CAST(strftime('%s', completed_at) AS INTEGER) * 1000)
             FROM memory_jobs j
             JOIN memories m ON m.id = j.memory_id
             WHERE j.status = 'completed'
               AND j.job_type IN ('extract', 'extraction')
               AND j.completed_at IS NOT NULL
               AND m.agent_id = ?1",
            rusqlite::params![agent_id],
            |r| r.get::<_, Option<i64>>(0),
        )?)
        // NOTE: strftime('%s') truncates to 1-second resolution.
        // At the default 30-minute stall window this is negligible (<0.1%).
        // rusqlite bundles SQLite ≥ 3.39, which parses +HH:MM offsets
        // correctly. Older SQLite returns NULL — the Option return handles
        // this gracefully (None = no stall).
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        extraction_stalled_ms, latest_extraction_progress_ms, should_run_dependency_synthesis,
    };
    use signet_core::DbPool;
    use signet_core::db::Priority;

    #[test]
    fn stall_gate_blocks_progress_older_than_window() {
        let now = 10_000;
        assert!(!should_run_dependency_synthesis(now, Some(3_999), 6_000));
        assert!(should_run_dependency_synthesis(now, Some(4_000), 6_000));
    }

    #[test]
    fn stall_gate_allows_disabled_or_unknown_progress() {
        let now = 10_000;
        assert!(should_run_dependency_synthesis(now, Some(1_000), 0));
        assert!(should_run_dependency_synthesis(now, None, 6_000));
        assert!(should_run_dependency_synthesis(now, Some(0), 6_000));
    }

    fn test_db(name: &str) -> std::path::PathBuf {
        let pid = std::process::id();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|v| v.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("signet-dep-synth-{name}-{pid}-{now}.db"))
    }

    #[tokio::test]
    async fn latest_extraction_progress_returns_max_completed_job() {
        let path = test_db("progress");
        let (pool, handle) = DbPool::open(&path).expect("failed to open DB");
        pool.write(Priority::Low, |conn| {
            conn.execute_batch(
                "INSERT INTO memories (id, agent_id, content, created_at, updated_at, updated_by, vector_clock)
                 VALUES ('m1', 'test-agent', 'hello', '2026-04-12T00:00:00Z', '2026-04-12T00:00:00Z', 'test', '{}');
                 INSERT INTO memories (id, agent_id, content, created_at, updated_at, updated_by, vector_clock)
                 VALUES ('m2', 'other-agent', 'world', '2026-04-12T00:00:00Z', '2026-04-12T00:00:00Z', 'test', '{}');
                 INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at, completed_at)
                 VALUES ('j1', 'm1', 'extract', 'completed', '2026-04-12T00:00:00Z', '2026-04-12T00:00:30Z', '2026-04-12T00:00:30Z');
                 INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at, completed_at)
                 VALUES ('j2', 'm1', 'extract', 'completed', '2026-04-12T00:00:00Z', '2026-04-12T00:01:00Z', '2026-04-12T00:01:00Z');
                 INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at, completed_at)
                 VALUES ('j3', 'm2', 'extract', 'completed', '2026-04-12T00:00:00Z', '2026-04-12T00:02:00Z', '2026-04-12T00:02:00Z');",
            )
            .expect("seed data");
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("write succeeded");

        let result = latest_extraction_progress_ms(&pool, "test-agent")
            .await
            .expect("query succeeded");
        assert!(result.is_some());
        let ts = result.unwrap();
        // 2026-04-12T00:01:00Z = 1775952060 epoch seconds * 1000
        assert_eq!(ts, 1_775_952_060_000);
        handle.abort();
    }

    #[tokio::test]
    async fn latest_extraction_progress_scopes_by_agent() {
        let path = test_db("scope");
        let (pool, handle) = DbPool::open(&path).expect("failed to open DB");
        pool.write(Priority::Low, |conn| {
            conn.execute_batch(
                "INSERT INTO memories (id, agent_id, content, created_at, updated_at, updated_by, vector_clock)
                 VALUES ('m1', 'a1', 'x', '2026-04-12T00:00:00Z', '2026-04-12T00:00:00Z', 'test', '{}');
                 INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at, completed_at)
                 VALUES ('j1', 'm1', 'extract', 'completed', '2026-04-12T00:00:00Z', '2026-04-12T00:01:00Z', '2026-04-12T00:01:00Z');",
            )
            .expect("seed data");
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("write succeeded");

        let result = latest_extraction_progress_ms(&pool, "different-agent")
            .await
            .expect("query succeeded");
        assert!(result.is_none());
        handle.abort();
    }

    #[tokio::test]
    async fn latest_extraction_progress_handles_plus00_offset_format() {
        let path = test_db("plus00");
        let (pool, handle) = DbPool::open(&path).expect("failed to open DB");
        pool.write(Priority::Low, |conn| {
            conn.execute_batch(
                "INSERT INTO memories (id, agent_id, content, created_at, updated_at, updated_by, vector_clock)
                 VALUES ('m1', 'tz-agent', 'hello', '2026-04-12T00:00:00+00:00', '2026-04-12T00:00:00+00:00', 'test', '{}');
                 INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at, completed_at)
                 VALUES ('j1', 'm1', 'extract', 'completed', '2026-04-12T00:00:00+00:00', '2026-04-12T00:00:30+00:00', '2026-04-12T00:01:00+00:00');",
            )
            .expect("seed data");
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("write succeeded");

        let result = latest_extraction_progress_ms(&pool, "tz-agent")
            .await
            .expect("query succeeded");
        assert!(result.is_some());
        let ts = result.unwrap();
        // 2026-04-12T00:01:00+00:00 = 1775952060 epoch seconds * 1000
        assert_eq!(ts, 1_775_952_060_000);
        handle.abort();
    }

    #[tokio::test]
    async fn extraction_stalled_ms_returns_none_when_no_progress() {
        let path = test_db("stalled");
        let (pool, handle) = DbPool::open(&path).expect("failed to open DB");

        let result = extraction_stalled_ms(&pool, "test-agent", 30 * 60_000)
            .await
            .expect("query succeeded");
        assert!(result.is_none());
        handle.abort();
    }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async fn find_stale_entities(
    pool: &DbPool,
    agent_id: &str,
    limit: usize,
) -> Result<Vec<StaleEntity>, String> {
    let agent_id = agent_id.to_string();
    pool.read(move |conn| {
        let mut stmt = conn.prepare_cached(
            "SELECT id, name, entity_type
             FROM entities
             WHERE agent_id = ?1
               AND (last_synthesized_at IS NULL
                    OR last_synthesized_at < updated_at)
             ORDER BY updated_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![agent_id, limit], |r| {
                Ok(StaleEntity {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    entity_type: r.get(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())
}

async fn load_facts(
    pool: &DbPool,
    agent_id: &str,
    entity_id: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let agent_id = agent_id.to_string();
    let eid = entity_id.to_string();
    pool.read(move |conn| {
        let mut stmt = conn.prepare_cached(
            "SELECT ea.content
             FROM entity_attributes ea
             JOIN entity_aspects asp ON asp.id = ea.aspect_id
             WHERE asp.entity_id = ?1 AND ea.agent_id = ?2
               AND ea.status = 'active'
             ORDER BY ea.updated_at DESC
             LIMIT ?3",
        )?;
        let facts = stmt
            .query_map(rusqlite::params![eid, agent_id, limit], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(facts)
    })
    .await
    .map_err(|e| e.to_string())
}

async fn load_top_entities(
    pool: &DbPool,
    agent_id: &str,
    exclude_id: &str,
    limit: usize,
) -> Result<Vec<GraphEntity>, String> {
    let agent_id = agent_id.to_string();
    let excl = exclude_id.to_string();
    pool.read(move |conn| {
        let mut stmt = conn.prepare_cached(
            "SELECT name, entity_type, mentions
             FROM entities
             WHERE id != ?1 AND agent_id = ?2 AND mentions > 0
             ORDER BY mentions DESC
             LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![excl, agent_id, limit], |r| {
                Ok(GraphEntity {
                    name: r.get(0)?,
                    entity_type: r.get(1)?,
                    mentions: r.get(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())
}

async fn load_existing_targets(
    pool: &DbPool,
    agent_id: &str,
    entity_id: &str,
) -> Result<HashSet<String>, String> {
    let agent_id = agent_id.to_string();
    let eid = entity_id.to_string();
    pool.read(move |conn| {
        let mut stmt = conn.prepare_cached(
            "SELECT dst.name
             FROM entity_dependencies dep
             JOIN entities dst ON dst.id = dep.target_entity_id
               AND dst.agent_id = ?1
             WHERE dep.source_entity_id = ?2 AND dep.agent_id = ?1",
        )?;
        let names: HashSet<String> = stmt
            .query_map(rusqlite::params![agent_id, eid], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(names)
    })
    .await
    .map_err(|e| e.to_string())
}

async fn lookup_entity_by_canonical(
    pool: &DbPool,
    agent_id: &str,
    canonical: &str,
    exclude_id: &str,
) -> Result<Option<String>, String> {
    let agent_id = agent_id.to_string();
    let c = canonical.to_string();
    let excl = exclude_id.to_string();
    pool.read(move |conn| {
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM entities WHERE canonical_name = ?1 AND agent_id = ?2 AND id != ?3 LIMIT 1",
                rusqlite::params![c, agent_id, excl],
                |r| r.get(0),
            )
            .ok();
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())
}

async fn mark_synthesized(pool: &DbPool, agent_id: &str, entity_id: &str) {
    let agent_id = agent_id.to_string();
    let eid = entity_id.to_string();
    let _ = pool
        .write(Priority::Low, move |conn| {
            let ts = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE entities SET last_synthesized_at = ?1 WHERE id = ?2 AND agent_id = ?3",
                rusqlite::params![ts, eid, agent_id],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

fn build_prompt(
    entity: &StaleEntity,
    facts: &[String],
    candidates: &[GraphEntity],
    existing: &HashSet<String>,
) -> String {
    let fact_list = facts
        .iter()
        .enumerate()
        .map(|(i, f)| format!("{}. {f}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");

    let entity_list = candidates
        .iter()
        .map(|e| format!("- {} ({}, {} mentions)", e.name, e.entity_type, e.mentions))
        .collect::<Vec<_>>()
        .join("\n");

    let already = if existing.is_empty() {
        "No existing connections.".to_string()
    } else {
        let names: Vec<&str> = existing.iter().map(|s| s.as_str()).collect();
        format!("Already connected to: {}", names.join(", "))
    };

    let type_list = DEPENDENCY_TYPES
        .iter()
        .zip(DEP_DESCRIPTIONS.iter())
        .map(|(t, d)| format!("- {t}: {d}"))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"Entity: {name} ({etype})
Facts:
{fact_list}

Known entities in the knowledge graph:
{entity_list}

{already}

Dependency types:
{type_list}

Identify connections between {name} and the known entities.
Only return connections you are confident exist based on the facts.
Do not repeat already-connected entities unless the dependency type differs.
For each: {{"target": "entity name", "dep_type": "type", "reason": "why"}}
Return a JSON array. If no new connections, return [].
/no_think"#,
        name = entity.name,
        etype = entity.entity_type,
    )
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

fn parse_results(raw: &str) -> Vec<SynthesisResult> {
    let valid_types: HashSet<&str> = DEPENDENCY_TYPES.iter().copied().collect();

    let cleaned = crate::extraction::parse_json_array(raw);
    let arr: Vec<serde_json::Value> = serde_json::from_str(&cleaned).unwrap_or_default();

    arr.into_iter()
        .filter_map(|v| {
            let target = v["target"].as_str()?.trim().to_string();
            if target.is_empty() {
                return None;
            }
            let dep_type = v["dep_type"].as_str()?.trim().to_string();
            if !valid_types.contains(dep_type.as_str()) {
                return None;
            }
            let reason = v["reason"]
                .as_str()
                .unwrap_or("")
                .trim()
                .chars()
                .take(300)
                .collect();
            Some(SynthesisResult {
                target,
                dep_type,
                reason,
            })
        })
        .collect()
}
