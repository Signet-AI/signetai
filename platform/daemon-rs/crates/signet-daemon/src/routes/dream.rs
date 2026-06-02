use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::state::AppState;

fn dream_agent_id(query: &HashMap<String, String>, body_agent_id: Option<&str>) -> String {
    body_agent_id
        .or_else(|| query.get("agentId").map(String::as_str))
        .or_else(|| query.get("agent_id").map(String::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default")
        .to_string()
}

fn dreaming_state(conn: &rusqlite::Connection, agent_id: &str) -> rusqlite::Result<Value> {
    let row = conn
        .query_row(
            "SELECT tokens_since_last_pass, consecutive_failures,
                    last_pass_at, last_pass_id, last_pass_mode
             FROM dreaming_state
             WHERE agent_id = ?1",
            [agent_id],
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
        Some((tokens, failures, last_pass_at, last_pass_id, last_pass_mode)) => json!({
            "tokensSinceLastPass": tokens,
            "consecutiveFailures": failures,
            "lastPassAt": last_pass_at,
            "lastPassId": last_pass_id,
            "lastPassMode": last_pass_mode,
        }),
        None => json!({
            "tokensSinceLastPass": 0,
            "consecutiveFailures": 0,
            "lastPassAt": null,
            "lastPassId": null,
            "lastPassMode": null,
        }),
    })
}

fn dreaming_passes(conn: &rusqlite::Connection, agent_id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT id, mode, status, started_at, completed_at, tokens_consumed,
                mutations_applied, mutations_skipped, mutations_failed, summary, error
         FROM dreaming_passes
         WHERE agent_id = ?1
         ORDER BY created_at DESC
         LIMIT 10",
    )?;
    let rows = stmt.query_map([agent_id], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "mode": row.get::<_, String>(1)?,
            "status": row.get::<_, String>(2)?,
            "startedAt": row.get::<_, String>(3)?,
            "completedAt": row.get::<_, Option<String>>(4)?,
            "tokensConsumed": row.get::<_, Option<i64>>(5)?,
            "mutationsApplied": row.get::<_, Option<i64>>(6)?,
            "mutationsSkipped": row.get::<_, Option<i64>>(7)?,
            "mutationsFailed": row.get::<_, Option<i64>>(8)?,
            "summary": row.get::<_, Option<String>>(9)?,
            "error": row.get::<_, Option<String>>(10)?,
        }))
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub async fn status(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let agent_id = dream_agent_id(&query, None);
    match state
        .pool
        .read(move |conn| {
            Ok(json!({
                "enabled": false,
                "worker": {
                    "running": false,
                    "active": false,
                    "activeAgentId": null,
                },
                "state": dreaming_state(conn, &agent_id)?,
                "config": {
                    "tokenThreshold": 100000,
                    "backfillOnFirstRun": true,
                    "maxInputTokens": 128000,
                    "maxOutputTokens": 16000,
                    "timeout": 300000,
                },
                "passes": dreaming_passes(conn, &agent_id)?,
            }))
        })
        .await
    {
        Ok(body) => Json(body).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

pub async fn trigger() -> impl IntoResponse {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "error": "Dreaming worker not running" })),
    )
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct PromoteBody {
    from: Option<String>,
    apply: Option<bool>,
    actor: Option<String>,
    limit: Option<i64>,
    #[serde(rename = "useProvider")]
    use_provider_camel: Option<bool>,
    use_provider: Option<bool>,
    #[serde(rename = "agentId")]
    agent_id_camel: Option<String>,
    agent_id: Option<String>,
}

impl PromoteBody {
    fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref().or(self.agent_id_camel.as_deref())
    }

    fn use_provider(&self) -> bool {
        self.use_provider
            .or(self.use_provider_camel)
            .unwrap_or(false)
    }
}

pub async fn promote(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<PromoteBody>,
) -> impl IntoResponse {
    let agent_id = dream_agent_id(&query, body.agent_id());
    let Some(from) = body
        .from
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "from is required" })),
        )
            .into_response();
    };
    let apply = body.apply.unwrap_or(false);
    let actor = body
        .actor
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("dreaming-promote")
        .to_string();
    let limit = body.limit.unwrap_or(50).clamp(1, 500) as usize;
    let use_provider = body.use_provider();

    match state
        .pool
        .write(signet_core::db::Priority::High, move |conn| {
            promote_memory_preferences(conn, &agent_id, &from, apply, &actor, limit, use_provider)
                .map_err(signet_core::error::CoreError::Migration)
        })
        .await
    {
        Ok(body) => Json(body).into_response(),
        Err(error) if error.to_string().contains("source not found") => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Dream promotion source not found" })),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Clone)]
struct DreamSource {
    id: String,
    content: String,
    project: Option<String>,
    captured_at: String,
    confidence: Option<f64>,
}

fn promote_memory_preferences(
    conn: &rusqlite::Connection,
    agent_id: &str,
    from: &str,
    apply: bool,
    actor: &str,
    limit: usize,
    use_provider: bool,
) -> Result<Value, String> {
    let sources = read_memory_sources(conn, agent_id, from, limit)?;
    let mut operations = Vec::new();
    for source in &sources {
        operations.extend(mechanical_preference_operations(source));
    }
    operations.truncate(limit);
    let applied_count = if apply {
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| err.to_string())?;
        let mut count = 0;
        for operation in &operations {
            apply_preference_operation(&tx, agent_id, operation, actor)?;
            count += 1;
        }
        tx.commit().map_err(|err| err.to_string())?;
        count
    } else {
        0
    };
    let mut warnings = Vec::new();
    if use_provider {
        warnings.push(
            "Provider promotion requested but native Rust provider promotion is not configured.",
        );
    }
    let skipped = if operations.is_empty() && !sources.is_empty() {
        vec!["No explicit high-confidence attribute promotions found."]
    } else {
        Vec::new()
    };
    Ok(json!({
        "sources": sources.iter().map(source_info).collect::<Vec<_>>(),
        "operations": operations.iter().map(|operation| operation.json.clone()).collect::<Vec<_>>(),
        "applied": if applied_count > 0 {
            json!({
                "success": true,
                "count": applied_count,
                "applied": applied_count,
                "errors": [],
                "dryRun": !apply
            })
        } else {
            Value::Null
        },
        "count": operations.len(),
        "appliedCount": applied_count,
        "skipped": skipped,
        "questions": Vec::<String>::new(),
        "warnings": warnings,
        "dryRun": !apply,
        "providerName": Value::Null,
    }))
}

fn read_memory_sources(
    conn: &rusqlite::Connection,
    agent_id: &str,
    from: &str,
    limit: usize,
) -> Result<Vec<DreamSource>, String> {
    if from == "all" || from == "memories:recent" {
        let mut stmt = conn
            .prepare(
                "SELECT id, content, project, confidence, created_at, updated_at
                 FROM memories
                 WHERE agent_id = ?1 AND COALESCE(is_deleted, 0) = 0
                 ORDER BY updated_at DESC, created_at DESC
                 LIMIT ?2",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![agent_id, limit as i64], dream_source_row)
            .map_err(|err| err.to_string())?;
        return Ok(rows.filter_map(Result::ok).collect());
    }

    let candidates = source_id_candidates(from);
    let placeholders = std::iter::repeat_n("?", candidates.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT id, content, project, confidence, created_at, updated_at
         FROM memories
         WHERE agent_id = ? AND COALESCE(is_deleted, 0) = 0 AND id IN ({placeholders})
         ORDER BY updated_at DESC
         LIMIT 1"
    );
    let mut values: Vec<&dyn rusqlite::ToSql> = vec![&agent_id];
    for candidate in &candidates {
        values.push(candidate);
    }
    let source = conn
        .query_row(&sql, rusqlite::params_from_iter(values), dream_source_row)
        .optional()
        .map_err(|err| err.to_string())?;
    source
        .map(|source| vec![source])
        .ok_or_else(|| "source not found".to_string())
}

fn dream_source_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DreamSource> {
    Ok(DreamSource {
        id: row.get(0)?,
        content: row.get(1)?,
        project: row.get(2)?,
        confidence: row.get(3)?,
        captured_at: row
            .get::<_, Option<String>>(5)?
            .or(row.get::<_, Option<String>>(4)?)
            .unwrap_or_default(),
    })
}

fn source_id_candidates(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    let stripped = trimmed
        .strip_prefix("memory:")
        .or_else(|| trimmed.strip_prefix("artifact:"))
        .or_else(|| trimmed.strip_prefix("source:"))
        .or_else(|| trimmed.strip_prefix("transcript:"))
        .or_else(|| trimmed.strip_prefix("session:"))
        .unwrap_or(trimmed);
    let mut values = Vec::new();
    for candidate in [
        trimmed.to_string(),
        stripped.to_string(),
        format!("memory:{stripped}"),
        format!("artifact:{stripped}"),
        format!("transcript:{stripped}"),
        format!("session:{stripped}"),
    ] {
        if !candidate.is_empty() && !values.contains(&candidate) {
            values.push(candidate);
        }
    }
    values
}

fn source_info(source: &DreamSource) -> Value {
    json!({
        "kind": "memory",
        "id": source.id,
        "sourceKind": "memory",
        "sourceId": source.id,
        "sourcePath": Value::Null,
        "project": source.project,
        "harness": Value::Null,
        "capturedAt": source.captured_at,
    })
}

#[derive(Clone)]
struct PreferenceOperation {
    entity: String,
    aspect: String,
    group_key: String,
    claim_key: String,
    value: String,
    confidence: f64,
    source_id: String,
    source_quote: String,
    json: Value,
}

fn mechanical_preference_operations(source: &DreamSource) -> Vec<PreferenceOperation> {
    let Some(confidence) = source.confidence else {
        return Vec::new();
    };
    if !(0.75..=1.0).contains(&confidence) {
        return Vec::new();
    }
    let mut seen = Vec::new();
    let mut operations = Vec::new();
    for sentence in split_sentences(&source.content) {
        let Some((entity, verb, object, context)) =
            statement_parts(sentence.trim_end_matches(['.', '!', '?']))
        else {
            continue;
        };
        let claim = context
            .as_ref()
            .map(|context| format!("{verb} {object} when {context}"))
            .unwrap_or_else(|| format!("{verb} {object}"));
        let claim_key = context
            .as_ref()
            .map(|context| {
                canonical_key(&format!("{verb} {} when {context}", claim_target(&object)))
            })
            .unwrap_or_else(|| canonical_key(&format!("{verb} {}", claim_target(&object))));
        let key = format!("{entity}:{claim_key}");
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let group_key = if context.is_some() {
            "workflow"
        } else {
            "general"
        }
        .to_string();
        let value = normalize_sentence(&format!("{entity} {claim}"));
        let json = json!({
            "operation": "set_claim_value",
            "payload": {
                "entity": entity,
                "entity_type": "person",
                "aspect": "preferences",
                "group_key": group_key,
                "claim_key": claim_key,
                "value": value,
                "kind": "attribute",
                "confidence": confidence,
            },
            "confidence": confidence,
            "reason": "Dreaming promoted an explicit user preference into an update-in-place attribute slot.",
            "evidence": [{
                "source_kind": "memory",
                "source_id": source.id,
                "source_path": Value::Null,
                "quote": sentence,
            }],
            "risk": "low",
            "sourceKind": "memory",
            "sourceId": source.id,
            "sourcePath": Value::Null,
            "sourceRoot": "memory",
            "trustedForApply": true,
        });
        operations.push(PreferenceOperation {
            entity,
            aspect: "preferences".to_string(),
            group_key,
            claim_key,
            value,
            confidence,
            source_id: source.id.clone(),
            source_quote: sentence,
            json,
        });
    }
    operations
}

fn split_sentences(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for ch in content.chars() {
        if ch == '\n' {
            if !current.trim().is_empty() {
                out.push(normalize_sentence(&current));
                current.clear();
            }
            continue;
        }
        current.push(ch);
        if matches!(ch, '.' | '!' | '?') {
            if !current.trim().is_empty() {
                out.push(normalize_sentence(&current));
                current.clear();
            }
        }
    }
    if !current.trim().is_empty() {
        out.push(normalize_sentence(&current));
    }
    out
}

fn normalize_sentence(value: &str) -> String {
    let sentence = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if sentence.ends_with(['.', '!', '?']) {
        sentence
    } else {
        format!("{sentence}.")
    }
}

fn statement_parts(sentence: &str) -> Option<(String, String, String, Option<String>)> {
    let normalized = sentence.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = normalized.to_lowercase();
    let (entity, rest) = if lower.starts_with("nicholai ") {
        ("Nicholai", &normalized["Nicholai ".len()..])
    } else if lower.starts_with("the user ") {
        ("Nicholai", &normalized["the user ".len()..])
    } else if lower.starts_with("user ") {
        ("Nicholai", &normalized["user ".len()..])
    } else {
        return None;
    };
    let rest_lower = rest.to_lowercase();
    let verb = ["prefers", "likes", "wants", "expects"]
        .into_iter()
        .find(|verb| rest_lower.starts_with(&format!("{verb} ")))?;
    let after_verb = rest[verb.len()..].trim();
    if after_verb.len() < 3 {
        return None;
    }
    let after_lower = after_verb.to_lowercase();
    let (object, context) = if let Some(idx) = after_lower.find(" when ") {
        (
            after_verb[..idx].trim().to_string(),
            Some(after_verb[idx + " when ".len()..].trim().to_string()),
        )
    } else {
        (after_verb.to_string(), None)
    };
    if object.len() < 3 {
        return None;
    }
    Some((
        entity.to_string(),
        verb.to_string(),
        object,
        context.filter(|value| !value.is_empty()),
    ))
}

fn claim_target(object: &str) -> String {
    let lower = object.to_lowercase();
    for marker in [" to be ", " as "] {
        if let Some(idx) = lower.find(marker) {
            let target = object[..idx].trim();
            if !target.is_empty() {
                return target.to_string();
            }
        }
    }
    object.trim().to_string()
}

fn canonical_key(value: &str) -> String {
    let mut out = String::new();
    let mut last_sep = false;
    for ch in value.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_sep = false;
        } else if !last_sep && !out.is_empty() {
            out.push('_');
            last_sep = true;
        }
        if out.len() >= 120 {
            break;
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    if out.is_empty() {
        "preference".to_string()
    } else {
        out
    }
}

fn apply_preference_operation(
    conn: &rusqlite::Transaction<'_>,
    agent_id: &str,
    operation: &PreferenceOperation,
    _actor: &str,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let entity_id = ensure_entity(conn, agent_id, &operation.entity, "person", &now)?;
    let aspect_id = ensure_aspect(conn, agent_id, &entity_id, &operation.aspect, &now)?;
    let previous = conn
        .query_row(
            "SELECT id, version
             FROM entity_attributes
             WHERE aspect_id = ?1 AND agent_id = ?2 AND kind = 'attribute'
               AND status = 'active' AND group_key = ?3 AND claim_key = ?4
             ORDER BY version DESC, updated_at DESC
             LIMIT 1",
            rusqlite::params![
                aspect_id,
                agent_id,
                operation.group_key,
                operation.claim_key
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    if let Some((previous_id, _)) = &previous {
        conn.execute(
            "UPDATE entity_attributes
             SET status = 'superseded', superseded_by = ?1, updated_at = ?2
             WHERE id = ?3 AND agent_id = ?4",
            rusqlite::params![id, now, previous_id, agent_id],
        )
        .map_err(|err| err.to_string())?;
    }
    let version = previous
        .as_ref()
        .map(|(_, version)| version + 1)
        .unwrap_or(1);
    let normalized = operation
        .value
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    conn.execute(
        "INSERT INTO entity_attributes
         (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
          confidence, importance, status, created_at, updated_at, group_key, claim_key,
          source_id, source_kind, source_path, source_root, proposal_evidence, version)
         VALUES (?1, ?2, ?3, ?4, 'attribute', ?5, ?6, ?7, 0.8, 'active',
                 ?8, ?8, ?9, ?10, ?4, 'memory', NULL, 'memory', ?11, ?12)",
        rusqlite::params![
            id,
            aspect_id,
            agent_id,
            operation.source_id,
            operation.value,
            normalized,
            operation.confidence,
            now,
            operation.group_key,
            operation.claim_key,
            json!([{
                "source_kind": "memory",
                "source_id": operation.source_id,
                "source_path": Value::Null,
                "quote": operation.source_quote,
            }])
            .to_string(),
            version,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn ensure_entity(
    conn: &rusqlite::Connection,
    agent_id: &str,
    name: &str,
    entity_type: &str,
    now: &str,
) -> Result<String, String> {
    let canonical = canonical_key(name);
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM entities
             WHERE name = ?1 OR (agent_id = ?2 AND canonical_name = ?3)
             ORDER BY updated_at DESC
             LIMIT 1",
            rusqlite::params![name, agent_id, canonical],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
    {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO entities
         (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
        rusqlite::params![id, name, canonical, entity_type, agent_id, now],
    )
    .map_err(|err| err.to_string())?;
    Ok(id)
}

fn ensure_aspect(
    conn: &rusqlite::Connection,
    agent_id: &str,
    entity_id: &str,
    name: &str,
    now: &str,
) -> Result<String, String> {
    let canonical = canonical_key(name);
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM entity_aspects
             WHERE entity_id = ?1 AND agent_id = ?2 AND canonical_name = ?3
             LIMIT 1",
            rusqlite::params![entity_id, agent_id, canonical],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
    {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO entity_aspects
         (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0.8, ?6, ?6)",
        rusqlite::params![id, entity_id, agent_id, name, canonical, now],
    )
    .map_err(|err| err.to_string())?;
    Ok(id)
}
