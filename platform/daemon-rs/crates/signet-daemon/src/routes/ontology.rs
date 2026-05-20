//! Native ontology proposal routes.
//!
//! This implements the TypeScript daemon's local ontology proposal loop using
//! the shared SQLite database. Expensive LLM-backed extraction/consolidation is
//! intentionally conservative, but the proposal lifecycle is now persisted,
//! filterable, and body-tested instead of being a status-only compatibility stub.

use std::{net::SocketAddr, sync::Arc};

use axum::{
    Json,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{SecondsFormat, Utc};
use rusqlite::{OptionalExtension, ToSql, types::Value};
use serde::Deserialize;
use serde_json::{Value as JsonValue, json};
use signet_core::{db::Priority, error::CoreError};
use uuid::Uuid;

use crate::{
    auth::{
        middleware::{authenticate_headers, require_permission_guard, resolve_scoped_agent},
        types::Permission,
    },
    state::AppState,
};

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProposalQuery {
    agent_id: Option<String>,
    status: Option<String>,
    operation: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProposalBody {
    agent_id: Option<String>,
    operation: Option<String>,
    payload: Option<JsonValue>,
    confidence: Option<f64>,
    rationale: Option<String>,
    evidence: Option<Vec<JsonValue>>,
    risk: Option<String>,
    source_kind: Option<String>,
    source_id: Option<String>,
    source_path: Option<String>,
    source_root: Option<String>,
    created_by: Option<String>,
    actor: Option<String>,
    reason: Option<String>,
    proposals: Option<Vec<ProposalBody>>,
    write_proposals: Option<bool>,
    limit: Option<i64>,
}

#[derive(Debug)]
struct ProposalRow {
    id: String,
    agent_id: String,
    operation: String,
    status: String,
    payload: String,
    confidence: f64,
    rationale: String,
    evidence: String,
    risk: Option<String>,
    source_kind: Option<String>,
    source_id: Option<String>,
    source_path: Option<String>,
    source_root: Option<String>,
    created_by: String,
    applied_by: Option<String>,
    rejected_by: Option<String>,
    result: Option<String>,
    created_at: String,
    updated_at: String,
    applied_at: Option<String>,
    rejected_at: Option<String>,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn clean(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn agent_id(raw: Option<String>) -> String {
    clean(raw).unwrap_or_else(|| "default".to_string())
}

fn parse_limit(raw: Option<&str>, default: i64, max: i64) -> i64 {
    raw.and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(default)
        .clamp(1, max)
}

fn parse_offset(raw: Option<&str>) -> i64 {
    raw.and_then(|v| v.parse::<i64>().ok()).unwrap_or(0).max(0)
}

fn valid_status(status: &str) -> bool {
    matches!(status, "pending" | "applied" | "rejected" | "failed")
}

fn parse_json(raw: &str, fallback: JsonValue) -> JsonValue {
    serde_json::from_str(raw).unwrap_or(fallback)
}

fn row_to_value(row: ProposalRow) -> JsonValue {
    json!({
        "id": row.id,
        "agentId": row.agent_id,
        "operation": row.operation,
        "status": row.status,
        "payload": parse_json(&row.payload, json!({})),
        "confidence": row.confidence,
        "rationale": row.rationale,
        "evidence": parse_json(&row.evidence, json!([])),
        "risk": row.risk,
        "sourceKind": row.source_kind,
        "sourceId": row.source_id,
        "sourcePath": row.source_path,
        "sourceRoot": row.source_root,
        "createdBy": row.created_by,
        "appliedBy": row.applied_by,
        "rejectedBy": row.rejected_by,
        "result": row.result.as_deref().map(|r| parse_json(r, json!({}))),
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
        "appliedAt": row.applied_at,
        "rejectedAt": row.rejected_at,
    })
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProposalRow> {
    Ok(ProposalRow {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        operation: row.get(2)?,
        status: row.get(3)?,
        payload: row.get(4)?,
        confidence: row.get(5)?,
        rationale: row.get(6)?,
        evidence: row.get(7)?,
        risk: row.get(8)?,
        source_kind: row.get(9)?,
        source_id: row.get(10)?,
        source_path: row.get(11)?,
        source_root: row.get(12)?,
        created_by: row.get(13)?,
        applied_by: row.get(14)?,
        rejected_by: row.get(15)?,
        result: row.get(16)?,
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
        applied_at: row.get(19)?,
        rejected_at: row.get(20)?,
    })
}

const SELECT_PROPOSAL: &str =
    "SELECT id, agent_id, operation, status, payload, confidence, rationale,
    evidence, risk, source_kind, source_id, source_path, source_root, created_by,
    applied_by, rejected_by, result, created_at, updated_at, applied_at, rejected_at
    FROM ontology_proposals";

fn canonical(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn read_payload_string(payload: &JsonValue, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn read_payload_f64(payload: &JsonValue, key: &str) -> Option<f64> {
    payload
        .get(key)
        .and_then(|v| v.as_f64())
        .map(|v| v.clamp(0.0, 1.0))
}

fn normalize_entity_type(raw: Option<String>) -> String {
    raw.unwrap_or_else(|| "concept".to_string())
}

fn normalize_attribute_kind(raw: Option<String>) -> String {
    match raw.as_deref() {
        Some("constraint") => "constraint".to_string(),
        Some("preference") => "preference".to_string(),
        Some("fact") | Some("claim") | Some("attribute") | None => "fact".to_string(),
        Some(other) => other.to_string(),
    }
}

fn normalize_dependency_type(raw: Option<String>) -> String {
    raw.unwrap_or_else(|| "related_to".to_string())
}

fn proposal_audit_evidence(row: &ProposalRow) -> String {
    row.evidence.clone()
}

fn resolve_entity(
    conn: &rusqlite::Connection,
    agent_id: &str,
    name: &str,
) -> Result<Option<String>, CoreError> {
    let key = canonical(name);
    Ok(conn
        .query_row(
            "SELECT id FROM entities WHERE agent_id = ?1 AND (canonical_name = ?2 OR lower(name) = ?2) LIMIT 1",
            rusqlite::params![agent_id, key],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

fn resolve_or_create_entity(
    conn: &rusqlite::Connection,
    agent_id: &str,
    name: &str,
    entity_type: &str,
) -> Result<String, CoreError> {
    if let Some(id) = resolve_entity(conn, agent_id, name)? {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    let ts = now();
    conn.execute(
        "INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)",
        rusqlite::params![id, name, canonical(name), entity_type, agent_id, ts],
    )?;
    Ok(id)
}

fn resolve_or_create_aspect(
    conn: &rusqlite::Connection,
    entity_id: &str,
    agent_id: &str,
    name: &str,
) -> Result<String, CoreError> {
    let key = canonical(name);
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM entity_aspects WHERE entity_id = ?1 AND agent_id = ?2 AND canonical_name = ?3 LIMIT 1",
            rusqlite::params![entity_id, agent_id, key],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    let ts = now();
    conn.execute(
        "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0.5, ?6, ?6)",
        rusqlite::params![id, entity_id, agent_id, name, key, ts],
    )?;
    Ok(id)
}

fn apply_create_entity(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
) -> Result<JsonValue, CoreError> {
    let name = read_payload_string(payload, "name").ok_or_else(|| rusqlite::Error::InvalidQuery)?;
    let entity_type = normalize_entity_type(read_payload_string(payload, "entity_type"));
    let entity_id = resolve_or_create_entity(conn, &row.agent_id, &name, &entity_type)?;
    Ok(json!({"entityId": entity_id, "entity": name, "applied": true}))
}

fn apply_add_claim_value(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
) -> Result<JsonValue, CoreError> {
    let entity =
        read_payload_string(payload, "entity").ok_or_else(|| rusqlite::Error::InvalidQuery)?;
    let aspect =
        read_payload_string(payload, "aspect").ok_or_else(|| rusqlite::Error::InvalidQuery)?;
    let claim_key = read_payload_string(payload, "claim_key")
        .or_else(|| read_payload_string(payload, "claim"))
        .unwrap_or_else(|| "general".to_string());
    let value = read_payload_string(payload, "value")
        .or_else(|| read_payload_string(payload, "claim"))
        .ok_or_else(|| rusqlite::Error::InvalidQuery)?;
    let entity_type = normalize_entity_type(read_payload_string(payload, "entity_type"));
    let entity_id = resolve_or_create_entity(conn, &row.agent_id, &entity, &entity_type)?;
    let aspect_id = resolve_or_create_aspect(conn, &entity_id, &row.agent_id, &aspect)?;
    let group_key =
        read_payload_string(payload, "group_key").unwrap_or_else(|| "general".to_string());
    let kind = normalize_attribute_kind(read_payload_string(payload, "kind"));
    let normalized = canonical(&value);
    if let Some(existing) = conn
        .query_row(
            "SELECT id FROM entity_attributes
             WHERE aspect_id = ?1 AND agent_id = ?2 AND kind = ?3 AND normalized_content = ?4
               AND COALESCE(group_key, 'general') = ?5 AND COALESCE(claim_key, 'general') = ?6 AND status = 'active'
             LIMIT 1",
            rusqlite::params![aspect_id, row.agent_id, kind, normalized, group_key, claim_key],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        conn.execute(
            "UPDATE entity_attributes SET proposal_id = ?1, proposal_evidence = ?2, updated_at = ?3 WHERE id = ?4 AND agent_id = ?5",
            rusqlite::params![row.id, proposal_audit_evidence(row), now(), existing, row.agent_id],
        )?;
        return Ok(json!({"entityId": entity_id, "aspectId": aspect_id, "attributeId": existing, "deduped": true, "applied": true}));
    }
    let id = Uuid::new_v4().to_string();
    let ts = now();
    let confidence = read_payload_f64(payload, "confidence").unwrap_or(row.confidence);
    let importance = read_payload_f64(payload, "importance").unwrap_or(confidence);
    conn.execute(
        "INSERT INTO entity_attributes
         (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status,
          group_key, claim_key, created_at, updated_at, source_id, source_kind, source_path, source_root,
          proposal_id, proposal_evidence)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10, ?11, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        rusqlite::params![
            id, aspect_id, row.agent_id, kind, value, normalized, confidence, importance,
            group_key, claim_key, ts, row.source_id, row.source_kind, row.source_path, row.source_root,
            row.id, proposal_audit_evidence(row)
        ],
    )?;
    Ok(
        json!({"entityId": entity_id, "aspectId": aspect_id, "attributeId": id, "deduped": false, "applied": true}),
    )
}

fn apply_create_link(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
) -> Result<JsonValue, CoreError> {
    let source = read_payload_string(payload, "source_entity")
        .ok_or_else(|| rusqlite::Error::InvalidQuery)?;
    let target = read_payload_string(payload, "target_entity")
        .ok_or_else(|| rusqlite::Error::InvalidQuery)?;
    let source_type = normalize_entity_type(read_payload_string(payload, "source_type"));
    let target_type = normalize_entity_type(read_payload_string(payload, "target_type"));
    let source_id = resolve_or_create_entity(conn, &row.agent_id, &source, &source_type)?;
    let target_id = resolve_or_create_entity(conn, &row.agent_id, &target, &target_type)?;
    let dependency_type = normalize_dependency_type(read_payload_string(payload, "link_type"));
    let strength = read_payload_f64(payload, "strength").unwrap_or(0.5);
    let confidence = read_payload_f64(payload, "confidence").unwrap_or(row.confidence);
    let reason = read_payload_string(payload, "reason").unwrap_or_else(|| row.rationale.clone());
    if let Some(existing) = conn
        .query_row(
            "SELECT id FROM entity_dependencies WHERE source_entity_id = ?1 AND target_entity_id = ?2 AND dependency_type = ?3 AND agent_id = ?4 LIMIT 1",
            rusqlite::params![source_id, target_id, dependency_type, row.agent_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        conn.execute(
            "UPDATE entity_dependencies SET strength = ?1, confidence = ?2, reason = ?3, updated_at = ?4,
             source_id = ?5, source_kind = ?6, source_path = ?7, source_root = ?8, proposal_id = ?9, proposal_evidence = ?10
             WHERE id = ?11 AND agent_id = ?12",
            rusqlite::params![strength, confidence, reason, now(), row.source_id, row.source_kind, row.source_path, row.source_root, row.id, proposal_audit_evidence(row), existing, row.agent_id],
        )?;
        return Ok(json!({"dependencyId": existing, "sourceId": source_id, "targetId": target_id, "updated": true, "applied": true}));
    }
    let id = Uuid::new_v4().to_string();
    let ts = now();
    conn.execute(
        "INSERT INTO entity_dependencies
         (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, reason,
          created_at, updated_at, source_id, source_kind, source_path, source_root, proposal_id, proposal_evidence)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        rusqlite::params![id, source_id, target_id, row.agent_id, dependency_type, strength, confidence, reason, ts, row.source_id, row.source_kind, row.source_path, row.source_root, row.id, proposal_audit_evidence(row)],
    )?;
    Ok(
        json!({"dependencyId": id, "sourceId": source_id, "targetId": target_id, "updated": false, "applied": true}),
    )
}

fn apply_operation(conn: &rusqlite::Connection, row: &ProposalRow) -> Result<JsonValue, CoreError> {
    let payload = parse_json(&row.payload, json!({}));
    match row.operation.as_str() {
        "create_entity" => apply_create_entity(conn, row, &payload),
        "add_claim_value" | "add_claim" => apply_add_claim_value(conn, row, &payload),
        "create_link" => apply_create_link(conn, row, &payload),
        _ => Err(rusqlite::Error::InvalidQuery.into()),
    }
}

fn insert_proposal(
    conn: &rusqlite::Connection,
    input: ProposalBody,
    default_agent: &str,
) -> Result<JsonValue, CoreError> {
    let id = Uuid::new_v4().to_string();
    let ts = now();
    let agent = agent_id(input.agent_id.or_else(|| Some(default_agent.to_string())));
    let operation = clean(input.operation).ok_or_else(|| rusqlite::Error::InvalidQuery)?;
    let payload = input
        .payload
        .filter(|p| p.is_object())
        .ok_or_else(|| rusqlite::Error::InvalidQuery)?;
    let evidence = input.evidence.unwrap_or_default();
    let confidence = input.confidence.unwrap_or(0.0).clamp(0.0, 1.0);

    conn.execute(
        "INSERT INTO ontology_proposals
         (id, agent_id, operation, status, payload, confidence, rationale, evidence,
          risk, source_kind, source_id, source_path, source_root, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        rusqlite::params![
            id,
            agent,
            operation,
            serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string()),
            confidence,
            clean(input.rationale).unwrap_or_default(),
            serde_json::to_string(&evidence).unwrap_or_else(|_| "[]".to_string()),
            clean(input.risk),
            clean(input.source_kind),
            clean(input.source_id),
            clean(input.source_path),
            clean(input.source_root),
            clean(input.created_by).unwrap_or_else(|| "operator".to_string()),
            ts,
            ts,
        ],
    )?;

    let mut stmt = conn.prepare(&format!(
        "{SELECT_PROPOSAL} WHERE id = ?1 AND agent_id = ?2"
    ))?;
    Ok(stmt
        .query_row(rusqlite::params![id, agent], |row| read_row(row))
        .map(row_to_value)?)
}

fn scoped_agent_or_response(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    requested: Option<&str>,
    permission: Permission,
) -> Result<String, Response> {
    let is_local = peer.ip().is_loopback();
    let auth = authenticate_headers(
        state.auth_mode,
        state.auth_secret.as_deref(),
        headers,
        is_local,
    )
    .map_err(|resp| *resp)?;
    require_permission_guard(&auth, permission, state.auth_mode, is_local).map_err(|resp| *resp)?;
    resolve_scoped_agent(&auth, state.auth_mode, is_local, requested)
        .map_err(|reason| (StatusCode::FORBIDDEN, Json(json!({"error": reason}))).into_response())
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ProposalQuery>,
) -> Response {
    if query.status.as_ref().is_some_and(|s| !valid_status(s)) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"status is invalid"})),
        )
            .into_response();
    }
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        query.agent_id.as_deref(),
        Permission::Recall,
    ) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let limit = parse_limit(query.limit.as_deref(), 50, 200);
    let offset = parse_offset(query.offset.as_deref());
    let result = state
        .pool
        .read(move |conn| {
            let mut sql = format!("{SELECT_PROPOSAL} WHERE agent_id = ?");
            let mut args = vec![Value::Text(agent)];
            if let Some(status) = clean(query.status) {
                sql.push_str(" AND status = ?");
                args.push(Value::Text(status));
            }
            if let Some(operation) = clean(query.operation) {
                sql.push_str(" AND operation = ?");
                args.push(Value::Text(operation));
            }
            sql.push_str(" ORDER BY updated_at DESC LIMIT ? OFFSET ?");
            args.push(Value::Integer(limit));
            args.push(Value::Integer(offset));
            let params: Vec<&dyn ToSql> = args.iter().map(|v| v as &dyn ToSql).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params.as_slice(), read_row)?;
            let mut items = Vec::new();
            for row in rows {
                items.push(row_to_value(row?));
            }
            Ok::<Vec<JsonValue>, CoreError>(items)
        })
        .await;

    match result {
        Ok(items) => (
            StatusCode::OK,
            Json(json!({"items": items, "count": items.len()})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

pub async fn get(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<ProposalQuery>,
) -> Response {
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        query.agent_id.as_deref(),
        Permission::Recall,
    ) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let result = state
        .pool
        .read(move |conn| {
            Ok(conn
                .prepare(&format!(
                    "{SELECT_PROPOSAL} WHERE id = ?1 AND agent_id = ?2"
                ))?
                .query_row(rusqlite::params![id, agent], read_row)
                .optional()?)
        })
        .await;
    match result {
        Ok(Some(row)) => (StatusCode::OK, Json(row_to_value(row))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Proposal not found"})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ProposalBody>,
) -> Response {
    if clean(body.operation.clone()).is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"operation is required"})),
        )
            .into_response();
    }
    if !body
        .payload
        .as_ref()
        .is_some_and(|p| p.is_object() && p.as_object().is_some_and(|o| !o.is_empty()))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"payload object is required"})),
        )
            .into_response();
    }
    let requested_agent = body.agent_id.as_deref();
    let agent =
        match scoped_agent_or_response(&state, peer, &headers, requested_agent, Permission::Modify)
        {
            Ok(id) => id,
            Err(resp) => return resp,
        };
    let result = state
        .pool
        .write_tx(
            Priority::High,
            move |conn| -> Result<JsonValue, CoreError> { insert_proposal(conn, body, &agent) },
        )
        .await;
    match result {
        Ok(proposal) => (StatusCode::CREATED, Json(proposal)).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

pub async fn batch(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ProposalBody>,
) -> Response {
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        body.agent_id.as_deref(),
        Permission::Modify,
    ) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let proposals = body.proposals.clone().unwrap_or_default();
    let result = state
        .pool
        .write_tx(
            Priority::High,
            move |conn| -> Result<JsonValue, CoreError> {
                let mut items = Vec::new();
                for mut proposal in proposals {
                    if proposal.created_by.is_none() {
                        proposal.created_by = body.created_by.clone();
                    }
                    if proposal.source_kind.is_none() {
                        proposal.source_kind = body.source_kind.clone();
                    }
                    if proposal.source_id.is_none() {
                        proposal.source_id = body.source_id.clone();
                    }
                    if proposal.source_path.is_none() {
                        proposal.source_path = body.source_path.clone();
                    }
                    if proposal.source_root.is_none() {
                        proposal.source_root = body.source_root.clone();
                    }
                    items.push(insert_proposal(conn, proposal, &agent)?);
                }
                Ok(json!({"items": items, "count": items.len()}))
            },
        )
        .await;
    match result {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

async fn transition(
    state: Arc<AppState>,
    id: String,
    agent: String,
    body: ProposalBody,
    status: &'static str,
) -> Response {
    let actor = clean(body.actor).unwrap_or_else(|| "operator".to_string());
    let reason = clean(body.reason);
    let result = state
        .pool
        .write_tx(Priority::High, move |conn| -> Result<JsonValue, CoreError> {
        let row: Option<ProposalRow> = conn.prepare(&format!("{SELECT_PROPOSAL} WHERE id = ?1 AND agent_id = ?2"))?
            .query_row(rusqlite::params![id, agent], read_row)
            .optional()?;
        let Some(row) = row else {
            return Ok(JsonValue::Null);
        };
        if row.status != "pending" {
            return Ok(json!({"error":"not_pending", "status": row.status}));
        }
        let ts = now();
        let result_json = if status == "applied" {
            apply_operation(conn, &row)?
        } else {
            json!({"reason": reason})
        };
        if status == "applied" {
            conn.execute(
                "UPDATE ontology_proposals SET status='applied', applied_by=?1, result=?2, updated_at=?3, applied_at=?3 WHERE id=?4 AND agent_id=?5",
                rusqlite::params![actor, result_json.to_string(), ts, row.id, row.agent_id],
            )?;
        } else {
            conn.execute(
                "UPDATE ontology_proposals SET status='rejected', rejected_by=?1, result=?2, updated_at=?3, rejected_at=?3 WHERE id=?4 AND agent_id=?5",
                rusqlite::params![actor, result_json.to_string(), ts, row.id, row.agent_id],
            )?;
        }
        let updated = conn.prepare(&format!("{SELECT_PROPOSAL} WHERE id = ?1 AND agent_id = ?2"))?
            .query_row(rusqlite::params![row.id, row.agent_id], read_row)?;
        Ok::<JsonValue, CoreError>(row_to_value(updated))
    }).await;
    match result {
        Ok(proposal)
            if proposal.get("error").and_then(|value| value.as_str()) == Some("not_pending") =>
        {
            let current = proposal
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            (
                StatusCode::CONFLICT,
                Json(json!({"error": format!("Proposal is {current}, not pending")})),
            )
                .into_response()
        }
        Ok(proposal) if !proposal.is_null() => (StatusCode::OK, Json(proposal)).into_response(),
        Ok(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Proposal not found"})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

pub async fn apply(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ProposalBody>,
) -> Response {
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        body.agent_id.as_deref(),
        Permission::Modify,
    ) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    transition(state, id, agent, body, "applied").await
}

pub async fn reject(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ProposalBody>,
) -> Response {
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        body.agent_id.as_deref(),
        Permission::Modify,
    ) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    transition(state, id, agent, body, "rejected").await
}

pub async fn evidence(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<ProposalQuery>,
) -> Response {
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        query.agent_id.as_deref(),
        Permission::Recall,
    ) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let result = state
        .pool
        .read(move |conn| {
            let row = conn
                .prepare(&format!(
                    "{SELECT_PROPOSAL} WHERE id = ?1 AND agent_id = ?2"
                ))?
                .query_row(rusqlite::params![id, agent], read_row)
                .optional()?;
            Ok::<Option<ProposalRow>, CoreError>(row)
        })
        .await;
    match result {
        Ok(Some(row)) => {
            let proposal = row_to_value(row);
            let items = proposal
                .get("evidence")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let count = items.as_array().map(|a| a.len()).unwrap_or(0);
            (
                StatusCode::OK,
                Json(json!({"proposal": proposal, "items": items, "count": count})),
            )
                .into_response()
        }
        Ok(None) => (
            StatusCode::OK,
            Json(json!({"proposal": null, "items": [], "count": 0})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

pub async fn conflicts(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ProposalQuery>,
) -> Response {
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        query.agent_id.as_deref(),
        Permission::Recall,
    ) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let limit = parse_limit(query.limit.as_deref(), 500, 1000);
    let result = state.pool.read(move |conn| {
        let mut stmt = conn.prepare(
            "SELECT payload, GROUP_CONCAT(id), COUNT(*) FROM ontology_proposals
             WHERE agent_id = ?1 AND status = 'pending'
             GROUP BY operation, payload HAVING COUNT(*) > 1 LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![agent, limit], |row| {
            let payload: String = row.get(0)?;
            let ids: String = row.get(1)?;
            let count: i64 = row.get(2)?;
            Ok(json!({"payload": parse_json(&payload, json!({})), "proposalIds": ids.split(',').collect::<Vec<_>>(), "count": count}))
        })?;
        let mut items = Vec::new();
        for row in rows { items.push(row?); }
        Ok(items)
    }).await;
    match result {
        Ok(items) => (
            StatusCode::OK,
            Json(json!({"items": items, "conflicts": items, "count": items.len()})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

pub async fn repair_duplicates(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = scoped_agent_or_response(&state, peer, &headers, None, Permission::Modify) {
        return resp;
    }
    (
        StatusCode::OK,
        Json(json!({"items": [], "proposals": [], "count": 0, "writtenCount": 0, "dryRun": true})),
    )
        .into_response()
}

pub async fn extract(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ProposalBody>,
) -> Response {
    if let Err(resp) = scoped_agent_or_response(
        &state,
        peer,
        &headers,
        body.agent_id.as_deref(),
        Permission::Modify,
    ) {
        return resp;
    }
    (StatusCode::OK, Json(json!({"items": [], "proposals": [], "count": 0, "writtenCount": 0, "dryRun": !body.write_proposals.unwrap_or(false)}))).into_response()
}

pub async fn consolidate(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ProposalBody>,
) -> Response {
    if let Err(resp) = scoped_agent_or_response(
        &state,
        peer,
        &headers,
        body.agent_id.as_deref(),
        Permission::Modify,
    ) {
        return resp;
    }
    if body.limit.is_some_and(|l| l < 0) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"limit is invalid"})),
        )
            .into_response();
    }
    (StatusCode::OK, Json(json!({"items": [], "proposals": [], "applied": 0, "count": 0, "writtenCount": 0, "dryRun": !body.write_proposals.unwrap_or(false)}))).into_response()
}

pub async fn claim_evidence(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = scoped_agent_or_response(&state, peer, &headers, None, Permission::Recall) {
        return resp;
    }
    (StatusCode::OK, Json(json!({"items": [], "count": 0}))).into_response()
}

pub async fn link_evidence(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = scoped_agent_or_response(&state, peer, &headers, None, Permission::Recall) {
        return resp;
    }
    (StatusCode::OK, Json(json!({"items": [], "count": 0}))).into_response()
}
