use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;
use signet_core::migrations;
use signet_pipeline::graph_traversal::resolve_focal_entities;
use signet_pipeline::path_feedback::{
    RecordPathFeedbackInput, apply_fts_overlap_feedback, decay_aspect_weights, get_entity_health,
    get_pinned_entities, pin_entity, propagate_memory_status, record_path_feedback, unpin_entity,
};
use uuid::Uuid;

fn db_path() -> PathBuf {
    std::env::temp_dir().join(format!("signet-path-feedback-parity-{}.db", Uuid::new_v4()))
}

fn setup_db() -> (Connection, PathBuf) {
    let path = db_path();
    let conn = Connection::open(&path).expect("open test db");
    migrations::run(&conn).expect("run migrations");
    (conn, path)
}

fn cleanup(path: PathBuf) {
    let _ = std::fs::remove_file(path);
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn insert_entity(conn: &Connection, id: &str, name: &str, entity_type: &str, agent_id: &str) {
    let ts = now();
    conn.execute(
        "INSERT INTO entities
         (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
        params![id, name, name.to_lowercase(), entity_type, agent_id, ts],
    )
    .expect("insert entity");
}

fn insert_memory(conn: &Connection, id: &str, content: &str) {
    let ts = now();
    conn.execute(
        "INSERT INTO memories
         (id, type, content, confidence, importance, created_at, updated_at, updated_by, vector_clock, is_deleted)
         VALUES (?1, 'fact', ?2, 1.0, 0.5, ?3, ?3, 'test', '{}', 0)",
        params![id, content, ts],
    )
    .expect("insert memory");
}

fn seed_graph(conn: &Connection) {
    let ts = now();
    insert_memory(conn, "mem-a", "A memory");
    insert_entity(conn, "ent-a", "Entity A", "project", "default");
    insert_entity(conn, "ent-b", "Entity B", "project", "default");
    conn.execute(
        "INSERT INTO entity_aspects
         (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
         VALUES ('asp-a', 'ent-a', 'default', 'timeline', 'timeline', 0.5, ?1, ?1)",
        params![ts],
    )
    .expect("insert aspect");
    conn.execute(
        "INSERT INTO entity_attributes
         (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
         VALUES ('attr-a', 'asp-a', 'default', 'mem-a', 'attribute', 'x', 'x', 1, 0.8, 'active', ?1, ?1)",
        params![ts],
    )
    .expect("insert attribute");
    conn.execute(
        "INSERT INTO entity_dependencies
         (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, reason, created_at, updated_at)
         VALUES ('dep-a', 'ent-a', 'ent-b', 'default', 'related_to', 0.5, 0.7, 'single-memory', ?1, ?1)",
        params![ts],
    )
    .expect("insert dependency");
    seed_session_memory(
        conn,
        "sess-a",
        "mem-a",
        Some(
            json!({
                "entity_ids": ["ent-a", "ent-b"],
                "aspect_ids": ["asp-a"],
                "dependency_ids": ["dep-a"]
            })
            .to_string(),
        ),
        "default",
    );
}

fn seed_session_memory(
    conn: &Connection,
    session_key: &str,
    memory_id: &str,
    path_json: Option<String>,
    agent_id: &str,
) {
    let ts = now();
    conn.execute(
        "INSERT INTO session_memories
         (id, session_key, agent_id, memory_id, source, effective_score, final_score, rank, was_injected, fts_hit_count, created_at, path_json)
         VALUES (?1, ?2, ?3, ?4, 'ka_traversal', 0.8, 0.8, 0, 1, 0, ?5, ?6)",
        params![
            format!("sm-{session_key}-{memory_id}-{agent_id}"),
            session_key,
            agent_id,
            memory_id,
            ts,
            path_json,
        ],
    )
    .expect("insert session memory");
}

fn feedback_input(
    session_key: &str,
    agent_id: &str,
    ratings: HashMap<String, f64>,
) -> RecordPathFeedbackInput {
    RecordPathFeedbackInput {
        session_key: session_key.to_string(),
        agent_id: agent_id.to_string(),
        ratings,
        paths: None,
        rewards: None,
        max_aspect_weight: None,
        min_aspect_weight: None,
    }
}

#[test]
fn pinning_updates_entity_state_and_focal_resolution_unions_pinned_entities() {
    let (conn, path) = setup_db();
    insert_entity(
        &conn,
        "entity-pinned",
        "Pinned Project",
        "project",
        "default",
    );
    insert_entity(
        &conn,
        "entity-project",
        "other-project",
        "project",
        "default",
    );

    pin_entity(&conn, "entity-pinned", "default").expect("pin");
    let pinned = get_pinned_entities(&conn, "default").expect("pinned");
    assert_eq!(pinned.len(), 1);
    assert_eq!(pinned[0].id, "entity-pinned");

    let resolved = resolve_focal_entities(
        &conn,
        "default",
        Some("/tmp/other-project"),
        None,
        None,
        true,
    );
    assert_eq!(resolved.pinned_entity_ids, vec!["entity-pinned"]);
    assert!(resolved.entity_ids.contains(&"entity-pinned".to_string()));
    assert!(resolved.entity_ids.contains(&"entity-project".to_string()));
    assert_eq!(resolved.source, "project");

    unpin_entity(&conn, "entity-pinned", "default").expect("unpin");
    assert!(get_pinned_entities(&conn, "default").unwrap().is_empty());
    cleanup(path);
}

#[test]
fn entity_health_is_empty_after_predictor_comparison_table_retirement() {
    let (conn, path) = setup_db();
    conn.execute("DROP TABLE IF EXISTS predictor_comparisons", [])
        .expect("drop predictor table");
    assert_eq!(
        get_entity_health(&conn, "default", None, 3).unwrap(),
        vec![]
    );
    cleanup(path);
}

#[test]
fn fts_overlap_feedback_raises_aspect_weights_and_decay_respects_floor() {
    let (conn, path) = setup_db();
    insert_entity(&conn, "entity-1", "Alpha", "project", "default");
    insert_memory(&conn, "memory-1", "remember alpha");
    let ts = now();
    conn.execute(
        "INSERT INTO entity_aspects
         (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
         VALUES ('aspect-1', 'entity-1', 'default', 'core', 'core', 0.5, ?1, ?1)",
        params![ts],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO entity_attributes
         (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
          confidence, importance, status, created_at, updated_at)
         VALUES ('attr-1', 'aspect-1', 'default', 'memory-1', 'attribute', 'remember alpha',
                 'remember alpha', 1, 0.5, 'active', ?1, ?1)",
        params![ts],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_memories
         (id, session_key, agent_id, memory_id, source, effective_score, final_score, rank,
          was_injected, fts_hit_count, created_at)
         VALUES ('sm-1', 'session-1', 'default', 'memory-1', 'ka_traversal', 0.8, 0.8, 1, 1, 2, ?1)",
        params![ts],
    )
    .unwrap();

    let feedback =
        apply_fts_overlap_feedback(&conn, "session-1", "default", 0.02, 0.1, 1.0).unwrap();
    assert_eq!(feedback.aspects_updated, 1);
    assert_eq!(feedback.total_fts_confirmations, 2);
    let weight: f64 = conn
        .query_row(
            "SELECT weight FROM entity_aspects WHERE id = 'aspect-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(weight, 0.54);

    conn.execute(
        "UPDATE entity_aspects SET weight = 0.11, updated_at = datetime('now', '-30 days') WHERE id = 'aspect-1'",
        [],
    )
    .unwrap();
    assert_eq!(
        decay_aspect_weights(&conn, "default", 0.05, 0.1, 14).unwrap(),
        1
    );
    let decayed: f64 = conn
        .query_row(
            "SELECT weight FROM entity_aspects WHERE id = 'aspect-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(decayed, 0.1);
    cleanup(path);
}

#[test]
fn record_path_feedback_writes_event_stats_and_propagates_aspect_dependency_updates() {
    let (conn, path) = setup_db();
    seed_graph(&conn);

    let mut ratings = HashMap::new();
    ratings.insert("mem-a".to_string(), 1.0);
    let mut input = feedback_input("sess-a", "default", ratings);
    input.rewards = Some(json!({"mem-a": {"forward_citation": 1}}));
    let result = record_path_feedback(&conn, input).unwrap();

    assert_eq!(result.accepted, 1);
    assert_eq!(result.propagated, 1);

    let event: Option<(f64, f64)> = conn
        .query_row(
            "SELECT rating, reward_forward FROM path_feedback_events WHERE memory_id = 'mem-a'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .unwrap();
    assert_eq!(event, Some((1.0, 1.0)));

    let stats: (i64, i64) = conn
        .query_row(
            "SELECT sample_count, positive_count FROM path_feedback_stats LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(stats, (1, 1));

    let aspect_weight: f64 = conn
        .query_row(
            "SELECT weight FROM entity_aspects WHERE id = 'asp-a'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(aspect_weight > 0.5);

    let dep: (f64, String) = conn
        .query_row(
            "SELECT strength, reason FROM entity_dependencies WHERE id = 'dep-a'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(dep.0 > 0.5);
    assert_eq!(dep.1, "pattern-matched");

    let history: Option<(String, String)> = conn
        .query_row(
            "SELECT event, changed_by FROM entity_dependency_history
             WHERE dependency_id = 'dep-a' AND event = 'updated'
             ORDER BY rowid DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .unwrap();
    assert_eq!(
        history,
        Some(("updated".to_string(), "db-trigger".to_string()))
    );
    cleanup(path);
}

#[test]
fn record_path_feedback_skips_unowned_or_unknown_session_memory_ids() {
    let (conn, path) = setup_db();
    seed_graph(&conn);

    let mut ghost_ratings = HashMap::new();
    ghost_ratings.insert("ghost".to_string(), 1.0);
    let mut ghost = feedback_input("sess-a", "default", ghost_ratings);
    ghost.paths = Some(
        json!({"ghost": {"entity_ids": ["ent-a"], "aspect_ids": ["asp-a"], "dependency_ids": ["dep-a"]}}),
    );
    let result = record_path_feedback(&conn, ghost).unwrap();
    assert_eq!(result.accepted, 0);
    assert_eq!(result.propagated, 0);

    seed_session_memory(&conn, "sess-shared", "mem-a", None, "agent-b");
    let mut scoped_ratings = HashMap::new();
    scoped_ratings.insert("mem-a".to_string(), 1.0);
    let mut scoped = feedback_input("sess-shared", "agent-a", scoped_ratings);
    scoped.paths = Some(
        json!({"mem-a": {"entity_ids": ["ent-a"], "aspect_ids": ["asp-a"], "dependency_ids": ["dep-a"]}}),
    );
    let scoped_result = record_path_feedback(&conn, scoped).unwrap();
    assert_eq!(scoped_result.accepted, 0);
    assert_eq!(scoped_result.propagated, 0);
    cleanup(path);
}

#[test]
fn record_path_feedback_assigns_default_reason_for_positive_null_reason() {
    let (conn, path) = setup_db();
    seed_graph(&conn);
    let ts = now();
    conn.execute(
        "INSERT INTO entity_dependencies
         (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, reason, created_at, updated_at)
         VALUES ('dep-null', 'ent-a', 'ent-b', 'default', 'depends_on', 0.4, 0.4, NULL, ?1, ?1)",
        params![ts],
    )
    .unwrap();

    let mut ratings = HashMap::new();
    ratings.insert("mem-a".to_string(), 1.0);
    let mut input = feedback_input("sess-a", "default", ratings);
    input.paths = Some(
        json!({"mem-a": {"entity_ids": ["ent-a", "ent-b"], "aspect_ids": [], "dependency_ids": ["dep-null"]}}),
    );
    let result = record_path_feedback(&conn, input).unwrap();
    assert_eq!(result.accepted, 1);
    assert_eq!(result.propagated, 1);

    let dep: (Option<String>, f64) = conn
        .query_row(
            "SELECT reason, confidence FROM entity_dependencies WHERE id = 'dep-null'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(dep.0.as_deref(), Some("single-memory"));
    assert!(dep.1 >= 0.7);
    cleanup(path);
}

#[test]
fn record_path_feedback_promotes_cooccurrence_edge_after_repeated_sessions() {
    let (conn, path) = setup_db();
    seed_graph(&conn);

    for key in ["sess-co-1", "sess-co-2", "sess-co-3"] {
        seed_session_memory(&conn, key, "mem-a", None, "default");
        let mut ratings = HashMap::new();
        ratings.insert("mem-a".to_string(), 1.0);
        let mut input = feedback_input(key, "default", ratings);
        input.paths = Some(
            json!({"mem-a": {"entity_ids": ["ent-a", "ent-b"], "aspect_ids": [], "dependency_ids": []}}),
        );
        record_path_feedback(&conn, input).unwrap();
    }

    let forward: Option<(String, f64)> = conn
        .query_row(
            "SELECT reason, confidence
             FROM entity_dependencies
             WHERE source_entity_id = 'ent-a'
               AND target_entity_id = 'ent-b'
               AND dependency_type = 'related_to'
             ORDER BY updated_at DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .unwrap();
    assert!(forward.is_some());
    let (reason, confidence) = forward.unwrap();
    assert_eq!(reason, "pattern-matched");
    assert!(confidence >= 0.5);

    let reverse: Option<(String, f64)> = conn
        .query_row(
            "SELECT reason, confidence
             FROM entity_dependencies
             WHERE source_entity_id = 'ent-b'
               AND target_entity_id = 'ent-a'
               AND dependency_type = 'related_to'
             ORDER BY updated_at DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .unwrap();
    assert!(reverse.is_some());
    let (reason, confidence) = reverse.unwrap();
    assert_eq!(reason, "pattern-matched");
    assert!(confidence >= 0.5);
    cleanup(path);
}

#[test]
fn propagate_memory_status_supersedes_attributes_for_deleted_or_missing_memories() {
    let (conn, path) = setup_db();
    insert_entity(&conn, "entity-1", "Alpha", "project", "default");
    insert_memory(&conn, "memory-live", "remember alpha");
    insert_memory(&conn, "memory-deleted", "forget alpha");
    conn.execute(
        "UPDATE memories SET is_deleted = 1 WHERE id = 'memory-deleted'",
        [],
    )
    .unwrap();
    let ts = now();
    conn.execute(
        "INSERT INTO entity_aspects
         (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
         VALUES ('aspect-1', 'entity-1', 'default', 'core', 'core', 0.5, ?1, ?1)",
        params![ts],
    )
    .unwrap();
    for (id, memory_id) in [
        ("attr-live", "memory-live"),
        ("attr-deleted", "memory-deleted"),
    ] {
        conn.execute(
            "INSERT INTO entity_attributes
             (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
             VALUES (?1, 'aspect-1', 'default', ?2, 'attribute', 'x', 'x', 1, 0.5, 'active', ?3, ?3)",
            params![id, memory_id, ts],
        )
        .unwrap();
    }

    assert_eq!(propagate_memory_status(&conn, "default").unwrap(), 1);
    let statuses: HashMap<String, String> = conn
        .prepare("SELECT id, status FROM entity_attributes")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<HashMap<_, _>>>()
        .unwrap();
    assert_eq!(
        statuses.get("attr-live").map(String::as_str),
        Some("active")
    );
    assert_eq!(
        statuses.get("attr-deleted").map(String::as_str),
        Some("superseded")
    );
    cleanup(path);
}
