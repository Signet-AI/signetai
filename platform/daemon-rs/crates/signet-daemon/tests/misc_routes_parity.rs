//! Misc route + auth/secrets parity tests ported from the TypeScript daemon.
//!
//! The assertions cite the TS test file:line they replay and exercise the real
//! Rust daemon binary over HTTP so regressions fail through the production
//! route stack rather than duplicated helper logic.

use std::net::TcpListener;
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;
const AUTH_SECRET: &[u8] = b"misc-routes-parity-auth-secret-32b";
static TEST_SERVER_START_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

struct TestServer {
    base: String,
    client: reqwest::Client,
    pid: u32,
    tmpdir: tempfile::TempDir,
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
    async fn start() -> Self {
        Self::start_with_agent_yaml(
            r#"agent:
  name: test-agent
  version: 1
memory:
  pipelineV2:
    extraction:
      provider: none
"#,
            false,
        )
        .await
    }

    async fn start_team_auth() -> Self {
        Self::start_with_agent_yaml(
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
"#,
            true,
        )
        .await
    }

    async fn start_team_auth_with_yaml(yaml: &str) -> Self {
        Self::start_with_agent_yaml(yaml, true).await
    }

    async fn start_with_agent_yaml(yaml: &str, auth_secret: bool) -> Self {
        let _guard = test_server_start_lock().lock().await;
        let tmpdir = tempfile::tempdir().expect("create test workspace");
        std::fs::create_dir_all(tmpdir.path().join("memory")).expect("create memory dir");
        std::fs::create_dir_all(tmpdir.path().join(".daemon/logs")).expect("create logs dir");
        std::fs::write(tmpdir.path().join("agent.yaml"), yaml).expect("write agent.yaml");
        if auth_secret {
            std::fs::write(tmpdir.path().join(".daemon/auth-secret"), AUTH_SECRET)
                .expect("write auth secret");
        }
        let (fake_bw, fake_op, fake_bin_dir) = write_fake_provider_bins(tmpdir.path());
        let path_with_fakes = match std::env::var_os("PATH") {
            Some(path) => {
                let mut paths = vec![fake_bin_dir];
                paths.extend(std::env::split_paths(&path));
                std::env::join_paths(paths).expect("join fake PATH")
            }
            None => fake_bin_dir.into_os_string(),
        };

        let port = ephemeral_port();
        let base = format!("http://127.0.0.1:{port}");
        let signet_path = tmpdir.path().to_string_lossy().to_string();
        let mut command = tokio::process::Command::new(daemon_binary());
        command
            .env("SIGNET_PATH", &signet_path)
            .env("SIGNET_PORT", port.to_string())
            .env("SIGNET_HOST", "127.0.0.1")
            .env("SIGNET_BIND", "127.0.0.1")
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
            .stderr(std::process::Stdio::null());
        let child = command.spawn().expect("spawn daemon");
        let pid = child.id().unwrap_or(0);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .expect("http client");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if tokio::time::Instant::now() > deadline {
                panic!("daemon did not start");
            }
            if let Ok(resp) = client.get(format!("{base}/health")).send().await {
                if resp.status().is_success() {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        Self {
            base,
            client,
            pid,
            tmpdir,
        }
    }

    fn db_path(&self) -> std::path::PathBuf {
        self.tmpdir.path().join("memory/memories.db")
    }

    async fn get(&self, path: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .expect("GET request")
    }

    async fn get_bearer(&self, path: &str, token: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .expect("GET bearer request")
    }

    async fn post(&self, path: &str, body: serde_json::Value) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.base))
            .json(&body)
            .send()
            .await
            .expect("POST request")
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
            .expect("POST bearer request")
    }

    async fn delete_bearer(&self, path: &str, token: &str) -> reqwest::Response {
        self.client
            .delete(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .expect("DELETE bearer request")
    }

    async fn json(&self, resp: reqwest::Response) -> serde_json::Value {
        resp.json().await.expect("parse JSON")
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
}

#[tokio::test]
async fn diagnostics_version_update_repair_and_troubleshoot_routes_replay_misc_contracts() {
    let server = TestServer::start().await;
    seed_repair_fixture(&server);
    seed_embedding_gap_fixture(&server);

    // TS parity: platform/daemon/src/version.test.ts:5-24 and
    // platform/daemon/src/update-route.test.ts cover version/status/update body
    // handling. Route assertions ensure Rust reports semver update state and
    // rejects malformed target versions rather than silently downgrading.
    let resp = server.get("/api/version").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(body["runtime"], "rust");

    let resp = server.get("/api/update/check").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["currentVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(body["updateAvailable"], false);
    assert_eq!(body["restartRequired"], false);

    let resp = server
        .post("/api/update/run", json!({"targetVersion": "not semver"}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "Invalid targetVersion 'not semver'");

    // TS parity: platform/daemon/src/diagnostics.test.ts:211-229 and
    // platform/daemon/src/embedding-health.test.ts:6-72 degrade index health
    // for missing embeddings while preserving structured domain details.
    let resp = server.get("/api/diagnostics").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body["score"].as_f64().unwrap_or(1.0) < 1.0);
    assert_eq!(body["domains"]["index"]["coverage"], 0.0);
    assert_eq!(body["domains"]["index"]["embeddings"], 0);

    let resp = server.get("/api/diagnostics/index").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["embeddings"], 0);
    assert_eq!(body["score"], 1.0);

    // TS parity: platform/daemon/src/repair-actions.test.ts:307-346,
    // 415-432, 979-1032 cover generic pruning, dead memory selection, and
    // scoped repair. The route must not touch another agent's dead memory.
    let resp = server
        .post(
            "/api/repair/prune-generic-entities",
            json!({"dryRun": true}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["action"], "pruneGenericEntities");
    assert!(body["affected"].as_i64().unwrap_or_default() >= 1);

    let resp = server
        .get("/api/repair/dead-memories?maxConfidence=2")
        .await;
    assert_eq!(resp.status(), 400);
    assert_eq!(
        server.json(resp).await["error"],
        "maxConfidence must be 0–1, maxAccessDays and limit must be non-negative"
    );

    let resp = server.get("/api/repair/dead-memories").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body["count"].as_i64().unwrap_or_default() >= 1);
    assert!(
        body["memories"]
            .as_array()
            .expect("dead memories")
            .iter()
            .any(|memory| memory["id"] == "mem-repair-dead")
    );

    let resp = server
        .post(
            "/api/repair/dead-memories/forget",
            json!({"ids": ["mem-repair-dead", "mem-repair-other-agent-dead"]}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(server.json(resp).await["forgotten"], 1);

    // TS parity: platform/daemon/src/repair-actions.test.ts:556-577 and
    // platform/daemon/src/which.test.ts:9-46 exercise command-backed repair
    // tooling without leaking arbitrary executable lookup behavior.
    let resp = server.get("/api/troubleshoot/commands").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let commands = body["commands"].as_array().expect("commands array");
    assert!(commands.iter().any(|command| command["key"] == "status"));

    let resp = server.post("/api/troubleshoot/exec", json!({})).await;
    assert_eq!(resp.status(), 400);
    assert_eq!(server.json(resp).await["error"], "Unknown command: ");
}

#[tokio::test]
async fn analytics_routes_record_counts_latency_errors_and_log_filters() {
    let server = TestServer::start().await;

    // TS parity: platform/daemon/src/analytics.test.ts:25-93 tracks endpoint
    // counts/latency/errors, and lines 111-149 filter by stage/since.
    let resp = server.get("/api/status").await;
    assert_eq!(resp.status(), 200);
    let resp = server
        .post(
            "/api/memory/remember",
            json!({"content": "Analytics parity memory", "type": "fact"}),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let resp = server
        .post(
            "/api/memory/recall",
            json!({"query": "Analytics parity memory", "limit": 1}),
        )
        .await;
    assert_eq!(resp.status(), 200);

    let resp = server.get("/api/analytics/usage").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["endpoints"]["GET /api/status"]["count"], 1);
    assert_eq!(body["endpoints"]["POST /api/memory/remember"]["count"], 1);
    assert_eq!(body["endpoints"]["POST /api/memory/recall"]["count"], 1);
    assert!(body["endpoints"]["GET /api/status"]["totalLatencyMs"].is_number());

    let resp = server.get("/api/analytics/latency").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["remember"]["count"], 1);
    assert_eq!(body["recall"]["count"], 1);
    assert_eq!(body["predictor_train"]["p95"], 0);

    let log_path = server.tmpdir.path().join(".daemon/logs/misc-parity.jsonl");
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
}

#[tokio::test]
async fn auth_api_keys_secrets_and_provider_routes_replay_auth_secrets_contracts() {
    let server = TestServer::start_team_auth().await;
    let admin_token = TestServer::scoped_role_token("default", "admin");

    // TS parity: platform/daemon/src/auth/api-keys.test.ts:60-80 and 97-106
    // create metadata-only connector keys, verify permission limits, and reject
    // revoked raw keys.
    let resp = server
        .post_bearer(
            "/api/auth/api-keys",
            json!({
                "name": "limited recall key",
                "role": "admin",
                "permissions": ["recall"],
                "scope": {"agent": "agent-api-key"}
            }),
            &admin_token,
        )
        .await;
    assert_eq!(resp.status(), 201);
    let body = server.json(resp).await;
    let created = &body["apiKey"];
    let id = created["id"].as_str().expect("api key id").to_string();
    let raw_key = created["key"].as_str().expect("raw api key").to_string();
    assert!(raw_key.starts_with("sig_sk_"));
    assert!(created.get("key_hash").is_none());

    let stored_hash: String = rusqlite::Connection::open(server.db_path())
        .expect("open db")
        .query_row(
            "SELECT key_hash FROM api_keys WHERE id = ?1",
            rusqlite::params![id.as_str()],
            |row| row.get(0),
        )
        .expect("stored key hash");
    assert!(stored_hash.starts_with("scrypt:"));
    assert!(!stored_hash.contains(&raw_key));

    let resp = server.get_bearer("/api/auth/whoami", &raw_key).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["claims"]["role"], "admin");
    assert_eq!(body["claims"]["scope"]["agent"], "agent-api-key");
    assert_eq!(body["claims"]["permissions"], json!(["recall"]));

    let resp = server.get_bearer("/api/auth/api-keys", &raw_key).await;
    assert_eq!(resp.status(), 403);
    assert_eq!(
        server.json(resp).await["error"],
        "credential lacks 'admin' permission"
    );

    let resp = server
        .delete_bearer(&format!("/api/auth/api-keys/{id}"), &admin_token)
        .await;
    assert_eq!(resp.status(), 200);
    let resp = server.get_bearer("/api/auth/whoami", &raw_key).await;
    assert_eq!(resp.status(), 401);
    assert_eq!(server.json(resp).await["error"], "api key revoked");

    // TS parity: platform/daemon/src/routes/secrets-routes.test.ts:52-98 and
    // platform/daemon/src/secrets.test.ts:55-96 and 98-148 stores
    // local secrets without exposing values and redacts exec output.
    let resp = server
        .post_bearer(
            "/api/secrets/REPLAY_SECRET",
            json!({"value": "replay-value"}),
            &admin_token,
        )
        .await;
    assert_eq!(resp.status(), 200);
    let resp = server.get_bearer("/api/secrets", &admin_token).await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["secrets"], json!(["REPLAY_SECRET"]));
    assert!(!body.to_string().contains("replay-value"));

    let resp = server
        .post_bearer(
            "/api/secrets/exec",
            json!({"command": "printf %s \"$REPLAY_SECRET\"", "secrets": {"REPLAY_SECRET": "REPLAY_SECRET"}}),
            &admin_token,
        )
        .await;
    assert_eq!(resp.status(), 202);
    let body = server.json(resp).await;
    let job_id = body["id"].as_str().expect("job id").to_string();
    let mut completed = serde_json::Value::Null;
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(30)).await;
        let resp = server
            .get_bearer(&format!("/api/secrets/exec/{job_id}"), &admin_token)
            .await;
        assert_eq!(resp.status(), 200);
        completed = server.json(resp).await;
        if completed["status"] == "completed" {
            break;
        }
    }
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["result"]["stdout"], "[REDACTED]");
    assert!(!completed.to_string().contains("replay-value"));

    // TS parity: platform/daemon/src/bitwarden.test.ts:61-80,
    // platform/daemon/src/routes/secrets-routes.test.ts:175-293, and
    // platform/daemon/src/onepassword.test.ts:11-49 cover provider status,
    // connect, folder/vault listing, migration/import naming, and disconnect.
    let resp = server
        .get_bearer("/api/secrets/1password/status", &admin_token)
        .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(server.json(resp).await["configured"], false);

    let resp = server
        .post_bearer(
            "/api/secrets/bitwarden/connect",
            json!({"session": "fake-bw-session", "activate": true, "folderId": "folder-1"}),
            &admin_token,
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["connected"], true);
    assert_eq!(body["activeProvider"], true);
    assert_eq!(body["userEmail"], "replay@example.com");

    let resp = server
        .post_bearer(
            "/api/secrets/bitwarden/provider",
            json!({"provider": "bad"}),
            &admin_token,
        )
        .await;
    assert_eq!(resp.status(), 400);
    assert_eq!(
        server.json(resp).await["error"],
        "provider must be local or bitwarden"
    );

    let resp = server
        .get_bearer("/api/secrets/bitwarden/folders", &admin_token)
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["folders"][0]["name"], "Replay Folder");

    let resp = server
        .post_bearer(
            "/api/secrets/bitwarden/migrate",
            json!({"dryRun": true, "folderId": "folder-1"}),
            &admin_token,
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["dryRun"], true);

    let resp = server
        .delete_bearer("/api/secrets/bitwarden/connect", &admin_token)
        .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(server.json(resp).await["disconnected"], true);

    let resp = server
        .post_bearer(
            "/api/secrets/1password/connect",
            json!({"token": "fake-op-token"}),
            &admin_token,
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["vaultCount"], 1);

    let resp = server
        .post_bearer(
            "/api/secrets/1password/import",
            json!({"vaults": ["vault-1"], "prefix": "OP", "overwrite": true}),
            &admin_token,
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["importedCount"], 1);
    assert_eq!(
        body["imported"][0]["secretName"],
        "OP_REPLAY_VAULT_DATABASE_PASSWORD"
    );
}

#[tokio::test]
async fn inference_routes_enforce_scope_admin_and_gateway_validation_contracts() {
    let server = TestServer::start_team_auth_with_yaml(INFERENCE_REPLAY_YAML).await;
    let admin = TestServer::scoped_role_token("default", "admin");
    let operator = TestServer::scoped_role_token("default", "operator");
    let rose = TestServer::scoped_role_token("rose", "agent");

    // TS parity: platform/daemon/src/inference-api.test.ts:614-682 exposes
    // diagnostics-readable status and rejects mismatched scoped agent ids.
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

    let resp = server
        .post_bearer(
            "/api/inference/explain",
            json!({"agentId": "miles", "operation": "interactive"}),
            &rose,
        )
        .await;
    assert_eq!(resp.status(), 403);
    assert!(
        server.json(resp).await["error"]
            .as_str()
            .unwrap_or_default()
            .contains("scope restricted to agent 'rose'")
    );

    // TS parity: platform/daemon/src/inference-api.test.ts:707-735 and 915-941
    // reject explicit target overrides, non-admin execution, oversized prompts,
    // and malformed gateway headers before provider execution.
    let resp = server
        .post_bearer(
            "/api/inference/explain",
            json!({"operation": "interactive", "explicitTargets": ["remote/sonnet"]}),
            &rose,
        )
        .await;
    assert_eq!(resp.status(), 400);
    assert!(
        server.json(resp).await["error"]
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
        .expect("gateway request");
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("x-signet-agent-id contains unsupported characters")
    );
}

fn seed_embedding_gap_fixture(server: &TestServer) {
    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    for (id, content) in [
        ("mem-diag-1", "Diagnostics missing embedding one."),
        ("mem-diag-2", "Diagnostics missing embedding two."),
        ("mem-diag-3", "Diagnostics missing embedding three."),
        ("mem-diag-4", "Diagnostics missing embedding four."),
    ] {
        conn.execute(
            "INSERT INTO memories
             (id, type, content, content_hash, confidence, importance, tags, who,
              project, created_at, updated_at, updated_by, is_deleted, version, agent_id)
             VALUES (?1, 'fact', ?2, ?3, 1.0, 0.8, 'diagnostics', 'parity',
              'signet', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
              'parity', 0, 1, 'default')",
            rusqlite::params![id, content, format!("hash-{id}")],
        )
        .expect("seed diagnostic memory");
    }
}

fn seed_repair_fixture(server: &TestServer) {
    let conn = rusqlite::Connection::open(server.db_path()).expect("open replay db");
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    conn.execute_batch(
        r#"INSERT INTO entities
           (id, name, canonical_name, entity_type, agent_id, mentions, pinned,
            created_at, updated_at)
           VALUES
           ('entity-repair-alpha', 'Signet Alpha', 'signet alpha', 'project', 'default', 4, 0,
            '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
           ('entity-repair-generic', 'The Repair Heading', 'the repair heading', 'concept', 'default', 1, 0,
            '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

           INSERT INTO memories
           (id, type, content, confidence, importance, tags, who, project,
            created_at, updated_at, updated_by, is_deleted, pinned, version,
            agent_id, visibility, scope)
           VALUES
           ('mem-repair-dead', 'fact', 'Low confidence stale repair memory.',
            0.01, 0.2, 'repair', 'contract-replay', 'signet',
            '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'contract-replay',
            0, 0, 1, 'default', 'global', NULL),
           ('mem-repair-other-agent-dead', 'fact', 'Other agent dead memory must not be repaired by default.',
            0.01, 0.2, 'repair', 'contract-replay', 'signet',
            '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'contract-replay',
            0, 0, 1, 'other-agent', 'global', NULL);"#,
    )
    .expect("seed repair fixture");
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
    std::env::var("CARGO_MANIFEST_DIR")
        .map(|dir| {
            std::path::PathBuf::from(dir)
                .join("../../target/debug/signet-daemon")
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_else(|_| "signet-daemon".to_string())
}

fn write_fake_provider_bins(
    root: &std::path::Path,
) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let bin_dir = root.join("fake-bin");
    std::fs::create_dir_all(&bin_dir).expect("create fake provider bin dir");
    let bw = bin_dir.join("bw");
    let op = bin_dir.join("op");
    let signet = bin_dir.join("signet");
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
  "embed audit ")
    echo "fake embed audit"
    ;;
  "embed backfill ")
    echo "fake embed backfill"
    ;;
  *)
    echo "unsupported signet command: $*" >&2
    exit 2
    ;;
esac
"#,
    )
    .expect("write fake signet");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [&bw, &op, &signet] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod fake bin");
        }
    }
    (bw, op, bin_dir)
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
