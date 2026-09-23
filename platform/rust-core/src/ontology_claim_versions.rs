use crate::{
    canonical_key, required_agent, CoreError, OntologyClaimVersionRequest,
    OntologyClaimVersionsRequest, Value,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

fn selector_key(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn resolve_entity(
    connection: &Connection,
    agent_id: &str,
    selector: &str,
) -> Result<String, CoreError> {
    let exact = connection
        .query_row(
            "SELECT id FROM entities WHERE agent_id=? AND id=? LIMIT 1",
            params![agent_id, selector],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(id) = exact {
        return Ok(id);
    }

    let key = selector_key(selector);
    let mut statement = connection.prepare(
        "SELECT id FROM entities
         WHERE agent_id=?
           AND (COALESCE(canonical_name, LOWER(name))=? OR LOWER(name)=?)
         ORDER BY updated_at DESC, name ASC",
    )?;
    let ids = statement
        .query_map(params![agent_id, key, key], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    match ids.as_slice() {
        [] => Err(CoreError::NotFoundMessage(format!(
            "Entity not found: {selector}"
        ))),
        [id] => Ok(id.clone()),
        _ => Err(CoreError::Conflict(format!(
            "Entity selector is ambiguous: {selector}. Use an id."
        ))),
    }
}

fn resolve_aspect(
    connection: &Connection,
    agent_id: &str,
    entity_id: &str,
    selector: &str,
) -> Result<String, CoreError> {
    let exact = connection
        .query_row(
            "SELECT id FROM entity_aspects WHERE entity_id=? AND agent_id=? AND id=? LIMIT 1",
            params![entity_id, agent_id, selector],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(id) = exact {
        return Ok(id);
    }

    let key = selector_key(selector);
    let mut statement = connection.prepare(
        "SELECT id FROM entity_aspects
         WHERE entity_id=?
           AND agent_id=?
           AND (canonical_name=? OR LOWER(name)=?)
         ORDER BY updated_at DESC, name ASC",
    )?;
    let ids = statement
        .query_map(params![entity_id, agent_id, key, key], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    match ids.as_slice() {
        [] => Err(CoreError::NotFoundMessage(format!(
            "Aspect not found: {selector}"
        ))),
        [id] => Ok(id.clone()),
        _ => Err(CoreError::Conflict(format!(
            "Aspect selector is ambiguous: {selector}. Use an id."
        ))),
    }
}

fn has_attribute_column(connection: &Connection, column: &str) -> Result<bool, CoreError> {
    let mut statement = connection.prepare("PRAGMA table_info(entity_attributes)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns.iter().any(|value| value == column))
}

fn claim_version_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let id = row.get::<_, String>(0)?;
    let version_root_id = row
        .get::<_, Option<String>>(14)?
        .unwrap_or_else(|| id.clone());
    Ok(json!({
        "id": id,
        "version": row.get::<_, Option<i64>>(13)?.unwrap_or(1),
        "versionRootId": version_root_id,
        "previousAttributeId": row.get::<_, Option<String>>(15)?,
        "content": row.get::<_, String>(2)?,
        "status": row.get::<_, String>(3)?,
        "confidence": row.get::<_, f64>(4)?,
        "proposalId": row.get::<_, Option<String>>(23)?,
        "sourceKind": row.get::<_, Option<String>>(19)?,
        "sourceId": row.get::<_, Option<String>>(20)?,
        "sourcePath": row.get::<_, Option<String>>(21)?,
        "createdAt": row.get::<_, String>(7)?,
        "updatedAt": row.get::<_, String>(8)?,
    }))
}

fn query_items(
    connection: &Connection,
    request: OntologyClaimVersionsRequest,
) -> Result<Vec<Value>, CoreError> {
    let agent_id = required_agent(&request.agent_id)?;
    let entity_selector = request.entity.trim();
    if entity_selector.is_empty() {
        return Err(CoreError::InvalidInput("entity is required".into()));
    }
    let aspect_selector = request.aspect.trim();
    if aspect_selector.is_empty() {
        return Err(CoreError::InvalidInput("aspect is required".into()));
    }
    let group_key = canonical_key(&request.group_key);
    let group_key = if group_key.is_empty() {
        "general".to_owned()
    } else {
        group_key
    };
    let claim_key = canonical_key(&request.claim_key);
    if claim_key.is_empty() {
        return Err(CoreError::InvalidInput("claim is required".into()));
    }
    let kind = request.kind.unwrap_or_else(|| "attribute".into());
    if kind != "attribute" && kind != "constraint" {
        return Err(CoreError::InvalidInput("kind is invalid".into()));
    }

    let entity_id = resolve_entity(connection, &agent_id, entity_selector)?;
    let aspect_id = resolve_aspect(connection, &agent_id, &entity_id, aspect_selector)?;
    let has_kind = has_attribute_column(connection, "kind")?;
    if !has_kind {
        return Err(CoreError::UnsupportedMigrationHistory(
            "entity_attributes.kind is required for claim versions".into(),
        ));
    }
    let projection = crate::attribute_projection(connection)?;
    let has_group_key = has_attribute_column(connection, "group_key")?;
    let has_claim_key = has_attribute_column(connection, "claim_key")?;
    if !has_claim_key {
        return Err(CoreError::UnsupportedMigrationHistory(
            "entity_attributes.claim_key is required for claim versions".into(),
        ));
    }
    let has_version = has_attribute_column(connection, "version")?;
    let group_predicate = if has_group_key {
        "COALESCE(attr.group_key,'general')=?"
    } else {
        "?='general'"
    };
    let version_order = if has_version {
        "attr.version DESC"
    } else {
        "1 DESC"
    };
    let sql = format!(
        "SELECT {projection} FROM entity_attributes attr
         WHERE attr.agent_id=?
           AND attr.aspect_id=?
           AND {group_predicate}
           AND attr.claim_key=?
           AND attr.kind=?
         ORDER BY {version_order}, attr.updated_at DESC"
    );
    let mut statement = connection.prepare(&sql)?;
    let items = statement
        .query_map(
            params![agent_id, aspect_id, group_key, claim_key, kind],
            claim_version_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}

pub fn execute(
    connection: &Connection,
    request: OntologyClaimVersionsRequest,
) -> Result<Value, CoreError> {
    let items = query_items(connection, request)?;
    let count = items.len();
    Ok(json!({"items": items, "count": count}))
}

pub fn execute_one(
    connection: &Connection,
    request: OntologyClaimVersionRequest,
) -> Result<Value, CoreError> {
    if request.version < 1 || request.version > 1_000_000 {
        return Err(CoreError::InvalidInput(
            "version must be between 1 and 1000000".into(),
        ));
    }
    let items = query_items(
        connection,
        OntologyClaimVersionsRequest {
            agent_id: request.agent_id,
            entity: request.entity,
            aspect: request.aspect,
            group_key: request.group_key,
            claim_key: request.claim_key,
            kind: request.kind,
        },
    )?;
    Ok(items
        .into_iter()
        .find(|item| item.get("version").and_then(Value::as_i64) == Some(request.version))
        .unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_kind_is_an_explicit_unsupported_schema_error() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE entities (id TEXT, agent_id TEXT, name TEXT, canonical_name TEXT, updated_at TEXT);
                 CREATE TABLE entity_aspects (id TEXT, entity_id TEXT, agent_id TEXT, name TEXT, canonical_name TEXT, updated_at TEXT);
                 CREATE TABLE entity_attributes (id TEXT, agent_id TEXT, aspect_id TEXT, content TEXT, status TEXT, confidence REAL, created_at TEXT, updated_at TEXT, claim_key TEXT);
                 INSERT INTO entities VALUES ('entity-a','agent-a','Person','person','now');
                 INSERT INTO entity_aspects VALUES ('aspect-a','entity-a','agent-a','Facts','facts','now');",
            )
            .unwrap();
        let error = execute(
            &connection,
            OntologyClaimVersionsRequest {
                agent_id: "agent-a".into(),
                entity: "Person".into(),
                aspect: "Facts".into(),
                group_key: "general".into(),
                claim_key: "claim".into(),
                kind: None,
            },
        )
        .unwrap_err();
        assert!(matches!(
            error,
            CoreError::UnsupportedMigrationHistory(message)
                if message == "entity_attributes.kind is required for claim versions"
        ));
    }
}
