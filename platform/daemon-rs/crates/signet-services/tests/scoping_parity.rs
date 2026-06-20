use rusqlite::{Connection, OptionalExtension, params};
use signet_services::graph::list_knowledge_entities;
use signet_services::session::{ClaimResult, RuntimePath, SessionTracker};
use signet_services::transactions::{IngestInput, ingest};

fn setup_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("run migrations");
    conn
}

fn insert_entity(conn: &Connection, id: &str, name: &str, agent_id: &str, status: &str) {
    conn.execute(
        "INSERT INTO entities
         (id, name, canonical_name, entity_type, agent_id, mentions, status, pinned, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'project', ?4, 1, ?5, 0, '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z')",
        params![id, name, name.to_lowercase(), agent_id, status],
    )
    .expect("insert entity");
}

fn insert_aspect(conn: &Connection, id: &str, entity_id: &str, agent_id: &str) {
    conn.execute(
        "INSERT INTO entity_aspects
         (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'scope', 'scope', 0.5, '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z')",
        params![id, entity_id, agent_id],
    )
    .expect("insert aspect");
}

fn insert_attribute(
    conn: &Connection,
    id: &str,
    aspect_id: &str,
    agent_id: &str,
    kind: &str,
    status: &str,
) {
    conn.execute(
        "INSERT INTO entity_attributes
         (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
          status, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?5, 0.8, 0.5, ?6, '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z')",
        params![id, aspect_id, agent_id, kind, format!("content-{id}"), status],
    )
    .expect("insert attribute");
}

// Port of platform/daemon/src/agent-id.test.ts:25-40 and
// session-tracker.test.ts:18-29, 62-72. Session keys are normalized, runtime
// ownership conflicts are enforced, and active listings are filtered by agent.
#[test]
fn session_tracker_normalizes_keys_and_filters_by_agent() {
    let tracker = SessionTracker::new();

    assert!(matches!(
        tracker.claim(
            "session:agent:agent-a:scope-1",
            RuntimePath::Plugin,
            "agent-a"
        ),
        ClaimResult::Ok
    ));
    assert!(matches!(
        tracker.claim("agent:agent-b:scope-2", RuntimePath::Legacy, "agent-b"),
        ClaimResult::Ok
    ));

    assert_eq!(
        tracker.get_path("agent:agent-a:scope-1"),
        Some(RuntimePath::Plugin)
    );
    assert!(matches!(
        tracker.claim("agent:agent-a:scope-1", RuntimePath::Legacy, "agent-a"),
        ClaimResult::Conflict {
            claimed_by: RuntimePath::Plugin
        }
    ));

    let agent_a = tracker.list_sessions(Some("agent-a"));
    assert_eq!(agent_a.len(), 1);
    assert_eq!(agent_a[0].key, "agent:agent-a:scope-1");
    assert_eq!(agent_a[0].agent_id, "agent-a");
    assert_eq!(agent_a[0].runtime_path, "plugin");

    tracker.bypass("session:agent:agent-a:scope-1");
    assert!(tracker.is_bypassed("agent:agent-a:scope-1"));
    tracker.release("agent:agent-a:scope-1");
    assert!(!tracker.is_bypassed("agent:agent-a:scope-1"));
}

// Port of platform/daemon/src/knowledge-graph-list.test.ts:169-220 and
// inline-entity-linker.test.ts:80-97. Knowledge graph reads must not leak
// archived rows or another agent's matching entity names.
#[test]
fn knowledge_entity_listing_honors_agent_and_active_visibility_scope() {
    let conn = setup_conn();
    insert_entity(&conn, "e-agent-a", "Shared Project", "agent-a", "active");
    insert_entity(
        &conn,
        "e-agent-a-archived",
        "Archived Project",
        "agent-a",
        "archived",
    );
    insert_entity(&conn, "e-agent-b", "shared project", "agent-b", "active");
    insert_aspect(&conn, "asp-a", "e-agent-a", "agent-a");
    insert_attribute(
        &conn,
        "attr-active",
        "asp-a",
        "agent-a",
        "attribute",
        "active",
    );
    insert_attribute(
        &conn,
        "attr-superseded",
        "asp-a",
        "agent-a",
        "attribute",
        "superseded",
    );
    insert_attribute(
        &conn,
        "attr-constraint",
        "asp-a",
        "agent-a",
        "constraint",
        "active",
    );

    let rows = list_knowledge_entities(&conn, "agent-a", None, None, 20, 0)
        .expect("list agent-a entities");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entity.id, "e-agent-a");
    assert_eq!(rows[0].entity.agent_id, "agent-a");
    assert_eq!(rows[0].attribute_count, 1);
    assert_eq!(rows[0].constraint_count, 1);

    let agent_b = list_knowledge_entities(&conn, "agent-b", None, None, 20, 0)
        .expect("list agent-b entities");
    assert_eq!(agent_b.len(), 1);
    assert_eq!(agent_b[0].entity.id, "e-agent-b");

    let wrong_agent_match =
        signet_core::queries::entity::find_by_canonical(&conn, "shared project", "agent-c")
            .expect("canonical lookup for missing agent");
    assert!(wrong_agent_match.is_none());
}

// Port of platform/daemon/src/cross-agent.test.ts:77-113. Inbox reads should
// return direct messages for the recipient plus broadcasts, while excluding
// unrelated direct messages for another agent.
#[test]
fn cross_agent_inbox_visibility_includes_broadcasts_without_direct_leakage() {
    let conn = setup_conn();
    conn.execute_batch(
        "INSERT INTO agent_messages
            (id, created_at, from_agent_id, from_session_key, to_agent_id, to_session_key, content, type, broadcast)
         VALUES
            ('msg-direct-beta', '2026-06-20T00:00:00Z', 'alpha', 'sess-a', 'beta', NULL,
             'Need help with migration rollout plan.', 'assist_request', 0),
            ('msg-broadcast', '2026-06-20T00:00:01Z', 'alpha', NULL, NULL, NULL,
             'CI is currently red on main.', 'decision_update', 1),
            ('msg-direct-gamma', '2026-06-20T00:00:02Z', 'alpha', 'sess-a', 'gamma', NULL,
             'Gamma-only direct message must not leak.', 'assist_request', 0);",
    )
    .expect("seed cross-agent messages");

    let messages = {
        let mut stmt = conn
            .prepare(
                "SELECT id, type, broadcast FROM agent_messages
                 WHERE to_agent_id = ?1 OR broadcast = 1
                 ORDER BY created_at",
            )
            .expect("prepare inbox query");
        stmt.query_map(["beta"], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .expect("query inbox")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect inbox")
    };

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].0, "msg-direct-beta");
    assert_eq!(messages[0].1, "assist_request");
    assert_eq!(messages[1].0, "msg-broadcast");
    assert_eq!(messages[1].2, 1);
    assert!(messages.iter().all(|row| row.0 != "msg-direct-gamma"));
}

// Port of platform/daemon/src/routes/memory-routes-scope.test.ts:102-142.
// The Rust transaction layer scopes duplicate detection by agent, visibility,
// and optional scope so scoped writes do not alias unscoped/private rows.
#[test]
fn memory_ingest_duplicate_detection_is_agent_visibility_and_scope_local() {
    let conn = setup_conn();
    let first = ingest(
        &conn,
        &IngestInput {
            content: "Scoped duplicate parity content.",
            memory_type: "fact",
            tags: vec!["scope".to_string()],
            who: None,
            why: None,
            project: Some("project-a"),
            importance: 0.5,
            pinned: false,
            source_type: Some("contract"),
            source_id: Some("scope-test"),
            source_path: None,
            idempotency_key: None,
            runtime_path: None,
            actor: "test",
            agent_id: "agent-a",
            visibility: "private",
            scope: Some("project-a"),
        },
    )
    .expect("ingest first scoped memory");
    assert!(first.duplicate_of.is_none());

    let same_scope = ingest(
        &conn,
        &IngestInput {
            content: "Scoped duplicate parity content.",
            memory_type: "fact",
            tags: vec!["scope".to_string()],
            who: None,
            why: None,
            project: Some("project-a"),
            importance: 0.5,
            pinned: false,
            source_type: Some("contract"),
            source_id: Some("scope-test-dup"),
            source_path: None,
            idempotency_key: None,
            runtime_path: None,
            actor: "test",
            agent_id: "agent-a",
            visibility: "private",
            scope: Some("project-a"),
        },
    )
    .expect("ingest duplicate scoped memory");
    assert_eq!(same_scope.duplicate_of.as_deref(), Some(first.id.as_str()));

    let other_scope = ingest(
        &conn,
        &IngestInput {
            content: "Scoped duplicate parity content.",
            memory_type: "fact",
            tags: vec!["scope".to_string()],
            who: None,
            why: None,
            project: Some("project-b"),
            importance: 0.5,
            pinned: false,
            source_type: Some("contract"),
            source_id: Some("scope-test-other"),
            source_path: None,
            idempotency_key: None,
            runtime_path: None,
            actor: "test",
            agent_id: "agent-a",
            visibility: "private",
            scope: Some("project-b"),
        },
    )
    .expect("ingest other scoped memory");
    assert!(other_scope.duplicate_of.is_none());
    assert_ne!(other_scope.id, first.id);

    let other_agent = ingest(
        &conn,
        &IngestInput {
            content: "Scoped duplicate parity content.",
            memory_type: "fact",
            tags: vec!["scope".to_string()],
            who: None,
            why: None,
            project: Some("project-a"),
            importance: 0.5,
            pinned: false,
            source_type: Some("contract"),
            source_id: Some("scope-test-agent-b"),
            source_path: None,
            idempotency_key: None,
            runtime_path: None,
            actor: "test",
            agent_id: "agent-b",
            visibility: "private",
            scope: Some("project-a"),
        },
    )
    .expect("ingest other agent memory");
    assert!(other_agent.duplicate_of.is_none());
}

// Port of platform/daemon/src/task-scope.test.ts:16-47. The scheduler's
// scoped task lookup contract hides out-of-scope rows when enforcement is
// active but still resolves the owner through task_scope_hints otherwise.
#[test]
fn scheduled_task_scope_hints_gate_rows_when_scope_enforced() {
    let conn = setup_conn();
    conn.execute(
        "INSERT INTO scheduled_tasks
         (id, name, prompt, cron_expression, harness, enabled, next_run_at, created_at, updated_at)
         VALUES ('task-1', 'Test task', 'Prompt', '* * * * *', 'codex', 1,
                 '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z')",
        [],
    )
    .expect("insert task");
    conn.execute(
        "INSERT INTO task_scope_hints (task_id, agent_id, created_at, updated_at)
         VALUES ('task-1', 'agent-b', '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z')",
        [],
    )
    .expect("insert task scope hint");

    let scoped_sql = "SELECT t.id, COALESCE(h.agent_id, 'default') AS agent_id
                      FROM scheduled_tasks t
                      LEFT JOIN task_scope_hints h ON h.task_id = t.id
                      WHERE t.id = ?1 AND COALESCE(h.agent_id, 'default') = ?2";
    let hidden: Option<(String, String)> = conn
        .query_row(scoped_sql, params!["task-1", "agent-a"], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()
        .expect("out-of-scope task lookup");
    assert!(hidden.is_none());

    let visible: Option<(String, String)> = conn
        .query_row(scoped_sql, params!["task-1", "agent-b"], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()
        .expect("in-scope task lookup");
    assert_eq!(visible, Some(("task-1".to_string(), "agent-b".to_string())));

    let unenforced: (String, String) = conn
        .query_row(
            "SELECT t.id, COALESCE(h.agent_id, 'default') AS agent_id
             FROM scheduled_tasks t
             LEFT JOIN task_scope_hints h ON h.task_id = t.id
             WHERE t.id = ?1",
            ["task-1"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("unenforced task lookup");
    assert_eq!(unenforced, ("task-1".to_string(), "agent-b".to_string()));
}

// Port of platform/daemon/src/agent-id.test.ts:42-72. First-seen agents can be
// registered without overwriting existing isolation policy.
#[test]
fn agent_registration_preserves_existing_policy_rows() {
    let conn = setup_conn();
    conn.execute(
        "INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
         VALUES ('noam', 'Noam', 'isolated', 'private-team', '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z')",
        [],
    )
    .expect("seed existing agent");
    conn.execute(
        "INSERT INTO agents (id, name, read_policy, created_at, updated_at)
         VALUES ('noam', 'noam', 'shared', '2026-06-21T00:00:00Z', '2026-06-21T00:00:00Z')
         ON CONFLICT(id) DO NOTHING",
        [],
    )
    .expect("first-seen registration should not overwrite");

    let row: (String, String, Option<String>) = conn
        .query_row(
            "SELECT name, read_policy, policy_group FROM agents WHERE id = 'noam'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read agent policy");
    assert_eq!(
        row,
        (
            "Noam".to_string(),
            "isolated".to_string(),
            Some("private-team".to_string())
        )
    );
}
