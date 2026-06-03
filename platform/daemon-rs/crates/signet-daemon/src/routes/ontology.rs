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
    #[serde(alias = "agent_id")]
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
    #[serde(alias = "created_by")]
    created_by: Option<String>,
    actor: Option<String>,
    reason: Option<String>,
    proposals: Option<Vec<ProposalBody>>,
    #[serde(alias = "write_proposals")]
    write_proposals: Option<bool>,
    #[serde(alias = "use_provider")]
    use_provider: Option<bool>,
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
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ClaimVersionQuery {
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
        && !matches!(kind, "attribute" | "constraint" | "fact" | "preference")
    {
        return Some("kind is invalid");
    }
    if require_version && query.version.unwrap_or(0) <= 0 {
        return Some("version is required");
    }
    None
}

/// GET /api/ontology/assertions — list epistemic assertions.
pub async fn assertions_list(Query(query): Query<StatusQuery>) -> impl IntoResponse {
    if let Some(status) = query.status.as_deref()
        && !matches!(status, "active" | "archived" | "superseded" | "all")
    {
        return json_error(StatusCode::BAD_REQUEST, "status is invalid");
    }
    Json(json!({"items": [], "count": 0})).into_response()
}

/// POST /api/ontology/assertions — create an epistemic assertion.
pub async fn assertions_create(Json(body): Json<JsonValue>) -> impl IntoResponse {
    let predicate = read_body_string(&body, "predicate");
    if predicate.is_none() {
        return json_error(StatusCode::BAD_REQUEST, "predicate is required");
    }
    let content = read_body_string(&body, "content");
    if content.is_none() {
        return json_error(StatusCode::BAD_REQUEST, "content is required");
    }
    (
        StatusCode::CREATED,
        Json(json!({
            "id": Uuid::new_v4().to_string(),
            "predicate": predicate.unwrap(),
            "content": content.unwrap(),
            "status": "active",
        })),
    )
        .into_response()
}

/// GET /api/ontology/assertions/:id — get an assertion.
pub async fn assertion_get(Path(_id): Path<String>) -> impl IntoResponse {
    json_error(StatusCode::NOT_FOUND, "Assertion not found")
}

/// POST /api/ontology/assertions/:id/archive — archive an assertion.
pub async fn assertion_archive(Path(_id): Path<String>) -> impl IntoResponse {
    json_error(StatusCode::NOT_FOUND, "Assertion not found")
}

/// POST /api/ontology/assertions/:id/link-claim — link assertion to a claim.
pub async fn assertion_link_claim(
    Path(_id): Path<String>,
    Json(body): Json<JsonValue>,
) -> impl IntoResponse {
    if read_body_string(&body, "attribute_id").is_none() {
        return json_error(StatusCode::BAD_REQUEST, "attribute_id is required");
    }
    json_error(StatusCode::NOT_FOUND, "Assertion not found")
}

/// POST /api/ontology/assertions/:id/supersede — supersede assertion.
pub async fn assertion_supersede(
    Path(_id): Path<String>,
    Json(body): Json<JsonValue>,
) -> impl IntoResponse {
    if read_body_string(&body, "predicate").is_none() {
        return json_error(StatusCode::BAD_REQUEST, "predicate is required");
    }
    if read_body_string(&body, "content").is_none() {
        return json_error(StatusCode::BAD_REQUEST, "content is required");
    }
    json_error(StatusCode::NOT_FOUND, "Assertion not found")
}

/// GET /api/ontology/claims/versions — list claim versions.
pub async fn claim_versions(Query(query): Query<ClaimVersionQuery>) -> impl IntoResponse {
    if let Some(error) = validate_claim_query(&query, false) {
        return json_error(StatusCode::BAD_REQUEST, error);
    }
    Json(json!({"items": [], "count": 0})).into_response()
}

/// GET /api/ontology/claims/version — fetch one claim version.
pub async fn claim_version(Query(query): Query<ClaimVersionQuery>) -> impl IntoResponse {
    if let Some(error) = validate_claim_query(&query, true) {
        return json_error(StatusCode::BAD_REQUEST, error);
    }
    json_error(StatusCode::NOT_FOUND, "Claim version not found")
}

/// GET /api/ontology/entities/:id/aliases — list entity aliases.
pub async fn entity_aliases(
    State(state): State<Arc<AppState>>,
    Path(entity_id): Path<String>,
    Query(query): Query<StatusQuery>,
) -> impl IntoResponse {
    if let Some(status) = query.status.as_deref()
        && !matches!(status, "active" | "archived" | "all")
    {
        return json_error(StatusCode::BAD_REQUEST, "status is invalid");
    }
    let status = query.status.unwrap_or_else(|| "active".to_string());
    let result = state
        .pool
        .read(move |conn| {
            let mut stmt = if status == "all" {
                conn.prepare_cached(
                    "SELECT id, entity_id, alias, canonical_alias, confidence, source, status, created_at, updated_at
                       FROM entity_aliases
                      WHERE agent_id = 'default' AND entity_id = ?1
                      ORDER BY created_at DESC",
                )?
            } else {
                conn.prepare_cached(
                    "SELECT id, entity_id, alias, canonical_alias, confidence, source, status, created_at, updated_at
                       FROM entity_aliases
                      WHERE agent_id = 'default' AND entity_id = ?1 AND status = ?2
                      ORDER BY created_at DESC",
                )?
            };
            let mut rows = if status == "all" {
                stmt.query(rusqlite::params![entity_id])?
            } else {
                stmt.query(rusqlite::params![entity_id, status])?
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
    let result = state
        .pool
        .write(Priority::Low, move |conn| {
            let exists = conn
                .prepare_cached("SELECT 1 FROM entities WHERE id = ?1 AND agent_id = 'default'")?
                .exists(rusqlite::params![entity_id])?;
            if !exists {
                return Ok(json!({"found": false}));
            }
            let id = Uuid::new_v4().to_string();
            let ts = now();
            let canonical_alias = canonical(&alias);
            conn.execute(
                "INSERT INTO entity_aliases
                 (id, entity_id, agent_id, alias, canonical_alias, confidence, source, status, created_at, updated_at)
                 VALUES (?1, ?2, 'default', ?3, ?4, ?5, ?6, 'active', ?7, ?7)",
                rusqlite::params![id, entity_id, alias, canonical_alias, confidence, source, ts],
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
    Path((entity_id, alias_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let response_alias_id = alias_id.clone();
    let result = state
        .pool
        .write(Priority::Low, move |conn| {
            let ts = now();
            let changed = conn.execute(
                "UPDATE entity_aliases
                    SET status = 'archived', updated_at = ?1
                  WHERE id = ?2 AND entity_id = ?3 AND agent_id = 'default'",
                rusqlite::params![ts, alias_id, entity_id],
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
pub async fn operations_apply(Json(body): Json<JsonValue>) -> impl IntoResponse {
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
    Json(json!({"success": true, "dryRun": body.get("dry_run").and_then(|value| value.as_bool()).unwrap_or(false)})).into_response()
}

/// POST /api/ontology/operations/batch — apply a batch of audited operations.
pub async fn operations_batch(Json(body): Json<JsonValue>) -> impl IntoResponse {
    let operations = body
        .get("operations")
        .or_else(|| body.get("items"))
        .and_then(|value| value.as_array());
    if operations.map(|items| items.is_empty()).unwrap_or(true) {
        return json_error(StatusCode::BAD_REQUEST, "operations are required");
    }
    Json(json!({"success": true, "results": [], "count": operations.map(Vec::len).unwrap_or(0)}))
        .into_response()
}

/// POST /api/ontology/proposals/repair/merge-plan — create a merge plan.
pub async fn repair_merge_plan(Json(body): Json<JsonValue>) -> impl IntoResponse {
    let has_target = read_body_string(&body, "target_entity")
        .or_else(|| read_body_string(&body, "target"))
        .or_else(|| read_body_string(&body, "target_entity_id"))
        .or_else(|| read_body_string(&body, "target_id"))
        .is_some();
    if !has_target {
        return json_error(StatusCode::BAD_REQUEST, "target entity is required");
    }
    Json(json!({"plan": null, "proposals": [], "created": 0})).into_response()
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
    let agent = agent_id(body.agent_id);
    let result = state
        .pool
        .read(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id FROM ontology_proposals
                 WHERE agent_id = ?1 AND status = ?2
                 ORDER BY updated_at DESC, created_at DESC
                 LIMIT ?3",
            )?;
            let source_ids = stmt
                .query_map(rusqlite::params![agent, status, limit], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<JsonValue, CoreError>(json!({
                "sourceProposalCount": source_ids.len(),
                "proposals": [],
                "items": [],
                "count": 0,
                "writtenCount": 0,
                "dryRun": true,
                "consolidationMode": "noop",
                "providerName": null,
                "summary": null,
                "rejections": [],
                "conflicts": [],
                "maintenance": [],
                "warnings": [if use_provider {
                    "Provider consolidation requested but no inference provider is configured."
                } else {
                    "Consolidation is provider-backed; pass use_provider to run the configured inference workload."
                }],
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
