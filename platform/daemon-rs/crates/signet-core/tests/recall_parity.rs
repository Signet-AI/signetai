use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;
use signet_core::queries::embedding::vector_to_blob;
use signet_core::search::{
    RecallFilter, ScoredHit, SearchSource, annotate_currentness, apply_currentness_bias,
    apply_sec_lite, apply_temporal_topic_evidence, authorize_scored_candidates, fts_search,
    hint_search, load_currentness_info, merge_recall_candidates, native_artifact_fallbacks,
    score_temporal_topic_evidence, source_chunk_vector_fallbacks, structured_path_candidates,
    temporal_candidates_for_recall,
};

fn setup() -> Connection {
    signet_core::db::register_vec_extension();
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::db::configure_pragmas_pub(&conn).expect("configure pragmas");
    signet_core::migrations::run(&conn).expect("run migrations");
    signet_core::db::ensure_fts_pub(&conn).expect("ensure fts");
    signet_core::db::ensure_vec_table_pub(&conn).expect("ensure vec table");
    conn
}

fn insert_agent(conn: &Connection, id: &str, policy_group: Option<&str>) {
    conn.execute(
        "INSERT OR REPLACE INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
         VALUES (?1, ?1, 'isolated', ?2, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')",
        params![id, policy_group],
    )
    .expect("insert agent");
}

fn insert_memory(
    conn: &Connection,
    id: &str,
    content: &str,
    agent_id: &str,
    visibility: &str,
    project: Option<&str>,
    is_deleted: bool,
) {
    conn.execute(
        "INSERT INTO memories
         (id, content, content_hash, type, agent_id, visibility, project, is_deleted, created_at, updated_at, updated_by, importance)
         VALUES (?1, ?2, ?3, 'fact', ?4, ?5, ?6, ?7, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 'test', 0.5)",
        params![
            id,
            content,
            format!("hash-{id}"),
            agent_id,
            visibility,
            project,
            i64::from(is_deleted)
        ],
    )
    .expect("insert memory");
}

#[test]
fn memory_search_scope_authorizes_candidates_before_content_reads() {
    // Ported from `platform/daemon/src/memory-search.test.ts:2236` and `:2047`:
    // group-without-policyGroup must fall back to isolated access, and
    // unauthorized over-fetched candidates must be removed before hydration.
    let conn = setup();
    insert_agent(&conn, "agent-a", Some("team-a"));
    insert_agent(&conn, "agent-b", Some("team-a"));
    insert_agent(&conn, "agent-c", Some("team-b"));
    insert_memory(
        &conn,
        "own",
        "shared recall authorization marker owned",
        "agent-a",
        "private",
        None,
        false,
    );
    insert_memory(
        &conn,
        "team-global",
        "shared recall authorization marker team",
        "agent-b",
        "global",
        None,
        false,
    );
    insert_memory(
        &conn,
        "other-global",
        "shared recall authorization marker other",
        "agent-c",
        "global",
        None,
        false,
    );

    let scored = vec![
        ScoredHit {
            id: "team-global".into(),
            score: 0.9,
            source: SearchSource::Keyword,
        },
        ScoredHit {
            id: "other-global".into(),
            score: 0.8,
            source: SearchSource::Keyword,
        },
        ScoredHit {
            id: "own".into(),
            score: 0.7,
            source: SearchSource::Keyword,
        },
    ];
    let isolated = RecallFilter {
        agent_id: Some("agent-a"),
        read_policy: Some("group"),
        policy_group: None,
        ..Default::default()
    };
    let isolated_ids: Vec<_> = authorize_scored_candidates(&conn, &scored, &isolated)
        .into_iter()
        .map(|hit| hit.id)
        .collect();
    assert_eq!(isolated_ids, vec!["own"]);

    let group = RecallFilter {
        agent_id: Some("agent-a"),
        read_policy: Some("group"),
        policy_group: Some("team-a"),
        ..Default::default()
    };
    let group_ids: Vec<_> = authorize_scored_candidates(&conn, &scored, &group)
        .into_iter()
        .map(|hit| hit.id)
        .collect();
    assert_eq!(group_ids, vec!["team-global", "own"]);
}

#[test]
fn memory_search_temporal_candidates_require_intent_and_topic_evidence() {
    // Ported from `platform/daemon/src/memory-search.test.ts:588`, `:634`, and `:831`:
    // temporal edges stay behind the temporal-intent and memory-visibility gates,
    // then topic evidence upgrades only anchored temporal rows.
    let conn = setup();
    insert_agent(&conn, "agent-a", None);
    insert_memory(
        &conn,
        "apollo",
        "apollo launch window recall decision",
        "agent-a",
        "private",
        None,
        false,
    );
    insert_memory(
        &conn,
        "offtopic",
        "garden harvest note",
        "agent-a",
        "private",
        None,
        false,
    );
    insert_memory(
        &conn,
        "hidden",
        "apollo hidden archived row",
        "agent-a",
        "archived",
        None,
        false,
    );
    for (id, subject, confidence) in [
        ("te-apollo", "apollo", 0.95_f64),
        ("te-offtopic", "offtopic", 0.94_f64),
        ("te-hidden", "hidden", 0.99_f64),
    ] {
        conn.execute(
            "INSERT INTO temporal_edges
             (id, agent_id, subject_type, subject_id, facet, start_at, confidence, created_at, updated_at)
             VALUES (?1, 'agent-a', 'memory', ?2, 'occurred', '2026-06-01T00:00:00Z', ?3, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')",
            params![id, subject, confidence],
        )
        .expect("insert temporal edge");
    }
    let filter = RecallFilter {
        agent_id: Some("agent-a"),
        read_policy: Some("isolated"),
        ..Default::default()
    };

    assert!(temporal_candidates_for_recall(&conn, 10, &filter, 0.1, false).is_empty());
    let temporal = temporal_candidates_for_recall(&conn, 10, &filter, 0.1, true);
    let temporal_ids: Vec<_> = temporal.iter().map(|hit| hit.id.as_str()).collect();
    assert_eq!(temporal_ids, vec!["apollo", "offtopic"]);

    let fts = vec![ScoredHit {
        id: "apollo".into(),
        score: 0.7,
        source: SearchSource::Keyword,
    }];
    let mut fused = merge_recall_candidates(&fts, &[], &[], &[], &temporal, 0.5, 0.1);
    apply_temporal_topic_evidence(&conn, &mut fused, "apollo launch");
    let apollo = fused
        .iter()
        .find(|hit| hit.id == "apollo")
        .expect("apollo hit");
    let off_topic = fused
        .iter()
        .find(|hit| hit.id == "offtopic")
        .expect("off-topic temporal candidate");
    assert_eq!(apollo.source, SearchSource::TemporalHybrid);
    assert_eq!(off_topic.source, SearchSource::TemporalCandidate);
    assert!(score_temporal_topic_evidence("apollo launch", "garden harvest note") <= 0.01);
}

#[test]
fn memory_search_source_chunk_fallback_respects_agent_project_and_dedupe() {
    // Ported from `platform/daemon/src/memory-search.test.ts:155`, `:277`, and `:1258`:
    // source chunk vector fallback is provider-generic, but blocked for project-scoped
    // recall, isolated by agent, and deduped by public source id.
    let conn = setup();
    let query_vec = vec![1.0_f32, 0.0, 0.0];
    let matching = vector_to_blob(&query_vec);
    let other = vector_to_blob(&[0.0_f32, 1.0, 0.0]);
    for (id, agent_id, source_id, chunk, vector) in [
        (
            "emb-a",
            "agent-a",
            "obsidian:vault:a.md#overview:1-1:0",
            "source_id: obsidian:vault\nsource_provider: obsidian\nsource_path: /vault/a.md\nGeneric source chunk fallback marker.",
            matching.clone(),
        ),
        (
            "emb-b",
            "agent-b",
            "obsidian:vault:b.md#overview:1-1:0",
            "source_path: /vault/b.md\nGeneric source chunk fallback marker.",
            matching.clone(),
        ),
        (
            "emb-zero",
            "agent-a",
            "filesystem:repo:zero.md#overview:1-1:0",
            "source_path: /repo/zero.md\nWrong vector.",
            other,
        ),
    ] {
        conn.execute(
            "INSERT INTO embeddings
             (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
             VALUES (?1, ?2, ?3, 3, 'source_chunk', ?4, ?5, '2026-06-01T00:00:00Z', ?6)",
            params![id, format!("hash-{id}"), vector, source_id, chunk, agent_id],
        )
        .expect("insert source embedding");
    }

    let hits =
        source_chunk_vector_fallbacks(&conn, Some(&query_vec), &HashSet::new(), 5, "agent-a", None);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].source, SearchSource::SourceObsidian);
    assert_eq!(hits[0].source_path, "/vault/a.md");
    assert!(
        hits[0]
            .content
            .contains("Generic source chunk fallback marker")
    );

    assert!(
        source_chunk_vector_fallbacks(
            &conn,
            Some(&query_vec),
            &HashSet::new(),
            5,
            "agent-a",
            Some("/repo")
        )
        .is_empty()
    );
    let existing = HashSet::from(["obsidian:vault:a.md#overview:1-1:0".to_string()]);
    assert!(
        source_chunk_vector_fallbacks(&conn, Some(&query_vec), &existing, 5, "agent-a", None)
            .is_empty()
    );
}

#[test]
fn memory_search_native_artifact_fallback_requires_bridge_marker_and_scope() {
    // Ported from `platform/daemon/src/memory-search.test.ts:1156`, `:1193`, and `:1227`:
    // native artifact recall uses source-backed rows without materializing memories,
    // but only for live bridge-owned rows in the requesting agent scope.
    let conn = setup();
    for (source_path, agent_id, source_node_id, deleted, content) in [
        (
            "native/default.md",
            "agent-a",
            "memory-md-native-bridge",
            0_i64,
            "Native codex memory durable marker",
        ),
        (
            "native/wrong-marker.md",
            "agent-a",
            "manual-import",
            0_i64,
            "Native codex memory durable marker",
        ),
        (
            "native/deleted.md",
            "agent-a",
            "memory-md-native-bridge",
            1_i64,
            "Native codex memory durable marker",
        ),
        (
            "native/other-agent.md",
            "agent-b",
            "memory-md-native-bridge",
            0_i64,
            "Native codex memory durable marker",
        ),
    ] {
        conn.execute(
            "INSERT INTO memory_artifacts
             (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
              project, harness, captured_at, manifest_path, source_node_id, memory_sentence,
              memory_sentence_quality, content, updated_at, is_deleted)
             VALUES (?1, ?2, ?3, 'native_memory_registry', ?2, ?2, ?2, '/repo', 'codex',
                     '2026-06-01T00:00:00Z', NULL, ?4, 'Native codex memory durable marker.',
                     'ok', ?6, '2026-06-01T00:00:00Z', ?5)",
            params![agent_id, source_path, format!("sha-{source_path}"), source_node_id, deleted, content],
        )
        .expect("insert native artifact");
    }

    let hits = native_artifact_fallbacks(
        &conn,
        "Native codex memory durable marker",
        &HashSet::new(),
        10,
        "agent-a",
        Some("/repo"),
    );
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].source, SearchSource::NativeArtifact);
    assert_eq!(hits[0].source_path, "native/default.md");
    assert!(
        hits[0]
            .source_id
            .starts_with("native:codex:native_memory_registry:")
    );
}

#[test]
fn memory_search_hint_recall_is_scoped_to_live_requesting_agent_memories() {
    // Ported from `platform/daemon/src/memory-search.test.ts:1075`: hint recall must
    // not surface deleted memories or hints belonging to another agent.
    let conn = setup();
    insert_memory(
        &conn,
        "live",
        "ordinary content",
        "agent-a",
        "private",
        None,
        false,
    );
    insert_memory(
        &conn,
        "deleted",
        "ordinary content",
        "agent-a",
        "private",
        None,
        true,
    );
    insert_memory(
        &conn,
        "other",
        "ordinary content",
        "agent-b",
        "private",
        None,
        false,
    );
    for (id, memory_id, agent_id) in [
        ("hint-live", "live", "agent-a"),
        ("hint-deleted", "deleted", "agent-a"),
        ("hint-other", "other", "agent-b"),
    ] {
        conn.execute(
            "INSERT INTO memory_hints (id, memory_id, agent_id, hint, created_at)
             VALUES (?1, ?2, ?3, 'signet portable recall marker', '2026-06-01T00:00:00Z')",
            params![id, memory_id, agent_id],
        )
        .expect("insert hint");
    }
    let filter = RecallFilter {
        agent_id: Some("agent-a"),
        read_policy: Some("isolated"),
        ..Default::default()
    };
    let ids: Vec<_> = hint_search(&conn, "signet portable recall marker", 10, &filter)
        .into_iter()
        .map(|hit| hit.id)
        .collect();
    assert_eq!(ids, vec!["live"]);
}

#[test]
fn memory_search_structured_path_candidates_rescue_lexical_misses_without_dominating() {
    // Ported from `platform/daemon/src/memory-search.test.ts:1611` and `:1497`:
    // structured path evidence is a separate rescue channel, while SEC-lite keeps
    // traversal-only evidence below directly anchored recall.
    let conn = setup();
    insert_memory(
        &conn,
        "structured",
        "User prefers audio services for workouts.",
        "agent-a",
        "private",
        None,
        false,
    );
    conn.execute(
        "INSERT INTO entities (id, name, entity_type, description, created_at, updated_at, agent_id)
         VALUES ('ent-spotify', 'Spotify', 'product', 'music platform', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 'agent-a')",
        [],
    )
    .expect("insert entity");
    conn.execute(
        "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
         VALUES ('asp-music', 'ent-spotify', 'agent-a', 'music', 'music', 0.9, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')",
        [],
    )
    .expect("insert aspect");
    conn.execute(
        "INSERT INTO entity_attributes
         (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
         VALUES ('attr-spotify', 'asp-music', 'agent-a', 'structured', 'preference',
                 'Spotify should be used for music recommendations', 'spotify music recommendations',
                 0.9, 0.92, 'active', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')",
        [],
    )
    .expect("insert attribute");
    let filter = RecallFilter {
        agent_id: Some("agent-a"),
        read_policy: Some("isolated"),
        ..Default::default()
    };
    assert!(
        fts_search(&conn, "spotify recommendation", 10, &filter)
            .unwrap()
            .is_empty()
    );
    let structured = structured_path_candidates(&conn, "spotify recommendation", 10, &filter);
    assert_eq!(
        structured.first().map(|hit| hit.id.as_str()),
        Some("structured")
    );

    let fts = vec![ScoredHit {
        id: "direct".into(),
        score: 0.8,
        source: SearchSource::Keyword,
    }];
    let traversal = vec![ScoredHit {
        id: "traversal-only".into(),
        score: 0.95,
        source: SearchSource::Traversal,
    }];
    let mut scored = vec![fts[0].clone(), traversal[0].clone(), structured[0].clone()];
    apply_sec_lite(&mut scored, &fts, &[], &[], &structured, &traversal, 0.1);
    let direct = scored.iter().find(|hit| hit.id == "direct").unwrap();
    let traversal_only = scored
        .iter()
        .find(|hit| hit.id == "traversal-only")
        .unwrap();
    assert!(direct.score > traversal_only.score);
    assert_eq!(traversal_only.source, SearchSource::Traversal);
}

#[test]
fn memory_search_currentness_bias_dampens_superseded_and_annotates_replacements() {
    // Ported from `platform/daemon/src/memory-search.test.ts:1891`: stale structured
    // memories are dampened and annotated with current replacement facts.
    let conn = setup();
    insert_memory(
        &conn,
        "old",
        "Old restaurant preference",
        "agent-a",
        "private",
        None,
        false,
    );
    insert_memory(
        &conn,
        "new",
        "New restaurant preference",
        "agent-a",
        "private",
        None,
        false,
    );
    conn.execute(
        "INSERT INTO entities (id, name, entity_type, description, created_at, updated_at, agent_id)
         VALUES ('ent-food', 'Food', 'topic', 'food preferences', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 'agent-a')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
         VALUES ('asp-food', 'ent-food', 'agent-a', 'restaurant', 'restaurant', 0.9, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO entity_attributes
         (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, superseded_by, created_at, updated_at)
         VALUES
         ('attr-old', 'asp-food', 'agent-a', 'old', 'preference', 'prefers old cafe', 'prefers old cafe', 0.9, 0.9, 'superseded', 'attr-new', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'),
         ('attr-new', 'asp-food', 'agent-a', 'new', 'preference', 'prefers new bistro', 'prefers new bistro', 0.9, 0.9, 'active', NULL, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')",
        [],
    )
    .unwrap();

    let currentness = load_currentness_info(&conn, &["old", "new"], "agent-a");
    let mut scored = vec![
        ScoredHit {
            id: "old".into(),
            score: 1.0,
            source: SearchSource::Structured,
        },
        ScoredHit {
            id: "new".into(),
            score: 0.8,
            source: SearchSource::Structured,
        },
    ];
    apply_currentness_bias(&mut scored, &currentness);
    let old = scored.iter().find(|hit| hit.id == "old").unwrap();
    let new = scored.iter().find(|hit| hit.id == "new").unwrap();
    assert!(new.score > old.score);
    let annotated = annotate_currentness("Old restaurant preference", currentness.get("old"));
    assert!(annotated.contains("[Signet currentness]"));
    assert!(annotated.contains("Current replacement: prefers new bistro"));
}

#[test]
fn embedding_coverage_counts_duplicate_hashes_and_flags_stale_source_embeddings() {
    // Ported from `platform/daemon/src/embedding-coverage.test.ts:23` and `:42`:
    // duplicate content hashes are covered by one embedding, while source-linked
    // embeddings with a stale content hash are still repair candidates.
    let conn = setup();
    conn.execute(
        "INSERT INTO memories (id, content, content_hash, scope, type, agent_id, visibility, created_at, updated_at, updated_by)
         VALUES
         ('mem-a', 'same', 'hash-same', 'scope-a', 'fact', 'agent-a', 'private', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 'test'),
         ('mem-b', 'same', 'hash-same', 'scope-b', 'fact', 'agent-a', 'private', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 'test'),
         ('mem-stale', 'new', 'hash-new', 'scope-stale', 'fact', 'agent-a', 'private', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 'test')",
        [],
    )
    .expect("insert memories");
    conn.execute(
        "INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
         VALUES
         ('emb-same', 'hash-same', ?1, 3, 'memory', 'mem-a', 'same', '2026-06-01T00:00:00Z', 'agent-a'),
         ('emb-stale', 'hash-old', ?1, 3, 'memory', 'mem-stale', 'old', '2026-06-01T00:00:00Z', 'agent-a')",
        params![vector_to_blob(&[0.1_f32, 0.2, 0.3])],
    )
    .expect("insert embeddings");

    let uncovered_same_hash: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM memories m
             WHERE m.id IN ('mem-a', 'mem-b')
               AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.content_hash = m.content_hash)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(uncovered_same_hash, 0);

    let stale_id: Option<String> = conn
        .query_row(
            "SELECT m.id
             FROM memories m
             JOIN embeddings e ON e.source_type = 'memory' AND e.source_id = m.id
             WHERE m.id = 'mem-stale' AND e.content_hash <> m.content_hash",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    assert_eq!(stale_id.as_deref(), Some("mem-stale"));
}

#[test]
fn memory_search_telemetry_schema_preserves_filters_timings_and_no_hit_filtering() {
    // Ported from `platform/daemon/src/memory-search-telemetry.test.ts:66` and `:105`:
    // telemetry rows preserve query/filter/timing/result snapshots and support no-hit filters.
    let conn = setup();
    conn.execute(
        "INSERT INTO memory_search_telemetry
         (id, created_at, route, agent_id, session_key, project, query, keyword_query, filters_json,
          method, result_count, top_score, no_hits, duration_ms, timings_json, results_json, sources_json)
         VALUES (?1, '2026-06-01T00:00:00Z', 'POST /api/memory/recall', 'agent-a', 'sess-1', '/repo',
                 'what did we decide about recall qa', 'recall qa', ?2, 'hybrid', 1, 0.91, 0, 12.34, ?3, ?4, NULL)",
        params![
            "telemetry-hit",
            json!({"limit": 5, "agentId": "agent-a", "project": "/repo"}).to_string(),
            json!({"totalMs": 12.34, "stages": [{"name": "memory_fts", "durationMs": 1.2}]}).to_string(),
            json!([{"rank": 1, "id": "mem-1", "content": "manual review context"}]).to_string(),
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_search_telemetry
         (id, created_at, route, agent_id, query, filters_json, method, result_count, no_hits,
          duration_ms, timings_json, results_json)
         VALUES ('telemetry-empty', '2026-06-01T00:01:00Z', 'GET /api/memory/search', 'agent-a',
                 'nothing here', '{}', 'hybrid', 0, 1, 3.0, '{}', '[]')",
        [],
    )
    .unwrap();

    let (query, keyword, limit, duration, rank, content): (String, String, i64, f64, i64, String) = conn
        .query_row(
            "SELECT query, keyword_query,
                    json_extract(filters_json, '$.limit'), duration_ms,
                    json_extract(results_json, '$[0].rank'), json_extract(results_json, '$[0].content')
             FROM memory_search_telemetry WHERE id = 'telemetry-hit'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .unwrap();
    assert_eq!(query, "what did we decide about recall qa");
    assert_eq!(keyword, "recall qa");
    assert_eq!(limit, 5);
    assert_eq!(duration, 12.34);
    assert_eq!(rank, 1);
    assert!(content.contains("manual review"));

    let no_hit_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_search_telemetry WHERE no_hits = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(no_hit_count, 1);
}

#[test]
fn session_recall_dedupe_epochs_are_agent_scoped() {
    // Ported from `platform/daemon/src/session-recall-dedupe.test.ts:139` and `:181`:
    // repeats are scoped by session, agent, and context epoch so another agent or a
    // post-compaction epoch can recall the same item again.
    let conn = setup();
    conn.execute(
        "INSERT INTO session_recall_events
         (session_key, agent_id, context_epoch, item_kind, item_id, surface, mode, score, source)
         VALUES ('sess-1', 'agent-a', 0, 'memory', 'mem-1', 'test', 'direct', 0.9, 'hybrid')",
        [],
    )
    .unwrap();
    let duplicate = conn
        .execute(
            "INSERT OR IGNORE INTO session_recall_events
         (session_key, agent_id, context_epoch, item_kind, item_id, surface, mode, score, source)
         VALUES ('sess-1', 'agent-a', 0, 'memory', 'mem-1', 'test', 'direct', 0.9, 'hybrid')",
            [],
        )
        .unwrap();
    assert_eq!(duplicate, 0);

    conn.execute(
        "INSERT INTO session_recall_events
         (session_key, agent_id, context_epoch, item_kind, item_id, surface, mode, score, source)
         VALUES
         ('sess-1', 'agent-b', 0, 'memory', 'mem-1', 'test', 'direct', 0.9, 'hybrid'),
         ('sess-1', 'agent-a', 1, 'memory', 'mem-1', 'test', 'direct', 0.9, 'hybrid')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_context_epochs (session_key, agent_id, context_epoch, reason, source_ref)
         VALUES ('sess-1', 'agent-a', 1, 'compaction-complete', 'summary-1')",
        [],
    )
    .unwrap();

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_recall_events WHERE item_id = 'mem-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 3);
    let epoch_reason: String = conn
        .query_row(
            "SELECT reason FROM session_context_epochs
             WHERE session_key = 'sess-1' AND agent_id = 'agent-a' AND context_epoch = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(epoch_reason, "compaction-complete");
}
