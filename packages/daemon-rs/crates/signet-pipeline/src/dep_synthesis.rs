//! Cross-entity dependency synthesis worker.
//!
//! Polling worker that discovers connections between entities by presenting
//! the LLM with an entity's facts alongside the top entities from the graph.
//! Separate from the structural-dependency worker which only sees facts from
//! a single memory at a time.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use signet_core::config::StructuralConfig;
use signet_core::constants::DEPENDENCY_TYPES;
use signet_core::db::{DbPool, Priority};
use tokio::sync::watch;
use tracing::{info, warn};

use crate::provider::{GenerateOpts, LlmProvider, LlmSemaphore};
use crate::structural::DEP_DESCRIPTIONS;

const AGENT_ID: &str = "default";

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
) -> DepSynthesisHandle {
    let (tx, rx) = watch::channel(false);
    let handle = tokio::spawn(worker_loop(pool, provider, semaphore, config, rx));
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
    mut shutdown: watch::Receiver<bool>,
) {
    let interval = Duration::from_millis(config.synthesis_interval_ms);

    info!(
        interval_ms = config.synthesis_interval_ms,
        top_entities = config.synthesis_top_entities,
        max_facts = config.synthesis_max_facts,
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

        if let Err(e) = tick(&pool, &provider, &semaphore, &config).await {
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
) -> Result<(), String> {
    let batch = config.dependency_batch_size;
    let stale = find_stale_entities(pool, batch).await?;
    if stale.is_empty() {
        return Ok(());
    }

    for entity in stale {
        let facts = load_facts(pool, &entity.id, config.synthesis_max_facts).await?;

        if facts.is_empty() {
            mark_synthesized(pool, &entity.id).await;
            continue;
        }

        let candidates =
            load_top_entities(pool, &entity.id, config.synthesis_top_entities).await?;

        if candidates.is_empty() {
            mark_synthesized(pool, &entity.id).await;
            continue;
        }

        let existing = load_existing_targets(pool, &entity.id).await?;
        let prompt = build_prompt(&entity, &facts, &candidates, &existing);

        let opts = GenerateOpts {
            timeout_ms: Some(60_000),
            max_tokens: Some(1024),
        };

        let p = provider.clone();
        let raw = match semaphore.run(async { p.generate(&prompt, &opts).await }).await {
            Ok(r) => r,
            Err(e) => {
                warn!(entity = %entity.name, err = %e, "dep-synthesis LLM call failed");
                continue;
            }
        };

        let results = parse_results(&raw.text);
        let mut created = 0usize;

        for result in &results {
            let canonical = result.target.trim().to_lowercase();
            let canonical = canonical.split_whitespace().collect::<Vec<_>>().join(" ");

            let target_id =
                match lookup_entity_by_canonical(pool, &canonical, &entity.id).await {
                    Ok(Some(id)) => id,
                    Ok(None) => continue,
                    Err(e) => {
                        warn!(err = %e, "dep-synthesis entity lookup failed");
                        continue;
                    }
                };

            let src = entity.id.clone();
            let tgt = target_id;
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
            let reason_opt: Option<String> = if reason.is_empty() { None } else { Some(reason) };

            let res = pool
                .write(Priority::Low, move |conn| {
                    signet_services::graph::upsert_dependency(
                        conn,
                        signet_services::graph::UpsertDepInput {
                            source_entity_id: &src,
                            target_entity_id: &tgt,
                            agent_id: AGENT_ID,
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
            mark_synthesized(pool, &entity.id).await;
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

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async fn find_stale_entities(pool: &DbPool, limit: usize) -> Result<Vec<StaleEntity>, String> {
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
            .query_map(rusqlite::params![AGENT_ID, limit], |r| {
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

async fn load_facts(pool: &DbPool, entity_id: &str, limit: usize) -> Result<Vec<String>, String> {
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
            .query_map(rusqlite::params![eid, AGENT_ID, limit], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(facts)
    })
    .await
    .map_err(|e| e.to_string())
}

async fn load_top_entities(
    pool: &DbPool,
    exclude_id: &str,
    limit: usize,
) -> Result<Vec<GraphEntity>, String> {
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
            .query_map(rusqlite::params![excl, AGENT_ID, limit], |r| {
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
    entity_id: &str,
) -> Result<HashSet<String>, String> {
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
            .query_map(rusqlite::params![AGENT_ID, eid], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(names)
    })
    .await
    .map_err(|e| e.to_string())
}

async fn lookup_entity_by_canonical(
    pool: &DbPool,
    canonical: &str,
    exclude_id: &str,
) -> Result<Option<String>, String> {
    let c = canonical.to_string();
    let excl = exclude_id.to_string();
    pool.read(move |conn| {
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM entities WHERE canonical_name = ?1 AND id != ?2 LIMIT 1",
                rusqlite::params![c, excl],
                |r| r.get(0),
            )
            .ok();
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())
}

async fn mark_synthesized(pool: &DbPool, entity_id: &str) {
    let eid = entity_id.to_string();
    let _ = pool
        .write(Priority::Low, move |conn| {
            let ts = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE entities SET last_synthesized_at = ?1 WHERE id = ?2 AND agent_id = ?3",
                rusqlite::params![ts, eid, AGENT_ID],
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
            Some(SynthesisResult { target, dep_type, reason })
        })
        .collect()
}
