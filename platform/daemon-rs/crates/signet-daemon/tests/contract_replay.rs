//! Contract replay integration tests.
//!
//! Starts a real daemon on an ephemeral port, sends requests matching the
//! contract fixtures, and validates responses against parity rules.
//!
//! These tests require a built daemon binary, so they are ignored by default.
//! To run:
//!   cargo build -p signet-daemon
//!   cargo test -p signet-daemon --test contract_replay -- --ignored

use std::io::{Cursor, Read, Write};
use std::net::TcpListener;
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use rusqlite::OptionalExtension;
use serde_json::json;
use sha2::Sha256;
use signet_core::db::register_vec_extension;

type HmacSha256 = Hmac<Sha256>;
const AUTH_SECRET: &[u8] = b"contract-replay-auth-secret-32bytes";
static TEST_SERVER_START_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Debug)]
struct SkillGraphRow {
    name: String,
    entity_type: String,
    agent_id: String,
    description: String,
    source: String,
    role: String,
    triggers: Option<String>,
    tags: Option<String>,
    enriched: i64,
    fs_path: String,
    uninstalled_at: Option<String>,
}

#[derive(Debug)]
struct SkillEmbeddingRow {
    content_hash: String,
    dimensions: i64,
    chunk_text: String,
    vec_rows: i64,
}

#[derive(Debug)]
struct SkillExtractionRows {
    source_name: String,
    target_name: String,
    relation_type: String,
}

struct TestServer {
    #[allow(dead_code)] // kept for debugging
    port: u16,
    pid: u32,
    base: String,
    client: reqwest::Client,
    _tmpdir: tempfile::TempDir,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if self.pid > 0 {
            #[cfg(unix)]
            unsafe {
                libc::kill(self.pid as i32, libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &self.pid.to_string(), "/F"])
                    .output();
            }
        }
    }
}

impl TestServer {
    /// Start a daemon on an ephemeral port with a fresh DB.
    async fn start() -> Self {
        Self::start_with_auth_mode(None).await
    }

    /// Start a daemon with team auth enabled and a fixed secret for scoped-token replay.
    async fn start_team_auth() -> Self {
        Self::start_with_auth_mode(Some("team")).await
    }

    async fn start_team_auth_with_agent_yaml(yaml: &str) -> Self {
        Self::start_with_agent_yaml(Some("team"), yaml).await
    }

    async fn start_with_auth_mode(auth_mode: Option<&str>) -> Self {
        let auth_yaml = auth_mode
            .map(|mode| format!("auth:\n  method: token\n  mode: {mode}\n"))
            .unwrap_or_default();
        let yaml = format!("agent:\n  name: test-agent\n  version: 1\n{}", auth_yaml);
        Self::start_with_agent_yaml(auth_mode, &yaml).await
    }

    async fn start_with_agent_yaml(auth_mode: Option<&str>, yaml: &str) -> Self {
        Self::start_with_agent_yaml_and_files(auth_mode, yaml, &[]).await
    }

    async fn start_with_agent_yaml_and_files(
        auth_mode: Option<&str>,
        yaml: &str,
        files: &[(&str, &str)],
    ) -> Self {
        Self::start_with_agent_yaml_files_and_setup(auth_mode, yaml, files, |_| {}).await
    }

    async fn start_with_agent_yaml_files_and_setup<F>(
        auth_mode: Option<&str>,
        yaml: &str,
        files: &[(&str, &str)],
        setup: F,
    ) -> Self
    where
        F: FnOnce(&std::path::Path),
    {
        let _start_guard = test_server_start_lock().lock().await;
        let tmpdir = tempfile::tempdir().expect("failed to create tmpdir");
        let port = ephemeral_port();
        let base = format!("http://127.0.0.1:{port}");

        // Set env for the daemon
        let signet_path = tmpdir.path().to_str().unwrap().to_string();
        let memory_dir = tmpdir.path().join("memory");
        std::fs::create_dir_all(&memory_dir).unwrap();
        let daemon_dir = tmpdir.path().join(".daemon/logs");
        std::fs::create_dir_all(&daemon_dir).unwrap();
        if auth_mode.is_some() {
            std::fs::write(tmpdir.path().join(".daemon/auth-secret"), AUTH_SECRET).unwrap();
        }
        let (fake_bw, fake_op, fake_bin_dir) = write_fake_provider_bins(tmpdir.path());
        let path_with_fakes = match std::env::var_os("PATH") {
            Some(path) => {
                let mut paths = vec![fake_bin_dir];
                paths.extend(std::env::split_paths(&path));
                std::env::join_paths(paths).expect("join fake binary PATH")
            }
            None => fake_bin_dir.into_os_string(),
        };

        std::fs::write(tmpdir.path().join("agent.yaml"), yaml).unwrap();
        for (relative, content) in files {
            let path = tmpdir.path().join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(path, content).unwrap();
        }
        setup(tmpdir.path());

        // Spawn daemon in background
        let port_str = port.to_string();
        let child = tokio::process::Command::new(daemon_binary())
            .env("SIGNET_PATH", &signet_path)
            .env("SIGNET_PORT", &port_str)
            .env("SIGNET_HOST", "127.0.0.1")
            .env("SIGNET_BIND", "127.0.0.1")
            .env("CODEX_HOME", tmpdir.path().join("codex"))
            .env(
                "SIGNET_UPDATE_MOCK_GITHUB_VERSION",
                env!("CARGO_PKG_VERSION"),
            )
            .env("SIGNET_UPDATE_MOCK_RUN_RESULT", "success")
            .env("SIGNET_MEMORY_IMPORT_POLL_MS", "200")
            .env("SIGNET_BW_BIN", fake_bw)
            .env("SIGNET_OP_BIN", fake_op)
            .env("PATH", path_with_fakes)
            .env("RUST_LOG", "warn")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("failed to spawn daemon");

        // Store child PID for cleanup
        let pid = child.id().unwrap_or(0);

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();

        // Wait for daemon to be ready
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if tokio::time::Instant::now() > deadline {
                panic!("daemon did not start within 10s");
            }
            if let Ok(resp) = client.get(format!("{base}/health")).send().await {
                if resp.status().is_success() {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let test_server = Self {
            port,
            pid,
            base,
            client,
            _tmpdir: tmpdir,
        };

        test_server
    }

    fn db_path(&self) -> std::path::PathBuf {
        self._tmpdir.path().join("memory/memories.db")
    }

    fn seed_recall_scope_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
             VALUES
               ('default', 'default', 'isolated', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
               ('agent-b', 'agent-b', 'isolated', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .expect("seed recall agents");
        conn.execute(
            "INSERT INTO memories
             (id, type, content, content_hash, confidence, importance, tags, who, project,
              created_at, updated_at, updated_by, is_deleted, pinned, version, agent_id,
              visibility, scope)
             VALUES
             ('mem-recall-visible', 'fact',
              'Recall parity visible unscoped memory for default agent.',
              'recall-visible-hash', 1.0, 0.9, 'recall,parity', 'contract',
              '/workspace/default', '2026-01-01T00:00:00Z',
              '2026-01-01T00:00:00Z', 'contract', 0, 0, 1, 'default',
              'global', NULL),
             ('mem-recall-scoped', 'fact',
              'Recall parity scoped memory must stay hidden by default.',
              'recall-scoped-hash', 1.0, 0.95, 'recall,parity', 'contract',
              '/workspace/default', '2026-01-01T00:00:00Z',
              '2026-01-01T00:00:00Z', 'contract', 0, 0, 1, 'default',
              'private', 'private-a'),
             ('mem-recall-other-agent', 'fact',
              'Recall parity other agent memory must stay hidden by default.',
              'recall-other-agent-hash', 1.0, 0.97, 'recall,parity', 'contract',
              '/workspace/other', '2026-01-01T00:00:00Z',
              '2026-01-01T00:00:00Z', 'contract', 0, 0, 1, 'agent-b',
              'global', NULL)",
            [],
        )
        .expect("seed scoped recall memories");
    }

    fn seed_memory_maintenance_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        conn.execute(
            "INSERT INTO memories
             (id, type, content, content_hash, confidence, importance, tags, who, project,
              created_at, updated_at, updated_by, is_deleted, version, agent_id)
             VALUES
             (?1, 'fact', ?2, ?3, 1.0, 0.5, 'rust,parity', 'contract-replay', 'signet',
              ?4, ?4, 'contract-replay', 0, 1, 'default')",
            rusqlite::params![
                "mem-maintenance-replay",
                "Memory maintenance replay starts here.",
                "memory-maintenance-replay-hash",
                now,
            ],
        )
        .expect("seed maintenance memory");
        conn.execute(
            "INSERT INTO memory_history
             (id, memory_id, event, old_content, new_content, changed_by, reason,
              metadata, created_at, session_id)
             VALUES
             ('history-maintenance-review', 'mem-maintenance-replay',
              'REVIEW_NEEDED', NULL, 'Memory maintenance replay starts here.',
              'contract-replay', 'needs review', '{\"source\":\"contract\"}', ?1,
              'session-maintenance')",
            rusqlite::params![now],
        )
        .expect("seed review queue history");
        conn.execute(
            "INSERT INTO memory_jobs
             (id, memory_id, document_id, job_type, status, attempts, max_attempts,
              error, created_at, updated_at)
             VALUES
             ('job-maintenance-replay', 'mem-maintenance-replay', NULL,
              'extract', 'failed', 2, 3, 'provider unavailable', ?1, ?1)",
            rusqlite::params![now],
        )
        .expect("seed memory job");
    }

    fn seed_memory_history_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute(
            "INSERT INTO memories
             (id, type, content, content_hash, confidence, importance, tags, who, project,
              created_at, updated_at, updated_by, is_deleted, version, agent_id)
             VALUES
             ('mem-history-replay', 'fact', 'History replay target.', 'history-replay-hash',
              1.0, 0.5, 'rust,parity', 'contract-replay', 'signet',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
              'contract-replay', 1, 3, 'default')",
            [],
        )
        .expect("seed history memory");
        conn.execute(
            "INSERT INTO memory_history
             (id, memory_id, event, old_content, new_content, changed_by, reason,
              metadata, created_at, actor_type, session_id, request_id)
             VALUES
             ('history-replay-updated', 'mem-history-replay', 'updated',
              'History replay target.', 'History replay target edited.',
              'contract-replay', 'history test edit', '{\"source\":\"contract\"}',
              '2026-01-01T00:00:01.000Z', 'agent', 'session-history', 'request-1'),
             ('history-replay-deleted', 'mem-history-replay', 'deleted',
              'History replay target edited.', NULL,
              'contract-replay', 'history test delete', 'plain metadata',
              '2026-01-01T00:00:02.000Z', NULL, NULL, NULL)",
            [],
        )
        .expect("seed history rows");
    }

    fn seed_memory_safety_history_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO memories
             (id, type, content, content_hash, confidence, importance, tags, who, project,
              created_at, updated_at, updated_by, is_deleted, version, agent_id)
             VALUES
             ('mem-memory-safety-replay', 'fact', 'Memory safety replay target.',
              'memory-safety-replay-hash', 1.0, 0.5, 'rust,parity',
              'contract-replay', 'signet', ?1, ?1, 'contract-replay', 0, 1,
              'default')",
            [&now],
        )
        .expect("seed memory safety memory");
        for index in 0..6 {
            conn.execute(
                "INSERT INTO memory_history
                 (id, memory_id, event, old_content, new_content, changed_by,
                  reason, metadata, created_at)
                 VALUES (?1, 'mem-memory-safety-replay', 'recovered', NULL,
                  'Memory safety replay target.', 'contract-replay',
                  'memory safety replay recovery', '{}', ?2)",
                rusqlite::params![format!("history-memory-safety-recovered-{index}"), now],
            )
            .expect("seed recovered history");
        }
        conn.execute(
            "INSERT INTO memory_history
             (id, memory_id, event, old_content, new_content, changed_by,
              reason, metadata, created_at)
             VALUES ('history-memory-safety-deleted', 'mem-memory-safety-replay',
              'deleted', 'Memory safety replay target.', NULL,
              'contract-replay', 'memory safety replay delete', '{}', ?1)",
            [&now],
        )
        .expect("seed deleted history");
    }

    fn seed_memory_delete_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute(
            "INSERT INTO memories
             (id, type, content, content_hash, confidence, importance, tags, who, project,
              created_at, updated_at, updated_by, is_deleted, pinned, version, agent_id)
             VALUES
             ('mem-delete-replay', 'fact', 'Delete replay target.',
              'delete-replay-hash', 1.0, 0.5, 'rust,parity', 'contract-replay',
              'signet', '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z', 'contract-replay', 0, 0, 1,
              'default'),
             ('mem-delete-pinned-replay', 'fact', 'Pinned delete replay target.',
              'delete-pinned-replay-hash', 1.0, 0.5, 'rust,parity',
              'contract-replay', 'signet', '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z', 'contract-replay', 0, 1, 1,
              'default')",
            [],
        )
        .expect("seed delete memories");
    }

    fn seed_document_delete_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute(
            "INSERT INTO documents
             (id, source_url, source_type, content_type, content_hash, title, raw_content,
              status, error, connector_id, chunk_count, memory_count, metadata_json,
              created_at, updated_at, completed_at)
             VALUES
             ('doc-delete-replay', 'file:///replay.md', 'markdown', 'text/markdown',
              'doc-delete-hash', 'Delete replay', '# Delete replay', 'indexed', NULL,
              'connector-delete', 2, 2, '{}',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z')",
            [],
        )
        .expect("seed delete document");
        conn.execute(
            "INSERT INTO memories
             (id, type, content, content_hash, confidence, importance, tags, who, project,
              source_id, source_type, created_at, updated_at, updated_by, is_deleted,
              deleted_at, version, agent_id)
             VALUES
             ('mem-doc-delete-active', 'fact', 'Active linked document memory.',
              'doc-delete-active-hash', 1.0, 0.5, 'doc', 'contract-replay', 'signet',
              'doc-delete-replay', 'document',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
              'contract-replay', 0, NULL, 1, 'default'),
             ('mem-doc-delete-already', 'fact', 'Already deleted linked document memory.',
              'doc-delete-already-hash', 1.0, 0.5, 'doc', 'contract-replay', 'signet',
              'doc-delete-replay', 'document',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
              'contract-replay', 1, '2026-01-01T00:00:00.000Z', 4, 'default')",
            [],
        )
        .expect("seed delete memories");
        conn.execute(
            "INSERT INTO document_memories (document_id, memory_id, chunk_index)
             VALUES
             ('doc-delete-replay', 'mem-doc-delete-active', 0),
             ('doc-delete-replay', 'mem-doc-delete-already', 1)",
            [],
        )
        .expect("seed document memory links");
    }

    fn seed_deduplicate_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute("DROP INDEX IF EXISTS idx_memories_content_hash_unique", [])
            .expect("drop unique content hash index for legacy duplicate fixture");
        let now = chrono::Utc::now().to_rfc3339();
        let rows = [
            (
                "mem-dedup-keeper",
                "Duplicate replay content.",
                "dedup-replay-hash",
                "alpha",
                0.9_f64,
                4_i64,
                "default",
            ),
            (
                "mem-dedup-loser",
                "Duplicate replay content.",
                "dedup-replay-hash",
                "beta",
                0.2_f64,
                0_i64,
                "default",
            ),
            (
                "mem-dedup-other-agent",
                "Duplicate replay content.",
                "dedup-replay-hash",
                "gamma",
                0.8_f64,
                5_i64,
                "other-agent",
            ),
        ];
        for row in rows {
            conn.execute(
                "INSERT INTO memories
                 (id, type, content, normalized_content, content_hash, confidence, importance,
                  tags, who, project, created_at, updated_at, updated_by, is_deleted, pinned,
                  manual_override, access_count, update_count, version, agent_id, visibility)
                 VALUES
                 (?1, 'fact', ?2, ?2, ?3, 1.0, ?5, ?4, 'contract-replay', 'signet',
                  ?6, ?6, 'contract-replay', 0, 0, 0, ?7, 0, 1, ?8, 'global')",
                rusqlite::params![row.0, row.1, row.2, row.3, row.4, now, row.5, row.6],
            )
            .expect("seed dedupe memory");
        }
    }

    fn seed_mcp_analytics_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let rows = [
            (
                "inv-mcp-1",
                "srv-a",
                "search",
                "default",
                "mcp",
                100,
                1,
                None,
            ),
            (
                "inv-mcp-2",
                "srv-a",
                "search",
                "default",
                "agent",
                200,
                1,
                None,
            ),
            (
                "inv-mcp-3",
                "srv-a",
                "create",
                "default",
                "mcp",
                300,
                0,
                Some("timeout"),
            ),
            ("inv-mcp-4", "srv-b", "list", "default", "cli", 50, 1, None),
            (
                "inv-mcp-other",
                "srv-a",
                "search",
                "agent-b",
                "mcp",
                500,
                1,
                None,
            ),
        ];
        for row in rows {
            conn.execute(
                "INSERT INTO mcp_invocations
                 (id, server_id, tool_name, agent_id, source, latency_ms, success, error_text, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, now],
            )
            .expect("seed MCP invocation");
        }
    }

    fn seed_reflection_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO daily_reflections
             (id, agent_id, date, summary, patterns, question, memory_ids, summary_ids, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', '[]', ?7)",
            rusqlite::params![
                "reflection-answer-replay",
                "agent-r",
                "2026-06-02",
                "Reflection replay summary",
                "[\"parity\"]",
                "What did the replay prove?",
                now,
            ],
        )
        .expect("seed reflection");
    }

    fn seed_knowledge_expand_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let now = "2026-01-01T00:00:00Z";
        conn.execute_batch(
            "INSERT INTO memories (id, type, content, confidence, importance, tags, who, project, created_at, updated_at, updated_by)
             VALUES ('mem-signet-context', 'fact', 'Signet has portable AI memory with source-backed provenance.', 1.0, 0.9, 'signet', 'test', 'signet', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'contract-replay');
             INSERT INTO memories (id, type, content, confidence, importance, tags, who, project, created_at, updated_at, updated_by, agent_id)
             VALUES ('mem-other-agent-signet', 'fact', 'Other agent private Signet context must not leak.', 1.0, 1.0, 'signet', 'test', 'signet', '2026-01-01T00:00:01Z', '2026-01-01T00:00:01Z', 'contract-replay', 'other-agent');
             INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
             VALUES ('entity-signet', 'Signet', 'signet', 'project', 'Portable AI memory and identity substrate', 'default', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
             VALUES ('entity-provenance', 'Provenance', 'provenance', 'concept', 'Source-backed evidence tracking', 'default', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
             VALUES ('entity-percent', '%', '%', 'concept', 'Literal wildcard entity', 'default', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES ('mem-signet-context', 'entity-signet');
             INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES ('mem-other-agent-signet', 'entity-signet');
             INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
             VALUES ('aspect-signet-identity', 'entity-signet', 'default', 'identity', 'identity', 0.95, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
             VALUES ('aspect-signet-percent', 'entity-signet', 'default', 'percent %', 'percent %', 0.90, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             INSERT INTO entity_attributes (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
             VALUES ('attr-signet-portable', 'aspect-signet-identity', 'default', 'mem-signet-context', 'attribute', 'Signet preserves portable AI identity with source-backed provenance.', 'signet preserves portable ai identity with source-backed provenance', 0.92, 0.91, 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             INSERT INTO entity_attributes (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
             VALUES ('attr-signet-percent', 'aspect-signet-percent', 'default', 'mem-signet-context', 'attribute', 'Signet has a literal percent aspect filter fixture.', 'signet has a literal percent aspect filter fixture', 0.90, 0.90, 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             INSERT INTO entity_dependencies (id, source_entity_id, target_entity_id, agent_id, aspect_id, dependency_type, strength, reason, created_at, updated_at)
             VALUES ('dep-signet-provenance', 'entity-signet', 'entity-provenance', 'default', 'aspect-signet-identity', 'depends_on', 0.83, 'Identity recall depends on provenance evidence.', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');"
        ).expect("seed graph fixture");
        conn.execute(
            "INSERT INTO session_summaries (id, project, depth, kind, content, token_count, earliest_at, latest_at, session_key, harness, agent_id, created_at, source_type)
             VALUES (?1, ?2, 0, 'session', ?3, 12, ?4, ?4, ?5, 'contract-replay', 'default', ?4, 'summary')",
            rusqlite::params![
                "summary-signet",
                "signet",
                "We discussed Signet graph expansion and provenance-aware context.",
                now,
                "session-signet-expand",
            ],
        ).expect("seed session summary");
    }

    fn seed_knowledge_navigation_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute_batch(
            r#"INSERT INTO entities
               (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
               VALUES
               ('entity-nicholai', 'Nicholai', 'nicholai', 'person', 'default', 10,
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z');

               INSERT INTO entity_aspects
               (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
               VALUES
               ('aspect-food', 'entity-nicholai', 'default', 'food', 'food', 0.8,
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z');

               INSERT INTO entity_attributes
               (id, aspect_id, agent_id, kind, content, normalized_content,
                group_key, claim_key, confidence, importance, status, created_at, updated_at)
               VALUES
               ('attr-fav-old', 'aspect-food', 'default', 'attribute',
                'Nicholai used to like Sushi Den.', 'nicholai used to like sushi den.',
                'restaurants', 'favorite_restaurant', 0.9, 0.7, 'superseded',
                '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
               ('attr-fav-new', 'aspect-food', 'default', 'attribute',
                'Nicholai currently prefers Temaki Den.', 'nicholai currently prefers temaki den.',
                'restaurants', 'favorite_restaurant', 0.9, 0.7, 'active',
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'),
               ('attr-count', 'aspect-food', 'default', 'attribute',
                'Nicholai has tried four Korean restaurants.', 'nicholai has tried four korean restaurants.',
                'restaurants', 'korean_restaurants_tried_count', 0.9, 0.7, 'active',
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'),
               ('attr-allergy', 'aspect-food', 'default', 'attribute',
                'Nicholai has no known shellfish allergy.', 'nicholai has no known shellfish allergy.',
                'dietary_constraints', 'shellfish_allergy', 0.9, 0.7, 'active',
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z');"#,
        )
        .expect("seed knowledge navigation fixture");
    }

    fn seed_ontology_evidence_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute_batch(
            r#"INSERT INTO memories
               (id, type, content, confidence, importance, source_id, source_type,
                source_path, tags, who, project, created_at, updated_at, updated_by,
                agent_id)
               VALUES
               ('mem-ontology-evidence', 'fact',
                'Memory evidence says Signet claim evidence resolves source provenance.',
                1.0, 0.9, 'memory-source-1', 'manual',
                '/sources/memory-evidence.md', 'ontology', 'contract-replay',
                'signet', '2026-01-02T00:00:00.000Z',
                '2026-01-02T00:00:00.000Z', 'contract-replay', 'default');

               INSERT INTO memory_artifacts
               (agent_id, source_path, source_sha256, source_kind, session_id,
                session_key, session_token, project, harness, captured_at,
                source_node_id, content, updated_at, source_id, source_root)
               VALUES
               ('default', '/sources/ontology-evidence.md', 'sha-ontology-evidence',
                'obsidian', 'session-ontology-evidence', 'session-ontology-evidence',
                'token-ontology-evidence', 'signet', 'contract-replay',
                '2026-01-02T00:00:00.000Z', 'artifact-node-1',
                'Artifact evidence explains the seeded ontology claim and link.',
                '2026-01-02T00:00:00.000Z', 'artifact-node-1', '/sources');

               INSERT INTO ontology_proposals
               (id, agent_id, operation, status, payload, confidence, rationale,
                evidence, source_kind, source_id, source_path, source_root,
                created_by, created_at, updated_at)
               VALUES
               ('proposal-ontology-evidence', 'default', 'upsert_attribute',
                'applied', '{"entityName":"Signet"}', 0.91,
                'Proposal rationale for ontology evidence replay.',
                '[{"source_kind":"transcript","session_key":"session-ontology-evidence","quote":"Transcript quote evidence."}]',
                'manual', 'proposal-source-1', '/sources/proposal.md', '/sources',
                'contract-replay', '2026-01-02T00:00:00.000Z',
                '2026-01-02T00:00:00.000Z');

               INSERT INTO entities
               (id, name, canonical_name, entity_type, agent_id, mentions, status,
                created_at, updated_at)
               VALUES
               ('entity-ontology-signet', 'Signet Evidence', 'signet evidence',
                'project', 'default', 4, 'active',
                '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
               ('entity-ontology-provenance', 'Provenance Evidence',
                'provenance evidence', 'concept', 'default', 2, 'active',
                '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

               INSERT INTO entity_aspects
               (id, entity_id, agent_id, name, canonical_name, weight, status,
                created_at, updated_at)
               VALUES
               ('aspect-ontology-evidence', 'entity-ontology-signet', 'default',
                'source truth', 'source truth', 0.9, 'active',
                '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

               INSERT INTO entity_attributes
               (id, aspect_id, agent_id, memory_id, kind, content,
                normalized_content, group_key, claim_key, confidence, importance,
                status, source_kind, source_id, source_path, source_root,
                proposal_id, proposal_evidence, version, version_root_id,
                created_at, updated_at)
               VALUES
               ('attr-ontology-evidence', 'aspect-ontology-evidence', 'default',
                'mem-ontology-evidence', 'attribute',
                'Signet claim evidence resolves source-backed provenance.',
                'signet claim evidence resolves source-backed provenance.',
                'source_truth', 'evidence_claim', 0.93, 0.88, 'active',
                'obsidian', 'artifact-node-1', '/sources/ontology-evidence.md',
                '/sources', 'proposal-ontology-evidence',
                '[{"source_kind":"manual","source_id":"inline-ref","quote":"Inline quote evidence."}]',
                1, 'attr-ontology-evidence',
                '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

               INSERT INTO entity_dependencies
               (id, source_entity_id, target_entity_id, agent_id, aspect_id,
                dependency_type, strength, confidence, reason, status,
                source_kind, source_id, source_path, source_root, proposal_id,
                proposal_evidence, created_at, updated_at)
               VALUES
               ('dep-ontology-evidence', 'entity-ontology-signet',
                'entity-ontology-provenance', 'default',
                'aspect-ontology-evidence', 'supports_claim', 0.84, 0.87,
                'Evidence links Signet to provenance.', 'active', 'obsidian',
                'artifact-node-1', '/sources/ontology-evidence.md', '/sources',
                'proposal-ontology-evidence',
                '[{"source_kind":"manual","source_id":"link-inline","quote":"Link quote evidence."}]',
                '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');"#,
        )
        .expect("seed ontology evidence fixture");
    }

    fn seed_ontology_consolidation_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute_batch(
            r#"INSERT INTO ontology_proposals
               (id, agent_id, operation, status, payload, confidence, rationale,
                evidence, created_by, created_at, updated_at)
               VALUES
               ('proposal-consolidate-pending-a', 'default', 'add_claim_value',
                'pending',
                '{"entity":"Signet","aspect":"architecture","claim_key":"proposal_loop","value":"A"}',
                0.8, 'Pending proposal A.', '[]', 'contract-replay',
                '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
               ('proposal-consolidate-pending-b', 'default', 'add_claim_value',
                'pending',
                '{"entity":"Signet","aspect":"architecture","claim_key":"proposal_loop","value":"B"}',
                0.7, 'Pending proposal B.', '[]', 'contract-replay',
                '2026-01-03T00:00:01.000Z', '2026-01-03T00:00:01.000Z'),
               ('proposal-consolidate-applied', 'default', 'create_entity',
                'applied', '{"name":"Already Applied"}', 0.9,
                'Applied proposal.', '[]', 'contract-replay',
                '2026-01-03T00:00:02.000Z', '2026-01-03T00:00:02.000Z'),
               ('proposal-consolidate-other-agent', 'other-agent',
                'create_entity', 'pending', '{"name":"Hidden"}', 0.9,
                'Other agent proposal.', '[]', 'contract-replay',
                '2026-01-03T00:00:03.000Z', '2026-01-03T00:00:03.000Z');"#,
        )
        .expect("seed ontology consolidation fixture");
    }

    fn seed_ontology_duplicate_repair_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute_batch(
            r#"INSERT INTO entities
               (id, name, canonical_name, entity_type, agent_id, mentions, pinned,
                status, created_at, updated_at)
               VALUES
               ('entity-dup-signet', 'Signet', 'signet', 'project', 'default',
                8, 1, 'active', '2026-01-04T00:00:00.000Z',
                '2026-01-04T00:00:00.000Z'),
               ('entity-dup-signet-upper', 'SIGNET', 'signet', 'project',
                'default', 3, 0, 'active', '2026-01-04T00:00:00.000Z',
                '2026-01-04T00:00:00.000Z'),
               ('entity-dup-signet-ai', 'signet.ai', 'signet', 'project',
                'default', 1, 0, 'active', '2026-01-04T00:00:00.000Z',
                '2026-01-04T00:00:00.000Z'),
               ('entity-dup-mixed-project', 'Mixed', 'mixed', 'project',
                'default', 8, 0, 'active', '2026-01-04T00:00:00.000Z',
                '2026-01-04T00:00:00.000Z'),
               ('entity-dup-mixed-skill', 'mixed', 'mixed', 'skill',
                'default', 3, 0, 'active', '2026-01-04T00:00:00.000Z',
                '2026-01-04T00:00:00.000Z'),
               ('entity-dup-other-agent', 'Signet Other', 'signet', 'project',
                'other-agent', 5, 0, 'active', '2026-01-04T00:00:00.000Z',
                '2026-01-04T00:00:00.000Z');

               INSERT INTO entity_aspects
               (id, entity_id, agent_id, name, canonical_name, weight, status,
                created_at, updated_at)
               VALUES
               ('aspect-dup-signet-upper', 'entity-dup-signet-upper', 'default',
                'identity', 'identity', 0.8, 'active',
                '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z');

               INSERT INTO entity_attributes
               (id, aspect_id, agent_id, kind, content, normalized_content,
                confidence, importance, status, created_at, updated_at)
               VALUES
               ('attr-dup-signet-upper', 'aspect-dup-signet-upper', 'default',
                'attribute', 'Duplicate source attribute.',
                'duplicate source attribute.', 0.8, 0.8, 'active',
                '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z');

               INSERT INTO memories
               (id, type, content, confidence, importance, tags, who, project,
                created_at, updated_at, updated_by, agent_id)
               VALUES
               ('memory-dup-source', 'fact', 'Duplicate source memory.',
                1.0, 0.8, 'ontology', 'test', 'signet',
                '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z',
                'contract-replay', 'default');

               INSERT INTO memory_entity_mentions (memory_id, entity_id)
               VALUES ('memory-dup-source', 'entity-dup-signet-upper');"#,
        )
        .expect("seed ontology duplicate repair fixture");
    }

    fn seed_knowledge_legacy_route_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute_batch(
            r#"INSERT INTO entities
               (id, name, canonical_name, entity_type, agent_id, mentions, pinned,
                pinned_at, status, created_at, updated_at)
               VALUES
               ('entity-nicholai', 'Nicholai', 'nicholai', 'person', 'default', 10, 0,
                NULL, 'active', '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'),
               ('entity-target', 'Target', 'target', 'concept', 'default', 3, 0,
                NULL, 'active', '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'),
               ('entity-deleted-target', 'Deleted Target', 'deleted target', 'concept', 'default', 3, 0,
                NULL, 'deleted', '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'),
               ('entity-deleted-pinned', 'Deleted Pinned', 'deleted pinned', 'concept', 'default', 3, 1,
                '2026-04-20T00:00:00.000Z', 'deleted', '2026-04-19T00:00:00.000Z', '2026-04-20T00:00:00.000Z'),
               ('entity-other-agent', 'Other Agent Entity', 'other agent entity', 'concept', 'other', 3, 0,
                NULL, 'active', '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z');

               INSERT INTO entity_aspects
               (id, entity_id, agent_id, name, canonical_name, weight, status, created_at, updated_at)
               VALUES
               ('aspect-food', 'entity-nicholai', 'default', 'food', 'food', 0.8, 'active',
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'),
               ('aspect-deleted', 'entity-nicholai', 'default', 'deleted', 'deleted', 0.9, 'deleted',
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z');

               INSERT INTO entity_attributes
               (id, aspect_id, agent_id, kind, content, normalized_content,
                group_key, claim_key, confidence, importance, status, created_at, updated_at)
               VALUES
               ('attr-active', 'aspect-food', 'default', 'attribute',
                'Nicholai currently prefers Temaki Den.', 'nicholai currently prefers temaki den.',
                'restaurants', 'favorite_restaurant', 0.9, 0.7, 'active',
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'),
               ('attr-hidden', 'aspect-deleted', 'default', 'attribute',
                'Deleted aspect attribute.', 'deleted aspect attribute.',
                'hidden', 'hidden_claim', 0.9, 0.9, 'active',
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z');

               INSERT INTO entity_dependencies
               (id, source_entity_id, target_entity_id, agent_id, aspect_id,
                dependency_type, strength, reason, status, created_at, updated_at)
               VALUES
               ('dep-active', 'entity-nicholai', 'entity-target', 'default', 'aspect-food',
                'depends_on', 0.83, 'Active dependency.', 'active',
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'),
               ('dep-deleted', 'entity-nicholai', 'entity-target', 'default', 'aspect-food',
                'depends_on', 0.99, 'Deleted dependency.', 'deleted',
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'),
               ('dep-deleted-target', 'entity-nicholai', 'entity-deleted-target', 'default', 'aspect-food',
                'depends_on', 0.95, 'Dependency to deleted target.', 'active',
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z');"#,
        )
        .expect("seed legacy knowledge route fixture");
    }

    fn seed_knowledge_health_hygiene_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute_batch(
            r#"CREATE TABLE IF NOT EXISTS entity_communities (
                   id TEXT PRIMARY KEY,
                   agent_id TEXT NOT NULL,
                   name TEXT,
                   cohesion REAL DEFAULT 0.0,
                   member_count INTEGER DEFAULT 0,
                   created_at TEXT NOT NULL DEFAULT (datetime('now')),
                   updated_at TEXT NOT NULL DEFAULT (datetime('now'))
               );

               CREATE TABLE IF NOT EXISTS predictor_comparisons (
                   id TEXT PRIMARY KEY,
                   session_key TEXT NOT NULL,
                   agent_id TEXT NOT NULL DEFAULT 'default',
                   predictor_ndcg REAL NOT NULL,
                   baseline_ndcg REAL NOT NULL,
                   predictor_won INTEGER NOT NULL,
                   margin REAL NOT NULL,
                   alpha REAL NOT NULL,
                   ema_updated INTEGER NOT NULL DEFAULT 0,
                   focal_entity_id TEXT,
                   focal_entity_name TEXT,
                   project TEXT,
                   candidate_count INTEGER NOT NULL,
                   traversal_count INTEGER NOT NULL DEFAULT 0,
                   constraint_count INTEGER NOT NULL DEFAULT 0,
                   created_at TEXT NOT NULL DEFAULT (datetime('now'))
               );

               INSERT INTO entities
               (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
               VALUES
               ('entity-signet-hygiene', 'Signet', 'signet', 'project', 'default', 5,
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'),
               ('entity-the-hygiene', 'The', 'the', 'concept', 'default', 1,
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'),
               ('entity-duplicate-a', 'Duplicate One', 'duplicate', 'concept', 'default', 1,
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'),
               ('entity-duplicate-b', 'Duplicate Two', 'duplicate', 'concept', 'default', 1,
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z');

               INSERT INTO memories
               (id, content, type, agent_id, updated_by, created_at, updated_at, is_deleted)
               VALUES
               ('mem-hygiene-signet', 'Signet should keep graph repair mechanical.',
                'fact', 'default', 'contract-replay',
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z', 0);

               INSERT INTO entity_aspects
               (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
               VALUES
               ('aspect-hygiene', 'entity-signet-hygiene', 'default', 'identity', 'identity', 0.7,
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z');

               INSERT INTO entity_attributes
               (id, aspect_id, agent_id, kind, content, normalized_content,
                confidence, importance, status, created_at, updated_at)
               VALUES
               ('attr-missing-slots', 'aspect-hygiene', 'default', 'attribute',
                'Signet attribute without navigation slots.', 'signet attribute without navigation slots.',
                0.8, 0.6, 'active', '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z');

               INSERT INTO entity_communities
               (id, agent_id, name, cohesion, member_count, created_at, updated_at)
               VALUES
               ('community-signet', 'default', 'Signet graph', 0.82, 4,
                '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z');

               INSERT INTO predictor_comparisons
               (id, session_key, agent_id, predictor_ndcg, baseline_ndcg,
                predictor_won, margin, alpha, ema_updated, focal_entity_id,
                focal_entity_name, project, candidate_count, traversal_count,
                constraint_count, created_at)
               VALUES
               ('pc-1', 'session-health', 'default', 0.2, 0.4, 0, -0.2, 0.1, 0,
                'entity-signet-hygiene', 'Signet', 'signet', 5, 1, 0, '2026-04-19T00:00:00.000Z'),
               ('pc-2', 'session-health', 'default', 0.8, 0.5, 1, 0.3, 0.1, 0,
                'entity-signet-hygiene', 'Signet', 'signet', 5, 1, 0, '2026-04-20T00:00:00.000Z'),
               ('pc-3', 'session-health', 'default', 0.9, 0.5, 1, 0.4, 0.1, 0,
                'entity-signet-hygiene', 'Signet', 'signet', 5, 1, 0, '2026-04-21T00:00:00.000Z');"#,
        )
        .expect("seed knowledge health and hygiene fixture");
    }

    fn seed_memory_search_telemetry_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute_batch(
            r#"INSERT INTO memory_search_telemetry
               (id, created_at, route, agent_id, session_key, project, query,
                keyword_query, filters_json, method, result_count, top_score,
                no_hits, duration_ms, timings_json, results_json, sources_json)
               VALUES
               ('telemetry-hit', '2026-01-02T00:00:00Z', 'POST /api/memory/recall',
                'ant', 'sess-telemetry', '/workspace/a', 'what did we decide about recall qa',
                'recall qa', '{"limit":3,"project":"/workspace/a"}', 'hybrid', 1, 0.91,
                0, 12.5, '{"totalMs":12.5,"stages":[{"name":"fts","durationMs":2.0}]}',
                '[{"rank":1,"id":"mem-telemetry","content":"Recall QA should preserve provenance.","content_length":36,"truncated":false,"score":0.91,"source":"memory","type":"fact","tags":"qa","pinned":false,"importance":0.8,"who":"test","project":"/workspace/a","created_at":"2026-01-01T00:00:00Z"}]',
                '{"memory":"local"}'),
               ('telemetry-miss', '2026-01-01T00:00:00Z', 'GET /api/memory/search',
                'ant', NULL, '/workspace/a', 'missing thing', NULL,
                '{"limit":5}', 'keyword', 0, NULL, 1, 4.0,
                '{"totalMs":4,"stages":[]}', '[]', NULL);
            "#,
        )
        .expect("seed memory search telemetry");
    }

    fn seed_continuity_and_checkpoint_fixture(&self) -> String {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let project = self._tmpdir.path().join("workspace-a");
        std::fs::create_dir_all(&project).expect("workspace fixture dir");
        let project = project.to_string_lossy().to_string();
        conn.execute(
            r#"INSERT INTO session_scores
               (id, session_key, project, harness, score,
                memories_recalled, memories_used, novel_context_count,
                reasoning, created_at)
               VALUES
               ('score-old', 'session-continuity-a', ?1, 'codex', 0.4, 5, 2, 1,
                'Older continuity score', '2026-01-01T00:00:00Z'),
               ('score-new', 'session-continuity-a', ?1, 'codex', 0.9, 7, 4, 2,
                'Newer continuity score', '2026-01-02T00:00:00Z'),
               ('score-other', 'session-continuity-b', '/workspace-b', 'codex', 0.7, 3, 2, 0,
                'Other project score', '2026-01-03T00:00:00Z')"#,
            [&project],
        )
        .expect("seed session scores");
        conn.execute(
            r#"INSERT INTO session_checkpoints
               (id, session_key, harness, project, project_normalized,
                trigger, digest, prompt_count, memory_queries, recent_remembers,
                focal_entity_ids, focal_entity_names, active_aspect_ids,
                surfaced_constraint_count, traversal_memory_count, created_at)
               VALUES
               ('checkpoint-new', 'session-continuity-a', 'codex', ?1, ?1,
                'periodic', 'Digest with token=super-secret-value', 4,
                '["continuity"]', '["remembered sk-test-secret-value"]',
                '["entity-a"]', '["Signet"]', '["aspect-a"]', 1, 2,
                '2026-01-02T00:05:00Z'),
               ('checkpoint-old', 'session-continuity-a', 'codex', ?1, ?1,
                'session_end', 'Older digest', 2, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL,
                '2026-01-01T00:05:00Z')"#,
            [&project],
        )
        .expect("seed session checkpoints");
        project
    }

    fn seed_ts_style_connector_with_nested_settings(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute(
            r#"INSERT INTO connectors
               (id, provider, display_name, config_json, settings_json, enabled, status, created_at, updated_at)
               VALUES
               ('connector-ts-full-config', 'obsidian', 'Obsidian',
                '{"id":"connector-ts-full-config","provider":"obsidian","settings":{"vault":"/tmp/vault","indexHidden":true},"enabled":true}',
                '{"id":"connector-ts-full-config","provider":"obsidian","settings":{"vault":"/tmp/vault","indexHidden":true},"enabled":true}',
                1, 'idle', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"#,
            [],
        )
        .expect("seed TS-style connector config");
    }

    fn seed_gdrive_connector_health_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute(
            r#"INSERT INTO connectors
               (id, provider, display_name, config_json, settings_json, enabled, status, last_sync_at, last_error, created_at, updated_at)
               VALUES
               ('connector-gdrive', 'gdrive', 'Drive Docs',
                '{"id":"connector-gdrive","provider":"gdrive","settings":{"rootPath":"/tmp/vault","indexHidden":true},"enabled":true}',
                '{"rootPath":"/tmp/vault","indexHidden":true}',
                1, 'idle', '2026-01-01T00:00:00Z', NULL,
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"#,
            [],
        )
        .expect("seed gdrive connector config");
        conn.execute(
            r#"INSERT INTO documents
               (id, source_url, source_type, content_type, title, raw_content,
                status, error, connector_id, chunk_count, memory_count,
                metadata_json, created_at, updated_at, completed_at)
               VALUES
               ('doc-vault-a', '/tmp/vault/a.md', 'file', 'text/plain', 'a.md', 'A',
                'completed', NULL, 'connector-gdrive', 1, 1, NULL,
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
               ('doc-vault-b', '/tmp/vault/nested/b.md', 'file', 'text/plain', 'b.md', 'B',
                'queued', NULL, 'connector-gdrive', 0, 0, NULL,
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL),
               ('doc-other', '/tmp/other/c.md', 'file', 'text/plain', 'c.md', 'C',
                'queued', NULL, 'connector-gdrive', 0, 0, NULL,
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)"#,
            [],
        )
        .expect("seed connector health documents");
    }

    fn seed_filesystem_connector_sync_fixture(&self) -> std::path::PathBuf {
        let root = self._tmpdir.path().join("connector-root");
        std::fs::create_dir_all(root.join("notes")).expect("create connector notes dir");
        std::fs::create_dir_all(root.join("node_modules")).expect("create ignored dir");
        std::fs::write(
            root.join("notes/a.md"),
            "Filesystem connector replay content from a Markdown file.",
        )
        .expect("write connector markdown file");
        std::fs::write(root.join("notes/b.txt"), "Text file excluded by pattern")
            .expect("write connector text file");
        std::fs::write(root.join("node_modules/skip.md"), "Ignored markdown file")
            .expect("write ignored connector file");

        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute(
            r#"INSERT INTO connectors
               (id, provider, display_name, config_json, settings_json, enabled,
                status, cursor_json, last_sync_at, last_error, created_at, updated_at)
               VALUES
               ('connector-fs-row', 'filesystem', 'Filesystem Docs',
                ?1, ?2, 1, 'idle', NULL, NULL, NULL,
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"#,
            rusqlite::params![
                serde_json::json!({
                    "id": "connector-fs-config",
                    "provider": "filesystem",
                    "displayName": "Filesystem Docs",
                    "settings": {
                        "rootPath": root.to_string_lossy(),
                        "patterns": ["**/*.md"],
                        "ignorePatterns": ["node_modules"],
                        "maxFileSize": 1048576
                    },
                    "enabled": true
                })
                .to_string(),
                serde_json::json!({
                    "rootPath": root.to_string_lossy(),
                    "patterns": ["**/*.md"],
                    "ignorePatterns": ["node_modules"],
                    "maxFileSize": 1048576
                })
                .to_string()
            ],
        )
        .expect("seed filesystem connector config");
        root
    }

    fn seed_malformed_connector_row(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute(
            r#"INSERT INTO connectors
               (id, provider, display_name, config_json, settings_json, enabled, status, created_at, updated_at)
               VALUES
               (x'01', 'filesystem', 'Bad Connector', '{}', '{}', 1, 'idle',
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"#,
            [],
        )
        .expect("seed malformed connector row");
    }

    fn seed_feedback_path_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute_batch(
            r#"INSERT INTO memories
               (id, type, content, confidence, importance, created_at, updated_at, agent_id)
               VALUES
               ('mem-feedback-a', 'fact', 'Feedback target memory', 1.0, 0.8,
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'default'),
               ('mem-feedback-other', 'fact', 'Different memory', 1.0, 0.8,
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'default');

               INSERT INTO entities
               (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
               VALUES
               ('entity-feedback-a', 'Feedback A', 'feedback a', 'concept', 'Feedback source entity', 'default', 1,
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
               ('entity-feedback-b', 'Feedback B', 'feedback b', 'concept', 'Feedback target entity', 'default', 1,
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

               INSERT INTO entity_aspects
               (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
               VALUES
               ('aspect-feedback-a', 'entity-feedback-a', 'default', 'runtime', 'runtime', 0.5,
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

               INSERT INTO entity_attributes
               (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
                confidence, importance, status, created_at, updated_at)
               VALUES
               ('attr-feedback-a', 'aspect-feedback-a', 'default', 'mem-feedback-a',
                'attribute', 'Feedback path attribute', 'feedback path attribute',
                0.9, 0.9, 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

               INSERT INTO entity_dependencies
               (id, source_entity_id, target_entity_id, agent_id, aspect_id,
                dependency_type, strength, confidence, reason, created_at, updated_at)
               VALUES
               ('dep-feedback-a', 'entity-feedback-a', 'entity-feedback-b', 'default',
                'aspect-feedback-a', 'depends_on', 0.5, 0.5, 'single-memory',
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

               INSERT INTO session_memories
               (id, session_key, memory_id, source, effective_score, predictor_score,
                final_score, rank, was_injected, relevance_score, created_at, agent_id,
                path_json)
               VALUES
               ('sm-feedback-a', 'sess-feedback', 'mem-feedback-a', 'memory', 0.9, NULL,
                0.9, 1, 1, 0.9, '2026-01-01T00:00:00Z', 'default',
                '{"entity_ids":["entity-feedback-a","entity-feedback-b"],"aspect_ids":["aspect-feedback-a"],"dependency_ids":["dep-feedback-a"]}'),
               ('sm-feedback-agent-b', 'sess-feedback', 'mem-feedback-other', 'memory', 0.9, NULL,
                0.9, 2, 1, 0.9, '2026-01-01T00:00:00Z', 'agent-b',
                '{"entity_ids":["entity-feedback-b"],"aspect_ids":[],"dependency_ids":[]}');"#,
        )
        .expect("seed path feedback fixture");
    }

    fn feedback_path_counts(&self) -> serde_json::Value {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM path_feedback_events WHERE memory_id = 'mem-feedback-a'",
                [],
                |row| row.get(0),
            )
            .expect("count feedback events");
        let stat_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM path_feedback_stats", [], |row| {
                row.get(0)
            })
            .expect("count feedback stats");
        let aspect_weight: f64 = conn
            .query_row(
                "SELECT weight FROM entity_aspects WHERE id = 'aspect-feedback-a'",
                [],
                |row| row.get(0),
            )
            .expect("aspect weight");
        let dep: (f64, f64, String) = conn
            .query_row(
                "SELECT strength, confidence, reason FROM entity_dependencies WHERE id = 'dep-feedback-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("dependency feedback state");
        let session_feedback: (f64, i64) = conn
            .query_row(
                "SELECT agent_relevance_score, agent_feedback_count
                 FROM session_memories WHERE id = 'sm-feedback-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("session feedback state");
        serde_json::json!({
            "eventCount": event_count,
            "statCount": stat_count,
            "aspectWeight": aspect_weight,
            "dependencyStrength": dep.0,
            "dependencyConfidence": dep.1,
            "dependencyReason": dep.2,
            "sessionScore": session_feedback.0,
            "sessionFeedbackCount": session_feedback.1,
        })
    }

    fn seed_plugin_audit_fixture(&self) {
        let dir = self._tmpdir.path().join(".daemon/plugins");
        std::fs::create_dir_all(&dir).expect("plugin audit dir");
        let line = serde_json::json!({
            "id": "audit-plugin-enabled",
            "timestamp": "2026-04-16T12:00:00.000Z",
            "event": "plugin.enabled",
            "pluginId": "signet.secrets",
            "result": "ok",
            "source": "plugin-host",
            "data": {
                "value": "raw-secret",
                "secret": "raw-secret-under-secret-key",
                "name": "OPENAI_API_KEY",
                "nested": {"clientSecret": "nested-secret"},
                "command": "OPENAI_API_KEY=*** bun test"
            }
        });
        std::fs::write(dir.join("audit-v1.ndjson"), format!("{}\n", line))
            .expect("write plugin audit");
    }

    fn seed_prompt_submit_entity_context_fixture(&self) {
        let conn = rusqlite::Connection::open(self.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let now = "2026-05-27T00:00:00Z";
        conn.execute(
            "INSERT INTO entities
             (id, name, canonical_name, entity_type, description, agent_id,
              mentions, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 10, ?7, ?7)",
            rusqlite::params![
                "entity-signet",
                "Signet",
                "signet",
                "project",
                "Source-backed agent continuity substrate",
                "agent-a",
                now,
            ],
        )
        .expect("seed prompt entity");
        conn.execute(
            "INSERT INTO entity_aliases
             (id, entity_id, agent_id, alias, canonical_alias, confidence,
              source, status, created_at, updated_at)
             VALUES ('alias-signetai', 'entity-signet', 'agent-a',
              'SignetAI', 'signetai', 1.0, 'test', 'active', ?1, ?1)",
            rusqlite::params![now],
        )
        .expect("seed prompt entity alias");
        conn.execute(
            "INSERT INTO entity_aspects
             (id, entity_id, agent_id, name, canonical_name, weight,
              created_at, updated_at)
             VALUES ('aspect-architecture', 'entity-signet', 'agent-a',
              'architecture', 'architecture', 0.9, ?1, ?1)",
            rusqlite::params![now],
        )
        .expect("seed prompt architecture aspect");
        conn.execute(
            "INSERT INTO entity_aspects
             (id, entity_id, agent_id, name, canonical_name, weight,
              created_at, updated_at)
             VALUES ('aspect-general', 'entity-signet', 'agent-a',
              'general', 'general', 1.0, ?1, ?1)",
            rusqlite::params![now],
        )
        .expect("seed prompt general aspect");
        conn.execute(
            "INSERT INTO entity_attributes
             (id, aspect_id, agent_id, memory_id, kind, content,
              normalized_content, confidence, importance, status, group_key,
              claim_key, source_kind, source_id, created_at, updated_at)
             VALUES ('attr-architecture', 'aspect-architecture', 'agent-a',
              NULL, 'attribute',
              'Prompt context should come from entity current views.',
              'prompt context should come from entity current views',
              0.95, 0.9, 'active', 'runtime', 'prompt_context', 'memory',
              'mem-architecture', ?1, ?1)",
            rusqlite::params![now],
        )
        .expect("seed prompt architecture attribute");
        conn.execute(
            "INSERT INTO entity_attributes
             (id, aspect_id, agent_id, memory_id, kind, content,
              normalized_content, confidence, importance, status, group_key,
              claim_key, created_at, updated_at)
             VALUES ('attr-general-junk', 'aspect-general', 'agent-a',
              NULL, 'constraint',
              'Prompt context junk from general uncategorized should not inject.',
              'prompt context junk from general uncategorized should not inject',
              0.99, 1.0, 'active', 'general', 'uncategorized', ?1, ?1)",
            rusqlite::params![now],
        )
        .expect("seed prompt general junk attribute");
        conn.execute(
            "INSERT INTO entity_attributes
             (id, aspect_id, agent_id, memory_id, kind, content,
              normalized_content, confidence, importance, status, group_key,
              claim_key, version, created_at, updated_at)
             VALUES ('attr-architecture-stale', 'aspect-architecture',
              'agent-a', NULL, 'attribute',
              'Stale prompt context should not be injected.',
              'stale prompt context should not be injected',
              0.5, 2.0, 'active', 'runtime', 'prompt_context', 0, ?1, ?1)",
            rusqlite::params![now],
        )
        .expect("seed stale prompt attribute");
    }

    async fn get(&self, path: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .expect("request failed")
    }

    async fn get_with_actor(&self, path: &str, actor: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{path}", self.base))
            .header("x-signet-actor", actor)
            .send()
            .await
            .expect("request failed")
    }

    async fn post(&self, path: &str, body: serde_json::Value) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.base))
            .json(&body)
            .send()
            .await
            .expect("request failed")
    }

    async fn post_with_actor(
        &self,
        path: &str,
        body: serde_json::Value,
        actor: &str,
    ) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.base))
            .header("x-signet-actor", actor)
            .json(&body)
            .send()
            .await
            .expect("request failed")
    }

    async fn post_mcp(&self, body: serde_json::Value) -> reqwest::Response {
        self.client
            .post(format!("{}/mcp", self.base))
            .header("Accept", "application/json, text/event-stream")
            .json(&body)
            .send()
            .await
            .expect("request failed")
    }

    async fn post_mcp_raw(&self, body: &str) -> reqwest::Response {
        self.client
            .post(format!("{}/mcp", self.base))
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .expect("request failed")
    }

    async fn patch_raw_json(&self, path: &str, body: &str) -> reqwest::Response {
        self.client
            .patch(format!("{}{path}", self.base))
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .expect("request failed")
    }

    async fn post_bearer(
        &self,
        path: &str,
        body: serde_json::Value,
        token: &str,
    ) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .expect("request failed")
    }

    async fn get_bearer(&self, path: &str, token: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .expect("request failed")
    }

    async fn patch_bearer(
        &self,
        path: &str,
        body: serde_json::Value,
        token: &str,
    ) -> reqwest::Response {
        self.client
            .patch(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .expect("request failed")
    }

    fn scoped_token(agent: &str) -> String {
        Self::scoped_role_token(agent, "agent")
    }

    fn scoped_role_token(agent: &str, role: &str) -> String {
        let now = chrono::Utc::now().timestamp();
        let payload = json!({
            "sub": format!("test-{agent}"),
            "scope": {"agent": agent},
            "role": role,
            "iat": now,
            "exp": now + 3600,
        });
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes());
        let mut mac = HmacSha256::new_from_slice(AUTH_SECRET).expect("valid hmac secret");
        mac.update(payload_b64.as_bytes());
        let sig_b64 = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{payload_b64}.{sig_b64}")
    }

    async fn patch(&self, path: &str, body: serde_json::Value) -> reqwest::Response {
        self.client
            .patch(format!("{}{path}", self.base))
            .json(&body)
            .send()
            .await
            .expect("request failed")
    }

    #[allow(dead_code)]
    async fn delete(&self, path: &str) -> reqwest::Response {
        self.client
            .delete(format!("{}{path}", self.base))
            .send()
            .await
            .expect("request failed")
    }

    async fn delete_json(&self, path: &str, body: serde_json::Value) -> reqwest::Response {
        self.client
            .delete(format!("{}{path}", self.base))
            .json(&body)
            .send()
            .await
            .expect("request failed")
    }

    async fn delete_bearer(&self, path: &str, token: &str) -> reqwest::Response {
        self.client
            .delete(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .expect("request failed")
    }

    async fn json(&self, resp: reqwest::Response) -> serde_json::Value {
        resp.json().await.expect("failed to parse json")
    }
}

async fn call_mcp_tool(
    server: &TestServer,
    name: &str,
    args: serde_json::Value,
) -> serde_json::Value {
    let resp = server
        .post_mcp(json!({
            "jsonrpc": "2.0",
            "id": format!("call-{name}"),
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": args,
            }
        }))
        .await;
    assert_eq!(resp.status(), 200, "MCP tool {name} HTTP status");
    let rpc = server.json(resp).await;
    assert!(
        rpc["error"].is_null(),
        "MCP tool {name} JSON-RPC error: {rpc}"
    );
    let text = rpc["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("MCP tool {name} returned no text content: {rpc}"));
    serde_json::from_str(text).unwrap_or_else(|_| json!({"text": text}))
}

fn ephemeral_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn test_server_start_lock() -> &'static tokio::sync::Mutex<()> {
    TEST_SERVER_START_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn write_fake_provider_bins(
    root: &std::path::Path,
) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let bin_dir = root.join("fake-bin");
    std::fs::create_dir_all(&bin_dir).expect("create fake provider bin dir");
    let bw = bin_dir.join("bw");
    let op = bin_dir.join("op");
    let signet = bin_dir.join("signet");
    let bunx = bin_dir.join("bunx");
    std::fs::write(
        &bw,
        r#"#!/bin/sh
set -eu
case "$1 ${2-}" in
  "status ")
    printf '{"status":"unlocked","userEmail":"replay@example.com","serverUrl":"https://vault.bitwarden.test"}'
    ;;
  "list folders")
    printf '[{"id":"folder-1","name":"Replay Folder"}]'
    ;;
  "list items")
    printf '[{"id":"item-1","name":"REPLAY_SECRET","folderId":"folder-1"}]'
    ;;
  "get item")
    printf '{"id":"%s","name":"REPLAY_SECRET","folderId":"folder-1","login":{"username":"signet","password":"bitwarden-secret"},"notes":"Managed by Signet secrets"}' "$3"
    ;;
  "encode ")
    cat
    ;;
  "create item")
    cat >/dev/null
    printf '{"id":"created-item","name":"CREATED_SECRET","folderId":"folder-1","login":{"username":"signet","password":"stored"}}'
    ;;
  "edit item")
    cat >/dev/null
    printf '{"id":"%s","name":"REPLAY_SECRET","folderId":"folder-1","login":{"username":"signet","password":"stored"}}' "$3"
    ;;
  *)
    echo "unsupported bw command: $*" >&2
    exit 2
    ;;
esac
"#,
    )
    .expect("write fake bw");
    std::fs::write(
        &op,
        r#"#!/bin/sh
set -eu
case "$1 ${2-} ${3-} ${4-}" in
  "vault list --format json")
    printf '[{"id":"vault-1","name":"Replay Vault"}]'
    ;;
  "item list --vault vault-1")
    printf '[{"id":"op-item-1","title":"Database","vaultId":"vault-1"}]'
    ;;
  "item get op-item-1 --vault")
    printf '{"id":"op-item-1","title":"Database","fields":[{"id":"password","label":"password","value":"op-secret","type":"CONCEALED","purpose":"PASSWORD"}]}'
    ;;
  *)
    echo "unsupported op command: $*" >&2
    exit 2
    ;;
esac
"#,
    )
    .expect("write fake op");
    std::fs::write(
        &signet,
        r#"#!/bin/sh
set -eu
case "$1 ${2-} ${3-}" in
  "status  ")
    echo "fake signet status"
    ;;
  "daemon status ")
    echo "fake daemon status"
    ;;
  "daemon logs --lines")
    echo "fake daemon logs"
    ;;
  "embed audit ")
    echo "fake embed audit"
    ;;
  "embed backfill ")
    echo "fake embed backfill"
    ;;
  "sync  ")
    echo "fake sync"
    ;;
  "recall test")
    echo "fake recall: ${3-}"
    ;;
  "skill list ")
    echo "fake skill list"
    ;;
  "secret list ")
    echo "fake secret list"
    ;;
  "update install ")
    echo "fake update install"
    ;;
  *)
    echo "unsupported signet command: $*" >&2
    exit 2
    ;;
esac
"#,
    )
    .expect("write fake signet");
    std::fs::write(
        &bunx,
        r#"#!/bin/sh
set -eu
if [ "${1-}" != "skills" ] || [ "${2-}" != "add" ]; then
  echo "unsupported bunx command: $*" >&2
  exit 2
fi
pkg="${3-}"
skill=""
shift 3
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skill)
      shift
      skill="${1-}"
      ;;
  esac
  shift || true
done
if [ -z "$skill" ]; then
  skill="${pkg##*/}"
  skill="${skill%@*}"
fi
target="${SIGNET_PATH}/skills/${skill}"
mkdir -p "$target"
cat >"${target}/SKILL.md" <<EOF
---
name: ${skill}
description: Installed by fake skills runner
version: 1.0.0
---

# ${skill}

This replay skill teaches agents to query SearchProvider through WebSearchSkill
for grounded web research, source attribution, and online fact lookup workflows
inside the Signet runtime.
EOF
echo "fake skills installed ${skill} from ${pkg}"
"#,
    )
    .expect("write fake bunx");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bw, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake bw");
        std::fs::set_permissions(&op, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake op");
        std::fs::set_permissions(&signet, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake signet");
        std::fs::set_permissions(&bunx, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake bunx");
    }
    (bw, op, bin_dir)
}

struct MarketplaceCatalogFixture {
    base: String,
    _thread: std::thread::JoinHandle<()>,
}

impl MarketplaceCatalogFixture {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind marketplace fixture");
        listener
            .set_nonblocking(false)
            .expect("configure marketplace fixture");
        let base = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming().take(32) {
                let Ok(mut stream) = stream else {
                    continue;
                };
                let mut buffer = [0_u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let body = marketplace_fixture_body(path);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/markdown; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            base,
            _thread: thread,
        }
    }
}

fn marketplace_fixture_body(path: &str) -> &'static str {
    if path.starts_with("/reference-catalog") {
        return r#"# Model Context Protocol Servers

## Reference Servers

- **[Fetch](src/fetch)** - Web content fetching and conversion.

## Third-Party Servers

- **[Dogfood](https://github.com/signet/fixture-mcp)** - Dogfood MCP server.
"#;
    }
    if path.starts_with("/catalog") {
        return r#"Showing 1-1 of 1 servers

[Official Web Fetch](https://mcpservers.org/en/servers/web-fetch)
"#;
    }
    if path.starts_with("/github/signet/catalog-mcp") {
        return r#"Catalog MCP
===========

Catalog detail description.

[GitHub](https://github.com/signet/catalog-mcp)

Standard Config

```json
{
  "mcpServers": {
    "catalog": {
      "command": "uvx",
      "args": ["catalog-mcp"]
    }
  }
}
```
"#;
    }
    if path.starts_with("/reference/fetch") {
        return r#"Fetch
=====

Reference fetch description.

Standard Config

```json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
```
"#;
    }
    r#"Web Fetch
=========

Web fetch description.

Standard Config

```json
{
  "mcpServers": {
    "web-fetch": {
      "command": "uvx",
      "args": ["web-fetch"]
    }
  }
}
```
"#
}

struct MarketplaceCatalogEnvGuard {
    previous: Vec<(&'static str, Option<String>)>,
}

impl MarketplaceCatalogEnvGuard {
    fn set(base: &str) -> Self {
        let values = [
            (
                "SIGNET_MCP_MARKETPLACE_REFERENCE_CATALOG_URL",
                format!("{base}/reference-catalog"),
            ),
            (
                "SIGNET_MCP_MARKETPLACE_CATALOG_PAGE_URL",
                format!("{base}/catalog?page={{page}}"),
            ),
            (
                "SIGNET_MCP_MARKETPLACE_MCPSERVERS_DETAIL_URL",
                format!("{base}/mcpservers/{{catalogId}}"),
            ),
            (
                "SIGNET_MCP_MARKETPLACE_REFERENCE_DETAIL_URL",
                format!("{base}/reference/{{catalogId}}"),
            ),
            (
                "SIGNET_MCP_MARKETPLACE_GITHUB_DETAIL_URL",
                format!("{base}/github/{{catalogId}}"),
            ),
        ];
        let previous = values
            .iter()
            .map(|(key, _)| (*key, std::env::var(key).ok()))
            .collect::<Vec<_>>();
        for (key, value) in values {
            unsafe {
                std::env::set_var(key, value);
            }
        }
        Self { previous }
    }
}

impl Drop for MarketplaceCatalogEnvGuard {
    fn drop(&mut self) {
        for (key, value) in &self.previous {
            unsafe {
                if let Some(value) = value {
                    std::env::set_var(key, value);
                } else {
                    std::env::remove_var(key);
                }
            }
        }
    }
}

struct ClawhubDownloadFixture {
    base: String,
    _thread: std::thread::JoinHandle<()>,
}

struct EmbeddingFixture {
    base: String,
    llm_requests: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    extraction_requests: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    _thread: std::thread::JoinHandle<()>,
}

impl EmbeddingFixture {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind embedding fixture");
        listener
            .set_nonblocking(false)
            .expect("configure embedding fixture");
        let base = format!("http://{}", listener.local_addr().unwrap());
        let llm_requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let extraction_requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let thread_llm_requests = llm_requests.clone();
        let thread_extraction_requests = extraction_requests.clone();
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming().take(16) {
                let Ok(mut stream) = stream else {
                    continue;
                };
                let mut buffer = [0_u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]);
                let body = if request.starts_with("POST /api/generate ") {
                    thread_llm_requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let response = if request.contains("Signet ontology consolidation") {
                        serde_json::json!({
                            "summary": "Merged duplicate Signet proposal candidates into one durable claim.",
                            "proposals": [{
                                "operation": "add_claim_value",
                                "payload": {
                                    "entity": "Signet",
                                    "aspect": "architecture",
                                    "claim_key": "proposal_loop",
                                    "value": "A"
                                },
                                "confidence": 0.91,
                                "rationale": "Pending candidates describe the same claim slot.",
                                "evidence": [{
                                    "source_kind": "ontology_proposal",
                                    "source_id": "proposal-consolidate-pending-a",
                                    "quote": "Pending proposal A."
                                }],
                                "risk": "low"
                            }],
                            "rejections": [{
                                "candidate_id": "proposal-consolidate-pending-b",
                                "reason": "duplicate"
                            }],
                            "conflicts": [{
                                "claim_slot": "architecture/proposal_loop",
                                "values": ["A", "B"],
                                "recommended_reducer": "prefer stable sourced value",
                                "needs_review": true
                            }],
                            "maintenance": [{
                                "operation": "request_review",
                                "target": "proposal-consolidate-pending-b",
                                "reason": "duplicate candidate"
                            }]
                        })
                        .to_string()
                    } else {
                        serde_json::json!({
                            "description": "Generated ollama replay metadata.",
                            "triggers": ["run ollama replay"],
                            "tags": ["replay"]
                        })
                        .to_string()
                    };
                    json!({
                        "response": response,
                        "eval_count": 1,
                        "prompt_eval_count": 1,
                        "total_duration": 1
                    })
                    .to_string()
                } else if request.starts_with("POST /v1/chat/completions ") {
                    thread_llm_requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if request.contains("Extract key facts and entity relationships") {
                        thread_extraction_requests
                            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        json!({
                            "choices": [{
                                "message": {
                                    "content": serde_json::json!({
                                        "facts": [],
                                        "entities": [{
                                            "source": "WebSearchSkill",
                                            "target": "SearchProvider",
                                            "relationship": "uses",
                                            "source_type": "skill",
                                            "target_type": "service"
                                        }]
                                    }).to_string()
                                }
                            }]
                        })
                        .to_string()
                    } else {
                        let (description, triggers, tags) =
                            if request.contains("Skill name: claw-demo") {
                                (
                                    "Enriched claw-demo discovery metadata for replay.",
                                    vec!["install claw demo", "use clawhub skill"],
                                    vec!["clawhub", "demo"],
                                )
                            } else {
                                (
                                    "Enriched web-search discovery metadata for replay.",
                                    vec!["look up web facts", "search online"],
                                    vec!["research", "web"],
                                )
                            };
                        json!({
                            "choices": [{
                                "message": {
                                    "content": serde_json::json!({
                                        "description": description,
                                        "triggers": triggers,
                                        "tags": tags,
                                    }).to_string()
                                }
                            }]
                        })
                        .to_string()
                    }
                } else {
                    r#"{"data":[{"embedding":[0.25,0.5,0.75]}]}"#.to_string()
                };
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(headers.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        Self {
            base,
            llm_requests,
            extraction_requests,
            _thread: thread,
        }
    }
}

impl ClawhubDownloadFixture {
    fn start(body: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind clawhub fixture");
        listener
            .set_nonblocking(false)
            .expect("configure clawhub fixture");
        let base = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming().take(8) {
                let Ok(mut stream) = stream else {
                    continue;
                };
                let mut buffer = [0_u8; 4096];
                let _ = stream.read(&mut buffer);
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(headers.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        Self {
            base,
            _thread: thread,
        }
    }
}

struct ClawhubEnvGuard {
    previous: Option<String>,
}

impl ClawhubEnvGuard {
    fn set(base: &str) -> Self {
        let previous = std::env::var("CLAWHUB_DOWNLOAD_BASE").ok();
        unsafe {
            std::env::set_var("CLAWHUB_DOWNLOAD_BASE", format!("{base}/download"));
        }
        Self { previous }
    }
}

impl Drop for ClawhubEnvGuard {
    fn drop(&mut self) {
        unsafe {
            if let Some(previous) = &self.previous {
                std::env::set_var("CLAWHUB_DOWNLOAD_BASE", previous);
            } else {
                std::env::remove_var("CLAWHUB_DOWNLOAD_BASE");
            }
        }
    }
}

fn clawhub_skill_archive(name: &str, description: &str) -> Vec<u8> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut archive = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default().unix_permissions(0o100644);
        archive.start_file("SKILL.md", options).unwrap();
        archive
            .write_all(
                format!(
                    "---\nname: {name}\ndescription: {description}\nversion: 1.0.0\n---\n\n# {name}\n"
                )
                .as_bytes(),
            )
            .unwrap();
        archive.finish().unwrap();
    }
    cursor.into_inner()
}

fn daemon_binary() -> String {
    if let Ok(path) = std::env::var("CARGO_BIN_EXE_signet-daemon") {
        if std::path::Path::new(&path).exists() {
            return path;
        }
    }
    if let Ok(target_dir) = std::env::var("CARGO_TARGET_DIR") {
        let path = std::path::PathBuf::from(target_dir).join("debug/signet-daemon");
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }
    // Look for the debug binary in target/
    let candidates = ["target/debug/signet-daemon", "target/release/signet-daemon"];
    for c in &candidates {
        let path = std::path::Path::new(c);
        if path.exists() {
            return path.to_str().unwrap().to_string();
        }
    }
    // Try workspace-relative paths
    let workspace = std::env::var("CARGO_MANIFEST_DIR")
        .map(|d| std::path::PathBuf::from(d).join("../../target/debug/signet-daemon"))
        .ok();
    if let Some(ref p) = workspace {
        if p.exists() {
            return p.to_str().unwrap().to_string();
        }
    }
    // Fall back to PATH
    "signet-daemon".to_string()
}

const INFERENCE_REPLAY_YAML: &str = r#"agent:
  name: test-agent
  version: 1
auth:
  method: token
  mode: team
memory:
  pipelineV2:
    extraction:
      provider: none
inference:
  defaultPolicy: auto
  targets:
    remote:
      executor: openrouter
      endpoint: https://openrouter.ai/api/v1
      models:
        sonnet:
          model: anthropic/claude-sonnet-4-6
          reasoning: medium
          toolUse: true
          streaming: true
    local:
      executor: ollama
      endpoint: http://127.0.0.1:11434
      models:
        gemma:
          model: gemma4
          reasoning: medium
          streaming: true
  policies:
    auto:
      mode: automatic
      defaultTargets:
        - remote/sonnet
        - local/gemma
  agents:
    rose:
      defaultPolicy: auto
      roster:
        - local/gemma
  workloads:
    interactive:
      policy: auto
"#;

const COMMAND_INFERENCE_REPLAY_YAML: &str = r#"agent:
  name: test-agent
  version: 1
auth:
  method: token
  mode: team
memory:
  pipelineV2:
    extraction:
      provider: none
inference:
  defaultPolicy: auto
  targets:
    localCli:
      executor: command
      command:
        bin: /bin/sh
        args:
          - -c
          - 'printf "cli:%s\n" "$SIGNET_PROMPT"'
      models:
        default:
          model: local-cli
          reasoning: low
  policies:
    auto:
      mode: strict
      defaultTargets:
        - localCli/default
  workloads:
    default:
      policy: auto
"#;

const COMMAND_STDIN_HANG_YAML: &str = r#"agent:
  name: test-agent
  version: 1
auth:
  method: token
  mode: team
memory:
  pipelineV2:
    extraction:
      provider: none
inference:
  defaultPolicy: auto
  targets:
    noReadCli:
      executor: command
      command:
        bin: /usr/bin/env
        args:
          - python3
          - -c
          - 'import time; time.sleep(5)'
      models:
        default:
          model: no-read-cli
          reasoning: low
  policies:
    auto:
      mode: strict
      defaultTargets:
        - noReadCli/default
  workloads:
    default:
      policy: auto
"#;

// ---------------------------------------------------------------------------
// Tests organized by endpoint category
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn health_returns_ok() {
    let server = TestServer::start().await;
    let resp = server.get("/health").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["status"], "healthy");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn status_returns_db_info() {
    let server = TestServer::start().await;
    let resp = server.get("/api/status").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["status"], "running");
    assert!(body["db"]["memories"].is_number());
    assert!(body["db"]["entities"].is_number());
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn memory_crud() {
    let server = TestServer::start().await;

    // List empty
    let resp = server.get("/api/memories").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["total"], 0);

    // Remember
    let resp = server
        .post(
            "/api/memory/remember",
            json!({
                "content": "Test memory for contract replay",
                "type": "observation"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body["id"].is_string() || body["status"].is_string());

    // List should now have >= 1
    let resp = server.get("/api/memories").await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn memory_history_replays_ts_order_and_body_shape() {
    let server = TestServer::start().await;
    server.seed_memory_history_fixture();

    let resp = server.get("/api/memory/mem-history-replay/history").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["memoryId"], "mem-history-replay");
    assert_eq!(body["count"], 2);
    assert!(body.get("total").is_none());
    assert_eq!(body["history"][0]["id"], "history-replay-updated");
    assert_eq!(body["history"][0]["event"], "updated");
    assert_eq!(body["history"][0]["oldContent"], "History replay target.");
    assert_eq!(
        body["history"][0]["newContent"],
        "History replay target edited."
    );
    assert_eq!(body["history"][0]["changedBy"], "contract-replay");
    assert_eq!(body["history"][0]["reason"], "history test edit");
    assert_eq!(body["history"][0]["metadata"]["source"], "contract");
    assert_eq!(body["history"][0]["createdAt"], "2026-01-01T00:00:01.000Z");
    assert_eq!(body["history"][0]["actorType"], "agent");
    assert_eq!(body["history"][0]["sessionId"], "session-history");
    assert_eq!(body["history"][0]["requestId"], "request-1");
    assert!(body["history"][0].get("old_content").is_none());
    assert!(body["history"][0].get("changed_by").is_none());

    assert_eq!(body["history"][1]["id"], "history-replay-deleted");
    assert_eq!(body["history"][1]["event"], "deleted");
    assert_eq!(body["history"][1]["reason"], "history test delete");
    assert_eq!(body["history"][1]["metadata"], "plain metadata");
    assert!(body["history"][1].get("actorType").is_none());
    assert!(body["history"][1].get("sessionId").is_none());
    assert!(body["history"][1].get("requestId").is_none());

    let resp = server.get("/api/memory/missing-history/history").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Not found");
    assert_eq!(body["memoryId"], "missing-history");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn memory_delete_replays_ts_validation_and_body_shape() {
    let server = TestServer::start().await;
    server.seed_memory_delete_fixture();

    let resp = server.delete("/api/memory/mem-delete-replay").await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "reason is required");

    let resp = server
        .delete_json("/api/memory/mem-delete-replay", json!("invalid"))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Invalid JSON body");

    let resp = server
        .delete_json(
            "/api/memory/mem-delete-replay",
            json!({"reason": "cleanup", "force": "not-bool"}),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "force must be a boolean");

    let resp = server
        .delete("/api/memory/mem-delete-pinned-replay?reason=cleanup")
        .await;
    assert_eq!(resp.status(), 409);
    let body = server.json(resp).await;
    assert_eq!(body["id"], "mem-delete-pinned-replay");
    assert_eq!(body["status"], "pinned_requires_force");
    assert_eq!(body["currentVersion"], 1);
    assert_eq!(body["error"], "Pinned memories require force=true");

    let resp = server
        .delete_json(
            "/api/memory/mem-delete-replay",
            json!({"reason": "body cleanup", "if_version": 1}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["id"], "mem-delete-replay");
    assert_eq!(body["status"], "deleted");
    assert_eq!(body["currentVersion"], 1);
    assert_eq!(body["newVersion"], 2);

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    let history: (String, String) = conn
        .query_row(
            "SELECT changed_by, reason
             FROM memory_history
             WHERE memory_id = 'mem-delete-replay' AND event = 'deleted'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("delete history");
    assert_eq!(history, ("api".to_string(), "body cleanup".to_string()));

    let resp = server
        .delete("/api/memory/missing-memory?reason=cleanup")
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["id"], "missing-memory");
    assert_eq!(body["status"], "not_found");
    assert_eq!(body["error"], "Not found");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn memory_maintenance_routes_replay_ts_shapes() {
    let server = TestServer::start().await;
    server.seed_memory_maintenance_fixture();

    let resp = server.get("/api/memory/review-queue").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["items"][0]["id"], "history-maintenance-review");
    assert_eq!(body["items"][0]["memory_id"], "mem-maintenance-replay");
    assert_eq!(body["items"][0]["event"], "REVIEW_NEEDED");
    assert_eq!(
        body["items"][0]["current_content"],
        "Memory maintenance replay starts here."
    );

    let resp = server.get("/api/memory/jobs/job-maintenance-replay").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["id"], "job-maintenance-replay");
    assert_eq!(body["memory_id"], "mem-maintenance-replay");
    assert_eq!(body["job_type"], "extract");
    assert_eq!(body["status"], "failed");
    assert_eq!(body["attempt_count"], 2);
    assert_eq!(body["attempts"], 2);
    assert_eq!(body["last_error"], "provider unavailable");
    assert_eq!(body["last_error_code"], serde_json::Value::Null);

    let resp = server.get("/api/memory/jobs/missing-job").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Job not found");

    let resp = server
        .post("/api/memory/codex-native-note", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "content is required");

    let resp = server
        .post(
            "/api/memory/codex-native-note",
            json!({
                "content": "Codex native note replay content.",
                "title": "Replay Note",
                "tags": "rust,parity"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["ok"], true);
    let note_path = body["path"].as_str().expect("note path");
    assert!(
        std::fs::read_to_string(note_path)
            .expect("read saved note")
            .contains("Codex native note replay content.")
    );

    let resp = server
        .patch(
            "/api/memory/mem-maintenance-replay",
            json!({
                "reason": "contract replay update",
                "content": "Memory maintenance replay was updated.",
                "importance": 0.8,
                "tags": ["rust", "maintenance"]
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["id"], "mem-maintenance-replay");
    assert_eq!(body["status"], "updated");
    assert_eq!(body["currentVersion"], 1);
    assert_eq!(body["newVersion"], 2);
    assert_eq!(body["contentChanged"], true);

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    let row: (String, f64, i64) = conn
        .query_row(
            "SELECT content, importance, version
             FROM memories
             WHERE id = 'mem-maintenance-replay'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("patched memory row");
    assert_eq!(row.0, "Memory maintenance replay was updated.");
    assert_eq!(row.1, 0.8);
    assert_eq!(row.2, 2);

    let resp = server
        .patch(
            "/api/memory/mem-maintenance-replay",
            json!({"content": "missing reason"}),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "reason is required");

    let resp = server
        .patch(
            "/api/memory/mem-maintenance-replay",
            json!({"reason": "bad version", "if_version": 1, "importance": 0.7}),
        )
        .await;
    assert_eq!(resp.status(), 409);
    let body = server.json(resp).await;
    assert_eq!(body["status"], "version_conflict");
    assert_eq!(body["currentVersion"], 2);

    let resp = server
        .patch(
            "/api/memory/missing-memory",
            json!({"reason": "contract replay", "importance": 0.7}),
        )
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["status"], "not_found");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn memory_remember_replays_ts_provenance_and_idempotency_contract() {
    let server = TestServer::start().await;

    let resp = server
        .post(
            "/api/memory/remember",
            json!({
                "content": "Provenance-backed imported memory",
                "who": "soulvessel.tests",
                "sourceType": "hermes-memory",
                "sourceId": "hermes-doc-provenance-test",
                "tags": "alpha, beta",
                "metadata": {
                    "source_path": "/tmp/signet-provenance/MEMORY.md",
                    "runtime_path": "memories/MEMORY.md",
                    "idempotency_key": "hermes:provenance-test"
                }
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let id = body["id"].as_str().expect("created memory id");
    assert_eq!(body["tags"], "alpha,beta");
    assert!(body.get("deduped").is_none());

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    let row: (String, String, String, String, String) = conn
        .query_row(
            "SELECT source_type, source_id, source_path, runtime_path, idempotency_key
             FROM memories WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("memory provenance row");
    assert_eq!(
        row,
        (
            "hermes-memory".to_string(),
            "hermes-doc-provenance-test".to_string(),
            "/tmp/signet-provenance/MEMORY.md".to_string(),
            "memories/MEMORY.md".to_string(),
            "hermes:provenance-test".to_string(),
        )
    );

    let retry = server
        .post(
            "/api/memory/remember",
            json!({
                "content": "Different retry content with the same stable import key",
                "who": "soulvessel.tests",
                "idempotencyKey": "hermes:provenance-test"
            }),
        )
        .await;
    assert_eq!(retry.status(), 200);
    let retry_body = server.json(retry).await;
    assert_eq!(retry_body["id"], id);
    assert_eq!(retry_body["deduped"], true);
    assert_eq!(retry_body["tags"], "alpha,beta");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn memory_remember_persists_structured_graph_hints_and_claim_supersession() {
    let server = TestServer::start().await;

    let resp = server
        .post(
            "/api/memory/remember",
            json!({
                "content": "Nicholai uses Signet for benchmark memory.",
                "structured": {
                    "entities": [{
                        "source": "Nicholai",
                        "sourceType": "person",
                        "relationship": "uses",
                        "target": "Signet",
                        "targetType": "system",
                        "confidence": 0.95
                    }],
                    "aspects": [{
                        "entityName": "Nicholai",
                        "aspect": "tools",
                        "attributes": [{
                            "content": "Nicholai uses Signet for benchmark memory.",
                            "confidence": 0.95
                        }]
                    }],
                    "hints": ["What does Nicholai use for benchmark memory?"]
                }
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let id = body["id"].as_str().expect("structured memory id");
    assert_eq!(body["structured"], true);
    assert_eq!(body["hints_written"], 1);
    assert!(
        body["entities_linked"]
            .as_i64()
            .expect("entities_linked count")
            > 0
    );

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    let attribute: String = conn
        .query_row(
            "SELECT ea.content
             FROM entities e
             JOIN entity_aspects asp ON asp.entity_id = e.id
             JOIN entity_attributes ea ON ea.aspect_id = asp.id
             WHERE e.agent_id = 'default' AND e.canonical_name = 'nicholai'",
            [],
            |row| row.get(0),
        )
        .expect("structured attribute row");
    assert_eq!(attribute, "Nicholai uses Signet for benchmark memory.");

    let (hint, extraction_status, extraction_model): (String, String, String) = conn
        .query_row(
            "SELECT mh.hint, m.extraction_status, m.extraction_model
             FROM memory_hints mh
             JOIN memories m ON m.id = mh.memory_id
             WHERE mh.memory_id = ?1 AND mh.agent_id = 'default'",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("structured hint row");
    assert_eq!(hint, "What does Nicholai use for benchmark memory?");
    assert_eq!(extraction_status, "complete");
    assert_eq!(extraction_model, "structured-passthrough");

    for payload in [
        json!({
            "content": "The benchmark user had tried three Korean restaurants.",
            "createdAt": "2023-05-01T12:00:00.000Z",
            "structured": {
                "aspects": [{
                    "entityName": "MemoryBench User restaurants",
                    "entityType": "person",
                    "aspect": "dining history",
                    "attributes": [{
                        "claimKey": "korean_restaurants_tried_count",
                        "content": "MemoryBench User restaurants has tried three Korean restaurants.",
                        "confidence": 0.9,
                        "importance": 0.8
                    }]
                }]
            }
        }),
        json!({
            "content": "The benchmark user has now tried four Korean restaurants.",
            "createdAt": "2023-06-01T12:00:00.000Z",
            "structured": {
                "aspects": [{
                    "entityName": "MemoryBench User restaurants",
                    "entityType": "person",
                    "aspect": "dining history",
                    "attributes": [{
                        "claimKey": "korean_restaurants_tried_count",
                        "content": "MemoryBench User restaurants has now tried four Korean restaurants.",
                        "confidence": 0.9,
                        "importance": 0.8
                    }]
                }]
            }
        }),
    ] {
        let resp = server.post("/api/memory/remember", payload).await;
        assert_eq!(resp.status(), 200);
    }

    let rows = conn
        .prepare(
            "SELECT ea.content, ea.status, replacement.content AS replacement
             FROM entities e
             JOIN entity_aspects asp ON asp.entity_id = e.id
             JOIN entity_attributes ea ON ea.aspect_id = asp.id
             LEFT JOIN entity_attributes replacement ON replacement.id = ea.superseded_by
             WHERE e.agent_id = 'default' AND e.canonical_name = 'memorybench user restaurants'
             ORDER BY ea.created_at",
        )
        .expect("prepare structured supersession query")
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .expect("query structured supersession rows")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect structured supersession rows");
    assert_eq!(
        rows,
        vec![
            (
                "MemoryBench User restaurants has tried three Korean restaurants.".to_string(),
                "superseded".to_string(),
                Some(
                    "MemoryBench User restaurants has now tried four Korean restaurants."
                        .to_string()
                )
            ),
            (
                "MemoryBench User restaurants has now tried four Korean restaurants.".to_string(),
                "active".to_string(),
                None
            )
        ]
    );

    let invalid = server
        .post(
            "/api/memory/remember",
            json!({"content": "Invalid timestamp memory.", "createdAt": "not-a-date"}),
        )
        .await;
    assert_eq!(invalid.status(), 400);
    let invalid_body = server.json(invalid).await;
    assert_eq!(
        invalid_body["error"],
        "createdAt must be a valid ISO timestamp"
    );
}

const CHUNK_REPLAY_YAML: &str = r#"agent:
  name: test-agent
  version: 1
memory:
  pipelineV2:
    enabled: false
    guardrails:
      maxContentChars: 800
      chunkTargetChars: 600
"#;

fn chunk_replay_content(prefix: &str, count: usize) -> String {
    (0..count)
        .map(|index| {
            format!("{prefix} sentence {index} carries enough words to split predictably.")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn memory_remember_chunks_oversized_idempotent_imports() {
    let server = TestServer::start_with_agent_yaml(None, CHUNK_REPLAY_YAML).await;
    let content = chunk_replay_content("Chunked provenance", 90);
    assert!(content.len() > 800);

    let first = server
        .post(
            "/api/memory/remember",
            json!({
                "content": content,
                "who": "soulvessel.tests",
                "idempotencyKey": "chunked-import-key"
            }),
        )
        .await;
    assert_eq!(first.status(), 200);
    let first_body = server.json(first).await;
    assert_eq!(first_body["chunked"], true);
    let ids = first_body["ids"].as_array().expect("chunk ids");
    assert!(ids.len() > 1);
    let group_id = first_body["group_id"].as_str().expect("chunk group id");

    let retry = server
        .post(
            "/api/memory/remember",
            json!({
                "content": content,
                "who": "soulvessel.tests",
                "idempotencyKey": "chunked-import-key"
            }),
        )
        .await;
    assert_eq!(retry.status(), 200);
    let retry_body = server.json(retry).await;
    assert_eq!(retry_body["chunked"], true);
    assert_eq!(retry_body["deduped"], true);
    assert_eq!(retry_body["ids"], first_body["ids"]);
    assert_eq!(retry_body["group_id"], group_id);

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    let groups: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entities WHERE entity_type = 'chunk_group'",
            [],
            |row| row.get(0),
        )
        .expect("chunk group count");
    assert_eq!(groups, 1);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn memory_remember_rejects_chunk_idempotency_conflicts() {
    let server = TestServer::start_with_agent_yaml(None, CHUNK_REPLAY_YAML).await;
    let content = chunk_replay_content("Stable chunked import", 90);
    let changed = chunk_replay_content("Changed chunked import", 92);

    let first = server
        .post(
            "/api/memory/remember",
            json!({
                "content": content,
                "who": "soulvessel.tests",
                "idempotencyKey": "chunked-import-conflict-key"
            }),
        )
        .await;
    assert_eq!(first.status(), 200);

    let conflict = server
        .post(
            "/api/memory/remember",
            json!({
                "content": changed,
                "who": "soulvessel.tests",
                "idempotencyKey": "chunked-import-conflict-key"
            }),
        )
        .await;
    assert_eq!(conflict.status(), 409);
    let conflict_body = server.json(conflict).await;
    assert!(
        conflict_body["error"]
            .as_str()
            .expect("conflict error")
            .contains("different chunked content")
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn memory_remember_rejects_mixed_chunked_and_small_idempotency_reuse() {
    let server = TestServer::start_with_agent_yaml(None, CHUNK_REPLAY_YAML).await;
    let oversized = chunk_replay_content("Mixed idempotency chunk", 90);

    let small = server
        .post(
            "/api/memory/remember",
            json!({
                "content": "Small memory using a key before a chunked import.",
                "who": "soulvessel.tests",
                "idempotencyKey": "mixed-small-first-key"
            }),
        )
        .await;
    assert_eq!(small.status(), 200);

    let chunk_after_small = server
        .post(
            "/api/memory/remember",
            json!({
                "content": oversized,
                "who": "soulvessel.tests",
                "idempotencyKey": "mixed-small-first-key"
            }),
        )
        .await;
    assert_eq!(chunk_after_small.status(), 409);
    let chunk_after_small_body = server.json(chunk_after_small).await;
    assert!(
        chunk_after_small_body["error"]
            .as_str()
            .expect("non-chunk conflict error")
            .contains("non-chunk content")
    );

    let chunk_first = server
        .post(
            "/api/memory/remember",
            json!({
                "content": chunk_replay_content("Mixed chunk first", 90),
                "who": "soulvessel.tests",
                "idempotencyKey": "mixed-chunk-first-key"
            }),
        )
        .await;
    assert_eq!(chunk_first.status(), 200);

    let small_after_chunk = server
        .post(
            "/api/memory/remember",
            json!({
                "content": "Small memory using a key after a chunked import.",
                "who": "soulvessel.tests",
                "idempotencyKey": "mixed-chunk-first-key"
            }),
        )
        .await;
    assert_eq!(small_after_chunk.status(), 409);
    let small_after_chunk_body = server.json(small_after_chunk).await;
    assert!(
        small_after_chunk_body["error"]
            .as_str()
            .expect("chunk conflict error")
            .contains("chunked content")
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn memory_remember_rejects_chunked_imports_that_reuse_content_rows() {
    let server = TestServer::start_with_agent_yaml(None, CHUNK_REPLAY_YAML).await;
    let first_chunk = "A".repeat(600);
    let oversized = format!("{}{}", first_chunk, "B".repeat(900));

    let existing = server
        .post(
            "/api/memory/remember",
            json!({
                "content": first_chunk,
                "who": "soulvessel.tests",
                "idempotencyKey": "existing-normal-chunk-content-key"
            }),
        )
        .await;
    assert_eq!(existing.status(), 200);

    let chunked = server
        .post(
            "/api/memory/remember",
            json!({
                "content": oversized,
                "who": "soulvessel.tests",
                "idempotencyKey": "chunked-existing-content-key"
            }),
        )
        .await;
    assert_eq!(chunked.status(), 409);
    let chunked_body = server.json(chunked).await;
    assert!(
        chunked_body["error"]
            .as_str()
            .expect("content conflict error")
            .contains("chunk content already exists")
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn memory_remember_resolves_concurrent_chunk_hash_collisions_as_conflicts() {
    let server = TestServer::start_with_agent_yaml(None, CHUNK_REPLAY_YAML).await;
    let oversized = chunk_replay_content("Concurrent chunk hash", 90);

    let first = server.post(
        "/api/memory/remember",
        json!({
            "content": oversized,
            "who": "soulvessel.tests",
            "idempotencyKey": "concurrent-chunk-content-key-a"
        }),
    );
    let second = server.post(
        "/api/memory/remember",
        json!({
            "content": chunk_replay_content("Concurrent chunk hash", 90),
            "who": "soulvessel.tests",
            "idempotencyKey": "concurrent-chunk-content-key-b"
        }),
    );
    let (first, second) = tokio::join!(first, second);
    let mut statuses = [first.status().as_u16(), second.status().as_u16()];
    statuses.sort_unstable();
    assert_eq!(statuses, [200, 409]);

    let (losing_key, conflict) = if first.status().as_u16() == 409 {
        ("concurrent-chunk-content-key-a", first)
    } else {
        ("concurrent-chunk-content-key-b", second)
    };
    let conflict_body = server.json(conflict).await;
    assert!(
        conflict_body["error"]
            .as_str()
            .expect("concurrent conflict error")
            .contains("chunk content already exists")
    );

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    let partial: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE idempotency_key LIKE ?1",
            [format!("{losing_key}:chunk:%")],
            |row| row.get(0),
        )
        .expect("losing chunk count");
    assert_eq!(partial, 0);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn config_endpoints() {
    let server = TestServer::start().await;

    let resp = server.get("/api/config").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/identity").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/features").await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn search_endpoints() {
    let server = TestServer::start().await;

    // Search with empty DB
    let resp = server.get("/api/memory/search?q=test&limit=10").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/memory/search?q=test&limit=10").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/memory/similar").await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "id is required");
    assert_eq!(body["results"], json!([]));

    let resp = server.get("/memory/similar?id=missing-memory").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "No embedding found for this memory");
    assert_eq!(body["results"], json!([]));

    server.seed_recall_scope_fixture();

    let resp = server
        .post(
            "/api/memory/recall",
            json!({"query": "recall parity", "limit": 10}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["query"], "recall parity");
    assert_eq!(body["method"], "keyword");
    assert_eq!(body["meta"]["totalReturned"], 1);
    assert_eq!(body["meta"]["hasSupplementary"], false);
    assert_eq!(body["meta"]["noHits"], false);
    assert!(body["meta"]["timings"]["totalMs"].is_number());
    assert_eq!(body["results"][0]["id"], "mem-recall-visible");
    assert_eq!(
        body["results"][0]["content"],
        "Recall parity visible unscoped memory for default agent."
    );
    assert_eq!(body["results"][0]["visibility"], "global");
    assert_eq!(body["results"][0]["scope"], serde_json::Value::Null);
    assert_eq!(body["results"][0]["project"], "/workspace/default");
    assert!(
        body["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|hit| hit["id"] != "mem-recall-scoped" && hit["id"] != "mem-recall-other-agent")
    );

    let resp = server
        .post(
            "/api/memory/recall",
            json!({"query": "recall parity", "scope": "private-a", "limit": 10}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["meta"]["totalReturned"], 1);
    assert_eq!(body["results"][0]["id"], "mem-recall-scoped");
    assert_eq!(body["results"][0]["visibility"], "private");
    assert_eq!(body["results"][0]["scope"], "private-a");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn feedback_endpoint() {
    let server = TestServer::start().await;
    server.seed_feedback_path_fixture();

    let bad = server
        .post("/api/memory/feedback", json!({"sessionKey": "sess-1"}))
        .await;
    assert_eq!(bad.status(), 400);

    let ok = server
        .post(
            "/api/memory/feedback",
            json!({
                "sessionKey": "sess-1",
                "feedback": { "missing-memory": 1 }
            }),
        )
        .await;
    assert_eq!(ok.status(), 200);
    let body = server.json(ok).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["recorded"], 1);
    assert_eq!(body["accepted"], 0);

    let ok = server
        .post(
            "/api/memory/feedback",
            json!({
                "sessionKey": "sess-feedback",
                "agentId": "default",
                "feedback": {
                    "mem-feedback-a": 1,
                    "mem-feedback-other": -1
                },
                "rewards": {
                    "mem-feedback-a": { "forward_citation": 1 }
                }
            }),
        )
        .await;
    assert_eq!(ok.status(), 200);
    let body = server.json(ok).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["recorded"], 2);
    assert_eq!(body["accepted"], 1);
    assert_eq!(body["rejected"], 1);
    assert_eq!(body["propagated"], 1);
    assert_eq!(body["dependenciesUpdated"], 1);
    assert!(
        body["acceptanceRule"]
            .as_str()
            .unwrap_or_default()
            .contains("recorded for this session")
    );
    let counts = server.feedback_path_counts();
    assert_eq!(counts["eventCount"], 1);
    assert_eq!(counts["statCount"], 1);
    assert_eq!(counts["sessionFeedbackCount"], 1);
    assert_eq!(counts["sessionScore"], 1.0);
    assert!(counts["aspectWeight"].as_f64().unwrap() > 0.5);
    assert!(counts["dependencyStrength"].as_f64().unwrap() > 0.5);
    assert!(counts["dependencyConfidence"].as_f64().unwrap() > 0.5);
    assert_eq!(counts["dependencyReason"], "pattern-matched");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn knowledge_endpoints() {
    let server = TestServer::start().await;

    let resp = server.get("/api/knowledge/entities").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/knowledge/stats").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/knowledge/constellation").await;
    assert_eq!(resp.status(), 200);

    let resp = server.post("/api/graph/impact", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "entityId is required");

    let resp = server
        .post(
            "/api/graph/impact",
            json!({"entityId": "missing-entity", "direction": "upstream", "maxDepth": 99}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["entityId"], "missing-entity");
    assert_eq!(body["entityName"], "missing-entity");
    assert_eq!(body["direction"], "upstream");
    assert_eq!(body["impact"], json!([]));
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn knowledge_legacy_entity_routes_replay_ts_shape() {
    let server = TestServer::start().await;
    server.seed_knowledge_legacy_route_fixture();

    let resp = server.get("/api/knowledge/entities?limit=10").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let entities = body["items"].as_array().expect("knowledge entity items");
    assert_eq!(entities.len(), 2);
    assert_eq!(entities[0]["entity"]["id"], "entity-nicholai");
    assert_eq!(entities[0]["entity"]["name"], "Nicholai");
    assert_eq!(entities[0]["aspectCount"], 1);
    assert_eq!(entities[0]["attributeCount"], 1);
    assert_eq!(entities[0]["dependencyCount"], 1);
    assert!(entities[0]["id"].is_null());
    assert_eq!(entities[1]["entity"]["id"], "entity-target");

    let resp = server.get("/api/knowledge/entities/missing-entity").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"error": "Entity not found"}));

    let resp = server.get("/api/knowledge/entities/entity-nicholai").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["entity"]["name"], "Nicholai");
    assert_eq!(body["aspectCount"], 1);
    assert_eq!(body["attributeCount"], 1);
    assert_eq!(body["dependencyCount"], 1);
    assert_eq!(body["outgoingDependencyCount"], 1);
    assert_eq!(body["incomingDependencyCount"], 0);

    let resp = server
        .get("/api/knowledge/entities/missing-entity/aspects")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"items": []}));

    let resp = server
        .get("/api/knowledge/entities/entity-nicholai/aspects")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let aspects = body["items"].as_array().expect("aspect items");
    assert_eq!(aspects.len(), 1);
    assert_eq!(aspects[0]["aspect"]["id"], "aspect-food");

    let resp = server
        .get("/api/knowledge/entities/entity-nicholai/aspects/aspect-deleted/attributes")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(
        body,
        json!({
            "items": [],
            "limit": 50,
            "offset": 0,
        })
    );

    let resp = server
        .get("/api/knowledge/entities/entity-nicholai/aspects/aspect-food/attributes")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let attributes = body["items"].as_array().expect("attribute items");
    assert_eq!(attributes.len(), 1);
    assert_eq!(attributes[0]["id"], "attr-active");

    let resp = server
        .get("/api/knowledge/entities/entity-nicholai/dependencies")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let dependencies = body["items"].as_array().expect("dependency items");
    assert_eq!(dependencies.len(), 1);
    assert_eq!(dependencies[0]["id"], "dep-active");

    let resp = server
        .get("/api/knowledge/entities/entity-nicholai/dependencies?direction=incoming")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"items": []}));

    let resp = server.get("/api/knowledge/entities/pinned").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body, json!([]));

    let resp = server
        .post("/api/knowledge/entities/entity-other-agent/pin", json!({}))
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"error": "Entity not found"}));

    let resp = server
        .post("/api/knowledge/entities/entity-nicholai/pin", json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["pinned"], true);
    assert!(body["pinnedAt"].as_str().is_some());

    let resp = server.get("/api/knowledge/entities/pinned").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let pinned = body.as_array().expect("pinned entity list");
    assert_eq!(pinned.len(), 1);
    assert_eq!(pinned[0]["id"], "entity-nicholai");
    assert_eq!(pinned[0]["name"], "Nicholai");
    assert!(pinned[0]["pinnedAt"].as_str().is_some());

    let resp = server
        .delete("/api/knowledge/entities/missing-entity/pin")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"pinned": false}));

    let resp = server
        .delete("/api/knowledge/entities/entity-nicholai/pin")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"pinned": false}));
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn graphiq_routes_replay_validation_and_status_shapes() {
    let fake_dir = tempfile::tempdir().expect("fake graphiq dir");
    let fake_bin_dir = fake_dir.path().join("bin");
    std::fs::create_dir_all(&fake_bin_dir).unwrap();
    let fake_graphiq = fake_bin_dir.join("graphiq");
    std::fs::write(
        &fake_graphiq,
        r#"#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "index" ]; then
  db=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--db" ]; then db="$arg"; fi
    prev="$arg"
  done
  if [ -n "$db" ]; then
    mkdir -p "$(dirname "$db")"
    : > "$db"
  fi
  echo "Files: 3 Symbols: 4 Edges: 5"
  exit 0
fi
echo "graphiq fixture"
"#,
    )
    .unwrap();
    let fake_installer = fake_dir.path().join("install-graphiq.sh");
    std::fs::write(
        &fake_installer,
        "#!/usr/bin/env bash\necho \"fixture install $1\"\nexit 0\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake_graphiq, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&fake_installer, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let original_path = std::env::var_os("PATH");
    let original_script = std::env::var_os("SIGNET_GRAPHIQ_INSTALL_SCRIPT");
    let next_path = match original_path.as_ref() {
        Some(path) => {
            let mut paths = vec![fake_bin_dir.clone()];
            paths.extend(std::env::split_paths(path));
            std::env::join_paths(paths).unwrap()
        }
        None => fake_bin_dir.clone().into_os_string(),
    };
    unsafe {
        std::env::set_var("PATH", next_path);
        std::env::set_var("SIGNET_GRAPHIQ_INSTALL_SCRIPT", &fake_installer);
    }
    let server = TestServer::start().await;

    let resp = server.get("/api/graphiq/status").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["installed"], true);
    assert_eq!(body["pluginEnabled"], false);
    assert_eq!(body["pluginState"], "not-registered");
    assert!(body["indexedProjects"].as_array().unwrap().is_empty());
    assert_eq!(body["installSource"], serde_json::Value::Null);

    let resp = server.post("/api/graphiq/index", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["success"], false);
    assert_eq!(body["error"], "path is required");

    let resp = server
        .post(
            "/api/graphiq/index",
            json!({"path": "/definitely/missing/graphiq-project"}),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["success"], false);
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("Project path does not exist")
    );

    let resp = server.post("/api/graphiq/uninstall", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["message"], "GraphIQ plugin disabled");

    let resp = server.post("/api/graphiq/install", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["message"], "GraphIQ already installed, plugin enabled");

    let project = server._tmpdir.path().join("graphiq-project");
    std::fs::create_dir_all(&project).unwrap();
    let resp = server
        .post(
            "/api/graphiq/index",
            json!({"path": project.display().to_string()}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["project"], project.display().to_string());
    assert_eq!(body["stats"]["files"], 3);
    assert_eq!(body["stats"]["symbols"], 4);
    assert_eq!(body["stats"]["edges"], 5);
    assert!(project.join(".graphiq/graphiq.db").exists());
    let state: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(server._tmpdir.path().join(".daemon/graphiq/state.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(state["enabled"], true);
    assert_eq!(state["activeProject"], project.display().to_string());
    assert_eq!(state["indexedProjects"][0]["files"], 3);

    let resp = server.post("/api/graphiq/update", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["message"], "GraphIQ updated via script");

    unsafe {
        if let Some(path) = original_path {
            std::env::set_var("PATH", path);
        } else {
            std::env::remove_var("PATH");
        }
        if let Some(script) = original_script {
            std::env::set_var("SIGNET_GRAPHIQ_INSTALL_SCRIPT", script);
        } else {
            std::env::remove_var("SIGNET_GRAPHIQ_INSTALL_SCRIPT");
        }
    }
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn pipeline_endpoints() {
    let server = TestServer::start().await;

    let resp = server.get("/api/pipeline/status").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body["queues"].is_object());
    assert!(body["mode"].is_string());

    let resp = server.post("/api/pipeline/pause", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["paused"], true);
    assert_eq!(body["mode"], "paused");

    let resp = server.post("/api/pipeline/resume", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["paused"], false);

    let resp = server.post("/api/pipeline/nudge", json!({})).await;
    assert_eq!(resp.status(), 503);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Extraction worker not running");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn session_endpoints() {
    let server = TestServer::start().await;

    let resp = server.get("/api/sessions").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/sessions/missing-session/transcript").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Transcript not found");

    {
        let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
        conn.execute(
            "INSERT INTO session_transcripts
             (session_key, agent_id, content, harness, project, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "seeded-session",
                "default",
                "seeded transcript body",
                "contract-replay",
                "session-test",
                "2026-06-02T00:00:00Z"
            ],
        )
        .expect("seed transcript");
        conn.execute(
            "INSERT INTO session_summaries
             (id, project, depth, kind, content, token_count, earliest_at, latest_at, session_key, harness, agent_id, created_at, source_type)
             VALUES (?1, 'session-test', 0, 'session', ?2, 12, ?3, ?3, ?4, 'contract-replay', 'default', ?3, 'summary')",
            rusqlite::params![
                "summary-session-default",
                "Default summary for native session route replay.",
                "2026-06-02T00:00:00Z",
                "seeded-session",
            ],
        )
        .expect("seed default summary");
        conn.execute(
            "INSERT INTO session_summaries
             (id, project, depth, kind, content, token_count, earliest_at, latest_at, session_key, harness, agent_id, created_at, source_type)
             VALUES (?1, 'session-test', 0, 'session', ?2, 12, ?3, ?3, ?4, 'contract-replay', 'other-agent', ?3, 'summary')",
            rusqlite::params![
                "summary-session-other-agent",
                "Other-agent summary must not leak into default summary scope.",
                "2026-06-02T00:00:01Z",
                "shared-summary-session",
            ],
        )
        .expect("seed other-agent summary");
        conn.execute(
            "INSERT INTO session_transcripts
             (session_key, agent_id, content, harness, project, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "shared-summary-session",
                "default",
                "default transcript must not attach to other-agent summary",
                "contract-replay",
                "session-test",
                "2026-06-02T00:00:01Z"
            ],
        )
        .expect("seed default colliding transcript");
        conn.execute(
            "INSERT INTO session_transcripts
             (session_key, agent_id, content, harness, project, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "shared-summary-session",
                "other-agent",
                "other-agent transcript body",
                "contract-replay",
                "session-test",
                "2026-06-02T00:00:01Z"
            ],
        )
        .expect("seed other-agent transcript");
    }
    let resp = server.get("/api/sessions/seeded-session/transcript").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["sessionKey"], "seeded-session");
    assert_eq!(body["agentId"], "default");
    assert_eq!(body["content"], "seeded transcript body");

    let resp = server.post("/api/sessions/search", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "query is required");

    let resp = server
        .post("/api/sessions/search", json!({"query": "missing query"}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["query"], "missing query");
    assert_eq!(body["count"], 0);
    assert!(body["hits"].as_array().expect("session hits").is_empty());

    let resp = server.get("/api/sessions/summaries").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["total"], 1);
    assert_eq!(body["summaries"][0]["id"], "summary-session-default");
    assert_eq!(body["summaries"][0]["agentId"], "default");

    let resp = server
        .get("/api/sessions/summaries?agent_id=other-agent")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["total"], 1);
    assert_eq!(body["summaries"][0]["id"], "summary-session-other-agent");
    assert_eq!(body["summaries"][0]["agentId"], "other-agent");

    let resp = server
        .get("/api/sessions/summaries?session_key=agent:other-agent:shared-summary-session")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["total"], 1);
    assert_eq!(body["summaries"][0]["id"], "summary-session-other-agent");

    let resp = server
        .post("/api/sessions/summaries/expand", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "id is required");

    let resp = server
        .post(
            "/api/sessions/summaries/expand",
            json!({"id": "missing-node"}),
        )
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "summary node not found");

    let resp = server
        .post(
            "/api/sessions/summaries/expand",
            json!({"id": "summary-session-other-agent"}),
        )
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "summary node not found");

    let resp = server
        .post(
            "/api/sessions/summaries/expand",
            json!({"id": "summary-session-other-agent", "agentId": "other-agent"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["summary"]["id"], "summary-session-other-agent");
    assert_eq!(body["summary"]["agentId"], "other-agent");
    assert_eq!(body["transcript"], "other-agent transcript body");

    let resp = server.get("/api/sessions/checkpoints").await;
    assert_eq!(resp.status(), 200);

    let resp = server
        .post("/api/sessions/missing-session/renew", json!({}))
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Session not found");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn session_bypass_replays_ts_validation_and_toggle_contract() {
    let server = TestServer::start().await;

    let resp = server
        .post("/api/sessions/missing-session/bypass", json!({}))
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Session not found");

    let resp = server
        .post(
            "/api/hooks/session-start",
            json!({
                "sessionKey": "bypass-replay",
                "harness": "contract-replay",
                "runtimePath": "plugin"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);

    let resp = server
        .post("/api/sessions/bypass-replay/bypass", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "enabled (boolean) is required");

    let resp = server
        .post(
            "/api/sessions/bypass-replay/bypass",
            json!({"enabled": "true"}),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "enabled (boolean) is required");

    let resp = server
        .post(
            "/api/sessions/bypass-replay/bypass",
            json!({"enabled": true}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["key"], "bypass-replay");
    assert_eq!(body["bypassed"], true);

    let resp = server.get("/api/sessions/bypass-replay").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["key"], "bypass-replay");
    assert_eq!(body["bypassed"], true);

    let resp = server
        .post(
            "/api/sessions/bypass-replay/bypass",
            json!({"enabled": false}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["key"], "bypass-replay");
    assert_eq!(body["bypassed"], false);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn checkpoint_extract_queues_summary_and_advances_cursor() {
    let server = TestServer::start().await;
    let session = "agent:ant:checkpoint-replay";
    let initial = "checkpoint replay transcript ".repeat(24);
    let extended = format!("{initial}{}", "second delta ".repeat(48));

    let first = server
        .post(
            "/api/hooks/session-checkpoint-extract",
            json!({
                "harness": "test",
                "sessionKey": session,
                "agentId": "ant",
                "project": "/workspace/signetai",
                "transcript": initial
            }),
        )
        .await;
    assert_eq!(first.status(), 200);
    let body = server.json(first).await;
    assert_eq!(body["queued"], true);
    assert!(body["jobId"].is_string());

    let replay = server
        .post(
            "/api/hooks/session-checkpoint-extract",
            json!({
                "harness": "test",
                "sessionKey": session,
                "agentId": "ant",
                "project": "/workspace/signetai",
                "transcript": initial
            }),
        )
        .await;
    assert_eq!(replay.status(), 200);
    let body = server.json(replay).await;
    assert_eq!(body["skipped"], true);

    let second = server
        .post(
            "/api/hooks/session-checkpoint-extract",
            json!({
                "harness": "test",
                "sessionKey": session,
                "agentId": "ant",
                "project": "/workspace/signetai",
                "transcript": extended
            }),
        )
        .await;
    assert_eq!(second.status(), 200);
    let body = server.json(second).await;
    assert_eq!(body["queued"], true);
    assert!(body["jobId"].is_string());

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    let jobs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM summary_jobs
             WHERE session_key = ?1 AND agent_id = 'ant' AND trigger = 'checkpoint_extract'",
            [session],
            |row| row.get(0),
        )
        .unwrap();
    let cursor: i64 = conn
        .query_row(
            "SELECT last_offset FROM session_extract_cursors
             WHERE session_key = ?1 AND agent_id = 'ant'",
            [session],
            |row| row.get(0),
        )
        .unwrap();
    let latest_len: i64 = conn
        .query_row(
            "SELECT length(transcript) FROM summary_jobs
             WHERE session_key = ?1 AND agent_id = 'ant' AND trigger = 'checkpoint_extract'
             ORDER BY created_at DESC LIMIT 1",
            [session],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(jobs, 2);
    assert_eq!(cursor, extended.len() as i64);
    assert_eq!(latest_len, (extended.len() - initial.len()) as i64);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn checkpoint_extract_guards_file_backed_transcript_paths() {
    let server = TestServer::start().await;
    let outside_path = server._tmpdir.path().join("outside-checkpoint.jsonl");
    std::fs::write(&outside_path, "outside checkpoint transcript ".repeat(24)).unwrap();

    let rejected = server
        .post(
            "/api/hooks/session-checkpoint-extract",
            json!({
                "harness": "test",
                "sessionKey": "agent:ant:checkpoint-path-rejected",
                "agentId": "ant",
                "transcriptPath": outside_path.display().to_string()
            }),
        )
        .await;
    assert_eq!(rejected.status(), 403);
    let body = server.json(rejected).await;
    assert_eq!(
        body["error"],
        "transcript_path outside allowed workspace roots"
    );

    let allowed_dir = std::path::Path::new("/tmp/signet");
    std::fs::create_dir_all(allowed_dir).unwrap();
    let allowed_path = allowed_dir.join(format!(
        "checkpoint-replay-{}-{}.jsonl",
        std::process::id(),
        server.port
    ));
    std::fs::write(&allowed_path, "allowed checkpoint transcript ".repeat(24)).unwrap();

    let accepted = server
        .post(
            "/api/hooks/session-checkpoint-extract",
            json!({
                "harness": "test",
                "sessionKey": "agent:ant:checkpoint-path-accepted",
                "agentId": "ant",
                "transcriptPath": allowed_path.display().to_string()
            }),
        )
        .await;
    let _ = std::fs::remove_file(&allowed_path);
    assert_eq!(accepted.status(), 200);
    let body = server.json(accepted).await;
    assert_eq!(body["queued"], true);
    assert!(body["jobId"].is_string());

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    let jobs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM summary_jobs
             WHERE session_key = 'agent:ant:checkpoint-path-accepted'
               AND agent_id = 'ant'
               AND trigger = 'checkpoint_extract'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(jobs, 1);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn version_endpoint() {
    let server = TestServer::start().await;
    let resp = server.get("/api/version").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["runtime"], "rust");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn diagnostics_endpoints() {
    let server = TestServer::start().await;

    let resp = server.get("/api/diagnostics").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body["status"].is_string());
    assert!(body["domains"].is_object());

    let resp = server.get("/api/diagnostics/storage").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/diagnostics/queue").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/diagnostics/index").await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn mcp_analytics_routes_replay_ts_shapes() {
    let server = TestServer::start().await;

    let resp = server.get("/api/mcp/analytics").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["totalCalls"], 0);
    assert_eq!(body["successRate"], 0.0);
    assert_eq!(body["topServers"], json!([]));
    assert_eq!(body["topTools"], json!([]));
    assert_eq!(body["latency"]["p50"], 0);
    assert_eq!(body["latency"]["p95"], 0);

    server.seed_mcp_analytics_fixture();

    let resp = server.get("/api/mcp/analytics?limit=1").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["totalCalls"], 4);
    assert_eq!(body["successRate"], 0.75);
    assert_eq!(body["topServers"].as_array().unwrap().len(), 1);
    assert_eq!(body["topServers"][0]["serverId"], "srv-a");
    assert_eq!(body["topServers"][0]["count"], 3);
    assert_eq!(body["topServers"][0]["successCount"], 2);
    assert_eq!(body["topServers"][0]["avgLatencyMs"], 200);
    assert_eq!(body["topTools"][0]["toolName"], "search");
    assert_eq!(body["topTools"][0]["count"], 2);
    assert_eq!(body["latency"]["p50"], 100);
    assert_eq!(body["latency"]["p95"], 300);

    let resp = server.get("/api/mcp/analytics?agent_id=agent-b").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["totalCalls"], 1);
    assert_eq!(body["topServers"][0]["serverId"], "srv-a");
    assert_eq!(body["topTools"][0]["toolName"], "search");

    let resp = server.get("/api/mcp/analytics/srv-a").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["serverId"], "srv-a");
    assert_eq!(body["totalCalls"], 3);
    assert_eq!(body["successRate"], 0.667);
    assert_eq!(body["tools"][0]["toolName"], "search");
    assert_eq!(body["tools"][0]["count"], 2);
    assert_eq!(body["tools"][1]["toolName"], "create");
    assert_eq!(body["tools"][1]["successCount"], 0);
    assert!(
        body["timeline"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["count"] == 3)
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn marketplace_endpoints() {
    let catalog_fixture = MarketplaceCatalogFixture::start();
    let _catalog_env = MarketplaceCatalogEnvGuard::set(&catalog_fixture.base);
    let server = TestServer::start().await;
    let fixture_script = server._tmpdir.path().join("mcp-fixture.sh");
    std::fs::write(
        &fixture_script,
        r#"#!/usr/bin/env bash
while IFS= read -r line; do
  if [[ "$line" == *'"id":1'* ]]; then
    echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"fixture","version":"1"}}}'
  elif [[ "$line" == *'"method":"tools/list"'* ]]; then
    echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"time_now","description":"Return current time","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]}}'
  elif [[ "$line" == *'"method":"tools/call"'* ]]; then
    echo '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"called time_now"}]}}'
  elif [[ "$line" == *'"method":"resources/read"'* ]]; then
    echo '{"jsonrpc":"2.0","id":2,"result":{"contents":[{"uri":"file:///tmp/example","text":"resource text"}]}}'
  fi
done
"#,
    )
    .expect("write MCP fixture script");

    let resp = server.get("/api/marketplace/mcp").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/marketplace/mcp/policy").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["policy"]["mode"], "hybrid");
    assert_eq!(body["policy"]["maxExpandedTools"], 12);
    assert_eq!(body["policy"]["maxSearchResults"], 8);

    let resp = server
        .patch("/api/marketplace/mcp/policy", json!({"mode": "invalid"}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "mode must be compact, hybrid, or expanded");

    let resp = server
        .patch_raw_json("/api/marketplace/mcp/policy", "{")
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Invalid JSON body");

    let resp = server
        .patch(
            "/api/marketplace/mcp/policy",
            json!({
                "mode": "expanded",
                "maxExpandedTools": 151.6,
                "maxSearchResults": -4.2
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["policy"]["mode"], "expanded");
    assert_eq!(body["policy"]["maxExpandedTools"], 100);
    assert_eq!(body["policy"]["maxSearchResults"], 1);

    let resp = server
        .patch(
            "/api/marketplace/mcp/policy",
            json!({
                "mode": "hybrid",
                "maxExpandedTools": 12,
                "maxSearchResults": 8
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["policy"]["mode"], "hybrid");
    assert_eq!(body["policy"]["maxExpandedTools"], 12);
    assert_eq!(body["policy"]["maxSearchResults"], 8);

    let resp = server.get("/api/marketplace/mcp/tools").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/marketplace/mcp/search").await;
    assert_eq!(resp.status(), 400);

    let resp = server.get("/api/marketplace/mcp/search?q=time").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/marketplace/mcp/browse?pages=1").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["total"], 3);
    assert_eq!(body["shown"], 3);
    assert_eq!(body["pageSize"], 30);
    assert_eq!(body["pages"], 1);
    assert_eq!(body["results"][0]["source"], "modelcontextprotocol/servers");
    assert_eq!(body["results"][0]["catalogId"], "fetch");
    assert_eq!(body["results"][0]["installed"], false);
    assert!(
        body["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["catalogId"] == "web-fetch")
    );

    let resp = server
        .get("/api/marketplace/mcp/detail?id=github:signet/catalog-mcp")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["source"], "github");
    assert_eq!(body["id"], "signet/catalog-mcp");
    assert_eq!(body["name"], "catalog");
    assert_eq!(body["description"], "Catalog detail description.");
    assert_eq!(body["githubUrl"], "https://github.com/signet/catalog-mcp");
    assert_eq!(body["defaultConfig"]["transport"], "stdio");
    assert_eq!(body["defaultConfig"]["command"], "uvx");
    assert_eq!(body["defaultConfig"]["args"][0], "catalog-mcp");

    let resp = server
        .post(
            "/api/marketplace/mcp/install",
            json!({
                "id": "github:signet/catalog-mcp",
                "scope": {"harnesses": ["catalog-replay"]}
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["updated"], false);
    assert_eq!(body["server"]["id"], "catalog");
    assert_eq!(body["server"]["description"], "Catalog detail description.");
    assert_eq!(body["server"]["config"]["command"], "uvx");

    let install_body = json!({
        "id": "github:signet/fixture-mcp",
        "alias": "Fixture MCP",
        "config": {
            "command": ["bash", fixture_script.display().to_string()],
            "args": [],
            "env": {"FIXTURE_ENV": "1"}
        },
        "scope": {"harnesses": ["contract-replay"]}
    });
    let resp = server
        .post("/api/marketplace/mcp/install", install_body)
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["updated"], false);
    assert_eq!(body["server"]["id"], "fixture-mcp");
    assert_eq!(body["server"]["source"], "github");
    assert_eq!(body["server"]["catalogId"], "signet/fixture-mcp");
    assert_eq!(body["server"]["config"]["transport"], "stdio");
    assert_eq!(body["server"]["config"]["command"], "bash");
    assert_eq!(
        body["server"]["config"]["args"][0],
        fixture_script.display().to_string()
    );
    let installed_path = server._tmpdir.path().join("marketplace/mcp-servers.json");
    let installed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(installed_path).unwrap()).unwrap();
    let fixture_server = installed
        .as_array()
        .unwrap()
        .iter()
        .find(|server| server["id"] == "fixture-mcp")
        .expect("fixture MCP server persisted");
    assert_eq!(fixture_server["scope"]["harnesses"][0], "contract-replay");

    let resp = server
        .get("/api/marketplace/mcp/tools?harness=contract-replay")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["tools"][0]["serverId"], "fixture-mcp");
    assert_eq!(body["tools"][0]["toolName"], "time_now");
    assert_eq!(body["tools"][0]["readOnly"], true);
    assert_eq!(body["servers"][0]["ok"], true);

    let resp = server
        .get("/api/marketplace/mcp/search?q=time&harness=contract-replay")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["results"][0]["toolName"], "time_now");

    let resp = server
        .post(
            "/api/marketplace/mcp/test",
            json!({"config": {"command": ["bash", fixture_script.display().to_string()]}}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["toolCount"], 1);
    assert_eq!(body["tools"][0], "time_now");

    let resp = server
        .post(
            "/api/marketplace/mcp/call?harness=contract-replay",
            json!({"serverId": "fixture-mcp", "toolName": "time_now", "args": {}}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["result"]["content"][0]["text"], "called time_now");

    let resp = server
        .post(
            "/api/marketplace/mcp/read-resource?harness=contract-replay",
            json!({"serverId": "fixture-mcp", "uri": "file:///tmp/example"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["contents"]["contents"][0]["text"], "resource text");

    let body = call_mcp_tool(&server, "mcp_server_list", json!({})).await;
    assert_eq!(body["count"], 1);
    assert!(
        body["servers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|server| server["serverId"] == "fixture-mcp" && server["ok"] == true)
    );

    let body = call_mcp_tool(
        &server,
        "mcp_server_search",
        json!({"query": "time", "limit": 3}),
    )
    .await;
    assert_eq!(body["query"], "time");
    assert_eq!(body["count"], 1);
    assert_eq!(body["results"][0]["toolName"], "time_now");

    let body = call_mcp_tool(
        &server,
        "mcp_server_call",
        json!({"server_id": "fixture-mcp", "tool": "time_now", "args": {}}),
    )
    .await;
    assert_eq!(body["content"][0]["text"], "called time_now");

    let body = call_mcp_tool(&server, "mcp_server_policy_get", json!({})).await;
    assert_eq!(body["policy"]["mode"], "hybrid");
    let body = call_mcp_tool(
        &server,
        "mcp_server_policy_set",
        json!({"mode": "compact", "max_search_results": 4}),
    )
    .await;
    assert_eq!(body["success"], true);
    assert_eq!(body["policy"]["mode"], "compact");
    assert_eq!(body["policy"]["maxSearchResults"], 4);

    let body = call_mcp_tool(
        &server,
        "mcp_server_scope_set",
        json!({"server_id": "fixture-mcp", "harnesses": ["contract-replay", "mcp-tool"]}),
    )
    .await;
    assert_eq!(body["success"], true);
    assert_eq!(body["server"]["scope"]["harnesses"][1], "mcp-tool");
    let body = call_mcp_tool(
        &server,
        "mcp_server_scope_get",
        json!({"server_id": "fixture-mcp"}),
    )
    .await;
    assert_eq!(body["server"]["scope"]["harnesses"][1], "mcp-tool");

    let body = call_mcp_tool(
        &server,
        "mcp_server_disable",
        json!({"server_id": "fixture-mcp"}),
    )
    .await;
    assert_eq!(body["success"], true);
    assert_eq!(body["server"]["enabled"], false);
    let body = call_mcp_tool(
        &server,
        "mcp_server_enable",
        json!({"server_id": "fixture-mcp"}),
    )
    .await;
    assert_eq!(body["success"], true);
    assert_eq!(body["server"]["enabled"], true);

    let resp = server.get("/api/marketplace/mcp/dogfood-everything").await;
    assert_eq!(resp.status(), 404);

    let resp = server
        .post(
            "/api/marketplace/mcp/call",
            json!({"serverId": "missing", "toolName": "missing", "args": {}}),
        )
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Server not found, disabled, or out of scope");

    let resp = server
        .post("/api/marketplace/mcp/read-resource", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "serverId and uri are required");

    let resp = server
        .post(
            "/api/marketplace/mcp/read-resource",
            json!({"serverId": "missing", "uri": "file:///tmp/example"}),
        )
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Server not found, disabled, or out of scope");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn os_routes_replay_empty_state_and_validation_shapes() {
    let server = TestServer::start().await;

    let resp = server.get("/api/os/events?limit=999&windowMs=1").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["events"], json!([]));
    assert_eq!(body["count"], 0);
    assert_eq!(body["query"]["limit"], 500);
    assert_eq!(body["query"]["windowMs"], 1000);

    let resp = server
        .get("/api/os/events/stream?type=browser.navigate")
        .await;
    assert_eq!(resp.status(), 200);
    let text = resp.text().await.expect("os events stream body");
    assert!(text.contains("\"type\":\"connected\""));
    assert!(text.contains("\"subscribedTo\":\"browser.navigate\""));

    let resp = server.get("/api/os/context").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["events"], json!([]));

    let resp = server.get("/api/os/events/stats").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/os/agent-sessions").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["sessions"], json!([]));
    assert_eq!(body["count"], 0);

    let resp = server.get("/api/os/agent-events").await;
    assert_eq!(resp.status(), 200);
    let text = resp.text().await.expect("os agent stream body");
    assert!(text.contains("\"type\":\"connected\""));

    let resp = server.post("/api/os/agent-execute", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "serverId and task are required");

    let resp = server
        .post(
            "/api/os/agent-execute",
            json!({"serverId": "browser", "task": "Open the settings panel"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let session_id = body["sessionId"].as_str().expect("session id");
    assert!(session_id.starts_with("agent-"));
    assert_eq!(body["serverId"], "browser");

    let resp = server
        .post(
            "/api/os/agent-execute",
            json!({"serverId": "browser", "task": "Start another task"}),
        )
        .await;
    assert_eq!(resp.status(), 409);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"],
        "An agent session is already running for this server"
    );

    let resp = server.get("/api/os/agent-sessions").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["sessions"][0]["id"], session_id);
    assert_eq!(body["sessions"][0]["serverId"], "browser");
    assert_eq!(body["sessions"][0]["task"], "Open the settings panel");
    assert_eq!(body["sessions"][0]["status"], "running");

    let resp = server.post("/api/os/agent-state", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "sessionId is required");

    let resp = server
        .post(
            "/api/os/agent-state",
            json!({"sessionId": session_id, "domState": {"url": "http://localhost"}}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);

    let resp = server
        .post("/api/os/agent-state", json!({"sessionId": "missing"}))
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Session not found");

    let resp = server.post("/api/os/chat", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Message is required");

    let resp = server.get("/api/os/tray").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["entries"], json!([]));
    assert_eq!(body["count"], 0);

    let resp = server.get("/api/os/tray/missing").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "App not found in tray");

    let resp = server.get("/api/os/tray/missing/probe").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "No probe result found");

    let resp = server.post("/api/os/tray/missing/reprobe", json!({})).await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Server not found in installed servers");

    let resp = server
        .patch("/api/os/tray/missing", json!({"state": "bad"}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "state must be tray, grid, or dock");

    let resp = server.post("/api/os/install", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["ok"], false);
    assert_eq!(body["error"], "url is required");

    let resp = server
        .post(
            "/api/os/install",
            json!({"url": "http://127.0.0.1:3850/mcp"}),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["ok"], false);
    assert_eq!(body["error"], "Private/loopback addresses are not allowed");

    let resp = server
        .post(
            "/api/os/install",
            json!({"url": "https://example.com/mcp", "name": "Example MCP"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["widgetId"], "example-mcp");
    assert_eq!(body["manifest"], serde_json::Value::Null);
    let installed: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(server._tmpdir.path().join("marketplace/mcp-servers.json"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(installed[0]["id"], "example-mcp");
    assert_eq!(installed[0]["source"], "manual");
    assert_eq!(installed[0]["config"]["transport"], "http");
    assert_eq!(installed[0]["config"]["url"], "https://example.com/mcp");

    let resp = server.post("/api/os/widget/generate", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "serverId is required");

    let resp = server.get("/api/os/widget/missing").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Widget not found");

    let resp = server.delete("/api/os/widget/missing").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn secrets_list() {
    let server = TestServer::start().await;

    let resp = server
        .post(
            "/api/secrets/REPLAY_SECRET",
            json!({"value": "replay-value"}),
        )
        .await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/secrets").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["secrets"], json!(["REPLAY_SECRET"]));

    let body = call_mcp_tool(&server, "secret_list", json!({})).await;
    assert_eq!(body["secrets"], json!(["REPLAY_SECRET"]));

    for body in [
        json!({}),
        json!({"command": {}, "secrets": {"REPLAY_SECRET": "REPLAY_SECRET"}}),
        json!({"command": "   ", "secrets": {"REPLAY_SECRET": "REPLAY_SECRET"}}),
    ] {
        let resp = server.post("/api/secrets/exec", body).await;
        assert_eq!(resp.status(), 400);
        let body = server.json(resp).await;
        assert_eq!(body["error"], "command is required");
    }

    for secrets in [
        json!({}),
        json!([]),
        json!("REPLAY_SECRET"),
        json!({"REPLAY_SECRET": ""}),
    ] {
        let resp = server
            .post(
                "/api/secrets/exec",
                json!({"command": "bun --version", "secrets": secrets}),
            )
            .await;
        assert_eq!(resp.status(), 400);
        let body = server.json(resp).await;
        assert_eq!(body["error"], "non-empty secrets map is required");
    }

    let resp = server
        .post(
            "/api/secrets/exec",
            json!({
                "command": "printf %s \"$REPLAY_SECRET\"",
                "secrets": {"REPLAY_SECRET": "REPLAY_SECRET"},
                "timeoutMs": "bad",
            }),
        )
        .await;
    assert_eq!(resp.status(), 202);
    let body = server.json(resp).await;
    let job_id = body["id"].as_str().expect("secret exec job id");
    assert_eq!(body["timeoutMs"], 300000);
    assert!(matches!(
        body["status"].as_str(),
        Some("queued") | Some("running")
    ));

    let mut completed = serde_json::Value::Null;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(25)).await;
        let resp = server.get(&format!("/api/secrets/exec/{job_id}")).await;
        assert_eq!(resp.status(), 200);
        completed = server.json(resp).await;
        if completed["status"] == "completed" {
            break;
        }
    }
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["result"]["code"], 0);
    assert_eq!(completed["result"]["stdout"], "[REDACTED]");
    assert!(
        !completed["result"]["stdout"]
            .as_str()
            .unwrap_or_default()
            .contains("replay-value")
    );

    let body = call_mcp_tool(
        &server,
        "secret_exec",
        json!({
            "command": "printf %s \"$REPLAY_SECRET\"",
            "secrets": {"REPLAY_SECRET": "REPLAY_SECRET"},
            "timeoutSeconds": 1,
        }),
    )
    .await;
    let mcp_job_id = body["id"].as_str().expect("MCP secret exec job id");
    assert!(matches!(
        body["status"].as_str(),
        Some("queued") | Some("running")
    ));
    let mut mcp_completed = serde_json::Value::Null;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(25)).await;
        mcp_completed =
            call_mcp_tool(&server, "secret_exec_status", json!({"jobId": mcp_job_id})).await;
        if mcp_completed["status"] == "completed" {
            break;
        }
    }
    assert_eq!(mcp_completed["status"], "completed");
    assert_eq!(mcp_completed["result"]["code"], 0);
    assert_eq!(mcp_completed["result"]["stdout"], "[REDACTED]");

    let resp = server.get("/api/secrets/1password/status").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["configured"], false);
    assert_eq!(body["connected"], false);
    assert_eq!(body["vaults"], json!([]));

    let resp = server.get("/api/secrets/bitwarden/status").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["configured"], false);
    assert_eq!(body["connected"], false);
    assert_eq!(body["activeProvider"], false);

    let resp = server
        .post("/api/secrets/bitwarden/connect", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "session is required");

    let resp = server
        .post(
            "/api/secrets/bitwarden/connect",
            json!({"session": "fake-bw-session", "activate": true, "folderId": "folder-1"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["connected"], true);
    assert_eq!(body["activeProvider"], true);
    assert_eq!(body["userEmail"], "replay@example.com");

    let resp = server.get("/api/secrets/bitwarden/status").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["configured"], true);
    assert_eq!(body["connected"], true);
    assert_eq!(body["activeProvider"], true);
    assert_eq!(body["folders"][0]["name"], "Replay Folder");

    let resp = server
        .post(
            "/api/secrets/bitwarden/provider",
            json!({"provider": "bad"}),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "provider must be local or bitwarden");

    let resp = server
        .post(
            "/api/secrets/bitwarden/provider",
            json!({"provider": "local"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["provider"], "local");

    let resp = server
        .post(
            "/api/secrets/bitwarden/provider",
            json!({"provider": "bitwarden"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["provider"], "bitwarden");

    let resp = server.get("/api/secrets/bitwarden/folders").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["folders"][0]["id"], "folder-1");

    let resp = server
        .post(
            "/api/secrets/bitwarden/migrate",
            json!({"dryRun": true, "folderId": "folder-1"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["dryRun"], true);
    assert!(body["skippedCount"].as_i64().unwrap_or_default() >= 1);

    let resp = server.delete("/api/secrets/bitwarden/connect").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["disconnected"], true);

    let resp = server
        .post("/api/secrets/1password/connect", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "token is required");

    let resp = server
        .post(
            "/api/secrets/1password/connect",
            json!({"token": "fake-op-token"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["connected"], true);
    assert_eq!(body["vaultCount"], 1);
    assert_eq!(body["vaults"][0]["name"], "Replay Vault");

    let resp = server.get("/api/secrets/1password/status").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["configured"], true);
    assert_eq!(body["connected"], true);

    let resp = server.get("/api/secrets/1password/vaults").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["vaults"][0]["id"], "vault-1");

    let resp = server
        .post(
            "/api/secrets/1password/import",
            json!({"vaults": ["vault-1"], "prefix": "OP", "overwrite": true}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["vaultsScanned"], 1);
    assert_eq!(body["itemsScanned"], 1);
    assert_eq!(body["importedCount"], 1);
    assert_eq!(
        body["imported"][0]["secretName"],
        "OP_REPLAY_VAULT_DATABASE_PASSWORD"
    );

    let resp = server.delete("/api/secrets/1password/connect").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["disconnected"], true);

    let resp = server.get("/api/secrets/exec/missing-job").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "secret exec job not found");

    let resp = server.post("/api/secrets/API_KEY/exec", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "command is required");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn tasks_crud() {
    let server = TestServer::start().await;

    let resp = server.get("/api/tasks").await;
    assert_eq!(resp.status(), 200);

    let resp = server.post("/api/tasks", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"],
        "name, prompt, cronExpression, and harness are required"
    );

    let base_task = json!({
        "name": "Replay task",
        "prompt": "Run replay",
        "cronExpression": "*/15 * * * *",
        "harness": "codex"
    });

    let mut invalid_cron = base_task.clone();
    invalid_cron["cronExpression"] = json!("not a cron");
    let resp = server.post("/api/tasks", invalid_cron).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Invalid cron expression");

    let mut invalid_harness = base_task.clone();
    invalid_harness["harness"] = json!("unknown");
    let resp = server.post("/api/tasks", invalid_harness).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"],
        "harness must be 'claude-code', 'codex', or 'opencode'"
    );

    let mut invalid_skill = base_task.clone();
    invalid_skill["skillName"] = json!("../bad");
    invalid_skill["skillMode"] = json!("inject");
    let resp = server.post("/api/tasks", invalid_skill).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Invalid skill name");

    let mut invalid_skill_mode = base_task.clone();
    invalid_skill_mode["skillName"] = json!("good-skill");
    invalid_skill_mode["skillMode"] = json!("bad");
    let resp = server.post("/api/tasks", invalid_skill_mode).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"],
        "skillMode must be 'inject' or 'slash' when skillName is set"
    );

    let resp = server.get("/api/tasks/missing-task").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Task not found");

    let resp = server.patch("/api/tasks/missing-task", json!({})).await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Task not found");

    let resp = server.post("/api/tasks/missing-task/run", json!({})).await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Task not found");

    let resp = server.get("/api/tasks/missing-task/runs").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["runs"], json!([]));
    assert_eq!(body["total"], 0);
    assert_eq!(body["hasMore"], false);

    let resp = server.delete("/api/tasks/missing-task").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);

    let resp = server.get("/api/tasks/missing-task/stream").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Task not found");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn git_status() {
    let server = TestServer::start().await;
    let resp = server.get("/api/git/status").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(
        body.get("configured").is_some()
            || body.get("branch").is_some()
            || body.get("error").is_some()
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn connectors_list() {
    let server = TestServer::start().await;
    let resp = server.get("/api/connectors").await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn connectors_unwrap_ts_style_config_settings() {
    let server = TestServer::start().await;
    server.seed_ts_style_connector_with_nested_settings();

    let resp = server.get("/api/connectors").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    let connector = &body["connectors"][0];
    assert_eq!(connector["settings"]["vault"], "/tmp/vault");
    assert_eq!(connector["settings"]["indexHidden"], true);
    assert!(connector["settings"].get("settings").is_none());
    assert_eq!(connector["display_name"], "Obsidian");
    assert_eq!(connector["status"], "idle");
    assert_eq!(
        connector["config_json"]
            .as_str()
            .unwrap()
            .contains("connector-ts-full-config"),
        true
    );
    assert_eq!(
        connector["settings_json"]
            .as_str()
            .unwrap()
            .contains("/tmp/vault"),
        true
    );

    let resp = server.get("/api/connectors/connector-ts-full-config").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["settings"]["vault"], "/tmp/vault");
    assert_eq!(body["settings"]["indexHidden"], true);
    assert!(body["settings"].get("settings").is_none());
    assert_eq!(body["display_name"], "Obsidian");
    assert_eq!(
        body["config_json"]
            .as_str()
            .unwrap()
            .contains("connector-ts-full-config"),
        true
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn connector_health_and_sync_routes_replay_ts_outcomes() {
    let server = TestServer::start().await;
    server.seed_gdrive_connector_health_fixture();

    let resp = server.get("/api/connectors/connector-gdrive/health").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["id"], "connector-gdrive");
    assert_eq!(body["status"], "idle");
    assert_eq!(body["lastSyncAt"], "2026-01-01T00:00:00Z");
    assert_eq!(body["lastError"], serde_json::Value::Null);
    assert_eq!(body["documentCount"], 2);

    let resp = server.get("/api/connectors/missing/health").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Connector not found");

    let resp = server
        .post("/api/connectors/connector-gdrive/sync", json!({}))
        .await;
    assert_eq!(resp.status(), 501);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Provider gdrive not yet supported");

    let resp = server
        .post("/api/connectors/connector-gdrive/sync/full", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Full resync requires ?confirm=true");

    let resp = server
        .post(
            "/api/connectors/connector-gdrive/sync/full?confirm=true",
            json!({}),
        )
        .await;
    assert_eq!(resp.status(), 501);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Provider gdrive not yet supported");

    let resp = server.post("/api/connectors/resync", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["status"], "ok");
    assert_eq!(body["total"], 1);
    assert_eq!(body["started"], 0);
    assert_eq!(body["alreadySyncing"], 0);
    assert_eq!(body["unsupported"], 1);
    assert_eq!(body["failed"], 0);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn connectors_delete_replays_ts_missing_and_cascade_contract() {
    let server = TestServer::start().await;
    server.seed_gdrive_connector_health_fixture();

    let resp = server.get("/api/connectors/missing-connector").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Connector not found");

    let resp = server.delete("/api/connectors/missing-connector").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Connector not found");

    let resp = server
        .delete("/api/connectors/connector-gdrive?cascade=true")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["deleted"], true);

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    let connector_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM connectors WHERE id = 'connector-gdrive'",
            [],
            |row| row.get(0),
        )
        .expect("connector count");
    assert_eq!(connector_count, 0);

    let root_docs: Vec<(String, String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, status, error
                 FROM documents
                 WHERE id IN ('doc-vault-a', 'doc-vault-b')
                 ORDER BY id",
            )
            .expect("prepare root docs query");
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query root docs")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect root docs")
    };
    assert_eq!(
        root_docs,
        vec![
            (
                "doc-vault-a".to_string(),
                "deleted".to_string(),
                "Connector removed".to_string()
            ),
            (
                "doc-vault-b".to_string(),
                "deleted".to_string(),
                "Connector removed".to_string()
            ),
        ]
    );

    let other: (String, Option<String>) = conn
        .query_row(
            "SELECT status, error FROM documents WHERE id = 'doc-other'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("other document");
    assert_eq!(other, ("queued".to_string(), None));
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn filesystem_connector_sync_replays_ts_document_ingest_side_effects() {
    let server = TestServer::start().await;
    let root = server.seed_filesystem_connector_sync_fixture();

    let resp = server
        .post("/api/connectors/connector-fs-row/sync", json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["status"], "syncing");

    let snapshot = wait_for_filesystem_connector_sync(&server).await;
    assert_eq!(snapshot["connectorStatus"], "idle");
    assert!(
        snapshot["cursorJson"]
            .as_str()
            .unwrap()
            .contains("lastSyncAt")
    );
    assert!(snapshot["lastSyncAt"].as_str().unwrap().contains('T'));
    assert_eq!(snapshot["title"], "a.md");
    assert_eq!(
        snapshot["rawContent"],
        "Filesystem connector replay content from a Markdown file."
    );
    assert_eq!(snapshot["documentConnectorId"], "connector-fs-config");
    assert_eq!(snapshot["jobStatus"], "pending");
    assert_eq!(snapshot["jobType"], "document_ingest");
    assert_eq!(snapshot["documentCount"], 1);
    assert_eq!(snapshot["documentIngestJobCount"], 1);
    assert_eq!(
        snapshot["sourceUrl"],
        root.join("notes/a.md").to_string_lossy().to_string()
    );
    let payload =
        serde_json::from_str::<serde_json::Value>(snapshot["jobPayload"].as_str().unwrap())
            .unwrap();
    assert_eq!(payload["documentId"], snapshot["documentId"]);
    assert_eq!(
        payload["content"],
        "Filesystem connector replay content from a Markdown file."
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn connectors_list_surfaces_row_decode_errors() {
    let server = TestServer::start().await;
    server.seed_malformed_connector_row();

    let resp = server.get("/api/connectors").await;
    assert_eq!(resp.status(), 500);
    let body = server.json(resp).await;
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("database error"),
        "{body}"
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn documents_list() {
    let server = TestServer::start().await;
    let resp = server.get("/api/documents").await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn documents_delete_replays_ts_soft_delete_contract() {
    let server = TestServer::start().await;
    server.seed_document_delete_fixture();

    let resp = server.delete("/api/documents/doc-delete-replay").await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "reason query parameter is required");

    let resp = server
        .delete("/api/documents/missing-document?reason=replay")
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Document not found");

    let resp = server
        .delete("/api/documents/doc-delete-replay?reason=replay")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["deleted"], true);
    assert_eq!(body["memoriesRemoved"], 1);

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    let doc: (String, String) = conn
        .query_row(
            "SELECT status, error FROM documents WHERE id = 'doc-delete-replay'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("document row");
    assert_eq!(doc, ("deleted".to_string(), "replay".to_string()));
    let active: (i64, String, String, i64) = conn
        .query_row(
            "SELECT is_deleted, deleted_at, updated_by, version
             FROM memories WHERE id = 'mem-doc-delete-active'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("active linked memory");
    assert_eq!(active.0, 1);
    assert!(!active.1.is_empty());
    assert_eq!(active.2, "document-api");
    assert_eq!(active.3, 2);
    let already_deleted_version: i64 = conn
        .query_row(
            "SELECT version FROM memories WHERE id = 'mem-doc-delete-already'",
            [],
            |row| row.get(0),
        )
        .expect("already deleted linked memory");
    assert_eq!(already_deleted_version, 4);
    let history: (String, String) = conn
        .query_row(
            "SELECT changed_by, reason FROM memory_history
             WHERE memory_id = 'mem-doc-delete-active' AND event = 'deleted'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("document delete history");
    assert_eq!(history.0, "document-api");
    assert_eq!(history.1, "Document deleted: replay");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn update_status() {
    let server = TestServer::start().await;
    let resp = server.get("/api/update").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["available"], false);

    let resp = server.get("/api/update/check").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["updateAvailable"], false);
    assert_eq!(body["restartRequired"], false);
    assert_eq!(body["latestVersion"], env!("CARGO_PKG_VERSION"));
    assert!(body["checkedAt"].as_str().is_some());

    let resp = server.get("/api/update/check").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["cached"], true);

    let resp = server.get("/api/update/config").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["autoInstall"], false);
    assert_eq!(body["checkInterval"], 21600);
    assert_eq!(body["channel"], "stable");
    assert_eq!(body["minInterval"], 300);
    assert_eq!(body["maxInterval"], 604800);
    assert_eq!(body["updateInProgress"], false);

    let resp = server
        .post("/api/update/config", json!({"channel": "beta"}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["success"], false);
    assert_eq!(body["error"], "channel must be stable or nightly");

    let resp = server
        .post(
            "/api/update/config",
            json!({"autoInstall": true, "checkInterval": 300, "channel": "stable"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["persisted"], true);
    assert_eq!(body["config"]["autoInstall"], true);
    assert_eq!(body["config"]["checkInterval"], 300);
    assert_eq!(body["config"]["channel"], "stable");
    let persisted = std::fs::read_to_string(server._tmpdir.path().join("agent.yaml")).unwrap();
    assert!(
        persisted
            .contains("updates:\n  auto_install: true\n  check_interval: 300\n  channel: stable\n")
    );

    let resp = server.post("/api/update/run", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["restartRequired"], false);

    let resp = server
        .post("/api/update/run", json!({"targetVersion": "not-semver"}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "Invalid targetVersion 'not-semver'");

    let resp = server
        .post("/api/update/run", json!({"targetVersion": "v0.139.0"}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["installedVersion"], "0.139.0");
    assert_eq!(body["restartRequired"], true);

    let resp = server.get("/api/update").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["restartRequired"], true);
    assert_eq!(body["pendingVersion"], "0.139.0");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn logs_endpoint() {
    let server = TestServer::start().await;
    let resp = server.get("/api/logs").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/logs/stream").await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default(),
        "text/event-stream"
    );
    let text = resp.text().await.expect("logs stream body");
    assert!(text.contains("\"type\":\"connected\""));
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn mcp_endpoint() {
    let server = TestServer::start().await;
    let initialize = json!({
        "jsonrpc": "2.0",
        "method": "initialize",
        "id": 1,
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "0.1.0"}
        }
    });

    let resp = server.post("/mcp", initialize.clone()).await;
    assert_eq!(resp.status(), 406);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"]["message"],
        "Not Acceptable: Client must accept both application/json and text/event-stream"
    );

    let resp = server.post_mcp(json!({ "jsonrpc": "2.0", "id": 1 })).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"]["code"], -32700);
    assert_eq!(
        body["error"]["message"],
        "Parse error: Invalid JSON-RPC message"
    );

    let resp = server.post_mcp_raw("{").await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"]["code"], -32700);
    assert_eq!(body["error"]["message"], "Parse error: Invalid JSON");

    let resp = server.post_mcp(initialize).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(body["result"]["capabilities"]["tools"]["listChanged"], true);
    assert_eq!(body["result"]["serverInfo"]["name"], "signet");

    let stored = call_mcp_tool(
        &server,
        "memory_store",
        json!({
            "content": "MCP modify replay original content.",
            "type": "fact",
            "importance": 0.4
        }),
    )
    .await;
    let memory_id = stored["id"].as_str().expect("stored memory id").to_string();
    let modified = call_mcp_tool(
        &server,
        "memory_modify",
        json!({
            "id": memory_id,
            "content": "MCP modify replay updated content.",
            "importance": 0.8,
            "pinned": true,
            "reason": "contract replay update"
        }),
    )
    .await;
    assert_eq!(modified["status"], "updated");
    assert_eq!(modified["contentChanged"], true);

    let fetched = call_mcp_tool(&server, "memory_get", json!({"id": memory_id})).await;
    assert_eq!(fetched["content"], "MCP modify replay updated content.");
    assert_eq!(fetched["importance"], 0.8);
    assert_eq!(fetched["pinned"], true);
}

const PROMPT_SUBMIT_CONTEXT_BUDGET_YAML: &str = r#"agent:
  name: test-agent
  version: 1
hooks: {}
memory:
  pipelineV2:
    guardrails:
      contextBudgetChars: 4000
"#;

const PROMPT_SUBMIT_DISABLED_YAML: &str = r#"agent:
  name: test-agent
  version: 1
hooks:
  userPromptSubmit:
    enabled: false
"#;

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn hook_session_lifecycle() {
    let server = TestServer::start_with_agent_yaml(None, PROMPT_SUBMIT_CONTEXT_BUDGET_YAML).await;

    // session-start
    let resp = server
        .post(
            "/api/hooks/session-start",
            json!({
                "sessionKey": "test-session-001",
                "harness": "claude-code",
                "runtimePath": "plugin"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body.get("inject").is_some());

    server.seed_prompt_submit_entity_context_fixture();

    // prompt-submit
    let resp = server
        .post(
            "/api/hooks/user-prompt-submit",
            json!({
                "sessionKey": "test-session-001",
                "harness": "claude-code",
                "agentId": "agent-a",
                "userMessage": "Should SignetAI prompt context include current views?"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["engine"], "entity-context");
    assert_eq!(body["memoryCount"], 1);
    assert!(
        body["queryTerms"]
            .as_str()
            .expect("prompt query terms")
            .contains("prompt context")
    );
    let inject = body["inject"].as_str().expect("prompt inject");
    assert!(inject.contains("## Relevant Entity Context"));
    assert!(inject.contains("## Plugin Context"));
    assert!(inject.contains(
        "<signet-plugin-context plugin=\"signet.secrets\" id=\"signet.secrets.credential-guidance\" target=\"user-prompt-submit\">"
    ));
    assert!(inject.contains("prefer storing them in Signet Secrets rather than chat"));
    assert!(
        inject.contains("Signet / architecture / runtime / prompt_context"),
        "inject:\n{inject}"
    );
    assert!(inject.contains("Prompt context should come from entity current views."));
    assert!(!inject.contains("general / uncategorized"));
    assert!(!inject.contains("Prompt context junk from general uncategorized"));
    assert!(!inject.contains("Stale prompt context should not be injected."));

    // session-end
    let resp = server
        .post(
            "/api/hooks/session-end",
            json!({
                "sessionKey": "test-session-001",
                "harness": "claude-code",
                "transcript": "User: test prompt\nAssistant: acknowledged"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn hook_user_prompt_submit_disabled_respects_config() {
    let server = TestServer::start_with_agent_yaml(None, PROMPT_SUBMIT_DISABLED_YAML).await;
    server.seed_prompt_submit_entity_context_fixture();

    let resp = server
        .post(
            "/api/hooks/user-prompt-submit",
            json!({
                "sessionKey": "test-session-disabled",
                "harness": "claude-code",
                "agentId": "agent-a",
                "userMessage": "Should SignetAI prompt context include current views?"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["engine"], "disabled");
    assert_eq!(body["memoryCount"], 0);
    assert_eq!(body["inject"], "");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn synthesis_hooks_replay_projection_and_status_shapes() {
    let server = TestServer::start().await;

    let resp = server.get("/api/hooks/synthesis/config").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body["enabled"].is_boolean());
    assert!(body["provider"].is_string());
    assert!(body["model"].is_string());

    let resp = server.get("/api/synthesis/status").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body["running"].is_boolean());
    assert_eq!(body["lastRunAt"], serde_json::Value::Null);
    assert!(body["config"].is_object());

    let resp = server
        .post("/api/hooks/synthesis", json!({"trigger": "manual"}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["harness"], "daemon");
    assert_eq!(body["model"], "projection");
    assert!(body["prompt"].is_string());
    assert!(body["fileCount"].is_number());
    assert!(body["indexBlock"].is_string());

    let resp = server
        .post("/api/hooks/synthesis/complete", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "content is required");

    let resp = server
        .post(
            "/api/hooks/synthesis/complete",
            json!({"content": "# MEMORY\n"}),
        )
        .await;
    assert_eq!(resp.status(), 503);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Synthesis worker not running");

    let resp = server.post("/api/synthesis/trigger", json!({})).await;
    assert_eq!(resp.status(), 503);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Synthesis worker not running");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn dream_routes_replay_status_and_inactive_worker_shapes() {
    let server = TestServer::start().await;

    let resp = server.get("/api/dream/status?agentId=agent-dream").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["enabled"], false);
    assert_eq!(body["worker"]["running"], false);
    assert_eq!(body["worker"]["active"], false);
    assert_eq!(body["worker"]["activeAgentId"], serde_json::Value::Null);
    assert_eq!(body["state"]["tokensSinceLastPass"], 0);
    assert_eq!(body["state"]["consecutiveFailures"], 0);
    assert_eq!(body["state"]["lastPassAt"], serde_json::Value::Null);
    assert_eq!(body["config"]["tokenThreshold"], 100000);
    assert_eq!(body["config"]["backfillOnFirstRun"], true);
    assert!(
        body["passes"]
            .as_array()
            .expect("dreaming passes")
            .is_empty()
    );

    let resp = server.post("/api/dream/trigger", json!({})).await;
    assert_eq!(resp.status(), 503);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Dreaming worker not running");

    let resp = server.post("/api/dream/promote", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "from is required");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn dream_promote_replays_native_preference_preview_and_apply() {
    let server = TestServer::start().await;
    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    conn.execute(
        "INSERT INTO memories
         (id, type, content, confidence, importance, project, created_at, updated_at,
          updated_by, is_deleted, version, agent_id)
         VALUES (?1, 'preference', ?2, 0.9, 0.8, '/tmp/signet',
                 '2026-05-16T10:00:00Z', '2026-05-16T10:00:00Z',
                 'contract-replay', 0, 1, 'ant')",
        rusqlite::params![
            "mem-dream-pref",
            "Nicholai prefers xyz to be like this when we're doing that.",
        ],
    )
    .expect("seed dream promotion memory");
    drop(conn);

    let resp = server
        .post(
            "/api/dream/promote?agentId=ant",
            json!({"from": "memory:mem-dream-pref"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dryRun"], true);
    assert_eq!(body["count"], 1);
    assert_eq!(body["appliedCount"], 0);
    assert_eq!(body["sources"][0]["kind"], "memory");
    assert_eq!(body["operations"][0]["operation"], "set_claim_value");
    assert_eq!(body["operations"][0]["payload"]["entity"], "Nicholai");
    assert_eq!(body["operations"][0]["payload"]["aspect"], "preferences");
    assert_eq!(body["operations"][0]["payload"]["group_key"], "workflow");
    assert_eq!(
        body["operations"][0]["payload"]["claim_key"],
        "prefers_xyz_when_we_re_doing_that"
    );

    let resp = server
        .post(
            "/api/dream/promote?agentId=ant",
            json!({"from": "memory:mem-dream-pref", "apply": true}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dryRun"], false);
    assert_eq!(body["appliedCount"], 1);

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    let row: (String, String, i64, String, String) = conn
        .query_row(
            "SELECT attr.content, attr.status, attr.version, attr.source_kind, attr.source_id
             FROM entity_attributes attr
             JOIN entity_aspects asp ON asp.id = attr.aspect_id
             JOIN entities e ON e.id = asp.entity_id
             WHERE e.agent_id = 'ant'
               AND e.name = 'Nicholai'
               AND asp.name = 'preferences'
               AND attr.group_key = 'workflow'
               AND attr.claim_key = 'prefers_xyz_when_we_re_doing_that'
               AND attr.kind = 'attribute'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("dream promotion attribute");
    assert_eq!(
        row.0,
        "Nicholai prefers xyz to be like this when we're doing that."
    );
    assert_eq!(row.1, "active");
    assert_eq!(row.2, 1);
    assert_eq!(row.3, "memory");
    assert_eq!(row.4, "mem-dream-pref");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn repair_endpoints() {
    let server = TestServer::start().await;

    let resp = server.get("/api/repair/embedding-gaps").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/repair/dedup-stats").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/repair/cold-stats").await;
    assert_eq!(resp.status(), 200);

    let resp = server
        .post("/api/repair/prune-generic-entities", json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["action"], "prune-generic-entities");
    assert_eq!(body["pruned"], 0);

    let resp = server.post("/api/repair/cluster-entities", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["action"], "cluster-entities");
    assert_eq!(body["clusters"], 0);

    let resp = server.post("/api/repair/relink-entities", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["action"], "relink-entities");
    assert_eq!(body["remaining"], 0);
    assert_eq!(body["message"], "all memories linked");

    let resp = server.post("/api/repair/backfill-hints", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["action"], "backfill-hints");
    assert_eq!(body["enqueued"], 0);
    assert_eq!(body["message"], "all unscoped memories have hints");

    let resp = server.post("/api/repair/re-embed", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["action"], "reembedMissingMemories");

    let resp = server
        .post("/api/repair/reclassify-entities", json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["action"], "reclassify_entities");

    let resp = server
        .post("/api/repair/structural-backfill", json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["action"], "structural_backfill");

    let resp = server
        .get("/api/repair/dead-memories?maxConfidence=2")
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"],
        "maxConfidence must be 0–1, maxAccessDays and limit must be non-negative"
    );

    let resp = server.get("/api/repair/dead-memories").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 0);
    assert!(
        body["memories"]
            .as_array()
            .expect("dead memories")
            .is_empty()
    );

    let resp = server
        .post("/api/repair/dead-memories/forget", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "ids must be a non-empty array");

    let resp = server
        .post(
            "/api/repair/dead-memories/forget",
            json!({"ids": ["dead-memory-a"]}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["forgotten"], 0);

    let resp = server.get("/api/troubleshoot/commands").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let commands = body["commands"].as_array().expect("commands");
    assert!(commands.iter().any(|command| command["key"] == "status"));
    assert!(
        commands
            .iter()
            .any(|command| command["display"] == "signet daemon status")
    );

    let resp = server.post("/api/troubleshoot/exec", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Unknown command: ");

    let resp = server
        .post("/api/troubleshoot/exec", json!({"key": "status"}))
        .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default(),
        "text/event-stream"
    );
    let text = resp.text().await.expect("troubleshoot SSE body");
    assert!(text.contains(r#"data: {"command":"signet status","key":"status","type":"started"}"#));
    assert!(text.contains(r#"data: {"data":"fake signet status\n","type":"stdout"}"#));
    assert!(text.contains(r#"data: {"code":0,"type":"exit"}"#));
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn timeline_endpoint() {
    let server = TestServer::start().await;
    let resp = server.get("/api/memory/timeline").await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn cross_agent_endpoints() {
    let server = TestServer::start().await;

    let resp = server
        .post(
            "/api/cross-agent/presence",
            json!({
                "sessionKey": "agent:alpha:peer-one",
                "agentId": "alpha",
                "harness": "codex",
                "project": "/workspace/replay",
                "runtimePath": "plugin",
                "provider": "codex"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/cross-agent/presence").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);

    let peers = call_mcp_tool(
        &server,
        "agent_peers",
        json!({
            "agent_id": "default",
            "project": "/workspace/replay",
            "limit": 10
        }),
    )
    .await;
    assert_eq!(peers["count"], 1);
    assert_eq!(peers["sessions"][0]["agentId"], "alpha");
    assert_eq!(peers["sessions"][0]["sessionKey"], "agent:alpha:peer-one");

    let sent = call_mcp_tool(
        &server,
        "agent_message_send",
        json!({
            "from_agent_id": "default",
            "from_session_key": "agent:default:sender",
            "to_agent_id": "alpha",
            "to_session_key": "agent:alpha:peer-one",
            "type": "question",
            "content": "Cross-agent MCP replay message"
        }),
    )
    .await;
    assert_eq!(sent["fromAgentId"], "default");
    assert_eq!(sent["toAgentId"], "alpha");
    assert_eq!(sent["type"], "question");

    let resp = server.get("/api/cross-agent/messages").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);

    let inbox = call_mcp_tool(
        &server,
        "agent_message_inbox",
        json!({
            "agent_id": "alpha",
            "session_key": "agent:alpha:peer-one",
            "limit": 10
        }),
    )
    .await;
    assert_eq!(inbox["count"], 1);
    assert_eq!(
        inbox["items"][0]["content"],
        "Cross-agent MCP replay message"
    );
    assert_eq!(inbox["items"][0]["toSessionKey"], "agent:alpha:peer-one");

    let resp = server.get("/api/cross-agent/stream").await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default(),
        "text/event-stream"
    );
    let text = resp.text().await.expect("cross-agent stream body");
    assert!(text.contains("\"type\":\"connected\""));
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn embeddings_stats() {
    let server = TestServer::start().await;
    let resp = server.get("/api/embeddings").await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn hook_recall_and_compaction_endpoints() {
    let server = TestServer::start().await;

    let resp = server
        .post(
            "/api/hooks/recall",
            json!({
                "sessionKey": "test-recall-001",
                "harness": "claude-code",
                "query": "what should I remember?",
                "limit": 3
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);

    let resp = server
        .post(
            "/api/hooks/pre-compaction",
            json!({
                "sessionKey": "test-recall-001",
                "harness": "claude-code",
                "transcript": "User: hello\nAssistant: hi"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
}

async fn wait_for_skill_graph_row(db_path: &std::path::Path, entity_id: &str) -> SkillGraphRow {
    for _ in 0..80 {
        let conn = rusqlite::Connection::open(db_path).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let row = conn
            .query_row(
                "SELECT e.name, e.entity_type, e.agent_id, COALESCE(e.description, ''),
                        sm.source, sm.role, sm.triggers, sm.tags, sm.enriched,
                        sm.fs_path, sm.uninstalled_at
                   FROM entities e
                   JOIN skill_meta sm ON sm.entity_id = e.id
                  WHERE e.id = ?1",
                rusqlite::params![entity_id],
                |row| {
                    Ok(SkillGraphRow {
                        name: row.get(0)?,
                        entity_type: row.get(1)?,
                        agent_id: row.get(2)?,
                        description: row.get(3)?,
                        source: row.get(4)?,
                        role: row.get(5)?,
                        triggers: row.get(6)?,
                        tags: row.get(7)?,
                        enriched: row.get(8)?,
                        fs_path: row.get(9)?,
                        uninstalled_at: row.get(10)?,
                    })
                },
            )
            .optional()
            .expect("query skill graph row");
        if let Some(row) = row {
            return row;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    panic!("skill graph row was not created for {entity_id}");
}

async fn wait_for_skill_graph_removed(db_path: &std::path::Path, entity_id: &str) {
    for _ in 0..80 {
        let conn = rusqlite::Connection::open(db_path).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let counts = conn
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM entities WHERE id = ?1),
                    (SELECT COUNT(*) FROM skill_meta WHERE entity_id = ?1),
                    (SELECT COUNT(*) FROM embeddings WHERE source_type = 'skill' AND source_id = ?1)",
                rusqlite::params![entity_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
            )
            .expect("query skill graph cleanup");
        if counts == (0, 0, 0) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    panic!("skill graph row was not removed for {entity_id}");
}

async fn wait_for_skill_embedding_row(
    db_path: &std::path::Path,
    entity_id: &str,
) -> SkillEmbeddingRow {
    for _ in 0..80 {
        let conn = open_replay_db_with_vec(db_path);
        let row = conn
            .query_row(
                "SELECT e.content_hash, e.dimensions, e.chunk_text,
                        (SELECT COUNT(*) FROM vec_embeddings WHERE id = e.id)
                   FROM embeddings e
                  WHERE e.source_type = 'skill' AND e.source_id = ?1",
                rusqlite::params![entity_id],
                |row| {
                    Ok(SkillEmbeddingRow {
                        content_hash: row.get(0)?,
                        dimensions: row.get(1)?,
                        chunk_text: row.get(2)?,
                        vec_rows: row.get(3)?,
                    })
                },
            )
            .optional()
            .expect("query skill embedding row");
        if let Some(row) = row {
            return row;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    panic!("skill embedding row was not created for {entity_id}");
}

async fn wait_for_skill_extraction_rows(
    db_path: &std::path::Path,
    entity_id: &str,
) -> SkillExtractionRows {
    for _ in 0..80 {
        let conn = rusqlite::Connection::open(db_path).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let row = conn
            .query_row(
                "SELECT src.name, tgt.name, r.relation_type
                   FROM relations r
                   JOIN entities src ON src.id = r.source_entity_id
                   JOIN entities tgt ON tgt.id = r.target_entity_id
                  WHERE src.name = 'WebSearchSkill'
                    AND tgt.name = 'SearchProvider'
                    AND r.relation_type = 'uses'",
                [],
                |row| {
                    Ok(SkillExtractionRows {
                        source_name: row.get(0)?,
                        target_name: row.get(1)?,
                        relation_type: row.get(2)?,
                    })
                },
            )
            .optional()
            .expect("query skill body extraction rows");
        if let Some(row) = row {
            return row;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    panic!("skill body extraction rows were not created for {entity_id}");
}

fn count_skill_embeddings(db_path: &std::path::Path, entity_id: &str) -> i64 {
    let conn = open_replay_db_with_vec(db_path);
    conn.query_row(
        "SELECT COUNT(*) FROM embeddings WHERE source_type = 'skill' AND source_id = ?1",
        rusqlite::params![entity_id],
        |row| row.get(0),
    )
    .expect("count skill embeddings")
}

fn open_replay_db_with_vec(db_path: &std::path::Path) -> rusqlite::Connection {
    register_vec_extension();
    let conn = rusqlite::Connection::open(db_path).expect("open replay db");
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    conn
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn skills_endpoints() {
    let clawhub_fixture =
        ClawhubDownloadFixture::start(clawhub_skill_archive("claw-demo", "Installed by ClawHub"));
    let _clawhub_env = ClawhubEnvGuard::set(&clawhub_fixture.base);
    let embedding_fixture = EmbeddingFixture::start();
    let server = TestServer::start_with_agent_yaml(
        None,
        &format!(
            "agent:\n  name: test-agent\n  version: 1\nembedding:\n  provider: openai\n  model: replay-embedding\n  dimensions: 3\n  base_url: {}\nmemory:\n  pipelineV2:\n    extractionProvider: openai-compatible\n    extractionModel: replay-llm\n    extractionEndpoint: {}\n    rerankerUseExtractionModel: true\n    extraction:\n      provider: openai-compatible\n      model: replay-llm\n      endpoint: {}\n      timeout: 5000\n    reranker:\n      enabled: true\n      useExtractionModel: true\n    procedural:\n      enabled: true\n      enrichOnInstall: true\n      enrichMinDescription: 50\n",
            embedding_fixture.base,
            embedding_fixture.base,
            embedding_fixture.base
        ),
    )
    .await;
    let skills_dir = server._tmpdir.path().join("skills/test-skill");
    std::fs::create_dir_all(&skills_dir).unwrap();
    std::fs::write(
        skills_dir.join("SKILL.md"),
        "---\nname: test-skill\ndescription: A test skill\nversion: 1.0.0\n---\n\n# Test Skill\n",
    )
    .unwrap();

    let resp = server.get("/api/skills").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["skills"][0]["name"], "test-skill");

    let resp = server.get("/api/skills/test-skill").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["description"], "A test skill");
    assert!(body["content"].as_str().unwrap().contains("# Test Skill"));

    let resp = server.get("/api/skills/browse").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/skills/search").await;
    assert_eq!(resp.status(), 400);

    for path in [
        "/api/skills/does-not-exist",
        "/api/skills/nonexistent-skill-xyz",
        "/api/skills/..%2Ffoo",
        "/api/skills/..%2F..%2Fetc",
    ] {
        let resp = server.get(path).await;
        assert!(resp.status() == 400 || resp.status() == 404, "GET {path}");
    }

    let resp = server
        .post(
            "/api/skills/install",
            json!({"name": "web-search", "source": "Signet-AI/signetai"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["name"], "web-search");
    assert!(
        body["output"]
            .as_str()
            .unwrap()
            .contains("fake skills installed web-search from Signet-AI/signetai")
    );
    let installed_skill = server._tmpdir.path().join("skills/web-search/SKILL.md");
    assert!(installed_skill.exists());

    let resp = server.get("/api/skills/web-search").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["name"], "web-search");
    assert_eq!(body["description"], "Installed by fake skills runner");
    let web_graph = wait_for_skill_graph_row(&server.db_path(), "skill:default:web-search").await;
    assert_eq!(web_graph.name, "web-search");
    assert_eq!(web_graph.entity_type, "skill");
    assert_eq!(web_graph.agent_id, "default");
    assert!(
        embedding_fixture
            .llm_requests
            .load(std::sync::atomic::Ordering::SeqCst)
            > 0,
        "skill enrichment did not call the LLM fixture"
    );
    assert_eq!(
        web_graph.description,
        "Enriched web-search discovery metadata for replay."
    );
    assert_eq!(web_graph.source, "installed");
    assert_eq!(web_graph.role, "utility");
    assert_eq!(web_graph.enriched, 1);
    assert_eq!(
        web_graph.triggers.as_deref(),
        Some("[\"look up web facts\",\"search online\"]")
    );
    assert_eq!(web_graph.tags.as_deref(), Some("[\"research\",\"web\"]"));
    assert!(web_graph.fs_path.ends_with("skills/web-search/SKILL.md"));
    assert_eq!(web_graph.uninstalled_at, None);
    let web_embedding =
        wait_for_skill_embedding_row(&server.db_path(), "skill:default:web-search").await;
    assert_eq!(web_embedding.content_hash, "6c5291356681c1e6");
    assert_eq!(web_embedding.dimensions, 3);
    assert_eq!(
        web_embedding.chunk_text,
        "web-search — Enriched web-search discovery metadata for replay. — look up web facts, search online"
    );
    assert_eq!(web_embedding.vec_rows, 1);
    let web_extraction =
        wait_for_skill_extraction_rows(&server.db_path(), "skill:default:web-search").await;
    assert!(
        embedding_fixture
            .extraction_requests
            .load(std::sync::atomic::Ordering::SeqCst)
            > 0,
        "skill body extraction did not call the LLM fixture"
    );
    assert_eq!(web_extraction.source_name, "WebSearchSkill");
    assert_eq!(web_extraction.target_name, "SearchProvider");
    assert_eq!(web_extraction.relation_type, "uses");

    let resp = server
        .post(
            "/api/skills/install",
            json!({"name": "web-search", "source": "Signet-AI/signetai"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let web_graph = wait_for_skill_graph_row(&server.db_path(), "skill:default:web-search").await;
    assert_eq!(web_graph.name, "web-search");
    assert_eq!(
        web_graph.description,
        "Enriched web-search discovery metadata for replay."
    );
    assert_eq!(web_graph.enriched, 1);
    assert_eq!(web_graph.uninstalled_at, None);
    assert_eq!(
        count_skill_embeddings(&server.db_path(), "skill:default:web-search"),
        1
    );

    let resp = server
        .post(
            "/api/skills/install",
            json!({"name": "claw-demo", "source": "clawhub@claw-demo"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["name"], "claw-demo");
    assert!(
        body["output"]
            .as_str()
            .unwrap()
            .contains("Installed ClawHub skill claw-demo")
    );
    let installed_skill = server._tmpdir.path().join("skills/claw-demo/SKILL.md");
    assert!(installed_skill.exists());

    let resp = server.get("/api/skills/claw-demo").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["name"], "claw-demo");
    assert_eq!(body["description"], "Installed by ClawHub");
    let claw_graph = wait_for_skill_graph_row(&server.db_path(), "skill:default:claw-demo").await;
    assert_eq!(claw_graph.name, "claw-demo");
    assert_eq!(claw_graph.entity_type, "skill");
    assert_eq!(claw_graph.agent_id, "default");
    assert_eq!(
        claw_graph.description,
        "Enriched claw-demo discovery metadata for replay."
    );
    assert_eq!(claw_graph.source, "installed");
    assert_eq!(claw_graph.role, "utility");
    assert_eq!(claw_graph.enriched, 1);
    assert!(claw_graph.fs_path.ends_with("skills/claw-demo/SKILL.md"));
    assert_eq!(claw_graph.uninstalled_at, None);

    let resp = server.delete("/api/skills/web-search").await;
    assert_eq!(resp.status(), 200);
    wait_for_skill_graph_removed(&server.db_path(), "skill:default:web-search").await;

    let resp = server.delete("/api/skills/test-skill").await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn sources_endpoints() {
    let picker_dir = tempfile::tempdir().expect("picker fixture dir");
    let picked_dir = picker_dir.path().join("picked");
    std::fs::create_dir_all(&picked_dir).unwrap();
    let picker = picker_dir.path().join("pick-directory.sh");
    std::fs::write(
        &picker,
        format!(
            "#!/usr/bin/env bash\nprintf '%s\\n' '{}'\n",
            picked_dir.display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&picker, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let original_picker = std::env::var_os("SIGNET_DIRECTORY_PICKER");
    unsafe {
        std::env::set_var("SIGNET_DIRECTORY_PICKER", &picker);
    }
    let server = TestServer::start().await;

    let resp = server.get("/api/sources").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"version": 1, "sources": []}));

    let resp = server.post("/api/sources/pick-directory", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["path"], picked_dir.display().to_string());
    unsafe {
        if let Some(value) = original_picker {
            std::env::set_var("SIGNET_DIRECTORY_PICKER", value);
        } else {
            std::env::remove_var("SIGNET_DIRECTORY_PICKER");
        }
    }

    let resp = server.post("/api/sources/discord", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "At least one Discord guild ID is required");

    let resp = server.post("/api/sources/github", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"],
        "At least one GitHub repo pattern is required"
    );

    let resp = server.get("/api/sources/missing/snapshot").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Source not found");

    let resp = server.get("/api/sources/missing/health").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Source not found");

    let resp = server
        .post("/api/sources/missing/snapshot/import", json!({}))
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Source not found");

    let vault = server._tmpdir.path().join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let resp = server
        .post(
            "/api/sources/obsidian",
            json!({"path": vault.to_string_lossy(), "name": "Replay Vault"}),
        )
        .await;
    assert_eq!(resp.status(), 202);
    let body = server.json(resp).await;
    assert_eq!(body["created"], true);
    assert_eq!(body["source"]["kind"], "obsidian");
    assert!(body["source"].get("indexJob").is_none());
    let id = body["source"]["id"].as_str().unwrap().to_string();
    assert_eq!(body["job"]["sourceId"], id);
    assert_eq!(body["job"]["status"], "queued");
    assert!(body["job"]["queuedAt"].as_str().is_some());
    assert!(
        body["job"]["id"]
            .as_str()
            .unwrap_or_default()
            .starts_with(&format!("source-index:{id}:"))
    );

    let resp = server.get("/api/sources").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let source = &body["sources"][0];
    assert_eq!(source["id"], id);
    assert_eq!(
        source["stats"],
        json!({"artifacts": 0, "chunks": 0, "indexed": 0})
    );
    assert_eq!(source["health"]["status"], "empty");
    assert_eq!(
        source["health"]["failures"],
        json!({"total": 0, "recoverable": 0})
    );
    assert_eq!(
        source["health"]["checkpoints"],
        json!({"total": 0, "partial": 0, "stale": 0})
    );
    assert_eq!(
        source["health"]["semantic"],
        json!({"entities": 0, "attributes": 0, "dependencies": 0, "communities": 0, "total": 0})
    );
    assert_eq!(source["indexJob"]["sourceId"], id);
    assert_eq!(source["indexJob"]["status"], "queued");

    let resp = server.get(&format!("/api/sources/{id}/snapshot")).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["version"], 1);
    assert_eq!(body["source"]["id"], id);
    assert_eq!(body["artifacts"], json!([]));

    let resp = server.get(&format!("/api/sources/{id}/health")).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["source"]["id"], id);
    assert_eq!(
        body["stats"],
        json!({"artifacts": 0, "chunks": 0, "indexed": 0})
    );
    assert_eq!(body["health"]["status"], "empty");
    assert_eq!(
        body["health"]["failures"],
        json!({"total": 0, "recoverable": 0})
    );
    assert_eq!(
        body["health"]["checkpoints"],
        json!({"total": 0, "partial": 0, "stale": 0})
    );
    assert_eq!(
        body["health"]["semantic"],
        json!({"entities": 0, "attributes": 0, "dependencies": 0, "communities": 0, "total": 0})
    );

    let resp = server
        .post(
            &format!("/api/sources/{id}/snapshot/import"),
            json!({"source": {"id": "other"}}),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert!(body["error"].as_str().unwrap().contains("does not match"));

    let resp = server.delete(&format!("/api/sources/{id}")).await;
    assert_eq!(resp.status(), 200);

    let resp = server.delete("/api/sources/obsidian%3Amissing").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("Source not found")
    );

    let resp = server
        .post(
            "/api/sources/discord",
            json!({
                "guildIds": ["123456789012345678"],
                "tokenRef": "DISCORD_BOT_TOKEN",
                "name": "Replay Discord",
                "includeAttachmentText": true,
                "maxAttachmentTextBytes": 2048
            }),
        )
        .await;
    assert_eq!(resp.status(), 202);
    let body = server.json(resp).await;
    assert_eq!(body["queued"], true);
    assert_eq!(body["source"]["kind"], "discord");
    assert!(body["source"].get("indexJob").is_none());
    assert_eq!(body["job"]["sourceId"], body["source"]["id"]);
    assert_eq!(body["job"]["status"], "queued");
    assert!(
        body["job"]["id"]
            .as_str()
            .unwrap_or_default()
            .starts_with(&format!(
                "source-index:{}:",
                body["source"]["id"].as_str().unwrap()
            ))
    );
    assert_eq!(
        body["source"]["providerSettings"]["tokenRef"],
        "DISCORD_BOT_TOKEN"
    );
    assert_eq!(
        body["source"]["providerSettings"]["includeAttachmentText"],
        true
    );
    assert_eq!(
        body["source"]["providerSettings"]["maxAttachmentTextBytes"],
        2048
    );

    let resp = server
        .post(
            "/api/sources/github",
            json!({
                "repos": ["Signet-AI/signetai"],
                "name": "Replay GitHub",
                "resourceTypes": ["issues", "docs"],
                "maxItemsPerRepo": 5
            }),
        )
        .await;
    assert_eq!(resp.status(), 202);
    let body = server.json(resp).await;
    assert_eq!(body["queued"], true);
    assert_eq!(body["source"]["kind"], "github");
    assert!(body["source"].get("indexJob").is_none());
    assert_eq!(body["job"]["sourceId"], body["source"]["id"]);
    assert_eq!(body["job"]["status"], "queued");
    assert!(
        body["job"]["id"]
            .as_str()
            .unwrap_or_default()
            .starts_with(&format!(
                "source-index:{}:",
                body["source"]["id"].as_str().unwrap()
            ))
    );
    assert_eq!(
        body["source"]["providerSettings"]["repos"],
        json!(["Signet-AI/signetai"])
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn inference_native_endpoints_cover_ts_hardening_contract() {
    let server = TestServer::start_team_auth_with_agent_yaml(INFERENCE_REPLAY_YAML).await;
    let admin = TestServer::scoped_role_token("default", "admin");
    let operator = TestServer::scoped_role_token("default", "operator");
    let rose = TestServer::scoped_role_token("rose", "agent");

    let resp = server.get_bearer("/api/inference/status", &operator).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["enabled"], true);
    assert_eq!(body["source"], "explicit");
    assert!(
        body["targetRefs"]
            .as_array()
            .unwrap()
            .contains(&json!("local/gemma"))
    );
    assert!(
        body["policies"]
            .as_array()
            .unwrap()
            .contains(&json!("auto"))
    );

    let resp = server
        .get_bearer("/api/inference/history?failures=1&limit=10", &operator)
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["enabled"], false);

    let resp = server
        .post_bearer(
            "/api/inference/explain",
            json!({"agentId": "miles", "operation": "interactive"}),
            &rose,
        )
        .await;
    assert_eq!(resp.status(), 403);
    let body = server.json(resp).await;
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("scope restricted to agent 'rose'")
    );

    let resp = server
        .post_bearer(
            "/api/inference/explain",
            json!({"operation": "interactive", "explicitTargets": ["remote/sonnet"]}),
            &rose,
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("Explicit target overrides are not allowed")
    );

    let resp = server
        .post_bearer(
            "/api/inference/execute",
            json!({"prompt": "hello"}),
            &operator,
        )
        .await;
    assert_eq!(resp.status(), 403);

    let resp = server
        .post_bearer(
            "/api/inference/execute",
            json!({"prompt": "x".repeat(200_001), "operation": "interactive"}),
            &admin,
        )
        .await;
    assert_eq!(resp.status(), 413);

    let resp = server
        .post_bearer(
            "/api/inference/execute",
            json!({"prompt": "hello", "operation": "interactive"}),
            &admin,
        )
        .await;
    assert_eq!(resp.status(), 503);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "inference router not initialized");

    let resp = server
        .post_bearer(
            "/api/inference/stream",
            json!({"prompt": "hello", "operation": "interactive"}),
            &admin,
        )
        .await;
    assert_eq!(resp.status(), 503);

    let resp = server
        .delete_bearer("/api/inference/requests/missing", &admin)
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "inference request not found");

    let resp = server.get_bearer("/v1/models", &admin).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let ids: Vec<&str> = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["id"].as_str())
        .collect();
    assert!(ids.contains(&"signet:auto"));
    assert!(ids.contains(&"policy:auto"));
    assert!(ids.contains(&"local/gemma"));

    let resp = server
        .client
        .post(format!("{}/v1/chat/completions", server.base))
        .bearer_auth(&admin)
        .header("x-signet-agent-id", "bad value!")
        .json(&json!({
            "model": "signet:auto",
            "messages": [{"role": "user", "content": "hello"}]
        }))
        .send()
        .await
        .expect("request failed");
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("x-signet-agent-id contains unsupported characters")
    );

    let resp = server
        .client
        .post(format!("{}/v1/chat/completions", server.base))
        .bearer_auth(&admin)
        .header("x-signet-agent-id", "rose")
        .header("x-signet-explicit-target", "remote/sonnet")
        .json(&json!({
            "model": "signet:auto",
            "messages": [{"role": "user", "content": "hello"}]
        }))
        .send()
        .await
        .expect("request failed");
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"]["message"], "scope violation");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn inference_command_execute_replays_ts_contract() {
    let server = TestServer::start_team_auth_with_agent_yaml(COMMAND_INFERENCE_REPLAY_YAML).await;
    let admin = TestServer::scoped_role_token("default", "admin");

    let resp = server
        .post_bearer(
            "/api/inference/execute",
            json!({"prompt": "bring your own cli", "operation": "default"}),
            &admin,
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["text"], "cli:bring your own cli");
    assert_eq!(body["decision"]["targetRef"], "localCli/default");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn inference_command_timeout_kills_child_process() {
    let marker_dir = tempfile::tempdir().expect("failed to create marker tmpdir");
    let marker = marker_dir.path().join("timed-out-command-ran");
    let yaml = format!(
        r#"agent:
  name: test-agent
  version: 1
auth:
  method: token
  mode: team
memory:
  pipelineV2:
    extraction:
      provider: none
inference:
  defaultPolicy: auto
  targets:
    slowCli:
      executor: command
      command:
        bin: /bin/sh
        args:
          - -c
          - 'sleep 1; touch "$MARKER"; printf "late\n"'
        env:
          MARKER: "{}"
      models:
        default:
          model: slow-cli
          reasoning: low
  policies:
    auto:
      mode: strict
      defaultTargets:
        - slowCli/default
  workloads:
    default:
      policy: auto
"#,
        marker.to_string_lossy()
    );
    let server = TestServer::start_team_auth_with_agent_yaml(&yaml).await;
    let admin = TestServer::scoped_role_token("default", "admin");

    let resp = server
        .post_bearer(
            "/api/inference/execute",
            json!({"prompt": "too slow", "operation": "default", "timeoutMs": 10}),
            &admin,
        )
        .await;
    assert_eq!(resp.status(), 504);

    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(
        !marker.exists(),
        "timed out command target continued after request returned"
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn inference_disabled_execute_does_not_run_command_targets() {
    let marker_dir = tempfile::tempdir().expect("failed to create marker tmpdir");
    let marker = marker_dir.path().join("disabled-command-ran");
    let yaml = format!(
        r#"agent:
  name: test-agent
  version: 1
auth:
  method: token
  mode: team
memory:
  pipelineV2:
    extraction:
      provider: none
inference:
  enabled: false
  defaultPolicy: auto
  targets:
    disabledCli:
      executor: command
      command:
        bin: /bin/sh
        args:
          - -c
          - 'touch "$MARKER"; printf "should-not-run\n"'
        env:
          MARKER: "{}"
      models:
        default:
          model: disabled-cli
          reasoning: low
  policies:
    auto:
      mode: strict
      defaultTargets:
        - disabledCli/default
  workloads:
    default:
      policy: auto
"#,
        marker.to_string_lossy()
    );
    let server = TestServer::start_team_auth_with_agent_yaml(&yaml).await;
    let admin = TestServer::scoped_role_token("default", "admin");

    let resp = server
        .post_bearer(
            "/api/inference/execute",
            json!({"prompt": "disabled", "operation": "default", "timeoutMs": 1000}),
            &admin,
        )
        .await;
    assert_eq!(resp.status(), 503);
    assert!(
        !marker.exists(),
        "disabled inference executed a command target"
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn inference_command_stdin_write_respects_timeout() {
    let server = TestServer::start_team_auth_with_agent_yaml(COMMAND_STDIN_HANG_YAML).await;
    let admin = TestServer::scoped_role_token("default", "admin");
    let prompt = "x".repeat(96_000);

    let resp = tokio::time::timeout(
        Duration::from_secs(2),
        server.post_bearer(
            "/api/inference/execute",
            json!({"prompt": prompt, "operation": "default", "timeoutMs": 50}),
            &admin,
        ),
    )
    .await
    .expect("request hung beyond route timeout");
    let status = resp.status();
    let body = server.json(resp).await;
    assert_eq!(status, 504, "{body}");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn knowledge_expand_native_graph_data() {
    let server = TestServer::start().await;
    server.seed_knowledge_expand_fixture();

    let resp = server
        .post(
            "/api/knowledge/expand",
            json!({"entity": "Signet", "aspect": "identity", "maxTokens": 200}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["entity"]["name"], "Signet");
    assert_eq!(body["memoryCount"], 1);
    assert_eq!(body["memories"][0]["id"], "mem-signet-context");
    assert_eq!(body["aspects"][0]["name"], "identity");
    assert_eq!(body["dependencies"][0]["target"], "Provenance");

    let body = call_mcp_tool(
        &server,
        "knowledge_expand",
        json!({"entity_name": "Signet", "aspect_filter": "identity", "max_tokens": 200}),
    )
    .await;
    assert_eq!(body["entity"]["name"], "Signet");
    assert_eq!(body["memoryCount"], 1);
    assert_eq!(body["memories"][0]["id"], "mem-signet-context");
    assert_eq!(body["aspects"][0]["name"], "identity");
    assert_eq!(body["dependencies"][0]["target"], "Provenance");

    let resp = server
        .post(
            "/api/knowledge/expand",
            json!({"entity": "Signet", "aspect": "%", "maxTokens": 200}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["aspects"].as_array().unwrap().len(), 1);
    assert_eq!(body["aspects"][0]["name"], "percent %");

    let resp = server
        .post(
            "/api/knowledge/expand/session",
            json!({"entityName": "Signet", "sessionId": "session-signet-expand"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["entityName"], "Signet");
    assert_eq!(body["total"], 1);
    assert_eq!(body["summaries"][0]["sessionKey"], "session-signet-expand");

    let resp = server
        .post("/api/knowledge/expand/session", json!({"entityName": "%"}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["entityName"], "%");
    assert_eq!(body["total"], 0);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn knowledge_navigation_routes_replay_ts_shape() {
    let server = TestServer::start().await;
    server.seed_knowledge_navigation_fixture();

    let resp = server
        .get("/api/knowledge/navigation/entities?limit=10")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["items"][0]["entity"]["name"], "Nicholai");
    assert_eq!(body["items"][0]["aspectCount"], 1);

    let resp = server
        .get("/api/knowledge/navigation/entity?name=Nicholai")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["entity"]["name"], "Nicholai");
    assert_eq!(body["aspectCount"], 1);

    let resp = server
        .get("/api/knowledge/navigation/aspects?entity=Nicholai")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["entity"]["name"], "Nicholai");
    assert_eq!(body["items"][0]["aspect"]["canonicalName"], "food");

    let resp = server
        .get("/api/knowledge/navigation/groups?entity=Nicholai&aspect=food")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let groups = body["items"].as_array().expect("group items");
    assert_eq!(groups[0]["groupKey"], "restaurants");
    assert_eq!(groups[0]["claimCount"], 2);
    assert_eq!(groups[1]["groupKey"], "dietary_constraints");

    let resp = server
        .get("/api/knowledge/navigation/claims?entity=Nicholai&aspect=food&group=restaurants")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let claims = body["items"].as_array().expect("claim items");
    assert_eq!(claims[0]["claimKey"], "favorite_restaurant");
    assert_eq!(claims[0]["activeCount"], 1);
    assert_eq!(claims[0]["supersededCount"], 1);
    assert_eq!(
        claims[0]["preview"],
        "Nicholai currently prefers Temaki Den."
    );
    assert_eq!(claims[1]["claimKey"], "korean_restaurants_tried_count");

    let resp = server
        .get("/api/knowledge/navigation/attributes?entity=Nicholai&aspect=food&group=restaurants&claim=favorite_restaurant")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let active = body["items"].as_array().expect("active attributes");
    assert_eq!(active.len(), 1);
    assert_eq!(
        active[0]["content"],
        "Nicholai currently prefers Temaki Den."
    );
    assert_eq!(active[0]["groupKey"], "restaurants");
    assert_eq!(active[0]["claimKey"], "favorite_restaurant");

    let resp = server
        .get("/api/knowledge/navigation/attributes?entity=Nicholai&aspect=food&group=restaurants&claim=favorite_restaurant&status=all")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let all = body["items"].as_array().expect("all attributes");
    assert_eq!(all.len(), 2);
    assert_eq!(all[0]["status"], "active");
    assert_eq!(all[1]["status"], "superseded");

    let resp = server
        .get("/api/knowledge/navigation/tree?entity=Nicholai&depth=3")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["entity"]["name"], "Nicholai");
    assert_eq!(body["limits"]["depth"], 3);
    assert_eq!(body["items"][0]["aspect"]["canonicalName"], "food");
    assert_eq!(body["items"][0]["groups"][0]["groupKey"], "restaurants");
    assert_eq!(
        body["items"][0]["groups"][0]["claims"][0]["preview"],
        "Nicholai currently prefers Temaki Den."
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn knowledge_health_hygiene_and_communities_replay_ts_shape() {
    let server = TestServer::start().await;
    server.seed_knowledge_health_hygiene_fixture();

    let resp = server
        .get("/api/knowledge/entities/health?min_comparisons=3")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let health = body.as_array().expect("health array");
    assert_eq!(health[0]["entityId"], "entity-signet-hygiene");
    assert_eq!(health[0]["entityName"], "Signet");
    assert_eq!(health[0]["comparisonCount"], 3);
    assert_eq!(health[0]["trend"], "improving");

    let resp = server
        .get("/api/knowledge/hygiene?limit=10&memory_limit=10")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["agentId"], "default");
    assert!(
        body["suspiciousEntities"]
            .as_array()
            .expect("suspicious entities")
            .iter()
            .any(
                |entity| entity["id"] == "entity-the-hygiene" && entity["reason"] == "generic_word"
            )
    );
    assert_eq!(body["duplicateEntities"][0]["canonicalName"], "duplicate");
    assert_eq!(body["attributeSummary"]["missingGroupKey"], 1);
    assert_eq!(
        body["safeMentionCandidates"][0]["memoryId"],
        "mem-hygiene-signet"
    );
    assert_eq!(
        body["safeMentionCandidates"][0]["snippet"],
        "Signet should keep graph repair mechanical."
    );

    let resp = server.get("/api/knowledge/communities").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["items"][0]["id"], "community-signet");
    assert_eq!(body["items"][0]["member_count"], 4);

    let resp = server.get("/api/knowledge/traversal/status").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body["status"].is_null());
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn knowledge_expand_enforces_authenticated_agent_scope() {
    let server = TestServer::start_team_auth().await;
    server.seed_knowledge_expand_fixture();
    let other_agent_token = TestServer::scoped_token("other-agent");

    let resp = server
        .post("/api/knowledge/expand", json!({"entity": "Signet"}))
        .await;
    assert_eq!(resp.status(), 401);

    let resp = server
        .post(
            "/api/knowledge/expand/session",
            json!({"entityName": "Signet", "sessionId": "session-signet-expand"}),
        )
        .await;
    assert_eq!(resp.status(), 401);

    let resp = server
        .post_bearer(
            "/api/knowledge/expand",
            json!({"entity": "Signet"}),
            &other_agent_token,
        )
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["memories"].as_array().unwrap().len(), 0);

    let resp = server
        .post_bearer(
            "/api/knowledge/expand",
            json!({"entity": "Signet", "agentId": "default"}),
            &other_agent_token,
        )
        .await;
    assert_eq!(resp.status(), 403);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "scope restricted to agent 'other-agent'");

    let resp = server
        .post_bearer(
            "/api/knowledge/expand/session",
            json!({"entityName": "Signet", "sessionId": "session-signet-expand"}),
            &other_agent_token,
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["total"], 0);

    let resp = server
        .post_bearer(
            "/api/knowledge/expand/session",
            json!({"entityName": "Signet", "agentId": "default"}),
            &other_agent_token,
        )
        .await;
    assert_eq!(resp.status(), 403);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn marketplace_reviews_native_roundtrip() {
    let server = TestServer::start().await;

    let resp = server
        .post(
            "/api/marketplace/reviews",
            json!({
                "targetType": "skill",
                "targetId": "skills.sh/foo",
                "displayName": "avery",
                "rating": 5,
                "title": "Great",
                "body": "Does the job"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["review"]["targetType"], "skill");
    assert_eq!(body["review"]["targetId"], "skills.sh/foo");

    let resp = server
        .get("/api/marketplace/reviews?type=skill&id=skills.sh%2Ffoo")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["total"], 1);
    assert_eq!(body["reviews"][0]["rating"], 5);
    assert_eq!(body["summary"]["count"], 1);
    assert_eq!(body["summary"]["avgRating"], 5.0);

    let marketplace_dir = server._tmpdir.path().join("marketplace");
    std::fs::create_dir_all(&marketplace_dir).expect("marketplace dir");
    std::fs::write(
        marketplace_dir.join("reviews.json"),
        serde_json::to_string_pretty(&json!([{
            "id": "review-replay",
            "targetType": "skill",
            "targetId": "skills.sh/foo",
            "displayName": "avery",
            "rating": 4,
            "title": "Initial",
            "body": "Initial review body",
            "source": "local",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "syncedAt": "2026-01-01T00:00:00Z"
        }]))
        .unwrap(),
    )
    .expect("write review fixture");

    let resp = server
        .patch(
            "/api/marketplace/reviews/review-replay",
            json!({
                "displayName": "riley",
                "rating": 3,
                "title": "Updated",
                "body": "Updated review body"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["review"]["displayName"], "riley");
    assert_eq!(body["review"]["rating"], 3);
    assert_eq!(body["review"]["syncedAt"], serde_json::Value::Null);

    let resp = server
        .patch(
            "/api/marketplace/reviews/review-replay",
            json!({"rating": 8}),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"],
        "displayName, rating, title, and body must be valid when provided"
    );

    let resp = server
        .delete("/api/marketplace/reviews/review-replay")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["id"], "review-replay");

    let resp = server
        .delete("/api/marketplace/reviews/review-replay")
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Review not found");

    let resp = server
        .post("/api/marketplace/reviews/sync", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["success"], false);
    assert_eq!(body["error"], "Review sync endpoint is not configured");

    let resp = server
        .patch(
            "/api/marketplace/reviews/config",
            json!({"enabled": true, "endpointUrl": "https://reviews.signetai.sh/reviews"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["config"]["enabled"], true);
    assert_eq!(
        body["config"]["endpointUrl"],
        "https://reviews.signetai.sh/reviews"
    );

    let resp = server
        .post("/api/marketplace/reviews/sync", json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["sent"], 0);
    assert_eq!(body["synced"], 0);
    assert_eq!(body["message"], "No pending reviews");

    let resp = server
        .patch(
            "/api/marketplace/reviews/config",
            json!({"endpointUrl": "http://127.0.0.1:1/reviews"}),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "endpointUrl must use https");

    let resp = server
        .patch(
            "/api/marketplace/reviews/config",
            json!({"endpointUrl": "https://[fc00::1]/reviews"}),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"],
        "endpointUrl host must be reviews.signetai.sh"
    );

    let resp = server.get("/api/marketplace/reviews/config").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["endpointUrl"], "https://reviews.signetai.sh/reviews");

    let mut entries: Vec<String> = std::fs::read_dir(&marketplace_dir)
        .expect("marketplace dir exists")
        .map(|entry| {
            entry
                .expect("marketplace dir entry")
                .file_name()
                .to_string_lossy()
                .to_string()
        })
        .collect();
    entries.sort();
    assert_eq!(entries, vec!["reviews-config.json", "reviews.json"]);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn workspace_file_mutations_enforce_team_admin_auth() {
    let server = TestServer::start_team_auth().await;
    let agent_token = TestServer::scoped_token("default");

    let resp = server
        .post(
            "/api/sources/obsidian",
            json!({"path": server._tmpdir.path().display().to_string()}),
        )
        .await;
    assert_eq!(resp.status(), 401);

    let resp = server
        .post_bearer(
            "/api/sources/obsidian",
            json!({"path": server._tmpdir.path().display().to_string()}),
            &agent_token,
        )
        .await;
    assert_eq!(resp.status(), 403);

    let resp = server.delete("/api/skills/local-test").await;
    assert_eq!(resp.status(), 401);

    let resp = server
        .delete_bearer("/api/skills/local-test", &agent_token)
        .await;
    assert_eq!(resp.status(), 403);

    let resp = server
        .patch("/api/plugins/signet.secrets", json!({"enabled": false}))
        .await;
    assert_eq!(resp.status(), 401);

    let resp = server
        .patch_bearer(
            "/api/plugins/signet.secrets",
            json!({"enabled": false}),
            &agent_token,
        )
        .await;
    assert_eq!(resp.status(), 403);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn marketplace_reviews_enforces_team_auth_on_mutations() {
    let server = TestServer::start_team_auth().await;
    let token = TestServer::scoped_token("default");
    let readonly_token = TestServer::scoped_role_token("default", "readonly");

    let review_body = json!({
        "targetType": "skill",
        "targetId": "skills.sh/private",
        "displayName": "avery",
        "rating": 4,
        "title": "Useful",
        "body": "Scoped write"
    });

    let resp = server
        .post("/api/marketplace/reviews", review_body.clone())
        .await;
    assert_eq!(resp.status(), 401);

    let resp = server
        .get_bearer("/api/marketplace/reviews", &readonly_token)
        .await;
    assert_eq!(resp.status(), 200);

    let resp = server
        .post_bearer(
            "/api/marketplace/reviews",
            review_body.clone(),
            &readonly_token,
        )
        .await;
    assert_eq!(resp.status(), 403);

    let resp = server
        .post_bearer("/api/marketplace/reviews", review_body, &token)
        .await;
    assert_eq!(resp.status(), 200);

    let resp = server
        .patch("/api/marketplace/reviews/config", json!({"enabled": true}))
        .await;
    assert_eq!(resp.status(), 401);

    let resp = server
        .patch_bearer(
            "/api/marketplace/reviews/config",
            json!({"enabled": true}),
            &token,
        )
        .await;
    assert_eq!(resp.status(), 200);

    let resp = server
        .patch_bearer(
            "/api/marketplace/reviews/config",
            json!({"enabled": false}),
            &readonly_token,
        )
        .await;
    assert_eq!(resp.status(), 403);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn marketplace_reviews_preserve_concurrent_file_writes() {
    let server = TestServer::start().await;
    let mut handles = Vec::new();

    for i in 0..20 {
        let client = server.client.clone();
        let url = format!("{}/api/marketplace/reviews", server.base);
        handles.push(tokio::spawn(async move {
            client
                .post(url)
                .json(&json!({
                    "targetType": "skill",
                    "targetId": "skills.sh/concurrent",
                    "displayName": format!("reviewer-{i}"),
                    "rating": 5,
                    "title": format!("Review {i}"),
                    "body": format!("Concurrent review {i}")
                }))
                .send()
                .await
                .expect("create review request")
        }));
    }

    for handle in handles {
        let resp = handle.await.expect("review task join");
        assert_eq!(resp.status(), 200);
    }

    let resp = server
        .get("/api/marketplace/reviews?type=skill&id=skills.sh%2Fconcurrent")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["total"], 20);
    assert_eq!(body["summary"]["count"], 20);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn marketplace_reviews_reject_invalid_storage_and_rating_without_overwrite() {
    let server = TestServer::start().await;
    let marketplace_dir = server._tmpdir.path().join("marketplace");
    std::fs::create_dir_all(&marketplace_dir).expect("create marketplace dir");
    let reviews_path = marketplace_dir.join("reviews.json");
    std::fs::write(&reviews_path, "not valid json").expect("write malformed reviews ledger");

    let resp = server
        .post(
            "/api/marketplace/reviews",
            json!({
                "targetType": "skill",
                "targetId": "skills.sh/corrupt",
                "displayName": "avery",
                "rating": 5,
                "title": "Great",
                "body": "Should not overwrite malformed data"
            }),
        )
        .await;
    assert_eq!(resp.status(), 500);
    assert_eq!(
        std::fs::read_to_string(&reviews_path).expect("read malformed reviews ledger"),
        "not valid json"
    );

    std::fs::write(&reviews_path, "[]").expect("reset reviews ledger");
    let resp = server
        .post(
            "/api/marketplace/reviews",
            json!({
                "targetType": "skill",
                "targetId": "skills.sh/rating",
                "displayName": "avery",
                "rating": 0.6,
                "title": "Invalid",
                "body": "Raw rating below one must be rejected"
            }),
        )
        .await;
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn existing_documented_routes_remain_mounted() {
    let server = TestServer::start().await;

    let resp = server.get("/api/auth/whoami").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["authenticated"], false);
    assert_eq!(body["claims"], serde_json::Value::Null);
    assert_eq!(body["mode"], "local");

    let resp = server.get("/api/memories/most-used?limit=2").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body["memories"].is_array());

    let resp = server.get("/api/embeddings/status").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body.get("provider").is_some());
    assert!(body.get("model").is_some());
    assert!(body.get("available").is_some());
    assert!(body.get("tracker").is_some());

    let resp = server.get("/api/embeddings/health").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body.get("status").is_some());
    assert!(body.get("score").is_some());
    assert!(body.get("checkedAt").is_some());
    assert!(body.get("config").is_some());
    let checks = body["checks"].as_array().expect("health checks array");
    let check_names: Vec<&str> = checks
        .iter()
        .filter_map(|check| check.get("name").and_then(|name| name.as_str()))
        .collect();
    assert!(check_names.contains(&"provider-available"));
    assert!(check_names.contains(&"coverage"));
    assert!(check_names.contains(&"dimension-mismatch"));
    assert!(check_names.contains(&"model-drift"));
    assert!(check_names.contains(&"null-vectors"));
    assert!(check_names.contains(&"vec-table-sync"));
    assert!(check_names.contains(&"orphaned-embeddings"));

    let resp = server
        .get("/api/embeddings/projection?dimensions=3&limit=5")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["status"], "ready");
    assert_eq!(body["dimensions"], 3);
    assert_eq!(body["count"], 0);
    assert_eq!(body["limit"], 5);
    assert!(
        body["nodes"]
            .as_array()
            .expect("projection nodes")
            .is_empty()
    );
    assert!(
        body["edges"]
            .as_array()
            .expect("projection edges")
            .is_empty()
    );

    let resp = server.post("/api/memory/forget", json!({})).await;
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn dashboard_openclaw_and_harness_routes_replay_ts_shapes() {
    let server = TestServer::start().await;

    let resp = server.get("/").await;
    assert_eq!(resp.status(), 200);
    let body = resp.text().await.expect("root dashboard fallback body");
    assert!(body.contains("Signet Daemon"));
    assert!(body.contains("dashboard is not installed"));

    let resp = server.get("/api/home/greeting").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(
        body["greeting"]
            .as_str()
            .unwrap_or_default()
            .starts_with("good ")
    );
    assert!(body.get("cachedAt").is_some());

    let resp = server.get("/api/diagnostics/openclaw").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["status"], "never-seen");
    assert_eq!(body["lastHeartbeat"], serde_json::Value::Null);
    assert_eq!(body["pluginVersion"], serde_json::Value::Null);
    assert_eq!(body["hooksSucceeded"], 0);
    assert_eq!(body["hooksFailed"], 0);

    let resp = server
        .post(
            "/api/diagnostics/openclaw/heartbeat",
            json!({
                "pluginVersion": "0.1.0",
                "hooksRegistered": ["prompt-submit", "session-end"],
                "lastHookCall": "prompt-submit",
                "lastError": null,
                "latencyMs": 12.5,
                "hooksSucceeded": 3,
                "hooksFailed": 1,
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["ok"], true);

    let resp = server.get("/api/diagnostics/openclaw").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["status"], "connected");
    assert_eq!(body["pluginVersion"], "0.1.0");
    assert_eq!(body["hooksSucceeded"], 3);
    assert_eq!(body["hooksFailed"], 1);
    assert_eq!(body["lastLatencyMs"], 12.5);
    assert_eq!(body["lastError"], serde_json::Value::Null);
    assert_eq!(
        body["hooksRegistered"]
            .as_array()
            .expect("hooks registered")
            .len(),
        2
    );

    let resp = server.get("/api/harnesses").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let harnesses = body["harnesses"].as_array().expect("harnesses array");
    assert_eq!(harnesses.len(), 4);
    assert_eq!(harnesses[0]["name"], "Claude Code");
    assert_eq!(harnesses[0]["id"], "claude-code");
    assert!(
        harnesses[0]["path"]
            .as_str()
            .expect("claude path")
            .ends_with(".claude/settings.json")
    );
    assert_eq!(harnesses[0]["lastSeen"], serde_json::Value::Null);
    assert_eq!(harnesses[1]["name"], "OpenCode");
    assert_eq!(harnesses[1]["id"], "opencode");
    assert!(
        harnesses[1]["path"]
            .as_str()
            .expect("opencode path")
            .ends_with(".config/opencode/AGENTS.md")
    );
    assert_eq!(harnesses[1]["lastSeen"], serde_json::Value::Null);
    assert_eq!(harnesses[2]["name"], "OpenClaw");
    assert_eq!(harnesses[2]["id"], "openclaw");
    assert!(
        harnesses[2]["path"]
            .as_str()
            .expect("openclaw path")
            .ends_with("AGENTS.md")
    );
    assert!(
        harnesses[2]["lastSeen"]
            .as_str()
            .expect("openclaw lastSeen")
            .contains('T')
    );
    assert_eq!(harnesses[3]["name"], "Gemini CLI");
    assert_eq!(harnesses[3]["id"], "gemini");
    assert!(
        harnesses[3]["path"]
            .as_str()
            .expect("gemini path")
            .ends_with(".gemini/settings.json")
    );
    assert_eq!(harnesses[3]["lastSeen"], serde_json::Value::Null);

    let resp = server.post("/api/harnesses/regenerate", json!({})).await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["success"], false);
    assert_eq!(body["error"], "Regeneration script not found");

    let scripts_dir = server._tmpdir.path().join("scripts");
    std::fs::create_dir_all(&scripts_dir).expect("create harness scripts dir");
    std::fs::write(
        scripts_dir.join("generate-harness-configs.py"),
        "print('regenerated from workspace scripts')\n",
    )
    .expect("write harness regeneration script");

    let resp = server.post("/api/harnesses/regenerate", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["message"], "Configs regenerated successfully");
    assert!(
        body["output"]
            .as_str()
            .expect("regeneration output")
            .contains("regenerated from workspace scripts")
    );
}

async fn wait_for_file_contains(path: &std::path::Path, needle: &str) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        if let Ok(content) = std::fs::read_to_string(path)
            && content.contains(needle)
        {
            return content;
        }
        if tokio::time::Instant::now() > deadline {
            panic!(
                "timed out waiting for {} to contain {needle}",
                path.display()
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_http_status(
    server: &TestServer,
    path: &str,
    expected: reqwest::StatusCode,
) -> reqwest::Response {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let mut last = "none".to_string();
    loop {
        if tokio::time::Instant::now() > deadline {
            panic!("timed out waiting for {path} to return {expected}; last response: {last}");
        }
        let resp = server.get(path).await;
        let status = resp.status();
        if status == expected {
            return resp;
        }
        last = format!(
            "{status}: {}",
            resp.text()
                .await
                .unwrap_or_else(|err| format!("failed to read response body: {err}"))
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_legacy_memory_import(
    server: &TestServer,
    source_prefix: &str,
) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
        let row = conn
            .query_row(
                "SELECT id, content, source_type, source_id, tags, who, importance
                 FROM memories
                 WHERE source_type = 'openclaw-memory-log'
                   AND source_id LIKE ?1
                   AND is_deleted = 0
                 LIMIT 1",
                [format!("{source_prefix}%")],
                |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "content": row.get::<_, String>(1)?,
                        "sourceType": row.get::<_, String>(2)?,
                        "sourceId": row.get::<_, String>(3)?,
                        "tags": row.get::<_, String>(4)?,
                        "who": row.get::<_, String>(5)?,
                        "importance": row.get::<_, f64>(6)?,
                    }))
                },
            )
            .ok();
        if let Some(row) = row {
            return row;
        }
        if tokio::time::Instant::now() > deadline {
            panic!("timed out waiting for legacy memory import with prefix {source_prefix}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn legacy_memory_import_count(server: &TestServer) -> i64 {
    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    conn.query_row(
        "SELECT COUNT(*)
         FROM memories
         WHERE source_type = 'openclaw-memory-log'
           AND is_deleted = 0",
        [],
        |row| row.get(0),
    )
    .expect("count legacy memory imports")
}

async fn wait_for_filesystem_connector_sync(server: &TestServer) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let snapshot = conn
            .query_row(
                r#"SELECT
                     c.status,
                     c.cursor_json,
                     c.last_sync_at,
                     d.id,
                     d.source_url,
                     d.title,
                     d.raw_content,
                     d.connector_id,
                     j.status,
                     j.job_type,
                     j.payload,
                     (SELECT COUNT(*) FROM documents),
                     (SELECT COUNT(*) FROM memory_jobs WHERE job_type = 'document_ingest')
                   FROM connectors c
                   JOIN documents d ON d.title = 'a.md'
                   JOIN memory_jobs j ON j.document_id = d.id
                   WHERE c.id = 'connector-fs-row'
                   LIMIT 1"#,
                [],
                |row| {
                    Ok(serde_json::json!({
                        "connectorStatus": row.get::<_, String>(0)?,
                        "cursorJson": row.get::<_, String>(1)?,
                        "lastSyncAt": row.get::<_, String>(2)?,
                        "documentId": row.get::<_, String>(3)?,
                        "sourceUrl": row.get::<_, String>(4)?,
                        "title": row.get::<_, String>(5)?,
                        "rawContent": row.get::<_, String>(6)?,
                        "documentConnectorId": row.get::<_, String>(7)?,
                        "jobStatus": row.get::<_, String>(8)?,
                        "jobType": row.get::<_, String>(9)?,
                        "jobPayload": row.get::<_, String>(10)?,
                        "documentCount": row.get::<_, i64>(11)?,
                        "documentIngestJobCount": row.get::<_, i64>(12)?,
                    }))
                },
            )
            .ok();
        if let Some(snapshot) = snapshot
            && snapshot["connectorStatus"] == "idle"
        {
            return snapshot;
        }
        if tokio::time::Instant::now() > deadline {
            panic!("timed out waiting for filesystem connector sync");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn run_git(dir: &std::path::Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap_or_else(|err| panic!("failed to run git {args:?}: {err}"));
    if !output.status.success() {
        panic!(
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    String::from_utf8_lossy(&output.stdout).to_string()
}

async fn wait_for_git_log_contains(dir: &std::path::Path, needle: &str) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let output = run_git(dir, &["log", "-1", "--name-only", "--pretty=%s"]);
        if output.contains(needle) {
            return output;
        }
        if tokio::time::Instant::now() > deadline {
            panic!("timed out waiting for git log to contain {needle}; last log:\n{output}");
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn watcher_syncs_identity_workspaces_and_architecture_doc() {
    let server = TestServer::start_with_agent_yaml_and_files(
        None,
        "agent:\n  name: test-agent\n  version: 1\n",
        &[
            ("AGENTS.md", "# Root Agent\n"),
            ("SOUL.md", "root soul"),
            ("IDENTITY.md", "root identity"),
            ("USER.md", "root user"),
            ("MEMORY.md", "root memory"),
            ("agents/writer/SOUL.md", "agent soul"),
        ],
    )
    .await;

    let workspace_agents = server
        ._tmpdir
        .path()
        .join("agents/writer/workspace/AGENTS.md");
    let architecture_doc = server._tmpdir.path().join("SIGNET-ARCHITECTURE.md");
    let content = wait_for_file_contains(&workspace_agents, "## USER\n\nroot user").await;
    assert!(content.contains("# Root Agent"));
    assert!(content.contains("## SOUL\n\nagent soul"));
    assert!(content.contains("## IDENTITY\n\nroot identity"));
    assert!(content.contains("## MEMORY\n\nroot memory"));

    let architecture = wait_for_file_contains(&architecture_doc, "Do not edit").await;
    assert!(architecture.contains("Identity files are your durable substrate"));

    std::fs::write(server._tmpdir.path().join("USER.md"), "updated root user")
        .expect("update root USER.md");
    let updated = wait_for_file_contains(&workspace_agents, "updated root user").await;
    assert!(updated.contains("## USER\n\nupdated root user"));
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn watcher_reloads_auth_config_without_restart() {
    let server = TestServer::start().await;

    let resp = server.get("/api/auth/whoami").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["mode"], "local");

    std::fs::write(
        server._tmpdir.path().join("agent.yaml"),
        "agent:\n  name: test-agent\n  version: 1\nauth:\n  method: token\n  mode: team\n",
    )
    .expect("switch auth mode to team");

    let resp = wait_for_http_status(
        &server,
        "/api/auth/whoami",
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
    let body = server.json(resp).await;
    assert_eq!(body["error"], "authentication required");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn watcher_imports_legacy_memory_markdown_and_skips_generated_files() {
    let legacy_content = "## Legacy Import\n\nThis chunk contains a meaningful amount of legacy memory log content that should be imported into the Rust daemon memory database with openclaw metadata.";
    let skipped_content = "## Generated\n\nThis generated memory content is intentionally long enough that it would be imported if the filename filter did not match the TypeScript daemon exclusions.";
    let server = TestServer::start_with_agent_yaml_and_files(
        None,
        "agent:\n  name: test-agent\n  version: 1\n",
        &[
            ("memory/2026-02-10-signet.md", legacy_content),
            ("memory/MEMORY.md", skipped_content),
            (
                "memory/MEMORY.backup-2026-03-31T21-17-05.md",
                skipped_content,
            ),
            (
                "memory/2026-03-01T00-09-52.500Z--abc12345--summary.md",
                skipped_content,
            ),
        ],
    )
    .await;

    let row = wait_for_legacy_memory_import(&server, "openclaw:2026-02-10-signet:").await;
    assert_eq!(row["sourceType"], "openclaw-memory-log");
    assert_eq!(row["who"], "openclaw-memory");
    assert_eq!(row["importance"], 0.65);
    assert!(
        row["content"]
            .as_str()
            .unwrap()
            .contains("## Legacy Import")
    );
    let tags = serde_json::from_str::<Vec<String>>(row["tags"].as_str().unwrap()).unwrap();
    assert_eq!(
        tags,
        vec![
            "openclaw",
            "memory-log",
            "2026-02-10",
            "2026-02-10-signet",
            "hierarchical-section"
        ]
    );
    assert_eq!(legacy_memory_import_count(&server), 1);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn watcher_polls_new_legacy_memory_markdown_files() {
    let server = TestServer::start().await;
    assert_eq!(legacy_memory_import_count(&server), 0);

    std::fs::write(
        server._tmpdir.path().join("memory/2026-03-12-live.md"),
        "## Live Import\n\nThis live memory markdown file is added after daemon startup and should be picked up by the Rust legacy memory import poller.",
    )
    .expect("write live legacy memory markdown file");

    let row = wait_for_legacy_memory_import(&server, "openclaw:2026-03-12-live:").await;
    assert_eq!(row["sourceType"], "openclaw-memory-log");
    assert_eq!(row["who"], "openclaw-memory");
    assert!(row["content"].as_str().unwrap().contains("## Live Import"));
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn watcher_auto_commits_changed_workspace_paths() {
    let server = TestServer::start_with_agent_yaml_files_and_setup(
        None,
        "agent:\n  name: test-agent\n  version: 1\ngit:\n  autoCommit: true\n",
        &[("AGENTS.md", "# Root Agent\n")],
        |dir| {
            run_git(dir, &["init", "-b", "main"]);
            run_git(dir, &["config", "user.email", "replay@example.com"]);
            run_git(dir, &["config", "user.name", "Replay Bot"]);
            run_git(dir, &["add", "agent.yaml", "AGENTS.md"]);
            run_git(dir, &["commit", "-m", "initial"]);
        },
    )
    .await;

    let config: serde_json::Value = server.get("/api/git/config").await.json().await.unwrap();
    assert_eq!(config["autoCommit"], true);

    std::fs::write(server._tmpdir.path().join("USER.md"), "autocommit user")
        .expect("write USER.md");

    let log = wait_for_git_log_contains(server._tmpdir.path(), "USER.md").await;
    assert!(log.contains("_auto_"));
    assert!(log.contains("USER.md"));
    assert!(
        run_git(
            server._tmpdir.path(),
            &["status", "--porcelain", "--", "USER.md"]
        )
        .trim()
        .is_empty()
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn provider_safety_routes_replay_empty_audit_and_validation() {
    let server = TestServer::start().await;

    let resp = server.get("/api/config/provider-safety").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body.get("snapshot").is_some());
    assert!(
        body["transitions"]
            .as_array()
            .expect("provider transitions")
            .is_empty()
    );
    assert_eq!(body["latestRiskyTransition"], serde_json::Value::Null);

    let resp = server
        .post(
            "/api/config/provider-safety/rollback",
            json!({"role": "memory"}),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "role must be 'extraction' or 'synthesis'");

    let resp = server
        .post("/api/config/provider-safety/rollback", json!({}))
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"],
        "No provider transition with rollback target found"
    );

    std::fs::write(
        server._tmpdir.path().join("agent.yaml"),
        "agent:\n  name: test-agent\n  version: 1\nmemory:\n  pipelineV2:\n    extractionProvider: anthropic\n    extractionModel: claude-3-haiku\n    extractionEndpoint: https://api.anthropic.com\n    extraction:\n      provider: anthropic\n      model: claude-3-haiku\n      endpoint: https://api.anthropic.com\n",
    )
    .expect("write provider rollback config");
    std::fs::write(
        server
            ._tmpdir
            .path()
            .join(".daemon/provider-transitions.json"),
        serde_json::to_string_pretty(&json!([
            {
                "role": "extraction",
                "from": "ollama",
                "to": "anthropic",
                "timestamp": "2026-06-02T00:00:00.000Z",
                "source": "agent.yaml",
                "risky": true
            }
        ]))
        .expect("provider transitions json"),
    )
    .expect("write provider transitions");

    let resp = server
        .post(
            "/api/config/provider-safety/rollback",
            json!({"role": "extraction"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["file"], "agent.yaml");
    assert_eq!(body["rolledBack"]["from"], "ollama");
    assert_eq!(body["rolledBack"]["to"], "anthropic");
    assert_eq!(body["rolledBack"]["rolledBack"], true);

    let config = std::fs::read_to_string(server._tmpdir.path().join("agent.yaml"))
        .expect("read rolled back config");
    assert!(config.contains("extractionProvider: ollama"));
    assert!(config.contains("provider: ollama"));
    assert!(!config.contains("claude-3-haiku"));
    assert!(!config.contains("anthropic.com"));

    let transitions: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            server
                ._tmpdir
                .path()
                .join(".daemon/provider-transitions.json"),
        )
        .expect("read provider transitions"),
    )
    .expect("parse provider transitions");
    assert_eq!(transitions[0]["rolledBack"], true);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn reflection_routes_replay_empty_and_validation_shapes() {
    let server = TestServer::start().await;

    let resp = server.get("/api/reflections/today?agentId=agent-r").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["reflection"], serde_json::Value::Null);
    assert!(
        body["reflections"]
            .as_array()
            .expect("today reflections")
            .is_empty()
    );

    let resp = server
        .get("/api/reflections?agentId=agent-r&limit=-1")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(
        body["reflections"]
            .as_array()
            .expect("reflection list")
            .is_empty()
    );

    let resp = server
        .post(
            "/api/reflections/generate?agentId=agent-r&count=2",
            json!({}),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Reflections are disabled in pipeline config");

    let resp = server
        .post("/api/reflections/reflection-missing/answer", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "answer is required");

    let resp = server
        .post(
            "/api/reflections/reflection-missing/answer?agentId=agent-r",
            json!({"answer": "Keep this insight"}),
        )
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Reflection not found");

    server.seed_reflection_fixture();
    let resp = server
        .post(
            "/api/reflections/reflection-answer-replay/answer?agentId=agent-r",
            json!({"answer": "  Ship the reflection parity fix.  "}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    let memory_id = body["memoryId"].as_str().expect("memory id");

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    let stored = conn
        .query_row(
            "SELECT r.answer, r.answer_memory_id, m.content, m.agent_id, m.source_type, m.source_id, m.content_hash
             FROM daily_reflections r
             JOIN memories m ON m.id = r.answer_memory_id
             WHERE r.id = 'reflection-answer-replay'",
            [],
            |row| {
                Ok(serde_json::json!({
                    "answer": row.get::<_, String>(0)?,
                    "answerMemoryId": row.get::<_, String>(1)?,
                    "content": row.get::<_, String>(2)?,
                    "agentId": row.get::<_, String>(3)?,
                    "sourceType": row.get::<_, String>(4)?,
                    "sourceId": row.get::<_, String>(5)?,
                    "contentHash": row.get::<_, String>(6)?,
                }))
            },
        )
        .expect("reflection answer row");
    assert_eq!(stored["answer"], "Ship the reflection parity fix.");
    assert_eq!(stored["answerMemoryId"], memory_id);
    assert_eq!(stored["content"], "Ship the reflection parity fix.");
    assert_eq!(stored["agentId"], "agent-r");
    assert_eq!(stored["sourceType"], "reflection-answer");
    assert_eq!(stored["sourceId"], "reflection-answer-replay");
    assert_eq!(
        stored["contentHash"],
        "reflection-a-reflection-answer-replay"
    );

    let resp = server
        .post(
            "/api/reflections/reflection-answer-replay/answer?agentId=agent-r",
            json!({"answer": "Second answer."}),
        )
        .await;
    assert_eq!(resp.status(), 409);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Already answered");
}

const ANALYTICS_REPLAY_YAML: &str = r#"agent:
  name: test-agent
  version: 1
memory:
  pipelineV2:
    enabled: true
    extraction:
      provider: openrouter
      fallbackProvider: none
"#;

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn analytics_collector_routes_record_request_counters_and_latency() {
    let server = TestServer::start_with_agent_yaml(None, ANALYTICS_REPLAY_YAML).await;
    server.seed_memory_safety_history_fixture();

    let resp = server
        .get_with_actor("/api/status", "analytics-actor")
        .await;
    assert_eq!(resp.status(), 200);
    let resp = server
        .post_with_actor(
            "/api/memory/remember",
            json!({"content": "Analytics parity memory", "type": "fact"}),
            "analytics-actor",
        )
        .await;
    assert_eq!(resp.status(), 200);
    let resp = server
        .post_with_actor(
            "/api/memory/recall",
            json!({"query": "Analytics parity memory", "limit": 1}),
            "analytics-actor",
        )
        .await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/analytics/usage").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["endpoints"]["GET /api/status"]["count"], 1);
    assert_eq!(body["endpoints"]["GET /api/status"]["errors"], 0);
    assert!(
        body["endpoints"]["GET /api/status"]["totalLatencyMs"]
            .as_i64()
            .is_some()
    );
    assert_eq!(body["endpoints"]["POST /api/memory/remember"]["count"], 1);
    assert_eq!(body["endpoints"]["POST /api/memory/recall"]["count"], 1);
    assert_eq!(body["actors"]["analytics-actor"]["requests"], 1);
    assert_eq!(body["actors"]["analytics-actor"]["remembers"], 1);
    assert_eq!(body["actors"]["analytics-actor"]["recalls"], 1);
    assert_eq!(body["actors"]["analytics-actor"]["mutations"], 0);
    assert!(body["providers"].is_object());
    assert!(body["connectors"].is_object());

    let resp = server
        .get("/api/analytics/errors?stage=extraction&limit=5")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let errors = body["errors"].as_array().expect("errors");
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0]["stage"], "extraction");
    assert_eq!(errors[0]["code"], "EXTRACTION_PROVIDER_BLOCKED");
    assert_eq!(errors[0]["actor"], "api");
    assert!(
        errors[0]["message"]
            .as_str()
            .expect("error message")
            .contains("openrouter is not supported by daemon-rs extraction worker")
    );
    assert!(errors[0]["memoryId"].as_str().is_some());
    assert_eq!(body["summary"]["EXTRACTION_PROVIDER_BLOCKED"], 1);

    let resp = server
        .get("/api/analytics/errors?stage=mutation&limit=5")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(
        body["errors"]
            .as_array()
            .expect("mutation errors")
            .is_empty()
    );

    let resp = server.get("/api/analytics/latency").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["remember"]["count"], 1);
    assert_eq!(body["recall"]["count"], 1);
    assert!(body["remember"]["p50"].as_i64().is_some());
    assert_eq!(body["predictor_train"]["p95"], 0);

    let log_path = server
        ._tmpdir
        .path()
        .join(".daemon/logs/analytics-replay.jsonl");
    std::fs::write(
        &log_path,
        [
            r#"{"timestamp":"2026-01-01T00:00:00.000Z","level":"error","category":"analytics","message":"old analytics error"}"#,
            r#"{"timestamp":"2026-01-02T00:00:00.000Z","level":"warn","category":"analytics","message":"wrong level"}"#,
            r#"{"timestamp":"2026-01-03T00:00:00.000Z","level":"error","category":"pipeline","message":"wrong category"}"#,
            r#"{"timestamp":"2026-01-04T00:00:00.000Z","level":"error","category":"analytics","message":"live analytics error"}"#,
        ]
        .join("\n"),
    )
    .expect("write analytics log fixture");

    let resp = server
        .get("/api/analytics/logs?limit=5&level=error&category=analytics&since=2026-01-02T00:00:00.000Z")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["logs"][0]["message"], "live analytics error");
    assert_eq!(body["logs"][0]["level"], "error");
    assert_eq!(body["logs"][0]["category"], "analytics");

    let resp = server.get("/api/analytics/memory-safety").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["mutation"]["status"], "degraded");
    assert_eq!(body["mutation"]["score"], 0.7);
    assert_eq!(body["mutation"]["recentRecovers"], 6);
    assert_eq!(body["mutation"]["recentDeletes"], 1);
    assert!(
        body["recentErrors"]
            .as_array()
            .expect("recent errors")
            .is_empty()
    );
    assert_eq!(body["errorSummary"]["EXTRACTION_PROVIDER_BLOCKED"], 1);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn auth_token_route_mints_scoped_tokens_and_whoami_reads_bearer() {
    let server = TestServer::start_team_auth().await;
    let admin_token = TestServer::scoped_role_token("default", "admin");

    let resp = server
        .post_bearer(
            "/api/auth/token",
            json!({
                "role": "agent",
                "scope": {"agent": "worker-a"},
                "ttlSeconds": 60
            }),
            &admin_token,
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let minted = body["token"].as_str().expect("token");
    assert!(body["expiresAt"].as_str().is_some_and(|s| s.ends_with('Z')));

    let resp = server.get_bearer("/api/auth/whoami", minted).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["authenticated"], true);
    assert_eq!(body["claims"]["role"], "agent");
    assert_eq!(body["claims"]["scope"]["agent"], "worker-a");

    let resp = server
        .post_bearer("/api/auth/token", json!({"role": "readonly"}), minted)
        .await;
    assert_eq!(resp.status(), 403);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn database_diagnostics_schema_and_samples_replay_ts_shape() {
    let server = TestServer::start().await;

    let resp = server.get("/api/diagnostics/database/schema").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body["generatedAt"].as_str().is_some());
    assert!(body["groups"]["core"].as_i64().is_some_and(|n| n > 0));
    let tables = body["tables"].as_array().expect("tables");
    let memories = tables
        .iter()
        .find(|table| table["name"] == "memories")
        .expect("memories table");
    assert_eq!(memories["group"], "core");
    assert_eq!(memories["sampleAllowed"], true);
    assert!(
        memories["columns"]
            .as_array()
            .is_some_and(|cols| !cols.is_empty())
    );
    assert!(memories["indexes"].as_array().is_some());
    assert!(memories["foreignKeys"].as_array().is_some());

    let resp = server
        .get("/api/diagnostics/database/tables/memories/sample?limit=2&offset=0")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["table"], "memories");
    assert_eq!(body["limit"], 2);
    assert_eq!(body["offset"], 0);
    assert!(
        body["columns"]
            .as_array()
            .is_some_and(|cols| cols.iter().any(|col| col == "id"))
    );
    assert!(body["rows"].as_array().is_some());
    assert!(body["hasMore"].as_bool().is_some());

    let resp = server
        .get("/api/diagnostics/database/tables/not_a_table/sample")
        .await;
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn changelog_roadmap_and_readme_routes_render_local_docs() {
    let server = TestServer::start().await;

    let resp = server.get("/api/changelog").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["source"], "local");
    assert!(body["cachedAt"].as_i64().is_some());
    let html = body["html"].as_str().expect("changelog html");
    assert!(html.contains("<h1>Changelog</h1>"));
    assert!(html.contains("<h2>[0.138."));

    let resp = server.get("/api/roadmap").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["source"], "local");
    let html = body["html"].as_str().expect("roadmap html");
    assert!(html.contains("<h1>Roadmap</h1>"));
    assert!(html.contains("Rust daemon parity"));

    let resp = server.get("/api/readme").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["source"], "local");
    let html = body["html"].as_str().expect("readme html");
    assert!(html.contains("Signet"));
    assert!(html.contains("Own your agent's context"));
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn telemetry_memory_search_native_list_and_export() {
    let server = TestServer::start().await;
    server.seed_memory_search_telemetry_fixture();

    let resp = server.get("/api/telemetry/events?limit=5").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["enabled"], true);
    assert!(body["events"].as_array().expect("events").is_empty());

    let resp = server.get("/api/telemetry/stats").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["enabled"], true);
    assert_eq!(body["totalEvents"], 0);
    assert_eq!(body["llm"]["calls"], 0);
    assert_eq!(body["llm"]["p50"], 0);
    assert_eq!(body["pipelineErrors"], 0);

    let resp = server.get("/api/telemetry/export?limit=5").await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/x-ndjson")
    );
    assert_eq!(resp.text().await.expect("telemetry export body"), "");

    let resp = server
        .get("/api/telemetry/memory-search?agent_id=ant&project=/workspace/a&limit=10")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 2);
    assert_eq!(body["items"][0]["id"], "telemetry-hit");
    assert_eq!(body["items"][0]["filters"]["limit"], 3);
    assert_eq!(body["items"][0]["timings"]["totalMs"], 12.5);
    assert_eq!(body["items"][0]["results"][0]["id"], "mem-telemetry");
    assert_eq!(body["items"][0]["sources"]["memory"], "local");

    let resp = server
        .get("/api/telemetry/memory-search?agentId=ant&no_hits=true")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["items"][0]["id"], "telemetry-miss");
    assert_eq!(body["items"][0]["method"], "keyword");
    assert_eq!(body["items"][0]["no_hits"], true);

    let resp = server
        .get("/api/telemetry/memory-search/export?agent_id=ant&no_hits=false")
        .await;
    assert_eq!(resp.status(), 200);
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let text = resp.text().await.expect("export text");
    assert!(content_type.contains("application/x-ndjson"));
    assert!(text.contains("telemetry-hit"));
    assert!(!text.contains("telemetry-miss"));
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn continuity_analytics_and_checkpoint_routes_replay_ts_shape() {
    let server = TestServer::start().await;
    let project = server.seed_continuity_and_checkpoint_fixture();

    let resp = server.get("/api/analytics/continuity?limit=10").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["summary"]["count"], 3);

    let resp = server
        .get(&format!(
            "/api/analytics/continuity?project={project}&limit=10"
        ))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["summary"]["count"], 2);
    assert_eq!(body["summary"]["average"], 0.65);
    assert_eq!(body["summary"]["trend"], 0.5);
    assert_eq!(body["summary"]["latest"], 0.9);
    assert_eq!(body["scores"][0]["id"], "score-new");

    let resp = server.get("/api/analytics/continuity/latest").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(
        body["scores"]
            .as_array()
            .is_some_and(|scores| scores.iter().any(|score| score["project"] == project))
    );

    let resp = server.get("/api/checkpoints").await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "project query parameter required");

    let resp = server
        .get(&format!("/api/checkpoints?project={project}&limit=5"))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 2);
    assert_eq!(body["checkpoints"][0]["id"], "checkpoint-new");
    assert_eq!(body["checkpoints"][0]["focal_entity_names"], "[\"Signet\"]");
    assert!(body["checkpoints"][0]["digest"]
        .as_str()
        .is_some_and(|digest| digest.contains("[REDACTED]") && !digest.contains("super-secret")));
    assert!(
        body["checkpoints"][0]["recent_remembers"]
            .as_str()
            .is_some_and(
                |remember| remember.contains("[REDACTED]") && !remember.contains("sk-test")
            )
    );

    let resp = server.get("/api/checkpoints/session-continuity-a").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 2);
    assert_eq!(body["checkpoints"][1]["id"], "checkpoint-old");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn plugins_native_registry_prompt_and_audit() {
    let server = TestServer::start().await;
    server.seed_plugin_audit_fixture();

    let resp = server.get("/api/plugins").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["plugins"][0]["id"], "signet.secrets");
    assert_eq!(body["plugins"][0]["state"], "active");
    assert_eq!(
        body["plugins"][0]["surfaces"]["sdkClients"][0]["name"],
        "listSecrets"
    );

    let resp = server.get("/api/plugins/signet.secrets/diagnostics").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["plugin"]["record"]["id"], "signet.secrets");
    assert_eq!(
        body["plugin"]["activeSurfaces"]["mcpTools"][0]["name"],
        "secret_list"
    );
    assert_eq!(
        body["plugin"]["plannedSurfaces"]["daemonRoutes"][0]["path"],
        "/api/secrets"
    );
    assert_eq!(
        body["plugin"]["promptContributionDiagnostics"][0]["included"],
        true
    );

    let resp = server.get("/api/plugins/prompt-contributions").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["activeCount"], 1);
    assert_eq!(body["contributions"][0]["pluginId"], "signet.secrets");

    let resp = server
        .patch("/api/plugins/signet.secrets", json!({"enabled": false}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["plugin"]["enabled"], false);
    assert_eq!(body["plugin"]["state"], "disabled");

    let resp = server.get("/api/plugins/prompt-contributions").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["activeCount"], 0);
    assert_eq!(body["contributions"], json!([]));

    let resp = server
        .get("/api/plugins/audit?pluginId=signet.secrets&limit=5")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["events"][0]["event"], "plugin.enabled");
    assert_eq!(body["events"][0]["data"]["value"], "[REDACTED]");
    assert_eq!(body["events"][0]["data"]["secret"], "[REDACTED]");
    assert_eq!(
        body["events"][0]["data"]["nested"]["clientSecret"],
        "[REDACTED]"
    );
    assert!(
        body["events"][0]["data"]["command"]
            .as_str()
            .is_some_and(|command| command.contains("bun test") && !command.contains("raw-secret"))
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn plugin_audit_requires_analytics_permission() {
    let server = TestServer::start_team_auth().await;
    server.seed_plugin_audit_fixture();
    let agent_token = TestServer::scoped_token("default");
    let operator_token = TestServer::scoped_role_token("default", "operator");

    let resp = server
        .get("/api/plugins/audit?pluginId=signet.secrets&limit=5")
        .await;
    assert_eq!(resp.status(), 401);

    let resp = server
        .get_bearer(
            "/api/plugins/audit?pluginId=signet.secrets&limit=5",
            &agent_token,
        )
        .await;
    assert_eq!(resp.status(), 403);

    let resp = server
        .get_bearer(
            "/api/plugins/audit?pluginId=signet.secrets&limit=5",
            &operator_token,
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["events"][0]["event"], "plugin.enabled");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_native_proposal_lifecycle() {
    let server = TestServer::start().await;

    let resp = server
        .post(
            "/api/ontology/proposals",
            json!({
                "operation": "create_entity",
                "payload": {"name": "Signet Cloud", "entity_type": "project"},
                "confidence": 0.82,
                "rationale": "Observed in product planning notes",
                "evidence": [{"quote": "Signet Cloud offer"}],
                "createdBy": "contract-replay"
            }),
        )
        .await;
    assert_eq!(resp.status(), 201);
    let created = server.json(resp).await;
    let id = created["id"].as_str().expect("proposal id").to_string();
    assert_eq!(created["operation"], "create_entity");
    assert_eq!(created["status"], "pending");
    assert_eq!(created["payload"]["name"], "Signet Cloud");

    let resp = server
        .get("/api/ontology/proposals?status=pending&operation=create_entity")
        .await;
    assert_eq!(resp.status(), 200);
    let listed = server.json(resp).await;
    assert_eq!(listed["count"], 1);
    assert_eq!(listed["items"][0]["id"], id);

    let resp = server.get(&format!("/api/ontology/proposals/{id}")).await;
    assert_eq!(resp.status(), 200);
    let fetched = server.json(resp).await;
    assert_eq!(fetched["id"], id);

    let resp = server
        .get(&format!("/api/ontology/proposals/{id}/evidence"))
        .await;
    assert_eq!(resp.status(), 200);
    let evidence = server.json(resp).await;
    assert_eq!(evidence["proposal"]["id"], id);
    assert_eq!(evidence["count"], 1);

    let resp = server
        .post(
            &format!("/api/ontology/proposals/{id}/apply"),
            json!({"actor": "replay"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let applied = server.json(resp).await;
    assert_eq!(applied["id"], id);
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["appliedBy"], "replay");
    assert_eq!(applied["result"]["applied"], true);
    assert!(applied["result"]["entityId"].as_str().is_some());

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    let created_entity: (String, String, String) = conn
        .query_row(
            "SELECT id, entity_type, agent_id FROM entities WHERE name = 'Signet Cloud'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("applied proposal created entity");
    assert_eq!(created_entity.1, "project");
    assert_eq!(created_entity.2, "default");

    let claim_resp = server
        .post(
            "/api/ontology/proposals",
            json!({
                "operation": "add_claim_value",
                "payload": {
                    "entity": "Signet Cloud",
                    "entity_type": "project",
                    "aspect": "pricing",
                    "group_key": "commercial",
                    "claim_key": "monthly_price",
                    "value": "$10/mo"
                },
                "confidence": 0.7,
                "evidence": [{"quote": "ten dollars monthly"}],
                "sourceKind": "transcript"
            }),
        )
        .await;
    assert_eq!(claim_resp.status(), 201);
    let claim = server.json(claim_resp).await;
    let claim_id = claim["id"].as_str().expect("claim proposal id");
    let resp = server
        .post(
            &format!("/api/ontology/proposals/{claim_id}/apply"),
            json!({"actor": "replay"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let applied_claim = server.json(resp).await;
    assert!(applied_claim["result"]["attributeId"].as_str().is_some());
    let attr_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_attributes attr
             JOIN entity_aspects asp ON asp.id = attr.aspect_id
             WHERE asp.entity_id = ?1 AND asp.name = 'pricing' AND attr.claim_key = 'monthly_price'
               AND attr.content = '$10/mo' AND attr.proposal_id = ?2",
            rusqlite::params![created_entity.0, claim_id],
            |row| row.get(0),
        )
        .expect("attribute count");
    assert_eq!(attr_count, 1);

    let resp = server
        .post(
            &format!("/api/ontology/proposals/{claim_id}/apply"),
            json!({"actor": "replay"}),
        )
        .await;
    assert_eq!(resp.status(), 409);
    let conflict = server.json(resp).await;
    assert_eq!(conflict["error"], "Proposal is applied, not pending");
    let attr_count_after_retry: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_attributes attr
             JOIN entity_aspects asp ON asp.id = attr.aspect_id
             WHERE asp.entity_id = ?1 AND asp.name = 'pricing' AND attr.claim_key = 'monthly_price'
               AND attr.content = '$10/mo' AND attr.proposal_id = ?2",
            rusqlite::params![created_entity.0, claim_id],
            |row| row.get(0),
        )
        .expect("attribute count after retry");
    assert_eq!(attr_count_after_retry, 1);

    let resp = server
        .post(
            "/api/ontology/proposals/batch",
            json!({
                "proposals": [{
                    "operation": "add_claim",
                    "payload": {"entity": "Signet", "aspect": "pricing", "claim": "$10/mo"},
                    "confidence": 0.7
                }],
                "createdBy": "batch-replay"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let batch = server.json(resp).await;
    assert_eq!(batch["count"], 1);
    assert_eq!(batch["items"][0]["createdBy"], "batch-replay");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_proposals_enforce_authenticated_agent_scope() {
    let server = TestServer::start_team_auth().await;
    let other_agent_token = TestServer::scoped_token("other-agent");

    let proposal_body = json!({
        "operation": "create_entity",
        "payload": {"name": "Scoped Entity", "entityType": "concept"},
        "rationale": "scope regression test"
    });

    let resp = server
        .post("/api/ontology/proposals", proposal_body.clone())
        .await;
    assert_eq!(resp.status(), 401);

    let resp = server
        .post_bearer(
            "/api/ontology/proposals",
            json!({
                "agentId": "default",
                "operation": "create_entity",
                "payload": {"name": "Forbidden Entity"}
            }),
            &other_agent_token,
        )
        .await;
    assert_eq!(resp.status(), 403);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "scope restricted to agent 'other-agent'");

    let resp = server
        .post_bearer("/api/ontology/proposals", proposal_body, &other_agent_token)
        .await;
    assert_eq!(resp.status(), 201);
    let body = server.json(resp).await;
    let id = body["id"].as_str().unwrap().to_string();
    assert_eq!(body["agentId"], "other-agent");

    let resp = server
        .get_bearer(
            "/api/ontology/proposals?agentId=default",
            &other_agent_token,
        )
        .await;
    assert_eq!(resp.status(), 403);

    let resp = server
        .get_bearer("/api/ontology/proposals", &other_agent_token)
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["items"][0]["agentId"], "other-agent");

    let resp = server
        .post_bearer(
            &format!("/api/ontology/proposals/{id}/apply"),
            json!({"agentId": "default", "actor": "operator"}),
            &other_agent_token,
        )
        .await;
    assert_eq!(resp.status(), 403);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_proposals_require_modify_permission_for_mutations() {
    let server = TestServer::start_team_auth().await;
    let token = TestServer::scoped_token("default");
    let readonly_token = TestServer::scoped_role_token("default", "readonly");
    let proposal_body = json!({
        "operation": "create_entity",
        "payload": {"name": "Readonly Blocked Entity"}
    });

    let resp = server
        .get_bearer("/api/ontology/proposals", &readonly_token)
        .await;
    assert_eq!(resp.status(), 200);

    let resp = server
        .post_bearer(
            "/api/ontology/proposals",
            proposal_body.clone(),
            &readonly_token,
        )
        .await;
    assert_eq!(resp.status(), 403);

    let resp = server
        .post_bearer("/api/ontology/proposals", proposal_body, &token)
        .await;
    assert_eq!(resp.status(), 201);
    let body = server.json(resp).await;
    let id = body["id"].as_str().unwrap().to_string();

    for path in [
        "/api/ontology/proposals/batch",
        "/api/ontology/proposals/repair/duplicates",
        "/api/ontology/extract",
        "/api/ontology/consolidate",
    ] {
        let resp = server
            .post_bearer(
                path,
                json!({"proposals": [], "writeProposals": true}),
                &readonly_token,
            )
            .await;
        assert_eq!(resp.status(), 403, "{path}");
    }

    let resp = server
        .post_bearer(
            &format!("/api/ontology/proposals/{id}/apply"),
            json!({"actor": "readonly"}),
            &readonly_token,
        )
        .await;
    assert_eq!(resp.status(), 403);

    let resp = server
        .post_bearer(
            &format!("/api/ontology/proposals/{id}/reject"),
            json!({"actor": "readonly"}),
            &readonly_token,
        )
        .await;
    assert_eq!(resp.status(), 403);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_evidence_routes_resolve_seeded_claim_and_link_evidence() {
    let server = TestServer::start().await;
    server.seed_ontology_evidence_fixture();

    let resp = server.get("/api/ontology/claims/evidence").await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"error": "entity is required"}));

    let resp = server
        .get("/api/ontology/claims/evidence?entity=Signet%20Evidence&aspect=source%20truth&group=source%20truth&claim=evidence%20claim&kind=preference")
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"error": "kind is invalid"}));

    let resp = server
        .get("/api/ontology/claims/evidence?entity=Missing&aspect=source%20truth&group=source%20truth&claim=evidence%20claim")
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"error": "Claim path not found"}));

    let resp = server
        .get("/api/ontology/claims/evidence?entity=Signet%20Evidence&aspect=source%20truth&group=source%20truth&claim=evidence%20claim&status=all")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["entity"]["id"], "entity-ontology-signet");
    assert_eq!(body["aspect"]["id"], "aspect-ontology-evidence");
    assert_eq!(body["groupKey"], "source_truth");
    assert_eq!(body["claimKey"], "evidence_claim");
    assert_eq!(body["count"], 1);
    assert_eq!(
        body["items"][0]["attribute"]["id"],
        "attr-ontology-evidence"
    );
    assert!(body["items"][0]["evidenceCount"].as_u64().unwrap_or(0) >= 4);
    let evidence_kinds = body["items"][0]["evidence"]
        .as_array()
        .expect("claim evidence array")
        .iter()
        .map(|item| item["kind"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    assert!(evidence_kinds.contains(&"ontology_proposal"));
    assert!(evidence_kinds.contains(&"memory_artifact"));
    assert!(evidence_kinds.contains(&"memory"));
    assert!(evidence_kinds.contains(&"provided_quote"));

    let resp = server
        .get("/api/ontology/links/missing-link/evidence")
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"error": "Link not found"}));

    let resp = server
        .get("/api/ontology/links/dep-ontology-evidence/evidence")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dependency"]["id"], "dep-ontology-evidence");
    assert_eq!(body["dependency"]["dependencyType"], "supports_claim");
    assert!(body["count"].as_u64().unwrap_or(0) >= 3);
    let link_evidence_kinds = body["items"]
        .as_array()
        .expect("link evidence array")
        .iter()
        .map(|item| item["kind"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    assert!(link_evidence_kinds.contains(&"ontology_proposal"));
    assert!(link_evidence_kinds.contains(&"memory_artifact"));
    assert!(link_evidence_kinds.contains(&"provided_quote"));
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_consolidate_reports_source_counts_and_noop_mode() {
    let server = TestServer::start().await;
    server.seed_ontology_consolidation_fixture();

    let resp = server
        .post("/api/ontology/consolidate", json!({"status": "missing"}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"error": "status is invalid"}));

    let resp = server.post("/api/ontology/consolidate", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["sourceProposalCount"], 2);
    assert_eq!(body["count"], 0);
    assert_eq!(body["writtenCount"], 0);
    assert_eq!(body["dryRun"], true);
    assert_eq!(body["consolidationMode"], "noop");
    assert_eq!(body["providerName"], serde_json::Value::Null);
    assert_eq!(
        body["warnings"][0],
        "Consolidation is provider-backed; pass use_provider to run the configured inference workload."
    );

    let resp = server
        .post("/api/ontology/consolidate", json!({"status": "applied"}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["sourceProposalCount"], 1);

    let resp = server
        .post("/api/ontology/consolidate", json!({"use_provider": true}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["sourceProposalCount"], 2);
    assert_eq!(body["consolidationMode"], "noop");
    assert_eq!(
        body["warnings"][0],
        "Provider consolidation requested but no inference provider is configured."
    );

    let fixture = EmbeddingFixture::start();
    let provider_server = TestServer::start_with_agent_yaml(
        None,
        &format!(
            "agent:\n  name: test-agent\n  version: 1\nmemory:\n  pipelineV2:\n    extractionProvider: ollama\n    extractionModel: replay-llm\n    extractionEndpoint: {}\n    extraction:\n      provider: ollama\n      model: replay-llm\n      endpoint: {}\n      timeout: 5000\n",
            fixture.base, fixture.base
        ),
    )
    .await;
    provider_server.seed_ontology_consolidation_fixture();

    let resp = provider_server
        .post("/api/ontology/consolidate", json!({"use_provider": true}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = provider_server.json(resp).await;
    assert_eq!(body["sourceProposalCount"], 2);
    assert_eq!(body["consolidationMode"], "provider");
    assert_eq!(body["providerName"], "ollama");
    assert_eq!(
        body["summary"],
        "Merged duplicate Signet proposal candidates into one durable claim."
    );
    assert_eq!(body["count"], 1);
    assert_eq!(body["writtenCount"], 0);
    assert_eq!(body["dryRun"], true);
    assert_eq!(body["proposals"][0]["operation"], "add_claim_value");
    assert_eq!(body["proposals"][0]["payload"]["entity"], "Signet");
    assert_eq!(
        body["rejections"][0]["candidate_id"],
        "proposal-consolidate-pending-b"
    );
    assert_eq!(
        body["conflicts"][0]["claim_slot"],
        "architecture/proposal_loop"
    );
    assert_eq!(body["maintenance"][0]["operation"], "request_review");

    let resp = provider_server
        .post_with_actor(
            "/api/ontology/consolidate",
            json!({"use_provider": true, "write_proposals": true}),
            "consolidate-test",
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = provider_server.json(resp).await;
    assert_eq!(body["consolidationMode"], "provider");
    assert_eq!(body["count"], 1);
    assert_eq!(body["writtenCount"], 1);
    assert_eq!(body["dryRun"], false);
    assert_eq!(body["items"][0]["createdBy"], "consolidate-test");
    assert_eq!(body["items"][0]["sourceKind"], "ontology_consolidation");
    assert_eq!(body["items"][0]["sourceId"], "proposals:2");

    let conn = rusqlite::Connection::open(provider_server.db_path()).expect("open replay db");
    let original_pending_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ontology_proposals
             WHERE id IN ('proposal-consolidate-pending-a', 'proposal-consolidate-pending-b')
               AND status = 'pending'",
            [],
            |row| row.get(0),
        )
        .expect("count original consolidation proposals");
    assert_eq!(original_pending_count, 2);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_duplicate_repair_builds_and_writes_merge_candidates() {
    let server = TestServer::start().await;
    server.seed_ontology_duplicate_repair_fixture();

    let resp = server
        .post(
            "/api/ontology/proposals/repair/duplicates",
            json!({"limit": 10}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dryRun"], true);
    assert_eq!(body["writtenCount"], 0);
    assert_eq!(body["count"], 2);
    let items = body["items"].as_array().expect("repair items");
    let signet = items
        .iter()
        .find(|item| item["canonicalName"] == "signet")
        .expect("signet duplicate candidate");
    assert_eq!(signet["operation"], "merge_entities");
    assert_eq!(signet["target"]["name"], "Signet");
    assert_eq!(signet["sources"].as_array().unwrap().len(), 2);
    assert_eq!(signet["blocked"], false);
    assert_eq!(signet["payload"]["repair_kind"], "duplicate_entities");
    assert_eq!(
        signet["payload"]["source_entities"],
        json!(["SIGNET", "signet.ai"])
    );
    assert_eq!(signet["impact"]["aspects"], 1);
    assert_eq!(signet["impact"]["attributes"], 1);
    assert_eq!(signet["impact"]["memoryMentions"], 1);
    let mixed = items
        .iter()
        .find(|item| item["canonicalName"] == "mixed")
        .expect("mixed duplicate candidate");
    assert_eq!(mixed["blocked"], true);
    assert!(
        mixed["warnings"][0]
            .as_str()
            .unwrap_or_default()
            .contains("differs from target type")
    );

    let resp = server
        .post(
            "/api/ontology/proposals/repair/duplicates?agent_id=other-agent",
            json!({"limit": 10}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 0);

    let resp = server
        .post(
            "/api/ontology/proposals/repair/duplicates",
            json!({"limit": 10, "write_proposals": true, "created_by": "repair-test"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dryRun"], false);
    assert_eq!(body["writtenCount"], 1);
    assert_eq!(body["skippedCount"], 1);
    assert_eq!(body["proposals"][0]["operation"], "merge_entities");
    assert_eq!(body["proposals"][0]["createdBy"], "repair-test");
    assert_eq!(body["proposals"][0]["payload"]["canonical_name"], "signet");

    let resp = server
        .post(
            "/api/ontology/proposals/repair/duplicates",
            json!({"limit": 10, "write_proposals": true, "created_by": "repair-test"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["writtenCount"], 0);
    assert_eq!(body["skippedCount"], 1);
    assert_eq!(body["items"][0]["canonicalName"], "mixed");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_merge_plan_previews_writes_and_blocks_seeded_merges() {
    let server = TestServer::start().await;
    server.seed_ontology_duplicate_repair_fixture();

    let resp = server
        .post(
            "/api/ontology/proposals/repair/merge-plan",
            json!({
                "target_entity_id": "entity-dup-signet",
                "source_entity_ids": ["entity-dup-signet-upper"]
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dryRun"], true);
    assert_eq!(body["operation"], "merge_entities");
    assert_eq!(body["target"]["name"], "Signet");
    assert_eq!(body["sources"][0]["name"], "SIGNET");
    assert_eq!(body["payload"]["repair_kind"], "manual_entity_merge");
    assert_eq!(body["payload"]["target_entity_id"], "entity-dup-signet");
    assert_eq!(
        body["payload"]["source_entity_ids"],
        json!(["entity-dup-signet-upper"])
    );
    assert_eq!(body["impact"]["aspects"], 1);
    assert!(body.get("proposal").is_none());

    let resp = server
        .post(
            "/api/ontology/proposals/repair/merge-plan",
            json!({
                "target_entity_id": "entity-dup-signet",
                "source_entity_ids": ["entity-dup-signet-ai"],
                "write_proposal": true,
                "created_by": "merge-plan-test"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dryRun"], false);
    assert_eq!(body["proposal"]["operation"], "merge_entities");
    assert_eq!(body["proposal"]["createdBy"], "merge-plan-test");
    assert_eq!(
        body["proposal"]["payload"]["target_entity_id"],
        "entity-dup-signet"
    );
    assert_eq!(
        body["proposal"]["payload"]["source_entity_ids"],
        json!(["entity-dup-signet-ai"])
    );

    let resp = server
        .post(
            "/api/ontology/proposals/repair/merge-plan",
            json!({
                "target_entity_id": "entity-dup-mixed-project",
                "source_entity_ids": ["entity-dup-mixed-skill"],
                "write_proposal": true,
                "created_by": "merge-plan-test"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["blocked"], true);
    assert_eq!(body["dryRun"], true);
    assert!(body.get("proposal").is_none());
    assert!(
        body["warnings"][0]
            .as_str()
            .unwrap_or_default()
            .contains("differs from target type")
    );

    let resp = server
        .post(
            "/api/ontology/proposals/repair/merge-plan?agent_id=other-agent",
            json!({
                "target_entity_id": "entity-dup-signet",
                "source_entity_ids": ["entity-dup-signet-upper"]
            }),
        )
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"],
        "payload.target_entity_id was not found: entity-dup-signet"
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_proposal_conflicts_group_pending_claim_slot_values() {
    let server = TestServer::start().await;

    for payload in [
        json!({
            "entity": "Signet",
            "aspect": "architecture",
            "group_key": "ontology",
            "claim_key": "mutation_policy",
            "value": "Extraction writes directly into the graph."
        }),
        json!({
            "entity": "Signet",
            "aspect": "architecture",
            "group_key": "ontology",
            "claim_key": "mutation_policy",
            "value": "Extraction writes provenance-backed operations before graph mutation."
        }),
    ] {
        let resp = server
            .post(
                "/api/ontology/proposals",
                json!({
                    "operation": "add_claim_value",
                    "payload": payload,
                    "confidence": 0.8,
                    "rationale": "Seed conflict.",
                    "evidence": [{"quote": "seeded conflict"}]
                }),
            )
            .await;
        assert_eq!(resp.status(), 201);
    }
    let resp = server
        .post(
            "/api/ontology/proposals",
            json!({
                "agent_id": "other-agent",
                "operation": "add_claim_value",
                "payload": {
                    "entity": "Signet",
                    "aspect": "architecture",
                    "group_key": "ontology",
                    "claim_key": "mutation_policy",
                    "value": "Different agent scope should not join conflicts."
                },
                "confidence": 0.8
            }),
        )
        .await;
    assert_eq!(resp.status(), 201);

    let resp = server.get("/api/ontology/proposals/conflicts").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert!(body.get("conflicts").is_none());
    let item = &body["items"][0];
    assert_eq!(item["entity"], "Signet");
    assert_eq!(item["aspect"], "architecture");
    assert_eq!(item["groupKey"], "ontology");
    assert_eq!(item["claimKey"], "mutation_policy");
    assert_eq!(item["values"].as_array().unwrap().len(), 2);
    assert_eq!(item["proposalIds"].as_array().unwrap().len(), 2);
    assert_eq!(item["values"][0]["evidenceCount"], 1);

    let resp = server
        .get("/api/ontology/proposals/conflicts?agent_id=other-agent")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 0);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_extract_reads_sources_and_writes_candidates_transactionally() {
    let server = TestServer::start().await;
    {
        let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute_batch(
            r#"INSERT INTO entities
               (id, name, canonical_name, entity_type, agent_id, mentions, status,
                created_at, updated_at)
               VALUES
               ('entity-extract-signet', 'Signet', 'signet', 'project', 'default',
                1, 'active', '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z');"#,
        )
        .expect("seed extract entity");
        conn.execute(
            "INSERT INTO session_transcripts
             (session_key, content, harness, project, agent_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                "extract-json",
                json!({
                    "claim_values": [{
                        "entity": "Signet",
                        "aspect": "architecture",
                        "group_key": "ontology",
                        "claim_key": "proposal_loop",
                        "value": "Extraction emits pending proposals.",
                        "confidence": 0.91,
                        "evidence": [{"quote": "Extraction emits pending proposals."}]
                    }],
                    "links": [{
                        "source_entity": "Transcript artifact",
                        "link_type": "supports_claim",
                        "target_entity": "Signet",
                        "reason": "The transcript explicitly supports the claim."
                    }]
                })
                .to_string(),
                "codex",
                "/tmp/signet",
                "default",
                "2026-06-02T00:00:00.000Z",
                "2026-06-02T00:01:00.000Z",
            ],
        )
        .expect("seed explicit extraction transcript");
        conn.execute(
            "INSERT INTO session_transcripts
             (session_key, content, harness, project, agent_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                "assertion-extract",
                json!({
                    "assertions": [{
                        "entity": "Signet",
                        "predicate": "believes",
                        "content": "Signet models attributed beliefs over time.",
                        "speaker": "Nicholai",
                        "confidence": 0.91,
                        "evidence": [{"quote": "attributed beliefs"}]
                    }]
                })
                .to_string(),
                "codex",
                "/tmp/signet",
                "default",
                "2026-06-02T00:01:10.000Z",
                "2026-06-02T00:01:20.000Z",
            ],
        )
        .expect("seed assertion extraction transcript");
        conn.execute(
            "INSERT INTO session_transcripts
             (session_key, content, harness, project, agent_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                "plain-extract",
                "Signet should become an agent-first ontology. [[Hermes Agent]] is relevant. Hermes Agent supports Signet proposal loop.",
                "codex",
                "/tmp/signet",
                "default",
                "2026-06-02T00:02:00.000Z",
                "2026-06-02T00:03:00.000Z",
            ],
        )
        .expect("seed plain extraction transcript");
        conn.execute(
            "INSERT INTO session_transcripts
             (session_key, content, harness, project, agent_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                "invalid-extract",
                json!({
                    "proposals": [{
                        "operation": "create_entity",
                        "payload": {"name": "Rollback Candidate", "entity_type": "concept"}
                    }],
                    "assertions": [{
                        "entity": "Signet",
                        "predicate": "claims",
                        "content": "Signet keeps attributed assertions.",
                        "evidence": [{"quote": "attributed assertions"}]
                    }, {
                        "entity": "Signet",
                        "predicate": "maybe",
                        "content": "This invalid assertion should roll back the batch.",
                        "evidence": [{"quote": "invalid assertion"}]
                    }]
                })
                .to_string(),
                "codex",
                "/tmp/signet",
                "default",
                "2026-06-02T00:04:00.000Z",
                "2026-06-02T00:05:00.000Z",
            ],
        )
        .expect("seed invalid extraction transcript");
    }

    let resp = server.post("/api/ontology/extract", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "from is required");

    let resp = server
        .post(
            "/api/ontology/extract?agent_id=other-agent",
            json!({"from": "transcript:extract-json"}),
        )
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Extraction source not found");

    let resp = server
        .post(
            "/api/ontology/extract",
            json!({"from": "transcript:extract-json"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dryRun"], true);
    assert_eq!(body["source"]["sourceKind"], "transcript");
    assert_eq!(body["source"]["sourceId"], "extract-json");
    assert_eq!(body["count"], 2);
    assert_eq!(body["assertionCount"], 0);
    assert_eq!(body["writtenCount"], 0);
    assert_eq!(body["writtenAssertionCount"], 0);
    assert_eq!(body["proposals"][0]["operation"], json!("add_claim_value"));

    let resp = server
        .post(
            "/api/ontology/extract",
            json!({
                "from": "transcript:extract-json",
                "writeProposals": true,
                "writeAssertions": true,
                "createdBy": "extract-replay"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dryRun"], false);
    assert_eq!(body["writtenCount"], 2);
    assert_eq!(body["writtenAssertionCount"], 0);
    assert_eq!(body["items"][0]["createdBy"], "extract-replay");

    let resp = server
        .post(
            "/api/ontology/extract",
            json!({
                "from": "assertion-extract",
                "writeAssertions": true,
                "createdBy": "assertion-replay"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dryRun"], false);
    assert_eq!(body["writtenCount"], 0);
    assert_eq!(body["writtenAssertionCount"], 1);
    assert_eq!(body["assertionItems"][0]["createdBy"], "assertion-replay");
    assert_eq!(body["assertionItems"][0]["predicate"], "believes");

    let resp = server
        .post("/api/ontology/extract", json!({"from": "plain-extract"}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let operations = body["proposals"]
        .as_array()
        .expect("plain proposals")
        .iter()
        .filter_map(|item| item["operation"].as_str())
        .collect::<Vec<_>>();
    assert!(operations.contains(&"create_entity"));
    assert!(operations.contains(&"add_claim_value"));
    assert!(operations.contains(&"create_link"));
    assert!(
        body["proposals"]
            .as_array()
            .unwrap()
            .iter()
            .all(|proposal| !proposal["evidence"].as_array().unwrap().is_empty())
    );

    let resp = server
        .post(
            "/api/ontology/extract",
            json!({
                "from": "invalid-extract",
                "writeProposals": true,
                "writeAssertions": true
            }),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "predicate is invalid");

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    let rollback_candidate_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ontology_proposals
             WHERE payload LIKE '%Rollback Candidate%'",
            [],
            |row| row.get(0),
        )
        .expect("rollback proposal count");
    assert_eq!(rollback_candidate_count, 0);
    let assertion_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM epistemic_assertions WHERE agent_id = 'default'",
            [],
            |row| row.get(0),
        )
        .expect("assertion count");
    assert_eq!(assertion_count, 1);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn plugin_ontology_telemetry_compat_endpoints() {
    let server = TestServer::start().await;

    for path in [
        "/api/plugins",
        "/api/plugins/prompt-contributions",
        "/api/plugins/audit?pluginId=signet.secrets&limit=5",
        "/api/telemetry/memory-search",
        "/api/telemetry/memory-search/export?agent_id=test-agent",
        "/api/ontology/proposals",
        "/api/ontology/proposals/conflicts",
        "/api/marketplace/reviews?type=skill&id=skills.sh%2Ffoo",
        "/api/marketplace/reviews/config",
    ] {
        let resp = server.get(path).await;
        assert_eq!(resp.status(), 200, "GET {path}");
    }

    let resp = server.get("/api/ontology/claims/evidence").await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"error": "entity is required"}));

    let resp = server.get("/api/ontology/links/link-1/evidence").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"error": "Link not found"}));

    let resp = server.get("/api/ontology/proposals/test/evidence").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"error": "Proposal not found"}));

    for path in [
        "/api/ontology/consolidate",
        "/api/ontology/proposals/batch",
        "/api/ontology/proposals/repair/duplicates",
        "/api/git/sync",
        "/api/repair/requeue-dead",
        "/api/memory/modify",
    ] {
        let body = match path {
            "/api/memory/modify" => {
                json!({"patches": [{"id":"missing-memory","patch":{"content":"updated"}}]})
            }
            _ => json!({}),
        };
        let resp = server.post(path, body).await;
        assert_eq!(resp.status(), 200, "POST {path}");
    }

    let resp = server.post("/api/ontology/extract", json!({})).await;
    assert_eq!(resp.status(), 400, "POST /api/ontology/extract");
    let body = server.json(resp).await;
    assert_eq!(body["error"], "from is required");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn remaining_public_routes_have_contract_replay_coverage() {
    let catalog_fixture = MarketplaceCatalogFixture::start();
    let _catalog_env = MarketplaceCatalogEnvGuard::set(&catalog_fixture.base);
    let server = TestServer::start().await;
    let assert_status = |label: &str, resp: &reqwest::Response, expected: &[u16]| {
        let status = resp.status().as_u16();
        assert!(
            expected.contains(&status),
            "{label} returned {status}, expected one of {expected:?}"
        );
    };

    let resp = server.get("/api/agents").await;
    assert_status("GET /api/agents", &resp, &[200]);
    let resp = server.post("/api/agents", json!({})).await;
    assert_status("POST /api/agents", &resp, &[400]);
    let resp = server.get("/api/agents/missing-agent").await;
    assert_status("GET /api/agents/:name", &resp, &[404]);
    let resp = server.delete("/api/agents/missing-agent").await;
    assert_status("DELETE /api/agents/:name", &resp, &[404]);

    let resp = server
        .post(
            "/api/config",
            json!({"file": "AGENTS.md", "content": "# Replay\n"}),
        )
        .await;
    assert_status("POST /api/config", &resp, &[200]);
    let resp = server.get("/api/harnesses").await;
    assert_status("GET /api/harnesses", &resp, &[200]);

    let resp = server.post("/api/connectors", json!({})).await;
    assert_status("POST /api/connectors", &resp, &[400]);
    let resp = server.delete("/api/connectors/missing-connector").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Connector not found");

    let resp = server.post("/api/cross-agent/messages", json!({})).await;
    assert_status("POST /api/cross-agent/messages", &resp, &[400]);
    let resp = server.post("/api/cross-agent/presence", json!({})).await;
    assert_status("POST /api/cross-agent/presence", &resp, &[200]);
    let resp = server
        .delete("/api/cross-agent/presence/missing-session")
        .await;
    assert_status(
        "DELETE /api/cross-agent/presence/:sessionKey",
        &resp,
        &[200],
    );

    let resp = server.post("/api/documents", json!({})).await;
    assert_status("POST /api/documents", &resp, &[201]);
    let resp = server.get("/api/documents/missing-document").await;
    assert_status("GET /api/documents/:id", &resp, &[404]);
    let resp = server.get("/api/documents/missing-document/chunks").await;
    assert_status("GET /api/documents/:id/chunks", &resp, &[200]);
    let resp = server
        .delete("/api/documents/missing-document?reason=replay")
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Document not found");

    let resp = server.get("/api/git/config").await;
    assert_status("GET /api/git/config", &resp, &[200]);
    let resp = server
        .post(
            "/api/git/config",
            json!({"autoCommit": true, "autoSync": true, "syncInterval": 120, "remote": "upstream", "branch": "main"}),
        )
        .await;
    assert_status("POST /api/git/config", &resp, &[200]);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["config"]["autoCommit"], true);
    assert_eq!(body["config"]["autoSync"], true);
    assert_eq!(body["config"]["syncInterval"], 120);
    assert_eq!(body["config"]["remote"], "upstream");
    let resp = server.post("/api/git/pull", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "Not a git repository");
    let resp = server.post("/api/git/push", json!({})).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "Not a git repository");
    let resp = server.post("/api/git/sync", json!({})).await;
    assert_status("POST /api/git/sync", &resp, &[200]);

    let resp = server
        .post(
            "/api/hook/remember",
            json!({"harness": "contract-replay", "content": "remember replay"}),
        )
        .await;
    assert_status("POST /api/hook/remember", &resp, &[200]);
    let resp = server
        .post(
            "/api/hooks/remember",
            json!({"harness": "contract-replay", "content": "remember replay"}),
        )
        .await;
    assert_status("POST /api/hooks/remember", &resp, &[200]);
    let resp = server
        .post(
            "/api/hooks/compaction-complete",
            json!({
                "harness": "contract-replay",
                "sessionKey": "replay-session",
                "summary": "# Replay\n\nCompaction route replay."
            }),
        )
        .await;
    assert_status("POST /api/hooks/compaction-complete", &resp, &[200]);

    let resp = server.get("/api/knowledge/entities/missing-entity").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"error": "Entity not found"}));

    let resp = server
        .get("/api/knowledge/entities/missing-entity/aspects")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"items": []}));

    let resp = server
        .get("/api/knowledge/entities/missing-entity/aspects/missing-aspect/attributes")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"items": [], "limit": 50, "offset": 0}));

    let resp = server
        .get("/api/knowledge/entities/missing-entity/dependencies")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"items": []}));

    let resp = server.get("/api/knowledge/entities/pinned").await;
    assert_status("GET /api/knowledge/entities/pinned", &resp, &[200]);
    let resp = server
        .post("/api/knowledge/entities/missing-entity/pin", json!({}))
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"error": "Entity not found"}));

    let resp = server
        .delete("/api/knowledge/entities/missing-entity/pin")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"pinned": false}));

    let resp = server.get("/api/marketplace/mcp/browse").await;
    assert_status("GET /api/marketplace/mcp/browse", &resp, &[200]);
    let resp = server.get("/api/marketplace/mcp/detail").await;
    assert_status("GET /api/marketplace/mcp/detail", &resp, &[400]);
    let resp = server
        .patch("/api/marketplace/mcp/policy", json!({"mode": "compact"}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["policy"]["mode"], "compact");
    let resp = server.post("/api/marketplace/mcp/install", json!({})).await;
    assert_status("POST /api/marketplace/mcp/install", &resp, &[400]);
    let resp = server
        .post("/api/marketplace/mcp/register", json!({}))
        .await;
    assert_status("POST /api/marketplace/mcp/register", &resp, &[400]);
    let resp = server.post("/api/marketplace/mcp/test", json!({})).await;
    assert_status("POST /api/marketplace/mcp/test", &resp, &[400]);
    let resp = server
        .patch(
            "/api/marketplace/mcp/missing-server",
            json!({"enabled": false}),
        )
        .await;
    assert_status("PATCH /api/marketplace/mcp/:id", &resp, &[404]);
    let resp = server.delete("/api/marketplace/mcp/missing-server").await;
    assert_status("DELETE /api/marketplace/mcp/:id", &resp, &[404]);

    let resp = server
        .post("/api/memory/save", json!({"content": "save replay"}))
        .await;
    assert_status("POST /api/memory/save", &resp, &[200]);
    let resp = server
        .post(
            "/api/memory/modify",
            json!({"patches": [{"id": "missing-memory", "patch": {"content": "updated"}}]}),
        )
        .await;
    assert_status("POST /api/memory/modify", &resp, &[200]);
    let resp = server.get("/api/memory/missing-memory/history").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Not found");
    assert_eq!(body["memoryId"], "missing-memory");
    let resp = server
        .post("/api/memory/missing-memory/recover", json!({}))
        .await;
    assert_status("POST /api/memory/:id/recover", &resp, &[404]);
    let resp = server.delete("/api/memory/missing-memory").await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "reason is required");

    let resp = server.get("/api/ontology/claims/evidence").await;
    assert_status("GET /api/ontology/claims/evidence", &resp, &[400]);
    let resp = server
        .get("/api/ontology/links/missing-link/evidence")
        .await;
    assert_status("GET /api/ontology/links/:id/evidence", &resp, &[404]);
    let resp = server.get("/api/ontology/proposals/missing-proposal").await;
    assert_status("GET /api/ontology/proposals/:id", &resp, &[404]);
    let resp = server
        .get("/api/ontology/proposals/missing-proposal/evidence")
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"error": "Proposal not found"}));
    let resp = server.get("/api/ontology/proposals/conflicts").await;
    assert_status("GET /api/ontology/proposals/conflicts", &resp, &[200]);
    let resp = server.post("/api/ontology/extract", json!({})).await;
    assert_status("POST /api/ontology/extract", &resp, &[400]);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "from is required");
    let resp = server.post("/api/ontology/consolidate", json!({})).await;
    assert_status("POST /api/ontology/consolidate", &resp, &[200]);
    let resp = server
        .post("/api/ontology/proposals/missing-proposal/apply", json!({}))
        .await;
    assert_status("POST /api/ontology/proposals/:id/apply", &resp, &[404]);
    let resp = server
        .post("/api/ontology/proposals/missing-proposal/reject", json!({}))
        .await;
    assert_status("POST /api/ontology/proposals/:id/reject", &resp, &[404]);
    let resp = server
        .post("/api/ontology/proposals/repair/duplicates", json!({}))
        .await;
    assert_status(
        "POST /api/ontology/proposals/repair/duplicates",
        &resp,
        &[200],
    );

    let resp = server.get("/api/pipeline/models").await;
    assert_status("GET /api/pipeline/models", &resp, &[200]);
    let resp = server.get("/api/pipeline/models/by-provider").await;
    assert_status("GET /api/pipeline/models/by-provider", &resp, &[200]);
    let resp = server.post("/api/pipeline/models/refresh", json!({})).await;
    assert_status("POST /api/pipeline/models/refresh", &resp, &[200]);

    let resp = server.post("/api/repair/backfill-skipped", json!({})).await;
    assert_status("POST /api/repair/backfill-skipped", &resp, &[200]);
    let resp = server.post("/api/repair/check-fts", json!({})).await;
    assert_status("POST /api/repair/check-fts", &resp, &[200]);
    let resp = server.post("/api/repair/clean-orphans", json!({})).await;
    assert_status("POST /api/repair/clean-orphans", &resp, &[200]);
    server.seed_deduplicate_fixture();
    let resp = server
        .post("/api/repair/deduplicate", json!({"dryRun": true}))
        .await;
    assert_status("POST /api/repair/deduplicate dry-run", &resp, &[200]);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["affected"], 0);
    assert_eq!(body["clusters"], 1);

    let resp = server.post("/api/repair/deduplicate", json!({})).await;
    assert_status("POST /api/repair/deduplicate", &resp, &[200]);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["affected"], 1);
    assert_eq!(body["clusters"], 1);

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    let keeper: (i64, String) = conn
        .query_row(
            "SELECT is_deleted, tags FROM memories WHERE id = 'mem-dedup-keeper'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("keeper row");
    assert_eq!(keeper.0, 0);
    assert!(keeper.1.split(',').any(|tag| tag == "alpha"));
    assert!(keeper.1.split(',').any(|tag| tag == "beta"));
    let loser_deleted: i64 = conn
        .query_row(
            "SELECT is_deleted FROM memories WHERE id = 'mem-dedup-loser'",
            [],
            |row| row.get(0),
        )
        .expect("loser row");
    assert_eq!(loser_deleted, 1);
    let other_agent_deleted: i64 = conn
        .query_row(
            "SELECT is_deleted FROM memories WHERE id = 'mem-dedup-other-agent'",
            [],
            |row| row.get(0),
        )
        .expect("other agent row");
    assert_eq!(other_agent_deleted, 0);
    let history: (i64, i64) = conn
        .query_row(
            "SELECT
               SUM(CASE WHEN memory_id = 'mem-dedup-keeper' AND event = 'merged' THEN 1 ELSE 0 END),
               SUM(CASE WHEN memory_id = 'mem-dedup-loser' AND event = 'deleted' THEN 1 ELSE 0 END)
             FROM memory_history
             WHERE memory_id IN ('mem-dedup-keeper', 'mem-dedup-loser')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("dedupe history rows");
    assert_eq!(history, (1, 1));
    let resp = server
        .post("/api/repair/prune-chunk-groups", json!({}))
        .await;
    assert_status("POST /api/repair/prune-chunk-groups", &resp, &[200]);
    let resp = server
        .post("/api/repair/prune-singleton-entities", json!({}))
        .await;
    assert_status("POST /api/repair/prune-singleton-entities", &resp, &[200]);
    let resp = server.post("/api/repair/re-embed", json!({})).await;
    assert_status("POST /api/repair/re-embed", &resp, &[200]);
    let resp = server
        .post("/api/repair/reclassify-entities", json!({}))
        .await;
    assert_status("POST /api/repair/reclassify-entities", &resp, &[200]);
    let resp = server.post("/api/repair/release-leases", json!({})).await;
    assert_status("POST /api/repair/release-leases", &resp, &[200]);
    let resp = server.post("/api/repair/requeue-dead", json!({})).await;
    assert_status("POST /api/repair/requeue-dead", &resp, &[200]);
    let resp = server.post("/api/repair/resync-vec", json!({})).await;
    assert_status("POST /api/repair/resync-vec", &resp, &[200]);
    let resp = server.post("/api/repair/retention-sweep", json!({})).await;
    assert_status("POST /api/repair/retention-sweep", &resp, &[200]);
    let resp = server
        .post("/api/repair/structural-backfill", json!({}))
        .await;
    assert_status("POST /api/repair/structural-backfill", &resp, &[200]);

    let resp = server.post("/api/secrets/REPLAY_SECRET", json!({})).await;
    assert_status("POST /api/secrets/:name", &resp, &[400]);
    let resp = server.delete("/api/secrets/REPLAY_SECRET").await;
    assert_status("DELETE /api/secrets/:name", &resp, &[200]);
    let resp = server.post("/api/secrets/exec", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "command is required");

    let resp = server
        .post(
            "/api/sessions/replay-session/bypass",
            json!({"enabled": true}),
        )
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Session not found");
    let resp = server.get("/api/skills/analytics").await;
    assert_status("GET /api/skills/analytics", &resp, &[200]);

    let resp = server.post("/api/tasks", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"],
        "name, prompt, cronExpression, and harness are required"
    );
    let resp = server.get("/api/tasks/missing-task").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Task not found");
    let resp = server.patch("/api/tasks/missing-task", json!({})).await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Task not found");
    let resp = server.post("/api/tasks/missing-task/run", json!({})).await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Task not found");
    let resp = server.get("/api/tasks/missing-task/runs").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["runs"], json!([]));
    assert_eq!(body["total"], 0);
    assert_eq!(body["hasMore"], false);
    let resp = server.delete("/api/tasks/missing-task").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);

    let resp = server.post("/v1/chat/completions", json!({})).await;
    assert_eq!(resp.status(), 503);
    let body = server.json(resp).await;
    assert_eq!(body["error"]["message"], "inference router not initialized");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_assertions_aliases_operations_replay_missing_cluster() {
    let server = TestServer::start().await;

    let resp = server.get("/api/ontology/assertions").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["items"], json!([]));
    assert_eq!(body["count"], 0);

    let resp = server.get("/api/ontology/assertions?status=bad").await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "status is invalid");

    let resp = server.post("/api/ontology/assertions", json!({})).await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "predicate is invalid");

    let resp = server.get("/api/ontology/assertions/missing").await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Assertion not found");

    let resp = server
        .post("/api/ontology/assertions/missing/link-claim", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "attribute_id is required");

    let resp = server
        .post("/api/ontology/assertions/missing/archive", json!({}))
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "assertion was not found");

    let resp = server
        .post("/api/ontology/assertions/missing/supersede", json!({}))
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "assertion was not found");

    let resp = server.get("/api/ontology/claims/versions").await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "entity is required");

    let resp = server
        .get("/api/ontology/claims/versions?entity=A&aspect=B&group=C&claim=D")
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Entity not found: A");

    let resp = server
        .get("/api/ontology/claims/version?entity=A&aspect=B&group=C&claim=D")
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "version is required");

    let resp = server.get("/api/ontology/entities/missing/aliases").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["items"], json!([]));

    let resp = server
        .post("/api/ontology/entities/missing/aliases", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "alias is required");

    let resp = server
        .delete("/api/ontology/entities/missing/aliases/missing-alias")
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Alias not found");

    let resp = server
        .post("/api/ontology/operations/apply", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "operation is required");

    let resp = server
        .post("/api/ontology/operations/batch", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "operations are required");

    let resp = server
        .post("/api/ontology/proposals/repair/merge-plan", json!({}))
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "payload.target_entity is required");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_operation_endpoints_apply_dry_run_and_batch_errors() {
    let server = TestServer::start().await;

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "create_entity",
                "payload": {"name": "Dry Run Entity", "entity_type": "project"},
                "dry_run": true,
                "reason": "replay dry run"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dryRun"], true);
    assert_eq!(body["proposed"], false);
    assert_eq!(body["proposal"]["status"], "applied");
    assert_eq!(body["proposal"]["operation"], "create_entity");
    assert_eq!(body["result"]["entity"], "Dry Run Entity");
    assert_eq!(body["result"]["applied"], true);

    {
        let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entities WHERE name = 'Dry Run Entity'",
                [],
                |row| row.get(0),
            )
            .expect("dry run entity count");
        assert_eq!(count, 0);
    }

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "create_entity",
                "payload": {"name": "Applied Entity", "entity_type": "project"},
                "actor": "operation-replay"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dryRun"], false);
    assert_eq!(body["proposal"]["status"], "applied");
    assert_eq!(body["proposal"]["appliedBy"], "operation-replay");
    assert_eq!(body["result"]["entity"], "Applied Entity");
    let applied_entity_id = body["result"]["entityId"]
        .as_str()
        .expect("applied entity id")
        .to_string();

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "create_entity",
                "payload": {"name": "Proposed Entity", "entity_type": "project"},
                "propose": true
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dryRun"], false);
    assert_eq!(body["proposed"], true);
    assert_eq!(body["result"], serde_json::Value::Null);
    assert_eq!(body["proposal"]["status"], "pending");

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "rename_entity",
                "payload": {
                    "selector": "Applied Entity",
                    "new_name": "Applied Entity Renamed"
                },
                "actor": "operation-replay"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["result"]["entityId"], applied_entity_id);
    assert_eq!(body["result"]["oldName"], "Applied Entity");
    assert_eq!(body["result"]["newName"], "Applied Entity Renamed");

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "create_aspect",
                "payload": {
                    "entity": "Applied Entity Renamed",
                    "name": "Profile"
                }
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let aspect_id = body["result"]["aspectId"]
        .as_str()
        .expect("created aspect id")
        .to_string();

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "rename_aspect",
                "payload": {
                    "entity": "Applied Entity Renamed",
                    "selector": "Profile",
                    "new_name": "Details"
                }
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["result"]["aspectId"], aspect_id);
    assert_eq!(body["result"]["oldName"], "Profile");
    assert_eq!(body["result"]["newName"], "Details");

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "set_claim_value",
                "payload": {
                    "entity": "Applied Entity Renamed",
                    "aspect": "Details",
                    "group_key": "state",
                    "claim_key": "status",
                    "value": "first"
                }
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let first_attribute_id = body["result"]["attributeId"]
        .as_str()
        .expect("first claim id")
        .to_string();
    assert_eq!(body["result"]["version"], 1);

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "set_claim_value",
                "payload": {
                    "entity": "Applied Entity Renamed",
                    "aspect": "Details",
                    "group_key": "state",
                    "claim_key": "status",
                    "value": "second"
                }
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let second_attribute_id = body["result"]["attributeId"]
        .as_str()
        .expect("second claim id")
        .to_string();
    assert_eq!(body["result"]["version"], 2);
    assert_eq!(body["result"]["previousAttributeId"], first_attribute_id);

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "supersede_claim_value",
                "payload": {
                    "entity": "Applied Entity Renamed",
                    "aspect": "Details",
                    "group_key": "state",
                    "claim_key": "status",
                    "old_value": "second",
                    "new_value": "third"
                }
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let third_attribute_id = body["result"]["replacementAttributeId"]
        .as_str()
        .expect("replacement claim id")
        .to_string();
    assert_eq!(
        body["result"]["supersededAttributeIds"][0],
        second_attribute_id
    );

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "archive_claim_value",
                "payload": {
                    "attribute_id": third_attribute_id,
                    "reason": "replay archive"
                },
                "actor": "operation-replay"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["result"]["archived"], true);

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "restore_claim_version",
                "payload": {"attribute_id": first_attribute_id}
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["result"]["restored"], true);

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "create_link",
                "payload": {
                    "source_entity": "Applied Entity Renamed",
                    "target_entity": "Linked Target",
                    "link_type": "references",
                    "strength": 0.4,
                    "reason": "initial link"
                }
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let dependency_id = body["result"]["dependencyId"]
        .as_str()
        .expect("dependency id")
        .to_string();

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "update_link",
                "payload": {
                    "dependency_id": dependency_id,
                    "link_type": "supports",
                    "strength": 0.9,
                    "confidence": 0.8,
                    "reason": "updated link"
                }
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["result"]["updated"], true);

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "archive_link",
                "payload": {
                    "dependency_id": dependency_id,
                    "reason": "retired"
                },
                "actor": "operation-replay"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["result"]["archived"], true);

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "archive_aspect",
                "payload": {
                    "entity": "Applied Entity Renamed",
                    "selector": "Details",
                    "reason": "retired"
                },
                "actor": "operation-replay"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["result"]["archived"], true);

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "archive_entity",
                "payload": {
                    "selector": "Applied Entity Renamed",
                    "reason": "retired"
                },
                "actor": "operation-replay"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["result"]["archived"], true);

    let resp = server
        .post(
            "/api/ontology/operations/batch",
            json!({
                "dry_run": true,
                "operations": [
                    {
                        "operation": "create_entity",
                        "payload": {"name": "Batch Preview", "entity_type": "project"}
                    },
                    {
                        "operation": "rename_entity",
                        "payload": {"selector": "Missing", "new_name": "Nope"}
                    }
                ]
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["dryRun"], true);
    assert_eq!(body["proposed"], false);
    assert_eq!(body["count"], 1);
    assert_eq!(body["items"][0]["proposal"]["status"], "applied");
    assert_eq!(body["items"][0]["result"]["entity"], "Batch Preview");
    assert_eq!(body["errors"][0]["index"], 1);
    assert_eq!(body["errors"][0]["line"], 2);
    assert_eq!(body["errors"][0]["operation"], "rename_entity");
    assert_eq!(body["errors"][0]["status"], 404);
    assert!(
        body["errors"][0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("Entity not found")
    );

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    let counts: (i64, i64, i64, i64, i64) = conn
        .query_row(
            "SELECT
               SUM(CASE WHEN name = 'Applied Entity' THEN 1 ELSE 0 END),
               SUM(CASE WHEN name = 'Proposed Entity' THEN 1 ELSE 0 END),
               SUM(CASE WHEN name = 'Batch Preview' THEN 1 ELSE 0 END),
               SUM(CASE WHEN name = 'Applied Entity Renamed' AND status = 'archived' THEN 1 ELSE 0 END),
               SUM(CASE WHEN name = 'Linked Target' THEN 1 ELSE 0 END)
             FROM entities",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .expect("operation entity counts");
    assert_eq!(counts, (0, 0, 0, 1, 1));
    let statuses: (String, String, String, String) = conn
        .query_row(
            "SELECT
               (SELECT status FROM entity_aspects WHERE id = ?1),
               (SELECT status FROM entity_attributes WHERE id = ?2),
               (SELECT status FROM entity_attributes WHERE id = ?3),
               (SELECT status FROM entity_dependencies WHERE id = ?4)",
            rusqlite::params![
                aspect_id,
                first_attribute_id,
                second_attribute_id,
                dependency_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("operation row statuses");
    assert_eq!(
        statuses,
        (
            "archived".to_string(),
            "deleted".to_string(),
            "superseded".to_string(),
            "archived".to_string(),
        )
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_operation_merge_entities_rewires_graph_rows() {
    let server = TestServer::start().await;
    {
        let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute_batch(
            r#"INSERT INTO memories
               (id, type, content, confidence, importance, tags, who, project,
                created_at, updated_at, updated_by)
               VALUES
               ('mem-merge-source', 'fact', 'Merge source memory.', 1.0, 0.8,
                'merge', 'test', 'signet', '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z', 'contract-replay');

               INSERT INTO entities
               (id, name, canonical_name, entity_type, agent_id, mentions, status,
                created_at, updated_at)
               VALUES
               ('entity-merge-target', 'Merge Target', 'merge target',
                'project', 'default', 3, 'active',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z'),
               ('entity-merge-source', 'Merge Source', 'merge source',
                'project', 'default', 2, 'active',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z'),
               ('entity-merge-other', 'Merge Other', 'merge other',
                'project', 'default', 1, 'active',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z');

               INSERT INTO entity_aspects
               (id, entity_id, agent_id, name, canonical_name, weight, status,
                created_at, updated_at)
               VALUES
               ('aspect-merge-target-shared', 'entity-merge-target', 'default',
                'Shared', 'shared', 0.7, 'active',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z'),
               ('aspect-merge-source-shared', 'entity-merge-source', 'default',
                'Shared', 'shared', 0.7, 'active',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z'),
               ('aspect-merge-source-unique', 'entity-merge-source', 'default',
                'Source Only', 'source only', 0.7, 'active',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z');

               INSERT INTO entity_attributes
               (id, aspect_id, agent_id, kind, content, normalized_content,
                confidence, importance, status, group_key, claim_key,
                created_at, updated_at)
               VALUES
               ('attr-merge-shared', 'aspect-merge-source-shared', 'default',
                'attribute', 'Shared source claim.', 'shared source claim',
                0.9, 0.8, 'active', 'merge', 'shared',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z'),
               ('attr-merge-unique', 'aspect-merge-source-unique', 'default',
                'attribute', 'Unique source claim.', 'unique source claim',
                0.9, 0.8, 'active', 'merge', 'unique',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z');

               INSERT INTO entity_dependencies
               (id, source_entity_id, target_entity_id, agent_id,
                dependency_type, strength, confidence, reason, status,
                created_at, updated_at)
               VALUES
               ('dep-merge-out', 'entity-merge-source', 'entity-merge-other',
                'default', 'supports', 0.6, 0.7, 'outgoing', 'active',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z'),
               ('dep-merge-in', 'entity-merge-other', 'entity-merge-source',
                'default', 'supports', 0.6, 0.7, 'incoming', 'active',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z'),
               ('dep-merge-self', 'entity-merge-source', 'entity-merge-target',
                'default', 'supports', 0.6, 0.7, 'self after merge', 'active',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z');

               INSERT INTO relations
               (id, source_entity_id, target_entity_id, relation_type, strength,
                metadata, created_at)
               VALUES
               ('rel-merge-out', 'entity-merge-source', 'entity-merge-other',
                'related_to', 0.5, '{}', '2026-06-02T00:00:00.000Z'),
               ('rel-merge-in', 'entity-merge-other', 'entity-merge-source',
                'related_to', 0.5, '{}', '2026-06-02T00:00:00.000Z'),
               ('rel-merge-self', 'entity-merge-source', 'entity-merge-target',
                'related_to', 0.5, '{}', '2026-06-02T00:00:00.000Z');

               INSERT INTO memory_entity_mentions (memory_id, entity_id)
               VALUES ('mem-merge-source', 'entity-merge-source');"#,
        )
        .expect("seed merge fixture");
    }

    let resp = server
        .post(
            "/api/ontology/operations/apply",
            json!({
                "operation": "merge_entities",
                "payload": {
                    "target_entity_id": "entity-merge-target",
                    "source_entity_ids": ["entity-merge-source"]
                },
                "actor": "operation-replay"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["result"]["targetEntityId"], "entity-merge-target");
    assert_eq!(
        body["result"]["mergedEntities"][0]["entityId"],
        "entity-merge-source"
    );
    assert_eq!(body["result"]["mergedEntities"][0]["movedAspects"], 2);

    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    let counts: (i64, i64, i64, i64, i64) = conn
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM entities WHERE id = 'entity-merge-source'),
               (SELECT mentions FROM entities WHERE id = 'entity-merge-target'),
               (SELECT COUNT(*) FROM entity_aspects
                WHERE id = 'aspect-merge-source-shared'),
               (SELECT COUNT(*) FROM entity_dependencies
                WHERE source_entity_id = target_entity_id),
               (SELECT COUNT(*) FROM relations
                WHERE source_entity_id = target_entity_id)",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("merge counts");
    assert_eq!(counts, (0, 5, 0, 0, 0));

    let moved: (String, String, String, String, i64, i64) = conn
        .query_row(
            "SELECT
               (SELECT aspect_id FROM entity_attributes WHERE id = 'attr-merge-shared'),
               (SELECT entity_id FROM entity_aspects WHERE id = 'aspect-merge-source-unique'),
               (SELECT source_entity_id FROM entity_dependencies WHERE id = 'dep-merge-out'),
               (SELECT target_entity_id FROM entity_dependencies WHERE id = 'dep-merge-in'),
               (SELECT COUNT(*) FROM memory_entity_mentions
                WHERE memory_id = 'mem-merge-source'
                  AND entity_id = 'entity-merge-target'),
               (SELECT COUNT(*) FROM memory_entity_mentions
                WHERE memory_id = 'mem-merge-source'
                  AND entity_id = 'entity-merge-source')",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .expect("merge moved rows");
    assert_eq!(
        moved,
        (
            "aspect-merge-target-shared".to_string(),
            "entity-merge-target".to_string(),
            "entity-merge-target".to_string(),
            "entity-merge-target".to_string(),
            1,
            0,
        )
    );
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_assertion_routes_create_link_supersede_and_archive() {
    let server = TestServer::start().await;
    {
        let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute_batch(
            r#"INSERT INTO entities
               (id, name, canonical_name, entity_type, agent_id, mentions, status,
                created_at, updated_at)
               VALUES
               ('entity-assert-signet', 'Signet', 'signet', 'project', 'default',
                1, 'active', '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z'),
               ('entity-assert-rival', 'Rival', 'rival', 'project', 'default',
                1, 'active', '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z');

               INSERT INTO entity_aspects
               (id, entity_id, agent_id, name, canonical_name, weight, status,
                created_at, updated_at)
               VALUES
               ('aspect-assert-signet', 'entity-assert-signet', 'default',
                'architecture', 'architecture', 0.7, 'active',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z');

               INSERT INTO entity_attributes
               (id, aspect_id, agent_id, kind, content, normalized_content,
                confidence, importance, status, group_key, claim_key,
                created_at, updated_at)
               VALUES
               ('attr-assert-signet', 'aspect-assert-signet', 'default',
                'attribute', 'Signet has epistemic assertions.',
                'signet has epistemic assertions.', 0.9, 0.8, 'active',
                'ontology', 'epistemic_assertions',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z');"#,
        )
        .expect("seed assertion lifecycle fixture");
    }

    let resp = server
        .post(
            "/api/ontology/assertions",
            json!({
                "entity": "Signet",
                "predicate": "maybe",
                "content": "Invalid predicate.",
                "evidence": [{"quote": "invalid"}]
            }),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "predicate is invalid");

    let resp = server
        .post(
            "/api/ontology/assertions",
            json!({
                "entity": "Signet",
                "predicate": "claims",
                "content": "No provenance."
            }),
        )
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "evidence or source provenance is required");

    let resp = server
        .post_with_actor(
            "/api/ontology/assertions",
            json!({
                "entity": "Signet",
                "predicate": "believes",
                "content": "Signet should model who believes what over time.",
                "speaker": "Nicholai",
                "asserted_at": "2026-06-02T01:00:00.000Z",
                "confidence": 0.91,
                "evidence": [{"quote": "who believes what"}],
                "source_kind": "transcript",
                "source_id": "assertion-session"
            }),
            "assertion-test",
        )
        .await;
    assert_eq!(resp.status(), 201);
    let created = server.json(resp).await;
    let assertion_id = created["id"]
        .as_str()
        .expect("created assertion id")
        .to_string();
    assert_eq!(created["subjectEntityName"], "Signet");
    assert_eq!(created["predicate"], "believes");
    assert_eq!(created["createdBy"], "assertion-test");

    let resp = server
        .get("/api/ontology/assertions?speaker=Nicholai&predicate=believes")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["items"][0]["id"], assertion_id);

    let resp = server
        .get(&format!("/api/ontology/assertions/{assertion_id}"))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(
        body["content"],
        "Signet should model who believes what over time."
    );

    let resp = server
        .post(
            &format!("/api/ontology/assertions/{assertion_id}/link-claim"),
            json!({"attribute_id": "attr-assert-signet"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let linked = server.json(resp).await;
    assert_eq!(linked["claimAttributeId"], "attr-assert-signet");

    let resp = server
        .post(
            &format!("/api/ontology/assertions/{assertion_id}/supersede"),
            json!({
                "content": "Signet keeps attributed assertions alongside similarity.",
                "evidence": [{"quote": "attributed assertions"}]
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let superseding = server.json(resp).await;
    let superseding_id = superseding["id"]
        .as_str()
        .expect("superseding assertion id")
        .to_string();
    assert_eq!(superseding["predicate"], "believes");
    assert_eq!(superseding["supersedesAssertionId"], assertion_id);

    let resp = server
        .post(
            &format!("/api/ontology/assertions/{superseding_id}/supersede"),
            json!({
                "entity_id": "entity-assert-rival",
                "content": "Rival should not enter Signet assertion history.",
                "evidence": [{"quote": "different entity"}]
            }),
        )
        .await;
    assert_eq!(resp.status(), 409);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"],
        "supersede cannot change assertion subject entity"
    );

    let resp = server
        .post(
            &format!("/api/ontology/assertions/{superseding_id}/archive"),
            json!({"actor": "assertion-test", "reason": "replaced by claim"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let archived = server.json(resp).await;
    assert_eq!(archived["status"], "archived");
    assert_eq!(archived["archiveReason"], "replaced by claim");

    let resp = server
        .get("/api/ontology/assertions?status=all&query=signet")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 2);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn ontology_claim_version_routes_list_and_get_persisted_versions() {
    let server = TestServer::start().await;
    {
        let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute_batch(
            r#"INSERT INTO entities
               (id, name, canonical_name, entity_type, agent_id, mentions, status,
                created_at, updated_at)
               VALUES
               ('entity-claim-signet', 'Signet', 'signet', 'project', 'default',
                1, 'active', '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z');

               INSERT INTO entity_aspects
               (id, entity_id, agent_id, name, canonical_name, weight, status,
                created_at, updated_at)
               VALUES
               ('aspect-claim-pricing', 'entity-claim-signet', 'default',
                'Pricing', 'pricing', 0.7, 'active',
                '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z');

               INSERT INTO entity_attributes
               (id, aspect_id, agent_id, kind, content, normalized_content,
                confidence, importance, status, group_key, claim_key,
                source_kind, source_id, proposal_id, version, version_root_id,
                previous_attribute_id, created_at, updated_at)
               VALUES
               ('attr-claim-v1', 'aspect-claim-pricing', 'default',
                'attribute', '$8/mo', '$8/mo', 0.7, 0.5, 'superseded',
                'plans', 'monthly_cost', 'manual', 'seed', 'proposal-v1',
                1, 'attr-claim-v1', NULL, '2026-06-02T00:00:00.000Z',
                '2026-06-02T00:00:00.000Z'),
               ('attr-claim-v2', 'aspect-claim-pricing', 'default',
                'attribute', '$10/mo', '$10/mo', 0.8, 0.6, 'superseded',
                'plans', 'monthly_cost', 'manual', 'seed', 'proposal-v2',
                2, 'attr-claim-v1', 'attr-claim-v1',
                '2026-06-02T00:01:00.000Z',
                '2026-06-02T00:01:00.000Z'),
               ('attr-claim-v3', 'aspect-claim-pricing', 'default',
                'attribute', '$12/mo', '$12/mo', 0.9, 0.7, 'active',
                'plans', 'monthly_cost', 'manual', 'seed', 'proposal-v3',
                3, 'attr-claim-v1', 'attr-claim-v2',
                '2026-06-02T00:02:00.000Z',
                '2026-06-02T00:02:00.000Z'),
               ('attr-claim-constraint', 'aspect-claim-pricing', 'default',
                'constraint', 'must stay under $20/mo',
                'must stay under $20/mo', 0.9, 0.7, 'active',
                'plans', 'monthly_cost', 'manual', 'seed', 'proposal-c1',
                1, 'attr-claim-constraint', NULL,
                '2026-06-02T00:03:00.000Z',
                '2026-06-02T00:03:00.000Z');"#,
        )
        .expect("seed claim version fixture");
    }

    let resp = server
        .get("/api/ontology/claims/versions?entity=Signet&aspect=pricing&group=plans&claim=monthly%20cost")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 3);
    assert_eq!(body["items"][0]["id"], "attr-claim-v3");
    assert_eq!(body["items"][0]["version"], 3);
    assert_eq!(body["items"][0]["versionRootId"], "attr-claim-v1");
    assert_eq!(body["items"][0]["previousAttributeId"], "attr-claim-v2");
    assert_eq!(body["items"][0]["sourceKind"], "manual");
    assert_eq!(body["items"][1]["version"], 2);
    assert_eq!(body["items"][2]["version"], 1);

    let resp = server
        .get("/api/ontology/claims/version?entity=entity-claim-signet&aspect=aspect-claim-pricing&group=plans&claim=monthly_cost&version=2")
        .await;
    assert_eq!(resp.status(), 200);
    let version = server.json(resp).await;
    assert_eq!(version["id"], "attr-claim-v2");
    assert_eq!(version["content"], "$10/mo");
    assert_eq!(version["proposalId"], "proposal-v2");

    let resp = server
        .get("/api/ontology/claims/versions?entity=Signet&aspect=pricing&group=plans&claim=monthly_cost&kind=constraint")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["items"][0]["id"], "attr-claim-constraint");

    let resp = server
        .get("/api/ontology/claims/versions?entity=Signet&aspect=pricing&group=plans&claim=monthly_cost&kind=fact")
        .await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "kind is invalid");

    let resp = server
        .get("/api/ontology/claims/version?entity=Signet&aspect=pricing&group=plans&claim=monthly_cost&version=99")
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Claim version not found");

    let resp = server
        .get("/api/ontology/claims/versions?entity=Missing&aspect=pricing&group=plans&claim=monthly_cost")
        .await;
    assert_eq!(resp.status(), 404);
    let body = server.json(resp).await;
    assert_eq!(body["error"], "Entity not found: Missing");

    {
        let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute(
            "INSERT INTO entities
             (id, name, canonical_name, entity_type, agent_id, mentions, status,
              created_at, updated_at)
             VALUES
             ('entity-claim-signet-duplicate', 'Signet Duplicate', 'signet', 'project',
              'default', 1, 'active', '2026-06-02T00:04:00.000Z',
              '2026-06-02T00:04:00.000Z')",
            [],
        )
        .expect("seed ambiguous entity");
    }

    let resp = server
        .get("/api/ontology/claims/versions?entity=Signet&aspect=pricing&group=plans&claim=monthly_cost")
        .await;
    assert_eq!(resp.status(), 409);
    let body = server.json(resp).await;
    assert_eq!(
        body["error"],
        "Entity selector is ambiguous: Signet. Use an id."
    );
}
