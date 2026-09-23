use crate::{
    ontology_proposal_evidence::{evidence_reference_key, resolve_evidence_reference},
    required_agent, CoreError, OntologyLinkEvidenceRequest, Value,
};
use rusqlite::{Connection, OptionalExtension, Row};
use serde_json::json;
use std::collections::HashSet;

fn optional_string(row: &Row<'_>, name: &str) -> rusqlite::Result<Option<String>> {
    let Ok(index) = row.as_ref().column_index(name) else {
        return Ok(None);
    };
    row.get(index)
}

fn required_string(row: &Row<'_>, name: &str) -> Result<String, CoreError> {
    optional_string(row, name)?.ok_or_else(|| {
        CoreError::UnsupportedMigrationHistory(format!(
            "entity_dependencies.{name} is required for ontology link evidence"
        ))
    })
}

fn optional_f64(row: &Row<'_>, name: &str, fallback: f64) -> rusqlite::Result<f64> {
    let Ok(index) = row.as_ref().column_index(name) else {
        return Ok(fallback);
    };
    Ok(row.get::<_, Option<f64>>(index)?.unwrap_or(fallback))
}

fn parse_array(value: Option<String>) -> Value {
    value
        .as_deref()
        .and_then(|text| serde_json::from_str(text).ok())
        .filter(|value: &Value| value.is_array())
        .unwrap_or_else(|| json!([]))
}

fn dependency_row(row: &Row<'_>) -> Result<Value, CoreError> {
    let id = required_string(row, "id")?;
    let source_entity_id = required_string(row, "source_entity_id")?;
    let target_entity_id = required_string(row, "target_entity_id")?;
    let agent_id = required_string(row, "agent_id")?;
    let aspect_id = optional_string(row, "aspect_id")?;
    let dependency_type = required_string(row, "dependency_type")?;
    let strength = optional_f64(row, "strength", 0.5)?;
    let confidence = optional_f64(row, "confidence", 0.7)?;
    let reason = optional_string(row, "reason")?;
    let status = optional_string(row, "status")?.unwrap_or_else(|| "active".into());
    let archived_at = optional_string(row, "archived_at")?;
    let archived_by = optional_string(row, "archived_by")?;
    let archive_reason = optional_string(row, "archive_reason")?;
    let source_kind = optional_string(row, "source_kind")?;
    let source_id = optional_string(row, "source_id")?;
    let source_path = optional_string(row, "source_path")?;
    let source_root = optional_string(row, "source_root")?;
    let proposal_id = optional_string(row, "proposal_id")?;
    let proposal_evidence = parse_array(optional_string(row, "proposal_evidence")?);
    let created_at = required_string(row, "created_at")?;
    let updated_at = required_string(row, "updated_at")?;

    Ok(json!({
        "id": id,
        "sourceEntityId": source_entity_id,
        "targetEntityId": target_entity_id,
        "agentId": agent_id,
        "aspectId": aspect_id,
        "dependencyType": dependency_type,
        "strength": strength,
        "confidence": confidence,
        "reason": reason,
        "status": status,
        "archivedAt": archived_at,
        "archivedBy": archived_by,
        "archiveReason": archive_reason,
        "sourceKind": source_kind,
        "sourceId": source_id,
        "sourcePath": source_path,
        "sourceRoot": source_root,
        "proposalId": proposal_id,
        "proposalEvidence": proposal_evidence,
        "createdAt": created_at,
        "updatedAt": updated_at,
    }))
}

fn references(dependency: &Value) -> Vec<Value> {
    let mut refs = Vec::new();
    let dependency_id = dependency["id"].as_str().unwrap_or_default();
    let proposal_id = dependency["proposalId"].as_str();
    let source_kind = dependency["sourceKind"].as_str();
    let source_id = dependency["sourceId"].as_str();
    let source_path = dependency["sourcePath"].as_str();
    let source_root = dependency["sourceRoot"].as_str();

    if let Some(proposal_id) = proposal_id {
        refs.push(json!({
            "dependency_id": dependency_id,
            "proposal_id": proposal_id,
        }));
    }
    if let Some(items) = dependency["proposalEvidence"].as_array() {
        refs.extend(items.iter().cloned());
    }
    if source_kind.is_some() || source_id.is_some() {
        refs.push(json!({
            "dependency_id": dependency_id,
            "source_kind": source_kind,
            "source_id": source_id,
        }));
    }
    if source_path.is_some() {
        refs.push(json!({
            "dependency_id": dependency_id,
            "source_kind": source_kind,
            "source_id": source_id,
            "source_path": source_path,
            "source_root": source_root,
        }));
    }
    let mut seen = HashSet::new();
    refs.retain(|reference| seen.insert(evidence_reference_key(reference)));
    refs
}

pub fn execute(
    connection: &Connection,
    request: OntologyLinkEvidenceRequest,
) -> Result<Value, CoreError> {
    let agent_id = required_agent(&request.agent_id)?;
    let dependency = connection
        .query_row(
            "SELECT * FROM entity_dependencies WHERE id=? AND agent_id=? LIMIT 1",
            rusqlite::params![request.id, agent_id],
            |row| {
                dependency_row(row)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
            },
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFoundMessage("Link not found".into()))?;

    let mut items = Vec::new();
    for reference in references(&dependency) {
        items.push(resolve_evidence_reference(
            connection, &agent_id, &reference,
        )?);
    }
    let count = items.len();
    Ok(json!({
        "dependency": dependency,
        "items": items,
        "count": count,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn link_evidence_returns_dependency_and_deduped_references() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE entity_dependencies (
                id TEXT PRIMARY KEY, source_entity_id TEXT NOT NULL,
                target_entity_id TEXT NOT NULL, agent_id TEXT NOT NULL,
                aspect_id TEXT, dependency_type TEXT NOT NULL,
                strength REAL NOT NULL, confidence REAL, reason TEXT,
                status TEXT, archived_at TEXT, archived_by TEXT,
                archive_reason TEXT, source_kind TEXT, source_id TEXT,
                source_path TEXT, source_root TEXT, proposal_id TEXT,
                proposal_evidence TEXT, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO entity_dependencies
                (id,source_entity_id,target_entity_id,agent_id,dependency_type,strength,
                 confidence,status,source_kind,source_id,proposal_evidence,created_at,updated_at)
            VALUES
                ('link-a','entity-a','entity-b','agent-a','supports',0.8,0.9,'active',
                 'transcript','session-1','[{\"source_kind\":\"transcript\",\"source_id\":\"session-1\"}]',
                 'created','updated');
            INSERT INTO entity_dependencies
                (id,source_entity_id,target_entity_id,agent_id,dependency_type,strength,
                 confidence,status,created_at,updated_at)
            VALUES
                ('link-b','entity-a','entity-b','agent-b','supports',0.8,0.9,'active','created','updated');",
        )
        .unwrap();

        let result = execute(
            &db,
            OntologyLinkEvidenceRequest {
                agent_id: "agent-a".into(),
                id: "link-a".into(),
            },
        )
        .unwrap();
        assert_eq!(result["dependency"]["id"], "link-a");
        assert_eq!(result["dependency"]["agentId"], "agent-a");
        assert_eq!(result["count"], 1);
        assert_eq!(result["items"][0]["kind"], "unresolved");
        assert!(matches!(
            execute(
                &db,
                OntologyLinkEvidenceRequest {
                    agent_id: "agent-b".into(),
                    id: "link-a".into(),
                },
            ),
            Err(CoreError::NotFoundMessage(message)) if message == "Link not found"
        ));
    }
}
