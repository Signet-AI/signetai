//! Graph entity/relation persistence — structured path, supersession, decrement.
//!
//! Supplements the base `persist_entities` in `signet-services/src/graph.rs`
//! with the structured persistence path (Remember API), attribute supersession
//! detection, and entity mention decrement for memory purge.
//!
//! Ports the remaining pieces of graph-transactions.ts (682 LOC) that aren't
//! already covered by graph.rs.

use rusqlite::params;
use uuid::Uuid;

use crate::entity_quality::{normalize_entity_type, should_persist_entity};
use crate::write_gate::is_decision_content;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Input for structured aspect persistence (Remember API).
#[derive(Debug, Clone)]
pub struct StructuredAspect {
    pub entity_name: String,
    pub entity_type: Option<String>,
    pub aspect: String,
    pub attributes: Vec<StructuredAttribute>,
}

#[derive(Debug, Clone)]
pub struct StructuredAttribute {
    pub group_key: Option<String>,
    pub claim_key: Option<String>,
    pub content: String,
    pub confidence: Option<f64>,
    pub importance: Option<f64>,
}

/// Result of structured persistence.
#[derive(Debug, Clone, Default)]
pub struct PersistStructuredResult {
    pub entities_inserted: usize,
    pub entities_updated: usize,
    pub relations_inserted: usize,
    pub relations_updated: usize,
    pub mentions_linked: usize,
    pub aspects_created: usize,
    pub attributes_created: usize,
    pub attributes_superseded: usize,
}

/// Input for entity mention decrement.
#[derive(Debug, Clone)]
pub struct DecrementInput {
    pub entity_ids: Vec<String>,
}

/// Result of entity mention decrement.
#[derive(Debug, Clone, Default)]
pub struct DecrementResult {
    pub entities_orphaned: usize,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn to_canonical(raw: &str) -> String {
    raw.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_claim_key(value: Option<&str>) -> Option<String> {
    let normalized: String = value
        .unwrap_or("")
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    if normalized.len() < 3 {
        return None;
    }
    Some(normalized[..normalized.len().min(120)].to_string())
}

fn normalize_group_key(value: Option<&str>) -> Option<String> {
    normalize_claim_key(value)
}

const UPDATE_MARKERS: &[&str] = &[
    "currently",
    "now",
    "recently",
    "lately",
    "updated",
    "changed",
    "switched",
    "replaced",
    "no longer",
    "not anymore",
    "instead",
    "previously",
    "formerly",
];

const NUMBER_WORDS: &[&str] = &[
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve",
];

fn tokenize(content: &str) -> Vec<String> {
    content
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .filter(|t| t.len() >= 2)
        .map(String::from)
        .collect()
}

fn has_update_marker(content: &str) -> bool {
    let lower = content.to_lowercase();
    UPDATE_MARKERS.iter().any(|m| lower.contains(m))
}

fn numeric_tokens(tokens: &[String]) -> HashSet<String> {
    tokens
        .iter()
        .filter(|t| t.chars().all(|c| c.is_ascii_digit()) || NUMBER_WORDS.contains(&t.as_str()))
        .cloned()
        .collect()
}

fn overlap_count(left: &[String], right: &[String]) -> usize {
    let right_set: HashSet<&str> = right.iter().map(|s| s.as_str()).collect();
    left.iter()
        .filter(|t| right_set.contains(t.as_str()))
        .count()
}

fn has_numeric_conflict(left: &[String], right: &[String]) -> bool {
    let left_nums = numeric_tokens(left);
    let right_nums = numeric_tokens(right);
    if left_nums.is_empty() || right_nums.is_empty() {
        return false;
    }
    for t in &left_nums {
        if !right_nums.contains(t) {
            return true;
        }
    }
    for t in &right_nums {
        if !left_nums.contains(t) {
            return true;
        }
    }
    false
}

use std::collections::HashSet;

/// Heuristic: does the newer content likely supersede the older?
fn is_likely_supersession(new_content: &str, old_content: &str) -> bool {
    let newer = tokenize(new_content);
    let older = tokenize(old_content);
    if newer.is_empty() || older.is_empty() {
        return false;
    }
    let overlap = overlap_count(&newer, &older);
    if overlap < 3 {
        return false;
    }
    if has_numeric_conflict(&newer, &older) {
        return true;
    }
    has_update_marker(new_content) && overlap >= 4
}

// ---------------------------------------------------------------------------
// Entity upsert (reused from graph.rs pattern)
// ---------------------------------------------------------------------------

struct UpsertEntityResult {
    id: String,
    inserted: bool,
}

fn upsert_entity(
    conn: &rusqlite::Connection,
    raw_name: &str,
    entity_type: Option<&str>,
    agent_id: &str,
    now: &str,
) -> Option<UpsertEntityResult> {
    let canonical = to_canonical(raw_name);
    let normalized_type = match entity_type {
        Some(t) if !t.is_empty() => t.trim().to_lowercase(),
        _ => "extracted".to_string(),
    };

    if !should_persist_entity(raw_name, Some(&normalized_type)) {
        return None;
    }

    // Look up by canonical_name, then name
    let existing: Option<(String, i64, String)> = conn
        .query_row(
            "SELECT id, mentions, entity_type FROM entities
             WHERE (canonical_name = ?1 AND agent_id = ?2) OR name = ?3
             LIMIT 1",
            params![canonical, agent_id, raw_name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();

    if let Some((id, _mentions, existing_type)) = &existing {
        conn.execute(
            "UPDATE entities SET mentions = mentions + 1, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )
        .ok();
        // Upgrade entity_type if currently "extracted"
        if normalized_type != "extracted" && existing_type == "extracted" {
            conn.execute(
                "UPDATE entities SET entity_type = ?1 WHERE id = ?2 AND entity_type = 'extracted'",
                params![normalized_type, id],
            )
            .ok();
        }
        return Some(UpsertEntityResult {
            id: id.clone(),
            inserted: false,
        });
    }

    let id = Uuid::new_v4().to_string();
    match conn.execute(
        "INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
        params![id, raw_name, canonical, normalized_type, agent_id, now],
    ) {
        Ok(_) => Some(UpsertEntityResult { id, inserted: true }),
        Err(_) => {
            // UNIQUE constraint collision fallback
            let fallback: Option<String> = conn
                .query_row(
                    "SELECT id FROM entities WHERE name = ?1 LIMIT 1",
                    params![raw_name],
                    |row| row.get(0),
                )
                .ok();
            match fallback {
                Some(fid) => {
                    conn.execute(
                        "UPDATE entities SET mentions = mentions + 1, updated_at = ?1,
                         canonical_name = COALESCE(canonical_name, ?2) WHERE id = ?3",
                        params![now, canonical, fid],
                    )
                    .ok();
                    Some(UpsertEntityResult { id: fid, inserted: false })
                }
                None => None,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Aspect upsert
// ---------------------------------------------------------------------------

fn upsert_aspect(
    conn: &rusqlite::Connection,
    entity_id: &str,
    agent_id: &str,
    aspect_name: &str,
    now: &str,
) -> Option<String> {
    let canonical = to_canonical(aspect_name);
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0.5, ?6, ?6)
         ON CONFLICT(entity_id, canonical_name) DO UPDATE SET updated_at = excluded.updated_at",
        params![id, entity_id, agent_id, aspect_name, canonical, now],
    )
    .ok()?;

    // Read back actual id (may differ on conflict)
    conn.query_row(
        "SELECT id FROM entity_aspects WHERE entity_id = ?1 AND canonical_name = ?2 LIMIT 1",
        params![entity_id, canonical],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

// ---------------------------------------------------------------------------
// Supersession detection
// ---------------------------------------------------------------------------

struct StoredAttribute {
    id: String,
    content: String,
    normalized_content: String,
    group_key: Option<String>,
    claim_key: String,
    memory_id: Option<String>,
    created_at: String,
}

fn mark_superseded_siblings(
    conn: &rusqlite::Connection,
    attribute: &StoredAttribute,
    aspect_id: &str,
    agent_id: &str,
    now: &str,
) -> usize {
    let mut stmt = match conn.prepare_cached(
        "SELECT id, content, normalized_content, group_key, claim_key, memory_id, created_at
         FROM entity_attributes
         WHERE aspect_id = ?1 AND agent_id = ?2
           AND (group_key = ?3 OR (group_key IS NULL AND ?3 IS NULL))
           AND claim_key = ?4
           AND id != ?5
           AND kind = 'attribute'
           AND status = 'active'",
    ) {
        Ok(s) => s,
        Err(_) => return 0,
    };

    let siblings: Vec<StoredAttribute> = match stmt.query_map(
        params![
            aspect_id,
            agent_id,
            attribute.group_key,
            attribute.claim_key,
            attribute.id
        ],
        |row| {
            Ok(StoredAttribute {
                id: row.get(0)?,
                content: row.get(1)?,
                normalized_content: row.get(2)?,
                group_key: row.get(3)?,
                claim_key: row.get(4)?,
                memory_id: row.get(5)?,
                created_at: row.get(6)?,
            })
        },
    ) {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => return 0,
    };

    let mut count = 0;
    for sibling in &siblings {
        let attr_ts = attribute.created_at.parse::<f64>().unwrap_or(0.0);
        let sib_ts = sibling.created_at.parse::<f64>().unwrap_or(0.0);
        let attr_is_newer = attr_ts >= sib_ts;

        let (newer, older) = if attr_is_newer {
            (&attribute.normalized_content, &sibling.normalized_content)
        } else {
            (&sibling.normalized_content, &attribute.normalized_content)
        };

        if !is_likely_supersession(newer, older) {
            continue;
        }

        let newer_id = if attr_is_newer {
            &attribute.id
        } else {
            &sibling.id
        };
        let older_id = if attr_is_newer {
            &sibling.id
        } else {
            &attribute.id
        };

        if conn
            .execute(
                "UPDATE entity_attributes
                 SET status = 'superseded', superseded_by = ?1, updated_at = ?2
                 WHERE id = ?3 AND agent_id = ?4 AND status = 'active'",
                params![newer_id, now, older_id, agent_id],
            )
            .is_ok()
        {
            count += 1;
        }
    }
    count
}

// ---------------------------------------------------------------------------
// Public API: Structured persistence
// ---------------------------------------------------------------------------

/// Persist pre-computed entities, aspects, and attributes in a single
/// transaction. Used when callers provide a `structured` payload to
/// the Remember API, bypassing the async pipeline.
pub fn persist_structured(
    conn: &rusqlite::Connection,
    entities: &[signet_core::types::ExtractedEntity],
    aspects: &[StructuredAspect],
    source_memory_id: &str,
    content: &str,
    agent_id: &str,
    now: &str,
) -> PersistStructuredResult {
    let mut result = PersistStructuredResult::default();

    // Step 1: Persist entity triples
    for triple in entities {
        let src_type = normalize_entity_type(triple.source_type.as_deref());
        let tgt_type = normalize_entity_type(triple.target_type.as_deref());
        if !should_persist_entity(&triple.source, src_type)
            || !should_persist_entity(&triple.target, tgt_type)
        {
            continue;
        }

        let source = match upsert_entity(conn, &triple.source, src_type, agent_id, now) {
            Some(s) => s,
            None => continue,
        };
        if source.inserted {
            result.entities_inserted += 1;
        } else {
            result.entities_updated += 1;
        }

        let target = match upsert_entity(conn, &triple.target, tgt_type, agent_id, now) {
            Some(t) => t,
            None => continue,
        };
        if target.inserted {
            result.entities_inserted += 1;
        } else {
            result.entities_updated += 1;
        }

        // Upsert relation
        let existing_rel: Option<String> = conn
            .query_row(
                "SELECT id FROM relations WHERE source_entity_id = ?1 AND target_entity_id = ?2 AND relation_type = ?3 LIMIT 1",
                params![source.id, target.id, triple.relationship],
                |row| row.get(0),
            )
            .ok();
        if let Some(_) = existing_rel {
            result.relations_updated += 1;
        } else {
            let rel_id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, strength, mentions, confidence, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 1.0, 1, ?5, ?6, ?6)",
                params![rel_id, source.id, target.id, triple.relationship, triple.confidence, now],
            )
            .ok();
            result.relations_inserted += 1;
        }

        // Link mentions
        for (entity_id, text) in &[(&source.id, &triple.source), (&target.id, &triple.target)] {
            conn.execute(
                "INSERT OR IGNORE INTO memory_entity_mentions (memory_id, entity_id, mention_text, confidence, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![source_memory_id, entity_id, text, triple.confidence, now],
            )
            .ok();
            result.mentions_linked += 1;
        }
    }

    // Decision detection for attribute kind
    let decision = is_decision_content(content);
    let kind = if decision { "constraint" } else { "attribute" };
    let base_importance = if decision { 0.85 } else { 0.5 };

    // Collect resolved entity IDs for dependency linking
    let mut resolved: Vec<String> = Vec::new();

    // Step 2: Upsert aspects and attributes
    for sa in aspects {
        let canonical = to_canonical(&sa.entity_name);
        let mut entity_id = conn
            .query_row(
                "SELECT id FROM entities WHERE canonical_name = ?1 AND agent_id = ?2 LIMIT 1",
                params![canonical, agent_id],
                |row| row.get::<_, String>(0),
            )
            .ok();

        if entity_id.is_none() {
            let inserted = upsert_entity(
                conn,
                &sa.entity_name,
                sa.entity_type.as_deref(),
                agent_id,
                now,
            );
            if let Some(ins) = inserted {
                if ins.inserted {
                    result.entities_inserted += 1;
                } else {
                    result.entities_updated += 1;
                }
                entity_id = Some(ins.id);
            }
        }

        let Some(eid) = entity_id else { continue };

        // Link mention for aspect entity
        conn.execute(
            "INSERT OR IGNORE INTO memory_entity_mentions (memory_id, entity_id, mention_text, confidence, created_at)
             VALUES (?1, ?2, ?3, 0.7, ?4)",
            params![source_memory_id, eid, sa.entity_name, now],
        )
        .ok();
        result.mentions_linked += 1;
        resolved.push(eid.clone());

        // Upsert aspect
        let aspect_id = match upsert_aspect(conn, &eid, agent_id, &sa.aspect, now) {
            Some(id) => id,
            None => continue,
        };
        result.aspects_created += 1;

        // Insert attributes with dedup
        for attr in &sa.attributes {
            let normalized = attr.content.trim().to_lowercase();

            // Check for duplicate
            let dup: Option<String> = conn
                .query_row(
                    "SELECT id FROM entity_attributes
                     WHERE aspect_id = ?1 AND agent_id = ?2 AND normalized_content = ?3 AND status = 'active'
                     LIMIT 1",
                    params![aspect_id, agent_id, normalized],
                    |row| row.get(0),
                )
                .ok();
            if dup.is_some() {
                continue;
            }

            let confidence = attr.confidence.unwrap_or(0.7);
            let importance = attr.importance.unwrap_or(base_importance);
            let attribute_id = Uuid::new_v4().to_string();
            let group_key = normalize_group_key(attr.group_key.as_deref());
            let claim_key = normalize_claim_key(attr.claim_key.as_deref());

            match conn.execute(
                "INSERT INTO entity_attributes
                 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
                  group_key, claim_key, confidence, importance, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', ?12, ?12)",
                params![
                    attribute_id,
                    aspect_id,
                    agent_id,
                    source_memory_id,
                    kind,
                    attr.content,
                    normalized,
                    group_key,
                    claim_key,
                    confidence,
                    importance,
                    now,
                ],
            ) {
                Ok(_) => {
                    result.attributes_created += 1;
                    // Check for supersession among siblings
                    if kind == "attribute" && claim_key.is_some() {
                        result.attributes_superseded += mark_superseded_siblings(
                            conn,
                            &StoredAttribute {
                                id: attribute_id,
                                content: attr.content.clone(),
                                normalized_content: normalized,
                                group_key,
                                claim_key: claim_key.unwrap_or_default(),
                                memory_id: Some(source_memory_id.to_string()),
                                created_at: now.to_string(),
                            },
                            &aspect_id,
                            agent_id,
                            now,
                        );
                    }
                }
                Err(_) => {} // UNIQUE constraint — skip
            }
        }
    }

    // Step 3: Create dependencies between co-occurring entities
    if resolved.len() >= 2 {
        for i in 0..resolved.len() - 1 {
            for j in i + 1..resolved.len() {
                if resolved[i] == resolved[j] {
                    continue;
                }
                let existing_dep: Option<String> = conn
                    .query_row(
                        "SELECT id FROM entity_dependencies
                         WHERE source_entity_id = ?1 AND target_entity_id = ?2
                           AND dependency_type = 'related_to' AND agent_id = ?3
                         LIMIT 1",
                        params![resolved[i], resolved[j], agent_id],
                        |row| row.get(0),
                    )
                    .ok();
                if existing_dep.is_some() {
                    continue;
                }
                let dep_id = Uuid::new_v4().to_string();
                let reason =
                    format!("co-occurred in extracted entities for memory {source_memory_id}");
                conn.execute(
                    "INSERT OR IGNORE INTO entity_dependencies
                     (id, source_entity_id, target_entity_id, agent_id,
                      dependency_type, strength, confidence, reason, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, 'related_to', 0.3, 0.5, ?5, ?6, ?6)",
                    params![dep_id, resolved[i], resolved[j], agent_id, reason, now],
                )
                .ok();
            }
        }
    }

    result
}

// ---------------------------------------------------------------------------
// Public API: Decrement mentions
// ---------------------------------------------------------------------------

/// Decrement entity mention counts after memory purge. Entities that
/// drop to 0 mentions are deleted, and dangling relations are cleaned.
pub fn decrement_entity_mentions(
    conn: &rusqlite::Connection,
    input: &DecrementInput,
) -> DecrementResult {
    if input.entity_ids.is_empty() {
        return DecrementResult::default();
    }

    // Decrement mentions (floor at 0)
    for entity_id in &input.entity_ids {
        conn.execute(
            "UPDATE entities SET mentions = MAX(0, mentions - 1) WHERE id = ?1",
            params![entity_id],
        )
        .ok();
    }

    // Find orphaned entities (mentions = 0)
    let mut stmt = match conn.prepare("SELECT id FROM entities WHERE mentions = 0") {
        Ok(s) => s,
        Err(_) => return DecrementResult::default(),
    };
    let orphaned: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .ok()
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();

    if !orphaned.is_empty() {
        for id in &orphaned {
            // Clean dangling relations
            conn.execute(
                "DELETE FROM relations WHERE source_entity_id = ?1 OR target_entity_id = ?1",
                params![id],
            )
            .ok();

            // Clean mentions
            conn.execute(
                "DELETE FROM memory_entity_mentions WHERE entity_id = ?1",
                params![id],
            )
            .ok();

            // Delete entity
            conn.execute("DELETE FROM entities WHERE id = ?1", params![id])
                .ok();
        }
    }

    DecrementResult {
        entities_orphaned: orphaned.len(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_likely_supersession_detects_update_markers() {
        assert!(is_likely_supersession(
            "now uses PostgreSQL database instead of MySQL database",
            "uses MySQL database for storage"
        ));
        assert!(is_likely_supersession(
            "currently runs on port 8080 for the server",
            "runs on port 3000 for the server"
        ));
    }

    #[test]
    fn is_likely_supersession_rejects_low_overlap() {
        assert!(!is_likely_supersession(
            "completely different topic here",
            "unrelated content about cats"
        ));
    }

    #[test]
    fn is_likely_supersession_numeric_conflict() {
        assert!(is_likely_supersession(
            "the port is 8080",
            "the port is 3000"
        ));
    }

    #[test]
    fn normalize_claim_key_valid() {
        assert_eq!(
            normalize_claim_key(Some("Favorite Restaurant")),
            Some("favorite_restaurant".to_string())
        );
    }

    #[test]
    fn normalize_claim_key_too_short() {
        assert_eq!(normalize_claim_key(Some("ab")), None);
        assert_eq!(normalize_claim_key(None), None);
    }

    #[test]
    fn tokenize_basic() {
        let tokens = tokenize("Hello, World! foo-bar");
        assert!(tokens.contains(&"hello".to_string()));
        assert!(tokens.contains(&"world".to_string()));
        assert!(tokens.contains(&"foo-bar".to_string()));
    }

    #[test]
    fn has_update_marker_positive() {
        assert!(has_update_marker("now uses Rust"));
        assert!(has_update_marker("Currently deployed"));
        assert!(has_update_marker("Switched to v2"));
    }

    #[test]
    fn has_update_marker_negative() {
        assert!(!has_update_marker("uses Rust"));
        assert!(!has_update_marker("a simple fact"));
    }

    #[test]
    fn numeric_conflict_detected() {
        let left = vec!["port".into(), "8080".into()];
        let right = vec!["port".into(), "3000".into()];
        assert!(has_numeric_conflict(&left, &right));
    }

    #[test]
    fn no_numeric_conflict_when_same() {
        let left = vec!["port".into(), "8080".into()];
        let right = vec!["port".into(), "8080".into()];
        assert!(!has_numeric_conflict(&left, &right));
    }
}
