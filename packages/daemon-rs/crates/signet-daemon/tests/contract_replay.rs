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

use serde_json::json;

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
        let tmpdir = tempfile::tempdir().expect("failed to create tmpdir");
        let port = ephemeral_port();
        let base = format!("http://127.0.0.1:{port}");

        // Set env for the daemon
        let signet_path = tmpdir.path().to_str().unwrap().to_string();
        let memory_dir = tmpdir.path().join("memory");
        std::fs::create_dir_all(&memory_dir).unwrap();
        let daemon_dir = tmpdir.path().join(".daemon/logs");
        std::fs::create_dir_all(&daemon_dir).unwrap();

        // Write a minimal agent.yaml
        let yaml = format!(
            "agent:\n  name: test-agent\n  version: 1\nhome: {}\n",
            tmpdir.path().display()
        );
        std::fs::write(tmpdir.path().join("agent.yaml"), &yaml).unwrap();

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

    #[allow(dead_code)]
    async fn delete(&self, path: &str) -> reqwest::Response {
        self.client
            .delete(format!("{}{path}", self.base))
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
async fn predictor_endpoints() {
    let server = TestServer::start().await;

    let resp = server.get("/api/predictor/status").await;
    assert_eq!(resp.status(), 200);
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
}

#[tokio::test]
#[ignore = "requires built daemon binary"]
async fn secrets_list() {
    let server = TestServer::start().await;
    let resp = server.get("/api/secrets").await;
    assert_eq!(resp.status(), 200);
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
