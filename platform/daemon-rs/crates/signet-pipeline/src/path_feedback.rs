//! Entity path feedback, pinning, health, and aspect feedback parity.
//!
//! Ports the durable behavior from `platform/daemon/src/path-feedback.ts`,
//! plus the small knowledge feedback helpers exercised by
//! `knowledge-feedback.test.ts`.

use std::collections::{BTreeSet, HashMap, HashSet};

use rusqlite::{OptionalExtension, params};
use serde_json::Value;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedbackPath {
    pub entity_ids: Vec<String>,
    pub aspect_ids: Vec<String>,
    pub dependency_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FeedbackReward {
    pub forward_citation: f64,
    pub update_after_retrieval: f64,
    pub downstream_creation: f64,
    pub dead_end: f64,
}

#[derive(Clone, Debug)]
pub struct PathFeedbackConfig {
    pub aspect_delta: f64,
    pub edge_delta: f64,
    pub confidence_delta: f64,
    pub q_alpha: f64,
    pub min_edge_strength: f64,
    pub min_confidence: f64,
    pub npmi_threshold: f64,
    pub min_co_sessions: i64,
    pub auto_edge_cap: i64,
    pub max_aspect_weight: f64,
    pub min_aspect_weight: f64,
}

impl Default for PathFeedbackConfig {
    fn default() -> Self {
        Self {
            aspect_delta: 0.02,
            edge_delta: 0.04,
            confidence_delta: 0.05,
            q_alpha: 0.1,
            min_edge_strength: 0.1,
            min_confidence: 0.2,
            npmi_threshold: 0.15,
            min_co_sessions: 3,
            auto_edge_cap: 20,
            max_aspect_weight: 1.0,
            min_aspect_weight: 0.1,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PathFeedbackResult {
    pub accepted: i64,
    pub propagated: i64,
    pub cooccurrence_updated: i64,
    pub dependencies_updated: i64,
}

#[derive(Clone, Debug)]
pub struct RecordPathFeedbackInput {
    pub session_key: String,
    pub agent_id: String,
    pub ratings: HashMap<String, f64>,
    pub paths: Option<Value>,
    pub rewards: Option<Value>,
    pub max_aspect_weight: Option<f64>,
    pub min_aspect_weight: Option<f64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PinnedEntitySummary {
    pub id: String,
    pub name: String,
    pub pinned_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EntityHealth {
    pub entity_id: String,
    pub entity_name: String,
    pub comparison_count: usize,
    pub win_rate: f64,
    pub avg_margin: f64,
    pub trend: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AspectFeedbackResult {
    pub aspects_updated: i64,
    pub total_fts_confirmations: i64,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn table_exists(conn: &rusqlite::Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get::<_, i64>(0).map(|value| value == 1),
    )
}

pub fn pin_entity(
    conn: &rusqlite::Connection,
    entity_id: &str,
    agent_id: &str,
) -> rusqlite::Result<()> {
    let ts = now();
    conn.execute(
        "UPDATE entities
         SET pinned = 1, pinned_at = ?1, updated_at = ?1
         WHERE id = ?2 AND agent_id = ?3",
        params![ts, entity_id, agent_id],
    )?;
    Ok(())
}

pub fn unpin_entity(
    conn: &rusqlite::Connection,
    entity_id: &str,
    agent_id: &str,
) -> rusqlite::Result<()> {
    let ts = now();
    conn.execute(
        "UPDATE entities
         SET pinned = 0, pinned_at = NULL, updated_at = ?1
         WHERE id = ?2 AND agent_id = ?3",
        params![ts, entity_id, agent_id],
    )?;
    Ok(())
}

pub fn get_pinned_entities(
    conn: &rusqlite::Connection,
    agent_id: &str,
) -> rusqlite::Result<Vec<PinnedEntitySummary>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, name, pinned_at
         FROM entities
         WHERE agent_id = ?1
           AND pinned = 1
           AND COALESCE(status, 'active') = 'active'
         ORDER BY pinned_at DESC, updated_at DESC, name ASC",
    )?;
    let rows = stmt.query_map([agent_id], |row| {
        Ok(PinnedEntitySummary {
            id: row.get(0)?,
            name: row.get(1)?,
            pinned_at: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        })
    })?;
    rows.collect()
}

pub fn get_entity_health(
    conn: &rusqlite::Connection,
    agent_id: &str,
    since: Option<&str>,
    min_comparisons: usize,
) -> rusqlite::Result<Vec<EntityHealth>> {
    if !table_exists(conn, "predictor_comparisons")? {
        return Ok(Vec::new());
    }

    let mut sql = String::from(
        "SELECT focal_entity_id,
                COALESCE(focal_entity_name, '') AS focal_entity_name,
                predictor_won,
                margin,
                created_at
         FROM predictor_comparisons
         WHERE agent_id = ?1
           AND focal_entity_id IS NOT NULL",
    );
    if since.filter(|value| !value.is_empty()).is_some() {
        sql.push_str(" AND created_at >= ?2");
    }
    sql.push_str(" ORDER BY focal_entity_id ASC, created_at ASC");

    let mut stmt = conn.prepare(&sql)?;
    let mut grouped: HashMap<String, Vec<(String, f64, f64)>> = HashMap::new();
    if let Some(since) = since.filter(|value| !value.is_empty()) {
        let rows = stmt.query_map(params![agent_id, since], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
            ))
        })?;
        for row in rows {
            let (entity_id, entity_name, predictor_won, margin) = row?;
            grouped.entry(entity_id.clone()).or_default().push((
                if entity_name.is_empty() {
                    entity_id
                } else {
                    entity_name
                },
                predictor_won,
                margin,
            ));
        }
    } else {
        let rows = stmt.query_map(params![agent_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
            ))
        })?;
        for row in rows {
            let (entity_id, entity_name, predictor_won, margin) = row?;
            grouped.entry(entity_id.clone()).or_default().push((
                if entity_name.is_empty() {
                    entity_id
                } else {
                    entity_name
                },
                predictor_won,
                margin,
            ));
        }
    }

    let mut health = Vec::new();
    for (entity_id, comparisons) in grouped {
        if comparisons.len() < min_comparisons {
            continue;
        }
        let wins = comparisons
            .iter()
            .filter(|(_, predictor_won, _)| *predictor_won > 0.0)
            .count();
        let avg_margin = comparisons
            .iter()
            .map(|(_, _, margin)| *margin)
            .sum::<f64>()
            / comparisons.len() as f64;
        let midpoint = 1_usize.max(comparisons.len() / 2);
        let (first_half, second_half) = comparisons.split_at(midpoint);
        let first_half_rate = first_half
            .iter()
            .filter(|(_, predictor_won, _)| *predictor_won > 0.0)
            .count() as f64
            / first_half.len() as f64;
        let second_half_rate = if second_half.is_empty() {
            first_half_rate
        } else {
            second_half
                .iter()
                .filter(|(_, predictor_won, _)| *predictor_won > 0.0)
                .count() as f64
                / second_half.len() as f64
        };
        let rate_delta = second_half_rate - first_half_rate;
        health.push(EntityHealth {
            entity_name: comparisons
                .first()
                .map(|(entity_name, _, _)| entity_name.clone())
                .unwrap_or_else(|| entity_id.clone()),
            entity_id,
            comparison_count: comparisons.len(),
            win_rate: wins as f64 / comparisons.len() as f64,
            avg_margin,
            trend: if rate_delta > 0.1 {
                "improving"
            } else if rate_delta < -0.1 {
                "declining"
            } else {
                "stable"
            }
            .to_string(),
        });
    }
    health.sort_by(|a, b| {
        b.win_rate
            .partial_cmp(&a.win_rate)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.comparison_count.cmp(&a.comparison_count))
    });
    Ok(health)
}

pub fn propagate_memory_status(
    conn: &rusqlite::Connection,
    agent_id: &str,
) -> rusqlite::Result<usize> {
    let ids = conn
        .prepare_cached(
            "SELECT id
             FROM entity_attributes
             WHERE agent_id = ?1
               AND status = 'active'
               AND memory_id IS NOT NULL
               AND memory_id NOT IN (SELECT id FROM memories WHERE is_deleted = 0)",
        )?
        .query_map([agent_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if ids.is_empty() {
        return Ok(0);
    }

    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "UPDATE entity_attributes
         SET status = 'superseded', updated_at = ?
         WHERE id IN ({placeholders}) AND agent_id = ?"
    );
    let ts = now();
    let mut params: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(ts)];
    params.extend(ids.iter().cloned().map(rusqlite::types::Value::Text));
    params.push(rusqlite::types::Value::Text(agent_id.to_string()));
    conn.execute(&sql, rusqlite::params_from_iter(params))?;
    Ok(ids.len())
}

pub fn parse_feedback_path_map(raw: Option<&Value>) -> HashMap<String, FeedbackPath> {
    let Some(obj) = raw.and_then(Value::as_object) else {
        return HashMap::new();
    };
    obj.iter()
        .filter(|(id, _)| !id.is_empty())
        .filter_map(|(id, value)| normalize_feedback_path(value).map(|path| (id.clone(), path)))
        .collect()
}

pub fn parse_feedback_reward_map(raw: Option<&Value>) -> HashMap<String, FeedbackReward> {
    let Some(obj) = raw.and_then(Value::as_object) else {
        return HashMap::new();
    };
    obj.iter()
        .filter(|(id, _)| !id.is_empty())
        .map(|(id, value)| (id.clone(), normalize_feedback_reward(Some(value))))
        .collect()
}

pub fn normalize_feedback_path(value: &Value) -> Option<FeedbackPath> {
    let obj = value.as_object()?;
    let entity_ids = unique_string_ids(
        obj.get("entity_ids")
            .or_else(|| obj.get("entityIds"))
            .unwrap_or(&Value::Null),
    );
    let aspect_ids = unique_string_ids(
        obj.get("aspect_ids")
            .or_else(|| obj.get("aspectIds"))
            .unwrap_or(&Value::Null),
    );
    let dependency_ids = unique_string_ids(
        obj.get("dependency_ids")
            .or_else(|| obj.get("dependencyIds"))
            .unwrap_or(&Value::Null),
    );
    if entity_ids.is_empty() && aspect_ids.is_empty() && dependency_ids.is_empty() {
        return None;
    }
    Some(FeedbackPath {
        entity_ids,
        aspect_ids,
        dependency_ids,
    })
}

fn unique_string_ids(value: &Value) -> Vec<String> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for item in items {
        if let Some(id) = item.as_str().filter(|id| !id.is_empty()) {
            let id = id.to_string();
            if seen.insert(id.clone()) {
                output.push(id);
            }
        }
    }
    output
}

pub fn normalize_feedback_reward(value: Option<&Value>) -> FeedbackReward {
    let Some(obj) = value.and_then(Value::as_object) else {
        return FeedbackReward::default();
    };
    FeedbackReward {
        forward_citation: reward_fraction(
            obj.get("forward_citation")
                .or_else(|| obj.get("forwardCitation")),
        ),
        update_after_retrieval: reward_fraction(
            obj.get("update_after_retrieval")
                .or_else(|| obj.get("updateAfterRetrieval")),
        ),
        downstream_creation: reward_fraction(
            obj.get("downstream_creation")
                .or_else(|| obj.get("downstreamCreation")),
        ),
        dead_end: reward_fraction(obj.get("dead_end").or_else(|| obj.get("deadEnd"))),
    }
}

fn reward_fraction(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Bool(false)) => 0.0,
        Some(Value::Number(value)) => value.as_f64().unwrap_or(0.0).clamp(0.0, 1.0),
        _ => 0.0,
    }
}

fn reward_score(reward: &FeedbackReward) -> f64 {
    reward.forward_citation + reward.update_after_retrieval * 0.5 + reward.downstream_creation * 0.6
        - reward.dead_end * 0.15
}

fn path_json(path: &FeedbackPath) -> String {
    serde_json::to_string(&serde_json::json!({
        "entity_ids": path.entity_ids,
        "aspect_ids": path.aspect_ids,
        "dependency_ids": path.dependency_ids,
    }))
    .unwrap_or_else(|_| "{}".to_string())
}

fn path_hash(path: &FeedbackPath) -> String {
    sha1_hex(path_json(path).as_bytes())
}

pub fn record_path_feedback(
    conn: &rusqlite::Connection,
    input: RecordPathFeedbackInput,
) -> rusqlite::Result<PathFeedbackResult> {
    let path_by_id = parse_feedback_path_map(input.paths.as_ref());
    let reward_by_id = parse_feedback_reward_map(input.rewards.as_ref());
    let cfg = PathFeedbackConfig {
        max_aspect_weight: input.max_aspect_weight.unwrap_or(1.0),
        min_aspect_weight: input.min_aspect_weight.unwrap_or(0.1),
        ..PathFeedbackConfig::default()
    };
    record_path_feedback_with_maps(
        conn,
        &input.session_key,
        &input.agent_id,
        &input.ratings,
        &path_by_id,
        &reward_by_id,
        &cfg,
    )
}

pub fn record_path_feedback_with_maps(
    conn: &rusqlite::Connection,
    session_key: &str,
    agent_id: &str,
    ratings: &HashMap<String, f64>,
    path_by_id: &HashMap<String, FeedbackPath>,
    reward_by_id: &HashMap<String, FeedbackReward>,
    cfg: &PathFeedbackConfig,
) -> rusqlite::Result<PathFeedbackResult> {
    let ts = now();
    record_session_feedback(conn, session_key, agent_id, ratings)?;
    let session_data = load_feedback_session_data(conn, session_key, agent_id, ratings.keys())?;
    conn.execute(
        "INSERT OR IGNORE INTO path_feedback_sessions (agent_id, session_key, created_at)
         VALUES (?1, ?2, ?3)",
        params![agent_id, session_key, ts],
    )?;

    let mut result = PathFeedbackResult::default();
    let mut entity_set = BTreeSet::new();

    for (memory_id, rating_raw) in ratings {
        if !session_data.session_ids.contains(memory_id) {
            continue;
        }
        result.accepted += 1;
        let rating = rating_raw.clamp(-1.0, 1.0);
        let Some(path) = path_by_id
            .get(memory_id)
            .cloned()
            .or_else(|| session_data.paths.get(memory_id).cloned())
            .or_else(|| {
                infer_feedback_path(conn, memory_id, agent_id)
                    .ok()
                    .flatten()
            })
        else {
            continue;
        };
        let reward = reward_by_id.get(memory_id).cloned().unwrap_or_default();
        let score = reward_score(&reward);
        let hash = path_hash(&path);
        let path_json = path_json(&path);
        conn.execute(
            "INSERT INTO path_feedback_events
             (id, agent_id, session_key, memory_id, path_hash, path_json, rating,
              reward, reward_forward, reward_update, reward_downstream, reward_dead_end, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                uuid::Uuid::new_v4().to_string(),
                agent_id,
                session_key,
                memory_id,
                hash,
                path_json,
                rating,
                score,
                reward.forward_citation,
                reward.update_after_retrieval,
                reward.downstream_creation,
                reward.dead_end,
                ts,
            ],
        )?;
        upsert_path_feedback_stats(conn, agent_id, &hash, &path, rating, score, cfg, &ts)?;
        update_feedback_aspects(conn, agent_id, &path, rating, cfg, &ts)?;
        result.dependencies_updated +=
            update_feedback_dependencies(conn, agent_id, &path, rating, cfg, &ts)?;
        result.propagated += 1;
        if rating > 0.0 {
            entity_set.extend(path.entity_ids.iter().cloned());
        }
    }

    let entities = entity_set.into_iter().collect::<Vec<_>>();
    if !entities.is_empty() {
        update_entity_retrieval_stats(conn, agent_id, session_key, &entities, &ts)?;
    }
    let pairs = entity_pairs(&entities);
    if !pairs.is_empty() {
        update_entity_pair_stats(conn, agent_id, session_key, &pairs, &ts)?;
    }
    let total_sessions = feedback_session_count(conn, agent_id)?;
    for (source, target) in pairs {
        let promoted = maybe_promote_feedback_pair(
            conn,
            agent_id,
            &source,
            &target,
            total_sessions,
            cfg,
            &ts,
        )?;
        if promoted > 0 {
            result.cooccurrence_updated += 1;
            result.dependencies_updated += promoted;
        }
    }

    Ok(result)
}

fn record_session_feedback(
    conn: &rusqlite::Connection,
    session_key: &str,
    agent_id: &str,
    ratings: &HashMap<String, f64>,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare_cached(
        "UPDATE session_memories
         SET agent_relevance_score = CASE
                 WHEN agent_relevance_score IS NULL THEN ?1
                 ELSE (agent_relevance_score * agent_feedback_count + ?1) / (agent_feedback_count + 1)
             END,
             agent_feedback_count = COALESCE(agent_feedback_count, 0) + 1
         WHERE session_key = ?2 AND memory_id = ?3 AND agent_id = ?4",
    )?;
    for (memory_id, score) in ratings {
        stmt.execute(params![score, session_key, memory_id, agent_id])?;
    }
    Ok(())
}

struct FeedbackSessionData {
    session_ids: HashSet<String>,
    paths: HashMap<String, FeedbackPath>,
}

fn load_feedback_session_data<'a>(
    conn: &rusqlite::Connection,
    session_key: &str,
    agent_id: &str,
    memory_ids: impl Iterator<Item = &'a String>,
) -> rusqlite::Result<FeedbackSessionData> {
    let ids = memory_ids.cloned().collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(FeedbackSessionData {
            session_ids: HashSet::new(),
            paths: HashMap::new(),
        });
    }
    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT memory_id, path_json
         FROM session_memories
         WHERE session_key = ?
           AND agent_id = ?
           AND memory_id IN ({placeholders})"
    );
    let mut params = vec![
        rusqlite::types::Value::Text(session_key.to_string()),
        rusqlite::types::Value::Text(agent_id.to_string()),
    ];
    params.extend(ids.iter().cloned().map(rusqlite::types::Value::Text));
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(params))?;
    let mut session_ids = HashSet::new();
    let mut paths = HashMap::new();
    while let Some(row) = rows.next()? {
        let memory_id: String = row.get(0)?;
        let path_json: Option<String> = row.get(1)?;
        session_ids.insert(memory_id.clone());
        if let Some(path) = path_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|value| normalize_feedback_path(&value))
        {
            paths.insert(memory_id, path);
        }
    }
    Ok(FeedbackSessionData { session_ids, paths })
}

fn infer_feedback_path(
    conn: &rusqlite::Connection,
    memory_id: &str,
    agent_id: &str,
) -> rusqlite::Result<Option<FeedbackPath>> {
    let rows = conn
        .prepare_cached(
            "SELECT asp.entity_id, ea.aspect_id
             FROM entity_attributes ea
             JOIN entity_aspects asp ON asp.id = ea.aspect_id
             WHERE ea.memory_id = ?1
               AND ea.agent_id = ?2
               AND ea.status = 'active'
             ORDER BY ea.importance DESC
             LIMIT 5",
        )?
        .query_map(params![memory_id, agent_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.is_empty() {
        return Ok(None);
    }
    Ok(Some(FeedbackPath {
        entity_ids: rows
            .iter()
            .map(|(entity_id, _)| entity_id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        aspect_ids: rows
            .iter()
            .map(|(_, aspect_id)| aspect_id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        dependency_ids: Vec::new(),
    }))
}

fn upsert_path_feedback_stats(
    conn: &rusqlite::Connection,
    agent_id: &str,
    hash: &str,
    path: &FeedbackPath,
    rating: f64,
    reward: f64,
    cfg: &PathFeedbackConfig,
    ts: &str,
) -> rusqlite::Result<()> {
    let positive = i64::from(rating > 0.0);
    let negative = i64::from(rating < 0.0);
    let neutral = i64::from(rating == 0.0);
    conn.execute(
        "INSERT INTO path_feedback_stats
         (agent_id, path_hash, path_json, q_value, sample_count,
          positive_count, negative_count, neutral_count, updated_at, created_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(agent_id, path_hash) DO UPDATE SET
          path_json = excluded.path_json,
          q_value = path_feedback_stats.q_value + (?4 - path_feedback_stats.q_value) * ?9,
          sample_count = path_feedback_stats.sample_count + 1,
          positive_count = path_feedback_stats.positive_count + ?5,
          negative_count = path_feedback_stats.negative_count + ?6,
          neutral_count = path_feedback_stats.neutral_count + ?7,
          updated_at = excluded.updated_at",
        params![
            agent_id,
            hash,
            path_json(path),
            reward,
            positive,
            negative,
            neutral,
            ts,
            cfg.q_alpha,
        ],
    )?;
    Ok(())
}

fn update_feedback_aspects(
    conn: &rusqlite::Connection,
    agent_id: &str,
    path: &FeedbackPath,
    rating: f64,
    cfg: &PathFeedbackConfig,
    ts: &str,
) -> rusqlite::Result<()> {
    if rating == 0.0 || path.aspect_ids.is_empty() {
        return Ok(());
    }
    let delta = cfg.aspect_delta * rating.abs() * if rating > 0.0 { 1.0 } else { -1.0 };
    let mut stmt = conn.prepare_cached(
        "UPDATE entity_aspects
         SET weight = MIN(?1, MAX(?2, weight + ?3)),
             updated_at = ?4
         WHERE id = ?5 AND agent_id = ?6",
    )?;
    for aspect_id in &path.aspect_ids {
        stmt.execute(params![
            cfg.max_aspect_weight,
            cfg.min_aspect_weight,
            delta,
            ts,
            aspect_id,
            agent_id,
        ])?;
    }
    Ok(())
}

fn update_feedback_dependencies(
    conn: &rusqlite::Connection,
    agent_id: &str,
    path: &FeedbackPath,
    rating: f64,
    cfg: &PathFeedbackConfig,
    ts: &str,
) -> rusqlite::Result<i64> {
    if rating == 0.0 || path.dependency_ids.is_empty() {
        return Ok(0);
    }
    let mut count = 0_i64;
    let mut select = conn.prepare_cached(
        "SELECT strength, confidence, reason
         FROM entity_dependencies
         WHERE id = ?1 AND agent_id = ?2
         LIMIT 1",
    )?;
    let mut update = conn.prepare_cached(
        "UPDATE entity_dependencies
         SET strength = ?1,
             confidence = ?2,
             reason = ?3,
             updated_at = ?4
         WHERE id = ?5 AND agent_id = ?6",
    )?;
    for dependency_id in &path.dependency_ids {
        let row = select
            .query_row(params![dependency_id, agent_id], |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, Option<f64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .optional()?;
        let Some((strength, confidence, reason)) = row else {
            continue;
        };
        let mag = rating.abs();
        let next_reason = next_dependency_reason(reason.as_deref(), rating);
        let base_confidence = reason_confidence(next_reason.as_deref());
        let next_strength = if rating > 0.0 {
            (strength + cfg.edge_delta * mag).clamp(cfg.min_edge_strength, 1.0)
        } else {
            (strength - cfg.edge_delta * mag).clamp(cfg.min_edge_strength, 1.0)
        };
        let current_confidence = confidence.unwrap_or(0.5);
        let next_confidence = if rating > 0.0 {
            (current_confidence + cfg.confidence_delta * mag)
                .max(base_confidence)
                .clamp(cfg.min_confidence, 1.0)
        } else {
            (current_confidence - cfg.confidence_delta * mag)
                .min(base_confidence)
                .clamp(cfg.min_confidence, 1.0)
        };
        update.execute(params![
            next_strength,
            next_confidence,
            next_reason,
            ts,
            dependency_id,
            agent_id,
        ])?;
        count += 1;
    }
    Ok(count)
}

fn reason_confidence(reason: Option<&str>) -> f64 {
    match reason {
        Some("user-asserted") => 1.0,
        Some("multi-memory") => 0.9,
        Some("single-memory") => 0.7,
        Some("pattern-matched") => 0.5,
        Some("inferred") => 0.4,
        Some("llm-uncertain") => 0.3,
        _ => 0.7,
    }
}

fn next_dependency_reason(reason: Option<&str>, rating: f64) -> Option<String> {
    if rating > 0.0 {
        return Some(
            match reason {
                None | Some("llm-uncertain") => "single-memory",
                Some("single-memory") => "pattern-matched",
                Some("pattern-matched") => "multi-memory",
                Some(other) => other,
            }
            .to_string(),
        );
    }
    if rating < 0.0 {
        return Some(
            match reason {
                None => "llm-uncertain",
                Some("multi-memory") => "pattern-matched",
                Some("pattern-matched") => "single-memory",
                Some("single-memory") => "llm-uncertain",
                Some(other) => other,
            }
            .to_string(),
        );
    }
    reason.map(ToOwned::to_owned)
}

fn update_entity_retrieval_stats(
    conn: &rusqlite::Connection,
    agent_id: &str,
    session_key: &str,
    entity_ids: &[String],
    ts: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO entity_retrieval_stats
         (agent_id, entity_id, session_count, last_session_key, updated_at, created_at)
         VALUES (?1, ?2, 1, ?3, ?4, ?4)
         ON CONFLICT(agent_id, entity_id) DO UPDATE SET
          session_count = CASE
            WHEN entity_retrieval_stats.last_session_key = excluded.last_session_key
              THEN entity_retrieval_stats.session_count
            ELSE entity_retrieval_stats.session_count + 1
          END,
          last_session_key = excluded.last_session_key,
          updated_at = excluded.updated_at",
    )?;
    for entity_id in entity_ids {
        stmt.execute(params![agent_id, entity_id, session_key, ts])?;
    }
    Ok(())
}

fn entity_pairs(entities: &[String]) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for (index, source) in entities.iter().enumerate() {
        for target in entities.iter().skip(index + 1) {
            if source < target {
                pairs.push((source.clone(), target.clone()));
            } else {
                pairs.push((target.clone(), source.clone()));
            }
        }
    }
    pairs.sort();
    pairs.dedup();
    pairs
}

fn update_entity_pair_stats(
    conn: &rusqlite::Connection,
    agent_id: &str,
    session_key: &str,
    pairs: &[(String, String)],
    ts: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO entity_cooccurrence
         (agent_id, source_entity_id, target_entity_id, session_count, last_session_key, updated_at, created_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5)
         ON CONFLICT(agent_id, source_entity_id, target_entity_id) DO UPDATE SET
          session_count = CASE
            WHEN entity_cooccurrence.last_session_key = excluded.last_session_key
              THEN entity_cooccurrence.session_count
            ELSE entity_cooccurrence.session_count + 1
          END,
          last_session_key = excluded.last_session_key,
          updated_at = excluded.updated_at",
    )?;
    for (source, target) in pairs {
        stmt.execute(params![agent_id, source, target, session_key, ts])?;
    }
    Ok(())
}

fn feedback_session_count(conn: &rusqlite::Connection, agent_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM path_feedback_sessions WHERE agent_id = ?1",
        [agent_id],
        |row| row.get::<_, i64>(0),
    )
}

fn maybe_promote_feedback_pair(
    conn: &rusqlite::Connection,
    agent_id: &str,
    source: &str,
    target: &str,
    total_sessions: i64,
    cfg: &PathFeedbackConfig,
    ts: &str,
) -> rusqlite::Result<i64> {
    Ok(i64::from(maybe_promote_feedback_directed(
        conn,
        agent_id,
        source,
        target,
        source,
        target,
        total_sessions,
        cfg,
        ts,
    )?) + i64::from(maybe_promote_feedback_directed(
        conn,
        agent_id,
        source,
        target,
        target,
        source,
        total_sessions,
        cfg,
        ts,
    )?))
}

#[allow(clippy::too_many_arguments)]
fn maybe_promote_feedback_directed(
    conn: &rusqlite::Connection,
    agent_id: &str,
    pair_source: &str,
    pair_target: &str,
    edge_source: &str,
    edge_target: &str,
    total_sessions: i64,
    cfg: &PathFeedbackConfig,
    ts: &str,
) -> rusqlite::Result<bool> {
    if total_sessions <= 1 {
        return Ok(false);
    }
    let co = conn
        .query_row(
            "SELECT session_count
             FROM entity_cooccurrence
             WHERE agent_id = ?1 AND source_entity_id = ?2 AND target_entity_id = ?3",
            params![agent_id, pair_source, pair_target],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0);
    let source_count = retrieval_count(conn, agent_id, edge_source)?;
    let target_count = retrieval_count(conn, agent_id, edge_target)?;
    if co < cfg.min_co_sessions || source_count == 0 || target_count == 0 {
        return Ok(false);
    }
    let pxy = co as f64 / total_sessions as f64;
    let px = source_count as f64 / total_sessions as f64;
    let py = target_count as f64 / total_sessions as f64;
    if pxy <= 0.0 || px <= 0.0 || py <= 0.0 {
        return Ok(false);
    }
    let npmi = if pxy >= 1.0 {
        1.0
    } else {
        (pxy / (px * py)).ln() / -pxy.ln()
    };
    if !npmi.is_finite() || npmi < cfg.npmi_threshold {
        return Ok(false);
    }
    let strength = (0.3 + npmi * 0.5).clamp(0.3, 0.9);
    let existing = conn
        .query_row(
            "SELECT id, strength, confidence
             FROM entity_dependencies
             WHERE agent_id = ?1
               AND source_entity_id = ?2
               AND target_entity_id = ?3
               AND dependency_type = 'related_to'
             LIMIT 1",
            params![agent_id, edge_source, edge_target],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, Option<f64>>(2)?.unwrap_or(0.5),
                ))
            },
        )
        .optional()?;
    if let Some((id, existing_strength, existing_confidence)) = existing {
        conn.execute(
            "UPDATE entity_dependencies
             SET strength = ?1,
                 confidence = ?2,
                 reason = 'pattern-matched',
                 updated_at = ?3
             WHERE id = ?4 AND agent_id = ?5",
            params![
                existing_strength.max(strength),
                existing_confidence.max(0.5),
                ts,
                id,
                agent_id,
            ],
        )?;
        return Ok(true);
    }
    if count_auto_feedback_edges(conn, agent_id, edge_source)? >= cfg.auto_edge_cap {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO entity_dependencies
         (id, source_entity_id, target_entity_id, agent_id, aspect_id,
          dependency_type, strength, confidence, reason, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, 'related_to', ?5, 0.5, 'pattern-matched', ?6, ?6)",
        params![
            uuid::Uuid::new_v4().to_string(),
            edge_source,
            edge_target,
            agent_id,
            strength,
            ts,
        ],
    )?;
    Ok(true)
}

fn retrieval_count(
    conn: &rusqlite::Connection,
    agent_id: &str,
    entity_id: &str,
) -> rusqlite::Result<i64> {
    Ok(conn
        .query_row(
            "SELECT session_count
             FROM entity_retrieval_stats
             WHERE agent_id = ?1 AND entity_id = ?2",
            params![agent_id, entity_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0))
}

fn count_auto_feedback_edges(
    conn: &rusqlite::Connection,
    agent_id: &str,
    source: &str,
) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*)
         FROM entity_dependencies
         WHERE agent_id = ?1
           AND source_entity_id = ?2
           AND dependency_type = 'related_to'
           AND reason = 'pattern-matched'",
        params![agent_id, source],
        |row| row.get::<_, i64>(0),
    )
}

pub fn apply_fts_overlap_feedback(
    conn: &rusqlite::Connection,
    session_key: &str,
    agent_id: &str,
    delta: f64,
    min_weight: f64,
    max_weight: f64,
) -> rusqlite::Result<AspectFeedbackResult> {
    let confirmed_rows = conn
        .prepare_cached(
            "SELECT memory_id, fts_hit_count
             FROM session_memories
             WHERE session_key = ?1 AND fts_hit_count > 0",
        )?
        .query_map([session_key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if confirmed_rows.is_empty() {
        return Ok(AspectFeedbackResult::default());
    }

    let mut aspect_confirmations: HashMap<String, i64> = HashMap::new();
    let mut total_fts_confirmations = 0_i64;
    let mut lookup = conn.prepare_cached(
        "SELECT aspect_id
         FROM entity_attributes
         WHERE memory_id = ?1
           AND agent_id = ?2
           AND status = 'active'
         LIMIT 1",
    )?;
    for (memory_id, confirmations) in confirmed_rows {
        if confirmations <= 0 {
            continue;
        }
        let aspect_id = lookup
            .query_row(params![memory_id, agent_id], |row| row.get::<_, String>(0))
            .optional()?;
        let Some(aspect_id) = aspect_id else {
            continue;
        };
        *aspect_confirmations.entry(aspect_id).or_default() += confirmations;
        total_fts_confirmations += confirmations;
    }

    if aspect_confirmations.is_empty() {
        return Ok(AspectFeedbackResult {
            aspects_updated: 0,
            total_fts_confirmations,
        });
    }

    let ts = now();
    let mut aspects_updated = 0_i64;
    for (aspect_id, confirmations) in aspect_confirmations {
        let current_weight = conn
            .query_row(
                "SELECT weight FROM entity_aspects WHERE id = ?1 AND agent_id = ?2",
                params![aspect_id, agent_id],
                |row| row.get::<_, f64>(0),
            )
            .optional()?;
        let Some(current_weight) = current_weight else {
            continue;
        };
        conn.execute(
            "UPDATE entity_aspects
             SET weight = ?1, updated_at = ?2
             WHERE id = ?3 AND agent_id = ?4",
            params![
                (current_weight + delta * confirmations as f64).clamp(min_weight, max_weight),
                ts,
                aspect_id,
                agent_id,
            ],
        )?;
        aspects_updated += 1;
    }

    Ok(AspectFeedbackResult {
        aspects_updated,
        total_fts_confirmations,
    })
}

pub fn decay_aspect_weights(
    conn: &rusqlite::Connection,
    agent_id: &str,
    decay_rate: f64,
    min_weight: f64,
    stale_days: i64,
) -> rusqlite::Result<i64> {
    let modifier = format!("-{stale_days} days");
    let stale_rows = conn
        .prepare_cached(
            "SELECT id, weight
             FROM entity_aspects
             WHERE agent_id = ?1
               AND updated_at < datetime('now', ?2)
               AND weight > ?3",
        )?
        .query_map(params![agent_id, modifier, min_weight], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if stale_rows.is_empty() {
        return Ok(0);
    }

    let ts = now();
    let mut count = 0_i64;
    for (aspect_id, weight) in stale_rows {
        conn.execute(
            "UPDATE entity_aspects
             SET weight = ?1, updated_at = ?2
             WHERE id = ?3 AND agent_id = ?4",
            params![min_weight.max(weight - decay_rate), ts, aspect_id, agent_id],
        )?;
        count += 1;
    }
    Ok(count)
}

fn sha1_hex(input: &[u8]) -> String {
    let digest = sha1_digest(input);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha1_digest(input: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x6745_2301;
    let mut h1: u32 = 0xefcd_ab89;
    let mut h2: u32 = 0x98ba_dcfe;
    let mut h3: u32 = 0x1032_5476;
    let mut h4: u32 = 0xc3d2_e1f0;

    let bit_len = (input.len() as u64) * 8;
    let mut data = input.to_vec();
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in data.chunks_exact(64) {
        let mut words = [0_u32; 80];
        for (i, word) in words.iter_mut().take(16).enumerate() {
            let start = i * 4;
            *word = u32::from_be_bytes([
                chunk[start],
                chunk[start + 1],
                chunk[start + 2],
                chunk[start + 3],
            ]);
        }
        for i in 16..80 {
            words[i] = (words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16]).rotate_left(1);
        }

        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;
        let mut e = h4;

        for (i, word) in words.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5a82_7999),
                20..=39 => (b ^ c ^ d, 0x6ed9_eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1b_bcdc),
                _ => (b ^ c ^ d, 0xca62_c1d6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }

        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut output = [0_u8; 20];
    for (offset, value) in [h0, h1, h2, h3, h4].into_iter().enumerate() {
        output[offset * 4..offset * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
    output
}
