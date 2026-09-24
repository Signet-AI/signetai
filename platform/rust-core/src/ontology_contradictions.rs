use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde_json::{Value, json};
use std::collections::HashSet;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{CoreError, OntologyContradictionGetRequest, OntologyContradictionListRequest};

const NEGATION_TOKENS: [&str; 11] = [
    "not", "no", "never", "cannot", "cant", "doesnt", "dont", "isnt", "wasnt", "wont", "without",
];
const PROSPECTIVE_ANTONYM_PAIRS: [(&str, &str); 6] = [
    ("enabled", "disabled"),
    ("allow", "deny"),
    ("accept", "reject"),
    ("always", "never"),
    ("on", "off"),
    ("true", "false"),
];

#[derive(Clone, Debug)]
struct ActiveClaim {
    entity_id: String,
    aspect_id: String,
    group_key: String,
    claim_key: String,
    kind: String,
    content: String,
}

pub(crate) fn execute_list(
    connection: &mut Connection,
    request: OntologyContradictionListRequest,
) -> Result<Value, CoreError> {
    let agent_id = required_agent(&request.agent_id)?;
    let status = parse_status(request.status.as_deref())?;
    let limit = request.limit.unwrap_or(50).clamp(1, 200);
    let offset = request.offset.unwrap_or(0);
    reconcile(connection, &agent_id, request.source_id.as_deref())?;

    let (where_clause, args) = list_where(&agent_id, &request, status.as_deref());
    let mut rows_args = args.clone();
    rows_args.push(SqlValue::Integer(limit as i64));
    rows_args.push(SqlValue::Integer(offset as i64));
    let sql = format!(
        "SELECT c.* FROM ontology_contradictions c WHERE {where_clause} ORDER BY CASE WHEN c.status = 'active' THEN 0 ELSE 1 END, c.updated_at DESC LIMIT ? OFFSET ?"
    );
    let items = connection
        .prepare(&sql)?
        .query_map(params_from_iter(rows_args), contradiction_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let count_sql = format!("SELECT COUNT(*) FROM ontology_contradictions c WHERE {where_clause}");
    let count: i64 = connection.query_row(&count_sql, params_from_iter(args), |row| row.get(0))?;
    Ok(json!({
        "items": items,
        "count": count,
        "limit": limit,
        "offset": offset,
    }))
}

pub(crate) fn execute_get(
    connection: &mut Connection,
    request: OntologyContradictionGetRequest,
) -> Result<Value, CoreError> {
    let agent_id = required_agent(&request.agent_id)?;
    reconcile(connection, &agent_id, None)?;
    connection
        .query_row(
            "SELECT c.* FROM ontology_contradictions c WHERE c.id = ? AND c.agent_id = ?",
            params![request.id, agent_id],
            contradiction_row,
        )
        .optional()
        .map_err(CoreError::from)
        .map(|row| row.unwrap_or(Value::Null))
}

fn required_agent(value: &str) -> Result<String, CoreError> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(CoreError::InvalidInput("agent_id is required".into()));
    }
    Ok(normalized.to_owned())
}

fn parse_status(value: Option<&str>) -> Result<Option<String>, CoreError> {
    let normalized = value.map(str::trim).filter(|value| !value.is_empty());
    match normalized {
        None => Ok(Some("active".into())),
        Some("active") => Ok(Some("active".into())),
        Some("resolved") => Ok(Some("resolved".into())),
        Some("all") => Ok(None),
        Some(_) => Err(CoreError::InvalidInput("status is invalid".into())),
    }
}

fn list_where(
    agent_id: &str,
    request: &OntologyContradictionListRequest,
    status: Option<&str>,
) -> (String, Vec<SqlValue>) {
    let mut clauses = vec!["c.agent_id = ?".to_owned()];
    let mut args = vec![SqlValue::Text(agent_id.to_owned())];
    if let Some(status) = status {
        clauses.push("c.status = ?".into());
        args.push(SqlValue::Text(status.to_owned()));
    }
    if let Some(value) = request.entity_id.as_deref() {
        clauses.push("c.entity_id = ?".into());
        args.push(SqlValue::Text(value.to_owned()));
    }
    if let Some(value) = request.entity.as_deref() {
        clauses.push("LOWER(c.entity_name) = LOWER(?)".into());
        args.push(SqlValue::Text(value.to_owned()));
    }
    if let Some(value) = request.aspect_id.as_deref() {
        clauses.push("c.aspect_id = ?".into());
        args.push(SqlValue::Text(value.to_owned()));
    }
    if let Some(value) = request.group_key.as_deref() {
        clauses.push("c.group_key = ?".into());
        args.push(SqlValue::Text(value.to_owned()));
    }
    if let Some(value) = request.claim_key.as_deref() {
        clauses.push("c.claim_key = ?".into());
        args.push(SqlValue::Text(value.to_owned()));
    }
    if let Some(value) = request.source_id.as_deref() {
        clauses.push("(c.left_source_id = ? OR c.right_source_id = ?)".into());
        args.push(SqlValue::Text(value.to_owned()));
        args.push(SqlValue::Text(value.to_owned()));
    }
    (clauses.join(" AND "), args)
}

fn contradiction_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "agentId": row.get::<_, String>(1)?,
        "entityId": row.get::<_, Option<String>>(2)?,
        "entityName": row.get::<_, String>(3)?,
        "aspectId": row.get::<_, Option<String>>(4)?,
        "aspectName": row.get::<_, String>(5)?,
        "groupKey": row.get::<_, String>(6)?,
        "claimKey": row.get::<_, String>(7)?,
        "leftAttributeId": row.get::<_, Option<String>>(8)?,
        "rightAttributeId": row.get::<_, Option<String>>(9)?,
        "leftContent": row.get::<_, String>(10)?,
        "rightContent": row.get::<_, String>(11)?,
        "leftConfidence": clamp01(row.get::<_, f64>(12)?),
        "rightConfidence": clamp01(row.get::<_, f64>(13)?),
        "leftScope": row.get::<_, Option<String>>(14)?,
        "rightScope": row.get::<_, Option<String>>(15)?,
        "leftVisibility": row.get::<_, Option<String>>(16)?,
        "rightVisibility": row.get::<_, Option<String>>(17)?,
        "leftSourceKind": row.get::<_, Option<String>>(18)?,
        "leftSourceId": row.get::<_, Option<String>>(19)?,
        "leftSourcePath": row.get::<_, Option<String>>(20)?,
        "leftSourceRoot": row.get::<_, Option<String>>(21)?,
        "rightSourceKind": row.get::<_, Option<String>>(22)?,
        "rightSourceId": row.get::<_, Option<String>>(23)?,
        "rightSourcePath": row.get::<_, Option<String>>(24)?,
        "rightSourceRoot": row.get::<_, Option<String>>(25)?,
        "leftEvidence": json_array(row.get::<_, String>(26)?),
        "rightEvidence": json_array(row.get::<_, String>(27)?),
        "detector": row.get::<_, String>(28)?,
        "reason": row.get::<_, String>(29)?,
        "confidence": clamp01(row.get::<_, f64>(30)?),
        "status": row.get::<_, String>(31)?,
        "detectedAt": row.get::<_, String>(32)?,
        "resolvedAt": row.get::<_, Option<String>>(33)?,
        "resolutionReason": row.get::<_, Option<String>>(34)?,
        "createdAt": row.get::<_, String>(35)?,
        "updatedAt": row.get::<_, String>(36)?,
    }))
}

fn clamp01(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

fn json_array(value: String) -> Value {
    if value.is_empty() {
        return json!([]);
    }
    match serde_json::from_str::<Value>(&value) {
        Ok(parsed) if parsed.is_array() => parsed,
        Ok(_) => json!([]),
        Err(_) => json!([{"raw": value, "parseError": "invalid_json_array"}]),
    }
}

fn reconcile(
    connection: &mut Connection,
    agent_id: &str,
    source_id: Option<&str>,
) -> Result<(), CoreError> {
    let mut clauses = vec!["c.agent_id = ?", "c.status = 'active'"];
    let mut args = vec![SqlValue::Text(agent_id.to_owned())];
    if let Some(source_id) = source_id {
        clauses.push("(c.left_source_id = ? OR c.right_source_id = ?)");
        args.push(SqlValue::Text(source_id.to_owned()));
        args.push(SqlValue::Text(source_id.to_owned()));
    }
    let sql = format!(
        "SELECT c.id, c.left_attribute_id, c.right_attribute_id FROM ontology_contradictions c WHERE {}",
        clauses.join(" AND ")
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(params_from_iter(args), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, left_id, right_id) in rows {
        let left = active_claim(connection, agent_id, left_id.as_deref())?;
        let right = active_claim(connection, agent_id, right_id.as_deref())?;
        let still_contradictory = match (left, right) {
            (Some(left), Some(right))
                if left.entity_id == right.entity_id
                    && left.aspect_id == right.aspect_id
                    && left.group_key == right.group_key
                    && left.claim_key == right.claim_key
                    && left.kind != "constraint"
                    && right.kind != "constraint" =>
            {
                detect_reason(&left.content, &right.content).is_some()
            }
            _ => false,
        };
        if still_contradictory {
            continue;
        }
        let reason = if left_id.is_none() || right_id.is_none() {
            "one competing claim is no longer active"
        } else if active_claim(connection, agent_id, left_id.as_deref())?.is_none()
            || active_claim(connection, agent_id, right_id.as_deref())?.is_none()
        {
            "one competing claim is no longer active"
        } else {
            "claims no longer conflict"
        };
        let timestamp = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        connection.execute(
            "UPDATE ontology_contradictions SET status='resolved', resolved_at=?, resolution_reason=?, updated_at=? WHERE id=? AND agent_id=? AND status='active'",
            params![timestamp, reason, timestamp, id, agent_id],
        )?;
    }
    Ok(())
}

fn active_claim(
    connection: &Connection,
    agent_id: &str,
    attribute_id: Option<&str>,
) -> Result<Option<ActiveClaim>, CoreError> {
    let Some(attribute_id) = attribute_id else {
        return Ok(None);
    };
    connection
        .query_row(
            "SELECT attr.id, asp.entity_id, asp.id, COALESCE(attr.group_key,'general'), attr.claim_key, COALESCE(attr.kind,'attribute'), attr.content
             FROM entity_attributes attr
             JOIN entity_aspects asp ON asp.id=attr.aspect_id AND asp.agent_id=attr.agent_id
             JOIN entities e ON e.id=asp.entity_id AND e.agent_id=asp.agent_id
             WHERE attr.id=? AND attr.agent_id=? AND attr.status='active'
               AND COALESCE(asp.status,'active')='active' AND COALESCE(e.status,'active')='active'",
            params![attribute_id, agent_id],
            |row| {
                Ok(ActiveClaim {
                    entity_id: row.get::<_, String>(1)?.trim().to_owned(),
                    aspect_id: row.get::<_, String>(2)?.trim().to_owned(),
                    group_key: row
                        .get::<_, Option<String>>(3)?
                        .and_then(|value| {
                            let value = value.trim().to_owned();
                            (!value.is_empty()).then_some(value)
                        })
                        .unwrap_or_else(|| "general".into()),
                    claim_key: row
                        .get::<_, Option<String>>(4)?
                        .unwrap_or_default()
                        .trim()
                        .to_owned(),
                    kind: row
                        .get::<_, Option<String>>(5)?
                        .and_then(|value| {
                            let value = value.trim().to_owned();
                            (!value.is_empty()).then_some(value)
                        })
                        .unwrap_or_else(|| "attribute".into()),
                    content: row.get::<_, String>(6)?.trim().to_owned(),
                })
            },
        )
        .optional()
        .map(|claim| {
            claim.filter(|claim| {
                !claim.entity_id.is_empty()
                    && !claim.aspect_id.is_empty()
                    && !claim.claim_key.is_empty()
                    && !claim.content.is_empty()
            })
        })
        .map_err(CoreError::from)
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character.is_ascii_whitespace() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .filter(|token| token.len() >= 2)
        .map(ToOwned::to_owned)
        .collect()
}

fn detect_reason(left: &str, right: &str) -> Option<&'static str> {
    let left_tokens = tokenize(left);
    let right_tokens = tokenize(right);
    if left_tokens.is_empty() || right_tokens.is_empty() {
        return None;
    }
    let right_set = right_tokens.iter().collect::<HashSet<_>>();
    let overlap = left_tokens
        .iter()
        .filter(|token| right_set.contains(token))
        .count();
    if overlap < 2 {
        return None;
    }
    let left_has_negation = left_tokens
        .iter()
        .any(|token| NEGATION_TOKENS.contains(&token.as_str()));
    let right_has_negation = right_tokens
        .iter()
        .any(|token| NEGATION_TOKENS.contains(&token.as_str()));
    if left_has_negation != right_has_negation {
        return Some("negation_mismatch");
    }
    let left_set = left_tokens.iter().collect::<HashSet<_>>();
    let right_set = right_tokens.iter().collect::<HashSet<_>>();
    for (a, b) in PROSPECTIVE_ANTONYM_PAIRS {
        let left_a = left_set.contains(&a.to_owned());
        let left_b = left_set.contains(&b.to_owned());
        let right_a = right_set.contains(&a.to_owned());
        let right_b = right_set.contains(&b.to_owned());
        if (left_a ^ left_b) && (right_a ^ right_b) && ((left_a && right_b) || (left_b && right_a))
        {
            return Some("antonym_conflict");
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{detect_reason, execute_list};
    use crate::{OntologyContradictionListRequest, migrate};
    use rusqlite::{Connection, params};
    use serde_json::Value;

    #[test]
    fn detector_matches_typescript_threshold_and_reasons() {
        assert_eq!(
            detect_reason("feature enabled for users", "feature disabled for users"),
            Some("antonym_conflict")
        );
        assert_eq!(
            detect_reason("feature is enabled", "feature is not enabled"),
            Some("negation_mismatch")
        );
        assert_eq!(detect_reason("enabled", "disabled"), None);
        assert_eq!(detect_reason("feature enabled", "feature enabled"), None);
    }

    #[test]
    fn list_is_agent_scoped_and_reconciles_stale_rows() {
        let mut connection = Connection::open_in_memory().expect("open sqlite");
        migrate(&mut connection).expect("migrate");
        connection
            .execute(
                "INSERT INTO entities (id, agent_id, name) VALUES ('entity-a', 'agent-a', 'Feature')",
                [],
            )
            .expect("entity");
        connection
            .execute(
                "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, created_at, updated_at) VALUES ('aspect-a', 'entity-a', 'agent-a', 'state', 'state', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .expect("aspect");
        connection
            .execute(
                "INSERT INTO entity_attributes (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key, confidence, created_at, updated_at) VALUES ('attr-left', 'aspect-a', 'agent-a', 'attribute', 'feature enabled for users', 'feature enabled for users', 'general', 'state', 0.8, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('attr-right', 'aspect-a', 'agent-a', 'attribute', 'feature disabled for users', 'feature disabled for users', 'general', 'state', 0.7, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .expect("attributes");
        connection
            .execute(
                "INSERT INTO ontology_contradictions (id, agent_id, entity_id, entity_name, aspect_id, aspect_name, group_key, claim_key, left_attribute_id, right_attribute_id, left_content, right_content, left_confidence, right_confidence, detector, reason, confidence, detected_at, created_at, updated_at) VALUES ('contradiction-a', 'agent-a', 'entity-a', 'Feature', 'aspect-a', 'state', 'general', 'state', 'attr-left', 'attr-right', 'feature enabled for users', 'feature disabled for users', 0.8, 0.7, 'lexical', 'antonym_conflict', 0.9, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .expect("contradiction");

        let result = execute_list(
            &mut connection,
            OntologyContradictionListRequest {
                agent_id: "agent-a".into(),
                entity: None,
                entity_id: None,
                aspect_id: None,
                group_key: None,
                claim_key: None,
                source_id: None,
                status: None,
                limit: Some(10),
                offset: Some(0),
            },
        )
        .expect("list");
        assert_eq!(result["count"], 1);
        assert_eq!(result["items"][0]["agentId"], "agent-a");

        connection
            .execute(
                "UPDATE entity_attributes SET content='feature enabled for users', normalized_content='feature enabled for users' WHERE id='attr-right'",
                [],
            )
            .expect("update claim");
        let reconciled = execute_list(
            &mut connection,
            OntologyContradictionListRequest {
                agent_id: "agent-a".into(),
                entity: None,
                entity_id: None,
                aspect_id: None,
                group_key: None,
                claim_key: None,
                source_id: None,
                status: Some("all".into()),
                limit: Some(10),
                offset: Some(0),
            },
        )
        .expect("reconciled list");
        assert_eq!(reconciled["count"], 1);
        assert_eq!(reconciled["items"][0]["status"], "resolved");
        let _: Value = reconciled;
        let status: String = connection
            .query_row(
                "SELECT status FROM ontology_contradictions WHERE id='contradiction-a'",
                params![],
                |row| row.get(0),
            )
            .expect("status");
        assert_eq!(status, "resolved");
    }
}
