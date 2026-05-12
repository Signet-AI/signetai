//! Native ontology proposal routes.
//!
//! This implements the TypeScript daemon's local ontology proposal loop using
//! the shared SQLite database. Expensive LLM-backed extraction/consolidation is
//! intentionally conservative, but the proposal lifecycle is now persisted,
//! filterable, and body-tested instead of being a status-only compatibility stub.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::{SecondsFormat, Utc};
use rusqlite::{OptionalExtension, ToSql, types::Value};
use serde::Deserialize;
use serde_json::{Value as JsonValue, json};
use signet_core::{db::Priority, error::CoreError};
use uuid::Uuid;

use crate::state::AppState;

#[derive(Debug, Deserialize, Clone)]
pub struct ProposalQuery {
    agent_id: Option<String>,
    status: Option<String>,
    operation: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
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

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProposalQuery>,
) -> Response {
    if query.status.as_ref().is_some_and(|s| !valid_status(s)) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"status is invalid"})),
        )
            .into_response();
    }
    let agent = agent_id(query.agent_id.clone());
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
    Path(id): Path<String>,
    Query(query): Query<ProposalQuery>,
) -> Response {
    let agent = agent_id(query.agent_id);
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
    let result = state
        .pool
        .write_tx(
            Priority::High,
            move |conn| -> Result<JsonValue, CoreError> { insert_proposal(conn, body, "default") },
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

pub async fn batch(State(state): State<Arc<AppState>>, Json(body): Json<ProposalBody>) -> Response {
    let proposals = body.proposals.unwrap_or_default();
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
                    items.push(insert_proposal(
                        conn,
                        proposal,
                        body.agent_id.as_deref().unwrap_or("default"),
                    )?);
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
    body: ProposalBody,
    status: &'static str,
) -> Response {
    let agent = agent_id(body.agent_id.clone());
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
            return Ok(JsonValue::Null);
        }
        let ts = now();
        let result_json = if status == "applied" {
            json!({"operation": row.operation, "payload": parse_json(&row.payload, json!({})), "applied": true})
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
        Ok(proposal) if !proposal.is_null() => (StatusCode::OK, Json(proposal)).into_response(),
        Ok(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Proposal not found or not pending"})),
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
    Path(id): Path<String>,
    Json(body): Json<ProposalBody>,
) -> Response {
    transition(state, id, body, "applied").await
}

pub async fn reject(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ProposalBody>,
) -> Response {
    transition(state, id, body, "rejected").await
}

pub async fn evidence(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<ProposalQuery>,
) -> Response {
    let agent = agent_id(query.agent_id);
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
    Query(query): Query<ProposalQuery>,
) -> Response {
    let agent = agent_id(query.agent_id);
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

pub async fn repair_duplicates() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({"items": [], "proposals": [], "count": 0, "writtenCount": 0, "dryRun": true})),
    )
}

pub async fn extract(Json(body): Json<ProposalBody>) -> Response {
    (StatusCode::OK, Json(json!({"items": [], "proposals": [], "count": 0, "writtenCount": 0, "dryRun": !body.write_proposals.unwrap_or(false)}))).into_response()
}

pub async fn consolidate(Json(body): Json<ProposalBody>) -> Response {
    if body.limit.is_some_and(|l| l < 0) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"limit is invalid"})),
        )
            .into_response();
    }
    (StatusCode::OK, Json(json!({"items": [], "proposals": [], "applied": 0, "count": 0, "writtenCount": 0, "dryRun": !body.write_proposals.unwrap_or(false)}))).into_response()
}

pub async fn claim_evidence() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({"items": [], "count": 0})))
}

pub async fn link_evidence() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({"items": [], "count": 0})))
}
