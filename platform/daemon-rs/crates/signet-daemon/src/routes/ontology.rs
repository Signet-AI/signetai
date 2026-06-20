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
use signet_pipeline::provider::GenerateOpts;
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
    #[serde(alias = "agent_id")]
    agent_id: Option<String>,
    status: Option<String>,
    operation: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProposalBody {
    #[serde(alias = "agent_id")]
    agent_id: Option<String>,
    #[serde(rename = "from")]
    from_source: Option<String>,
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
    #[serde(alias = "created_by")]
    created_by: Option<String>,
    actor: Option<String>,
    reason: Option<String>,
    proposals: Option<Vec<ProposalBody>>,
    #[serde(alias = "write_proposals")]
    write_proposals: Option<bool>,
    #[serde(alias = "write_assertions")]
    write_assertions: Option<bool>,
    #[serde(alias = "use_provider")]
    use_provider: Option<bool>,
    #[serde(alias = "provider_timeout_ms")]
    provider_timeout_ms: Option<i64>,
    #[serde(alias = "provider_max_tokens")]
    provider_max_tokens: Option<i64>,
    status: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ClaimEvidenceQuery {
    #[serde(alias = "agentId")]
    agent_id: Option<String>,
    entity: Option<String>,
    aspect: Option<String>,
    group: Option<String>,
    claim: Option<String>,
    kind: Option<String>,
    status: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct LinkEvidenceQuery {
    #[serde(alias = "agentId")]
    agent_id: Option<String>,
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

#[derive(Debug)]
struct EntityRow {
    id: String,
    name: String,
    canonical_name: Option<String>,
    entity_type: String,
    agent_id: String,
    description: Option<String>,
    mentions: i64,
    pinned: bool,
    pinned_at: Option<String>,
    status: String,
    archived_at: Option<String>,
    archived_by: Option<String>,
    archive_reason: Option<String>,
    proposal_id: Option<String>,
    proposal_evidence: String,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug)]
struct DuplicateEntityRow {
    id: String,
    name: String,
    canonical_name: Option<String>,
    entity_type: String,
    mentions: i64,
    pinned: bool,
    updated_at: String,
}

#[derive(Debug)]
struct AspectRow {
    id: String,
    entity_id: String,
    agent_id: String,
    name: String,
    canonical_name: String,
    weight: f64,
    status: String,
    archived_at: Option<String>,
    archived_by: Option<String>,
    archive_reason: Option<String>,
    proposal_id: Option<String>,
    proposal_evidence: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug)]
struct AttributeEvidenceRow {
    id: String,
    aspect_id: String,
    agent_id: String,
    memory_id: Option<String>,
    kind: String,
    content: String,
    normalized_content: String,
    group_key: Option<String>,
    claim_key: Option<String>,
    confidence: f64,
    importance: f64,
    status: String,
    superseded_by: Option<String>,
    version: i64,
    version_root_id: Option<String>,
    previous_attribute_id: Option<String>,
    archived_at: Option<String>,
    archived_by: Option<String>,
    archive_reason: Option<String>,
    source_kind: Option<String>,
    source_id: Option<String>,
    source_path: Option<String>,
    source_root: Option<String>,
    proposal_id: Option<String>,
    proposal_evidence: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug)]
struct DependencyEvidenceRow {
    id: String,
    source_entity_id: String,
    target_entity_id: String,
    agent_id: String,
    aspect_id: Option<String>,
    dependency_type: String,
    strength: f64,
    confidence: f64,
    reason: Option<String>,
    status: String,
    archived_at: Option<String>,
    archived_by: Option<String>,
    archive_reason: Option<String>,
    source_kind: Option<String>,
    source_id: Option<String>,
    source_path: Option<String>,
    source_root: Option<String>,
    proposal_id: Option<String>,
    proposal_evidence: String,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug)]
struct EvidenceRef {
    source_kind: Option<String>,
    source_id: Option<String>,
    source_path: Option<String>,
    memory_id: Option<String>,
    quote: Option<String>,
    reference: JsonValue,
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

fn json_array(raw: &str) -> Vec<JsonValue> {
    parse_json(raw, json!([]))
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn compact_excerpt(content: &str, quote: Option<&str>) -> String {
    let text = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.len() <= 1200 {
        return text;
    }
    if let Some(quote) = quote.map(str::trim).filter(|q| !q.is_empty()) {
        if quote.len() <= 1200 {
            return quote.to_string();
        }
    }
    format!("{}...", text.chars().take(1197).collect::<String>().trim())
}

fn read_ref_string(record: &JsonValue, key: &str) -> Option<String> {
    record
        .get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn read_evidence_ref(value: JsonValue) -> Option<EvidenceRef> {
    match &value {
        JsonValue::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            Some(EvidenceRef {
                source_kind: None,
                source_id: Some(trimmed.to_string()),
                source_path: None,
                memory_id: None,
                quote: None,
                reference: value,
            })
        }
        JsonValue::Object(_) => {
            let transcript_id = read_ref_string(&value, "transcript_id");
            let session_key = read_ref_string(&value, "session_key");
            let proposal_id = read_ref_string(&value, "proposal_id");
            let source_kind = read_ref_string(&value, "source_kind").or_else(|| {
                if proposal_id.is_some() {
                    Some("ontology_proposal".to_string())
                } else if transcript_id.is_some() || session_key.is_some() {
                    Some("transcript".to_string())
                } else {
                    None
                }
            });
            Some(EvidenceRef {
                source_kind,
                source_id: read_ref_string(&value, "source_id")
                    .or_else(|| proposal_id.clone())
                    .or_else(|| transcript_id.clone())
                    .or(session_key.clone())
                    .or_else(|| read_ref_string(&value, "session_id"))
                    .or_else(|| read_ref_string(&value, "source")),
                source_path: read_ref_string(&value, "source_path"),
                memory_id: read_ref_string(&value, "memory_id"),
                quote: read_ref_string(&value, "quote"),
                reference: value,
            })
        }
        _ => None,
    }
}

fn unique_evidence_refs(refs: Vec<EvidenceRef>) -> Vec<EvidenceRef> {
    let mut seen = std::collections::HashSet::new();
    refs.into_iter()
        .filter(|r| {
            seen.insert((
                r.source_kind.clone(),
                r.source_id.clone(),
                r.source_path.clone(),
                r.memory_id.clone(),
                r.quote.clone(),
            ))
        })
        .collect()
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

fn entity_to_value(row: &EntityRow) -> JsonValue {
    json!({
        "id": row.id,
        "name": row.name,
        "canonicalName": row.canonical_name,
        "entityType": row.entity_type,
        "agentId": row.agent_id,
        "description": row.description,
        "mentions": row.mentions,
        "pinned": row.pinned,
        "pinnedAt": row.pinned_at,
        "status": row.status,
        "archivedAt": row.archived_at,
        "archivedBy": row.archived_by,
        "archiveReason": row.archive_reason,
        "proposalId": row.proposal_id,
        "proposalEvidence": parse_json(&row.proposal_evidence, json!([])),
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    })
}

fn aspect_to_value(row: &AspectRow) -> JsonValue {
    json!({
        "id": row.id,
        "entityId": row.entity_id,
        "agentId": row.agent_id,
        "name": row.name,
        "canonicalName": row.canonical_name,
        "weight": row.weight,
        "status": row.status,
        "archivedAt": row.archived_at,
        "archivedBy": row.archived_by,
        "archiveReason": row.archive_reason,
        "proposalId": row.proposal_id,
        "proposalEvidence": parse_json(&row.proposal_evidence, json!([])),
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    })
}

fn attribute_to_value(row: &AttributeEvidenceRow) -> JsonValue {
    json!({
        "id": row.id,
        "aspectId": row.aspect_id,
        "agentId": row.agent_id,
        "memoryId": row.memory_id,
        "kind": row.kind,
        "content": row.content,
        "normalizedContent": row.normalized_content,
        "groupKey": row.group_key,
        "claimKey": row.claim_key,
        "confidence": row.confidence,
        "importance": row.importance,
        "status": row.status,
        "supersededBy": row.superseded_by,
        "version": row.version,
        "versionRootId": row.version_root_id,
        "previousAttributeId": row.previous_attribute_id,
        "archivedAt": row.archived_at,
        "archivedBy": row.archived_by,
        "archiveReason": row.archive_reason,
        "sourceKind": row.source_kind,
        "sourceId": row.source_id,
        "sourcePath": row.source_path,
        "sourceRoot": row.source_root,
        "proposalId": row.proposal_id,
        "proposalEvidence": parse_json(&row.proposal_evidence, json!([])),
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    })
}

fn dependency_to_value(row: &DependencyEvidenceRow) -> JsonValue {
    json!({
        "id": row.id,
        "sourceEntityId": row.source_entity_id,
        "targetEntityId": row.target_entity_id,
        "agentId": row.agent_id,
        "aspectId": row.aspect_id,
        "dependencyType": row.dependency_type,
        "strength": row.strength,
        "confidence": row.confidence,
        "reason": row.reason,
        "status": row.status,
        "archivedAt": row.archived_at,
        "archivedBy": row.archived_by,
        "archiveReason": row.archive_reason,
        "sourceKind": row.source_kind,
        "sourceId": row.source_id,
        "sourcePath": row.source_path,
        "sourceRoot": row.source_root,
        "proposalId": row.proposal_id,
        "proposalEvidence": parse_json(&row.proposal_evidence, json!([])),
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
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

fn read_entity_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EntityRow> {
    Ok(EntityRow {
        id: row.get("id")?,
        name: row.get("name")?,
        canonical_name: row.get("canonical_name")?,
        entity_type: row.get("entity_type")?,
        agent_id: row.get("agent_id")?,
        description: row.get("description")?,
        mentions: row.get::<_, Option<i64>>("mentions")?.unwrap_or(0),
        pinned: row.get::<_, Option<i64>>("pinned")?.unwrap_or(0) != 0,
        pinned_at: row.get("pinned_at")?,
        status: row
            .get::<_, Option<String>>("status")?
            .unwrap_or_else(|| "active".to_string()),
        archived_at: row.get("archived_at")?,
        archived_by: row.get("archived_by")?,
        archive_reason: row.get("archive_reason")?,
        proposal_id: row.get("proposal_id")?,
        proposal_evidence: row
            .get::<_, Option<String>>("proposal_evidence")?
            .unwrap_or_else(|| "[]".to_string()),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_aspect_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AspectRow> {
    Ok(AspectRow {
        id: row.get("id")?,
        entity_id: row.get("entity_id")?,
        agent_id: row.get("agent_id")?,
        name: row.get("name")?,
        canonical_name: row.get("canonical_name")?,
        weight: row.get::<_, Option<f64>>("weight")?.unwrap_or(0.5),
        status: row
            .get::<_, Option<String>>("status")?
            .unwrap_or_else(|| "active".to_string()),
        archived_at: row.get("archived_at")?,
        archived_by: row.get("archived_by")?,
        archive_reason: row.get("archive_reason")?,
        proposal_id: row.get("proposal_id")?,
        proposal_evidence: row
            .get::<_, Option<String>>("proposal_evidence")?
            .unwrap_or_else(|| "[]".to_string()),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_attribute_evidence_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttributeEvidenceRow> {
    Ok(AttributeEvidenceRow {
        id: row.get("id")?,
        aspect_id: row.get("aspect_id")?,
        agent_id: row.get("agent_id")?,
        memory_id: row.get("memory_id")?,
        kind: row.get("kind")?,
        content: row.get("content")?,
        normalized_content: row.get("normalized_content")?,
        group_key: row.get("group_key")?,
        claim_key: row.get("claim_key")?,
        confidence: row.get::<_, Option<f64>>("confidence")?.unwrap_or(0.0),
        importance: row.get::<_, Option<f64>>("importance")?.unwrap_or(0.5),
        status: row.get("status")?,
        superseded_by: row.get("superseded_by")?,
        version: row.get::<_, Option<i64>>("version")?.unwrap_or(1),
        version_root_id: row.get("version_root_id")?,
        previous_attribute_id: row.get("previous_attribute_id")?,
        archived_at: row.get("archived_at")?,
        archived_by: row.get("archived_by")?,
        archive_reason: row.get("archive_reason")?,
        source_kind: row.get("source_kind")?,
        source_id: row.get("source_id")?,
        source_path: row.get("source_path")?,
        source_root: row.get("source_root")?,
        proposal_id: row.get("proposal_id")?,
        proposal_evidence: row
            .get::<_, Option<String>>("proposal_evidence")?
            .unwrap_or_else(|| "[]".to_string()),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_dependency_evidence_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<DependencyEvidenceRow> {
    Ok(DependencyEvidenceRow {
        id: row.get("id")?,
        source_entity_id: row.get("source_entity_id")?,
        target_entity_id: row.get("target_entity_id")?,
        agent_id: row.get("agent_id")?,
        aspect_id: row.get("aspect_id")?,
        dependency_type: row.get("dependency_type")?,
        strength: row.get::<_, Option<f64>>("strength")?.unwrap_or(0.5),
        confidence: row.get::<_, Option<f64>>("confidence")?.unwrap_or(0.7),
        reason: row.get("reason")?,
        status: row
            .get::<_, Option<String>>("status")?
            .unwrap_or_else(|| "active".to_string()),
        archived_at: row.get("archived_at")?,
        archived_by: row.get("archived_by")?,
        archive_reason: row.get("archive_reason")?,
        source_kind: row.get("source_kind")?,
        source_id: row.get("source_id")?,
        source_path: row.get("source_path")?,
        source_root: row.get("source_root")?,
        proposal_id: row.get("proposal_id")?,
        proposal_evidence: row
            .get::<_, Option<String>>("proposal_evidence")?
            .unwrap_or_else(|| "[]".to_string()),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
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

fn canonical_path_key(value: &str) -> String {
    canonical(value).replace(' ', "_")
}

fn duplicate_entity_key(row: &DuplicateEntityRow) -> String {
    canonical(row.canonical_name.as_deref().unwrap_or(&row.name))
}

fn duplicate_entity_ref(row: &DuplicateEntityRow, key: &str) -> JsonValue {
    json!({
        "id": row.id,
        "name": row.name,
        "canonicalName": key,
        "entityType": row.entity_type,
        "mentions": row.mentions,
        "pinned": row.pinned,
        "updatedAt": row.updated_at,
    })
}

fn time_rank(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

fn compare_duplicate_targets(a: &DuplicateEntityRow, b: &DuplicateEntityRow) -> std::cmp::Ordering {
    b.pinned
        .cmp(&a.pinned)
        .then_with(|| b.mentions.cmp(&a.mentions))
        .then_with(|| time_rank(&b.updated_at).cmp(&time_rank(&a.updated_at)))
        .then_with(|| a.name.len().cmp(&b.name.len()))
        .then_with(|| a.name.cmp(&b.name))
}

fn read_duplicate_entity_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DuplicateEntityRow> {
    Ok(DuplicateEntityRow {
        id: row.get("id")?,
        name: row.get("name")?,
        canonical_name: row.get("canonical_name")?,
        entity_type: row.get("entity_type")?,
        mentions: row.get::<_, Option<i64>>("mentions")?.unwrap_or(0),
        pinned: row.get::<_, Option<i64>>("pinned")?.unwrap_or(0) != 0,
        updated_at: row.get("updated_at")?,
    })
}

fn entity_ref_by_id(
    conn: &rusqlite::Connection,
    agent_id: &str,
    id: &str,
) -> Result<Option<DuplicateEntityRow>, CoreError> {
    conn.query_row(
        "SELECT id, name, canonical_name, entity_type,
                COALESCE(mentions, 0) AS mentions,
                COALESCE(pinned, 0) AS pinned,
                updated_at
         FROM entities
         WHERE agent_id = ?1
           AND COALESCE(status, 'active') = 'active'
           AND id = ?2
         LIMIT 1",
        rusqlite::params![agent_id, id],
        read_duplicate_entity_row,
    )
    .optional()
    .map_err(Into::into)
}

fn resolve_entity_ref_strict(
    conn: &rusqlite::Connection,
    agent_id: &str,
    selector: &str,
) -> Result<DuplicateEntityRow, CoreError> {
    let key = canonical(selector);
    let rows = conn
        .prepare(
            "SELECT id, name, canonical_name, entity_type,
                    COALESCE(mentions, 0) AS mentions,
                    COALESCE(pinned, 0) AS pinned,
                    updated_at
             FROM entities
             WHERE agent_id = ?1
               AND COALESCE(status, 'active') = 'active'
               AND (id = ?2 OR COALESCE(canonical_name, LOWER(name)) = ?3 OR LOWER(name) = ?4)
             ORDER BY CASE WHEN id = ?5 THEN 0 ELSE 1 END, updated_at DESC, name ASC",
        )?
        .query_map(
            rusqlite::params![agent_id, selector, key, key, selector],
            read_duplicate_entity_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    match rows.len() {
        0 => Err(CoreError::NotFound(format!("Entity not found: {selector}"))),
        1 => Ok(rows.into_iter().next().expect("one entity row")),
        _ => Err(CoreError::Conflict(format!(
            "Entity selector is ambiguous: {selector}. Use an id."
        ))),
    }
}

fn selector_matches_entity_ref(selector: &str, entity: &DuplicateEntityRow) -> bool {
    let key = canonical(selector);
    selector == entity.id
        || key == canonical(&entity.name)
        || key == canonical(entity.canonical_name.as_deref().unwrap_or(&entity.name))
}

fn resolve_merge_entity_ref(
    conn: &rusqlite::Connection,
    agent_id: &str,
    field: &str,
    selector: Option<String>,
    id: Option<String>,
) -> Result<DuplicateEntityRow, CoreError> {
    match id {
        Some(id) => {
            let entity = entity_ref_by_id(conn, agent_id, &id)?
                .ok_or_else(|| CoreError::NotFound(format!("{field}_id was not found: {id}")))?;
            if selector
                .as_deref()
                .is_some_and(|value| !selector_matches_entity_ref(value, &entity))
            {
                return Err(CoreError::Conflict(format!(
                    "{field}_id does not match {field}"
                )));
            }
            Ok(entity)
        }
        None => {
            let selector =
                selector.ok_or_else(|| CoreError::Invalid(format!("{field} is required")))?;
            resolve_entity_ref_strict(conn, agent_id, &selector)
        }
    }
}

fn read_body_string_array(body: &JsonValue, key: &str) -> Vec<String> {
    body.get(key)
        .and_then(JsonValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn read_body_bool(body: &JsonValue, key: &str) -> Option<bool> {
    body.get(key).and_then(JsonValue::as_bool)
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

fn table_exists(conn: &rusqlite::Connection, table: &str) -> Result<bool, CoreError> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
        rusqlite::params![table],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(Into::into)
}

fn source_id_candidates(value: Option<&str>) -> Vec<String> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    for candidate in [
        Some(value.to_string()),
        value
            .strip_prefix("transcript:")
            .map(std::string::ToString::to_string),
        value
            .strip_prefix("session:")
            .map(std::string::ToString::to_string),
        (!value.starts_with("transcript:")).then(|| format!("transcript:{value}")),
        (!value.starts_with("session:")).then(|| format!("session:{value}")),
    ]
    .into_iter()
    .flatten()
    {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

fn source_looks_like_transcript(reference: &EvidenceRef) -> bool {
    matches!(
        reference.source_kind.as_deref(),
        Some("transcript" | "session_transcript")
    ) || reference
        .source_id
        .as_deref()
        .is_some_and(|id| id.starts_with("transcript:") || id.starts_with("session:"))
}

fn resolve_ontology_evidence_ref(
    conn: &rusqlite::Connection,
    agent_id: &str,
    reference: &EvidenceRef,
) -> Result<JsonValue, CoreError> {
    if reference.source_kind.as_deref() == Some("ontology_proposal") {
        if let Some(source_id) = reference.source_id.as_deref() {
            let proposal = conn
                .query_row(
                    &format!("{SELECT_PROPOSAL} WHERE id = ?1 AND agent_id = ?2 LIMIT 1"),
                    rusqlite::params![source_id, agent_id],
                    read_row,
                )
                .optional()?;
            if let Some(proposal) = proposal {
                let excerpt_source =
                    reference
                        .quote
                        .as_deref()
                        .unwrap_or(if proposal.rationale.is_empty() {
                            &proposal.evidence
                        } else {
                            &proposal.rationale
                        });
                return Ok(json!({
                    "kind": "ontology_proposal",
                    "found": true,
                    "sourceKind": "ontology_proposal",
                    "sourceId": proposal.id,
                    "sourcePath": reference.source_path,
                    "label": format!("proposal:{}", proposal.id),
                    "excerpt": compact_excerpt(excerpt_source, None),
                    "reference": reference.reference,
                }));
            }
        }
    }

    if let Some(source_path) = reference.source_path.as_deref() {
        if table_exists(conn, "memory_artifacts")? {
            let artifact = conn
                .query_row(
                    "SELECT source_path, source_kind, session_id, session_key, session_token, content
                     FROM memory_artifacts
                     WHERE agent_id = ?1 AND COALESCE(is_deleted, 0) = 0 AND source_path = ?2
                     ORDER BY captured_at DESC
                     LIMIT 1",
                    rusqlite::params![agent_id, source_path],
                    |row| {
                        Ok((
                            row.get::<_, String>("source_path")?,
                            row.get::<_, String>("source_kind")?,
                            row.get::<_, String>("session_id")?,
                            row.get::<_, Option<String>>("session_key")?,
                            row.get::<_, String>("session_token")?,
                            row.get::<_, String>("content")?,
                        ))
                    },
                )
                .optional()?;
            if let Some((path, kind, session_id, session_key, session_token, content)) = artifact {
                return Ok(json!({
                    "kind": "memory_artifact",
                    "found": true,
                    "sourceKind": kind,
                    "sourceId": session_key.or(Some(session_id)).unwrap_or(session_token),
                    "sourcePath": path,
                    "label": path,
                    "excerpt": compact_excerpt(&content, reference.quote.as_deref()),
                    "reference": reference.reference,
                }));
            }
        }
    }

    if source_looks_like_transcript(reference) && table_exists(conn, "session_transcripts")? {
        let ids = source_id_candidates(reference.source_id.as_deref());
        if !ids.is_empty() {
            let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            let sql = format!(
                "SELECT session_key, content, COALESCE(updated_at, created_at) AS seen_at
                 FROM session_transcripts
                 WHERE agent_id = ? AND session_key IN ({placeholders})
                 ORDER BY seen_at DESC
                 LIMIT 1"
            );
            let mut args = vec![Value::Text(agent_id.to_string())];
            args.extend(ids.into_iter().map(Value::Text));
            let params: Vec<&dyn ToSql> = args.iter().map(|v| v as &dyn ToSql).collect();
            let transcript = conn
                .query_row(&sql, params.as_slice(), |row| {
                    Ok((
                        row.get::<_, String>("session_key")?,
                        row.get::<_, String>("content")?,
                    ))
                })
                .optional()?;
            if let Some((session_key, content)) = transcript {
                return Ok(json!({
                    "kind": "session_transcript",
                    "found": true,
                    "sourceKind": reference.source_kind.clone().unwrap_or_else(|| "transcript".to_string()),
                    "sourceId": session_key,
                    "sourcePath": reference.source_path,
                    "label": format!("transcript:{session_key}"),
                    "excerpt": compact_excerpt(&content, reference.quote.as_deref()),
                    "reference": reference.reference,
                }));
            }
        }
    }

    if reference.source_path.is_none() && table_exists(conn, "memory_artifacts")? {
        let ids = source_id_candidates(reference.source_id.as_deref());
        if !ids.is_empty() {
            let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            let sql = format!(
                "SELECT source_path, source_kind, session_id, session_key, session_token, content
                 FROM memory_artifacts
                 WHERE agent_id = ? AND COALESCE(is_deleted, 0) = 0
                   AND (
                     source_node_id IN ({placeholders})
                     OR session_id IN ({placeholders})
                     OR session_key IN ({placeholders})
                     OR session_token IN ({placeholders})
                     OR source_path IN ({placeholders})
                   )
                 ORDER BY captured_at DESC
                 LIMIT 1"
            );
            let mut args = vec![Value::Text(agent_id.to_string())];
            for _ in 0..5 {
                args.extend(ids.iter().cloned().map(Value::Text));
            }
            let params: Vec<&dyn ToSql> = args.iter().map(|v| v as &dyn ToSql).collect();
            let artifact = conn
                .query_row(&sql, params.as_slice(), |row| {
                    Ok((
                        row.get::<_, String>("source_path")?,
                        row.get::<_, String>("source_kind")?,
                        row.get::<_, String>("session_id")?,
                        row.get::<_, Option<String>>("session_key")?,
                        row.get::<_, String>("session_token")?,
                        row.get::<_, String>("content")?,
                    ))
                })
                .optional()?;
            if let Some((path, kind, session_id, session_key, session_token, content)) = artifact {
                return Ok(json!({
                    "kind": "memory_artifact",
                    "found": true,
                    "sourceKind": kind,
                    "sourceId": session_key.or(Some(session_id)).unwrap_or(session_token),
                    "sourcePath": path,
                    "label": path,
                    "excerpt": compact_excerpt(&content, reference.quote.as_deref()),
                    "reference": reference.reference,
                }));
            }
        }
    }

    if let Some(memory_id) = reference.memory_id.as_deref() {
        if table_exists(conn, "memories")? {
            let memory = conn
                .query_row(
                    "SELECT id, source_id, source_type, source_path, content
                     FROM memories
                     WHERE id = ?1 AND agent_id = ?2 AND COALESCE(is_deleted, 0) = 0
                     LIMIT 1",
                    rusqlite::params![memory_id, agent_id],
                    |row| {
                        Ok((
                            row.get::<_, String>("id")?,
                            row.get::<_, Option<String>>("source_id")?,
                            row.get::<_, Option<String>>("source_type")?,
                            row.get::<_, Option<String>>("source_path")?,
                            row.get::<_, String>("content")?,
                        ))
                    },
                )
                .optional()?;
            if let Some((id, source_id, source_type, source_path, content)) = memory {
                return Ok(json!({
                    "kind": "memory",
                    "found": true,
                    "sourceKind": source_type,
                    "sourceId": source_id.unwrap_or_else(|| id.clone()),
                    "sourcePath": source_path,
                    "label": format!("memory:{id}"),
                    "excerpt": compact_excerpt(&content, reference.quote.as_deref()),
                    "reference": reference.reference,
                }));
            }
        }
    }

    if let Some(quote) = reference.quote.as_deref() {
        return Ok(json!({
            "kind": "provided_quote",
            "found": true,
            "sourceKind": reference.source_kind,
            "sourceId": reference.source_id,
            "sourcePath": reference.source_path,
            "label": "embedded quote",
            "excerpt": compact_excerpt(quote, None),
            "reference": reference.reference,
        }));
    }

    Ok(json!({
        "kind": "unresolved",
        "found": false,
        "sourceKind": reference.source_kind,
        "sourceId": reference.source_id,
        "sourcePath": reference.source_path,
        "label": reference
            .source_path
            .clone()
            .or_else(|| reference.source_id.clone())
            .or_else(|| reference.memory_id.clone())
            .unwrap_or_else(|| "unknown evidence".to_string()),
        "excerpt": "",
        "reference": reference.reference,
    }))
}

fn attribute_evidence_refs(attribute: &AttributeEvidenceRow) -> Vec<EvidenceRef> {
    let mut refs = Vec::new();
    if let Some(proposal_id) = attribute.proposal_id.clone() {
        refs.push(EvidenceRef {
            source_kind: Some("ontology_proposal".to_string()),
            source_id: Some(proposal_id.clone()),
            source_path: None,
            memory_id: None,
            quote: None,
            reference: json!({
                "attribute_id": attribute.id,
                "proposal_id": proposal_id,
            }),
        });
    }
    refs.extend(
        json_array(&attribute.proposal_evidence)
            .into_iter()
            .filter_map(read_evidence_ref),
    );
    if attribute.source_kind.is_some() || attribute.source_id.is_some() {
        refs.push(EvidenceRef {
            source_kind: attribute.source_kind.clone(),
            source_id: attribute.source_id.clone(),
            source_path: None,
            memory_id: None,
            quote: None,
            reference: json!({
                "attribute_id": attribute.id,
                "source_kind": attribute.source_kind,
                "source_id": attribute.source_id,
            }),
        });
    }
    if attribute.source_path.is_some() {
        refs.push(EvidenceRef {
            source_kind: attribute.source_kind.clone(),
            source_id: attribute.source_id.clone(),
            source_path: attribute.source_path.clone(),
            memory_id: None,
            quote: None,
            reference: json!({
                "attribute_id": attribute.id,
                "source_kind": attribute.source_kind,
                "source_id": attribute.source_id,
                "source_path": attribute.source_path,
                "source_root": attribute.source_root,
            }),
        });
    }
    if let Some(memory_id) = attribute.memory_id.clone() {
        refs.push(EvidenceRef {
            source_kind: None,
            source_id: None,
            source_path: None,
            memory_id: Some(memory_id.clone()),
            quote: None,
            reference: json!({
                "attribute_id": attribute.id,
                "memory_id": memory_id,
            }),
        });
    }
    unique_evidence_refs(refs)
}

fn link_evidence_refs(dependency: &DependencyEvidenceRow) -> Vec<EvidenceRef> {
    let mut refs = Vec::new();
    if let Some(proposal_id) = dependency.proposal_id.clone() {
        refs.push(EvidenceRef {
            source_kind: Some("ontology_proposal".to_string()),
            source_id: Some(proposal_id.clone()),
            source_path: None,
            memory_id: None,
            quote: None,
            reference: json!({
                "dependency_id": dependency.id,
                "proposal_id": proposal_id,
            }),
        });
    }
    refs.extend(
        json_array(&dependency.proposal_evidence)
            .into_iter()
            .filter_map(read_evidence_ref),
    );
    if dependency.source_kind.is_some() || dependency.source_id.is_some() {
        refs.push(EvidenceRef {
            source_kind: dependency.source_kind.clone(),
            source_id: dependency.source_id.clone(),
            source_path: None,
            memory_id: None,
            quote: None,
            reference: json!({
                "dependency_id": dependency.id,
                "source_kind": dependency.source_kind,
                "source_id": dependency.source_id,
            }),
        });
    }
    if dependency.source_path.is_some() {
        refs.push(EvidenceRef {
            source_kind: dependency.source_kind.clone(),
            source_id: dependency.source_id.clone(),
            source_path: dependency.source_path.clone(),
            memory_id: None,
            quote: None,
            reference: json!({
                "dependency_id": dependency.id,
                "source_kind": dependency.source_kind,
                "source_id": dependency.source_id,
                "source_path": dependency.source_path,
                "source_root": dependency.source_root,
            }),
        });
    }
    unique_evidence_refs(refs)
}

fn count_for_source_ids(
    conn: &rusqlite::Connection,
    sql_template: &str,
    agent_id: Option<&str>,
    ids: &[String],
    repeat_ids: usize,
) -> Result<i64, CoreError> {
    if ids.is_empty() {
        return Ok(0);
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = sql_template.replace("{ids}", &placeholders);
    let mut args = Vec::new();
    if let Some(agent_id) = agent_id {
        args.push(Value::Text(agent_id.to_string()));
    }
    for _ in 0..repeat_ids {
        args.extend(ids.iter().cloned().map(Value::Text));
    }
    let params: Vec<&dyn ToSql> = args.iter().map(|v| v as &dyn ToSql).collect();
    conn.query_row(&sql, params.as_slice(), |row| row.get::<_, i64>(0))
        .map_err(Into::into)
}

fn duplicate_merge_impact(
    conn: &rusqlite::Connection,
    agent_id: &str,
    sources: &[DuplicateEntityRow],
) -> Result<JsonValue, CoreError> {
    let ids = sources
        .iter()
        .map(|source| source.id.clone())
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(json!({
            "sourceMentions": 0,
            "memoryMentions": 0,
            "aspects": 0,
            "attributes": 0,
            "dependencies": 0,
            "relations": 0,
        }));
    }
    let source_mentions = sources.iter().map(|source| source.mentions).sum::<i64>();
    let aspects = count_for_source_ids(
        conn,
        "SELECT COUNT(*) FROM entity_aspects WHERE agent_id = ? AND entity_id IN ({ids})",
        Some(agent_id),
        &ids,
        1,
    )?;
    let attributes = count_for_source_ids(
        conn,
        "SELECT COUNT(*)
         FROM entity_attributes attr
         JOIN entity_aspects asp ON asp.id = attr.aspect_id
         WHERE attr.agent_id = ? AND asp.entity_id IN ({ids})",
        Some(agent_id),
        &ids,
        1,
    )?;
    let dependencies = count_for_source_ids(
        conn,
        "SELECT COUNT(*)
         FROM entity_dependencies
         WHERE agent_id = ? AND (source_entity_id IN ({ids}) OR target_entity_id IN ({ids}))",
        Some(agent_id),
        &ids,
        2,
    )?;
    let relations = count_for_source_ids(
        conn,
        "SELECT COUNT(*)
         FROM relations
         WHERE source_entity_id IN ({ids}) OR target_entity_id IN ({ids})",
        None,
        &ids,
        2,
    )?;
    let memory_mentions = count_for_source_ids(
        conn,
        "SELECT COUNT(*) FROM memory_entity_mentions WHERE entity_id IN ({ids})",
        None,
        &ids,
        1,
    )?;
    Ok(json!({
        "sourceMentions": source_mentions,
        "memoryMentions": memory_mentions,
        "aspects": aspects,
        "attributes": attributes,
        "dependencies": dependencies,
        "relations": relations,
    }))
}

fn merge_warnings(
    target: &DuplicateEntityRow,
    sources: &[DuplicateEntityRow],
    force: bool,
) -> (Vec<String>, bool, &'static str) {
    let mut warnings = Vec::new();
    for source in sources {
        if source.pinned {
            warnings.push(format!("source entity \"{}\" is pinned", source.name));
        }
        if source.entity_type != target.entity_type {
            warnings.push(format!(
                "source entity \"{}\" type {} differs from target type {}",
                source.name, source.entity_type, target.entity_type
            ));
        }
    }
    if warnings.is_empty() {
        (warnings, false, "low")
    } else {
        (
            warnings,
            !force,
            if force { "review_required" } else { "blocked" },
        )
    }
}

fn merge_plan_payload(
    target: &DuplicateEntityRow,
    sources: &[DuplicateEntityRow],
    force: bool,
    repair_kind: &str,
) -> JsonValue {
    let mut payload = json!({
        "repair_kind": repair_kind,
        "target_entity": target.name,
        "target_entity_id": target.id,
        "source_entities": sources.iter().map(|source| source.name.clone()).collect::<Vec<_>>(),
        "source_entity_ids": sources.iter().map(|source| source.id.clone()).collect::<Vec<_>>(),
    });
    if force {
        payload["force"] = JsonValue::Bool(true);
    }
    payload
}

fn build_entity_merge_plan(
    conn: &rusqlite::Connection,
    agent_id: &str,
    body: &JsonValue,
    repair_kind: &str,
) -> Result<JsonValue, CoreError> {
    let target_selector =
        read_body_string(body, "target_entity").or_else(|| read_body_string(body, "target"));
    let target_id =
        read_body_string(body, "target_entity_id").or_else(|| read_body_string(body, "target_id"));
    let target = resolve_merge_entity_ref(
        conn,
        agent_id,
        "payload.target_entity",
        target_selector,
        target_id,
    )?;

    let source_entities = {
        let values = read_body_string_array(body, "source_entities");
        if values.is_empty() {
            read_body_string_array(body, "sources")
        } else {
            values
        }
    };
    let source_entity_ids = {
        let values = read_body_string_array(body, "source_entity_ids");
        if values.is_empty() {
            read_body_string_array(body, "source_ids")
        } else {
            values
        }
    };
    if !source_entity_ids.is_empty() && source_entities.len() > source_entity_ids.len() {
        return Err(CoreError::Invalid(
            "sourceEntities and sourceEntityIds must match".to_string(),
        ));
    }
    let specs = if source_entity_ids.is_empty() {
        source_entities
            .into_iter()
            .map(|selector| (Some(selector), None))
            .collect::<Vec<_>>()
    } else {
        source_entity_ids
            .into_iter()
            .enumerate()
            .map(|(idx, id)| (source_entities.get(idx).cloned(), Some(id)))
            .collect::<Vec<_>>()
    };
    if specs.is_empty() {
        return Err(CoreError::Invalid(
            "source entities are required".to_string(),
        ));
    }

    let resolved = specs
        .into_iter()
        .map(|(selector, id)| {
            resolve_merge_entity_ref(conn, agent_id, "payload.source_entity", selector, id)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut seen = std::collections::HashSet::new();
    let sources = resolved
        .into_iter()
        .filter(|source| source.id != target.id)
        .filter(|source| seen.insert(source.id.clone()))
        .collect::<Vec<_>>();
    if sources.is_empty() {
        return Err(CoreError::Invalid(
            "No distinct source entities to merge".to_string(),
        ));
    }

    let force = read_body_bool(body, "force").unwrap_or(false);
    let (warnings, blocked, risk) = merge_warnings(&target, &sources, force);
    let target_key = duplicate_entity_key(&target);
    let evidence = body
        .get("evidence")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_else(|| {
            vec![json!({
                "source_kind": "ontology_index",
                "source_id": format!("entities:{target_key}"),
                "quote": format!(
                    "Merge {} into {}.",
                    sources.iter().map(|source| source.name.as_str()).collect::<Vec<_>>().join(", "),
                    target.name
                ),
            })]
        });
    let rationale = read_body_string(body, "rationale")
        .or_else(|| read_body_string(body, "reason"))
        .unwrap_or_else(|| {
            format!(
                "Merge {} into \"{}\".",
                sources
                    .iter()
                    .map(|source| format!("\"{}\"", source.name))
                    .collect::<Vec<_>>()
                    .join(", "),
                target.name
            )
        });
    Ok(json!({
        "operation": "merge_entities",
        "target": duplicate_entity_ref(&target, &target_key),
        "sources": sources.iter().map(|source| duplicate_entity_ref(source, &duplicate_entity_key(source))).collect::<Vec<_>>(),
        "payload": merge_plan_payload(&target, &sources, force, repair_kind),
        "impact": duplicate_merge_impact(conn, agent_id, &sources)?,
        "warnings": warnings,
        "blocked": blocked,
        "confidence": if risk == "low" { 0.86 } else { 0.72 },
        "rationale": rationale,
        "evidence": evidence,
        "risk": risk,
    }))
}

fn pending_duplicate_repair_keys(
    conn: &rusqlite::Connection,
    agent_id: &str,
) -> Result<std::collections::HashSet<String>, CoreError> {
    let mut stmt = conn.prepare(
        "SELECT payload FROM ontology_proposals
         WHERE agent_id = ?1 AND status = 'pending' AND operation = 'merge_entities'
         ORDER BY updated_at DESC
         LIMIT 1000",
    )?;
    let rows = stmt
        .query_map(rusqlite::params![agent_id], |row| {
            row.get::<_, String>("payload")
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|payload| {
            let payload = parse_json(&payload, json!({}));
            (payload.get("repair_kind").and_then(|v| v.as_str()) == Some("duplicate_entities"))
                .then(|| {
                    payload
                        .get("canonical_name")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .flatten()
        })
        .collect())
}

fn duplicate_merge_candidates(
    conn: &rusqlite::Connection,
    agent_id: &str,
    limit: i64,
) -> Result<Vec<JsonValue>, CoreError> {
    let existing = pending_duplicate_repair_keys(conn, agent_id)?;
    let mut stmt = conn.prepare(
        "SELECT id, name, canonical_name, entity_type,
                COALESCE(mentions, 0) AS mentions,
                COALESCE(pinned, 0) AS pinned,
                updated_at
         FROM entities
         WHERE agent_id = ?1
           AND COALESCE(status, 'active') = 'active'
         ORDER BY COALESCE(canonical_name, LOWER(name)), COALESCE(mentions, 0) DESC, updated_at DESC",
    )?;
    let rows = stmt
        .query_map(rusqlite::params![agent_id], read_duplicate_entity_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let mut groups: std::collections::BTreeMap<String, Vec<DuplicateEntityRow>> =
        std::collections::BTreeMap::new();
    for row in rows {
        let key = duplicate_entity_key(&row);
        groups.entry(key).or_default().push(row);
    }

    let mut candidates = Vec::new();
    for (key, mut group) in groups {
        if key.is_empty() || group.len() < 2 || existing.contains(&key) {
            continue;
        }
        group.sort_by(compare_duplicate_targets);
        let target = group[0].clone();
        let sources = group[1..].to_vec();
        let mut warnings = Vec::new();
        for source in &sources {
            if source.pinned {
                warnings.push(format!("source entity \"{}\" is pinned", source.name));
            }
            if source.entity_type != target.entity_type {
                warnings.push(format!(
                    "source entity \"{}\" type {} differs from target type {}",
                    source.name, source.entity_type, target.entity_type
                ));
            }
        }
        let blocked = !warnings.is_empty();
        let risk = if blocked { "blocked" } else { "low" };
        let evidence = vec![json!({
            "source_kind": "ontology_index",
            "source_id": format!("entities:{key}"),
            "quote": format!(
                "Duplicate canonical_name \"{key}\" appears on {}.",
                group.iter().map(|row| row.name.as_str()).collect::<Vec<_>>().join(", ")
            ),
        })];
        let payload = json!({
            "repair_kind": "duplicate_entities",
            "target_entity": target.name,
            "target_entity_id": target.id,
            "source_entities": sources.iter().map(|source| source.name.clone()).collect::<Vec<_>>(),
            "source_entity_ids": sources.iter().map(|source| source.id.clone()).collect::<Vec<_>>(),
            "canonical_name": key,
        });
        candidates.push(json!({
            "operation": "merge_entities",
            "canonicalName": key,
            "target": duplicate_entity_ref(&target, &key),
            "sources": sources.iter().map(|source| duplicate_entity_ref(source, &key)).collect::<Vec<_>>(),
            "payload": payload,
            "impact": duplicate_merge_impact(conn, agent_id, &sources)?,
            "warnings": warnings,
            "blocked": blocked,
            "confidence": if blocked { 0.72 } else { 0.86 },
            "rationale": format!(
                "Entities share canonical_name \"{key}\" in the same agent scope."
            ),
            "evidence": evidence,
            "risk": risk,
        }));
    }
    candidates.sort_by(|a, b| {
        let a_sources = a
            .get("sources")
            .and_then(|v| v.as_array())
            .map_or(0, Vec::len);
        let b_sources = b
            .get("sources")
            .and_then(|v| v.as_array())
            .map_or(0, Vec::len);
        b_sources.cmp(&a_sources).then_with(|| {
            a.get("canonicalName")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .cmp(
                    b.get("canonicalName")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                )
        })
    });
    Ok(candidates.into_iter().take(limit as usize).collect())
}

#[derive(Clone, Debug)]
struct ExtractionSource {
    kind: String,
    id: String,
    content: String,
    source_kind: String,
    source_id: String,
    source_path: Option<String>,
    project: Option<String>,
    harness: Option<String>,
}

fn bounded_limit(raw: Option<i64>, default: i64, min: i64, max: i64) -> i64 {
    raw.unwrap_or(default).clamp(min, max)
}

fn extraction_source_id_candidates(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    let stripped = trimmed
        .strip_prefix("transcript:")
        .or_else(|| trimmed.strip_prefix("session:"))
        .unwrap_or(trimmed);
    let mut seen = std::collections::HashSet::new();
    [
        trimmed,
        stripped,
        &format!("transcript:{stripped}"),
        &format!("session:{stripped}"),
    ]
    .into_iter()
    .filter(|item| !item.trim().is_empty())
    .filter(|item| seen.insert((*item).to_string()))
    .map(ToOwned::to_owned)
    .collect()
}

fn read_transcript_source(
    conn: &rusqlite::Connection,
    agent_id: &str,
    id: &str,
) -> Result<Option<ExtractionSource>, CoreError> {
    if !table_exists(conn, "session_transcripts")? {
        return Ok(None);
    }
    let candidates = extraction_source_id_candidates(id);
    let placeholders = vec!["?"; candidates.len()].join(", ");
    let sql = format!(
        "SELECT session_key, content, harness, project
         FROM session_transcripts
         WHERE agent_id = ?1 AND session_key IN ({placeholders})
         ORDER BY created_at DESC
         LIMIT 1"
    );
    let mut values = vec![Value::Text(agent_id.to_string())];
    values.extend(candidates.into_iter().map(Value::Text));
    let params = values.iter().map(|v| v as &dyn ToSql).collect::<Vec<_>>();
    conn.prepare(&sql)?
        .query_row(params.as_slice(), |row| {
            let session_key = row.get::<_, String>(0)?;
            Ok(ExtractionSource {
                kind: "transcript".to_string(),
                id: session_key.clone(),
                content: row.get::<_, String>(1)?,
                harness: row.get::<_, Option<String>>(2)?,
                project: row.get::<_, Option<String>>(3)?,
                source_kind: "transcript".to_string(),
                source_id: session_key,
                source_path: None,
            })
        })
        .optional()
        .map_err(Into::into)
}

fn read_artifact_source(
    conn: &rusqlite::Connection,
    agent_id: &str,
    id: &str,
) -> Result<Option<ExtractionSource>, CoreError> {
    if !table_exists(conn, "memory_artifacts")? {
        return Ok(None);
    }
    let candidates = extraction_source_id_candidates(id);
    let placeholders = vec!["?"; candidates.len()].join(", ");
    let sql = format!(
        "SELECT source_path, source_kind, source_node_id, session_id, session_key,
                session_token, project, harness, content
         FROM memory_artifacts
         WHERE agent_id = ?1
           AND COALESCE(is_deleted, 0) = 0
           AND (
             source_path = ?2
             OR source_node_id IN ({placeholders})
             OR session_id IN ({placeholders})
             OR session_key IN ({placeholders})
             OR session_token IN ({placeholders})
           )
         ORDER BY captured_at DESC
         LIMIT 1"
    );
    let mut values = vec![
        Value::Text(agent_id.to_string()),
        Value::Text(id.to_string()),
    ];
    for _ in 0..4 {
        values.extend(candidates.iter().cloned().map(Value::Text));
    }
    let params = values.iter().map(|v| v as &dyn ToSql).collect::<Vec<_>>();
    conn.prepare(&sql)?
        .query_row(params.as_slice(), |row| {
            let source_path = row.get::<_, String>(0)?;
            let source_node_id = row.get::<_, Option<String>>(2)?;
            let session_id = row.get::<_, String>(3)?;
            let session_key = row.get::<_, Option<String>>(4)?;
            let session_token = row.get::<_, String>(5)?;
            Ok(ExtractionSource {
                kind: "artifact".to_string(),
                id: source_path.clone(),
                source_path: Some(source_path),
                source_kind: row.get::<_, String>(1)?,
                source_id: source_node_id.or(session_key).unwrap_or_else(|| {
                    if session_id.is_empty() {
                        session_token
                    } else {
                        session_id
                    }
                }),
                project: row.get::<_, Option<String>>(6)?,
                harness: row.get::<_, Option<String>>(7)?,
                content: row.get::<_, String>(8)?,
            })
        })
        .optional()
        .map_err(Into::into)
}

fn read_extraction_source(
    conn: &rusqlite::Connection,
    agent_id: &str,
    from: &str,
) -> Result<ExtractionSource, CoreError> {
    let trimmed = from.trim();
    if trimmed.is_empty() {
        return Err(CoreError::Invalid("from is required".to_string()));
    }
    if (trimmed.starts_with("transcript:") || trimmed.starts_with("session:"))
        && let Some(source) = read_transcript_source(conn, agent_id, trimmed)?
    {
        return Ok(source);
    }
    let artifact_id = trimmed
        .strip_prefix("artifact:")
        .or_else(|| trimmed.strip_prefix("source:"))
        .unwrap_or(trimmed);
    if let Some(source) = read_artifact_source(conn, agent_id, artifact_id)? {
        return Ok(source);
    }
    if let Some(source) = read_transcript_source(conn, agent_id, trimmed)? {
        return Ok(source);
    }
    Err(CoreError::NotFound(
        "Extraction source not found".to_string(),
    ))
}

fn read_json_string(record: &JsonValue, key: &str) -> Option<String> {
    record
        .get(key)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn read_json_number(record: &JsonValue, key: &str) -> Option<f64> {
    record.get(key).and_then(JsonValue::as_f64)
}

fn read_json_array(record: &JsonValue, key: &str) -> Vec<JsonValue> {
    record
        .get(key)
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default()
}

fn compact_json(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(map) => JsonValue::Object(
            map.into_iter()
                .filter_map(|(key, value)| {
                    let value = compact_json(value);
                    (!value.is_null()).then_some((key, value))
                })
                .collect(),
        ),
        JsonValue::Array(items) => JsonValue::Array(items.into_iter().map(compact_json).collect()),
        other => other,
    }
}

fn proposal_draft(
    operation: &str,
    payload: JsonValue,
    src: &JsonValue,
    fallback_rationale: &str,
) -> Option<JsonValue> {
    let payload = compact_json(payload);
    if !payload.is_object() || payload.as_object().is_none_or(serde_json::Map::is_empty) {
        return None;
    }
    let mut draft = serde_json::Map::new();
    draft.insert(
        "operation".to_string(),
        JsonValue::String(operation.to_string()),
    );
    draft.insert("payload".to_string(), payload);
    if let Some(confidence) = read_json_number(src, "confidence") {
        draft.insert("confidence".to_string(), json!(confidence));
    }
    draft.insert(
        "rationale".to_string(),
        JsonValue::String(
            read_json_string(src, "rationale")
                .or_else(|| read_json_string(src, "reason"))
                .unwrap_or_else(|| fallback_rationale.to_string()),
        ),
    );
    draft.insert(
        "evidence".to_string(),
        JsonValue::Array(read_json_array(src, "evidence")),
    );
    if let Some(risk) = read_json_string(src, "risk") {
        draft.insert("risk".to_string(), JsonValue::String(risk));
    }
    Some(JsonValue::Object(draft))
}

fn normalize_extraction_proposals(root: &JsonValue) -> Vec<JsonValue> {
    let mut proposals = Vec::new();
    for item in read_json_array(root, "entities") {
        if let Some(name) = read_json_string(&item, "name") {
            proposals.push(proposal_draft(
                "create_entity",
                json!({
                    "name": name,
                    "entity_type": read_json_string(&item, "type")
                        .or_else(|| read_json_string(&item, "entity_type")),
                }),
                &item,
                "Extracted entity candidate from source evidence.",
            ));
        }
    }
    for item in read_json_array(root, "claim_values") {
        if let (Some(entity), Some(aspect), Some(claim_key), Some(value)) = (
            read_json_string(&item, "entity"),
            read_json_string(&item, "aspect"),
            read_json_string(&item, "claim_key"),
            read_json_string(&item, "value"),
        ) {
            proposals.push(proposal_draft(
                "add_claim_value",
                json!({
                    "entity": entity,
                    "entity_type": read_json_string(&item, "entity_type"),
                    "aspect": aspect,
                    "group_key": read_json_string(&item, "group_key"),
                    "claim_key": claim_key,
                    "value": value,
                    "visibility": read_json_string(&item, "visibility"),
                    "reducer_hint": read_json_string(&item, "reducer_hint"),
                    "confidence": read_json_number(&item, "confidence"),
                }),
                &item,
                "Extracted claim value candidate from source evidence.",
            ));
        }
    }
    for item in read_json_array(root, "links") {
        if let (Some(source_entity), Some(target_entity), Some(link_type)) = (
            read_json_string(&item, "source_entity"),
            read_json_string(&item, "target_entity"),
            read_json_string(&item, "link_type"),
        ) {
            proposals.push(proposal_draft(
                "create_link",
                json!({
                    "source_entity": source_entity,
                    "source_type": read_json_string(&item, "source_type"),
                    "link_type": link_type,
                    "target_entity": target_entity,
                    "target_type": read_json_string(&item, "target_type"),
                    "properties": item.get("properties").cloned(),
                    "reason": read_json_string(&item, "reason"),
                    "confidence": read_json_number(&item, "confidence"),
                }),
                &item,
                "Extracted typed link candidate from source evidence.",
            ));
        }
    }
    for item in read_json_array(root, "actions_or_policies") {
        if let (Some(target), Some(kind), Some(content)) = (
            read_json_string(&item, "target_entity"),
            read_json_string(&item, "kind"),
            read_json_string(&item, "content"),
        ) {
            proposals.push(proposal_draft(
                "create_policy",
                json!({"target_entity": target, "kind": kind, "content": content}),
                &item,
                "Extracted action or policy candidate from source evidence.",
            ));
        }
    }
    proposals.into_iter().flatten().collect()
}

fn normalize_extraction_assertions(root: &JsonValue) -> Vec<JsonValue> {
    read_json_array(root, "assertions")
        .into_iter()
        .filter_map(|item| {
            let entity = read_json_string(&item, "entity");
            let entity_id = read_json_string(&item, "entity_id");
            let content =
                read_json_string(&item, "content").or_else(|| read_json_string(&item, "value"))?;
            if entity.is_none() && entity_id.is_none() {
                return None;
            }
            Some(json!({
                "entity": entity,
                "entity_id": entity_id,
                "predicate": read_json_string(&item, "predicate").unwrap_or_else(|| "claims".to_string()),
                "content": content,
                "speaker": read_json_string(&item, "speaker"),
                "asserted_at": read_json_string(&item, "asserted_at").or_else(|| read_json_string(&item, "when")),
                "confidence": read_json_number(&item, "confidence"),
                "evidence": read_json_array(&item, "evidence"),
                "source_kind": read_json_string(&item, "source_kind"),
                "source_id": read_json_string(&item, "source_id"),
                "source_path": read_json_string(&item, "source_path"),
                "source_root": read_json_string(&item, "source_root"),
                "claim_attribute_id": read_json_string(&item, "claim_attribute_id"),
            }))
        })
        .collect()
}

fn normalize_proposal_json(raw: &JsonValue) -> (Vec<JsonValue>, Vec<JsonValue>, Vec<String>) {
    if let Some(items) = raw.as_array() {
        return (
            items
                .iter()
                .filter_map(|item| {
                    proposal_draft(
                        &read_json_string(item, "operation")?,
                        item.get("payload").cloned().unwrap_or_else(|| json!({})),
                        item,
                        "Imported ontology proposal.",
                    )
                })
                .collect(),
            Vec::new(),
            Vec::new(),
        );
    }
    if !raw.is_object() {
        return (Vec::new(), Vec::new(), Vec::new());
    }
    let explicit = read_json_array(raw, "proposals");
    let proposals = if explicit.is_empty() {
        normalize_extraction_proposals(raw)
    } else {
        explicit
            .iter()
            .filter_map(|item| {
                proposal_draft(
                    &read_json_string(item, "operation")?,
                    item.get("payload").cloned().unwrap_or_else(|| json!({})),
                    item,
                    "Imported ontology proposal.",
                )
            })
            .collect()
    };
    let questions = read_json_array(raw, "questions")
        .into_iter()
        .filter_map(|item| item.as_str().map(str::trim).map(ToOwned::to_owned))
        .filter(|item| !item.is_empty())
        .collect();
    (proposals, normalize_extraction_assertions(raw), questions)
}

fn json_blocks(content: &str) -> Vec<JsonValue> {
    if let Ok(parsed) = serde_json::from_str::<JsonValue>(content) {
        return vec![parsed];
    }
    let mut items = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("```") {
        rest = &rest[start + 3..];
        let Some(newline) = rest.find('\n') else {
            break;
        };
        let label = rest[..newline].trim();
        rest = &rest[newline + 1..];
        let Some(end) = rest.find("```") else {
            break;
        };
        let block = rest[..end].trim();
        if (label.is_empty() || label.eq_ignore_ascii_case("json"))
            && let Ok(parsed) = serde_json::from_str::<JsonValue>(block)
        {
            items.push(parsed);
        }
        rest = &rest[end + 3..];
    }
    items
}

fn source_evidence(source: &ExtractionSource, quote: &str) -> Vec<JsonValue> {
    vec![json!({
        "source_kind": source.source_kind,
        "source_id": source.source_id,
        "source_path": source.source_path,
        "quote": quote,
    })]
}

fn claim_key_for(value: &str) -> String {
    let words = value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join("_");
    if words.is_empty() {
        "extracted_claim".to_string()
    } else {
        words
    }
}

fn normalize_name(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn mechanical_entity_proposals(source: &ExtractionSource) -> Vec<JsonValue> {
    let mut seen = std::collections::HashSet::new();
    let mut proposals = Vec::new();
    let mut rest = source.content.as_str();
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else {
            break;
        };
        let raw = &rest[..end];
        let name = normalize_name(raw.split(['|', '#']).next().unwrap_or_default().trim());
        rest = &rest[end + 2..];
        if name.len() < 2 || !seen.insert(canonical(&name)) {
            continue;
        }
        proposals.push(json!({
            "operation": "create_entity",
            "payload": {"name": name, "entity_type": "concept"},
            "confidence": 0.7,
            "rationale": "Detected explicit wikilink entity in source text.",
            "evidence": source_evidence(source, &format!("[[{name}]]")),
            "risk": "low",
        }));
        if proposals.len() >= 50 {
            break;
        }
    }
    proposals
}

fn mechanical_claim_proposals(source: &ExtractionSource) -> Vec<JsonValue> {
    let blocked = ["User", "Assistant", "The", "This", "That", "It", "I", "We"];
    let text = source
        .content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut seen = std::collections::HashSet::new();
    let mut proposals = Vec::new();
    for sentence in text.split(['.', '!', '?']) {
        let sentence = normalize_name(sentence);
        let Some((verb, pos)) = [" should ", " must ", " needs to ", " is ", " are "]
            .iter()
            .find_map(|verb| sentence.find(verb).map(|pos| (*verb, pos)))
        else {
            continue;
        };
        let entity = normalize_name(&sentence[..pos]);
        let rest = normalize_name(&sentence[pos + verb.len()..]);
        let first = entity.split_whitespace().next().unwrap_or_default();
        if blocked.contains(&first)
            || entity.len() < 2
            || !entity
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_uppercase())
            || rest.len() < 12
        {
            continue;
        }
        let verb_clean = verb.trim();
        let value = format!("{entity} {verb_clean} {rest}.");
        let key = format!("{}:{}", canonical(&entity), canonical(&value));
        if !seen.insert(key) {
            continue;
        }
        proposals.push(json!({
            "operation": "add_claim_value",
            "payload": {
                "entity": entity,
                "entity_type": "concept",
                "aspect": "extracted",
                "group_key": "transcript",
                "claim_key": claim_key_for(&format!("{verb_clean} {rest}")),
                "value": value,
            },
            "confidence": 0.55,
            "rationale": "Detected explicit sentence-level claim in source text.",
            "evidence": source_evidence(source, &value),
            "risk": "medium",
        }));
        if proposals.len() >= 50 {
            break;
        }
    }
    proposals
}

fn mechanical_link_proposals(source: &ExtractionSource) -> Vec<JsonValue> {
    let text = source
        .content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let link_types = [
        " supports ",
        " requires ",
        " blocks ",
        " uses ",
        " contains ",
        " implements ",
        " maintains ",
        " informs ",
    ];
    let mut seen = std::collections::HashSet::new();
    let mut proposals = Vec::new();
    for sentence in text.split(['.', '!', '?', ',']) {
        let sentence = normalize_name(sentence);
        let Some((link, pos)) = link_types
            .iter()
            .find_map(|link| sentence.find(link).map(|pos| (*link, pos)))
        else {
            continue;
        };
        let source_entity = normalize_name(&sentence[..pos]);
        let target_entity = normalize_name(&sentence[pos + link.len()..]);
        if source_entity.len() < 2
            || target_entity.len() < 2
            || !source_entity
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_uppercase())
            || !target_entity
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_uppercase())
        {
            continue;
        }
        let link_clean = link.trim();
        let key = format!(
            "{}:{link_clean}:{}",
            canonical(&source_entity),
            canonical(&target_entity)
        );
        if !seen.insert(key) {
            continue;
        }
        let link_type = if link_clean == "supports" {
            "supports_claim"
        } else {
            link_clean
        };
        let quote = format!("{source_entity} {link_clean} {target_entity}");
        proposals.push(json!({
            "operation": "create_link",
            "payload": {
                "source_entity": source_entity,
                "source_type": "concept",
                "link_type": link_type,
                "target_entity": target_entity,
                "target_type": "concept",
                "reason": "Detected explicit relationship statement in source text.",
            },
            "confidence": 0.58,
            "rationale": "Detected explicit relationship statement in source text.",
            "evidence": source_evidence(source, &quote),
            "risk": "medium",
        }));
        if proposals.len() >= 50 {
            break;
        }
    }
    proposals
}

fn dedupe_proposals(proposals: Vec<JsonValue>, limit: usize) -> Vec<JsonValue> {
    let mut seen = std::collections::HashSet::new();
    proposals
        .into_iter()
        .filter(|proposal| {
            let key = json!([proposal.get("operation"), proposal.get("payload")]).to_string();
            seen.insert(key)
        })
        .take(limit)
        .collect()
}

fn proposal_prompt_value(row: &ProposalRow) -> JsonValue {
    json!({
        "id": row.id,
        "operation": row.operation,
        "payload": parse_json(&row.payload, json!({})),
        "confidence": row.confidence,
        "rationale": row.rationale,
        "evidence": parse_json(&row.evidence, json!([])),
        "risk": row.risk,
        "sourceKind": row.source_kind,
        "sourceId": row.source_id,
        "sourcePath": row.source_path,
        "createdAt": row.created_at,
    })
}

fn consolidation_prompt(source: &[JsonValue], conflicts: &[JsonValue]) -> String {
    format!(
        r#"You are performing Signet ontology consolidation.

Goal:
Turn noisy pending ontology proposals into a compact set of stable ontology proposals.
Do not mutate the ontology. Output proposals only.

Rules:
1. Contact is not meaning. Do not preserve every mention.
2. Prefer existing proposal operations: create_entity, add_claim_value, supersede_claim_value, create_link, merge_entities.
3. Prefer claim slots with multiple values over destructive overwrites.
4. Preserve provenance for every promoted value.
5. Mark weak, temporary, duplicate, or ambiguous candidates as rejections instead of promoting them.
6. Return ONLY JSON.

Return JSON:
{{
  "summary": "what changed and why",
  "proposals": [
    {{
      "operation": "create_entity|add_claim_value|supersede_claim_value|create_link|merge_entities",
      "payload": {{}},
      "confidence": 0.0,
      "rationale": "string",
      "evidence": [{{ "source_kind": "ontology_proposal", "source_id": "proposal-id", "quote": "why this proposal was used" }}],
      "risk": "low|medium|high"
    }}
  ],
  "rejections": [
    {{ "candidate_id": "string", "reason": "duplicate|weak_evidence|temporary_task|not_durable|ambiguous|contradicted" }}
  ],
  "conflicts": [
    {{ "claim_slot": "string", "values": ["..."], "recommended_reducer": "string", "needs_review": true }}
  ],
  "maintenance": [
    {{ "operation": "request_review|mark_stale|merge_duplicate", "target": "string", "reason": "string" }}
  ]
}}

Pending proposals:
{}

Current conflicts:
{}"#,
        serde_json::to_string_pretty(source).unwrap_or_else(|_| "[]".to_string()),
        serde_json::to_string_pretty(conflicts).unwrap_or_else(|_| "[]".to_string())
    )
}

fn normalize_consolidation_promotions(root: &JsonValue) -> Vec<JsonValue> {
    read_json_array(root, "promotions")
        .into_iter()
        .filter_map(|item| {
            proposal_draft(
                &read_json_string(&item, "operation")?,
                item.get("payload")
                    .or_else(|| item.get("target"))
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                &item,
                "Consolidated noisy candidates into a stable ontology proposal.",
            )
        })
        .collect()
}

fn parse_consolidation_output(
    raw: &str,
    limit: usize,
) -> (
    Vec<JsonValue>,
    Option<String>,
    Vec<JsonValue>,
    Vec<JsonValue>,
    Vec<JsonValue>,
) {
    for root in json_blocks(raw) {
        if !root.is_object() {
            continue;
        }
        let (explicit, _, _) = normalize_proposal_json(&root);
        let mut proposals = explicit;
        proposals.extend(normalize_consolidation_promotions(&root));
        return (
            dedupe_proposals(proposals, limit),
            read_json_string(&root, "summary"),
            read_json_array(&root, "rejections"),
            read_json_array(&root, "conflicts"),
            read_json_array(&root, "maintenance"),
        );
    }
    (Vec::new(), None, Vec::new(), Vec::new(), Vec::new())
}

fn claim_conflict_values(
    conn: &rusqlite::Connection,
    agent_id: &str,
    limit: i64,
) -> Result<Vec<JsonValue>, CoreError> {
    let rows = conn
        .prepare(&format!(
            "{SELECT_PROPOSAL}
             WHERE agent_id = ?1 AND status = 'pending' AND operation = 'add_claim_value'
             ORDER BY updated_at DESC
             LIMIT ?2"
        ))?
        .query_map(rusqlite::params![agent_id, limit], read_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let mut groups = std::collections::BTreeMap::<String, JsonValue>::new();
    for row in rows {
        let payload = parse_json(&row.payload, json!({}));
        let Some(entity) = read_payload_string(&payload, "entity") else {
            continue;
        };
        let Some(aspect) = read_payload_string(&payload, "aspect") else {
            continue;
        };
        let Some(claim_key) = read_payload_string(&payload, "claim_key") else {
            continue;
        };
        let Some(value) = read_payload_string(&payload, "value") else {
            continue;
        };
        let group_key =
            read_payload_string(&payload, "group_key").unwrap_or_else(|| "general".to_string());
        let key = [
            canonical(&entity),
            canonical(&aspect),
            canonical(&group_key),
            canonical(&claim_key),
        ]
        .join("\0");
        let entry = groups.entry(key).or_insert_with(|| {
            json!({
                "entity": entity,
                "aspect": aspect,
                "groupKey": group_key,
                "claimKey": claim_key,
                "values": [],
                "proposalIds": [],
                "count": 0,
            })
        });
        if let Some(values) = entry.get_mut("values").and_then(JsonValue::as_array_mut) {
            values.push(json!({
                "proposalId": row.id.clone(),
                "value": value,
                "confidence": row.confidence,
                "rationale": row.rationale,
                "evidenceCount": parse_json(&row.evidence, json!([])).as_array().map_or(0, Vec::len),
            }));
        }
        if let Some(ids) = entry
            .get_mut("proposalIds")
            .and_then(JsonValue::as_array_mut)
        {
            ids.push(JsonValue::String(row.id));
        }
        let count = entry.get("count").and_then(JsonValue::as_i64).unwrap_or(0) + 1;
        entry["count"] = JsonValue::Number(count.into());
    }
    Ok(groups
        .into_values()
        .filter(|group| {
            let values = group
                .get("values")
                .and_then(JsonValue::as_array)
                .cloned()
                .unwrap_or_default();
            values
                .into_iter()
                .filter_map(|item| item.get("value").and_then(JsonValue::as_str).map(canonical))
                .collect::<std::collections::HashSet<_>>()
                .len()
                > 1
        })
        .collect())
}

fn extracted_proposals_and_assertions(
    source: &ExtractionSource,
    limit: usize,
) -> (Vec<JsonValue>, Vec<JsonValue>, Vec<String>) {
    let parsed = json_blocks(&source.content)
        .iter()
        .map(normalize_proposal_json)
        .collect::<Vec<_>>();
    let mut explicit_proposals = Vec::new();
    let mut explicit_assertions = Vec::new();
    let mut questions = Vec::new();
    for (proposals, assertions, parsed_questions) in parsed {
        explicit_proposals.extend(proposals);
        explicit_assertions.extend(assertions);
        questions.extend(parsed_questions);
    }
    let proposals = dedupe_proposals(
        [
            explicit_proposals,
            mechanical_entity_proposals(source),
            mechanical_claim_proposals(source),
            mechanical_link_proposals(source),
        ]
        .concat(),
        limit,
    )
    .into_iter()
    .map(|mut proposal| {
        if proposal
            .get("evidence")
            .and_then(JsonValue::as_array)
            .is_none_or(Vec::is_empty)
            && let Some(object) = proposal.as_object_mut()
        {
            object.insert(
                "evidence".to_string(),
                JsonValue::Array(source_evidence(source, &source.id)),
            );
        }
        proposal
    })
    .collect();
    questions.sort();
    questions.dedup();
    (
        proposals,
        explicit_assertions.into_iter().take(limit).collect(),
        questions,
    )
}

fn resolve_assertion_subject(
    conn: &rusqlite::Connection,
    agent_id: &str,
    assertion: &JsonValue,
) -> Result<(String, String), CoreError> {
    if let Some(id) = read_json_string(assertion, "entity_id") {
        return conn
            .query_row(
                "SELECT id, name FROM entities
                 WHERE id = ?1 AND agent_id = ?2 AND COALESCE(status, 'active') = 'active'",
                rusqlite::params![id, agent_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound("entity_id was not found".to_string()));
    }
    let entity = read_json_string(assertion, "entity")
        .ok_or_else(|| CoreError::Invalid("entity or entity_id is required".to_string()))?;
    let key = canonical(&entity);
    conn.query_row(
        "SELECT id, name FROM entities
         WHERE agent_id = ?1
           AND COALESCE(status, 'active') = 'active'
           AND (COALESCE(canonical_name, LOWER(name)) = ?2 OR LOWER(name) = ?3)
         ORDER BY updated_at DESC
         LIMIT 1",
        rusqlite::params![agent_id, key, key],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .optional()?
    .ok_or_else(|| CoreError::NotFound("entity was not found".to_string()))
}

fn assertion_row_to_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<JsonValue> {
    let evidence: String = row.get("evidence")?;
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "agentId": row.get::<_, String>("agent_id")?,
        "subjectEntityId": row.get::<_, String>("subject_entity_id")?,
        "subjectEntityName": row.get::<_, Option<String>>("subject_entity_name")?,
        "claimAttributeId": row.get::<_, Option<String>>("claim_attribute_id")?,
        "predicate": row.get::<_, String>("predicate")?,
        "content": row.get::<_, String>("content")?,
        "normalizedContent": row.get::<_, String>("normalized_content")?,
        "speaker": row.get::<_, Option<String>>("speaker")?,
        "assertedAt": row.get::<_, String>("asserted_at")?,
        "confidence": row.get::<_, f64>("confidence")?,
        "evidence": parse_json(&evidence, json!([])),
        "sourceKind": row.get::<_, Option<String>>("source_kind")?,
        "sourceId": row.get::<_, Option<String>>("source_id")?,
        "sourcePath": row.get::<_, Option<String>>("source_path")?,
        "sourceRoot": row.get::<_, Option<String>>("source_root")?,
        "status": row.get::<_, String>("status")?,
        "supersedesAssertionId": row.get::<_, Option<String>>("supersedes_assertion_id")?,
        "archivedAt": row.get::<_, Option<String>>("archived_at")?,
        "archivedBy": row.get::<_, Option<String>>("archived_by")?,
        "archiveReason": row.get::<_, Option<String>>("archive_reason")?,
        "createdBy": row.get::<_, String>("created_by")?,
        "createdAt": row.get::<_, String>("created_at")?,
        "updatedAt": row.get::<_, String>("updated_at")?,
    }))
}

fn insert_assertion(
    conn: &rusqlite::Connection,
    agent_id: &str,
    source: Option<&ExtractionSource>,
    assertion: &JsonValue,
    created_by: &str,
) -> Result<JsonValue, CoreError> {
    let predicates = [
        "claims",
        "believes",
        "observed",
        "decided",
        "prefers",
        "denies",
        "questions",
    ];
    let predicate =
        read_json_string(assertion, "predicate").unwrap_or_else(|| "claims".to_string());
    if !predicates.contains(&predicate.as_str()) {
        return Err(CoreError::Invalid("predicate is invalid".to_string()));
    }
    let content = read_json_string(assertion, "content")
        .ok_or_else(|| CoreError::Invalid("content is required".to_string()))?;
    let (subject_id, _) = resolve_assertion_subject(conn, agent_id, assertion)?;
    let evidence = {
        let evidence = read_json_array(assertion, "evidence");
        if evidence.is_empty() {
            source
                .map(|source| source_evidence(source, &content))
                .unwrap_or_default()
        } else {
            evidence
        }
    };
    let source_kind = read_json_string(assertion, "source_kind")
        .or_else(|| source.map(|source| source.source_kind.clone()));
    let source_id = read_json_string(assertion, "source_id")
        .or_else(|| source.map(|source| source.source_id.clone()));
    let source_path = read_json_string(assertion, "source_path")
        .or_else(|| source.and_then(|source| source.source_path.clone()));
    let source_root = read_json_string(assertion, "source_root");
    if evidence.is_empty()
        && source_kind.is_none()
        && source_id.is_none()
        && source_path.is_none()
        && source_root.is_none()
    {
        return Err(CoreError::Invalid(
            "evidence or source provenance is required".to_string(),
        ));
    }
    let asserted_at = match read_json_string(assertion, "asserted_at") {
        Some(raw) => chrono::DateTime::parse_from_rfc3339(&raw)
            .map_err(|_| CoreError::Invalid("asserted_at is invalid".to_string()))?
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        None => now(),
    };
    let claim_attribute_id = read_json_string(assertion, "claim_attribute_id");
    if let Some(attribute_id) = claim_attribute_id.as_deref() {
        let matches_subject = conn
            .query_row(
                "SELECT asp.entity_id
                 FROM entity_attributes attr
                 JOIN entity_aspects asp ON asp.id = attr.aspect_id AND asp.agent_id = attr.agent_id
                 WHERE attr.id = ?1 AND attr.agent_id = ?2 AND attr.status = 'active'",
                rusqlite::params![attribute_id, agent_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match matches_subject {
            Some(entity_id) if entity_id == subject_id => {}
            Some(_) => {
                return Err(CoreError::Conflict(
                    "claim attribute belongs to a different entity".to_string(),
                ));
            }
            None => {
                return Err(CoreError::NotFound(
                    "claim attribute was not found".to_string(),
                ));
            }
        }
    }
    let id = Uuid::new_v4().to_string();
    let ts = now();
    let normalized = content
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let confidence = read_json_number(assertion, "confidence")
        .unwrap_or(0.7)
        .clamp(0.0, 1.0);
    conn.execute(
        "INSERT INTO epistemic_assertions
         (id, agent_id, subject_entity_id, claim_attribute_id, predicate,
          content, normalized_content, speaker, asserted_at, confidence, evidence,
          source_kind, source_id, source_path, source_root, status,
          supersedes_assertion_id, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 'active', ?16, ?17, ?18, ?18)",
        rusqlite::params![
            id,
            agent_id,
            subject_id,
            claim_attribute_id,
            predicate,
            content,
            normalized,
            read_json_string(assertion, "speaker"),
            asserted_at,
            confidence,
            serde_json::to_string(&evidence)?,
            source_kind,
            source_id,
            source_path,
            source_root,
            read_json_string(assertion, "supersedes_assertion_id"),
            created_by,
            ts,
        ],
    )?;
    conn.query_row(
        "SELECT a.*, e.name AS subject_entity_name
         FROM epistemic_assertions a
         JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
         WHERE a.id = ?1 AND a.agent_id = ?2",
        rusqlite::params![id, agent_id],
        assertion_row_to_value,
    )
    .map_err(Into::into)
}

fn assertion_error(error: CoreError) -> Response {
    match error {
        CoreError::Invalid(message) => json_error(StatusCode::BAD_REQUEST, &message),
        CoreError::NotFound(message) => json_error(StatusCode::NOT_FOUND, &message),
        CoreError::Conflict(message) => json_error(StatusCode::CONFLICT, &message),
        other => json_error(StatusCode::INTERNAL_SERVER_ERROR, &other.to_string()),
    }
}

fn valid_assertion_predicate(predicate: &str) -> bool {
    matches!(
        predicate,
        "claims" | "believes" | "observed" | "decided" | "prefers" | "denies" | "questions"
    )
}

fn valid_assertion_status(status: &str) -> bool {
    matches!(status, "active" | "archived" | "superseded" | "all")
}

fn normalized_content(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn get_assertion_value(
    conn: &rusqlite::Connection,
    agent_id: &str,
    id: &str,
) -> Result<Option<JsonValue>, CoreError> {
    conn.query_row(
        "SELECT a.*, e.name AS subject_entity_name
         FROM epistemic_assertions a
         JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
         WHERE a.id = ?1 AND a.agent_id = ?2",
        rusqlite::params![id, agent_id],
        assertion_row_to_value,
    )
    .optional()
    .map_err(Into::into)
}

fn list_assertion_values(
    conn: &rusqlite::Connection,
    agent_id: &str,
    query: AssertionQuery,
) -> Result<JsonValue, CoreError> {
    if let Some(predicate) = query.predicate.as_deref().map(str::trim)
        && !predicate.is_empty()
        && !valid_assertion_predicate(predicate)
    {
        return Err(CoreError::Invalid("predicate is invalid".to_string()));
    }
    if let Some(status) = query.status.as_deref().map(str::trim)
        && !status.is_empty()
        && !valid_assertion_status(status)
    {
        return Err(CoreError::Invalid("status is invalid".to_string()));
    }

    let mut where_parts = vec!["a.agent_id = ?".to_string()];
    let mut args = vec![Value::Text(agent_id.to_string())];
    if let Some(entity_id) = clean(query.entity_id) {
        where_parts.push("a.subject_entity_id = ?".to_string());
        args.push(Value::Text(entity_id));
    } else if let Some(entity) = clean(query.entity) {
        let Some(entity_id) = resolve_entity(conn, agent_id, &entity)? else {
            return Ok(json!({"items": [], "count": 0}));
        };
        where_parts.push("a.subject_entity_id = ?".to_string());
        args.push(Value::Text(entity_id));
    }
    if query.status.as_deref().map(str::trim) != Some("all") {
        where_parts.push("a.status = ?".to_string());
        args.push(Value::Text(
            clean(query.status).unwrap_or_else(|| "active".to_string()),
        ));
    }
    if let Some(predicate) = clean(query.predicate) {
        where_parts.push("a.predicate = ?".to_string());
        args.push(Value::Text(predicate));
    }
    if let Some(speaker) = clean(query.speaker) {
        where_parts.push("a.speaker = ?".to_string());
        args.push(Value::Text(speaker));
    }
    if let Some(source_kind) = clean(query.source_kind) {
        where_parts.push("a.source_kind = ?".to_string());
        args.push(Value::Text(source_kind));
    }
    if let Some(source_id) = clean(query.source_id) {
        where_parts.push("a.source_id = ?".to_string());
        args.push(Value::Text(source_id));
    }
    if let Some(text_query) = clean(query.query) {
        where_parts.push("a.normalized_content LIKE ?".to_string());
        args.push(Value::Text(format!(
            "%{}%",
            normalized_content(&text_query)
        )));
    }
    let clause = where_parts.join(" AND ");
    let count_sql = format!(
        "SELECT COUNT(*) FROM epistemic_assertions a
         JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
         WHERE {clause}"
    );
    let params = args.iter().map(|v| v as &dyn ToSql).collect::<Vec<_>>();
    let count: i64 = conn.query_row(&count_sql, params.as_slice(), |row| row.get(0))?;

    let limit = parse_limit(query.limit.as_deref(), 50, 200);
    let offset = parse_offset(query.offset.as_deref());
    let mut select_args = args.clone();
    select_args.push(Value::Integer(limit));
    select_args.push(Value::Integer(offset));
    let select_params = select_args
        .iter()
        .map(|v| v as &dyn ToSql)
        .collect::<Vec<_>>();
    let select_sql = format!(
        "SELECT a.*, e.name AS subject_entity_name
         FROM epistemic_assertions a
         JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
         WHERE {clause}
         ORDER BY a.asserted_at DESC, a.created_at DESC
         LIMIT ? OFFSET ?"
    );
    let rows = conn
        .prepare(&select_sql)?
        .query_map(select_params.as_slice(), assertion_row_to_value)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"items": rows, "count": count}))
}

fn archive_assertion_value(
    conn: &rusqlite::Connection,
    agent_id: &str,
    id: &str,
    actor: &str,
    reason: Option<String>,
) -> Result<JsonValue, CoreError> {
    if get_assertion_value(conn, agent_id, id)?.is_none() {
        return Err(CoreError::NotFound("assertion was not found".to_string()));
    }
    let ts = now();
    conn.execute(
        "UPDATE epistemic_assertions
         SET status = 'archived', archived_at = ?1, archived_by = ?2,
             archive_reason = ?3, updated_at = ?1
         WHERE id = ?4 AND agent_id = ?5",
        rusqlite::params![ts, actor, reason, id, agent_id],
    )?;
    get_assertion_value(conn, agent_id, id)?
        .ok_or_else(|| CoreError::NotFound("assertion was not found".to_string()))
}

fn link_assertion_claim_value(
    conn: &rusqlite::Connection,
    agent_id: &str,
    id: &str,
    attribute_id: &str,
) -> Result<JsonValue, CoreError> {
    let subject_id = conn
        .query_row(
            "SELECT subject_entity_id FROM epistemic_assertions WHERE id = ?1 AND agent_id = ?2",
            rusqlite::params![id, agent_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound("assertion was not found".to_string()))?;
    let attribute_entity = conn
        .query_row(
            "SELECT asp.entity_id
             FROM entity_attributes attr
             JOIN entity_aspects asp ON asp.id = attr.aspect_id AND asp.agent_id = attr.agent_id
             WHERE attr.id = ?1 AND attr.agent_id = ?2 AND attr.status = 'active'",
            rusqlite::params![attribute_id, agent_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound("claim attribute was not found".to_string()))?;
    if attribute_entity != subject_id {
        return Err(CoreError::Conflict(
            "claim attribute belongs to a different entity".to_string(),
        ));
    }
    conn.execute(
        "UPDATE epistemic_assertions
         SET claim_attribute_id = ?1, updated_at = ?2
         WHERE id = ?3 AND agent_id = ?4",
        rusqlite::params![attribute_id, now(), id, agent_id],
    )?;
    get_assertion_value(conn, agent_id, id)?
        .ok_or_else(|| CoreError::NotFound("assertion was not found".to_string()))
}

fn body_with_string(body: &JsonValue, key: &str, value: String) -> JsonValue {
    let mut object = body.as_object().cloned().unwrap_or_default();
    object.insert(key.to_string(), JsonValue::String(value));
    JsonValue::Object(object)
}

fn supersede_assertion_value(
    conn: &rusqlite::Connection,
    agent_id: &str,
    id: &str,
    body: JsonValue,
    created_by: &str,
) -> Result<JsonValue, CoreError> {
    let old = conn
        .query_row(
            "SELECT a.*, e.name AS subject_entity_name
             FROM epistemic_assertions a
             JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
             WHERE a.id = ?1 AND a.agent_id = ?2",
            rusqlite::params![id, agent_id],
            assertion_row_to_value,
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound("assertion was not found".to_string()))?;
    if read_json_string(&body, "entity").is_some() || read_json_string(&body, "entity_id").is_some()
    {
        let (subject_id, _) = resolve_assertion_subject(conn, agent_id, &body)?;
        if Some(subject_id.as_str()) != old["subjectEntityId"].as_str() {
            return Err(CoreError::Conflict(
                "supersede cannot change assertion subject entity".to_string(),
            ));
        }
    }
    let mut next = body_with_string(
        &body,
        "entity_id",
        old["subjectEntityId"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    );
    if read_json_string(&next, "predicate").is_none() {
        next = body_with_string(
            &next,
            "predicate",
            old["predicate"].as_str().unwrap_or("claims").to_string(),
        );
    }
    for (snake, camel) in [
        ("speaker", "speaker"),
        ("source_kind", "sourceKind"),
        ("source_id", "sourceId"),
        ("source_path", "sourcePath"),
        ("source_root", "sourceRoot"),
    ] {
        if read_json_string(&next, snake).is_none()
            && let Some(value) = old.get(camel).and_then(JsonValue::as_str)
        {
            next = body_with_string(&next, snake, value.to_string());
        }
    }
    next = body_with_string(&next, "supersedes_assertion_id", id.to_string());
    let created = insert_assertion(conn, agent_id, None, &next, created_by)?;
    conn.execute(
        "UPDATE epistemic_assertions
         SET status = 'superseded', updated_at = ?1
         WHERE id = ?2 AND agent_id = ?3",
        rusqlite::params![now(), id, agent_id],
    )?;
    Ok(created)
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

fn payload_selector(payload: &JsonValue, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| read_payload_string(payload, key))
}

fn proposal_evidence_json(row: &ProposalRow) -> String {
    proposal_audit_evidence(row)
}

fn force_payload(payload: &JsonValue) -> bool {
    payload.get("force").and_then(JsonValue::as_bool) == Some(true)
}

fn optional_payload_string(payload: &JsonValue, key: &str) -> Option<String> {
    payload.get(key).and_then(|value| {
        value.as_str().map(|value| value.to_string()).or_else(|| {
            if value.is_null() {
                None
            } else {
                Some(value.to_string())
            }
        })
    })
}

fn resolve_entity_row_strict(
    conn: &rusqlite::Connection,
    agent_id: &str,
    selector: &str,
) -> Result<EntityRow, CoreError> {
    let key = canonical(selector);
    let rows = conn
        .prepare(
            "SELECT *
             FROM entities
             WHERE agent_id = ?1
               AND COALESCE(status, 'active') = 'active'
               AND (id = ?2 OR COALESCE(canonical_name, LOWER(name)) = ?3 OR LOWER(name) = ?4)
             ORDER BY CASE WHEN id = ?5 THEN 0 ELSE 1 END, updated_at DESC, name ASC",
        )?
        .query_map(
            rusqlite::params![agent_id, selector, key, key, selector],
            read_entity_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    match rows.len() {
        0 => Err(CoreError::NotFound(format!("Entity not found: {selector}"))),
        1 => Ok(rows.into_iter().next().expect("one entity row")),
        _ => Err(CoreError::Conflict(format!(
            "Entity selector is ambiguous: {selector}. Use an id."
        ))),
    }
}

fn resolve_aspect_row_strict(
    conn: &rusqlite::Connection,
    agent_id: &str,
    entity_id: &str,
    selector: &str,
) -> Result<AspectRow, CoreError> {
    let key = canonical(selector);
    let rows = conn
        .prepare(
            "SELECT *
             FROM entity_aspects
             WHERE entity_id = ?1
               AND agent_id = ?2
               AND COALESCE(status, 'active') = 'active'
               AND (id = ?3 OR canonical_name = ?4 OR LOWER(name) = ?5)
             ORDER BY CASE WHEN id = ?6 THEN 0 ELSE 1 END, updated_at DESC, name ASC",
        )?
        .query_map(
            rusqlite::params![entity_id, agent_id, selector, key, key, selector],
            read_aspect_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    match rows.len() {
        0 => Err(CoreError::NotFound(format!("Aspect not found: {selector}"))),
        1 => Ok(rows.into_iter().next().expect("one aspect row")),
        _ => Err(CoreError::Conflict(format!(
            "Aspect selector is ambiguous: {selector}. Use an id."
        ))),
    }
}

#[derive(Clone)]
struct ClaimSlotRow {
    id: String,
    normalized_content: String,
    version: i64,
    version_root_id: Option<String>,
    status: String,
}

fn load_claim_slot(
    conn: &rusqlite::Connection,
    agent_id: &str,
    aspect_id: &str,
    kind: &str,
    group_key: &str,
    claim_key: &str,
) -> Result<Vec<ClaimSlotRow>, CoreError> {
    Ok(conn
        .prepare(
            "SELECT id, normalized_content, version, version_root_id, status
             FROM entity_attributes
             WHERE aspect_id = ?1
               AND agent_id = ?2
               AND kind = ?3
               AND COALESCE(group_key, 'general') = ?4
               AND claim_key = ?5
             ORDER BY version DESC, updated_at DESC",
        )?
        .query_map(
            rusqlite::params![aspect_id, agent_id, kind, group_key, claim_key],
            |r| {
                Ok(ClaimSlotRow {
                    id: r.get::<_, String>(0)?,
                    normalized_content: r.get::<_, String>(1)?,
                    version: r.get::<_, Option<i64>>(2)?.unwrap_or(1),
                    version_root_id: r.get::<_, Option<String>>(3)?,
                    status: r.get::<_, String>(4)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?)
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn source_merge_specs(
    payload: &JsonValue,
) -> Result<Vec<(Option<String>, Option<String>)>, CoreError> {
    let mut selectors = Vec::new();
    for value in read_body_string_array(payload, "source_entities") {
        push_unique(&mut selectors, value);
    }
    for value in read_body_string_array(payload, "sources") {
        push_unique(&mut selectors, value);
    }
    if let Some(source) = read_payload_string(payload, "source_entity") {
        push_unique(&mut selectors, source);
    }
    if let Some(source) = read_payload_string(payload, "source") {
        push_unique(&mut selectors, source);
    }
    let mut ids = Vec::new();
    for value in read_body_string_array(payload, "source_entity_ids") {
        push_unique(&mut ids, value);
    }
    for value in read_body_string_array(payload, "source_ids") {
        push_unique(&mut ids, value);
    }
    if let Some(id) = read_payload_string(payload, "source_entity_id") {
        push_unique(&mut ids, id);
    }
    if let Some(id) = read_payload_string(payload, "source_id") {
        push_unique(&mut ids, id);
    }
    if !ids.is_empty() {
        if selectors.len() > ids.len() {
            return Err(CoreError::Invalid(
                "payload.source_entities and payload.source_entity_ids must match".to_string(),
            ));
        }
        return Ok(ids
            .into_iter()
            .enumerate()
            .map(|(index, id)| (selectors.get(index).cloned(), Some(id)))
            .collect());
    }
    Ok(selectors
        .into_iter()
        .map(|selector| (Some(selector), None))
        .collect())
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

fn apply_rename_entity(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
) -> Result<JsonValue, CoreError> {
    let selector = payload_selector(payload, &["selector", "entity", "entity_id", "name"])
        .ok_or_else(|| CoreError::Invalid("payload.selector is required".to_string()))?;
    let name = read_payload_string(payload, "new_name")
        .ok_or_else(|| CoreError::Invalid("payload.new_name is required".to_string()))?;
    let entity = resolve_entity_row_strict(conn, &row.agent_id, &selector)?;
    let key = canonical(&name);
    if let Some(collision) = conn
        .query_row(
            "SELECT name
             FROM entities
             WHERE agent_id = ?1
               AND id != ?2
               AND COALESCE(status, 'active') = 'active'
               AND (COALESCE(canonical_name, LOWER(name)) = ?3 OR LOWER(name) = ?4)
             LIMIT 1",
            rusqlite::params![row.agent_id, entity.id, key, key],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        return Err(CoreError::Conflict(format!(
            "Entity canonical name collides with \"{collision}\". Use merge_entities instead."
        )));
    }
    conn.execute(
        "UPDATE entities
         SET name = ?1, canonical_name = ?2, proposal_id = ?3, proposal_evidence = ?4, updated_at = ?5
         WHERE id = ?6 AND agent_id = ?7",
        rusqlite::params![
            name,
            key,
            row.id,
            proposal_evidence_json(row),
            now(),
            entity.id,
            row.agent_id
        ],
    )?;
    Ok(json!({"entityId": entity.id, "oldName": entity.name, "newName": name}))
}

fn apply_archive_entity(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
    actor: &str,
) -> Result<JsonValue, CoreError> {
    let selector = payload_selector(payload, &["selector", "entity", "entity_id", "name"])
        .ok_or_else(|| CoreError::Invalid("payload.selector is required".to_string()))?;
    let entity = resolve_entity_row_strict(conn, &row.agent_id, &selector)?;
    if entity.pinned && !force_payload(payload) {
        return Err(CoreError::Conflict(
            "Refusing to archive pinned entity without force".to_string(),
        ));
    }
    conn.execute(
        "UPDATE entities
         SET status = 'archived', archived_at = ?1, archived_by = ?2,
             archive_reason = ?3, proposal_id = ?4, proposal_evidence = ?5, updated_at = ?1
         WHERE id = ?6 AND agent_id = ?7",
        rusqlite::params![
            now(),
            actor,
            read_payload_string(payload, "reason").unwrap_or_else(|| row.rationale.clone()),
            row.id,
            proposal_evidence_json(row),
            entity.id,
            row.agent_id
        ],
    )?;
    Ok(json!({"entityId": entity.id, "archived": true}))
}

fn apply_create_aspect(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
) -> Result<JsonValue, CoreError> {
    let entity_selector = payload_selector(payload, &["entity", "entity_id"])
        .ok_or_else(|| CoreError::Invalid("payload.entity is required".to_string()))?;
    let name = read_payload_string(payload, "name")
        .or_else(|| read_payload_string(payload, "aspect"))
        .ok_or_else(|| CoreError::Invalid("payload.name is required".to_string()))?;
    let entity = resolve_entity_row_strict(conn, &row.agent_id, &entity_selector)?;
    let aspect_id = resolve_or_create_aspect(conn, &entity.id, &row.agent_id, &name)?;
    conn.execute(
        "UPDATE entity_aspects
         SET proposal_id = ?1, proposal_evidence = ?2, updated_at = ?3
         WHERE id = ?4 AND agent_id = ?5",
        rusqlite::params![
            row.id,
            proposal_evidence_json(row),
            now(),
            aspect_id,
            row.agent_id
        ],
    )?;
    Ok(json!({"entityId": entity.id, "aspectId": aspect_id, "aspect": name}))
}

fn apply_rename_aspect(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
) -> Result<JsonValue, CoreError> {
    let entity_selector = payload_selector(payload, &["entity", "entity_id"])
        .ok_or_else(|| CoreError::Invalid("payload.entity is required".to_string()))?;
    let aspect_selector =
        payload_selector(payload, &["selector", "aspect", "aspect_id", "name"])
            .ok_or_else(|| CoreError::Invalid("payload.selector is required".to_string()))?;
    let name = read_payload_string(payload, "new_name")
        .ok_or_else(|| CoreError::Invalid("payload.new_name is required".to_string()))?;
    let entity = resolve_entity_row_strict(conn, &row.agent_id, &entity_selector)?;
    let aspect = resolve_aspect_row_strict(conn, &row.agent_id, &entity.id, &aspect_selector)?;
    let key = canonical(&name);
    if let Some(collision) = conn
        .query_row(
            "SELECT name
             FROM entity_aspects
             WHERE entity_id = ?1 AND agent_id = ?2 AND id != ?3
               AND COALESCE(status, 'active') = 'active'
               AND (canonical_name = ?4 OR LOWER(name) = ?5)
             LIMIT 1",
            rusqlite::params![entity.id, row.agent_id, aspect.id, key, key],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        return Err(CoreError::Conflict(format!(
            "Aspect collides with \"{collision}\""
        )));
    }
    conn.execute(
        "UPDATE entity_aspects
         SET name = ?1, canonical_name = ?2, proposal_id = ?3, proposal_evidence = ?4, updated_at = ?5
         WHERE id = ?6 AND agent_id = ?7",
        rusqlite::params![
            name,
            key,
            row.id,
            proposal_evidence_json(row),
            now(),
            aspect.id,
            row.agent_id
        ],
    )?;
    Ok(
        json!({"entityId": entity.id, "aspectId": aspect.id, "oldName": aspect.name, "newName": name}),
    )
}

fn apply_archive_aspect(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
    actor: &str,
) -> Result<JsonValue, CoreError> {
    let entity_selector = payload_selector(payload, &["entity", "entity_id"])
        .ok_or_else(|| CoreError::Invalid("payload.entity is required".to_string()))?;
    let aspect_selector =
        payload_selector(payload, &["selector", "aspect", "aspect_id", "name"])
            .ok_or_else(|| CoreError::Invalid("payload.selector is required".to_string()))?;
    let entity = resolve_entity_row_strict(conn, &row.agent_id, &entity_selector)?;
    let aspect = resolve_aspect_row_strict(conn, &row.agent_id, &entity.id, &aspect_selector)?;
    let ts = now();
    let reason = read_payload_string(payload, "reason").unwrap_or_else(|| row.rationale.clone());
    conn.execute(
        "UPDATE entity_aspects
         SET status = 'archived', archived_at = ?1, archived_by = ?2,
             archive_reason = ?3, proposal_id = ?4, proposal_evidence = ?5, updated_at = ?1
         WHERE id = ?6 AND agent_id = ?7",
        rusqlite::params![
            ts,
            actor,
            reason,
            row.id,
            proposal_evidence_json(row),
            aspect.id,
            row.agent_id
        ],
    )?;
    conn.execute(
        "UPDATE entity_attributes
         SET status = 'deleted', archived_at = ?1, archived_by = ?2,
             archive_reason = ?3, updated_at = ?1
         WHERE aspect_id = ?4 AND agent_id = ?5 AND status = 'active'",
        rusqlite::params![ts, actor, reason, aspect.id, row.agent_id],
    )?;
    Ok(json!({"entityId": entity.id, "aspectId": aspect.id, "archived": true}))
}

fn apply_set_claim_value(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
) -> Result<JsonValue, CoreError> {
    let entity = read_payload_string(payload, "entity")
        .ok_or_else(|| CoreError::Invalid("payload.entity is required".to_string()))?;
    let aspect = read_payload_string(payload, "aspect")
        .ok_or_else(|| CoreError::Invalid("payload.aspect is required".to_string()))?;
    let claim_key = read_payload_string(payload, "claim_key")
        .or_else(|| read_payload_string(payload, "claim"))
        .ok_or_else(|| CoreError::Invalid("payload.claim_key is required".to_string()))?;
    let value = read_payload_string(payload, "value")
        .ok_or_else(|| CoreError::Invalid("payload.value is required".to_string()))?;
    let entity_type = normalize_entity_type(read_payload_string(payload, "entity_type"));
    let entity_id = resolve_or_create_entity(conn, &row.agent_id, &entity, &entity_type)?;
    let aspect_id = resolve_or_create_aspect(conn, &entity_id, &row.agent_id, &aspect)?;
    let group_key =
        read_payload_string(payload, "group_key").unwrap_or_else(|| "general".to_string());
    let kind = normalize_attribute_kind(read_payload_string(payload, "kind"));
    let slot = load_claim_slot(
        conn,
        &row.agent_id,
        &aspect_id,
        &kind,
        &group_key,
        &claim_key,
    )?;
    let active = slot
        .iter()
        .filter(|entry| entry.status == "active")
        .collect::<Vec<_>>();
    let normalized = canonical(&value);
    if let Some(existing) = active
        .iter()
        .find(|entry| entry.normalized_content == normalized)
        && active.len() == 1
    {
        return Ok(json!({
            "entityId": entity_id,
            "aspectId": aspect_id,
            "attributeId": existing.id,
            "version": existing.version,
            "versionRootId": existing.version_root_id.clone().unwrap_or_else(|| existing.id.clone()),
            "deduped": true,
        }));
    }
    if kind == "constraint" && !active.is_empty() && !force_payload(payload) {
        return Err(CoreError::Conflict(
            "Refusing to replace active constraint claim without force".to_string(),
        ));
    }
    let previous = active.first().copied().or_else(|| slot.first());
    let version = slot.iter().map(|entry| entry.version).max().unwrap_or(0) + 1;
    let root_id = previous
        .and_then(|entry| {
            entry
                .version_root_id
                .clone()
                .or_else(|| Some(entry.id.clone()))
        })
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let id = if version == 1 {
        root_id.clone()
    } else {
        Uuid::new_v4().to_string()
    };
    let ts = now();
    let confidence = read_payload_f64(payload, "confidence").unwrap_or(row.confidence);
    let importance = read_payload_f64(payload, "importance").unwrap_or(confidence);
    conn.execute(
        "INSERT INTO entity_attributes
         (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status,
          group_key, claim_key, version, version_root_id, previous_attribute_id,
          created_at, updated_at, source_id, source_kind, source_path, source_root,
          proposal_id, proposal_evidence)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10, ?11, ?12, ?13,
                 ?14, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        rusqlite::params![
            id,
            aspect_id,
            row.agent_id,
            kind,
            value,
            normalized,
            confidence,
            importance,
            group_key,
            claim_key,
            version,
            root_id,
            previous.map(|entry| entry.id.clone()),
            ts,
            row.source_id,
            row.source_kind,
            row.source_path,
            row.source_root,
            row.id,
            proposal_evidence_json(row)
        ],
    )?;
    if !active.is_empty() {
        conn.execute(
            "UPDATE entity_attributes
             SET status = 'superseded', superseded_by = ?1, updated_at = ?2
             WHERE agent_id = ?3
               AND aspect_id = ?4
               AND kind = ?5
               AND COALESCE(group_key, 'general') = ?6
               AND claim_key = ?7
               AND status = 'active'
               AND id != ?1",
            rusqlite::params![id, ts, row.agent_id, aspect_id, kind, group_key, claim_key],
        )?;
    }
    Ok(json!({
        "entityId": entity_id,
        "aspectId": aspect_id,
        "attributeId": id,
        "version": version,
        "versionRootId": root_id,
        "previousAttributeId": previous.map(|entry| entry.id.clone()),
    }))
}

fn apply_supersede_claim_value(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
) -> Result<JsonValue, CoreError> {
    let entity = read_payload_string(payload, "entity")
        .ok_or_else(|| CoreError::Invalid("payload.entity is required".to_string()))?;
    let aspect = read_payload_string(payload, "aspect")
        .ok_or_else(|| CoreError::Invalid("payload.aspect is required".to_string()))?;
    let claim_key = read_payload_string(payload, "claim_key")
        .or_else(|| read_payload_string(payload, "claim"))
        .ok_or_else(|| CoreError::Invalid("payload.claim_key is required".to_string()))?;
    let attribute_id = read_payload_string(payload, "attribute_id");
    let old_value = read_payload_string(payload, "old_value");
    if attribute_id.is_none() && old_value.is_none() {
        return Err(CoreError::Invalid(
            "payload.attribute_id or payload.old_value is required".to_string(),
        ));
    }
    let group_key =
        read_payload_string(payload, "group_key").unwrap_or_else(|| "general".to_string());
    let kind = normalize_attribute_kind(read_payload_string(payload, "kind"));
    let entity_row = resolve_entity_row_strict(conn, &row.agent_id, &entity)?;
    let aspect_row = resolve_aspect_row_strict(conn, &row.agent_id, &entity_row.id, &aspect)?;
    let mut matched = Vec::new();
    if let Some(id) = &attribute_id {
        if let Some(found) = conn
            .query_row(
                "SELECT id
                 FROM entity_attributes
                 WHERE id = ?1
                   AND agent_id = ?2
                   AND aspect_id = ?3
                   AND kind = ?4
                   AND COALESCE(group_key, 'general') = ?5
                   AND claim_key = ?6
                   AND status = 'active'
                 LIMIT 1",
                rusqlite::params![id, row.agent_id, aspect_row.id, kind, group_key, claim_key],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            matched.push(found);
        }
    } else if let Some(value) = &old_value {
        matched = conn
            .prepare(
                "SELECT id
                 FROM entity_attributes
                 WHERE agent_id = ?1
                   AND aspect_id = ?2
                   AND kind = ?3
                   AND COALESCE(group_key, 'general') = ?4
                   AND claim_key = ?5
                   AND normalized_content = ?6
                   AND status = 'active'",
            )?
            .query_map(
                rusqlite::params![
                    row.agent_id,
                    aspect_row.id,
                    kind,
                    group_key,
                    claim_key,
                    canonical(value)
                ],
                |r| r.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
    }
    if matched.is_empty() {
        return Err(CoreError::Invalid(
            "No active claim values matched supersession payload".to_string(),
        ));
    }
    let replacement_id = if let Some(new_value) = read_payload_string(payload, "new_value") {
        let mut next = payload.clone();
        if let Some(object) = next.as_object_mut() {
            object.insert("value".to_string(), JsonValue::String(new_value));
            object.insert(
                "claim_key".to_string(),
                JsonValue::String(claim_key.clone()),
            );
            object.insert(
                "group_key".to_string(),
                JsonValue::String(group_key.clone()),
            );
        }
        let result = apply_set_claim_value(conn, row, &next)?;
        result
            .get("attributeId")
            .and_then(JsonValue::as_str)
            .map(|value| value.to_string())
    } else {
        read_payload_string(payload, "superseded_by")
    };
    let ts = now();
    for id in &matched {
        conn.execute(
            "UPDATE entity_attributes
             SET status = 'superseded', superseded_by = ?1,
                 proposal_id = ?2, proposal_evidence = ?3, updated_at = ?4
             WHERE id = ?5 AND agent_id = ?6",
            rusqlite::params![
                replacement_id,
                row.id,
                proposal_evidence_json(row),
                ts,
                id,
                row.agent_id
            ],
        )?;
    }
    Ok(json!({
        "entityId": entity_row.id,
        "aspectId": aspect_row.id,
        "supersededAttributeIds": matched,
        "replacementAttributeId": replacement_id,
    }))
}

fn apply_archive_claim_value(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
    actor: &str,
) -> Result<JsonValue, CoreError> {
    let attribute_id = read_payload_string(payload, "attribute_id")
        .ok_or_else(|| CoreError::Invalid("payload.attribute_id is required".to_string()))?;
    let kind = conn
        .query_row(
            "SELECT kind
             FROM entity_attributes
             WHERE id = ?1 AND agent_id = ?2",
            rusqlite::params![attribute_id, row.agent_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound("Attribute not found".to_string()))?;
    if kind == "constraint" && !force_payload(payload) {
        return Err(CoreError::Conflict(
            "Refusing to archive constraint attribute without force".to_string(),
        ));
    }
    let ts = now();
    conn.execute(
        "UPDATE entity_attributes
         SET status = 'deleted', archived_at = ?1, archived_by = ?2,
             archive_reason = ?3, proposal_id = ?4, proposal_evidence = ?5, updated_at = ?1
         WHERE id = ?6 AND agent_id = ?7",
        rusqlite::params![
            ts,
            actor,
            read_payload_string(payload, "reason").unwrap_or_else(|| row.rationale.clone()),
            row.id,
            proposal_evidence_json(row),
            attribute_id,
            row.agent_id
        ],
    )?;
    Ok(json!({"attributeId": attribute_id, "archived": true}))
}

fn apply_restore_claim_version(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
) -> Result<JsonValue, CoreError> {
    let attribute_id = read_payload_string(payload, "attribute_id")
        .ok_or_else(|| CoreError::Invalid("payload.attribute_id is required".to_string()))?;
    let attribute = conn
        .query_row(
            "SELECT *
             FROM entity_attributes
             WHERE id = ?1 AND agent_id = ?2",
            rusqlite::params![attribute_id, row.agent_id],
            read_attribute_evidence_row,
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("Attribute not found: {attribute_id}")))?;
    let group_key = attribute
        .group_key
        .clone()
        .unwrap_or_else(|| "general".to_string());
    let claim_key = attribute
        .claim_key
        .clone()
        .unwrap_or_else(|| "general".to_string());
    let root_id = attribute
        .version_root_id
        .clone()
        .unwrap_or_else(|| attribute.id.clone());
    let ts = now();
    conn.execute(
        "UPDATE entity_attributes
         SET status = 'superseded', superseded_by = ?1, updated_at = ?2
         WHERE agent_id = ?3
           AND aspect_id = ?4
           AND kind = ?5
           AND COALESCE(group_key, 'general') = ?6
           AND claim_key = ?7
           AND COALESCE(version_root_id, id) = ?8
           AND status = 'active'
           AND id != ?1",
        rusqlite::params![
            attribute.id,
            ts,
            row.agent_id,
            attribute.aspect_id,
            attribute.kind,
            group_key,
            claim_key,
            root_id
        ],
    )?;
    conn.execute(
        "UPDATE entity_attributes
         SET status = 'active', superseded_by = NULL, archived_at = NULL,
             archived_by = NULL, archive_reason = NULL,
             proposal_id = ?1, proposal_evidence = ?2, updated_at = ?3
         WHERE id = ?4 AND agent_id = ?5",
        rusqlite::params![
            row.id,
            proposal_evidence_json(row),
            ts,
            attribute.id,
            row.agent_id
        ],
    )?;
    Ok(json!({
        "attributeId": attribute.id,
        "versionRootId": root_id,
        "restored": true,
    }))
}

fn merge_entity_aspects(
    conn: &rusqlite::Connection,
    agent_id: &str,
    source_id: &str,
    target_id: &str,
) -> Result<usize, CoreError> {
    let aspects = conn
        .prepare(
            "SELECT id, canonical_name
             FROM entity_aspects
             WHERE entity_id = ?1 AND agent_id = ?2",
        )?
        .query_map(rusqlite::params![source_id, agent_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (aspect_id, canonical_name) in &aspects {
        if let Some(target_aspect_id) = conn
            .query_row(
                "SELECT id
                 FROM entity_aspects
                 WHERE entity_id = ?1 AND agent_id = ?2 AND canonical_name = ?3
                 LIMIT 1",
                rusqlite::params![target_id, agent_id, canonical_name],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            conn.execute(
                "UPDATE entity_attributes
                 SET aspect_id = ?1
                 WHERE aspect_id = ?2 AND agent_id = ?3",
                rusqlite::params![target_aspect_id, aspect_id, agent_id],
            )?;
            conn.execute(
                "DELETE FROM entity_aspects WHERE id = ?1 AND agent_id = ?2",
                rusqlite::params![aspect_id, agent_id],
            )?;
        } else {
            conn.execute(
                "UPDATE entity_aspects
                 SET entity_id = ?1, updated_at = ?2
                 WHERE id = ?3 AND agent_id = ?4",
                rusqlite::params![target_id, now(), aspect_id, agent_id],
            )?;
        }
    }
    Ok(aspects.len())
}

fn merge_entity_edges(
    conn: &rusqlite::Connection,
    agent_id: &str,
    source_id: &str,
    target_id: &str,
) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE entity_dependencies
         SET source_entity_id = ?1
         WHERE source_entity_id = ?2 AND agent_id = ?3",
        rusqlite::params![target_id, source_id, agent_id],
    )?;
    conn.execute(
        "UPDATE entity_dependencies
         SET target_entity_id = ?1
         WHERE target_entity_id = ?2 AND agent_id = ?3",
        rusqlite::params![target_id, source_id, agent_id],
    )?;
    conn.execute(
        "DELETE FROM entity_dependencies
         WHERE source_entity_id = target_entity_id AND agent_id = ?1",
        rusqlite::params![agent_id],
    )?;
    conn.execute(
        "UPDATE relations
         SET source_entity_id = ?1
         WHERE source_entity_id = ?2",
        rusqlite::params![target_id, source_id],
    )?;
    conn.execute(
        "UPDATE relations
         SET target_entity_id = ?1
         WHERE target_entity_id = ?2",
        rusqlite::params![target_id, source_id],
    )?;
    conn.execute(
        "DELETE FROM relations WHERE source_entity_id = target_entity_id",
        [],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO memory_entity_mentions (memory_id, entity_id)
         SELECT memory_id, ?1 FROM memory_entity_mentions WHERE entity_id = ?2",
        rusqlite::params![target_id, source_id],
    )?;
    conn.execute(
        "DELETE FROM memory_entity_mentions WHERE entity_id = ?1",
        rusqlite::params![source_id],
    )?;
    Ok(())
}

fn apply_merge_entities(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
) -> Result<JsonValue, CoreError> {
    let target_selector = read_payload_string(payload, "target_entity")
        .or_else(|| read_payload_string(payload, "target"));
    let target_id = read_payload_string(payload, "target_entity_id")
        .or_else(|| read_payload_string(payload, "target_id"));
    let target = resolve_merge_entity_ref(
        conn,
        &row.agent_id,
        "payload.target_entity",
        target_selector,
        target_id,
    )?;
    let specs = source_merge_specs(payload)?;
    if specs.is_empty() {
        return Err(CoreError::Invalid(
            "source entities are required".to_string(),
        ));
    }
    let resolved = specs
        .into_iter()
        .map(|(selector, id)| {
            resolve_merge_entity_ref(conn, &row.agent_id, "payload.source_entity", selector, id)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut seen = std::collections::HashSet::new();
    let sources = resolved
        .into_iter()
        .filter(|source| source.id != target.id)
        .filter(|source| seen.insert(source.id.clone()))
        .collect::<Vec<_>>();
    if sources.is_empty() {
        return Err(CoreError::Invalid(
            "No distinct source entities to merge".to_string(),
        ));
    }
    let force = force_payload(payload);
    let (warnings, blocked, _) = merge_warnings(&target, &sources, force);
    if blocked {
        return Err(CoreError::Conflict(format!(
            "Merge blocked: {}",
            warnings.join("; ")
        )));
    }
    let mut merged = Vec::new();
    for source in &sources {
        let moved_aspects = merge_entity_aspects(conn, &row.agent_id, &source.id, &target.id)?;
        merge_entity_edges(conn, &row.agent_id, &source.id, &target.id)?;
        conn.execute(
            "UPDATE entities
             SET mentions = COALESCE(mentions, 0) + COALESCE((SELECT mentions FROM entities WHERE id = ?1), 0),
                 updated_at = ?2
             WHERE id = ?3 AND agent_id = ?4",
            rusqlite::params![source.id, now(), target.id, row.agent_id],
        )?;
        conn.execute(
            "DELETE FROM entities WHERE id = ?1 AND agent_id = ?2",
            rusqlite::params![source.id, row.agent_id],
        )?;
        merged.push(json!({
            "name": source.name,
            "entityId": source.id,
            "movedAspects": moved_aspects,
        }));
    }
    Ok(json!({
        "targetEntityId": target.id,
        "targetEntityName": target.name,
        "mergedEntities": merged,
        "warnings": warnings,
    }))
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

fn apply_update_link(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
) -> Result<JsonValue, CoreError> {
    let dependency_id = payload_selector(payload, &["id", "dependency_id", "link_id"])
        .ok_or_else(|| CoreError::Invalid("payload.id is required".to_string()))?;
    let current = conn
        .query_row(
            "SELECT *
             FROM entity_dependencies
             WHERE id = ?1 AND agent_id = ?2",
            rusqlite::params![dependency_id, row.agent_id],
            read_dependency_evidence_row,
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound("Link not found".to_string()))?;
    let dependency_type = read_payload_string(payload, "link_type")
        .or_else(|| read_payload_string(payload, "dependency_type"))
        .map(|value| normalize_dependency_type(Some(value)))
        .unwrap_or(current.dependency_type);
    let strength = read_payload_f64(payload, "strength").unwrap_or(current.strength);
    let confidence = read_payload_f64(payload, "confidence").unwrap_or(current.confidence);
    let reason = optional_payload_string(payload, "reason").or(current.reason);
    conn.execute(
        "UPDATE entity_dependencies
         SET dependency_type = ?1, strength = ?2, confidence = ?3, reason = ?4,
             source_id = COALESCE(?5, source_id),
             source_kind = COALESCE(?6, source_kind),
             source_path = COALESCE(?7, source_path),
             source_root = COALESCE(?8, source_root),
             proposal_id = ?9, proposal_evidence = ?10, updated_at = ?11
         WHERE id = ?12 AND agent_id = ?13",
        rusqlite::params![
            dependency_type,
            strength,
            confidence,
            reason,
            row.source_id,
            row.source_kind,
            row.source_path,
            row.source_root,
            row.id,
            proposal_evidence_json(row),
            now(),
            dependency_id,
            row.agent_id
        ],
    )?;
    Ok(json!({
        "dependencyId": dependency_id,
        "updated": true,
    }))
}

fn apply_archive_link(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    payload: &JsonValue,
    actor: &str,
) -> Result<JsonValue, CoreError> {
    let dependency_id = payload_selector(payload, &["id", "dependency_id", "link_id"])
        .ok_or_else(|| CoreError::Invalid("payload.id is required".to_string()))?;
    let exists = conn
        .query_row(
            "SELECT 1
             FROM entity_dependencies
             WHERE id = ?1 AND agent_id = ?2",
            rusqlite::params![dependency_id, row.agent_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    if !exists {
        return Err(CoreError::NotFound("Link not found".to_string()));
    }
    let ts = now();
    conn.execute(
        "UPDATE entity_dependencies
         SET status = 'archived', archived_at = ?1, archived_by = ?2,
             archive_reason = ?3, proposal_id = ?4, proposal_evidence = ?5, updated_at = ?1
         WHERE id = ?6 AND agent_id = ?7",
        rusqlite::params![
            ts,
            actor,
            read_payload_string(payload, "reason").unwrap_or_else(|| row.rationale.clone()),
            row.id,
            proposal_evidence_json(row),
            dependency_id,
            row.agent_id
        ],
    )?;
    Ok(json!({"dependencyId": dependency_id, "archived": true}))
}

fn apply_operation(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    actor: &str,
) -> Result<JsonValue, CoreError> {
    let payload = parse_json(&row.payload, json!({}));
    match row.operation.as_str() {
        "create_entity" => apply_create_entity(conn, row, &payload),
        "rename_entity" => apply_rename_entity(conn, row, &payload),
        "archive_entity" => apply_archive_entity(conn, row, &payload, actor),
        "create_aspect" => apply_create_aspect(conn, row, &payload),
        "rename_aspect" => apply_rename_aspect(conn, row, &payload),
        "archive_aspect" => apply_archive_aspect(conn, row, &payload, actor),
        "add_claim_value" | "add_claim" => apply_add_claim_value(conn, row, &payload),
        "set_claim_value" => apply_set_claim_value(conn, row, &payload),
        "supersede_claim_value" => apply_supersede_claim_value(conn, row, &payload),
        "archive_claim_value" => apply_archive_claim_value(conn, row, &payload, actor),
        "restore_claim_version" => apply_restore_claim_version(conn, row, &payload),
        "merge_entities" => apply_merge_entities(conn, row, &payload),
        "create_link" => apply_create_link(conn, row, &payload),
        "update_link" => apply_update_link(conn, row, &payload),
        "archive_link" => apply_archive_link(conn, row, &payload, actor),
        _ => Err(CoreError::Invalid(format!(
            "unsupported ontology operation: {}",
            row.operation
        ))),
    }
}

fn load_proposal_row(
    conn: &rusqlite::Connection,
    id: &str,
    agent_id: &str,
) -> Result<ProposalRow, CoreError> {
    Ok(conn
        .prepare(&format!(
            "{SELECT_PROPOSAL} WHERE id = ?1 AND agent_id = ?2"
        ))?
        .query_row(rusqlite::params![id, agent_id], read_row)?)
}

fn mark_applied_value(
    conn: &rusqlite::Connection,
    row: &ProposalRow,
    actor: &str,
    result: &JsonValue,
) -> Result<JsonValue, CoreError> {
    let ts = now();
    conn.execute(
        "UPDATE ontology_proposals
         SET status='applied', applied_by=?1, result=?2, updated_at=?3, applied_at=?3
         WHERE id=?4 AND agent_id=?5",
        rusqlite::params![actor, result.to_string(), ts, row.id, row.agent_id],
    )?;
    Ok(row_to_value(load_proposal_row(
        conn,
        &row.id,
        &row.agent_id,
    )?))
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
    let auth_runtime = state.auth_snapshot();
    let auth = authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        headers,
        is_local,
    )
    .map_err(|resp| *resp)?;
    require_permission_guard(&auth, permission, auth_runtime.mode, is_local)
        .map_err(|resp| *resp)?;
    resolve_scoped_agent(&auth, auth_runtime.mode, is_local, requested)
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

#[derive(Debug, Deserialize)]
pub struct StatusQuery {
    #[serde(alias = "agent_id")]
    agent_id: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssertionQuery {
    #[serde(alias = "agent_id")]
    agent_id: Option<String>,
    entity: Option<String>,
    #[serde(alias = "entity_id")]
    entity_id: Option<String>,
    predicate: Option<String>,
    status: Option<String>,
    speaker: Option<String>,
    #[serde(alias = "source_kind")]
    source_kind: Option<String>,
    #[serde(alias = "source_id")]
    source_id: Option<String>,
    query: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ClaimVersionQuery {
    #[serde(alias = "agent_id")]
    agent_id: Option<String>,
    entity: Option<String>,
    aspect: Option<String>,
    group: Option<String>,
    claim: Option<String>,
    version: Option<i64>,
    kind: Option<String>,
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

fn read_body_string(body: &JsonValue, key: &str) -> Option<String> {
    body.get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn validate_claim_query(query: &ClaimVersionQuery, require_version: bool) -> Option<&'static str> {
    if query
        .entity
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Some("entity is required");
    }
    if query
        .aspect
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Some("aspect is required");
    }
    if query
        .group
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Some("group is required");
    }
    if query
        .claim
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Some("claim is required");
    }
    if let Some(kind) = query.kind.as_deref()
        && !matches!(kind, "attribute" | "constraint")
    {
        return Some("kind is invalid");
    }
    if require_version && query.version.unwrap_or(0) <= 0 {
        return Some("version is required");
    }
    None
}

fn claim_version_row_to_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<JsonValue> {
    let id = row.get::<_, String>("id")?;
    Ok(json!({
        "id": id,
        "version": row.get::<_, Option<i64>>("version")?.unwrap_or(1),
        "versionRootId": row.get::<_, Option<String>>("version_root_id")?.unwrap_or_else(|| id.clone()),
        "previousAttributeId": row.get::<_, Option<String>>("previous_attribute_id")?,
        "content": row.get::<_, String>("content")?,
        "status": row.get::<_, String>("status")?,
        "confidence": row.get::<_, Option<f64>>("confidence")?.unwrap_or(0.0),
        "proposalId": row.get::<_, Option<String>>("proposal_id")?,
        "sourceKind": row.get::<_, Option<String>>("source_kind")?,
        "sourceId": row.get::<_, Option<String>>("source_id")?,
        "sourcePath": row.get::<_, Option<String>>("source_path")?,
        "createdAt": row.get::<_, String>("created_at")?,
        "updatedAt": row.get::<_, String>("updated_at")?,
    }))
}

fn resolve_claim_versions_entity(
    conn: &rusqlite::Connection,
    agent_id: &str,
    selector: &str,
) -> Result<String, CoreError> {
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM entities WHERE agent_id = ?1 AND id = ?2 LIMIT 1",
            rusqlite::params![agent_id, selector],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    let key = canonical(selector);
    let rows = conn
        .prepare(
            "SELECT id FROM entities
             WHERE agent_id = ?1
               AND (COALESCE(canonical_name, LOWER(name)) = ?2 OR LOWER(name) = ?3)
             ORDER BY updated_at DESC, name ASC",
        )?
        .query_map(rusqlite::params![agent_id, key, key], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    match rows.len() {
        0 => Err(CoreError::NotFound(format!("Entity not found: {selector}"))),
        1 => Ok(rows.into_iter().next().expect("one entity id")),
        _ => Err(CoreError::Conflict(format!(
            "Entity selector is ambiguous: {selector}. Use an id."
        ))),
    }
}

fn resolve_claim_versions_aspect(
    conn: &rusqlite::Connection,
    agent_id: &str,
    entity_id: &str,
    selector: &str,
) -> Result<String, CoreError> {
    if let Some(id) = conn
        .query_row(
            "SELECT id
             FROM entity_aspects
             WHERE entity_id = ?1 AND agent_id = ?2 AND id = ?3
             LIMIT 1",
            rusqlite::params![entity_id, agent_id, selector],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    let key = canonical(selector);
    let rows = conn
        .prepare(
            "SELECT id FROM entity_aspects
             WHERE entity_id = ?1
               AND agent_id = ?2
               AND (canonical_name = ?3 OR LOWER(name) = ?4)
             ORDER BY updated_at DESC, name ASC",
        )?
        .query_map(rusqlite::params![entity_id, agent_id, key, key], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    match rows.len() {
        0 => Err(CoreError::NotFound(format!("Aspect not found: {selector}"))),
        1 => Ok(rows.into_iter().next().expect("one aspect id")),
        _ => Err(CoreError::Conflict(format!(
            "Aspect selector is ambiguous: {selector}. Use an id."
        ))),
    }
}

fn list_claim_version_values(
    conn: &rusqlite::Connection,
    agent_id: &str,
    query: &ClaimVersionQuery,
) -> Result<JsonValue, CoreError> {
    let entity = clean(query.entity.clone())
        .ok_or_else(|| CoreError::Invalid("entity is required".to_string()))?;
    let aspect = clean(query.aspect.clone())
        .ok_or_else(|| CoreError::Invalid("aspect is required".to_string()))?;
    let group = clean(query.group.clone())
        .ok_or_else(|| CoreError::Invalid("group is required".to_string()))?;
    let claim = clean(query.claim.clone())
        .ok_or_else(|| CoreError::Invalid("claim is required".to_string()))?;
    let kind = clean(query.kind.clone()).unwrap_or_else(|| "attribute".to_string());
    if !matches!(kind.as_str(), "attribute" | "constraint") {
        return Err(CoreError::Invalid("kind is invalid".to_string()));
    }
    let entity_id = resolve_claim_versions_entity(conn, agent_id, &entity)?;
    let aspect_id = resolve_claim_versions_aspect(conn, agent_id, &entity_id, &aspect)?;
    let group_key = {
        let key = canonical_path_key(&group);
        if key.is_empty() {
            "general".to_string()
        } else {
            key
        }
    };
    let claim_key = canonical_path_key(&claim);
    let items = conn
        .prepare(
            "SELECT id, version, version_root_id, previous_attribute_id, content,
                    status, confidence, proposal_id, source_kind, source_id,
                    source_path, created_at, updated_at
             FROM entity_attributes
             WHERE agent_id = ?1
               AND aspect_id = ?2
               AND COALESCE(group_key, 'general') = ?3
               AND claim_key = ?4
               AND kind = ?5
             ORDER BY version DESC, updated_at DESC",
        )?
        .query_map(
            rusqlite::params![agent_id, aspect_id, group_key, claim_key, kind],
            claim_version_row_to_value,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"items": items, "count": items.len()}))
}

fn get_claim_version_value(
    conn: &rusqlite::Connection,
    agent_id: &str,
    query: &ClaimVersionQuery,
) -> Result<Option<JsonValue>, CoreError> {
    let version = query.version.unwrap_or(0);
    let items = list_claim_version_values(conn, agent_id, query)?;
    Ok(items["items"].as_array().and_then(|items| {
        items
            .iter()
            .find(|item| item["version"].as_i64() == Some(version))
            .cloned()
    }))
}

/// GET /api/ontology/assertions — list epistemic assertions.
pub async fn assertions_list(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<AssertionQuery>,
) -> Response {
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        query.agent_id.as_deref(),
        Permission::Recall,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let result = state
        .pool
        .read(move |conn| list_assertion_values(conn, &agent, query))
        .await;
    match result {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => assertion_error(error),
    }
}

/// POST /api/ontology/assertions — create an epistemic assertion.
pub async fn assertions_create(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ProposalQuery>,
    Json(body): Json<JsonValue>,
) -> Response {
    let requested_agent = query
        .agent_id
        .clone()
        .or_else(|| read_json_string(&body, "agent_id"));
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        requested_agent.as_deref(),
        Permission::Modify,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let created_by = read_json_string(&body, "created_by")
        .or_else(|| {
            headers
                .get("x-signet-actor")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "operator".to_string());
    if read_json_string(&body, "predicate")
        .as_deref()
        .is_none_or(|predicate| !valid_assertion_predicate(predicate))
    {
        return json_error(StatusCode::BAD_REQUEST, "predicate is invalid");
    }
    let result = state
        .pool
        .write_tx(Priority::High, move |conn| {
            insert_assertion(conn, &agent, None, &body, &created_by)
        })
        .await;
    match result {
        Ok(value) => (StatusCode::CREATED, Json(value)).into_response(),
        Err(error) => assertion_error(error),
    }
}

/// GET /api/ontology/assertions/:id — get an assertion.
pub async fn assertion_get(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<StatusQuery>,
) -> Response {
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        query.agent_id.as_deref(),
        Permission::Recall,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let result = state
        .pool
        .read(move |conn| get_assertion_value(conn, &agent, &id))
        .await;
    match result {
        Ok(Some(value)) => (StatusCode::OK, Json(value)).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Assertion not found"),
        Err(error) => assertion_error(error),
    }
}

/// POST /api/ontology/assertions/:id/archive — archive an assertion.
pub async fn assertion_archive(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<ProposalQuery>,
    Json(body): Json<JsonValue>,
) -> Response {
    let requested_agent = query
        .agent_id
        .clone()
        .or_else(|| read_json_string(&body, "agent_id"));
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        requested_agent.as_deref(),
        Permission::Modify,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let actor = read_json_string(&body, "actor")
        .or_else(|| {
            headers
                .get("x-signet-actor")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "operator".to_string());
    let reason = read_json_string(&body, "reason");
    let result = state
        .pool
        .write_tx(Priority::High, move |conn| {
            archive_assertion_value(conn, &agent, &id, &actor, reason)
        })
        .await;
    match result {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => assertion_error(error),
    }
}

/// POST /api/ontology/assertions/:id/link-claim — link assertion to a claim.
pub async fn assertion_link_claim(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<ProposalQuery>,
    Json(body): Json<JsonValue>,
) -> Response {
    let requested_agent = query
        .agent_id
        .clone()
        .or_else(|| read_json_string(&body, "agent_id"));
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        requested_agent.as_deref(),
        Permission::Modify,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let Some(attribute_id) = read_json_string(&body, "attribute_id") else {
        return json_error(StatusCode::BAD_REQUEST, "attribute_id is required");
    };
    let result = state
        .pool
        .write_tx(Priority::High, move |conn| {
            link_assertion_claim_value(conn, &agent, &id, &attribute_id)
        })
        .await;
    match result {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => assertion_error(error),
    }
}

/// POST /api/ontology/assertions/:id/supersede — supersede assertion.
pub async fn assertion_supersede(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<ProposalQuery>,
    Json(body): Json<JsonValue>,
) -> Response {
    let requested_agent = query
        .agent_id
        .clone()
        .or_else(|| read_json_string(&body, "agent_id"));
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        requested_agent.as_deref(),
        Permission::Modify,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let created_by = read_json_string(&body, "created_by")
        .or_else(|| {
            headers
                .get("x-signet-actor")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "operator".to_string());
    let result = state
        .pool
        .write_tx(Priority::High, move |conn| {
            supersede_assertion_value(conn, &agent, &id, body, &created_by)
        })
        .await;
    match result {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => assertion_error(error),
    }
}

/// GET /api/ontology/claims/versions — list claim versions.
pub async fn claim_versions(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ClaimVersionQuery>,
) -> Response {
    if let Some(error) = validate_claim_query(&query, false) {
        return json_error(StatusCode::BAD_REQUEST, error);
    }
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        query.agent_id.as_deref(),
        Permission::Recall,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let result = state
        .pool
        .read(move |conn| list_claim_version_values(conn, &agent, &query))
        .await;
    match result {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => assertion_error(error),
    }
}

/// GET /api/ontology/claims/version — fetch one claim version.
pub async fn claim_version(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ClaimVersionQuery>,
) -> Response {
    if let Some(error) = validate_claim_query(&query, true) {
        return json_error(StatusCode::BAD_REQUEST, error);
    }
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        query.agent_id.as_deref(),
        Permission::Recall,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let result = state
        .pool
        .read(move |conn| get_claim_version_value(conn, &agent, &query))
        .await;
    match result {
        Ok(Some(value)) => (StatusCode::OK, Json(value)).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Claim version not found"),
        Err(error) => assertion_error(error),
    }
}

/// GET /api/ontology/entities/:id/aliases — list entity aliases.
pub async fn entity_aliases(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(entity_id): Path<String>,
    Query(query): Query<StatusQuery>,
) -> impl IntoResponse {
    if let Some(status) = query.status.as_deref()
        && !matches!(status, "active" | "archived" | "all")
    {
        return json_error(StatusCode::BAD_REQUEST, "status is invalid");
    }
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        query.agent_id.as_deref(),
        Permission::Recall,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let status = query.status.unwrap_or_else(|| "active".to_string());
    let result = state
        .pool
        .read(move |conn| {
            let mut stmt = if status == "all" {
                conn.prepare_cached(
                    "SELECT id, entity_id, alias, canonical_alias, confidence, source, status, created_at, updated_at
                       FROM entity_aliases
                      WHERE agent_id = ?1 AND entity_id = ?2
                      ORDER BY created_at DESC",
                )?
            } else {
                conn.prepare_cached(
                    "SELECT id, entity_id, alias, canonical_alias, confidence, source, status, created_at, updated_at
                       FROM entity_aliases
                      WHERE agent_id = ?1 AND entity_id = ?2 AND status = ?3
                      ORDER BY created_at DESC",
                )?
            };
            let mut rows = if status == "all" {
                stmt.query(rusqlite::params![&agent, &entity_id])?
            } else {
                stmt.query(rusqlite::params![&agent, &entity_id, &status])?
            };
            let mut items = Vec::new();
            while let Some(row) = rows.next()? {
                items.push(json!({
                    "id": row.get::<_, String>(0)?,
                    "entityId": row.get::<_, String>(1)?,
                    "alias": row.get::<_, String>(2)?,
                    "canonicalAlias": row.get::<_, String>(3)?,
                    "confidence": row.get::<_, f64>(4)?,
                    "source": row.get::<_, Option<String>>(5)?,
                    "status": row.get::<_, String>(6)?,
                    "createdAt": row.get::<_, String>(7)?,
                    "updatedAt": row.get::<_, String>(8)?,
                }));
            }
            Ok(json!({"items": items}))
        })
        .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// POST /api/ontology/entities/:id/aliases — create an alias.
pub async fn entity_alias_create(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(entity_id): Path<String>,
    Json(body): Json<JsonValue>,
) -> impl IntoResponse {
    let Some(alias) = read_body_string(&body, "alias") else {
        return json_error(StatusCode::BAD_REQUEST, "alias is required");
    };
    let confidence = body
        .get("confidence")
        .and_then(|value| value.as_f64())
        .unwrap_or(1.0)
        .clamp(0.0, 1.0);
    let source = read_body_string(&body, "source");
    let requested_agent =
        read_body_string(&body, "agent_id").or_else(|| read_body_string(&body, "agentId"));
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        requested_agent.as_deref(),
        Permission::Modify,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let result = state
        .pool
        .write(Priority::Low, move |conn| {
            let exists = conn
                .prepare_cached("SELECT 1 FROM entities WHERE id = ?1 AND agent_id = ?2")?
                .exists(rusqlite::params![&entity_id, &agent])?;
            if !exists {
                return Ok(json!({"found": false}));
            }
            let id = Uuid::new_v4().to_string();
            let ts = now();
            let canonical_alias = canonical(&alias);
            conn.execute(
                "INSERT INTO entity_aliases
                 (id, entity_id, agent_id, alias, canonical_alias, confidence, source, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?8)",
                rusqlite::params![id, &entity_id, &agent, &alias, &canonical_alias, confidence, &source, ts],
            )?;
            Ok(json!({
                "found": true,
                "item": {
                    "id": id,
                    "entityId": entity_id,
                    "alias": alias,
                    "canonicalAlias": canonical_alias,
                    "confidence": confidence,
                    "source": source,
                    "status": "active",
                    "createdAt": ts,
                    "updatedAt": ts,
                },
            }))
        })
        .await;
    match result {
        Ok(value) if value.get("found").and_then(JsonValue::as_bool) == Some(true) => (
            StatusCode::CREATED,
            Json(json!({"item": value.get("item").cloned().unwrap_or_else(|| json!({}))})),
        )
            .into_response(),
        Ok(_) => json_error(StatusCode::NOT_FOUND, "Entity not found"),
        Err(error) => {
            if error.to_string().contains("UNIQUE") {
                json_error(StatusCode::CONFLICT, "alias already exists")
            } else {
                json_error(StatusCode::BAD_REQUEST, &error.to_string())
            }
        }
    }
}

/// DELETE /api/ontology/entities/:id/aliases/:aliasId — archive an alias.
pub async fn entity_alias_delete(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path((entity_id, alias_id)): Path<(String, String)>,
    Query(query): Query<StatusQuery>,
) -> impl IntoResponse {
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        query.agent_id.as_deref(),
        Permission::Modify,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let response_alias_id = alias_id.clone();
    let result = state
        .pool
        .write(Priority::Low, move |conn| {
            let ts = now();
            let changed = conn.execute(
                "UPDATE entity_aliases
                    SET status = 'archived', updated_at = ?1
                  WHERE id = ?2 AND entity_id = ?3 AND agent_id = ?4",
                rusqlite::params![ts, &alias_id, &entity_id, &agent],
            )?;
            Ok(json!({"changed": changed}))
        })
        .await
        .ok()
        .and_then(|value| value.get("changed").and_then(JsonValue::as_u64))
        .unwrap_or(0);
    if result == 0 {
        json_error(StatusCode::NOT_FOUND, "Alias not found")
    } else {
        Json(json!({"item": {"id": response_alias_id, "status": "archived"}})).into_response()
    }
}

/// POST /api/ontology/operations/apply — apply one audited operation.
pub async fn operations_apply(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ProposalQuery>,
    Json(body): Json<JsonValue>,
) -> impl IntoResponse {
    let requested_agent = query
        .agent_id
        .clone()
        .or_else(|| read_body_string(&body, "agent_id"))
        .or_else(|| read_body_string(&body, "agentId"));
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        requested_agent.as_deref(),
        Permission::Modify,
    ) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    if read_body_string(&body, "operation").is_none() {
        return json_error(StatusCode::BAD_REQUEST, "operation is required");
    }
    let payload = body.get("payload").filter(|value| value.is_object());
    if payload
        .and_then(|value| value.as_object())
        .map(|object| object.is_empty())
        .unwrap_or(true)
    {
        return json_error(StatusCode::BAD_REQUEST, "payload object is required");
    }
    let dry_run = read_body_bool(&body, "dry_run")
        .or_else(|| read_body_bool(&body, "dryRun"))
        .unwrap_or(false);
    let propose = read_body_bool(&body, "propose").unwrap_or(false);
    if dry_run && propose {
        return json_error(
            StatusCode::BAD_REQUEST,
            "--dry-run and --propose cannot be used together",
        );
    }
    let actor = read_body_string(&body, "actor")
        .or_else(|| {
            headers
                .get("x-signet-actor")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "operator".to_string());
    let proposal = match proposal_body_from_operation(&body, &agent, &actor, &body) {
        Ok(value) => value,
        Err(error) => return core_error_response(error),
    };
    let result = state
        .pool
        .write(Priority::High, move |conn| {
            run_operation_transaction(conn, dry_run, || {
                apply_operation_item(conn, proposal, &agent, &actor, dry_run, propose)
            })
        })
        .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => core_error_response(error),
    }
}

/// POST /api/ontology/operations/batch — apply a batch of audited operations.
pub async fn operations_batch(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ProposalQuery>,
    Json(body): Json<JsonValue>,
) -> impl IntoResponse {
    let requested_agent = query
        .agent_id
        .clone()
        .or_else(|| read_body_string(&body, "agent_id"))
        .or_else(|| read_body_string(&body, "agentId"));
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        requested_agent.as_deref(),
        Permission::Modify,
    ) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let operations = body
        .get("operations")
        .or_else(|| body.get("items"))
        .and_then(|value| value.as_array());
    if operations.map(|items| items.is_empty()).unwrap_or(true) {
        return json_error(StatusCode::BAD_REQUEST, "operations are required");
    }
    let operations = operations.cloned().unwrap_or_default();
    if operations.len() > 500 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "cannot apply more than 500 operations at once",
        );
    }
    let dry_run = read_body_bool(&body, "dry_run")
        .or_else(|| read_body_bool(&body, "dryRun"))
        .unwrap_or(false);
    let propose = read_body_bool(&body, "propose").unwrap_or(false);
    if dry_run && propose {
        return json_error(
            StatusCode::BAD_REQUEST,
            "--dry-run and --propose cannot be used together",
        );
    }
    let actor = read_body_string(&body, "actor")
        .or_else(|| {
            headers
                .get("x-signet-actor")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "operator".to_string());
    let result = state
        .pool
        .write(Priority::High, move |conn| {
            run_operation_transaction(conn, dry_run, || {
                let mut items = Vec::new();
                let mut errors = Vec::new();
                for (index, raw) in operations.iter().enumerate() {
                    let proposal = proposal_body_from_operation(raw, &agent, &actor, &body);
                    let item = proposal.and_then(|proposal| {
                        apply_operation_item(conn, proposal, &agent, &actor, dry_run, propose)
                    });
                    match item {
                        Ok(value) => items.push(value),
                        Err(error) if dry_run => errors.push(json!({
                            "index": index,
                            "line": index + 1,
                            "operation": read_body_string(raw, "operation").unwrap_or_default(),
                            "error": error.to_string(),
                            "status": status_code_for_core_error(&error).as_u16(),
                        })),
                        Err(error) => return Err(error),
                    }
                }
                let mut output = json!({
                    "items": items,
                    "count": items.len(),
                    "dryRun": dry_run,
                    "proposed": propose,
                });
                if !errors.is_empty() {
                    output["errors"] = JsonValue::Array(errors);
                }
                Ok(output)
            })
        })
        .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => core_error_response(error),
    }
}

fn proposal_body_from_operation(
    raw: &JsonValue,
    agent: &str,
    actor: &str,
    defaults: &JsonValue,
) -> Result<ProposalBody, CoreError> {
    let mut proposal = serde_json::from_value::<ProposalBody>(raw.clone())
        .map_err(|error| CoreError::Invalid(format!("invalid operation body: {error}")))?;
    proposal.agent_id = Some(agent.to_string());
    if proposal.rationale.is_none() {
        proposal.rationale = proposal.reason.clone();
    }
    if proposal.created_by.is_none() {
        proposal.created_by = read_body_string(raw, "created_by")
            .or_else(|| read_body_string(raw, "createdBy"))
            .or_else(|| read_body_string(defaults, "created_by"))
            .or_else(|| read_body_string(defaults, "createdBy"))
            .or_else(|| Some(actor.to_string()));
    }
    if proposal.source_kind.is_none() {
        proposal.source_kind = read_body_string(raw, "source_kind")
            .or_else(|| read_body_string(defaults, "source_kind"));
    }
    if proposal.source_id.is_none() {
        proposal.source_id =
            read_body_string(raw, "source_id").or_else(|| read_body_string(defaults, "source_id"));
    }
    if proposal.source_path.is_none() {
        proposal.source_path = read_body_string(raw, "source_path")
            .or_else(|| read_body_string(defaults, "source_path"));
    }
    if proposal.source_root.is_none() {
        proposal.source_root = read_body_string(raw, "source_root")
            .or_else(|| read_body_string(defaults, "source_root"));
    }
    Ok(proposal)
}

fn run_operation_transaction<F>(
    conn: &rusqlite::Connection,
    rollback: bool,
    operation: F,
) -> Result<JsonValue, CoreError>
where
    F: FnOnce() -> Result<JsonValue, CoreError>,
{
    conn.execute_batch("BEGIN IMMEDIATE")?;
    match operation() {
        Ok(value) => {
            if rollback {
                conn.execute_batch("ROLLBACK")?;
            } else {
                conn.execute_batch("COMMIT")?;
            }
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn apply_operation_item(
    conn: &rusqlite::Connection,
    proposal: ProposalBody,
    agent: &str,
    actor: &str,
    dry_run: bool,
    propose: bool,
) -> Result<JsonValue, CoreError> {
    if propose {
        let proposal = insert_proposal(conn, proposal, agent)?;
        return Ok(json!({
            "proposal": proposal,
            "result": null,
            "dryRun": false,
            "proposed": true,
        }));
    }
    let proposal = insert_proposal(conn, proposal, agent)?;
    let id = proposal
        .get("id")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| CoreError::Invalid("proposal id is missing".to_string()))?;
    let agent_id = proposal
        .get("agentId")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| CoreError::Invalid("proposal agentId is missing".to_string()))?;
    let row = load_proposal_row(conn, id, agent_id)?;
    let result = apply_operation(conn, &row, actor)?;
    let proposal = mark_applied_value(conn, &row, actor, &result)?;
    Ok(json!({
        "proposal": proposal,
        "result": result,
        "dryRun": dry_run,
        "proposed": false,
    }))
}

fn status_code_for_core_error(error: &CoreError) -> StatusCode {
    match error {
        CoreError::Invalid(_) => StatusCode::BAD_REQUEST,
        CoreError::NotFound(_) => StatusCode::NOT_FOUND,
        CoreError::Conflict(_) => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn core_error_response(error: CoreError) -> Response {
    match error {
        CoreError::Invalid(message) => json_error(StatusCode::BAD_REQUEST, &message),
        CoreError::NotFound(message) => json_error(StatusCode::NOT_FOUND, &message),
        CoreError::Conflict(message) => json_error(StatusCode::CONFLICT, &message),
        other => json_error(StatusCode::INTERNAL_SERVER_ERROR, &other.to_string()),
    }
}

/// POST /api/ontology/proposals/repair/merge-plan — create a merge plan.
pub async fn repair_merge_plan(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ProposalQuery>,
    Json(body): Json<JsonValue>,
) -> Response {
    let requested_agent = query
        .agent_id
        .clone()
        .or_else(|| read_body_string(&body, "agent_id"));
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        requested_agent.as_deref(),
        Permission::Modify,
    ) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let write_proposal = read_body_bool(&body, "write_proposal")
        .or_else(|| read_body_bool(&body, "write_proposals"))
        .unwrap_or(false);
    let created_by = read_body_string(&body, "created_by")
        .or_else(|| {
            headers
                .get("x-signet-actor")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "ontology-merge-plan".to_string());
    let result = state
        .pool
        .write_tx(
            Priority::High,
            move |conn| -> Result<JsonValue, CoreError> {
                let plan = build_entity_merge_plan(conn, &agent, &body, "manual_entity_merge")?;
                let blocked = plan
                    .get("blocked")
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(false);
                if !write_proposal || blocked {
                    let mut output = plan;
                    if let Some(object) = output.as_object_mut() {
                        object.insert("dryRun".to_string(), JsonValue::Bool(true));
                    }
                    return Ok(output);
                }
                let target_id = plan
                    .get("target")
                    .and_then(|target| target.get("id"))
                    .and_then(JsonValue::as_str)
                    .unwrap_or_default()
                    .to_string();
                let proposal = insert_proposal(
                    conn,
                    ProposalBody {
                        agent_id: Some(agent.clone()),
                        from_source: None,
                        operation: Some("merge_entities".to_string()),
                        payload: plan.get("payload").cloned(),
                        confidence: plan.get("confidence").and_then(JsonValue::as_f64),
                        rationale: plan
                            .get("rationale")
                            .and_then(JsonValue::as_str)
                            .map(str::to_string),
                        evidence: plan.get("evidence").and_then(JsonValue::as_array).cloned(),
                        risk: plan
                            .get("risk")
                            .and_then(JsonValue::as_str)
                            .map(str::to_string),
                        source_kind: Some("ontology_index".to_string()),
                        source_id: Some(format!("entities:{target_id}")),
                        source_path: None,
                        source_root: None,
                        created_by: Some(created_by),
                        actor: None,
                        reason: None,
                        proposals: None,
                        write_proposals: None,
                        write_assertions: None,
                        use_provider: None,
                        provider_timeout_ms: None,
                        provider_max_tokens: None,
                        status: None,
                        limit: None,
                    },
                    &agent,
                )?;
                let mut output = plan;
                if let Some(object) = output.as_object_mut() {
                    object.insert("dryRun".to_string(), JsonValue::Bool(false));
                    object.insert("proposal".to_string(), proposal);
                }
                Ok(output)
            },
        )
        .await;
    match result {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(CoreError::Invalid(message)) => json_error(StatusCode::BAD_REQUEST, &message),
        Err(CoreError::NotFound(message)) => json_error(StatusCode::NOT_FOUND, &message),
        Err(CoreError::Conflict(message)) => json_error(StatusCode::CONFLICT, &message),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
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
            apply_operation(conn, &row, &actor)?
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
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Proposal not found"})),
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
        let rows = conn
            .prepare(&format!(
                "{SELECT_PROPOSAL}
                 WHERE agent_id = ?1 AND status = 'pending' AND operation = 'add_claim_value'
                 ORDER BY updated_at DESC
                 LIMIT ?2"
            ))?
            .query_map(rusqlite::params![agent, limit], read_row)?
            .collect::<Result<Vec<_>, _>>()?;
        let mut groups = std::collections::BTreeMap::<String, JsonValue>::new();
        for row in rows {
            let payload = parse_json(&row.payload, json!({}));
            let Some(entity) = read_payload_string(&payload, "entity") else {
                continue;
            };
            let Some(aspect) = read_payload_string(&payload, "aspect") else {
                continue;
            };
            let Some(claim_key) = read_payload_string(&payload, "claim_key") else {
                continue;
            };
            let Some(value) = read_payload_string(&payload, "value") else {
                continue;
            };
            let group_key =
                read_payload_string(&payload, "group_key").unwrap_or_else(|| "general".to_string());
            let key = [
                canonical(&entity),
                canonical(&aspect),
                canonical(&group_key),
                canonical(&claim_key),
            ]
            .join("\0");
            let entry = groups.entry(key).or_insert_with(|| {
                json!({
                    "entity": entity,
                    "aspect": aspect,
                    "groupKey": group_key,
                    "claimKey": claim_key,
                    "values": [],
                    "proposalIds": [],
                    "count": 0,
                })
            });
            if let Some(values) = entry.get_mut("values").and_then(JsonValue::as_array_mut) {
                values.push(json!({
                    "proposalId": row.id.clone(),
                    "value": value,
                    "confidence": row.confidence,
                    "rationale": row.rationale,
                    "evidenceCount": parse_json(&row.evidence, json!([])).as_array().map_or(0, Vec::len),
                }));
            }
            if let Some(ids) = entry
                .get_mut("proposalIds")
                .and_then(JsonValue::as_array_mut)
            {
                ids.push(JsonValue::String(row.id));
            }
            let count = entry.get("count").and_then(JsonValue::as_i64).unwrap_or(0) + 1;
            entry["count"] = JsonValue::Number(count.into());
        }
        let items = groups
            .into_values()
            .filter(|group| {
                let values = group
                    .get("values")
                    .and_then(JsonValue::as_array)
                    .cloned()
                    .unwrap_or_default();
                values
                    .into_iter()
                    .filter_map(|item| {
                        item.get("value")
                            .and_then(JsonValue::as_str)
                            .map(canonical)
                    })
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    > 1
            })
            .collect::<Vec<_>>();
        Ok(items)
    }).await;
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

pub async fn repair_duplicates(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ProposalQuery>,
    Json(body): Json<ProposalBody>,
) -> Response {
    let requested_agent = query.agent_id.as_deref().or(body.agent_id.as_deref());
    let agent =
        match scoped_agent_or_response(&state, peer, &headers, requested_agent, Permission::Modify)
        {
            Ok(id) => id,
            Err(resp) => return resp,
        };
    let limit = body.limit.unwrap_or(25).clamp(1, 100);
    let write_proposals = body.write_proposals.unwrap_or(false);
    let created_by = clean(body.created_by)
        .or_else(|| {
            headers
                .get("x-signet-actor")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "operator".to_string());
    let result = state
        .pool
        .write(Priority::Low, move |conn| {
            let items = duplicate_merge_candidates(conn, &agent, limit)?;
            let dry_run = !write_proposals;
            let writable = items
                .iter()
                .filter(|item| {
                    !item
                        .get("blocked")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                })
                .collect::<Vec<_>>();
            if dry_run || writable.is_empty() {
                return Ok::<JsonValue, CoreError>(json!({
                    "items": items,
                    "proposals": [],
                    "count": items.len(),
                    "writtenCount": 0,
                    "skippedCount": items.len() - writable.len(),
                    "dryRun": dry_run,
                }));
            }
            let mut proposals = Vec::new();
            for item in writable {
                let canonical_name = item
                    .get("canonicalName")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let evidence = item
                    .get("evidence")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                proposals.push(insert_proposal(
                    conn,
                    ProposalBody {
                        agent_id: Some(agent.clone()),
                        from_source: None,
                        operation: Some("merge_entities".to_string()),
                        payload: item.get("payload").cloned(),
                        confidence: item.get("confidence").and_then(|v| v.as_f64()),
                        rationale: item
                            .get("rationale")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        evidence: Some(evidence),
                        risk: item
                            .get("risk")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        source_kind: Some("ontology_index".to_string()),
                        source_id: Some(format!("entities:{canonical_name}")),
                        source_path: None,
                        source_root: None,
                        created_by: Some(created_by.clone()),
                        actor: None,
                        reason: None,
                        proposals: None,
                        write_proposals: None,
                        write_assertions: None,
                        use_provider: None,
                        provider_timeout_ms: None,
                        provider_max_tokens: None,
                        status: None,
                        limit: None,
                    },
                    &agent,
                )?);
            }
            Ok(json!({
                "items": items,
                "proposals": proposals,
                "count": items.len(),
                "writtenCount": proposals.len(),
                "skippedCount": items.len() - proposals.len(),
                "dryRun": false,
            }))
        })
        .await;
    match result {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

pub async fn extract(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ProposalQuery>,
    Json(body): Json<ProposalBody>,
) -> Response {
    let requested_agent = query.agent_id.clone().or_else(|| body.agent_id.clone());
    let agent = match scoped_agent_or_response(
        &state,
        peer,
        &headers,
        requested_agent.as_deref(),
        Permission::Modify,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let Some(from) = clean(body.from_source.clone()) else {
        return json_error(StatusCode::BAD_REQUEST, "from is required");
    };
    let created_by = clean(body.created_by.clone())
        .or_else(|| {
            headers
                .get("x-signet-actor")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "ontology-extract".to_string());
    let write_proposals = body.write_proposals.unwrap_or(false);
    let write_assertions = body.write_assertions.unwrap_or(false);
    let use_provider = body.use_provider.unwrap_or(false);
    let limit = bounded_limit(body.limit, 100, 1, 500) as usize;
    let result = state
        .pool
        .write_tx(
            Priority::High,
            move |conn| -> Result<JsonValue, CoreError> {
                let source = read_extraction_source(conn, &agent, &from)?;
                let (proposals, assertions, questions) =
                    extracted_proposals_and_assertions(&source, limit);
                let mut warnings = Vec::new();
                if use_provider {
                    warnings.push(
                        "Provider extraction requested but no inference provider is configured."
                            .to_string(),
                    );
                }
                let should_write_proposals = write_proposals && !proposals.is_empty();
                let should_write_assertions = write_assertions && !assertions.is_empty();
                let mut items = Vec::new();
                let mut assertion_items = Vec::new();
                if should_write_proposals {
                    for proposal in &proposals {
                        items.push(insert_proposal(
                            conn,
                            ProposalBody {
                                agent_id: Some(agent.clone()),
                                from_source: None,
                                operation: read_json_string(proposal, "operation"),
                                payload: proposal.get("payload").cloned(),
                                confidence: read_json_number(proposal, "confidence"),
                                rationale: read_json_string(proposal, "rationale"),
                                evidence: Some(read_json_array(proposal, "evidence")),
                                risk: read_json_string(proposal, "risk"),
                                source_kind: Some(source.source_kind.clone()),
                                source_id: Some(source.source_id.clone()),
                                source_path: source.source_path.clone(),
                                source_root: None,
                                created_by: Some(created_by.clone()),
                                actor: None,
                                reason: None,
                                proposals: None,
                                write_proposals: None,
                                write_assertions: None,
                                use_provider: None,
                                provider_timeout_ms: None,
                                provider_max_tokens: None,
                                status: None,
                                limit: None,
                            },
                            &agent,
                        )?);
                    }
                }
                if should_write_assertions {
                    for assertion in &assertions {
                        assertion_items.push(insert_assertion(
                            conn,
                            &agent,
                            Some(&source),
                            assertion,
                            &created_by,
                        )?);
                    }
                }
                Ok(json!({
                    "source": {
                        "kind": source.kind,
                        "id": source.id,
                        "sourceKind": source.source_kind,
                        "sourceId": source.source_id,
                        "sourcePath": source.source_path,
                        "project": source.project,
                        "harness": source.harness,
                    },
                    "proposals": proposals,
                    "items": items,
                    "assertions": assertions,
                    "assertionItems": assertion_items,
                    "count": proposals.len(),
                    "writtenCount": items.len(),
                    "assertionCount": assertions.len(),
                    "writtenAssertionCount": assertion_items.len(),
                    "dryRun": !(should_write_proposals || should_write_assertions),
                    "extractionMode": "mechanical",
                    "providerName": JsonValue::Null,
                    "questions": questions,
                    "warnings": warnings,
                }))
            },
        )
        .await;
    match result {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(CoreError::Invalid(message)) => json_error(StatusCode::BAD_REQUEST, &message),
        Err(CoreError::NotFound(message)) => json_error(StatusCode::NOT_FOUND, &message),
        Err(CoreError::Conflict(message)) => json_error(StatusCode::CONFLICT, &message),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

pub async fn consolidate(
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
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    if body.limit.is_some_and(|l| l < 0) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"limit is invalid"})),
        )
            .into_response();
    }
    let status = clean(body.status).unwrap_or_else(|| "pending".to_string());
    if !valid_status(&status) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"status is invalid"})),
        )
            .into_response();
    }
    let limit = body.limit.unwrap_or(50).clamp(1, 200);
    let use_provider = body.use_provider.unwrap_or(false);
    let write_proposals = body.write_proposals.unwrap_or(false);
    let created_by = clean(body.created_by.clone())
        .or_else(|| {
            headers
                .get("x-signet-actor")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "ontology-consolidate".to_string());
    let provider_timeout_ms = body
        .provider_timeout_ms
        .unwrap_or(120_000)
        .clamp(1_000, 10 * 60_000) as u64;
    let provider_max_tokens = body.provider_max_tokens.unwrap_or(4096).clamp(1, 16_000) as u32;

    let read_agent = agent.clone();
    let source_result = state
        .pool
        .read(move |conn| {
            let mut stmt = conn.prepare(&format!(
                "{SELECT_PROPOSAL}
                 WHERE agent_id = ?1 AND status = ?2
                 ORDER BY updated_at DESC, created_at DESC
                 LIMIT ?3"
            ))?;
            let source_rows = stmt
                .query_map(
                    rusqlite::params![read_agent.as_str(), status, limit],
                    read_row,
                )?
                .collect::<Result<Vec<_>, _>>()?;
            let source = source_rows
                .iter()
                .map(proposal_prompt_value)
                .collect::<Vec<_>>();
            let conflicts = claim_conflict_values(conn, &read_agent, limit.max(50))?;
            Ok::<(Vec<JsonValue>, Vec<JsonValue>), CoreError>((source, conflicts))
        })
        .await;
    let (source, conflict_items) = match source_result {
        Ok(value) => value,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    };

    let provider = if use_provider {
        state.llm.read().await.clone()
    } else {
        None
    };
    let provider_name = provider
        .as_ref()
        .map(|provider| provider.name().to_string());
    let mut warnings = Vec::<String>::new();
    let mut summary = None;
    let mut rejections = Vec::new();
    let mut result_conflicts = Vec::new();
    let mut maintenance = Vec::new();
    let proposals = if use_provider {
        if let Some(provider) = provider.as_ref() {
            let prompt = consolidation_prompt(&source, &conflict_items);
            match provider
                .generate(
                    &prompt,
                    &GenerateOpts {
                        timeout_ms: Some(provider_timeout_ms),
                        max_tokens: Some(provider_max_tokens),
                    },
                )
                .await
            {
                Ok(result) => {
                    let (
                        proposals,
                        parsed_summary,
                        parsed_rejections,
                        parsed_conflicts,
                        parsed_maintenance,
                    ) = parse_consolidation_output(&result.text, limit as usize);
                    summary = parsed_summary;
                    rejections = parsed_rejections;
                    result_conflicts = parsed_conflicts;
                    maintenance = parsed_maintenance;
                    if proposals.is_empty() && rejections.is_empty() && result_conflicts.is_empty()
                    {
                        warnings.push(format!(
                            "Provider {} returned no valid consolidation output.",
                            provider.name()
                        ));
                    }
                    proposals
                }
                Err(error) => {
                    warnings.push(format!(
                        "Provider {} consolidation failed: {error}",
                        provider.name()
                    ));
                    Vec::new()
                }
            }
        } else {
            warnings.push(
                "Provider consolidation requested but no inference provider is configured."
                    .to_string(),
            );
            Vec::new()
        }
    } else {
        warnings.push(
            "Consolidation is provider-backed; pass use_provider to run the configured inference workload."
                .to_string(),
        );
        Vec::new()
    };

    let should_write = write_proposals && !proposals.is_empty();
    let written = if should_write {
        let write_agent = agent.clone();
        let write_created_by = created_by.clone();
        let write_proposals = proposals.clone();
        let source_count = source.len();
        let result = state
            .pool
            .write_tx(
                Priority::High,
                move |conn| -> Result<JsonValue, CoreError> {
                    let items = write_proposals
                        .into_iter()
                        .map(|proposal| {
                            insert_proposal(
                                conn,
                                ProposalBody {
                                    agent_id: Some(write_agent.clone()),
                                    from_source: None,
                                    operation: read_json_string(&proposal, "operation"),
                                    payload: proposal.get("payload").cloned(),
                                    confidence: read_json_number(&proposal, "confidence"),
                                    rationale: read_json_string(&proposal, "rationale"),
                                    evidence: Some(read_json_array(&proposal, "evidence")),
                                    risk: read_json_string(&proposal, "risk"),
                                    source_kind: Some("ontology_consolidation".to_string()),
                                    source_id: Some(format!("proposals:{source_count}")),
                                    source_path: None,
                                    source_root: None,
                                    created_by: Some(write_created_by.clone()),
                                    actor: None,
                                    reason: None,
                                    proposals: None,
                                    write_proposals: None,
                                    write_assertions: None,
                                    use_provider: None,
                                    provider_timeout_ms: None,
                                    provider_max_tokens: None,
                                    status: None,
                                    limit: None,
                                },
                                &write_agent,
                            )
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(JsonValue::Array(items))
                },
            )
            .await;
        match result {
            Ok(JsonValue::Array(items)) => items,
            Ok(_) => Vec::new(),
            Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
        }
    } else {
        Vec::new()
    };

    (
        StatusCode::OK,
        Json(json!({
            "sourceProposalCount": source.len(),
            "proposals": proposals,
            "items": written,
            "count": proposals.len(),
            "writtenCount": written.len(),
            "dryRun": !should_write,
            "consolidationMode": if use_provider && (!proposals.is_empty() || provider.is_some()) { "provider" } else { "noop" },
            "providerName": provider_name,
            "summary": summary,
            "rejections": rejections,
            "conflicts": result_conflicts,
            "maintenance": maintenance,
            "warnings": warnings,
        })),
    )
    .into_response()
}

pub async fn claim_evidence(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ClaimEvidenceQuery>,
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
    let Some(entity_name) = clean(query.entity) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "entity is required"})),
        )
            .into_response();
    };
    let Some(aspect_name) = clean(query.aspect) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "aspect is required"})),
        )
            .into_response();
    };
    let Some(group) = clean(query.group) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "group is required"})),
        )
            .into_response();
    };
    let Some(claim) = clean(query.claim) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "claim is required"})),
        )
            .into_response();
    };
    if query
        .kind
        .as_deref()
        .is_some_and(|kind| !matches!(kind, "attribute" | "constraint"))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "kind is invalid"})),
        )
            .into_response();
    }
    if query
        .status
        .as_deref()
        .is_some_and(|status| !matches!(status, "active" | "superseded" | "deleted" | "all"))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "status is invalid"})),
        )
            .into_response();
    }

    let kind = query.kind;
    let status = query.status;
    let limit = parse_limit(query.limit.as_deref(), 20, 200);
    let offset = parse_offset(query.offset.as_deref());
    let group_key = {
        let normalized = canonical_path_key(&group);
        if normalized.is_empty() {
            "general".to_string()
        } else {
            normalized
        }
    };
    let claim_key = canonical_path_key(&claim);

    let response = state
        .pool
        .read(move |conn| {
            let entity_canonical = canonical(&entity_name);
            let entity = conn
                .query_row(
                    "SELECT *
                     FROM entities
                     WHERE agent_id = ?1
                       AND COALESCE(status, 'active') = 'active'
                       AND (COALESCE(canonical_name, LOWER(name)) = ?2 OR LOWER(name) = ?2 OR id = ?3)
                     ORDER BY mentions DESC, updated_at DESC, name ASC
                     LIMIT 1",
                    rusqlite::params![agent, entity_canonical, entity_name],
                    read_entity_row,
                )
                .optional()?;
            let Some(entity) = entity else {
                return Ok::<JsonValue, CoreError>(json!({"_code": 404}));
            };
            let aspect_canonical = canonical(&aspect_name);
            let aspect = conn
                .query_row(
                    "SELECT *
                     FROM entity_aspects
                     WHERE entity_id = ?1
                       AND agent_id = ?2
                       AND COALESCE(status, 'active') = 'active'
                       AND (canonical_name = ?3 OR LOWER(name) = ?3 OR id = ?4)
                     ORDER BY weight DESC, updated_at DESC
                     LIMIT 1",
                    rusqlite::params![entity.id, agent, aspect_canonical, aspect_name],
                    read_aspect_row,
                )
                .optional()?;
            let Some(aspect) = aspect else {
                return Ok(json!({"_code": 404}));
            };

            let mut conditions = vec![
                "ea.aspect_id = ?1".to_string(),
                "ea.agent_id = ?2".to_string(),
                "COALESCE(ea.group_key, 'general') = ?3".to_string(),
                "ea.claim_key = ?4".to_string(),
            ];
            let mut args = vec![
                Value::Text(aspect.id.clone()),
                Value::Text(agent.clone()),
                Value::Text(group_key.clone()),
                Value::Text(claim_key.clone()),
            ];
            if let Some(kind) = kind {
                conditions.push(format!("ea.kind = ?{}", args.len() + 1));
                args.push(Value::Text(kind));
            }
            match status.as_deref() {
                Some("all") => {}
                Some(status) => {
                    conditions.push(format!("ea.status = ?{}", args.len() + 1));
                    args.push(Value::Text(status.to_string()));
                }
                None => conditions.push("ea.status = 'active'".to_string()),
            }
            let limit_idx = args.len() + 1;
            let offset_idx = args.len() + 2;
            let sql = format!(
                "SELECT ea.*
                 FROM entity_attributes ea
                 WHERE {}
                 ORDER BY ea.created_at DESC, ea.importance DESC
                 LIMIT ?{limit_idx} OFFSET ?{offset_idx}",
                conditions.join(" AND ")
            );
            args.push(Value::Integer(limit));
            args.push(Value::Integer(offset));
            let params: Vec<&dyn ToSql> = args.iter().map(|v| v as &dyn ToSql).collect();
            let mut stmt = conn.prepare(&sql)?;
            let attributes = stmt
                .query_map(params.as_slice(), read_attribute_evidence_row)?
                .collect::<Result<Vec<_>, _>>()?;
            let items = attributes
                .into_iter()
                .map(|attribute| {
                    let evidence = attribute_evidence_refs(&attribute)
                        .into_iter()
                        .map(|reference| resolve_ontology_evidence_ref(conn, &agent, &reference))
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok::<JsonValue, CoreError>(json!({
                        "attribute": attribute_to_value(&attribute),
                        "evidence": evidence,
                        "evidenceCount": evidence.len(),
                    }))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({
                "entity": entity_to_value(&entity),
                "aspect": aspect_to_value(&aspect),
                "groupKey": group_key,
                "claimKey": claim_key,
                "items": items,
                "count": items.len(),
            }))
        })
        .await;

    match response {
        Ok(value) if value.get("_code").and_then(|code| code.as_i64()) == Some(404) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Claim path not found"})),
        )
            .into_response(),
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

pub async fn link_evidence(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<LinkEvidenceQuery>,
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
            let dependency = conn
                .query_row(
                    "SELECT *
                     FROM entity_dependencies
                     WHERE id = ?1 AND agent_id = ?2
                     LIMIT 1",
                    rusqlite::params![id, agent],
                    read_dependency_evidence_row,
                )
                .optional()?;
            let Some(dependency) = dependency else {
                return Ok::<JsonValue, CoreError>(json!({"_code": 404}));
            };
            let items = link_evidence_refs(&dependency)
                .into_iter()
                .map(|reference| resolve_ontology_evidence_ref(conn, &agent, &reference))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({
                "dependency": dependency_to_value(&dependency),
                "items": items,
                "count": items.len(),
            }))
        })
        .await;

    match result {
        Ok(value) if value.get("_code").and_then(|code| code.as_i64()) == Some(404) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Link not found"})),
        )
            .into_response(),
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}
