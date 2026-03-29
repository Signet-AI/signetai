//! Memory transaction helpers.
//!
//! Orchestrates content normalization, hashing, CRUD operations, and
//! history recording. All functions operate on a single `&Connection`
//! (the write connection).

use rusqlite::Connection;
use tracing::info;

use signet_core::error::CoreError;
use signet_core::queries::memory;

use crate::normalize::normalize_and_hash;

// ---------------------------------------------------------------------------
// Ingest (create new memory)
// ---------------------------------------------------------------------------

pub struct IngestInput<'a> {
    pub content: &'a str,
    pub memory_type: &'a str,
    pub tags: Vec<String>,
    pub who: Option<&'a str>,
    pub why: Option<&'a str>,
    pub project: Option<&'a str>,
    pub importance: f64,
    pub pinned: bool,
    pub source_type: Option<&'a str>,
    pub source_id: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
    pub runtime_path: Option<&'a str>,
    pub actor: &'a str,
    pub agent_id: &'a str,
    pub visibility: &'a str,
    pub scope: Option<&'a str>,
}

pub struct IngestResult {
    pub id: String,
    pub hash: String,
    pub duplicate_of: Option<String>,
}

pub fn ingest(conn: &Connection, input: &IngestInput) -> Result<IngestResult, CoreError> {
    let norm = normalize_and_hash(input.content);

    // Duplicate check
    if let Some(dup_id) = memory::exists_by_hash_scoped(
        conn,
        &norm.hash,
        input.agent_id,
        input.scope,
        input.visibility,
    )? {
        return Ok(IngestResult {
            id: dup_id.clone(),
            hash: norm.hash,
            duplicate_of: Some(dup_id),
        });
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let tags_json = serde_json::to_string(&input.tags).unwrap_or_else(|_| "[]".into());

    memory::insert(
        conn,
        &memory::InsertMemory {
            id: &id,
            content: &norm.storage,
            normalized_content: &norm.normalized,
            content_hash: &norm.hash,
            memory_type: input.memory_type,
            tags: &tags_json,
            who: input.who,
            why: input.why,
            project: input.project,
            importance: input.importance,
            pinned: input.pinned,
            extraction_status: "none",
            embedding_model: None,
            extraction_model: None,
            source_type: input.source_type,
            source_id: input.source_id,
            idempotency_key: input.idempotency_key,
            runtime_path: input.runtime_path,
            now: &now,
            updated_by: input.actor,
            agent_id: input.agent_id,
            visibility: input.visibility,
            scope: input.scope,
        },
    )?;

    // Record history
    let hist_id = uuid::Uuid::new_v4().to_string();
    memory::insert_history(
        conn,
        &memory::InsertHistory {
            id: &hist_id,
            memory_id: &id,
            event: "created",
            old_content: None,
            new_content: Some(&norm.storage),
            changed_by: input.actor,
            reason: None,
            metadata: None,
            now: &now,
            actor_type: input.source_type,
            session_id: None,
            request_id: None,
        },
    )?;

    info!(id = %id, hash = %norm.hash, "memory ingested");
    Ok(IngestResult {
        id,
        hash: norm.hash,
        duplicate_of: None,
    })
}

// ---------------------------------------------------------------------------
// Modify (update existing memory)
// ---------------------------------------------------------------------------

pub struct ModifyInput<'a> {
    pub id: &'a str,
    pub content: Option<&'a str>,
    pub memory_type: Option<&'a str>,
    pub tags: Option<Vec<String>>,
    pub importance: Option<f64>,
    pub pinned: Option<bool>,
    pub if_version: Option<i64>,
    pub actor: &'a str,
    pub reason: Option<&'a str>,
}

#[derive(Debug)]
pub enum ModifyResult {
    Updated { new_version: i64 },
    NotFound,
    Deleted,
    VersionConflict { current: i64 },
    DuplicateHash { existing_id: String },
    NoChanges,
}

pub fn modify(conn: &Connection, input: &ModifyInput) -> Result<ModifyResult, CoreError> {
    let now = chrono::Utc::now().to_rfc3339();

    // Get old content for history
    let old = memory::get(conn, input.id)?;
    let old_content = old.as_ref().map(|m| m.content.clone());

    // Normalize new content if provided
    let norm = input.content.map(normalize_and_hash);
    let tags_json = input
        .tags
        .as_ref()
        .map(|t| serde_json::to_string(t).unwrap_or_else(|_| "[]".into()));

    let fields = memory::UpdateFields {
        content: norm.as_ref().map(|n| n.storage.as_str()),
        normalized_content: norm.as_ref().map(|n| n.normalized.as_str()),
        content_hash: norm.as_ref().map(|n| n.hash.as_str()),
        memory_type: input.memory_type,
        tags: tags_json.as_deref(),
        importance: input.importance,
        pinned: input.pinned,
        extraction_status: if norm.is_some() {
            Some("none") // Content change resets extraction
        } else {
            None
        },
        extraction_model: None,
        embedding_model: None,
    };

    let result = memory::update(conn, input.id, &fields, input.actor, &now, input.if_version)?;

    match &result {
        memory::UpdateResult::Updated { new_version } => {
            // Record history
            let hist_id = uuid::Uuid::new_v4().to_string();
            let new_content = norm.as_ref().map(|n| n.storage.as_str());
            let metadata = serde_json::json!({
                "contentChanged": norm.is_some(),
                "ifVersion": input.if_version,
            });
            memory::insert_history(
                conn,
                &memory::InsertHistory {
                    id: &hist_id,
                    memory_id: input.id,
                    event: "updated",
                    old_content: old_content.as_deref(),
                    new_content,
                    changed_by: input.actor,
                    reason: input.reason,
                    metadata: Some(&metadata.to_string()),
                    now: &now,
                    actor_type: None,
                    session_id: None,
                    request_id: None,
                },
            )?;

            Ok(ModifyResult::Updated {
                new_version: *new_version,
            })
        }
        memory::UpdateResult::NotFound => Ok(ModifyResult::NotFound),
        memory::UpdateResult::Deleted => Ok(ModifyResult::Deleted),
        memory::UpdateResult::VersionConflict { current } => {
            Ok(ModifyResult::VersionConflict { current: *current })
        }
        memory::UpdateResult::DuplicateHash { existing_id } => Ok(ModifyResult::DuplicateHash {
            existing_id: existing_id.clone(),
        }),
        memory::UpdateResult::NoChanges => Ok(ModifyResult::NoChanges),
    }
}

// ---------------------------------------------------------------------------
// Forget (soft-delete)
// ---------------------------------------------------------------------------

pub struct ForgetInput<'a> {
    pub id: &'a str,
    pub force: bool,
    pub if_version: Option<i64>,
    pub actor: &'a str,
    pub reason: Option<&'a str>,
    pub actor_type: Option<&'a str>,
}

#[derive(Debug)]
pub enum ForgetResult {
    Deleted { new_version: i64 },
    NotFound,
    AlreadyDeleted,
    VersionConflict { current: i64 },
    PinnedRequiresForce,
    AutonomousForceDenied,
}

pub fn forget(conn: &Connection, input: &ForgetInput) -> Result<ForgetResult, CoreError> {
    // Spec 27.2: pipeline cannot force-delete pinned memories
    if input.force && input.actor_type == Some("pipeline") {
        let existing = memory::get(conn, input.id)?;
        if let Some(m) = &existing
            && m.pinned
        {
            return Ok(ForgetResult::AutonomousForceDenied);
        }
    }

    let now = chrono::Utc::now().to_rfc3339();
    let result = memory::soft_delete(
        conn,
        input.id,
        input.actor,
        &now,
        input.force,
        input.if_version,
    )?;

    match result {
        memory::DeleteResult::Deleted { new_version } => {
            // Get content for history
            let old = memory::get(conn, input.id)?;
            let hist_id = uuid::Uuid::new_v4().to_string();
            let metadata = serde_json::json!({
                "force": input.force,
                "ifVersion": input.if_version,
            });
            memory::insert_history(
                conn,
                &memory::InsertHistory {
                    id: &hist_id,
                    memory_id: input.id,
                    event: "deleted",
                    old_content: old.as_ref().map(|m| m.content.as_str()),
                    new_content: None,
                    changed_by: input.actor,
                    reason: input.reason,
                    metadata: Some(&metadata.to_string()),
                    now: &now,
                    actor_type: input.actor_type,
                    session_id: None,
                    request_id: None,
                },
            )?;

            info!(id = %input.id, "memory forgotten");
            Ok(ForgetResult::Deleted { new_version })
        }
        memory::DeleteResult::NotFound => Ok(ForgetResult::NotFound),
        memory::DeleteResult::AlreadyDeleted => Ok(ForgetResult::AlreadyDeleted),
        memory::DeleteResult::VersionConflict { current } => {
            Ok(ForgetResult::VersionConflict { current })
        }
        memory::DeleteResult::PinnedRequiresForce => Ok(ForgetResult::PinnedRequiresForce),
    }
}

// ---------------------------------------------------------------------------
// Recover (un-delete)
// ---------------------------------------------------------------------------

/// Default retention window: 30 days in milliseconds.
const SOFT_DELETE_RETENTION_MS: u64 = 30 * 24 * 3600 * 1000;

pub struct RecoverInput<'a> {
    pub id: &'a str,
    pub if_version: Option<i64>,
    pub actor: &'a str,
    pub reason: Option<&'a str>,
}

#[derive(Debug)]
pub enum RecoverResult {
    Recovered { new_version: i64 },
    NotFound,
    NotDeleted,
    VersionConflict { current: i64 },
    RetentionExpired,
}

pub fn recover(conn: &Connection, input: &RecoverInput) -> Result<RecoverResult, CoreError> {
    let now = chrono::Utc::now().to_rfc3339();
    let result = memory::recover(
        conn,
        input.id,
        input.actor,
        &now,
        SOFT_DELETE_RETENTION_MS,
        input.if_version,
    )?;

    match result {
        memory::RecoverResult::Recovered { new_version } => {
            let hist_id = uuid::Uuid::new_v4().to_string();
            memory::insert_history(
                conn,
                &memory::InsertHistory {
                    id: &hist_id,
                    memory_id: input.id,
                    event: "recovered",
                    old_content: None,
                    new_content: None,
                    changed_by: input.actor,
                    reason: input.reason,
                    metadata: None,
                    now: &now,
                    actor_type: None,
                    session_id: None,
                    request_id: None,
                },
            )?;

            info!(id = %input.id, "memory recovered");
            Ok(RecoverResult::Recovered { new_version })
        }
        memory::RecoverResult::NotFound => Ok(RecoverResult::NotFound),
        memory::RecoverResult::NotDeleted => Ok(RecoverResult::NotDeleted),
        memory::RecoverResult::VersionConflict { current } => {
            Ok(RecoverResult::VersionConflict { current })
        }
        memory::RecoverResult::RetentionExpired => Ok(RecoverResult::RetentionExpired),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        signet_core::db::register_vec_extension();
        let conn = Connection::open_in_memory().unwrap();
        signet_core::db::configure_pragmas_pub(&conn).unwrap();
        signet_core::migrations::run(&conn).unwrap();
        signet_core::db::ensure_fts_pub(&conn).unwrap();
        signet_core::db::ensure_vec_table_pub(&conn).unwrap();
        conn
    }

    #[test]
    fn ingest_and_deduplicate() {
        let conn = setup();

        let r1 = ingest(
            &conn,
            &IngestInput {
                content: "Hello World!",
                memory_type: "fact",
                tags: vec!["test".into()],
                who: Some("agent"),
                why: None,
                project: None,
                importance: 0.5,
                pinned: false,
                source_type: None,
                source_id: None,
                idempotency_key: None,
                runtime_path: None,
                actor: "test",
                agent_id: "default",
                visibility: "global",
                scope: None,
            },
        )
        .unwrap();
        assert!(r1.duplicate_of.is_none());

        // Same content (different casing/whitespace) should deduplicate
        let r2 = ingest(
            &conn,
            &IngestInput {
                content: "  hello   world!  ",
                memory_type: "fact",
                tags: vec![],
                who: None,
                why: None,
                project: None,
                importance: 0.5,
                pinned: false,
                source_type: None,
                source_id: None,
                idempotency_key: None,
                runtime_path: None,
                actor: "test",
                agent_id: "default",
                visibility: "global",
                scope: None,
            },
        )
        .unwrap();
        assert_eq!(r2.duplicate_of.as_deref(), Some(r1.id.as_str()));
    }

    #[test]
    fn dedupe_is_scoped_by_agent_visibility_and_scope() {
        let conn = setup();

        let base = ingest(
            &conn,
            &IngestInput {
                content: "Scoped Duplicate",
                memory_type: "fact",
                tags: vec![],
                who: None,
                why: None,
                project: None,
                importance: 0.5,
                pinned: false,
                source_type: None,
                source_id: None,
                idempotency_key: None,
                runtime_path: None,
                actor: "test",
                agent_id: "agent-a",
                visibility: "global",
                scope: Some("scope-a"),
            },
        )
        .unwrap();

        let same = ingest(
            &conn,
            &IngestInput {
                content: " scoped   duplicate ",
                memory_type: "fact",
                tags: vec![],
                who: None,
                why: None,
                project: None,
                importance: 0.5,
                pinned: false,
                source_type: None,
                source_id: None,
                idempotency_key: None,
                runtime_path: None,
                actor: "test",
                agent_id: "agent-a",
                visibility: "global",
                scope: Some("scope-a"),
            },
        )
        .unwrap();
        assert_eq!(same.duplicate_of.as_deref(), Some(base.id.as_str()));

        let other_scope = ingest(
            &conn,
            &IngestInput {
                content: "Scoped Duplicate",
                memory_type: "fact",
                tags: vec![],
                who: None,
                why: None,
                project: None,
                importance: 0.5,
                pinned: false,
                source_type: None,
                source_id: None,
                idempotency_key: None,
                runtime_path: None,
                actor: "test",
                agent_id: "agent-a",
                visibility: "global",
                scope: Some("scope-b"),
            },
        )
        .unwrap();
        assert!(other_scope.duplicate_of.is_none());

        let other_visibility = ingest(
            &conn,
            &IngestInput {
                content: "Scoped Duplicate",
                memory_type: "fact",
                tags: vec![],
                who: None,
                why: None,
                project: None,
                importance: 0.5,
                pinned: false,
                source_type: None,
                source_id: None,
                idempotency_key: None,
                runtime_path: None,
                actor: "test",
                agent_id: "agent-a",
                visibility: "private",
                scope: Some("scope-a"),
            },
        )
        .unwrap();
        assert!(other_visibility.duplicate_of.is_none());

        let other_agent = ingest(
            &conn,
            &IngestInput {
                content: "Scoped Duplicate",
                memory_type: "fact",
                tags: vec![],
                who: None,
                why: None,
                project: None,
                importance: 0.5,
                pinned: false,
                source_type: None,
                source_id: None,
                idempotency_key: None,
                runtime_path: None,
                actor: "test",
                agent_id: "agent-b",
                visibility: "global",
                scope: Some("scope-a"),
            },
        )
        .unwrap();
        assert!(other_agent.duplicate_of.is_none());
    }

    #[test]
    fn modify_records_history() {
        let conn = setup();

        let r = ingest(
            &conn,
            &IngestInput {
                content: "original",
                memory_type: "fact",
                tags: vec![],
                who: None,
                why: None,
                project: None,
                importance: 0.5,
                pinned: false,
                source_type: None,
                source_id: None,
                idempotency_key: None,
                runtime_path: None,
                actor: "test",
                agent_id: "default",
                visibility: "global",
                scope: None,
            },
        )
        .unwrap();

        let result = modify(
            &conn,
            &ModifyInput {
                id: &r.id,
                content: Some("updated"),
                memory_type: None,
                tags: None,
                importance: None,
                pinned: None,
                if_version: Some(1),
                actor: "test",
                reason: Some("testing"),
            },
        )
        .unwrap();
        assert!(matches!(result, ModifyResult::Updated { new_version: 2 }));

        // Check history
        let hist = memory::get_history(&conn, &r.id).unwrap();
        assert_eq!(hist.len(), 2); // created + updated
    }

    #[test]
    fn forget_and_recover() {
        let conn = setup();

        let r = ingest(
            &conn,
            &IngestInput {
                content: "deletable",
                memory_type: "fact",
                tags: vec![],
                who: None,
                why: None,
                project: None,
                importance: 0.5,
                pinned: false,
                source_type: None,
                source_id: None,
                idempotency_key: None,
                runtime_path: None,
                actor: "test",
                agent_id: "default",
                visibility: "global",
                scope: None,
            },
        )
        .unwrap();

        let result = forget(
            &conn,
            &ForgetInput {
                id: &r.id,
                force: false,
                if_version: None,
                actor: "test",
                reason: Some("no longer needed"),
                actor_type: None,
            },
        )
        .unwrap();
        assert!(matches!(result, ForgetResult::Deleted { .. }));

        let result = recover(
            &conn,
            &RecoverInput {
                id: &r.id,
                if_version: None,
                actor: "test",
                reason: Some("actually needed"),
            },
        )
        .unwrap();
        assert!(matches!(result, RecoverResult::Recovered { .. }));

        // History should have created + deleted + recovered
        let hist = memory::get_history(&conn, &r.id).unwrap();
        assert_eq!(hist.len(), 3);
    }

    #[test]
    fn pipeline_cannot_force_delete_pinned() {
        let conn = setup();

        let r = ingest(
            &conn,
            &IngestInput {
                content: "pinned memory",
                memory_type: "fact",
                tags: vec![],
                who: None,
                why: None,
                project: None,
                importance: 0.9,
                pinned: true,
                source_type: None,
                source_id: None,
                idempotency_key: None,
                runtime_path: None,
                actor: "test",
                agent_id: "default",
                visibility: "global",
                scope: None,
            },
        )
        .unwrap();

        let result = forget(
            &conn,
            &ForgetInput {
                id: &r.id,
                force: true,
                if_version: None,
                actor: "pipeline-v2",
                reason: None,
                actor_type: Some("pipeline"),
            },
        )
        .unwrap();
        assert!(matches!(result, ForgetResult::AutonomousForceDenied));
    }
}
