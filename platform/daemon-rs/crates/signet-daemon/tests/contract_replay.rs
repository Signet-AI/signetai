//! Contract replay integration tests.
//!
//! Starts a real daemon on an ephemeral port, sends requests matching the
//! contract fixtures, and validates responses against parity rules.
//!
//! These tests require a built daemon binary, so they are ignored by default.
//! To run:
//!   cargo build -p signet-daemon
//!   cargo test -p signet-daemon --test contract_replay -- --ignored

use std::net::TcpListener;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;
const AUTH_SECRET: &[u8] = b"contract-replay-auth-secret-32bytes";

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

        std::fs::write(tmpdir.path().join("agent.yaml"), yaml).unwrap();

        // Spawn daemon in background
        let port_str = port.to_string();
        let child = tokio::process::Command::new(daemon_binary())
            .env("SIGNET_PATH", &signet_path)
            .env("SIGNET_PORT", &port_str)
            .env("SIGNET_HOST", "127.0.0.1")
            .env("SIGNET_BIND", "127.0.0.1")
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

    async fn get(&self, path: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{path}", self.base))
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

fn ephemeral_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn daemon_binary() -> String {
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
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn status_returns_db_info() {
    let server = TestServer::start().await;
    let resp = server.get("/api/status").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["status"], "ok");
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

    let resp = server
        .post("/api/memory/recall", json!({"query": "test memory"}))
        .await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn feedback_endpoint() {
    let server = TestServer::start().await;

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
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn session_endpoints() {
    let server = TestServer::start().await;

    let resp = server.get("/api/sessions").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/sessions/summaries").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/sessions/checkpoints").await;
    assert_eq!(resp.status(), 200);
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
async fn marketplace_endpoints() {
    let server = TestServer::start().await;

    let resp = server.get("/api/marketplace/mcp").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/marketplace/mcp/policy").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/marketplace/mcp/tools").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/marketplace/mcp/search").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/marketplace/mcp/search?q=time").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/marketplace/mcp/dogfood-everything").await;
    assert_eq!(resp.status(), 404);

    let resp = server
        .post(
            "/api/marketplace/mcp/call",
            json!({"serverId": "missing", "toolName": "missing", "args": {}}),
        )
        .await;
    assert_ne!(resp.status(), 404);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn secrets_list() {
    let server = TestServer::start().await;
    let resp = server.get("/api/secrets").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/secrets/1password/status").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["configured"], false);
    assert_eq!(body["connected"], false);
    assert_eq!(body["vaults"], json!([]));
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn tasks_crud() {
    let server = TestServer::start().await;

    let resp = server.get("/api/tasks").await;
    assert_eq!(resp.status(), 200);
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
async fn update_status() {
    let server = TestServer::start().await;
    let resp = server.get("/api/update").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["available"], false);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn logs_endpoint() {
    let server = TestServer::start().await;
    let resp = server.get("/api/logs").await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn mcp_endpoint() {
    let server = TestServer::start().await;
    let resp = server
        .post(
            "/mcp",
            json!({
                "jsonrpc": "2.0",
                "method": "initialize",
                "id": 1,
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "0.1.0"}
                }
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body["result"]["serverInfo"]["name"].is_string());
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn hook_session_lifecycle() {
    let server = TestServer::start().await;

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

    // prompt-submit
    let resp = server
        .post(
            "/api/hooks/user-prompt-submit",
            json!({
                "sessionKey": "test-session-001",
                "harness": "claude-code",
                "userMessage": "test prompt"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);

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
async fn repair_endpoints() {
    let server = TestServer::start().await;

    let resp = server.get("/api/repair/embedding-gaps").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/repair/dedup-stats").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/repair/cold-stats").await;
    assert_eq!(resp.status(), 200);
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

    let resp = server.get("/api/cross-agent/presence").await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/cross-agent/messages").await;
    assert_eq!(resp.status(), 200);
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

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn skills_endpoints() {
    let server = TestServer::start().await;
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
    assert_ne!(resp.status(), 400);

    let resp = server.delete("/api/skills/test-skill").await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn sources_endpoints() {
    let server = TestServer::start().await;

    let resp = server.get("/api/sources").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body, json!({"version": 1, "sources": []}));

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
    let id = body["source"]["id"].as_str().unwrap().to_string();

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

    let marketplace_dir = server._tmpdir.path().join("marketplace");
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

    let resp = server.post("/api/memory/forget", json!({})).await;
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn telemetry_memory_search_native_list_and_export() {
    let server = TestServer::start().await;
    server.seed_memory_search_telemetry_fixture();

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
        "/api/ontology/proposals/test/evidence",
        "/api/ontology/claims/evidence",
        "/api/ontology/links/link-1/evidence",
        "/api/marketplace/reviews?type=skill&id=skills.sh%2Ffoo",
        "/api/marketplace/reviews/config",
    ] {
        let resp = server.get(path).await;
        assert_eq!(resp.status(), 200, "GET {path}");
    }

    for path in [
        "/api/ontology/extract",
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
}
