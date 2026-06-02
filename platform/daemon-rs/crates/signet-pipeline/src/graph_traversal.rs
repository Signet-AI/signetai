//! Graph traversal for recall-time knowledge graph navigation.
//!
//! BFS/DFS traversal of entity/aspect/dependency graph at recall time.
//! Returns memory IDs, scores, constraints, and provenance paths.
//!
//! Ports graph-traversal.ts (591 LOC).

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use rusqlite::params;
use tracing::debug;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct TraversalPath {
    pub entity_ids: Vec<String>,
    pub aspect_ids: Vec<String>,
    pub dependency_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Constraint {
    pub entity_name: String,
    pub content: String,
    pub importance: f64,
}

#[derive(Debug, Clone)]
pub struct TraversalResult {
    pub memory_ids: HashSet<String>,
    pub memory_scores: HashMap<String, f64>,
    pub memory_paths: HashMap<String, TraversalPath>,
    pub constraints: Vec<Constraint>,
    pub entity_count: usize,
    pub timed_out: bool,
    pub active_aspect_ids: Vec<String>,
    pub focal_entity_ids: Vec<String>,
}

impl Default for TraversalResult {
    fn default() -> Self {
        Self {
            memory_ids: HashSet::new(),
            memory_scores: HashMap::new(),
            memory_paths: HashMap::new(),
            constraints: Vec::new(),
            entity_count: 0,
            timed_out: false,
            active_aspect_ids: Vec::new(),
            focal_entity_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TraversalConfig {
    pub scope: Option<String>,
    pub max_aspects_per_entity: usize,
    pub max_attributes_per_aspect: usize,
    pub max_dependency_hops: usize,
    pub min_dependency_strength: f64,
    pub max_branching: usize,
    pub max_traversal_paths: usize,
    pub min_confidence: f64,
    pub timeout_ms: u64,
    pub aspect_filter: Option<String>,
}

impl Default for TraversalConfig {
    fn default() -> Self {
        Self {
            scope: None,
            max_aspects_per_entity: 10,
            max_attributes_per_aspect: 20,
            max_dependency_hops: 10,
            min_dependency_strength: 0.3,
            max_branching: 4,
            max_traversal_paths: 50,
            min_confidence: 0.5,
            timeout_ms: 500,
            aspect_filter: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FocalEntityResult {
    pub entity_ids: Vec<String>,
    pub entity_names: Vec<String>,
    pub pinned_entity_ids: Vec<String>,
    pub source: String, // "project" | "checkpoint" | "query" | "session_key"
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn normalize_token(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect::<String>()
        .trim()
        .to_string()
}

fn sanitize_entity_ids(ids: &[String]) -> Vec<String> {
    let mut unique = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        if !id.is_empty() && !seen.contains(id.as_str()) {
            seen.insert(id.as_str());
            unique.push(id.clone());
        }
    }
    unique
}

fn get_entity_names(conn: &rusqlite::Connection, ids: &[String]) -> Vec<String> {
    let entity_ids = sanitize_entity_ids(ids);
    if entity_ids.is_empty() {
        return Vec::new();
    }
    let placeholders = entity_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT id, name FROM entities WHERE id IN ({placeholders})");
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let params: Vec<&dyn rusqlite::types::ToSql> = entity_ids
        .iter()
        .map(|id| id as &dyn rusqlite::types::ToSql)
        .collect();
    let rows: HashMap<String, String> = stmt
        .query_map(params.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok()
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();

    entity_ids
        .iter()
        .filter_map(|id| rows.get(id).filter(|n| !n.is_empty()).cloned())
        .collect()
}

fn get_pinned_entity_ids(conn: &rusqlite::Connection, agent_id: &str) -> Vec<String> {
    conn.prepare_cached(
        "SELECT id FROM entities
         WHERE agent_id = ?1 AND pinned = 1
         ORDER BY pinned_at DESC, updated_at DESC",
    )
    .ok()
    .and_then(|mut stmt| {
        stmt.query_map(params![agent_id], |row| row.get::<_, String>(0))
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
    })
    .unwrap_or_default()
}

fn extract_project_tokens(project_path: &str) -> Vec<String> {
    let parts: Vec<String> = project_path
        .split(|c: char| c == '/' || c == '\\')
        .map(|p| normalize_token(p))
        .filter(|p| p.len() >= 2)
        .collect();
    if parts.is_empty() {
        return Vec::new();
    }
    let tail: Vec<String> = parts.into_iter().rev().take(2).collect();
    let mut seen = HashSet::new();
    tail.into_iter()
        .filter(|t| seen.insert(t.clone()))
        .collect()
}

fn has_traversal_tables(conn: &rusqlite::Connection) -> bool {
    let required = [
        "entities",
        "entity_aspects",
        "entity_attributes",
        "entity_dependencies",
    ];
    for table in &required {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                params![table],
                |row| row.get::<_, i64>(0).map(|v| v == 1),
            )
            .unwrap_or(false);
        if !exists {
            return false;
        }
    }
    true
}

fn resolve_by_project(
    conn: &rusqlite::Connection,
    agent_id: &str,
    project_path: &str,
) -> Vec<String> {
    let tokens = extract_project_tokens(project_path);
    if tokens.is_empty() {
        return Vec::new();
    }

    let clauses: Vec<String> = tokens
        .iter()
        .map(|_| "(canonical_name LIKE ? OR name LIKE ?)".to_string())
        .collect();
    let sql = format!(
        "SELECT id FROM entities
         WHERE agent_id = ? AND entity_type = 'project'
           AND ({})
         ORDER BY mentions DESC LIMIT 5",
        clauses.join(" OR ")
    );

    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(agent_id.to_string())];
    for token in &tokens {
        let pattern = format!("%{token}%");
        args.push(Box::new(pattern.clone()));
        args.push(Box::new(pattern));
    }
    let refs: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|a| a.as_ref()).collect();

    conn.prepare(&sql)
        .ok()
        .and_then(|mut stmt| {
            stmt.query_map(refs.as_slice(), |row| row.get::<_, String>(0))
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default()
}

fn resolve_by_query_tokens(
    conn: &rusqlite::Connection,
    agent_id: &str,
    query_tokens: &[String],
) -> Vec<String> {
    let tokens: Vec<String> = query_tokens
        .iter()
        .map(|t| normalize_token(t))
        .filter(|t| t.len() >= 2)
        .collect();
    if tokens.is_empty() {
        return Vec::new();
    }

    // Try FTS5 first
    let fts_query = tokens.join(" OR ");
    let fts_result: Vec<String> = conn
        .prepare(
            "SELECT e.id FROM entities_fts
             CROSS JOIN entities e ON e.rowid = entities_fts.rowid
             WHERE entities_fts MATCH ?1 AND e.agent_id = ?2
             ORDER BY rank LIMIT 20",
        )
        .ok()
        .and_then(|mut stmt| {
            stmt.query_map(params![fts_query, agent_id], |row| row.get::<_, String>(0))
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();
    if !fts_result.is_empty() {
        return fts_result;
    }

    // LIKE fallback
    let clauses: Vec<String> = tokens
        .iter()
        .map(|_| "(canonical_name LIKE ? OR name LIKE ?)".to_string())
        .collect();
    let sql = format!(
        "SELECT id FROM entities
         WHERE agent_id = ? AND ({})
         ORDER BY mentions DESC LIMIT 20",
        clauses.join(" OR ")
    );

    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(agent_id.to_string())];
    for token in &tokens {
        let pattern = format!("%{token}%");
        args.push(Box::new(pattern.clone()));
        args.push(Box::new(pattern));
    }
    let refs: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|a| a.as_ref()).collect();

    conn.prepare(&sql)
        .ok()
        .and_then(|mut stmt| {
            stmt.query_map(refs.as_slice(), |row| row.get::<_, String>(0))
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Public API: Focal entity resolution
// ---------------------------------------------------------------------------

/// Resolve focal entities from various signals (project, query, checkpoint, session).
pub fn resolve_focal_entities(
    conn: &rusqlite::Connection,
    agent_id: &str,
    project: Option<&str>,
    query_tokens: Option<&[String]>,
    checkpoint_entity_ids: Option<&[String]>,
    include_pinned: bool,
) -> FocalEntityResult {
    if !has_traversal_tables(conn) {
        return FocalEntityResult {
            entity_ids: Vec::new(),
            entity_names: Vec::new(),
            pinned_entity_ids: Vec::new(),
            source: "query".into(),
        };
    }

    let pinned_entity_ids = if include_pinned {
        get_pinned_entity_ids(conn, agent_id)
    } else {
        Vec::new()
    };

    let mut resolved_entity_ids = Vec::new();
    let mut source = if project.is_some() {
        "project"
    } else {
        "query"
    };

    if let Some(checkpoint_ids) = checkpoint_entity_ids {
        if !checkpoint_ids.is_empty() {
            resolved_entity_ids =
                sanitize_entity_ids(&checkpoint_ids.iter().map(|s| s.clone()).collect::<Vec<_>>());
            source = "checkpoint";
        }
    }

    if resolved_entity_ids.is_empty() {
        if let Some(proj) = project {
            let project_ids = resolve_by_project(conn, agent_id, proj);
            if !project_ids.is_empty() {
                resolved_entity_ids = project_ids;
                source = "project";
            }
        }
    }

    if resolved_entity_ids.is_empty() {
        if let Some(tokens) = query_tokens {
            if !tokens.is_empty() {
                let query_ids = resolve_by_query_tokens(conn, agent_id, tokens);
                if !query_ids.is_empty() {
                    resolved_entity_ids = query_ids;
                    source = "query";
                }
            }
        }
    }

    let mut all_ids = pinned_entity_ids.clone();
    all_ids.extend(resolved_entity_ids);
    let entity_ids = sanitize_entity_ids(&all_ids);

    FocalEntityResult {
        entity_names: get_entity_names(conn, &entity_ids),
        entity_ids,
        pinned_entity_ids,
        source: source.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Traversal state (avoids closure borrow issues)
// ---------------------------------------------------------------------------

struct TraversalState<'a> {
    conn: &'a rusqlite::Connection,
    agent_id: &'a str,
    config: &'a TraversalConfig,
    deadline: Instant,
    budget: usize,
    memory_ids: HashSet<String>,
    memory_scores: HashMap<String, f64>,
    memory_paths: HashMap<String, TraversalPath>,
    active_aspect_ids: HashSet<String>,
    constraint_keys: HashSet<String>,
    constraints: Vec<Constraint>,
    visited_entities: HashSet<String>,
    timed_out: bool,
}

impl<'a> TraversalState<'a> {
    fn new(conn: &'a rusqlite::Connection, agent_id: &'a str, config: &'a TraversalConfig) -> Self {
        let deadline = Instant::now() + std::time::Duration::from_millis(config.timeout_ms.max(1));
        Self {
            conn,
            agent_id,
            config,
            deadline,
            budget: config.max_traversal_paths,
            memory_ids: HashSet::new(),
            memory_scores: HashMap::new(),
            memory_paths: HashMap::new(),
            active_aspect_ids: HashSet::new(),
            constraint_keys: HashSet::new(),
            constraints: Vec::new(),
            visited_entities: HashSet::new(),
            timed_out: false,
        }
    }

    fn check_deadline(&mut self) -> bool {
        if Instant::now() > self.deadline {
            self.timed_out = true;
            true
        } else {
            false
        }
    }

    fn at_budget(&self) -> bool {
        self.memory_ids.len() >= self.budget
    }

    fn record_path(
        &mut self,
        memory_id: &str,
        entity_id: &str,
        source_entity_id: Option<&str>,
        aspect_id: Option<&str>,
        dependency_id: Option<&str>,
    ) {
        let next = TraversalPath {
            entity_ids: match source_entity_id {
                Some(sid) if !sid.is_empty() && sid != entity_id => {
                    vec![sid.to_string(), entity_id.to_string()]
                }
                _ => vec![entity_id.to_string()],
            },
            aspect_ids: aspect_id.map(|id| vec![id.to_string()]).unwrap_or_default(),
            dependency_ids: dependency_id
                .map(|id| vec![id.to_string()])
                .unwrap_or_default(),
        };
        let next_size = next.entity_ids.len() + next.aspect_ids.len() + next.dependency_ids.len();
        match self.memory_paths.get(memory_id) {
            Some(prev)
                if (prev.entity_ids.len() + prev.aspect_ids.len() + prev.dependency_ids.len())
                    >= next_size => {}
            _ => {
                self.memory_paths.insert(memory_id.to_string(), next);
            }
        }
    }

    fn record_memory(&mut self, memory_id: &str, importance: f64) {
        self.memory_ids.insert(memory_id.to_string());
        match self.memory_scores.get(memory_id) {
            Some(current) if *current >= importance => {}
            _ => {
                self.memory_scores.insert(memory_id.to_string(), importance);
            }
        }
    }

    fn collect_for_entity(
        &mut self,
        entity_id: &str,
        source_entity_id: Option<&str>,
        dependency_id: Option<&str>,
    ) {
        if self.timed_out || self.visited_entities.contains(entity_id) || self.at_budget() {
            return;
        }
        self.visited_entities.insert(entity_id.to_string());

        if self.check_deadline() {
            return;
        }

        let agent_id = self.agent_id;

        // Collect constraints
        if let Ok(mut stmt) = self.conn.prepare_cached(
            "SELECT e.name, ea.content, ea.importance
             FROM entity_aspects asp
             CROSS JOIN entity_attributes ea ON ea.aspect_id = asp.id
             JOIN entities e ON e.id = asp.entity_id
             WHERE asp.entity_id = ?1 AND asp.agent_id = ?2 AND ea.agent_id = ?2
               AND ea.kind = 'constraint' AND ea.status = 'active'
             ORDER BY ea.importance DESC",
        ) {
            if let Ok(rows) = stmt.query_map(params![entity_id, agent_id], |row| {
                Ok(Constraint {
                    entity_name: row.get::<_, String>(0)?,
                    content: row.get::<_, String>(1)?,
                    importance: row.get::<_, f64>(2)?,
                })
            }) {
                for row in rows.flatten() {
                    let key = format!("{}::{}", row.entity_name, row.content);
                    if !self.constraint_keys.contains(&key) {
                        self.constraint_keys.insert(key);
                        self.constraints.push(row);
                    }
                }
            }
        }

        if self.check_deadline() {
            return;
        }

        // Collect aspects
        let (aspect_sql, aspect_params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) =
            match &self.config.aspect_filter {
                Some(filter) => (
                    "SELECT id FROM entity_aspects
                 WHERE entity_id = ?1 AND agent_id = ?2 AND canonical_name LIKE ?3
                 ORDER BY weight DESC LIMIT ?4"
                        .into(),
                    vec![
                        Box::new(entity_id.to_string()),
                        Box::new(agent_id.to_string()),
                        Box::new(format!("%{filter}%")),
                        Box::new(self.config.max_aspects_per_entity as i64),
                    ],
                ),
                None => (
                    "SELECT id FROM entity_aspects
                 WHERE entity_id = ?1 AND agent_id = ?2
                 ORDER BY weight DESC LIMIT ?3"
                        .into(),
                    vec![
                        Box::new(entity_id.to_string()),
                        Box::new(agent_id.to_string()),
                        Box::new(self.config.max_aspects_per_entity as i64),
                    ],
                ),
            };

        if let Ok(mut stmt) = self.conn.prepare(&aspect_sql) {
            let refs: Vec<&dyn rusqlite::types::ToSql> =
                aspect_params.iter().map(|p| p.as_ref()).collect();
            if let Ok(rows) = stmt.query_map(refs.as_slice(), |row| row.get::<_, String>(0)) {
                for aspect_row in rows.flatten() {
                    if self.timed_out || self.at_budget() {
                        break;
                    }
                    self.active_aspect_ids.insert(aspect_row.clone());

                    let attr_rows: Vec<(Option<String>, f64)> = self.query_attributes(&aspect_row);

                    for (memory_id, importance) in &attr_rows {
                        if let Some(mid) = memory_id {
                            self.record_memory(mid, *importance);
                            self.record_path(
                                mid,
                                entity_id,
                                source_entity_id,
                                Some(&aspect_row),
                                dependency_id,
                            );
                        }
                    }
                }
            }
        }

        // Fallback: collect via memory_entity_mentions
        if self.timed_out || self.at_budget() {
            return;
        }
        let mention_budget = self
            .config
            .max_attributes_per_aspect
            .min(self.budget.saturating_sub(self.memory_ids.len()));
        if mention_budget == 0 {
            return;
        }

        let mention_rows: Vec<(String, f64)> = self.query_mentions(entity_id, mention_budget);

        for (memory_id, importance) in &mention_rows {
            self.record_memory(memory_id, *importance);
            self.record_path(memory_id, entity_id, source_entity_id, None, dependency_id);
        }
    }

    fn query_attributes(&self, aspect_id: &str) -> Vec<(Option<String>, f64)> {
        let limit = self.config.max_attributes_per_aspect as i64;
        match &self.config.scope {
            Some(scope_val) if scope_val.is_empty() => {
                let Ok(mut stmt) = self.conn.prepare(
                    "SELECT ea.memory_id, ea.importance FROM entity_attributes ea
                     JOIN memories m ON m.id = ea.memory_id
                     WHERE ea.aspect_id = ?1 AND ea.agent_id = ?2
                       AND ea.status = 'active' AND m.is_deleted = 0 AND m.scope IS NULL
                     ORDER BY ea.importance DESC LIMIT ?3",
                ) else {
                    return Vec::new();
                };
                let rows: Vec<_> = stmt
                    .query_map(params![aspect_id, self.agent_id, limit], |row| {
                        Ok((row.get::<_, Option<String>>(0)?, row.get::<_, f64>(1)?))
                    })
                    .ok()
                    .map(|r| r.filter_map(|v| v.ok()).collect())
                    .unwrap_or_default();
                rows
            }
            Some(scope_val) => {
                let Ok(mut stmt) = self.conn.prepare(
                    "SELECT ea.memory_id, ea.importance FROM entity_attributes ea
                     JOIN memories m ON m.id = ea.memory_id
                     WHERE ea.aspect_id = ?1 AND ea.agent_id = ?2
                       AND ea.status = 'active' AND m.is_deleted = 0 AND m.scope = ?3
                     ORDER BY ea.importance DESC LIMIT ?4",
                ) else {
                    return Vec::new();
                };
                let rows: Vec<_> = stmt
                    .query_map(params![aspect_id, self.agent_id, scope_val, limit], |row| {
                        Ok((row.get::<_, Option<String>>(0)?, row.get::<_, f64>(1)?))
                    })
                    .ok()
                    .map(|r| r.filter_map(|v| v.ok()).collect())
                    .unwrap_or_default();
                rows
            }
            None => {
                let Ok(mut stmt) = self.conn.prepare(
                    "SELECT memory_id, importance FROM entity_attributes
                     WHERE aspect_id = ?1 AND agent_id = ?2 AND status = 'active'
                     ORDER BY importance DESC LIMIT ?3",
                ) else {
                    return Vec::new();
                };
                let rows: Vec<_> = stmt
                    .query_map(params![aspect_id, self.agent_id, limit], |row| {
                        Ok((row.get::<_, Option<String>>(0)?, row.get::<_, f64>(1)?))
                    })
                    .ok()
                    .map(|r| r.filter_map(|v| v.ok()).collect())
                    .unwrap_or_default();
                rows
            }
        }
    }

    fn query_mentions(&self, entity_id: &str, limit: usize) -> Vec<(String, f64)> {
        match &self.config.scope {
            Some(scope_val) if scope_val.is_empty() => {
                let Ok(mut stmt) = self.conn.prepare(
                    "SELECT mem.memory_id, COALESCE(m.importance, 0.5)
                     FROM memory_entity_mentions mem
                     JOIN memories m ON m.id = mem.memory_id
                     WHERE mem.entity_id = ?1 AND m.is_deleted = 0 AND m.scope IS NULL
                     ORDER BY mem.confidence DESC, m.importance DESC LIMIT ?2",
                ) else {
                    return Vec::new();
                };
                stmt.query_map(params![entity_id, limit as i64], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
                })
                .ok()
                .map(|r| r.filter_map(|v| v.ok()).collect())
                .unwrap_or_default()
            }
            Some(scope_val) => {
                let Ok(mut stmt) = self.conn.prepare(
                    "SELECT mem.memory_id, COALESCE(m.importance, 0.5)
                     FROM memory_entity_mentions mem
                     JOIN memories m ON m.id = mem.memory_id
                     WHERE mem.entity_id = ?1 AND m.is_deleted = 0 AND m.scope = ?2
                     ORDER BY mem.confidence DESC, m.importance DESC LIMIT ?3",
                ) else {
                    return Vec::new();
                };
                stmt.query_map(params![entity_id, scope_val, limit as i64], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
                })
                .ok()
                .map(|r| r.filter_map(|v| v.ok()).collect())
                .unwrap_or_default()
            }
            None => {
                let Ok(mut stmt) = self.conn.prepare(
                    "SELECT mem.memory_id, COALESCE(m.importance, 0.5)
                     FROM memory_entity_mentions mem
                     JOIN memories m ON m.id = mem.memory_id
                     WHERE mem.entity_id = ?1 AND m.is_deleted = 0
                     ORDER BY mem.confidence DESC, m.importance DESC LIMIT ?2",
                ) else {
                    return Vec::new();
                };
                stmt.query_map(params![entity_id, limit as i64], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
                })
                .ok()
                .map(|r| r.filter_map(|v| v.ok()).collect())
                .unwrap_or_default()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Public API: Knowledge graph traversal
// ---------------------------------------------------------------------------

/// Traverse the knowledge graph starting from focal entities, collecting
/// memory IDs, scores, constraints, and provenance paths.
pub fn traverse_knowledge_graph(
    focal_entity_ids: &[String],
    conn: &rusqlite::Connection,
    agent_id: &str,
    config: &TraversalConfig,
) -> TraversalResult {
    if !has_traversal_tables(conn) {
        return TraversalResult::default();
    }

    let focal_ids = sanitize_entity_ids(focal_entity_ids);
    if focal_ids.is_empty() {
        return TraversalResult::default();
    }

    let mut state = TraversalState::new(conn, agent_id, config);

    // Phase 1: Collect from focal entities
    for entity_id in &focal_ids {
        if state.timed_out || state.at_budget() {
            break;
        }
        state.collect_for_entity(entity_id, None, None);
    }

    // Phase 2: One-hop dependency expansion
    if !state.timed_out && !state.at_budget() {
        let placeholders: String = focal_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let dep_sql = format!(
            "SELECT id, source_entity_id, target_entity_id FROM entity_dependencies
             WHERE agent_id = ?1 AND source_entity_id IN ({placeholders})
               AND (COALESCE(confidence, 0.7) * strength) >= ?2
               AND COALESCE(confidence, 0.7) >= ?3
             ORDER BY (COALESCE(confidence, 0.7) * strength) DESC
             LIMIT ?4"
        );

        let mut dep_args: Vec<Box<dyn rusqlite::types::ToSql>> = vec![
            Box::new(agent_id.to_string()),
            Box::new(config.min_dependency_strength),
            Box::new(config.min_confidence),
            Box::new((config.max_branching * focal_ids.len()) as i64),
        ];
        for fid in &focal_ids {
            dep_args.push(Box::new(fid.clone()));
        }
        let dep_refs: Vec<&dyn rusqlite::types::ToSql> =
            dep_args.iter().map(|a| a.as_ref()).collect();

        if let Ok(mut stmt) = conn.prepare(&dep_sql) {
            if let Ok(rows) = stmt.query_map(dep_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            }) {
                for row in rows.flatten() {
                    if state.timed_out || state.at_budget() {
                        break;
                    }
                    state.collect_for_entity(&row.2, Some(&row.1), Some(&row.0));
                }
            }
        }
    }

    state.constraints.sort_by(|a, b| {
        b.importance
            .partial_cmp(&a.importance)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    debug!(
        entities = state.visited_entities.len(),
        memories = state.memory_ids.len(),
        constraints = state.constraints.len(),
        timed_out = state.timed_out,
        "graph traversal complete"
    );

    TraversalResult {
        memory_ids: state.memory_ids,
        memory_scores: state.memory_scores,
        memory_paths: state.memory_paths,
        constraints: state.constraints,
        entity_count: state.visited_entities.len(),
        timed_out: state.timed_out,
        active_aspect_ids: state.active_aspect_ids.into_iter().collect(),
        focal_entity_ids: focal_ids,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_token_strips_non_alnum() {
        assert_eq!(normalize_token("Hello, World!"), "helloworld");
        assert_eq!(normalize_token("foo-bar_baz"), "foo-bar_baz");
    }

    #[test]
    fn sanitize_entity_ids_dedupes_and_filters_empty() {
        let ids = vec!["a".into(), "".into(), "b".into(), "a".into()];
        let result = sanitize_entity_ids(&ids);
        assert_eq!(result, vec!["a", "b"]);
    }

    #[test]
    fn extract_project_tokens_takes_last_two() {
        let tokens = extract_project_tokens("/home/user/projects/my-app");
        assert!(tokens.contains(&"my-app".to_string()));
    }

    #[test]
    fn traversal_config_defaults() {
        let cfg = TraversalConfig::default();
        assert_eq!(cfg.max_aspects_per_entity, 10);
        assert_eq!(cfg.max_attributes_per_aspect, 20);
        assert_eq!(cfg.max_traversal_paths, 50);
        assert_eq!(cfg.timeout_ms, 500);
    }

    #[test]
    fn empty_focal_ids_returns_empty() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let cfg = TraversalConfig::default();
        let result = traverse_knowledge_graph(&[], &conn, "test", &cfg);
        assert!(result.memory_ids.is_empty());
        assert_eq!(result.entity_count, 0);
    }
}
