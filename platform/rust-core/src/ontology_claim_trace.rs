use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Instant;

use crate::{CoreError, OntologyClaimTraceRequest};

const MAX_VERSION_LIMIT: usize = 50;
const MAX_PREMISE_LIMIT: usize = 100;
const MAX_REVERSE_LIMIT: usize = 100;
const MAX_DEPTH: usize = 3;
const MAX_EXCERPT_LENGTH: usize = 1200;
const SOURCE_KINDS: [&str; 4] = ["memory", "artifact", "transcript", "summary"];

#[derive(Clone, Debug)]
struct Reference {
    source_kind: Option<String>,
    source_id: Option<String>,
    source_path: Option<String>,
    quote: Option<String>,
    strict: bool,
    derived_memory_id: Option<String>,
    public: Value,
}

#[derive(Clone, Debug)]
struct Source {
    id: String,
    path: Option<String>,
    content: Option<String>,
    project: Option<String>,
    visibility: Option<String>,
    session_keys: Vec<String>,
    state: &'static str,
}

#[derive(Clone, Debug)]
struct Evidence {
    value: Value,
    exact: bool,
    invalidated: bool,
    unverified: bool,
}

#[derive(Clone, Debug)]
struct ReverseTrace {
    items: Vec<Value>,
    truncated: bool,
    max_depth_reached: usize,
}

pub(crate) fn execute(
    connection: &Connection,
    request: OntologyClaimTraceRequest,
) -> Result<Value, CoreError> {
    let started = Instant::now();
    let agent_id = required_agent(&request.agent_id)?;
    let version_limit = bounded(request.version_limit, 20, MAX_VERSION_LIMIT, "versionLimit")?;
    let premise_limit = bounded(request.premise_limit, 50, MAX_PREMISE_LIMIT, "premiseLimit")?;
    let reverse_limit = bounded(request.reverse_limit, 50, MAX_REVERSE_LIMIT, "reverseLimit")?;
    let max_depth = bounded_depth(request.max_depth)?;
    let project = clean_opt(request.project);
    let session_key = clean_opt(request.session_key);
    let response_group_key = request.group_key.clone();
    let response_claim_key = request.claim_key.clone();
    let entity_query = canonical(&request.entity);
    let aspect_query = canonical(&request.aspect);
    let group_key = canonical(&request.group_key).replace(char::is_whitespace, "_");
    let claim_key = canonical(&request.claim_key).replace(char::is_whitespace, "_");
    let kind = request.kind.filter(|value| !value.trim().is_empty());

    let entity = resolve_entity(connection, &agent_id, &entity_query)?
        .ok_or_else(|| CoreError::NotFoundMessage("Claim path not found".into()))?;
    let aspect = resolve_aspect(
        connection,
        &agent_id,
        &entity["id"].as_str().unwrap_or_default(),
        &aspect_query,
    )?
    .ok_or_else(|| CoreError::NotFoundMessage("Claim path not found".into()))?;
    let rows = load_attributes(
        connection,
        &agent_id,
        &aspect["id"].as_str().unwrap_or_default(),
        &group_key,
        &claim_key,
        kind.as_deref(),
        version_limit + 1,
    )?;
    if rows.is_empty() {
        return Err(CoreError::NotFoundMessage(
            "Claim path has no versions".into(),
        ));
    }
    let truncated_versions = rows.len() > version_limit;
    let versions = rows.into_iter().take(version_limit).collect::<Vec<_>>();

    if let Some(project_name) = project.as_deref() {
        for attribute in &versions {
            require_project(connection, &agent_id, attribute, project_name)?;
        }
    }

    let version_values = versions
        .iter()
        .map(|attribute| trace_version(connection, &agent_id, attribute))
        .collect::<Result<Vec<_>, _>>()?;
    let current = version_values
        .iter()
        .filter(|value| value["attribute"]["status"] == "active")
        .cloned()
        .collect::<Vec<_>>();
    let current_content = current
        .iter()
        .filter_map(|value| value["attribute"]["normalizedContent"].as_str())
        .collect::<HashSet<_>>();

    let attribute_ids = versions
        .iter()
        .filter_map(|attribute| attribute["id"].as_str())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let assertions = read_assertions(connection, &agent_id, &attribute_ids)?;
    let contradictory = assertions
        .iter()
        .filter(|assertion| assertion["predicate"] == "denies" && assertion["status"] == "active")
        .cloned()
        .collect::<Vec<_>>();

    let mut references = Vec::new();
    for attribute in &versions {
        references.extend(attribute_references(connection, &agent_id, attribute)?);
    }
    for assertion in &assertions {
        if let Some(values) = assertion["evidenceRefs"].as_array() {
            references.extend(values.iter().filter_map(parse_reference));
        }
    }
    let references = merge_references(references);
    let mut premise_values = Vec::new();
    let mut verified = 0usize;
    let mut invalidated = 0usize;
    let mut unverified = 0usize;
    for reference in references.iter().take(premise_limit) {
        let evidence = source_from_reference(
            connection,
            &agent_id,
            reference,
            project.as_deref(),
            session_key.as_deref(),
        )?;
        if evidence.exact {
            verified += 1;
        } else if evidence.unverified {
            unverified += 1;
        }
        if evidence.invalidated {
            invalidated += 1;
        }
        premise_values.push(json!({
            "depth": 0,
            "derivedMemoryId": reference.derived_memory_id,
            "evidence": evidence.value,
        }));
    }

    let memory_ids = versions
        .iter()
        .filter_map(|attribute| attribute["memoryId"].as_str())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let reverse = read_reverse(
        connection,
        &agent_id,
        project.as_deref(),
        &memory_ids,
        reverse_limit,
        max_depth,
    )?;
    let integrity = if invalidated > 0 {
        "invalidated"
    } else if verified == 0 || unverified > 0 {
        "unverified"
    } else {
        "verified"
    };
    let reason = if integrity == "verified" {
        Value::Null
    } else if invalidated > 0 {
        json!("one or more premise records were deleted, superseded, stale, or incomplete")
    } else {
        json!("the claim has no verified exact-quote premise")
    };
    let has_competing = current_content.len() > 1;
    let max_depth_reached = reverse
        .items
        .iter()
        .filter_map(|value| value["depth"].as_u64())
        .max()
        .unwrap_or(reverse.max_depth_reached as u64) as usize;

    Ok(json!({
        "entity": public_object(&entity),
        "aspect": public_object(&aspect),
        "path": {"groupKey": response_group_key, "claimKey": response_claim_key, "kind": kind},
        "current": {
            "items": current,
            "status": if current.is_empty() {"historical"} else if has_competing {"competing"} else {"active"}
        },
        "versions": {"items": version_values, "truncated": truncated_versions},
        "competing": {"items": if has_competing {current.clone()} else {Vec::new()}, "contradictoryAssertions": contradictory},
        "assertions": assertions,
        "premises": {"items": premise_values, "truncated": references.len() > premise_limit},
        "reverse": {"items": reverse.items, "truncated": reverse.truncated},
        "authorization": {
            "agentId": agent_id,
            "project": project,
            "sessionKey": session_key,
            "decisions": {
                "agent": "allowed",
                "project": if project.is_some() {"allowed"} else {"unrestricted"},
                "session": if session_key.is_some() {"allowed"} else {"unrestricted"}
            },
            "readPath": "recall"
        },
        "integrity": {"status": integrity, "verifiedPremises": verified, "invalidatedPremises": invalidated, "unverifiedPremises": unverified, "reason": reason},
        "traversal": {
            "limits": {"versionLimit": version_limit, "premiseLimit": premise_limit, "reverseLimit": reverse_limit, "maxDepth": max_depth},
            "versionsVisited": version_values.len(), "premisesVisited": premise_values.len(), "reverseVisited": reverse.items.len(),
            "maxDepthReached": max_depth_reached, "bounded": true
        },
        "latencyMs": (started.elapsed().as_secs_f64() * 100.0).round() / 100.0
    }))
}

fn required_agent(value: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() {
        Err(CoreError::InvalidInput("agent id is required".into()))
    } else {
        Ok(value.to_owned())
    }
}

fn clean_opt(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_owned();
        (!trimmed.is_empty()).then_some(trimmed)
    })
}

fn bounded(
    value: Option<usize>,
    fallback: usize,
    maximum: usize,
    name: &str,
) -> Result<usize, CoreError> {
    let value = value.unwrap_or(fallback);
    if value == 0 || value > maximum {
        return Err(CoreError::InvalidInput(format!(
            "{name} must be an integer between 1 and {maximum}"
        )));
    }
    Ok(value)
}

fn bounded_depth(value: Option<usize>) -> Result<usize, CoreError> {
    let value = value.unwrap_or(MAX_DEPTH);
    if value > MAX_DEPTH {
        return Err(CoreError::InvalidInput(format!(
            "maxDepth must be an integer between 0 and {MAX_DEPTH}"
        )));
    }
    Ok(value)
}

fn canonical(value: &str) -> String {
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
    query: &str,
) -> Result<Option<Value>, CoreError> {
    if query.is_empty() {
        return Ok(None);
    }
    let starts = format!("{query}%");
    let contains = format!("%{query}%");
    let row = connection
        .query_row(
            "SELECT id,name,COALESCE(canonical_name,LOWER(name)),entity_type,description,mentions,pinned,pinned_at,status,archived_at,archived_by,archive_reason,proposal_id,proposal_evidence,created_at,updated_at
             FROM entities WHERE agent_id=? AND COALESCE(status,'active')='active'
             AND (COALESCE(canonical_name,LOWER(name))=? OR LOWER(name)=? OR COALESCE(canonical_name,LOWER(name)) LIKE ? OR LOWER(name) LIKE ? OR COALESCE(canonical_name,LOWER(name)) LIKE ? OR LOWER(name) LIKE ?)
             ORDER BY CASE WHEN COALESCE(canonical_name,LOWER(name))=? THEN 0 WHEN LOWER(name)=? THEN 1 WHEN COALESCE(canonical_name,LOWER(name)) LIKE ? THEN 2 WHEN LOWER(name) LIKE ? THEN 3 WHEN COALESCE(canonical_name,LOWER(name)) LIKE ? THEN 4 ELSE 5 END, COALESCE(mentions,0) DESC, updated_at DESC, name ASC LIMIT 1",
            params![agent_id, query, query, starts, starts, contains, contains, query, query, starts, starts, contains],
            |row| entity_from_row(row),
        )
        .optional()?;
    Ok(row.map(|mut value| {
        value["agentId"] = json!(agent_id);
        value
    }))
}

fn entity_from_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?, "name": row.get::<_, String>(1)?, "canonicalName": row.get::<_, String>(2)?,
        "entityType": row.get::<_, String>(3)?, "agentId": row.get::<_, String>(0).unwrap_or_default(),
        "description": row.get::<_, Option<String>>(4)?, "mentions": row.get::<_, Option<i64>>(5)?.unwrap_or(0),
        "pinned": row.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0, "pinnedAt": row.get::<_, Option<String>>(7)?,
        "status": row.get::<_, String>(8)?, "archivedAt": row.get::<_, Option<String>>(9)?, "archivedBy": row.get::<_, Option<String>>(10)?,
        "archiveReason": row.get::<_, Option<String>>(11)?, "proposalId": row.get::<_, Option<String>>(12)?,
        "proposalEvidence": parse_array(row.get::<_, Option<String>>(13)?.as_deref()),
        "createdAt": row.get::<_, Option<String>>(14)?, "updatedAt": row.get::<_, Option<String>>(15)?
    }))
}

fn resolve_aspect(
    connection: &Connection,
    agent_id: &str,
    entity_id: &str,
    query: &str,
) -> Result<Option<Value>, CoreError> {
    if query.is_empty() {
        return Ok(None);
    }
    let row = connection
        .query_row(
            "SELECT id,entity_id,agent_id,name,canonical_name,weight,status,archived_at,archived_by,archive_reason,proposal_id,proposal_evidence,created_at,updated_at
             FROM entity_aspects WHERE entity_id=? AND agent_id=? AND COALESCE(status,'active')='active' AND (canonical_name=? OR LOWER(name)=?) ORDER BY weight DESC,updated_at DESC LIMIT 1",
            params![entity_id, agent_id, query, query],
            |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?, "entityId": row.get::<_, String>(1)?, "agentId": row.get::<_, String>(2)?,
                    "name": row.get::<_, String>(3)?, "canonicalName": row.get::<_, String>(4)?, "weight": row.get::<_, f64>(5)?,
                    "status": row.get::<_, String>(6)?, "archivedAt": row.get::<_, Option<String>>(7)?, "archivedBy": row.get::<_, Option<String>>(8)?,
                    "archiveReason": row.get::<_, Option<String>>(9)?, "proposalId": row.get::<_, Option<String>>(10)?,
                    "proposalEvidence": parse_array(row.get::<_, Option<String>>(11)?.as_deref()),
                    "createdAt": row.get::<_, Option<String>>(12)?, "updatedAt": row.get::<_, Option<String>>(13)?
                }))
            },
        )
        .optional()?;
    Ok(row)
}

fn load_attributes(
    connection: &Connection,
    agent_id: &str,
    aspect_id: &str,
    group_key: &str,
    claim_key: &str,
    kind: Option<&str>,
    limit: usize,
) -> Result<Vec<Value>, CoreError> {
    let mut sql = String::from(
        "SELECT id,aspect_id,agent_id,memory_id,kind,content,normalized_content,group_key,claim_key,confidence,importance,status,superseded_by,version,version_root_id,previous_attribute_id,archived_at,archived_by,archive_reason,source_kind,source_id,source_path,source_root,proposal_id,proposal_evidence,created_at,updated_at FROM entity_attributes WHERE aspect_id=? AND agent_id=? AND COALESCE(group_key,'general')=? AND claim_key=?",
    );
    if kind.is_some() {
        sql.push_str(" AND kind=?");
    }
    sql.push_str(" ORDER BY created_at DESC,importance DESC LIMIT ?");
    let mut statement = connection.prepare(&sql)?;
    let mut values = Vec::new();
    let mut bind: Vec<Box<dyn rusqlite::ToSql>> = vec![
        Box::new(aspect_id.to_owned()),
        Box::new(agent_id.to_owned()),
        Box::new(group_key.to_owned()),
        Box::new(claim_key.to_owned()),
    ];
    if let Some(kind) = kind {
        bind.push(Box::new(kind.to_owned()));
    }
    bind.push(Box::new(limit as i64));
    let rows = statement.query_map(
        rusqlite::params_from_iter(bind.iter().map(|value| value.as_ref())),
        attribute_from_row,
    )?;
    for row in rows {
        values.push(row?);
    }
    Ok(values)
}

fn attribute_from_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?, "aspectId": row.get::<_, String>(1)?, "agentId": row.get::<_, String>(2)?,
        "memoryId": row.get::<_, Option<String>>(3)?, "kind": row.get::<_, String>(4)?, "content": row.get::<_, String>(5)?,
        "normalizedContent": row.get::<_, String>(6)?, "groupKey": row.get::<_, Option<String>>(7)?, "claimKey": row.get::<_, Option<String>>(8)?,
        "confidence": row.get::<_, f64>(9)?, "importance": row.get::<_, f64>(10)?, "status": row.get::<_, String>(11)?,
        "supersededBy": row.get::<_, Option<String>>(12)?, "version": row.get::<_, Option<i64>>(13)?.unwrap_or(1),
        "versionRootId": row.get::<_, Option<String>>(14)?, "previousAttributeId": row.get::<_, Option<String>>(15)?,
        "archivedAt": row.get::<_, Option<String>>(16)?, "archivedBy": row.get::<_, Option<String>>(17)?, "archiveReason": row.get::<_, Option<String>>(18)?,
        "sourceKind": row.get::<_, Option<String>>(19)?, "sourceId": row.get::<_, Option<String>>(20)?, "sourcePath": row.get::<_, Option<String>>(21)?, "sourceRoot": row.get::<_, Option<String>>(22)?,
        "proposalId": row.get::<_, Option<String>>(23)?, "proposalEvidence": parse_array(row.get::<_, Option<String>>(24)?.as_deref()),
        "createdAt": row.get::<_, Option<String>>(25)?, "updatedAt": row.get::<_, Option<String>>(26)?
    }))
}

fn trace_version(
    connection: &Connection,
    agent_id: &str,
    attribute: &Value,
) -> Result<Value, CoreError> {
    let memory_id = attribute["memoryId"].as_str();
    let memory = memory_id.and_then(|id| {
        connection.query_row(
            "SELECT id,COALESCE(is_deleted,0),stale_at,superseded_by FROM memories WHERE id=? AND agent_id=? LIMIT 1",
            params![id, agent_id],
            |row| Ok(json!({"id":row.get::<_,String>(0)?,"isDeleted":row.get::<_,i64>(1)?,"staleAt":row.get::<_,Option<String>>(2)?,"supersededBy":row.get::<_,Option<String>>(3)?})),
        ).optional().ok().flatten()
    });
    let superseded = memory
        .as_ref()
        .and_then(|v| v["supersededBy"].as_str())
        .or_else(|| attribute["supersededBy"].as_str());
    let mut attr = attribute.clone();
    if let Some(object) = attr.as_object_mut() {
        let evidence = public_evidence(
            object
                .get("proposalEvidence")
                .cloned()
                .unwrap_or_else(|| json!([])),
        );
        object.insert("proposalEvidence".into(), evidence);
    }
    Ok(json!({
        "attribute": attr,
        "lifecycle": {
            "status": attribute["status"], "memoryId": memory_id, "memoryPresent": memory.is_some(),
            "staleAt": memory.as_ref().and_then(|v| v["staleAt"].clone().as_str().map(ToOwned::to_owned)), "supersededBy": superseded
        },
        "history": {"version": attribute["version"], "versionRootId": attribute["versionRootId"], "previousAttributeId": attribute["previousAttributeId"], "supersededBy": attribute["supersededBy"]}
    }))
}

fn require_project(
    connection: &Connection,
    agent_id: &str,
    attribute: &Value,
    project: &str,
) -> Result<(), CoreError> {
    let memory_id = attribute["memoryId"].as_str();
    let memory_project = memory_id
        .and_then(|id| {
            connection
                .query_row(
                    "SELECT project FROM memories WHERE id=? AND agent_id=? LIMIT 1",
                    params![id, agent_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .ok()
                .flatten()
        })
        .flatten();
    if memory_project.as_deref() != Some(project) {
        return Err(CoreError::Forbidden(
            "Claim is outside the authorized project scope".into(),
        ));
    }
    Ok(())
}

fn attribute_references(
    connection: &Connection,
    agent_id: &str,
    attribute: &Value,
) -> Result<Vec<Reference>, CoreError> {
    let mut references = Vec::new();
    if let Some(memory_id) = attribute["memoryId"].as_str() {
        let mut statement = connection.prepare("SELECT source_kind,source_id,source_path FROM derived_memory_sources WHERE derived_memory_id=? AND agent_id=? ORDER BY created_at ASC LIMIT ?")?;
        let rows = statement.query_map(params![memory_id, agent_id, (MAX_PREMISE_LIMIT + 1) as i64], |row| {
            let source_kind: String = row.get(0)?;
            let source_id: String = row.get(1)?;
            let source_path: Option<String> = row.get(2)?;
            Ok(Reference { source_kind: Some(source_kind.clone()), source_id: Some(source_id.clone()), source_path: source_path.clone(), quote: None, strict: true, derived_memory_id: Some(memory_id.to_owned()), public: json!({"source_ref":format!("{source_kind}:{source_id}"),"source_path":source_path}) })
        })?;
        for row in rows {
            references.push(row?);
        }
    }
    let proposal_id = attribute["proposalId"].as_str();
    if let Some(proposal_id) = proposal_id {
        if let Some(evidence) = connection
            .query_row(
                "SELECT evidence FROM ontology_proposals WHERE id=? AND agent_id=? LIMIT 1",
                params![proposal_id, agent_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
        {
            let parsed = parse_array(evidence.as_deref());
            if let Some(items) = parsed.as_array() {
                references.extend(items.iter().filter_map(parse_reference));
            }
        }
    }
    if let Some(evidence) = attribute.get("proposalEvidence").and_then(Value::as_array) {
        references.extend(evidence.iter().filter_map(parse_reference));
    }
    let source_kind = attribute["sourceKind"].as_str().map(ToOwned::to_owned);
    let source_id = attribute["sourceId"].as_str().map(ToOwned::to_owned);
    let source_path = attribute["sourcePath"].as_str().map(ToOwned::to_owned);
    if let (Some(kind), Some(id)) = (source_kind, source_id) {
        if canonical_source_kind(&kind).is_some() {
            references.push(Reference {
                source_kind: Some(kind.clone()),
                source_id: Some(id.clone()),
                source_path: source_path.clone(),
                quote: None,
                strict: true,
                derived_memory_id: attribute["memoryId"].as_str().map(ToOwned::to_owned),
                public: json!({"source_kind":kind,"source_id":id,"source_path":source_path}),
            });
        }
    }
    Ok(merge_references(references)
        .into_iter()
        .filter(|reference| {
            reference.strict
                && reference
                    .source_kind
                    .as_deref()
                    .and_then(canonical_source_kind)
                    .is_some()
                && reference
                    .source_id
                    .as_deref()
                    .map(|id| !id.trim().is_empty())
                    .unwrap_or(false)
        })
        .collect())
}

fn parse_reference(value: &Value) -> Option<Reference> {
    if let Some(value) = value.as_str() {
        let separator = value.find(':');
        let (kind, id) = separator
            .map(|index| {
                (
                    Some(value[..index].to_owned()),
                    value[index + 1..].to_owned(),
                )
            })
            .unwrap_or((None, value.to_owned()));
        return Some(Reference {
            source_kind: kind,
            source_id: Some(id),
            source_path: None,
            quote: None,
            strict: true,
            derived_memory_id: None,
            public: json!(value),
        });
    }
    let object = value.as_object()?;
    let mut source_kind = object
        .get("source_kind")
        .or_else(|| object.get("sourceKind"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let mut source_id = object
        .get("source_id")
        .or_else(|| object.get("sourceId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    if let Some(source_ref) = object
        .get("source_ref")
        .or_else(|| object.get("sourceRef"))
        .and_then(Value::as_str)
    {
        if let Some(index) = source_ref.find(':') {
            source_kind = Some(source_ref[..index].to_owned());
            source_id = Some(source_ref[index + 1..].to_owned());
        }
    }
    if source_id.is_none() {
        source_id = object
            .get("memory_id")
            .or_else(|| object.get("memoryId"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if source_id.is_some() && source_kind.is_none() {
            source_kind = Some("memory".into());
        }
    }
    let path = object
        .get("source_path")
        .or_else(|| object.get("sourcePath"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let quote = object
        .get("quote")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let strict = object.get("source_ref").is_some()
        || source_kind
            .as_deref()
            .and_then(canonical_source_kind)
            .is_some()
            && source_id.is_some();
    Some(Reference {
        source_kind,
        source_id,
        source_path: path,
        quote,
        strict,
        derived_memory_id: None,
        public: value.clone(),
    })
}

fn merge_references(values: Vec<Reference>) -> Vec<Reference> {
    let mut merged: Vec<Reference> = Vec::new();
    let mut quoted = HashSet::new();
    for value in values {
        let key = format!(
            "{}\0{}\0{}",
            value.source_kind.as_deref().unwrap_or(""),
            value.source_id.as_deref().unwrap_or(""),
            value.source_path.as_deref().unwrap_or("")
        );
        if let Some(quote) = value.quote.as_deref() {
            merged.retain(|current| {
                format!(
                    "{}\0{}\0{}",
                    current.source_kind.as_deref().unwrap_or(""),
                    current.source_id.as_deref().unwrap_or(""),
                    current.source_path.as_deref().unwrap_or("")
                ) != key
                    || current.quote.is_some()
            });
            if !merged.iter().any(|current| {
                format!(
                    "{}\0{}\0{}",
                    current.source_kind.as_deref().unwrap_or(""),
                    current.source_id.as_deref().unwrap_or(""),
                    current.source_path.as_deref().unwrap_or("")
                ) == key
                    && current.quote.as_deref() == Some(quote)
            }) {
                merged.push(value);
            }
            quoted.insert(key);
        } else if !quoted.contains(&key)
            && !merged.iter().any(|current| {
                format!(
                    "{}\0{}\0{}",
                    current.source_kind.as_deref().unwrap_or(""),
                    current.source_id.as_deref().unwrap_or(""),
                    current.source_path.as_deref().unwrap_or("")
                ) == key
                    && current.quote.is_none()
            })
        {
            merged.push(value);
        }
    }
    merged
}

fn canonical_source_kind(value: &str) -> Option<&'static str> {
    SOURCE_KINDS.iter().copied().find(|kind| *kind == value)
}

fn source_id_candidates(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    let stripped = [
        "memory:",
        "artifact:",
        "source:",
        "transcript:",
        "session:",
        "summary:",
    ]
    .iter()
    .find_map(|prefix| trimmed.strip_prefix(prefix))
    .unwrap_or(trimmed);
    let mut candidates = Vec::new();
    for candidate in [
        trimmed.to_owned(),
        stripped.to_owned(),
        format!("memory:{stripped}"),
        format!("artifact:{stripped}"),
        format!("source:{stripped}"),
        format!("transcript:{stripped}"),
        format!("session:{stripped}"),
        format!("summary:{stripped}"),
    ] {
        if !candidate.is_empty() && !candidates.iter().any(|value| value == &candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

fn source_from_reference(
    connection: &Connection,
    agent_id: &str,
    reference: &Reference,
    project: Option<&str>,
    session_key: Option<&str>,
) -> Result<Evidence, CoreError> {
    let kind = reference
        .source_kind
        .as_deref()
        .and_then(canonical_source_kind)
        .ok_or_else(|| {
            CoreError::Conflict("Claim premise must include a canonical source_ref".into())
        })?;
    let id = reference
        .source_id
        .as_deref()
        .unwrap_or_default()
        .trim()
        .trim_start_matches(&format!("{kind}:"))
        .to_owned();
    if id.is_empty() {
        return Err(CoreError::Conflict(
            "Claim premise must include a canonical source_ref".into(),
        ));
    }
    let source = match kind {
        "memory" => read_memory(connection, agent_id, &id)?,
        "artifact" => read_artifact(connection, agent_id, &id, reference.source_path.as_deref())?,
        "transcript" => read_transcript(connection, agent_id, &id)?,
        "summary" => read_summary(connection, agent_id, &id)?,
        _ => unreachable!(),
    };
    let Some(source) = source else {
        let owned = ownership_exists(
            connection,
            kind,
            &id,
            reference.source_path.as_deref(),
            agent_id,
        )?;
        if owned {
            return Err(CoreError::Forbidden(
                "Claim premise crosses the authorized agent scope".into(),
            ));
        }
        return Err(CoreError::Conflict(format!(
            "Claim premise '{kind}:{id}' was not found"
        )));
    };
    if let Some(project) = project {
        if source.project.as_deref() != Some(project) {
            return Err(CoreError::Forbidden(
                "Claim premise is outside the authorized project scope".into(),
            ));
        }
    }
    if let Some(session) = session_key {
        if !source.session_keys.iter().any(|value| value == session) {
            return Err(CoreError::Forbidden(
                "Claim trace premise crosses the authorized session boundary".into(),
            ));
        }
    }
    let quote = reference.quote.as_deref();
    let exact = source
        .content
        .as_deref()
        .zip(quote)
        .map(|(content, quote)| content.contains(quote))
        .unwrap_or(false);
    if source.state == "available" && quote.is_some() && !exact {
        return Err(CoreError::Conflict(
            "Claim premise quote does not match the immutable source".into(),
        ));
    }
    let excerpt = if exact {
        source
            .content
            .as_deref()
            .zip(quote)
            .map(|(content, quote)| compact_excerpt(content, quote))
    } else {
        None
    };
    let public = public_reference(reference);
    Ok(Evidence {
        value: json!({"sourceKind":kind,"sourceId":source.id,"sourcePath":source.path,"exactQuote":if exact {quote.map(ToOwned::to_owned)} else {None::<String>},"excerpt":excerpt,"found":source.state != "deleted","state":if source.state == "available" && !exact {"quote_unverified"} else {source.state},"scope":{"agentId":agent_id,"project":source.project,"visibility":source.visibility,"sessionKeys":session_key.map(|value| vec![value]).unwrap_or_default()},"reference":public}),
        exact,
        invalidated: matches!(source.state, "deleted" | "stale" | "incomplete"),
        unverified: source.state == "available" && !exact,
    })
}

fn read_memory(
    connection: &Connection,
    agent_id: &str,
    id: &str,
) -> Result<Option<Source>, CoreError> {
    let row = connection.query_row("SELECT id,content,source_path,project,visibility,scope,memory_kind,COALESCE(is_deleted,0),stale_at,superseded_by,source_type,source_id FROM memories WHERE id=? AND agent_id=? LIMIT 1", params![id,agent_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,Option<String>>(4)?,row.get::<_,Option<String>>(5)?,row.get::<_,Option<String>>(6)?,row.get::<_,i64>(7)?,row.get::<_,Option<String>>(8)?,row.get::<_,Option<String>>(9)?,row.get::<_,Option<String>>(10)?,row.get::<_,Option<String>>(11)?))).optional()?;
    let Some((
        id,
        content,
        path,
        project,
        visibility,
        scope,
        memory_kind,
        deleted,
        stale_at,
        superseded_by,
        _source_type,
        _source_id,
    )) = row
    else {
        return Ok(None);
    };
    let state = if deleted != 0 {
        "deleted"
    } else if stale_at.is_some() || superseded_by.is_some() {
        "stale"
    } else if memory_kind.as_deref() != Some("episodic")
        || visibility.as_deref() == Some("archived")
        || scope.is_some()
    {
        "incomplete"
    } else {
        "available"
    };
    let session_keys = memory_session_keys(connection, agent_id, &id);
    Ok(Some(Source {
        id,
        path,
        content: (state == "available").then_some(content),
        project,
        visibility,
        session_keys,
        state,
    }))
}

fn memory_session_keys(connection: &Connection, agent_id: &str, id: &str) -> Vec<String> {
    let Some((kind, source)) = connection
        .query_row(
            "SELECT source_type,source_id FROM memories WHERE id=? AND agent_id=? LIMIT 1",
            params![id, agent_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten()
    else {
        return Vec::new();
    };
    let mut keys = Vec::new();
    if matches!(kind.as_deref(), Some("session" | "transcript")) {
        if let Some(source) = source.as_deref() {
            keys.push(
                source
                    .trim_start_matches("session:")
                    .trim_start_matches("transcript:")
                    .to_owned(),
            );
        }
    }
    if let Some(source_id) = source.as_deref() {
        if let Ok(mut statement) = connection.prepare(
            "SELECT session_key,session_id,session_token FROM memory_artifacts
             WHERE agent_id=? AND (source_node_id=? OR source_id=?)",
        ) {
            if let Ok(rows) = statement.query_map(params![agent_id, source_id, source_id], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            }) {
                for row in rows.flatten() {
                    for value in [row.0, row.1, row.2].into_iter().flatten() {
                        if !keys.iter().any(|key| key == &value) {
                            keys.push(value);
                        }
                    }
                }
            }
        }
    }
    keys
}

fn read_artifact(
    connection: &Connection,
    agent_id: &str,
    id: &str,
    path: Option<&str>,
) -> Result<Option<Source>, CoreError> {
    let candidates = source_id_candidates(id);
    let placeholders = candidates.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT source_path,session_id,session_key,session_token,project,content,COALESCE(is_deleted,0),source_node_id,source_id
         FROM memory_artifacts WHERE agent_id=? AND (source_path=? OR source_node_id IN ({placeholders}) OR session_id IN ({placeholders}) OR session_key IN ({placeholders}) OR session_token IN ({placeholders}))
         ORDER BY captured_at DESC LIMIT 1"
    );
    let mut statement = connection.prepare(&sql)?;
    let mut bind: Vec<Box<dyn rusqlite::ToSql>> = vec![
        Box::new(agent_id.to_owned()),
        Box::new(path.unwrap_or(id).to_owned()),
    ];
    for _ in 0..4 {
        bind.extend(
            candidates
                .iter()
                .cloned()
                .map(|value| Box::new(value) as Box<dyn rusqlite::ToSql>),
        );
    }
    let row = statement
        .query_row(
            rusqlite::params_from_iter(bind.iter().map(|value| value.as_ref())),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            },
        )
        .optional()?;
    let Some((
        path,
        session_id,
        session_key,
        session_token,
        project,
        content,
        deleted,
        _node,
        _source_id,
    )) = row
    else {
        return Ok(None);
    };
    let keys = [session_key, session_id, session_token]
        .into_iter()
        .flatten()
        .collect();
    Ok(Some(Source {
        id: path.clone(),
        path: Some(path),
        content: (!deleted.eq(&1)).then_some(content),
        project,
        visibility: Some("scoped".into()),
        session_keys: keys,
        state: if deleted != 0 { "deleted" } else { "available" },
    }))
}

fn read_transcript(
    connection: &Connection,
    agent_id: &str,
    id: &str,
) -> Result<Option<Source>, CoreError> {
    let id = id
        .trim_start_matches("session:")
        .trim_start_matches("transcript:");
    let row = connection.query_row("SELECT session_key,content,project,completed_at FROM session_transcripts WHERE agent_id=? AND session_key=? LIMIT 1", params![agent_id,id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?))).optional()?;
    let Some((key, content, project, completed)) = row else {
        return Ok(None);
    };
    Ok(Some(Source {
        id: key.clone(),
        path: None,
        content: completed.is_some().then_some(content),
        project,
        visibility: Some("scoped".into()),
        session_keys: vec![key],
        state: if completed.is_some() {
            "available"
        } else {
            "incomplete"
        },
    }))
}

fn read_summary(
    connection: &Connection,
    agent_id: &str,
    id: &str,
) -> Result<Option<Source>, CoreError> {
    let row = connection.query_row("SELECT id,content,project,session_key,source_ref,depth,source_type FROM session_summaries WHERE agent_id=? AND (id=? OR source_ref=?) ORDER BY latest_at DESC LIMIT 1", params![agent_id,id,id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,Option<String>>(4)?,row.get::<_,i64>(5)?,row.get::<_,Option<String>>(6)?))).optional()?;
    let Some((id, content, project, session_key, source_ref, depth, source_type)) = row else {
        return Ok(None);
    };
    if depth != 0
        || !matches!(
            source_type.as_deref(),
            None | Some("summary" | "compaction" | "checkpoint")
        )
    {
        return Ok(None);
    }
    let mut keys = Vec::new();
    if let Some(value) = session_key {
        keys.push(value);
    }
    if let Some(value) = source_ref
        .as_deref()
        .filter(|value| value.starts_with("session:") || value.starts_with("transcript:"))
    {
        keys.push(
            value
                .split_once(':')
                .map(|(_, tail)| tail)
                .unwrap_or(value)
                .to_owned(),
        );
    }
    Ok(Some(Source {
        id,
        path: None,
        content: Some(content),
        project,
        visibility: Some("scoped".into()),
        session_keys: keys,
        state: "available",
    }))
}

fn ownership_exists(
    connection: &Connection,
    kind: &str,
    id: &str,
    path: Option<&str>,
    agent_id: &str,
) -> Result<bool, CoreError> {
    if kind == "artifact" {
        let candidates = source_id_candidates(id);
        let placeholders = candidates.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT COUNT(*) FROM memory_artifacts
             WHERE agent_id != ? AND (source_path=? OR source_node_id IN ({placeholders})
             OR session_id IN ({placeholders}) OR session_key IN ({placeholders})
             OR session_token IN ({placeholders}))"
        );
        let mut statement = connection.prepare(&sql)?;
        let mut bind: Vec<Box<dyn rusqlite::ToSql>> = vec![
            Box::new(agent_id.to_owned()),
            Box::new(path.unwrap_or(id).to_owned()),
        ];
        for _ in 0..4 {
            bind.extend(
                candidates
                    .iter()
                    .cloned()
                    .map(|value| Box::new(value) as Box<dyn rusqlite::ToSql>),
            );
        }
        let count: i64 = statement.query_row(
            rusqlite::params_from_iter(bind.iter().map(|value| value.as_ref())),
            |row| row.get(0),
        )?;
        return Ok(count > 0);
    }
    let count: i64 = match kind {
        "memory" => connection.query_row(
            "SELECT COUNT(*) FROM memories WHERE id=? AND agent_id != ?",
            params![id, agent_id],
            |row| row.get(0),
        )?,
        "transcript" => connection.query_row(
            "SELECT COUNT(*) FROM session_transcripts WHERE session_key=? AND agent_id != ?",
            params![
                id.trim_start_matches("session:")
                    .trim_start_matches("transcript:"),
                agent_id
            ],
            |row| row.get(0),
        )?,
        "summary" => connection.query_row(
            "SELECT COUNT(*) FROM session_summaries WHERE (id=? OR source_ref=?) AND agent_id != ?",
            params![id, id, agent_id],
            |row| row.get(0),
        )?,
        _ => 0,
    };
    Ok(count > 0)
}

fn compact_excerpt(content: &str, quote: &str) -> String {
    let Some(index) = content.find(quote) else {
        return String::new();
    };
    let available = MAX_EXCERPT_LENGTH.saturating_sub(quote.len());
    let start = index.saturating_sub(available / 2);
    let end = std::cmp::min(content.len(), start + MAX_EXCERPT_LENGTH);
    format!(
        "{}{}{}",
        if start > 0 { "..." } else { "" },
        &content[start..end],
        if end < content.len() { "..." } else { "" }
    )
}

fn public_reference(reference: &Reference) -> Value {
    let Some(kind) = reference
        .source_kind
        .as_deref()
        .and_then(canonical_source_kind)
    else {
        return Value::Null;
    };
    let Some(id) = reference
        .source_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Value::Null;
    };
    if reference.public.is_string() {
        return json!(format!("{kind}:{id}"));
    }
    let mut object = serde_json::Map::new();
    object.insert("source_ref".into(), json!(format!("{kind}:{id}")));
    if let Some(path) = &reference.source_path {
        object.insert("source_path".into(), json!(path));
    }
    if let Some(quote) = &reference.quote {
        object.insert("quote".into(), json!(quote));
    }
    if let Some(source_root) = reference
        .public
        .as_object()
        .and_then(|value| value.get("source_root").or_else(|| value.get("sourceRoot")))
        .and_then(Value::as_str)
    {
        object.insert("source_root".into(), json!(source_root));
    }
    Value::Object(object)
}

fn assertion_reference(reference: &Reference) -> Value {
    json!({
        "sourceKind": reference.source_kind,
        "sourceId": reference.source_id,
        "sourcePath": reference.source_path,
        "quote": reference.quote,
        "strict": reference.strict,
        "reference": public_reference(reference),
    })
}

fn public_evidence(value: Value) -> Value {
    let items = value
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|item| parse_reference(item).map(|reference| public_reference(&reference)))
        .filter(|item| !item.is_null())
        .collect::<Vec<_>>();
    Value::Array(items)
}

fn parse_array(value: Option<&str>) -> Value {
    value
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .filter(|value| value.is_array())
        .unwrap_or_else(|| json!([]))
}

fn public_object(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(object) = value.as_object_mut() {
        let evidence = object
            .get("proposalEvidence")
            .cloned()
            .unwrap_or_else(|| json!([]));
        object.insert("proposalEvidence".into(), public_evidence(evidence));
    }
    value
}

fn read_assertions(
    connection: &Connection,
    agent_id: &str,
    attribute_ids: &[String],
) -> Result<Vec<Value>, CoreError> {
    if attribute_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat("?")
        .take(attribute_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT a.id,a.agent_id,a.subject_entity_id,e.name,a.claim_attribute_id,a.predicate,a.content,a.normalized_content,a.speaker,a.asserted_at,a.confidence,a.evidence,a.source_kind,a.source_id,a.source_path,a.source_root,a.status,a.supersedes_assertion_id,a.archived_at,a.archived_by,a.archive_reason,a.created_by,a.created_at,a.updated_at FROM epistemic_assertions a JOIN entities e ON e.id=a.subject_entity_id AND e.agent_id=a.agent_id WHERE a.agent_id=? AND a.claim_attribute_id IN ({placeholders}) ORDER BY a.asserted_at DESC,a.created_at DESC LIMIT {}", MAX_PREMISE_LIMIT);
    let mut statement = connection.prepare(&sql)?;
    let mut bind: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(agent_id.to_owned())];
    bind.extend(
        attribute_ids
            .iter()
            .cloned()
            .map(|value| Box::new(value) as Box<dyn rusqlite::ToSql>),
    );
    let rows = statement.query_map(rusqlite::params_from_iter(bind.iter().map(|value| value.as_ref())), |row| {
        let evidence = parse_array(row.get::<_,Option<String>>(11)?.as_deref());
        let mut refs = evidence.as_array().cloned().unwrap_or_default().iter().filter_map(parse_reference).collect::<Vec<_>>();
        let source_kind = row.get::<_,Option<String>>(12)?; let source_id = row.get::<_,Option<String>>(13)?; let source_path = row.get::<_,Option<String>>(14)?;
        if source_kind.is_some() || source_id.is_some() || source_path.is_some() { refs.push(Reference { source_kind: source_kind.clone(), source_id: source_id.clone(), source_path: source_path.clone(), quote: None, strict: true, derived_memory_id: None, public: json!({"source_kind":source_kind,"source_id":source_id,"source_path":source_path}) }); }
        Ok(json!({
            "id":row.get::<_,String>(0)?,"agentId":row.get::<_,String>(1)?,"subjectEntityId":row.get::<_,String>(2)?,"subjectEntityName":row.get::<_,Option<String>>(3)?,"claimAttributeId":row.get::<_,Option<String>>(4)?,"predicate":row.get::<_,String>(5)?,"content":row.get::<_,String>(6)?,"normalizedContent":row.get::<_,String>(7)?,"speaker":row.get::<_,Option<String>>(8)?,"assertedAt":row.get::<_,String>(9)?,"confidence":row.get::<_,f64>(10)?,"evidence":public_evidence(evidence),"sourceKind":source_kind,"sourceId":source_id,"sourcePath":source_path,"sourceRoot":row.get::<_,Option<String>>(15)?,"status":row.get::<_,String>(16)?,"supersedesAssertionId":row.get::<_,Option<String>>(17)?,"archivedAt":row.get::<_,Option<String>>(18)?,"archivedBy":row.get::<_,Option<String>>(19)?,"archiveReason":row.get::<_,Option<String>>(20)?,"createdBy":row.get::<_,String>(21)?,"createdAt":row.get::<_,String>(22)?,"updatedAt":row.get::<_,String>(23)?,"evidenceRefs":merge_references(refs).iter().map(assertion_reference).collect::<Vec<_>>()
        }))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn read_reverse(
    connection: &Connection,
    agent_id: &str,
    project: Option<&str>,
    memory_ids: &[String],
    limit: usize,
    max_depth: usize,
) -> Result<ReverseTrace, CoreError> {
    if memory_ids.is_empty() || max_depth == 0 {
        return Ok(ReverseTrace {
            items: Vec::new(),
            truncated: false,
            max_depth_reached: 0,
        });
    }
    let mut visited = memory_ids.iter().cloned().collect::<HashSet<_>>();
    let mut frontier = memory_ids.to_vec();
    let mut values = Vec::new();
    let mut truncated = false;
    let mut max_depth_reached = 0;
    for depth in 1..=max_depth {
        if frontier.is_empty() || values.len() >= limit {
            break;
        }
        let placeholders = std::iter::repeat("?")
            .take(frontier.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("SELECT DISTINCT dms.derived_memory_id,ea.id,e.name,eas.name,ea.group_key,ea.claim_key,COALESCE(ea.content,m.content),COALESCE(ea.status,'derived') FROM derived_memory_sources dms JOIN memories m ON m.id=dms.derived_memory_id AND m.agent_id=dms.agent_id LEFT JOIN entity_attributes ea ON ea.memory_id=m.id AND ea.agent_id=m.agent_id LEFT JOIN entity_aspects eas ON eas.id=ea.aspect_id AND eas.agent_id=ea.agent_id LEFT JOIN entities e ON e.id=eas.entity_id AND e.agent_id=eas.agent_id WHERE dms.agent_id=? AND dms.source_kind='memory' AND dms.source_id IN ({placeholders}) AND COALESCE(m.is_deleted,0)=0 AND m.visibility!='archived' AND m.scope IS NULL AND (? IS NULL OR m.project=?) ORDER BY m.updated_at DESC,m.id ASC LIMIT {}", limit - values.len() + 1);
        let mut bind: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(agent_id.to_owned())];
        bind.extend(
            frontier
                .iter()
                .cloned()
                .map(|value| Box::new(value) as Box<dyn rusqlite::ToSql>),
        );
        bind.push(Box::new(project.map(ToOwned::to_owned)));
        bind.push(Box::new(project.map(ToOwned::to_owned)));
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(
            rusqlite::params_from_iter(bind.iter().map(|value| value.as_ref())),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )?;
        let rows = rows.collect::<Result<Vec<_>, _>>()?;
        if rows.len() > limit - values.len() {
            truncated = true;
        }
        let mut next = Vec::new();
        for (memory_id, attribute_id, entity, aspect, group, claim, content, status) in rows {
            if !visited.insert(memory_id.clone()) {
                continue;
            }
            if values.len() >= limit {
                break;
            }
            values.push(json!({"attributeId":attribute_id,"memoryId":memory_id,"entity":entity,"aspect":aspect,"groupKey":group,"claimKey":claim,"content":content,"status":status,"depth":depth}));
            max_depth_reached = depth;
            next.push(memory_id);
        }
        if depth == max_depth && !next.is_empty() {
            truncated = true;
        }
        frontier = next;
    }
    Ok(ReverseTrace {
        items: values,
        truncated,
        max_depth_reached,
    })
}
