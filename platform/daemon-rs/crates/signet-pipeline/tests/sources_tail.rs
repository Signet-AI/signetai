use rusqlite::{Connection, params};
use signet_core::config::EmbeddingConfig;
use signet_core::queries::embedding::{self, InsertEmbedding};
use signet_pipeline::document::chunk_content;
use signet_pipeline::embedding::from_config;
use signet_pipeline::memory_lineage::upsert_thread_head;

fn setup_conn() -> Connection {
    signet_core::db::register_vec_extension();
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::db::configure_pragmas_pub(&conn).expect("configure pragmas");
    signet_core::migrations::run(&conn).expect("run migrations");
    signet_core::db::ensure_fts_pub(&conn).expect("ensure fts");
    signet_core::db::ensure_vec_table_pub(&conn).expect("ensure vec table");
    conn
}

fn embedding_config(provider: &str) -> EmbeddingConfig {
    EmbeddingConfig {
        provider: provider.to_string(),
        model: "tail-embedding".to_string(),
        dimensions: 3,
        base_url: None,
        api_key: None,
    }
}

// Port of platform/daemon/src/embedding-fetch.test.ts:12-23 and :98-135 for
// daemon-rs provider routing. Rust exposes provider construction rather than
// Bun fetch mocking; this locks provider selection, names, dimensions, and the
// disabled/unknown-provider no-op route without performing network I/O.
#[test]
fn embedding_provider_factory_routes_configured_providers() {
    let ollama = from_config(&embedding_config("ollama"), None);
    assert_eq!(ollama.name(), "ollama");
    assert_eq!(ollama.dimensions(), 3);

    let mut openai_cfg = embedding_config("openai");
    openai_cfg.base_url = Some("http://localhost:1234/v1".to_string());
    let openai = from_config(&openai_cfg, None);
    assert_eq!(openai.name(), "openai");
    assert_eq!(openai.dimensions(), 3);

    let none = from_config(&embedding_config("none"), None);
    assert_eq!(none.name(), "none");
    assert_eq!(none.dimensions(), 3);

    let unknown = from_config(&embedding_config("native"), None);
    assert_eq!(unknown.name(), "none");
    assert_eq!(unknown.dimensions(), 3);
}

// Port of platform/daemon/src/obsidian-source-embeddings.test.ts:53-104 and
// :198-264 for feasible Rust pieces. daemon-rs does not expose the TS
// Obsidian heading-aware indexer, but it does expose the shared chunker and
// source-chunk embedding CRUD/purge primitives used by source indexing.
#[test]
fn source_chunking_and_exact_purge_preserve_utf8_overlap_and_sibling_rows() {
    let chunks = chunk_content("alpha βeta gamma delta", 9, 3, 10);
    assert!(chunks.len() >= 3);
    assert_eq!(chunks[0].index, 0);
    assert!(chunks[0].text.is_char_boundary(chunks[0].text.len()));
    assert!(chunks.iter().all(|chunk| !chunk.text.is_empty()));
    assert!(chunks.windows(2).all(|pair| pair[1].start > pair[0].start));

    let conn = setup_conn();
    let now = "2026-06-20T00:00:00Z";
    embedding::upsert(
        &conn,
        &InsertEmbedding {
            id: "source-chunk-note-a",
            content_hash: "hash-note-a",
            vector: &[1.0, 0.0, 0.0],
            source_type: "source_chunk",
            source_id: "obsidian:test-vault:literature/note_%A.md#source:1-3:0",
            chunk_text: "source_path: /vault/literature/note_%A.md\nheading: Source\nlines: 1-3\nchunk a",
            now,
            agent_id: Some("agent-a"),
        },
    )
    .expect("insert source chunk a");
    embedding::upsert(
        &conn,
        &InsertEmbedding {
            id: "source-chunk-note-b",
            content_hash: "hash-note-b",
            vector: &[0.0, 1.0, 0.0],
            source_type: "source_chunk",
            source_id: "obsidian:test-vault:literature/note_XA.md#source:1-3:0",
            chunk_text: "source_path: /vault/literature/note_XA.md\nheading: Source\nlines: 1-3\nchunk b",
            now,
            agent_id: Some("agent-a"),
        },
    )
    .expect("insert source chunk b");

    let purged = embedding::delete_by_source(
        &conn,
        "source_chunk",
        "obsidian:test-vault:literature/note_%A.md#source:1-3:0",
        None,
    )
    .expect("purge exact source chunk");
    assert_eq!(purged, 1);

    let remaining: Vec<String> = conn
        .prepare("SELECT source_id FROM embeddings WHERE source_type = 'source_chunk' ORDER BY source_id")
        .and_then(|mut stmt| {
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            Ok(rows.filter_map(|row| row.ok()).collect::<Vec<_>>())
        })
        .expect("read remaining source chunks");
    assert_eq!(
        remaining,
        vec!["obsidian:test-vault:literature/note_XA.md#source:1-3:0".to_string()]
    );
}

// Port of platform/daemon/src/subagent-context.test.ts:30-65. The Rust route
// function lives outside this crate, so this integration test locks the SQL
// fallback contract the TS regression fixed: score LIKE args first, then
// agent/session/project filters, then WHERE LIKE args, then limit.
#[test]
fn transcript_fallback_like_query_preserves_session_project_parameter_order() {
    let conn = setup_conn();
    conn.execute(
        "INSERT INTO session_transcripts
         (agent_id, session_key, project, harness, content, created_at)
         VALUES (?1, ?2, ?3, 'opencode', ?4, ?5)",
        params![
            "default",
            "parent-session",
            "/repo",
            "Parent session decided the delegated subagent should inherit the continuity note.",
            "2026-05-06T10:00:00Z"
        ],
    )
    .expect("insert parent transcript");
    conn.execute(
        "INSERT INTO session_transcripts
         (agent_id, session_key, project, harness, content, created_at)
         VALUES (?1, ?2, ?3, 'opencode', ?4, ?5)",
        params![
            "default",
            "other-session",
            "/elsewhere",
            "Parent session decided the delegated subagent should inherit the continuity note.",
            "2026-05-06T10:02:00Z"
        ],
    )
    .expect("insert other transcript");

    let sql = "SELECT st.session_key, st.project,
                  CASE WHEN LOWER(st.content) LIKE ? THEN 1 ELSE 0 END
                + CASE WHEN LOWER(st.content) LIKE ? THEN 1 ELSE 0 END AS rank
               FROM session_transcripts st
               WHERE st.agent_id = ?
                 AND st.session_key != ?
                 AND st.project = ?
                 AND (LOWER(st.content) LIKE ? OR LOWER(st.content) LIKE ?)
               ORDER BY rank DESC, st.created_at DESC LIMIT ?";
    let rows: Vec<(String, Option<String>, i64)> = conn
        .prepare(sql)
        .and_then(|mut stmt| {
            let rows = stmt.query_map(
                params![
                    "%delegated%",
                    "%continuity%",
                    "default",
                    "child-session",
                    "/repo",
                    "%delegated%",
                    "%continuity%",
                    5
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            Ok(rows.filter_map(|row| row.ok()).collect::<Vec<_>>())
        })
        .expect("run fallback transcript query");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "parent-session");
    assert_eq!(rows[0].1.as_deref(), Some("/repo"));
    assert_eq!(rows[0].2, 2);
}

// Port of platform/daemon/src/thread-heads.test.ts:58-102 for feasible Rust
// behavior. daemon-rs accepts caller-derived keys/labels, so this covers
// scoped upsert semantics, newer-write wins, older-write ignored, and agent
// isolation.
#[test]
fn thread_head_upsert_keeps_agent_scope_label_and_newest_state() {
    let conn = setup_conn();
    upsert_thread_head(
        &conn,
        "default",
        "project:/tmp/proj|source:lane-a|harness:test",
        "project:/tmp/proj#source:lane-a#harness:test",
        Some("/tmp/proj"),
        Some("sess-1"),
        "summary",
        Some("lane-a"),
        Some("test"),
        "node-1",
        "2026-03-25T10:00:00.000Z",
        "first sample",
    )
    .expect("insert first thread head");
    upsert_thread_head(
        &conn,
        "default",
        "project:/tmp/proj|source:lane-a|harness:test",
        "older label should not win",
        Some("/tmp/proj"),
        Some("sess-old"),
        "summary",
        Some("lane-a"),
        Some("test"),
        "node-old",
        "2026-03-25T09:00:00.000Z",
        "old sample",
    )
    .expect("ignore older thread head");
    upsert_thread_head(
        &conn,
        "default",
        "project:/tmp/proj|source:lane-a|harness:test",
        "project:/tmp/proj#source:lane-a#harness:test",
        Some("/tmp/proj"),
        Some("sess-2"),
        "compaction",
        Some("lane-a"),
        Some("test"),
        "node-2",
        "2026-03-25T11:00:00.000Z",
        "new sample that should win",
    )
    .expect("update newer thread head");
    upsert_thread_head(
        &conn,
        "agent-b",
        "project:/tmp/proj|source:lane-a|harness:test",
        "agent b label",
        Some("/tmp/proj"),
        Some("sess-b"),
        "summary",
        Some("lane-a"),
        Some("test"),
        "node-b",
        "2026-03-25T12:00:00.000Z",
        "agent b sample",
    )
    .expect("insert agent b thread head");

    let row: (String, String, String, String, String, String) = conn
        .query_row(
            "SELECT label, node_id, latest_at, sample, source_type, session_key
             FROM memory_thread_heads
             WHERE agent_id = 'default' AND thread_key = 'project:/tmp/proj|source:lane-a|harness:test'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .expect("read default thread head");
    assert_eq!(row.0, "project:/tmp/proj#source:lane-a#harness:test");
    assert_eq!(row.1, "node-2");
    assert_eq!(row.2, "2026-03-25T11:00:00.000Z");
    assert!(row.3.contains("new sample"));
    assert_eq!(row.4, "compaction");
    assert_eq!(row.5, "sess-2");

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_thread_heads WHERE thread_key = 'project:/tmp/proj|source:lane-a|harness:test'",
            [],
            |row| row.get(0),
        )
        .expect("count scoped thread heads");
    assert_eq!(count, 2);
}

// platform/daemon/src/embedding-tracker.test.ts:11 covers embedding retry
// backoff/suppression/content-hash invalidation. No Rust embedding tracker
// module exists.
#[test]
#[ignore = "gap: no Rust embedding retry tracker module"]
fn gap_embedding_tracker_missing() {}

// platform/daemon/src/native-memory-sources.test.ts:18 covers native
// Codex/Claude memory source discovery, symlink rejection, dedupe, and purge.
// daemon-rs has no native memory source discovery equivalent.
#[test]
#[ignore = "gap: no Rust native memory source discovery module"]
fn gap_native_memory_sources_missing() {}

// platform/daemon/src/source-index-progress.test.ts:10 covers the TS delayed
// source-index runner completed-job guard. Rust source_index_job/progress route
// helpers are private daemon route details, not exposed to signet-pipeline.
#[test]
#[ignore = "gap: Rust source index progress helpers are private/not exposed"]
fn gap_source_index_progress_private() {}

// platform/daemon/src/discord-source-fetch.test.ts:15 and
// discord-source-provider.test.ts:15 depend on live Discord REST/gateway/cache
// provider behavior. There is no daemon-rs live Discord REST client equivalent.
#[test]
#[ignore = "skip: live Discord REST/gateway source provider has no Rust equivalent"]
fn skip_discord_live_rest_sources() {}

// platform/daemon/src/github-source-fetch.test.ts:19 and
// github-source-provider.test.ts:12 depend on live GitHub API pagination,
// issues/PR/discussion fetches, and provider indexing. There is no daemon-rs
// live GitHub API source provider equivalent.
#[test]
#[ignore = "skip: live GitHub API source provider has no Rust equivalent"]
fn skip_github_live_api_sources() {}

// platform/daemon/src/memory-ingest-filter.test.ts:12 covers watcher filename
// exclusion matchers. The relevant daemon-rs watcher helpers are private to
// signet-daemon and not available from signet-pipeline integration tests.
#[test]
#[ignore = "gap: Rust watcher ingest filename matcher is private/not exposed"]
fn gap_memory_ingest_filter_private() {}

// platform/daemon/src/temporal-expand.test.ts:13 covers expandTemporalNode.
// Rust has lower-level temporal candidate search in signet-core, but no
// exposed temporal node expansion API equivalent.
#[test]
#[ignore = "gap: no exposed Rust temporal node expansion API"]
fn gap_temporal_expand_api_missing() {}

// platform/daemon/src/path-feedback.test.ts:110 covers path feedback stats,
// aspect/dependency propagation, and session/agent filtering. No Rust path
// feedback module equivalent is exposed.
#[test]
#[ignore = "gap: no Rust path feedback module equivalent"]
fn gap_path_feedback_missing() {}
