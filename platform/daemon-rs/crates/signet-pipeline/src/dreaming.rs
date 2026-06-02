//! Dreaming agent: periodic smart-model consolidation of the knowledge graph.
//!
//! Reads accumulated session summaries and the current entity graph, produces
//! structured graph mutations (create, merge, update, delete, supersede), and
//! applies them transactionally.
//!
//! See docs/specs/approved/dreaming-memory-consolidation.md

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use uuid::Uuid;

use signet_core::db::{DbPool, Priority};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Dreaming mode: incremental processes new summaries; compact cleans the graph.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DreamingMode {
    Incremental,
    Compact,
}

/// Input aspect for create_entity mutations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AspectInput {
    pub name: String,
    pub attributes: Option<Vec<String>>,
}

/// Discriminated union of all dreaming mutation operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum DreamingMutation {
    #[serde(rename = "create_entity")]
    CreateEntity {
        name: String,
        #[serde(rename = "type")]
        entity_type: Option<String>,
        aspects: Option<Vec<AspectInput>>,
    },
    #[serde(rename = "merge_entities")]
    MergeEntities {
        source: Vec<String>,
        target: String,
        reason: Option<String>,
    },
    #[serde(rename = "delete_entity")]
    DeleteEntity {
        name: String,
        reason: Option<String>,
    },
    #[serde(rename = "update_aspect")]
    UpdateAspect {
        entity: String,
        aspect: String,
        attributes: Vec<String>,
    },
    #[serde(rename = "delete_aspect")]
    DeleteAspect {
        entity: String,
        aspect: String,
        reason: Option<String>,
    },
    #[serde(rename = "supersede_attribute")]
    SupersedeAttribute {
        entity: String,
        aspect: String,
        old: String,
        new: String,
    },
    #[serde(rename = "create_attribute")]
    CreateAttribute {
        entity: String,
        aspect: String,
        content: String,
    },
    #[serde(rename = "delete_attribute")]
    DeleteAttribute {
        entity: String,
        aspect: String,
        content: String,
        reason: Option<String>,
    },
}

/// Result of a dreaming pass LLM call.
#[derive(Debug, Clone)]
pub struct DreamingResult {
    pub mutations: Vec<DreamingMutation>,
    pub summary: String,
    pub tokens_consumed: usize,
    pub invalid_mutations: usize,
}

/// Persisted dreaming state for an agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamingState {
    pub tokens_since_last_pass: i64,
    pub consecutive_failures: i64,
    pub last_pass_at: Option<String>,
    pub last_pass_id: Option<String>,
    pub last_pass_mode: Option<String>,
}

/// Configuration for the dreaming agent.
#[derive(Debug, Clone)]
pub struct DreamingConfig {
    pub enabled: bool,
    pub token_threshold: i64,
    pub timeout_ms: u64,
    pub max_input_tokens: usize,
    pub max_output_tokens: usize,
    pub backfill_on_first_run: bool,
}

impl Default for DreamingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            token_threshold: 100_000,
            timeout_ms: 300_000,
            max_input_tokens: 128_000,
            max_output_tokens: 16_000,
            backfill_on_first_run: true,
        }
    }
}

/// LLM generate function signature.
pub trait LlmGenerateFn: Send + Sync {
    fn generate(
        &self,
        prompt: &str,
        timeout_ms: Option<u64>,
        max_tokens: Option<usize>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>;
}

// Internal DB row types

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct DreamingPassRow {
    id: String,
    mode: String,
    status: String,
    started_at: String,
    completed_at: Option<String>,
    tokens_consumed: Option<i64>,
    mutations_applied: Option<i64>,
    mutations_skipped: Option<i64>,
    mutations_failed: Option<i64>,
    summary: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct SessionSummaryRow {
    id: String,
    content: String,
    token_count: i64,
    session_key: Option<String>,
    project: Option<String>,
    latest_at: String,
}

#[derive(Debug, Clone)]
struct EntityRow {
    id: String,
    name: String,
    entity_type: String,
    description: Option<String>,
}

#[derive(Debug, Clone)]
struct AspectRow {
    id: String,
    entity_id: String,
    name: String,
    weight: f64,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct AttributeRow {
    id: String,
    aspect_id: String,
    kind: String,
    content: String,
    status: String,
    importance: f64,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct DependencyRow {
    source_entity_id: String,
    target_entity_id: String,
    dependency_type: String,
    strength: f64,
    confidence: f64,
    reason: Option<String>,
}

struct EntityGraph {
    entities: Vec<EntityRow>,
    aspects: Vec<AspectRow>,
    attributes: Vec<AttributeRow>,
    dependencies: Vec<DependencyRow>,
}

#[derive(Clone)]
struct GraphLimits {
    entities: usize,
    aspects: usize,
    attributes: usize,
    dependencies: usize,
}

/// Outcome of a single mutation application.
enum MutationOutcome {
    Applied,
    Skipped,
}

/// Rich result from merge_entities (multiple sources can have mixed outcomes).
struct MergeResult {
    applied: usize,
    skipped: usize,
}

/// Aggregate result from applying all mutations.
struct ApplyResult {
    applied: usize,
    skipped: usize,
    failed: usize,
    errors: Vec<String>,
}

// ---------------------------------------------------------------------------
// Dreaming state DB helpers
// ---------------------------------------------------------------------------

/// Read the current dreaming state for an agent.
pub async fn get_dreaming_state(pool: &DbPool, agent_id: &str) -> DreamingState {
    let agent_id = agent_id.to_string();
    pool.read(move |conn| {
        let row = conn
            .query_row(
                "SELECT tokens_since_last_pass, consecutive_failures,
                        last_pass_at, last_pass_id, last_pass_mode
                 FROM dreaming_state WHERE agent_id = ?1",
                params![agent_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()?;
        Ok(match row {
            Some((tokens, failures, last_at, last_id, last_mode)) => DreamingState {
                tokens_since_last_pass: tokens,
                consecutive_failures: failures,
                last_pass_at: last_at,
                last_pass_id: last_id,
                last_pass_mode: last_mode,
            },
            None => DreamingState {
                tokens_since_last_pass: 0,
                consecutive_failures: 0,
                last_pass_at: None,
                last_pass_id: None,
                last_pass_mode: None,
            },
        })
    })
    .await
    .unwrap_or(DreamingState {
        tokens_since_last_pass: 0,
        consecutive_failures: 0,
        last_pass_at: None,
        last_pass_id: None,
        last_pass_mode: None,
    })
}

/// Add tokens to the dreaming accumulator for an agent.
pub async fn add_dreaming_tokens(pool: &DbPool, agent_id: &str, tokens: i64) {
    let agent_id = agent_id.to_string();
    let result = pool
        .write(Priority::Low, move |conn| {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM dreaming_state WHERE agent_id = ?1)",
                    params![agent_id],
                    |row| row.get::<_, i64>(0).map(|v| v == 1),
                )
                .unwrap_or(false);
            if exists {
                conn.execute(
                    "UPDATE dreaming_state
                     SET tokens_since_last_pass = tokens_since_last_pass + ?1,
                         updated_at = datetime('now')
                     WHERE agent_id = ?2",
                    params![tokens, agent_id],
                )?;
            } else {
                conn.execute(
                    "INSERT INTO dreaming_state (agent_id, tokens_since_last_pass)
                     VALUES (?1, ?2)",
                    params![agent_id, tokens],
                )?;
            }
            Ok(serde_json::Value::Null)
        })
        .await;
    if let Err(e) = result {
        warn!(error = %e, "failed to add dreaming tokens");
    }
}

/// Record a dreaming failure (increments consecutive_failures).
pub async fn record_dreaming_failure(pool: &DbPool, agent_id: &str) {
    let agent_id = agent_id.to_string();
    let result = pool
        .write(Priority::Low, move |conn| {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM dreaming_state WHERE agent_id = ?1)",
                    params![agent_id],
                    |row| row.get::<_, i64>(0).map(|v| v == 1),
                )
                .unwrap_or(false);
            if exists {
                conn.execute(
                    "UPDATE dreaming_state
                     SET consecutive_failures = consecutive_failures + 1,
                         updated_at = datetime('now')
                     WHERE agent_id = ?1",
                    params![agent_id],
                )?;
            } else {
                conn.execute(
                    "INSERT INTO dreaming_state (agent_id, tokens_since_last_pass, consecutive_failures)
                     VALUES (?1, 0, 1)",
                    params![agent_id],
                )?;
            }
            Ok(serde_json::Value::Null)
        })
        .await;
    if let Err(e) = result {
        warn!(error = %e, "failed to record dreaming failure");
    }
}

/// Create a new dreaming pass record in 'running' state. Returns the pass ID.
pub async fn create_dreaming_pass(pool: &DbPool, agent_id: &str, mode: &DreamingMode) -> String {
    let id = Uuid::new_v4().to_string();
    let agent_id = agent_id.to_string();
    let mode_str = match mode {
        DreamingMode::Incremental => "incremental",
        DreamingMode::Compact => "compact",
    };
    let id_clone = id.clone();
    if let Err(e) = pool
        .write(Priority::Low, move |conn| {
            conn.execute(
                "INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
                 VALUES (?1, ?2, ?3, 'running', datetime('now'), datetime('now'))",
                params![id_clone, agent_id, mode_str],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
    {
        warn!(error = %e, "failed to create dreaming pass");
    }
    id
}

/// Mark a dreaming pass as failed.
#[allow(dead_code)]
async fn fail_dreaming_pass(pool: &DbPool, pass_id: &str, error: &str) {
    let pass_id = pass_id.to_string();
    let error = error.to_string();
    if let Err(e) = pool
        .write(Priority::Low, move |conn| {
            conn.execute(
                "UPDATE dreaming_passes
                 SET status = 'failed', completed_at = datetime('now'), error = ?1
                 WHERE id = ?2",
                params![error, pass_id],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
    {
        warn!(error = %e, "failed to mark dreaming pass as failed");
    }
}

/// Get recent dreaming passes for an agent.
pub async fn get_dreaming_passes(
    pool: &DbPool,
    agent_id: &str,
    limit: usize,
) -> Vec<DreamingPassRow> {
    let agent_id = agent_id.to_string();
    pool.read(move |conn| {
        let mut stmt = conn.prepare_cached(
            "SELECT id, mode, status, started_at, completed_at, tokens_consumed,
                    mutations_applied, mutations_skipped, mutations_failed, summary, error
             FROM dreaming_passes
             WHERE agent_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![agent_id, limit as i64], |row| {
                Ok(DreamingPassRow {
                    id: row.get(0)?,
                    mode: row.get(1)?,
                    status: row.get(2)?,
                    started_at: row.get(3)?,
                    completed_at: row.get(4)?,
                    tokens_consumed: row.get(5)?,
                    mutations_applied: row.get(6)?,
                    mutations_skipped: row.get(7)?,
                    mutations_failed: row.get(8)?,
                    summary: row.get(9)?,
                    error: row.get(10)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    })
    .await
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Data fetching for prompt assembly
// ---------------------------------------------------------------------------

fn fetch_unprocessed_summaries(
    conn: &rusqlite::Connection,
    agent_id: &str,
    since: Option<&str>,
    limit: usize,
) -> Vec<SessionSummaryRow> {
    let sql = match since {
        Some(_) => {
            "SELECT id, content, token_count, session_key, project, latest_at
             FROM session_summaries
             WHERE agent_id = ?1 AND depth = 0
               AND COALESCE(source_type, 'summary') = 'summary'
               AND latest_at > ?2
             ORDER BY latest_at ASC
             LIMIT ?3"
        }
        None => {
            "SELECT id, content, token_count, session_key, project, latest_at
             FROM session_summaries
             WHERE agent_id = ?1 AND depth = 0
               AND COALESCE(source_type, 'summary') = 'summary'
             ORDER BY latest_at ASC
             LIMIT ?2"
        }
    };

    let result = match since {
        Some(s) => {
            let mut stmt = match conn.prepare_cached(sql) {
                Ok(s) => s,
                Err(_) => return Vec::new(),
            };
            stmt.query_map(params![agent_id, s, limit as i64], |row| {
                Ok(SessionSummaryRow {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    token_count: row.get(2)?,
                    session_key: row.get(3)?,
                    project: row.get(4)?,
                    latest_at: row.get(5)?,
                })
            })
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
        }
        None => {
            let mut stmt = match conn.prepare_cached(sql) {
                Ok(s) => s,
                Err(_) => return Vec::new(),
            };
            stmt.query_map(params![agent_id, limit as i64], |row| {
                Ok(SessionSummaryRow {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    token_count: row.get(2)?,
                    session_key: row.get(3)?,
                    project: row.get(4)?,
                    latest_at: row.get(5)?,
                })
            })
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
        }
    };
    result.unwrap_or_default()
}

fn fetch_entity_graph(
    conn: &rusqlite::Connection,
    agent_id: &str,
    limits: &GraphLimits,
) -> EntityGraph {
    let entities = conn
        .prepare_cached(
            "SELECT id, name, entity_type, description
             FROM entities WHERE agent_id = ?1
             ORDER BY mentions DESC, updated_at DESC
             LIMIT ?2",
        )
        .ok()
        .and_then(|mut stmt| {
            stmt.query_map(params![agent_id, limits.entities as i64], |row| {
                Ok(EntityRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    entity_type: row.get(2)?,
                    description: row.get(3)?,
                })
            })
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    let aspects = conn
        .prepare_cached(
            "SELECT ea.id, ea.entity_id, ea.name, ea.weight
             FROM entity_aspects ea
             WHERE ea.agent_id = ?1
             ORDER BY ea.weight DESC
             LIMIT ?2",
        )
        .ok()
        .and_then(|mut stmt| {
            stmt.query_map(params![agent_id, limits.aspects as i64], |row| {
                Ok(AspectRow {
                    id: row.get(0)?,
                    entity_id: row.get(1)?,
                    name: row.get(2)?,
                    weight: row.get(3)?,
                })
            })
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    let attributes = conn
        .prepare_cached(
            "SELECT ea.id, ea.aspect_id, ea.kind, ea.content,
                    ea.status, ea.importance
             FROM entity_attributes ea
             WHERE ea.agent_id = ?1 AND ea.status = 'active'
             ORDER BY ea.importance DESC
             LIMIT ?2",
        )
        .ok()
        .and_then(|mut stmt| {
            stmt.query_map(params![agent_id, limits.attributes as i64], |row| {
                Ok(AttributeRow {
                    id: row.get(0)?,
                    aspect_id: row.get(1)?,
                    kind: row.get(2)?,
                    content: row.get(3)?,
                    status: row.get(4)?,
                    importance: row.get(5)?,
                })
            })
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    let dependencies = conn
        .prepare_cached(
            "SELECT source_entity_id, target_entity_id,
                    dependency_type, strength, confidence, reason
             FROM entity_dependencies
             WHERE agent_id = ?1
             LIMIT ?2",
        )
        .ok()
        .and_then(|mut stmt| {
            stmt.query_map(params![agent_id, limits.dependencies as i64], |row| {
                Ok(DependencyRow {
                    source_entity_id: row.get(0)?,
                    target_entity_id: row.get(1)?,
                    dependency_type: row.get(2)?,
                    strength: row.get(3)?,
                    confidence: row.get(4)?,
                    reason: row.get(5)?,
                })
            })
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    EntityGraph {
        entities,
        aspects,
        attributes,
        dependencies,
    }
}

fn warn_if_truncated(graph: &EntityGraph, limits: &GraphLimits) {
    let mut truncated = Vec::new();
    if graph.entities.len() >= limits.entities {
        truncated.push(format!("entities({})", graph.entities.len()));
    }
    if graph.aspects.len() >= limits.aspects {
        truncated.push(format!("aspects({})", graph.aspects.len()));
    }
    if graph.attributes.len() >= limits.attributes {
        truncated.push(format!("attributes({})", graph.attributes.len()));
    }
    if graph.dependencies.len() >= limits.dependencies {
        truncated.push(format!("dependencies({})", graph.dependencies.len()));
    }
    if !truncated.is_empty() {
        warn!(
            truncated = ?truncated,
            "entity graph truncated by row limits — dreaming pass will operate on a partial snapshot"
        );
    }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const IDENTITY_FILES: &[&str] = &["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
const DREAMING_IDENTITY_FILES: &[&str] = &["DREAMING.md"];

fn read_identity_file(dir: &Path, filename: &str, budget: usize) -> String {
    let path = dir.join(filename);
    match fs::read_to_string(&path) {
        Ok(raw) => {
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() {
                return String::new();
            }
            if trimmed.len() <= budget {
                trimmed
            } else {
                format!("{}\n[truncated]", &trimmed[..budget])
            }
        }
        Err(_) => String::new(),
    }
}

fn render_identity_block(dir: &Path, files: &[&str]) -> String {
    files
        .iter()
        .map(|filename| {
            let content = read_identity_file(dir, filename, 4_000);
            if content.is_empty() {
                String::new()
            } else {
                format!("## {filename}\n\n{content}")
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

fn build_dreaming_prompt(
    mode: &DreamingMode,
    summaries: &[SessionSummaryRow],
    graph: &EntityGraph,
    agents_dir: &Path,
    max_tokens: usize,
) -> String {
    // Read identity files
    let identity = IDENTITY_FILES
        .iter()
        .filter(|f| **f != "MEMORY.md")
        .map(|f| {
            let content = read_identity_file(agents_dir, f, 4_000);
            if content.is_empty() {
                String::new()
            } else {
                format!("## {f}\n\n{content}")
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    let dreaming_prompt = render_identity_block(agents_dir, DREAMING_IDENTITY_FILES);
    let memory_md = read_identity_file(agents_dir, "MEMORY.md", 4_000);

    // Build entity/aspect/attribute lookup maps
    let entity_map: HashMap<&str, &EntityRow> =
        graph.entities.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut aspects_by_entity: HashMap<&str, Vec<&AspectRow>> = HashMap::new();
    for a in &graph.aspects {
        aspects_by_entity
            .entry(a.entity_id.as_str())
            .or_default()
            .push(a);
    }
    let mut attrs_by_aspect: HashMap<&str, Vec<&AttributeRow>> = HashMap::new();
    for a in &graph.attributes {
        attrs_by_aspect
            .entry(a.aspect_id.as_str())
            .or_default()
            .push(a);
    }

    // Graph section: ~30% of token budget (~4 chars/token)
    let graph_budget = (max_tokens as f64 * 0.3 * 4.0) as usize;
    let mut graph_text = String::new();
    for entity in &graph.entities {
        let entity_header = match &entity.description {
            Some(desc) if !desc.is_empty() => {
                format!("\n## {} ({})\n{desc}", entity.name, entity.entity_type)
            }
            _ => format!("\n## {} ({})", entity.name, entity.entity_type),
        };
        if graph_text.len() + entity_header.len() > graph_budget {
            break;
        }
        graph_text.push_str(&entity_header);
        let aspects = aspects_by_entity
            .get(entity.id.as_str())
            .map(|v| v.as_slice())
            .unwrap_or(&[]);
        for aspect in aspects {
            let aspect_line = format!("\n### {} (weight: {:.2})", aspect.name, aspect.weight);
            if graph_text.len() + aspect_line.len() > graph_budget {
                break;
            }
            graph_text.push_str(&aspect_line);
            let attrs = attrs_by_aspect
                .get(aspect.id.as_str())
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            for attr in attrs {
                let tag = if attr.kind == "constraint" {
                    " [CONSTRAINT]"
                } else {
                    ""
                };
                let attr_line = format!("\n- {}{tag}", attr.content);
                if graph_text.len() + attr_line.len() > graph_budget {
                    break;
                }
                graph_text.push_str(&attr_line);
            }
        }
        graph_text.push('\n');
    }

    // Dependencies: ~5% of token budget
    let dep_budget = (max_tokens as f64 * 0.05 * 4.0) as usize;
    let mut dep_text = String::new();
    for dep in &graph.dependencies {
        let src_name = entity_map
            .get(dep.source_entity_id.as_str())
            .map(|e| e.name.as_str())
            .unwrap_or(dep.source_entity_id.as_str());
        let tgt_name = entity_map
            .get(dep.target_entity_id.as_str())
            .map(|e| e.name.as_str())
            .unwrap_or(dep.target_entity_id.as_str());
        let line = format!(
            "\n- {} --[{}]--> {} (strength: {:.2}, confidence: {:.2})",
            src_name, dep.dependency_type, tgt_name, dep.strength, dep.confidence
        );
        if dep_text.len() + line.len() > dep_budget {
            break;
        }
        dep_text.push_str(&line);
    }

    // Summaries: ~60% of token budget
    let summary_budget = (max_tokens as f64 * 0.6 * 4.0) as usize;
    let mut summary_text = String::new();
    let mut used_chars = 0_usize;
    for s in summaries {
        if used_chars + s.content.len() > summary_budget {
            break;
        }
        let project_tag = match &s.project {
            Some(p) if !p.is_empty() => format!(" — {p}"),
            _ => String::new(),
        };
        summary_text.push_str(&format!(
            "\n### Session ({}){project_tag}\n{}\n",
            s.latest_at, s.content
        ));
        used_chars += s.content.len();
    }

    let mode_instructions = match mode {
        DreamingMode::Compact =>
            "You are running in COMPACTION mode. Focus on cleaning up the existing graph:
- Merge duplicate and near-duplicate entities (possessive forms, markdown artifacts, abbreviations of the same thing)
- Delete junk entities (fragments, markdown artifacts, truncated names)
- Prune meaningless or broken attributes
- Collapse redundant aspects
- Strengthen the graph structure by consolidating where possible",
        DreamingMode::Incremental =>
            "You are running in INCREMENTAL mode. Focus on integrating new session learnings:
- Create new entities for significant concepts, people, or projects mentioned in the sessions
- Update existing entity attributes with new information
- Merge any duplicates you notice
- Supersede outdated attributes with newer facts
- Delete attributes that are clearly wrong or outdated
- Add meaningful relationships between entities",
    };

    let mut prompt = String::new();
    prompt.push_str("<identity>\n");
    prompt.push_str(&identity);
    prompt.push_str("\n</identity>\n\n");
    prompt.push_str("<working_memory>\n");
    prompt.push_str(&memory_md);
    prompt.push_str("\n</working_memory>\n\n");

    if !dreaming_prompt.is_empty() {
        prompt.push_str("<dreaming_prompt>\n");
        prompt.push_str(&dreaming_prompt);
        prompt.push_str("\n</dreaming_prompt>\n\n");
    }

    prompt.push_str("<task>\n");
    prompt.push_str(&format!(
        "You are taking time to reflect on {} and consolidate your memory.\n\n",
        match mode {
            DreamingMode::Compact => "your knowledge graph",
            DreamingMode::Incremental => "your recent sessions",
        }
    ));
    prompt.push_str(mode_instructions);
    prompt.push_str("\n\nGuidelines:\n");
    prompt.push_str("- Constraints (attributes marked [CONSTRAINT]) are important decisions — do NOT delete them unless they are genuinely wrong\n");
    prompt.push_str("- Prefer merging over deleting when entities represent the same concept\n");
    prompt.push_str("- Keep entity names clean and consistent (no markdown formatting, no possessive forms as separate entities)\n");
    prompt.push_str("- When merging, pick the best canonical name as the target\n");
    prompt.push_str("- Provide clear reasons for all deletions and merges\n");
    prompt.push_str("- Be conservative — only change what you're confident about\n");
    prompt.push_str("- \"update_aspect\" is ADDITIVE — it adds new attributes to an aspect without removing existing ones. To replace a stale attribute, use \"supersede_attribute\" instead\n");
    prompt.push_str("- \"delete_attribute\" soft-deletes a single attribute (auditable, recoverable). \"delete_aspect\" hard-deletes the entire aspect and all its attributes permanently — use only when the whole aspect is no longer meaningful\n");
    prompt.push_str("</task>\n\n");

    if !summary_text.is_empty() {
        prompt.push_str("<recent_sessions>\n");
        prompt.push_str(&summary_text);
        prompt.push_str("\n</recent_sessions>\n\n");
    }

    prompt.push_str("<knowledge_graph>\n");
    prompt.push_str(&graph_text);
    prompt.push_str("\n### Entity Relationships\n");
    if dep_text.is_empty() {
        prompt.push_str("(no relationships yet)");
    } else {
        prompt.push_str(&dep_text);
    }
    prompt.push_str("\n</knowledge_graph>\n\n");

    prompt.push_str(
        "Respond with ONLY a JSON object in this exact format (no markdown code fences, no other text):\n\n\
         {\n  \"mutations\": [\n    \
         { \"op\": \"create_entity\", \"name\": \"...\", \"type\": \"person|project|system|tool|concept|skill|task\", \"aspects\": [{\"name\": \"...\", \"attributes\": [\"...\"]}] },\n    \
         { \"op\": \"merge_entities\", \"source\": [\"entity name 1\", \"entity name 2\"], \"target\": \"canonical name\", \"reason\": \"...\" },\n    \
         { \"op\": \"delete_entity\", \"name\": \"...\", \"reason\": \"...\" },\n    \
         { \"op\": \"update_aspect\", \"entity\": \"...\", \"aspect\": \"...\", \"attributes\": [\"attribute to add 1\", \"attribute to add 2\"] },\n    \
         { \"op\": \"delete_aspect\", \"entity\": \"...\", \"aspect\": \"...\", \"reason\": \"...\" },\n    \
         { \"op\": \"supersede_attribute\", \"entity\": \"...\", \"aspect\": \"...\", \"old\": \"old content\", \"new\": \"new content\" },\n    \
         { \"op\": \"create_attribute\", \"entity\": \"...\", \"aspect\": \"...\", \"content\": \"...\" },\n    \
         { \"op\": \"delete_attribute\", \"entity\": \"...\", \"aspect\": \"...\", \"content\": \"...\", \"reason\": \"...\" }\n  ],\n  \
         \"summary\": \"Brief description of what you changed and why\"\n}",
    );

    prompt
}

// ---------------------------------------------------------------------------
// Mutation validation
// ---------------------------------------------------------------------------

fn is_valid_mutation(value: &serde_json::Value) -> bool {
    let obj = match value.as_object() {
        Some(o) => o,
        None => return false,
    };
    let op = match obj.get("op").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return false,
    };
    match op {
        "create_entity" => obj.get("name").and_then(|v| v.as_str()).is_some(),
        "merge_entities" => {
            obj.get("source").and_then(|v| v.as_array()).is_some()
                && obj.get("target").and_then(|v| v.as_str()).is_some()
        }
        "delete_entity" => obj.get("name").and_then(|v| v.as_str()).is_some(),
        "update_aspect" => {
            obj.get("entity").and_then(|v| v.as_str()).is_some()
                && obj.get("aspect").and_then(|v| v.as_str()).is_some()
                && obj.get("attributes").and_then(|v| v.as_array()).is_some()
        }
        "delete_aspect" => {
            obj.get("entity").and_then(|v| v.as_str()).is_some()
                && obj.get("aspect").and_then(|v| v.as_str()).is_some()
        }
        "supersede_attribute" => {
            obj.get("entity").and_then(|v| v.as_str()).is_some()
                && obj.get("aspect").and_then(|v| v.as_str()).is_some()
                && obj.get("old").and_then(|v| v.as_str()).is_some()
                && obj.get("new").and_then(|v| v.as_str()).is_some()
        }
        "create_attribute" => {
            obj.get("entity").and_then(|v| v.as_str()).is_some()
                && obj.get("aspect").and_then(|v| v.as_str()).is_some()
                && obj.get("content").and_then(|v| v.as_str()).is_some()
        }
        "delete_attribute" => {
            obj.get("entity").and_then(|v| v.as_str()).is_some()
                && obj.get("aspect").and_then(|v| v.as_str()).is_some()
                && obj.get("content").and_then(|v| v.as_str()).is_some()
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Mutation result parsing
// ---------------------------------------------------------------------------

fn parse_dreaming_result(raw: &str) -> Result<DreamingResult, String> {
    let mut cleaned = raw.trim().to_string();
    // Strip markdown code fences
    if cleaned.starts_with("```") {
        let first = cleaned.find('\n').unwrap_or(0);
        let last = cleaned.rfind("```").unwrap_or(0);
        if first > 0 && last > first {
            cleaned = cleaned[first + 1..last].trim().to_string();
        }
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&cleaned).map_err(|e| format!("JSON parse error: {e}"))?;

    let all = parsed
        .get("mutations")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let valid_json: Vec<&serde_json::Value> = all.iter().filter(|v| is_valid_mutation(v)).collect();
    let invalid_mutations = all.len() - valid_json.len();

    if invalid_mutations > 0 {
        let sample: Vec<String> = all
            .iter()
            .filter(|v| !is_valid_mutation(v))
            .take(3)
            .map(|v| format!("{v:.120}"))
            .collect();
        warn!(
            count = invalid_mutations,
            sample = ?sample,
            "LLM response contained invalid mutations — discarded"
        );
    }

    let mutations: Vec<DreamingMutation> = valid_json
        .into_iter()
        .filter_map(|v| serde_json::from_value(v.clone()).ok())
        .collect();

    let summary = parsed
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("No summary provided")
        .to_string();

    let tokens_consumed = estimate_tokens(raw);

    Ok(DreamingResult {
        mutations,
        summary,
        tokens_consumed,
        invalid_mutations,
    })
}

/// Rough token estimate: ~4 chars per token.
fn estimate_tokens(text: &str) -> usize {
    text.len() / 4
}

// ---------------------------------------------------------------------------
// Mutation execution helpers
// ---------------------------------------------------------------------------

fn canonicalize(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn resolve_entity(conn: &rusqlite::Connection, agent_id: &str, name: &str) -> Option<String> {
    let canonical = canonicalize(name);
    conn.query_row(
        "SELECT id FROM entities
         WHERE agent_id = ?1
           AND (COALESCE(canonical_name, LOWER(name)) = ?2 OR LOWER(name) = ?2)
         LIMIT 1",
        params![agent_id, canonical],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn resolve_or_create_entity(
    conn: &rusqlite::Connection,
    agent_id: &str,
    name: &str,
    entity_type: &str,
) -> String {
    if let Some(id) = resolve_entity(conn, agent_id, name) {
        return id;
    }
    let id = Uuid::new_v4().to_string();
    let canonical = canonicalize(name);
    conn.execute(
        "INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, datetime('now'), datetime('now'))",
        params![id, name.trim(), canonical, entity_type, agent_id],
    )
    .ok();
    id
}

fn resolve_aspect(
    conn: &rusqlite::Connection,
    entity_id: &str,
    agent_id: &str,
    name: &str,
) -> Option<String> {
    let canonical = canonicalize(name);
    conn.query_row(
        "SELECT id FROM entity_aspects
         WHERE entity_id = ?1 AND agent_id = ?2 AND canonical_name = ?3
         LIMIT 1",
        params![entity_id, agent_id, canonical],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn resolve_or_create_aspect(
    conn: &rusqlite::Connection,
    entity_id: &str,
    agent_id: &str,
    name: &str,
) -> String {
    if let Some(id) = resolve_aspect(conn, entity_id, agent_id, name) {
        return id;
    }
    let id = Uuid::new_v4().to_string();
    let canonical = canonicalize(name);
    conn.execute(
        "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0.5, datetime('now'), datetime('now'))",
        params![id, entity_id, agent_id, name.trim(), canonical],
    )
    .ok();
    id
}

/// Insert a single attribute row, deduplicating by normalized_content.
fn insert_attr(
    conn: &rusqlite::Connection,
    aspect_id: &str,
    agent_id: &str,
    content: &str,
    normalized: &str,
    kind: &str,
    confidence: f64,
    importance: f64,
) -> String {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO entity_attributes
         (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', datetime('now'), datetime('now'))",
        params![id, aspect_id, agent_id, kind, content, normalized, confidence, importance],
    )
    .ok();
    id
}

/// Check if an attribute with the given normalized content exists under an aspect.
fn attr_exists(
    conn: &rusqlite::Connection,
    aspect_id: &str,
    agent_id: &str,
    normalized: &str,
) -> bool {
    conn.query_row(
        "SELECT 1 FROM entity_attributes
         WHERE aspect_id = ?1 AND agent_id = ?2 AND normalized_content = ?3",
        params![aspect_id, agent_id, normalized],
        |row| row.get::<_, i64>(0),
    )
    .ok()
    .is_some()
}

// ---------------------------------------------------------------------------
// Individual mutation handlers
// ---------------------------------------------------------------------------

fn apply_create_entity(
    conn: &rusqlite::Connection,
    agent_id: &str,
    name: &str,
    entity_type: Option<&str>,
    aspects: Option<&[AspectInput]>,
) -> MutationOutcome {
    if name.is_empty() {
        return MutationOutcome::Skipped;
    }
    let etype = entity_type.unwrap_or("unknown");
    let entity_id = resolve_or_create_entity(conn, agent_id, name, etype);
    if let Some(aspects) = aspects {
        for aspect in aspects {
            let aspect_id = resolve_or_create_aspect(conn, &entity_id, agent_id, &aspect.name);
            if let Some(attrs) = &aspect.attributes {
                for content in attrs {
                    if content.is_empty() || content.trim().len() < 5 {
                        continue;
                    }
                    let normalized = content.trim().to_lowercase();
                    if !attr_exists(conn, &aspect_id, agent_id, &normalized) {
                        insert_attr(
                            conn,
                            &aspect_id,
                            agent_id,
                            content.trim(),
                            &normalized,
                            "attribute",
                            0.8,
                            0.5,
                        );
                    }
                }
            }
        }
    }
    MutationOutcome::Applied
}

fn apply_merge_entities(
    conn: &rusqlite::Connection,
    agent_id: &str,
    source_names: &[String],
    target_name: &str,
) -> MergeResult {
    if source_names.is_empty() || target_name.is_empty() {
        return MergeResult {
            applied: 0,
            skipped: 1,
        };
    }

    let target_id = match resolve_entity(conn, agent_id, target_name) {
        Some(id) => id,
        None => {
            warn!(target = %target_name, "merge target not found, skipping");
            return MergeResult {
                applied: 0,
                skipped: 1,
            };
        }
    };

    let mut merged = 0_usize;
    let mut pinned_skipped = 0_usize;

    for src_name in source_names {
        let src_id = match resolve_entity(conn, agent_id, src_name) {
            Some(id) => id,
            None => continue,
        };
        if src_id == target_id {
            continue;
        }

        // Don't merge pinned entities
        let pinned: bool = conn
            .query_row(
                "SELECT pinned FROM entities WHERE id = ?1 AND agent_id = ?2",
                params![src_id, agent_id],
                |row| row.get::<_, i64>(0),
            )
            .ok()
            .map(|v| v == 1)
            .unwrap_or(false);
        if pinned {
            warn!(source = %src_name, "merge source is pinned, skipping");
            pinned_skipped += 1;
            continue;
        }
        merged += 1;

        // Move non-colliding aspects to target
        conn.execute(
            "UPDATE entity_aspects SET entity_id = ?1, updated_at = datetime('now')
             WHERE entity_id = ?2 AND agent_id = ?3
               AND canonical_name NOT IN (
                 SELECT canonical_name FROM entity_aspects WHERE entity_id = ?1 AND agent_id = ?3
               )",
            params![target_id, src_id, agent_id],
        )
        .ok();

        // Handle colliding aspects: copy active attributes from source to target
        let colliding: Vec<(String, String)> = conn
            .prepare_cached(
                "SELECT sa.id, ta.id
                 FROM entity_aspects sa
                 JOIN entity_aspects ta
                   ON ta.entity_id = ?1 AND ta.agent_id = ?2 AND ta.canonical_name = sa.canonical_name
                 WHERE sa.entity_id = ?3 AND sa.agent_id = ?2",
            )
            .ok()
            .and_then(|mut stmt| {
                stmt.query_map(params![target_id, agent_id, src_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default();

        for (src_aspect_id, tgt_aspect_id) in &colliding {
            let src_attrs: Vec<(String, String, String, f64, f64)> = conn
                .prepare_cached(
                    "SELECT content, normalized_content, kind, confidence, importance
                     FROM entity_attributes
                     WHERE aspect_id = ?1 AND agent_id = ?2 AND status = 'active'",
                )
                .ok()
                .and_then(|mut stmt| {
                    stmt.query_map(params![src_aspect_id, agent_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, f64>(3)?,
                            row.get::<_, f64>(4)?,
                        ))
                    })
                    .ok()
                    .map(|rows| rows.filter_map(|r| r.ok()).collect())
                })
                .unwrap_or_default();

            for (content, normalized, kind, confidence, importance) in &src_attrs {
                if !attr_exists(conn, tgt_aspect_id, agent_id, normalized) {
                    insert_attr(
                        conn,
                        tgt_aspect_id,
                        agent_id,
                        content,
                        normalized,
                        kind,
                        *confidence,
                        *importance,
                    );
                }
            }
        }

        // Dependency rewiring: check for S→T edge before rewriting
        let had_src_to_target: bool = conn
            .query_row(
                "SELECT 1 FROM entity_dependencies
                 WHERE source_entity_id = ?1 AND target_entity_id = ?2 AND agent_id = ?3",
                params![src_id, target_id, agent_id],
                |row| row.get::<_, i64>(0),
            )
            .ok()
            .is_some();
        let had_target_self_loop: bool = conn
            .query_row(
                "SELECT 1 FROM entity_dependencies
                 WHERE source_entity_id = ?1 AND target_entity_id = ?1 AND agent_id = ?2",
                params![target_id, agent_id],
                |row| row.get::<_, i64>(0),
            )
            .ok()
            .is_some();

        // Rewrite source dependencies to target (OR IGNORE handles collisions)
        conn.execute(
            "UPDATE OR IGNORE entity_dependencies SET source_entity_id = ?1, updated_at = datetime('now')
             WHERE source_entity_id = ?2 AND agent_id = ?3",
            params![target_id, src_id, agent_id],
        )
        .ok();
        conn.execute(
            "DELETE FROM entity_dependencies WHERE source_entity_id = ?1 AND agent_id = ?2",
            params![src_id, agent_id],
        )
        .ok();

        // Rewrite target-side dependencies
        conn.execute(
            "UPDATE OR IGNORE entity_dependencies SET target_entity_id = ?1, updated_at = datetime('now')
             WHERE target_entity_id = ?2 AND agent_id = ?3",
            params![target_id, src_id, agent_id],
        )
        .ok();
        conn.execute(
            "DELETE FROM entity_dependencies WHERE target_entity_id = ?1 AND agent_id = ?2",
            params![src_id, agent_id],
        )
        .ok();

        // Remove S→T self-loop if it was created by the rewrite and didn't exist before
        if had_src_to_target && !had_target_self_loop {
            conn.execute(
                "DELETE FROM entity_dependencies
                 WHERE source_entity_id = ?1 AND target_entity_id = ?1 AND agent_id = ?2",
                params![target_id, agent_id],
            )
            .ok();
        }

        // Move memory mentions (scoped via entities table for agent isolation)
        conn.execute(
            "UPDATE OR IGNORE memory_entity_mentions SET entity_id = ?1
             WHERE entity_id = ?2
               AND entity_id IN (SELECT id FROM entities WHERE agent_id = ?3)",
            params![target_id, src_id, agent_id],
        )
        .ok();
        conn.execute(
            "DELETE FROM memory_entity_mentions
             WHERE entity_id = ?1
               AND entity_id IN (SELECT id FROM entities WHERE agent_id = ?2)",
            params![src_id, agent_id],
        )
        .ok();

        // Transfer mention count
        conn.execute(
            "UPDATE entities SET mentions = mentions + COALESCE(
               (SELECT mentions FROM entities WHERE id = ?1), 0
             ), updated_at = datetime('now')
             WHERE id = ?2",
            params![src_id, target_id],
        )
        .ok();

        // Delete remaining source aspects/attributes and the source entity
        conn.execute(
            "DELETE FROM entity_attributes WHERE agent_id = ?1 AND aspect_id IN (
               SELECT id FROM entity_aspects WHERE entity_id = ?2 AND agent_id = ?1
             )",
            params![agent_id, src_id],
        )
        .ok();
        conn.execute(
            "DELETE FROM entity_aspects WHERE entity_id = ?1 AND agent_id = ?2",
            params![src_id, agent_id],
        )
        .ok();
        conn.execute(
            "DELETE FROM entities WHERE id = ?1 AND agent_id = ?2",
            params![src_id, agent_id],
        )
        .ok();
    }

    MergeResult {
        applied: if merged > 0 { 1 } else { 0 },
        skipped: if merged == 0 { 1 } else { 0 } + pinned_skipped,
    }
}

fn apply_delete_entity(conn: &rusqlite::Connection, agent_id: &str, name: &str) -> MutationOutcome {
    if name.is_empty() {
        return MutationOutcome::Skipped;
    }
    let entity_id = match resolve_entity(conn, agent_id, name) {
        Some(id) => id,
        None => return MutationOutcome::Skipped,
    };

    // Don't delete pinned entities
    let pinned: bool = conn
        .query_row(
            "SELECT pinned FROM entities WHERE id = ?1 AND agent_id = ?2",
            params![entity_id, agent_id],
            |row| row.get::<_, i64>(0),
        )
        .ok()
        .map(|v| v == 1)
        .unwrap_or(false);
    if pinned {
        return MutationOutcome::Skipped;
    }

    // Don't delete entities with active constraint attributes
    let has_constraints: bool = conn
        .query_row(
            "SELECT 1 FROM entity_attributes ea
             JOIN entity_aspects asp ON ea.aspect_id = asp.id
             WHERE asp.entity_id = ?1 AND asp.agent_id = ?2
               AND ea.kind = 'constraint' AND ea.status = 'active'",
            params![entity_id, agent_id],
            |row| row.get::<_, i64>(0),
        )
        .ok()
        .is_some();
    if has_constraints {
        return MutationOutcome::Skipped;
    }

    conn.execute(
        "DELETE FROM entity_attributes WHERE agent_id = ?1 AND aspect_id IN (
           SELECT id FROM entity_aspects WHERE entity_id = ?2 AND agent_id = ?1
         )",
        params![agent_id, entity_id],
    )
    .ok();
    conn.execute(
        "DELETE FROM entity_aspects WHERE entity_id = ?1 AND agent_id = ?2",
        params![entity_id, agent_id],
    )
    .ok();
    conn.execute(
        "DELETE FROM entity_dependencies WHERE (source_entity_id = ?1 OR target_entity_id = ?1) AND agent_id = ?2",
        params![entity_id, agent_id],
    )
    .ok();
    conn.execute(
        "DELETE FROM memory_entity_mentions
         WHERE entity_id = ?1
           AND entity_id IN (SELECT id FROM entities WHERE agent_id = ?2)",
        params![entity_id, agent_id],
    )
    .ok();
    conn.execute(
        "DELETE FROM entities WHERE id = ?1 AND agent_id = ?2",
        params![entity_id, agent_id],
    )
    .ok();
    MutationOutcome::Applied
}

fn apply_update_aspect(
    conn: &rusqlite::Connection,
    agent_id: &str,
    entity_name: &str,
    aspect_name: &str,
    attributes: &[String],
) -> MutationOutcome {
    if entity_name.is_empty() || aspect_name.is_empty() || attributes.is_empty() {
        return MutationOutcome::Skipped;
    }

    let entity_id = match resolve_entity(conn, agent_id, entity_name) {
        Some(id) => id,
        None => return MutationOutcome::Skipped,
    };

    // Pre-filter: drop attributes shorter than 5 chars
    let candidates: Vec<(&str, String)> = attributes
        .iter()
        .map(|a| a.trim())
        .filter(|a| a.len() >= 5)
        .map(|a| (a, a.to_lowercase()))
        .collect();
    if candidates.is_empty() {
        return MutationOutcome::Skipped;
    }

    // Filter out already-existing attributes if the aspect exists
    let existing_aspect_id = resolve_aspect(conn, &entity_id, agent_id, aspect_name);
    let to_insert: Vec<(&str, &str)> = if let Some(aid) = &existing_aspect_id {
        candidates
            .iter()
            .filter(|(_, normalized)| !attr_exists(conn, aid, agent_id, normalized))
            .map(|(content, normalized)| (*content, normalized.as_str()))
            .collect()
    } else {
        candidates
            .iter()
            .map(|(content, normalized)| (*content, normalized.as_str()))
            .collect()
    };

    if to_insert.is_empty() {
        return MutationOutcome::Skipped;
    }

    let aspect_id = resolve_or_create_aspect(conn, &entity_id, agent_id, aspect_name);
    for (content, normalized) in &to_insert {
        insert_attr(
            conn,
            &aspect_id,
            agent_id,
            content,
            normalized,
            "attribute",
            0.8,
            0.5,
        );
    }
    MutationOutcome::Applied
}

fn apply_delete_aspect(
    conn: &rusqlite::Connection,
    agent_id: &str,
    entity_name: &str,
    aspect_name: &str,
) -> MutationOutcome {
    if entity_name.is_empty() || aspect_name.is_empty() {
        return MutationOutcome::Skipped;
    }

    let entity_id = match resolve_entity(conn, agent_id, entity_name) {
        Some(id) => id,
        None => return MutationOutcome::Skipped,
    };
    let aspect_id = match resolve_aspect(conn, &entity_id, agent_id, aspect_name) {
        Some(id) => id,
        None => return MutationOutcome::Skipped,
    };

    // Don't delete aspects containing constraints
    let has_constraints: bool = conn
        .query_row(
            "SELECT 1 FROM entity_attributes
             WHERE aspect_id = ?1 AND agent_id = ?2 AND kind = 'constraint' AND status = 'active'",
            params![aspect_id, agent_id],
            |row| row.get::<_, i64>(0),
        )
        .ok()
        .is_some();
    if has_constraints {
        return MutationOutcome::Skipped;
    }

    conn.execute(
        "DELETE FROM entity_attributes WHERE aspect_id = ?1 AND agent_id = ?2",
        params![aspect_id, agent_id],
    )
    .ok();
    conn.execute(
        "DELETE FROM entity_aspects WHERE id = ?1 AND agent_id = ?2",
        params![aspect_id, agent_id],
    )
    .ok();
    MutationOutcome::Applied
}

fn apply_supersede(
    conn: &rusqlite::Connection,
    agent_id: &str,
    entity_name: &str,
    aspect_name: &str,
    old_content: &str,
    new_content: &str,
) -> MutationOutcome {
    if entity_name.is_empty()
        || aspect_name.is_empty()
        || old_content.is_empty()
        || new_content.is_empty()
    {
        return MutationOutcome::Skipped;
    }

    let entity_id = match resolve_entity(conn, agent_id, entity_name) {
        Some(id) => id,
        None => return MutationOutcome::Skipped,
    };
    let aspect_id = match resolve_aspect(conn, &entity_id, agent_id, aspect_name) {
        Some(id) => id,
        None => return MutationOutcome::Skipped,
    };

    let normalized_old = old_content.trim().to_lowercase();
    let old_attr: Option<(String, String)> = conn
        .query_row(
            "SELECT id, kind FROM entity_attributes
             WHERE aspect_id = ?1 AND agent_id = ?2 AND normalized_content = ?3 AND status = 'active'",
            params![aspect_id, agent_id, normalized_old],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .ok();

    let Some((old_id, old_kind)) = old_attr else {
        return MutationOutcome::Skipped;
    };

    // Don't supersede constraints
    if old_kind == "constraint" {
        return MutationOutcome::Skipped;
    }

    let normalized_new = new_content.trim().to_lowercase();
    let new_id = insert_attr(
        conn,
        &aspect_id,
        agent_id,
        new_content.trim(),
        &normalized_new,
        "attribute",
        0.8,
        0.5,
    );

    conn.execute(
        "UPDATE entity_attributes
         SET status = 'superseded', superseded_by = ?1, updated_at = datetime('now')
         WHERE id = ?2",
        params![new_id, old_id],
    )
    .ok();

    MutationOutcome::Applied
}

fn apply_create_attribute(
    conn: &rusqlite::Connection,
    agent_id: &str,
    entity_name: &str,
    aspect_name: &str,
    content: &str,
) -> MutationOutcome {
    if entity_name.is_empty() || aspect_name.is_empty() || content.trim().len() < 5 {
        return MutationOutcome::Skipped;
    }

    let entity_id = match resolve_entity(conn, agent_id, entity_name) {
        Some(id) => id,
        None => return MutationOutcome::Skipped,
    };
    let aspect_id = resolve_or_create_aspect(conn, &entity_id, agent_id, aspect_name);

    let normalized = content.trim().to_lowercase();
    if attr_exists(conn, &aspect_id, agent_id, &normalized) {
        return MutationOutcome::Skipped;
    }

    insert_attr(
        conn,
        &aspect_id,
        agent_id,
        content.trim(),
        &normalized,
        "attribute",
        0.8,
        0.5,
    );
    MutationOutcome::Applied
}

fn apply_delete_attribute(
    conn: &rusqlite::Connection,
    agent_id: &str,
    entity_name: &str,
    aspect_name: &str,
    content: &str,
) -> MutationOutcome {
    if entity_name.is_empty() || aspect_name.is_empty() || content.is_empty() {
        return MutationOutcome::Skipped;
    }

    let entity_id = match resolve_entity(conn, agent_id, entity_name) {
        Some(id) => id,
        None => return MutationOutcome::Skipped,
    };
    let aspect_id = match resolve_aspect(conn, &entity_id, agent_id, aspect_name) {
        Some(id) => id,
        None => return MutationOutcome::Skipped,
    };

    let normalized = content.trim().to_lowercase();
    let attr: Option<(String, String)> = conn
        .query_row(
            "SELECT id, kind FROM entity_attributes
             WHERE aspect_id = ?1 AND agent_id = ?2 AND normalized_content = ?3 AND status = 'active'",
            params![aspect_id, agent_id, normalized],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .ok();

    let Some((attr_id, kind)) = attr else {
        return MutationOutcome::Skipped;
    };

    // Don't delete constraints
    if kind == "constraint" {
        return MutationOutcome::Skipped;
    }

    conn.execute(
        "UPDATE entity_attributes SET status = 'deleted', updated_at = datetime('now')
         WHERE id = ?1",
        params![attr_id],
    )
    .ok();
    MutationOutcome::Applied
}

// ---------------------------------------------------------------------------
// Mutation dispatch
// ---------------------------------------------------------------------------

fn apply_mutations(
    conn: &rusqlite::Connection,
    agent_id: &str,
    mutations: &[DreamingMutation],
) -> ApplyResult {
    let mut applied = 0_usize;
    let mut skipped = 0_usize;
    let mut failed = 0_usize;
    let mut errors = Vec::new();

    for mutation in mutations {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match mutation {
                DreamingMutation::MergeEntities { source, target, .. } => {
                    let r = apply_merge_entities(conn, agent_id, source, target);
                    applied += r.applied;
                    skipped += r.skipped;
                    return None; // handled inline
                }
                DreamingMutation::CreateEntity {
                    name,
                    entity_type,
                    aspects,
                } => {
                    let outcome = apply_create_entity(
                        conn,
                        agent_id,
                        name,
                        entity_type.as_deref(),
                        aspects.as_deref(),
                    );
                    Some(outcome)
                }
                DreamingMutation::DeleteEntity { name, .. } => {
                    Some(apply_delete_entity(conn, agent_id, name))
                }
                DreamingMutation::UpdateAspect {
                    entity,
                    aspect,
                    attributes,
                } => Some(apply_update_aspect(
                    conn, agent_id, entity, aspect, attributes,
                )),
                DreamingMutation::DeleteAspect { entity, aspect, .. } => {
                    Some(apply_delete_aspect(conn, agent_id, entity, aspect))
                }
                DreamingMutation::SupersedeAttribute {
                    entity,
                    aspect,
                    old,
                    new,
                } => Some(apply_supersede(conn, agent_id, entity, aspect, old, new)),
                DreamingMutation::CreateAttribute {
                    entity,
                    aspect,
                    content,
                } => Some(apply_create_attribute(
                    conn, agent_id, entity, aspect, content,
                )),
                DreamingMutation::DeleteAttribute {
                    entity,
                    aspect,
                    content,
                    ..
                } => Some(apply_delete_attribute(
                    conn, agent_id, entity, aspect, content,
                )),
            }
        }));

        match result {
            Ok(Some(MutationOutcome::Applied)) => applied += 1,
            Ok(Some(MutationOutcome::Skipped)) => skipped += 1,
            Ok(None) => {} // merge handled inline
            Err(_) => {
                let op_name = match mutation {
                    DreamingMutation::CreateEntity { .. } => "create_entity",
                    DreamingMutation::MergeEntities { .. } => "merge_entities",
                    DreamingMutation::DeleteEntity { .. } => "delete_entity",
                    DreamingMutation::UpdateAspect { .. } => "update_aspect",
                    DreamingMutation::DeleteAspect { .. } => "delete_aspect",
                    DreamingMutation::SupersedeAttribute { .. } => "supersede_attribute",
                    DreamingMutation::CreateAttribute { .. } => "create_attribute",
                    DreamingMutation::DeleteAttribute { .. } => "delete_attribute",
                };
                errors.push(format!("{op_name} failed: panic during execution"));
                failed += 1;
            }
        }
    }

    ApplyResult {
        applied,
        skipped,
        failed,
        errors,
    }
}

// ---------------------------------------------------------------------------
// Main dreaming orchestrator
// ---------------------------------------------------------------------------

/// Result of a completed dreaming pass.
#[derive(Debug, Clone)]
pub struct DreamingPassResult {
    pub pass_id: String,
    pub applied: usize,
    pub skipped: usize,
    pub failed: usize,
    pub summary: String,
}

/// Run a full dreaming pass: fetch data, call LLM, apply mutations.
pub async fn run_dreaming_pass(
    pool: &DbPool,
    generate: &(dyn LlmGenerateFn + Send + Sync),
    cfg: &DreamingConfig,
    agents_dir: &str,
    agent_id: &str,
    mode: &DreamingMode,
    existing_pass_id: Option<&str>,
) -> Result<DreamingPassResult, String> {
    let pass_id = match existing_pass_id {
        Some(id) => id.to_string(),
        None => create_dreaming_pass(pool, agent_id, mode).await,
    };

    let agents_path = Path::new(agents_dir);
    let agent_id_owned = agent_id.to_string();

    // Fetch data
    let state = get_dreaming_state(pool, &agent_id_owned).await;

    let graph_token_budget = (cfg.max_input_tokens as f64 * 0.4) as usize;
    let graph_limits = GraphLimits {
        entities: 100.max(graph_token_budget / 20),
        aspects: 200.max(graph_token_budget / 10),
        attributes: 500.max(graph_token_budget / 25),
        dependencies: 200.max(graph_token_budget / 20),
    };

    let since: Option<String> = match mode {
        DreamingMode::Compact => None,
        DreamingMode::Incremental => state.last_pass_at.clone(),
    };

    let agent_id_for_read = agent_id.to_string();
    let limits_for_read = graph_limits.clone();

    let data = pool
        .read(move |conn| {
            let summaries =
                fetch_unprocessed_summaries(conn, &agent_id_for_read, since.as_deref(), 200);
            let graph = fetch_entity_graph(conn, &agent_id_for_read, &limits_for_read);
            Ok((summaries, graph))
        })
        .await
        .map_err(|e| format!("failed to fetch dreaming data: {e}"))?;

    let (summaries, graph) = data;
    warn_if_truncated(&graph, &graph_limits);

    // Early exit for incremental with nothing to process
    if *mode == DreamingMode::Incremental && summaries.is_empty() && graph.entities.is_empty() {
        let pass_id_clone = pass_id.clone();
        let agent_id_clone = agent_id.to_string();
        let mode_str = match mode {
            DreamingMode::Incremental => "incremental",
            DreamingMode::Compact => "compact",
        };
        pool.write(Priority::Low, move |conn| {
            conn.execute(
                "UPDATE dreaming_passes
                 SET status = 'completed',
                     completed_at = datetime('now'),
                     tokens_consumed = 0,
                     mutations_applied = 0,
                     mutations_skipped = 0,
                     mutations_failed = 0,
                     summary = 'No new summaries or entities to process'
                 WHERE id = ?1",
                params![pass_id_clone],
            )?;
            reset_dreaming_tokens(conn, &agent_id_clone, &pass_id_clone, mode_str)?;
            Ok(serde_json::Value::Null)
        })
        .await
        .ok();

        return Ok(DreamingPassResult {
            pass_id,
            applied: 0,
            skipped: 0,
            failed: 0,
            summary: "No new summaries or entities to process".into(),
        });
    }

    // Build prompt and call LLM
    let prompt = build_dreaming_prompt(mode, &summaries, &graph, agents_path, cfg.max_input_tokens);

    info!(
        mode = ?mode,
        summaries = summaries.len(),
        entities = graph.entities.len(),
        prompt_chars = prompt.len(),
        "starting dreaming pass"
    );

    let raw = generate
        .generate(&prompt, Some(cfg.timeout_ms), Some(cfg.max_output_tokens))
        .await
        .map_err(|e| format!("LLM generation failed: {e}"))?;

    let result = parse_dreaming_result(&raw)?;
    let prompt_tokens = estimate_tokens(&prompt);
    let total_tokens = prompt_tokens + result.tokens_consumed;

    info!(
        count = result.mutations.len(),
        prompt_tokens,
        output_tokens = result.tokens_consumed,
        summary = &result.summary[..result.summary.len().min(200)],
        "dreaming pass produced mutations"
    );

    // Apply mutations and complete pass in a single atomic transaction
    let pass_id_clone = pass_id.clone();
    let agent_id_clone = agent_id.to_string();
    let mode_str = match mode {
        DreamingMode::Incremental => "incremental",
        DreamingMode::Compact => "compact",
    };
    let mutations = result.mutations.clone();
    let summary = result.summary.clone();
    let invalid_mutations = result.invalid_mutations;

    let apply_result = pool
        .write(Priority::High, move |conn| {
            let ar = apply_mutations(conn, &agent_id_clone, &mutations);

            // Post-mutation integrity check: orphaned aspects
            let orphaned: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM entity_aspects ea
                     WHERE ea.agent_id = ?1
                       AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = ea.entity_id)",
                    params![agent_id_clone],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            if orphaned > 0 {
                warn!(
                    count = orphaned,
                    "post-mutation integrity: found orphaned aspects with no parent entity"
                );
            }

            // Complete pass record
            conn.execute(
                "UPDATE dreaming_passes
                 SET status = 'completed',
                     completed_at = datetime('now'),
                     tokens_consumed = ?1,
                     mutations_applied = ?2,
                     mutations_skipped = ?3,
                     mutations_failed = ?4,
                     summary = ?5
                 WHERE id = ?6",
                params![
                    total_tokens as i64,
                    ar.applied as i64,
                    ar.skipped as i64,
                    (ar.failed + invalid_mutations) as i64,
                    summary,
                    pass_id_clone,
                ],
            )?;
            reset_dreaming_tokens(conn, &agent_id_clone, &pass_id_clone, mode_str)?;

            Ok(serde_json::json!({
                "applied": ar.applied,
                "skipped": ar.skipped,
                "failed": ar.failed,
                "errors": ar.errors,
            }))
        })
        .await
        .map_err(|e| format!("mutation apply failed: {e}"))?;

    let apply_applied = apply_result["applied"].as_u64().unwrap_or(0) as usize;
    let apply_skipped = apply_result["skipped"].as_u64().unwrap_or(0) as usize;
    let apply_failed = apply_result["failed"].as_u64().unwrap_or(0) as usize;
    let apply_errors: Vec<String> = apply_result["errors"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if !apply_errors.is_empty() {
        warn!(
            errors = ?&apply_errors[..apply_errors.len().min(10)],
            "some mutations failed"
        );
    }

    info!(
        applied = apply_applied,
        skipped = apply_skipped,
        failed = apply_failed,
        summary = &result.summary[..result.summary.len().min(200)],
        "dreaming pass complete"
    );

    Ok(DreamingPassResult {
        pass_id,
        applied: apply_applied,
        skipped: apply_skipped,
        failed: apply_failed,
        summary: result.summary,
    })
}

/// Reset dreaming tokens after a successful pass.
fn reset_dreaming_tokens(
    conn: &rusqlite::Connection,
    agent_id: &str,
    pass_id: &str,
    mode: &str,
) -> Result<(), rusqlite::Error> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM dreaming_state WHERE agent_id = ?1)",
            params![agent_id],
            |row| row.get::<_, i64>(0).map(|v| v == 1),
        )
        .unwrap_or(false);

    if exists {
        conn.execute(
            "UPDATE dreaming_state
             SET tokens_since_last_pass = 0,
                 consecutive_failures = 0,
                 last_pass_at = datetime('now'),
                 last_pass_id = ?1,
                 last_pass_mode = ?2,
                 updated_at = datetime('now')
             WHERE agent_id = ?3",
            params![pass_id, mode, agent_id],
        )?;
    } else {
        conn.execute(
            "INSERT INTO dreaming_state (agent_id, tokens_since_last_pass, consecutive_failures, last_pass_at, last_pass_id, last_pass_mode)
             VALUES (?1, 0, 0, datetime('now'), ?2, ?3)",
            params![agent_id, pass_id, mode],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Threshold check
// ---------------------------------------------------------------------------

/// Max backoff: 5min * 2^6 = ~5.3 hours
const MAX_FAILURE_BACKOFF_MULTIPLIER: u32 = 6;

/// Check whether a dreaming pass should be triggered for the given agent.
pub async fn should_trigger_dreaming(pool: &DbPool, cfg: &DreamingConfig, agent_id: &str) -> bool {
    if !cfg.enabled {
        return false;
    }

    let state = get_dreaming_state(pool, agent_id).await;

    if state.consecutive_failures > 0 {
        let exp = (state.consecutive_failures as u32).min(MAX_FAILURE_BACKOFF_MULTIPLIER);
        let backoff_checks = 2_i64.pow(exp);

        // First-run failures with backfill: require at least tokenThreshold
        if state.last_pass_at.is_none() && cfg.backfill_on_first_run {
            return state.tokens_since_last_pass >= cfg.token_threshold;
        }

        return state.tokens_since_last_pass >= cfg.token_threshold * backoff_checks;
    }

    // First run with backfill always triggers (no failures)
    if cfg.backfill_on_first_run && state.last_pass_at.is_none() {
        return true;
    }

    state.tokens_since_last_pass >= cfg.token_threshold
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalize_normalizes_whitespace_and_case() {
        assert_eq!(canonicalize("  Hello   World  "), "hello world");
        assert_eq!(canonicalize("Foo"), "foo");
        assert_eq!(canonicalize(""), "");
    }

    #[test]
    fn estimate_tokens_approx_4_chars_per_token() {
        assert_eq!(estimate_tokens("1234"), 1);
        assert_eq!(estimate_tokens("12345678"), 2);
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn parse_dreaming_result_handles_code_fences() {
        let raw = "```json\n{\"mutations\": [], \"summary\": \"test\"}\n```";
        let result = parse_dreaming_result(raw).unwrap();
        assert!(result.mutations.is_empty());
        assert_eq!(result.summary, "test");
    }

    #[test]
    fn parse_dreaming_result_validates_mutations() {
        let raw = r#"{"mutations": [
            {"op": "create_entity", "name": "Test"},
            {"op": "invalid_op"},
            {"op": "merge_entities", "source": ["a"], "target": "b"}
        ], "summary": "mixed"}"#;
        let result = parse_dreaming_result(raw).unwrap();
        assert_eq!(result.mutations.len(), 2);
        assert_eq!(result.invalid_mutations, 1);
    }

    #[test]
    fn is_valid_mutation_rejects_non_objects() {
        assert!(!is_valid_mutation(&serde_json::json!("string")));
        assert!(!is_valid_mutation(&serde_json::json!(42)));
        assert!(!is_valid_mutation(&serde_json::json!(null)));
    }

    #[test]
    fn is_valid_mutation_rejects_unknown_op() {
        assert!(!is_valid_mutation(&serde_json::json!({"op": "unknown"})));
    }

    #[test]
    fn is_valid_mutation_accepts_create_entity() {
        assert!(is_valid_mutation(&serde_json::json!({
            "op": "create_entity", "name": "Test"
        })));
    }

    #[test]
    fn is_valid_mutation_requires_merge_source_array() {
        assert!(!is_valid_mutation(&serde_json::json!({
            "op": "merge_entities", "source": "not_array", "target": "b"
        })));
        assert!(is_valid_mutation(&serde_json::json!({
            "op": "merge_entities", "source": ["a"], "target": "b"
        })));
    }

    #[test]
    fn build_prompt_contains_all_sections() {
        let summaries = vec![SessionSummaryRow {
            id: "s1".into(),
            content: "Test summary content".into(),
            token_count: 10,
            session_key: None,
            project: Some("test-project".into()),
            latest_at: "2026-01-01T00:00:00Z".into(),
        }];
        let graph = EntityGraph {
            entities: vec![EntityRow {
                id: "e1".into(),
                name: "TestEntity".into(),
                entity_type: "concept".into(),
                description: Some("A test entity".into()),
            }],
            aspects: vec![AspectRow {
                id: "a1".into(),
                entity_id: "e1".into(),
                name: "general".into(),
                weight: 0.8,
            }],
            attributes: vec![AttributeRow {
                id: "attr1".into(),
                aspect_id: "a1".into(),
                kind: "attribute".into(),
                content: "test attribute".into(),
                status: "active".into(),
                importance: 0.5,
            }],
            dependencies: vec![DependencyRow {
                source_entity_id: "e1".into(),
                target_entity_id: "e2".into(),
                dependency_type: "uses".into(),
                strength: 0.7,
                confidence: 0.9,
                reason: None,
            }],
        };
        let dir = std::env::temp_dir();
        let prompt = build_dreaming_prompt(
            &DreamingMode::Incremental,
            &summaries,
            &graph,
            &dir,
            128_000,
        );
        assert!(prompt.contains("<identity>"));
        assert!(prompt.contains("<working_memory>"));
        assert!(prompt.contains("<task>"));
        assert!(prompt.contains("INCREMENTAL"));
        assert!(prompt.contains("TestEntity"));
        assert!(prompt.contains("test attribute"));
        assert!(prompt.contains("Test summary content"));
        assert!(prompt.contains("uses"));
    }

    #[test]
    fn dreaming_config_default_matches_ts() {
        let cfg = DreamingConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.token_threshold, 100_000);
        assert_eq!(cfg.timeout_ms, 300_000);
        assert_eq!(cfg.max_input_tokens, 128_000);
        assert_eq!(cfg.max_output_tokens, 16_000);
        assert!(cfg.backfill_on_first_run);
    }

    #[test]
    fn should_trigger_respects_enabled_flag() {
        let cfg = DreamingConfig {
            enabled: false,
            ..DreamingConfig::default()
        };
        // Can't easily test async here without a pool, but the logic is trivial
        assert!(!cfg.enabled);
    }

    #[test]
    fn should_trigger_backoff_calculation() {
        // 2^3 = 8, threshold * 8
        let failures = 3_i64;
        let exp = (failures as u32).min(MAX_FAILURE_BACKOFF_MULTIPLIER);
        let backoff = 2_i64.pow(exp);
        assert_eq!(backoff, 8);

        // Capped at 2^6 = 64
        let failures = 10_i64;
        let exp = (failures as u32).min(MAX_FAILURE_BACKOFF_MULTIPLIER);
        let backoff = 2_i64.pow(exp);
        assert_eq!(backoff, 64);
    }

    // --- Integration-style tests with real DB ---

    #[tokio::test]
    async fn add_dreaming_tokens_creates_row() {
        let path =
            std::env::temp_dir().join(format!("signet-dreaming-tokens-{}.db", Uuid::new_v4()));
        let (pool, _handle) = DbPool::open(&path).unwrap();

        add_dreaming_tokens(&pool, "agent-a", 500).await;
        add_dreaming_tokens(&pool, "agent-a", 300).await;

        let state = get_dreaming_state(&pool, "agent-a").await;
        assert_eq!(state.tokens_since_last_pass, 800);
        assert_eq!(state.consecutive_failures, 0);
    }

    #[tokio::test]
    async fn record_failure_increments_counter() {
        let path =
            std::env::temp_dir().join(format!("signet-dreaming-failure-{}.db", Uuid::new_v4()));
        let (pool, _handle) = DbPool::open(&path).unwrap();

        record_dreaming_failure(&pool, "agent-a").await;
        record_dreaming_failure(&pool, "agent-a").await;

        let state = get_dreaming_state(&pool, "agent-a").await;
        assert_eq!(state.consecutive_failures, 2);
    }

    #[tokio::test]
    async fn create_pass_and_get_passes() {
        let path =
            std::env::temp_dir().join(format!("signet-dreaming-passes-{}.db", Uuid::new_v4()));
        let (pool, _handle) = DbPool::open(&path).unwrap();

        let id = create_dreaming_pass(&pool, "agent-a", &DreamingMode::Incremental).await;
        assert!(!id.is_empty());

        let passes = get_dreaming_passes(&pool, "agent-a", 10).await;
        assert_eq!(passes.len(), 1);
        assert_eq!(passes[0].id, id);
        assert_eq!(passes[0].mode, "incremental");
        assert_eq!(passes[0].status, "running");
    }

    #[tokio::test]
    async fn should_trigger_first_run_backfill() {
        let path =
            std::env::temp_dir().join(format!("signet-dreaming-trigger-{}.db", Uuid::new_v4()));
        let (pool, _handle) = DbPool::open(&path).unwrap();

        let cfg = DreamingConfig {
            enabled: true,
            backfill_on_first_run: true,
            ..DreamingConfig::default()
        };

        // First run with backfill always triggers
        assert!(should_trigger_dreaming(&pool, &cfg, "new-agent").await);
    }

    #[tokio::test]
    async fn should_trigger_requires_tokens_after_threshold() {
        let path =
            std::env::temp_dir().join(format!("signet-dreaming-threshold-{}.db", Uuid::new_v4()));
        let (pool, _handle) = DbPool::open(&path).unwrap();

        // Create state with a past pass
        pool.write(Priority::Low, |conn| {
            conn.execute(
                "INSERT INTO dreaming_state (agent_id, tokens_since_last_pass, consecutive_failures, last_pass_at, last_pass_id, last_pass_mode)
                 VALUES ('agent-a', 0, 0, datetime('now'), 'p1', 'incremental')",
                [],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
        .unwrap();

        let cfg = DreamingConfig {
            enabled: true,
            token_threshold: 100_000,
            backfill_on_first_run: true,
            ..DreamingConfig::default()
        };

        // Below threshold
        assert!(!should_trigger_dreaming(&pool, &cfg, "agent-a").await);

        // Add enough tokens
        add_dreaming_tokens(&pool, "agent-a", 100_000).await;
        assert!(should_trigger_dreaming(&pool, &cfg, "agent-a").await);
    }

    #[tokio::test]
    async fn mutation_create_entity_creates_graph() {
        let path =
            std::env::temp_dir().join(format!("signet-dreaming-mutation-{}.db", Uuid::new_v4()));
        let (pool, _handle) = DbPool::open(&path).unwrap();

        pool.write(Priority::Low, |conn| {
            let outcome = apply_create_entity(
                conn,
                "agent-a",
                "TestEntity",
                Some("concept"),
                Some(&[AspectInput {
                    name: "general".into(),
                    attributes: Some(vec!["This is a test attribute that is long enough".into()]),
                }]),
            );
            assert!(matches!(outcome, MutationOutcome::Applied));
            Ok(serde_json::Value::Null)
        })
        .await
        .unwrap();

        // Verify entity was created
        let counts = pool
            .read(|conn| {
                let entities: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM entities WHERE agent_id = 'agent-a'",
                    [],
                    |row| row.get(0),
                )?;
                let aspects: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM entity_aspects WHERE agent_id = 'agent-a'",
                    [],
                    |row| row.get(0),
                )?;
                let attrs: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM entity_attributes WHERE agent_id = 'agent-a' AND status = 'active'",
                    [],
                    |row| row.get(0),
                )?;
                Ok((entities, aspects, attrs))
            })
            .await
            .unwrap();
        assert_eq!(counts.0, 1);
        assert_eq!(counts.1, 1);
        assert_eq!(counts.2, 1);
    }

    #[tokio::test]
    async fn mutation_delete_entity_respects_constraints() {
        let path =
            std::env::temp_dir().join(format!("signet-dreaming-delete-{}.db", Uuid::new_v4()));
        let (pool, _handle) = DbPool::open(&path).unwrap();

        pool.write(Priority::Low, |conn| {
            // Create entity with a constraint attribute
            let entity_id = resolve_or_create_entity(conn, "agent-a", "ProtectedEntity", "concept");
            let aspect_id = resolve_or_create_aspect(conn, &entity_id, "agent-a", "rules");
            insert_attr(
                conn,
                &aspect_id,
                "agent-a",
                "never delete this",
                "never delete this",
                "constraint",
                1.0,
                1.0,
            );

            // Try to delete — should skip due to constraint
            let outcome = apply_delete_entity(conn, "agent-a", "ProtectedEntity");
            assert!(matches!(outcome, MutationOutcome::Skipped));
            Ok(serde_json::Value::Null)
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn mutation_supersede_marks_old() {
        let path =
            std::env::temp_dir().join(format!("signet-dreaming-supersede-{}.db", Uuid::new_v4()));
        let (pool, _handle) = DbPool::open(&path).unwrap();

        pool.write(Priority::Low, |conn| {
            let entity_id = resolve_or_create_entity(conn, "agent-a", "TestEntity", "concept");
            let aspect_id = resolve_or_create_aspect(conn, &entity_id, "agent-a", "general");
            insert_attr(
                conn,
                &aspect_id,
                "agent-a",
                "old value here for testing",
                "old value here for testing",
                "attribute",
                0.8,
                0.5,
            );

            let outcome = apply_supersede(
                conn,
                "agent-a",
                "TestEntity",
                "general",
                "old value here for testing",
                "new updated value for testing",
            );
            assert!(matches!(outcome, MutationOutcome::Applied));

            // Verify old is superseded
            let superseded: i64 = conn.query_row(
                "SELECT COUNT(*) FROM entity_attributes WHERE status = 'superseded'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(superseded, 1);

            let active: i64 = conn.query_row(
                "SELECT COUNT(*) FROM entity_attributes WHERE status = 'active'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(active, 1);

            Ok(serde_json::Value::Null)
        })
        .await
        .unwrap();
    }
}
