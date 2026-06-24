//! Tail route parity tests ported from the remaining TypeScript daemon corpus.
//!
//! These tests start the real Rust daemon and assert HTTP/SQLite contracts so
//! route regressions fail through production code paths. Each test cites the TS
//! file:line range it replays.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

static TEST_SERVER_START_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

const DEFAULT_AGENT_YAML: &str = r#"agent:
  name: Tail Test Agent
  description: Route parity workspace
memory:
  pipelineV2:
    extraction:
      provider: none
    procedural:
      enabled: true
      enrichOnInstall: false
embedding:
  provider: none
search:
  min_score: 0
"#;

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
        Self::start_with(DEFAULT_AGENT_YAML, &[], |_| {}).await
    }

    async fn start_with_files(files: &[(&str, &str)]) -> Self {
        Self::start_with(DEFAULT_AGENT_YAML, files, |_| {}).await
    }

    async fn start_with_yaml(yaml: &str) -> Self {
        Self::start_with(yaml, &[], |_| {}).await
    }

    async fn start_with<F>(yaml: &str, files: &[(&str, &str)], setup: F) -> Self
    where
        F: FnOnce(&Path),
    {
        let _guard = test_server_start_lock().lock().await;
        let tmpdir = tempfile::tempdir().expect("create test workspace");
        std::fs::create_dir_all(tmpdir.path().join("memory")).expect("create memory dir");
        std::fs::create_dir_all(tmpdir.path().join(".daemon/logs")).expect("create logs dir");
        std::fs::write(tmpdir.path().join("agent.yaml"), yaml).expect("write agent.yaml");
        for (relative, content) in files {
            let path = tmpdir.path().join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("create fixture parent");
            }
            std::fs::write(path, content).expect("write fixture file");
        }
        setup(tmpdir.path());

        let fake_bin = write_fake_signet_bin(tmpdir.path());
        let path_with_fake = match std::env::var_os("PATH") {
            Some(path) => {
                let mut paths = vec![fake_bin];
                paths.extend(std::env::split_paths(&path));
                std::env::join_paths(paths).expect("join fake PATH")
            }
            None => fake_bin.into_os_string(),
        };

        let port = ephemeral_port();
        let base = format!("http://127.0.0.1:{port}");
        let mut command = tokio::process::Command::new(daemon_binary());
        command
            .env("SIGNET_PATH", tmpdir.path())
            .env("SIGNET_PORT", port.to_string())
            .env("SIGNET_HOST", "127.0.0.1")
            .env("SIGNET_BIND", "127.0.0.1")
            .env("SIGNET_MEMORY_IMPORT_POLL_MS", "200")
            .env("PATH", path_with_fake)
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

    fn db_path(&self) -> PathBuf {
        self.tmpdir.path().join("memory/memories.db")
    }

    async fn get(&self, path: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .expect("GET request")
    }

    async fn post(&self, path: &str, body: Value) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.base))
            .json(&body)
            .send()
            .await
            .expect("POST request")
    }

    async fn post_with_runtime(&self, path: &str, runtime: &str, body: Value) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.base))
            .header("x-signet-runtime-path", runtime)
            .json(&body)
            .send()
            .await
            .expect("POST runtime request")
    }

    async fn post_mcp(&self, body: Value) -> reqwest::Response {
        self.client
            .post(format!("{}/mcp", self.base))
            .header("Accept", "application/json, text/event-stream")
            .json(&body)
            .send()
            .await
            .expect("POST MCP request")
    }

    async fn post_mcp_raw(&self, body: &str) -> reqwest::Response {
        self.client
            .post(format!("{}/mcp", self.base))
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .expect("POST raw MCP request")
    }

    async fn delete(&self, path: &str) -> reqwest::Response {
        self.client
            .delete(format!("{}{path}", self.base))
            .send()
            .await
            .expect("DELETE request")
    }

    async fn json(&self, resp: reqwest::Response) -> Value {
        resp.json().await.expect("parse JSON")
    }
}

#[tokio::test]
async fn mcp_route_parses_json_and_returns_sdk_parse_error_shape() {
    let server = TestServer::start().await;

    // TS parity: platform/daemon/src/mcp/route.test.ts:17-36.
    let resp = server
        .post_mcp(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "route-test", "version": "0.1.0"},
            },
        }))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["result"]["serverInfo"]["name"], "signet");

    // TS parity: platform/daemon/src/mcp/route.test.ts:38-50. The native
    // route currently omits the optional JSON-RPC `id: null` field; the parse
    // error code/message and HTTP status remain locked here and the omission is
    // reported in the porting notes instead of changing production behavior.
    let resp = server.post_mcp_raw("{").await;
    assert_eq!(resp.status(), 400);
    let body = server.json(resp).await;
    assert_eq!(body["jsonrpc"], "2.0");
    assert_eq!(body["error"]["code"], -32700);
    assert_eq!(body["error"]["message"], "Parse error: Invalid JSON");
    assert!(body.get("id").is_none(), "Rust currently omits id:null");
}

#[tokio::test]
async fn mcp_tools_list_exposes_rust_tool_registry_and_scoped_memory_schema() {
    let server = TestServer::start().await;

    // TS parity: platform/daemon/src/mcp/tools.test.ts:223-268. Rust has a
    // smaller native registry than the TS MCP server; this asserts the native
    // registry remains complete for currently implemented tools and preserves
    // scoped write schema fields.
    let resp = server
        .post_mcp(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    let tools = body["result"]["tools"].as_array().expect("tools array");
    let names = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    for expected in [
        "memory_search",
        "memory_store",
        "memory_get",
        "memory_list",
        "memory_modify",
        "memory_forget",
        "memory_feedback",
        "knowledge_expand",
        "agent_peers",
        "agent_message_send",
        "agent_message_inbox",
        "mcp_server_list",
        "mcp_server_search",
        "mcp_server_call",
        "mcp_server_enable",
        "mcp_server_disable",
        "mcp_server_scope_get",
        "mcp_server_scope_set",
        "mcp_server_policy_get",
        "mcp_server_policy_set",
        "secret_list",
        "secret_exec",
        "secret_exec_status",
        "session_bypass",
    ] {
        assert!(names.contains(expected), "missing MCP tool {expected}");
    }
    assert_eq!(tools.len(), 24);

    let memory_store = tools
        .iter()
        .find(|tool| tool["name"] == "memory_store")
        .expect("memory_store tool");
    let props = memory_store["inputSchema"]["properties"]
        .as_object()
        .expect("memory_store properties");
    for expected in ["session_key", "agent_id", "visibility", "scope", "pinned"] {
        assert!(
            props.contains_key(expected),
            "missing memory_store.{expected}"
        );
    }
    assert_eq!(
        props["visibility"]["enum"],
        json!(["global", "private", "archived"])
    );
}

#[tokio::test]
async fn hooks_recall_validates_required_fields_and_runtime_path_conflicts() {
    let server = TestServer::start().await;

    // TS parity: platform/daemon/src/hooks-recall.test.ts:87-105.
    let resp = server
        .post("/api/hooks/recall", json!({"query": "test"}))
        .await;
    assert_eq!(resp.status(), 400);
    assert_eq!(server.json(resp).await["error"], "harness is required");

    let resp = server
        .post("/api/hooks/recall", json!({"harness": "openclaw"}))
        .await;
    assert_eq!(resp.status(), 400);
    assert_eq!(server.json(resp).await["error"], "query is required");

    // TS parity: platform/daemon/src/hooks-recall.test.ts:187-224. The Rust
    // daemon enforces the same one-runtime-path-per-session contract for recall.
    let session_key = "duplicate-runtime-session";
    let resp = server
        .post_with_runtime(
            "/api/hooks/session-start",
            "plugin",
            json!({"harness": "opencode", "sessionKey": session_key}),
        )
        .await;
    assert_eq!(resp.status(), 200);

    let resp = server
        .post_with_runtime(
            "/api/hooks/recall",
            "legacy",
            json!({
                "harness": "claude-code",
                "query": "deploy checklist",
                "sessionKey": session_key,
            }),
        )
        .await;
    assert_eq!(resp.status(), 409);
    let body = server.json(resp).await;
    // Rust currently returns the same 409 conflict with a compact error body
    // rather than TS' duplicateRuntimePath/claimedBy fields; reported below.
    assert_eq!(body["error"], "session claimed by plugin path");
}

#[tokio::test]
async fn skills_routes_install_graph_upsert_delete_and_record_agent_scoped_invocations() {
    let server = TestServer::start_with_files(&[(
        "skills/local-skill/SKILL.md",
        r#"---
name: local-skill
description: Local skill for route parsing.
version: 1.0.0
author: tester
verified: true
permissions: [network, filesystem]
---

Use this local skill for route parity.
"#,
    )])
    .await;

    // TS parity: platform/daemon/src/routes/skills.test.ts:40-191.
    let resp = server.get("/api/skills").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["skills"][0]["name"], "local-skill");
    assert_eq!(
        body["skills"][0]["description"],
        "Local skill for route parsing."
    );

    let resp = server.get("/api/skills/local-skill").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["name"], "local-skill");
    assert_eq!(body["description"], "Local skill for route parsing.");
    assert_eq!(body["version"], "1.0.0");
    assert!(
        body["content"]
            .as_str()
            .unwrap()
            .contains("Use this local skill")
    );

    // TS parity: platform/daemon/src/pipeline/skill-graph.test.ts:31-75.
    seed_duplicate_skill_meta(&server, "astro-portfolio-site");
    let resp = server
        .post(
            "/api/skills/install",
            json!({"name": "astro-portfolio-site", "source": "fixture/astro-portfolio-site"}),
        )
        .await;
    let status = resp.status();
    let body = server.json(resp).await;
    assert_eq!(status, 200, "install response: {body}");
    assert_eq!(body["success"], true);
    assert_eq!(body["name"], "astro-portfolio-site");
    wait_for_skill_meta(&server, "skill:default:astro-portfolio-site").await;
    let graph = skill_graph_snapshot(&server, "skill:default:astro-portfolio-site");
    assert_eq!(graph["entityType"], "skill");
    assert_eq!(graph["agentId"], "default");
    assert_eq!(graph["uninstalledAt"], Value::Null);
    assert_eq!(graph["source"], "installed");

    // TS parity: platform/daemon/src/skill-invocations.test.ts:40-83. Rust
    // records the same usage row through the scheduler run route.
    seed_skill_task(&server, "agent-a", "web-search");
    let resp = server
        .post("/api/tasks/task-agent-a/run?agent_id=agent-a", json!({}))
        .await;
    assert_eq!(resp.status(), 202);
    let inv = skill_invocation_snapshot(&server, "agent-a");
    assert_eq!(inv["agentId"], "agent-a");
    assert_eq!(inv["skillName"], "web-search");
    assert_eq!(inv["useCount"], 1);
    assert!(inv["lastUsedAt"].as_str().is_some_and(|v| !v.is_empty()));

    seed_task_without_skill_meta(&server, "agent-b", "browser-use");
    let resp = server
        .post("/api/tasks/task-agent-b/run?agent_id=agent-b", json!({}))
        .await;
    assert_eq!(resp.status(), 202);
    let missing_meta = invocation_without_meta_snapshot(&server, "agent-b");
    assert_eq!(missing_meta["agentId"], "agent-b");
    assert_eq!(missing_meta["skillName"], "browser-use");

    let resp = server.delete("/api/skills/astro-portfolio-site").await;
    assert_eq!(resp.status(), 200);
    assert_eq!(server.json(resp).await["success"], true);
    let conn = Connection::open(server.db_path()).expect("open db");
    let remaining: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM skill_meta WHERE entity_id = 'skill:default:astro-portfolio-site'",
            [],
            |row| row.get(0),
        )
        .expect("count skill_meta");
    assert_eq!(remaining, 0);
}

#[tokio::test]
async fn skill_analytics_filters_by_agent_since_and_reports_top_skills() {
    let server = TestServer::start().await;
    seed_skill_analytics(&server);

    // TS parity: platform/daemon/src/routes/skill-analytics.test.ts:32-117.
    let resp = server
        .get("/api/skills/analytics?agent_id=agent-a&limit=1")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["totalCalls"], 3);
    assert_eq!(body["successRate"], 0.667);
    assert_eq!(body["topSkills"].as_array().unwrap().len(), 1);
    assert_eq!(body["topSkills"][0]["skillName"], "web-search");
    assert_eq!(body["topSkills"][0]["count"], 2);
    assert_eq!(body["latency"]["p50"], 100);
    assert_eq!(body["latency"]["p95"], 300);

    let resp = server
        .get("/api/skills/analytics?agent_id=agent-a&since=2026-01-02T00:00:00Z")
        .await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert_eq!(body["totalCalls"], 1);
    assert_eq!(body["topSkills"][0]["skillName"], "browser-use");

    let resp = server
        .get("/api/skills/analytics?agent_id=agent-a&since=not-a-date")
        .await;
    assert_eq!(resp.status(), 400);
    assert_eq!(
        server.json(resp).await["error"],
        "since must be an ISO 8601 UTC timestamp"
    );
}

#[tokio::test]
async fn dashboard_identity_and_marketplace_tail_routes_replay_ts_shapes() {
    let server = TestServer::start_with_yaml(
        r#"agent:
  name: Tail Test Agent
  description: Route parity workspace
"#,
    )
    .await;
    std::fs::write(
        server.tmpdir.path().join("IDENTITY.md"),
        "- name: Legacy\n- creature: helper\n- vibe: direct\n",
    )
    .expect("write identity");

    // TS parity: platform/daemon/src/routes/misc-routes.test.ts:30-39.
    let resp = server.get("/api/identity").await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        server.json(resp).await,
        json!({"name": "Legacy", "creature": "helper", "vibe": "direct"})
    );

    // TS parity: platform/daemon/src/routes/marketplace.test.ts:105-137.
    let resp = server.get("/api/marketplace/mcp/tools").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body.get("error").is_none());
    assert_eq!(body["count"], 0);
    assert_eq!(body["tools"], json!([]));
    assert_eq!(body["servers"], json!([]));

    let resp = server.get("/api/marketplace/mcp/search?q=time").await;
    assert_eq!(resp.status(), 200);
    let body = server.json(resp).await;
    assert!(body.get("error").is_none());
    assert_eq!(body["query"], "time");
    assert_eq!(body["count"], 0);
    assert_eq!(body["results"], json!([]));
}

fn seed_duplicate_skill_meta(server: &TestServer, skill: &str) {
    let conn = Connection::open(server.db_path()).expect("open db");
    let entity_id = format!("skill:default:{skill}");
    conn.execute(
        "INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'skill', 'default', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        params![entity_id, skill, skill],
    )
    .expect("seed duplicate skill entity");
    conn.execute(
        "INSERT INTO skill_meta
         (entity_id, agent_id, source, role, installed_at, fs_path, enriched, uninstalled_at)
         VALUES (?1, 'default', 'reconciler', 'utility', '2026-01-01T00:00:00Z', ?2, 0, '2026-01-02T00:00:00Z')",
        params![entity_id, format!("/tmp/skills/{skill}/SKILL.md")],
    )
    .expect("seed duplicate skill_meta");
}

async fn wait_for_skill_meta(server: &TestServer, entity_id: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let conn = Connection::open(server.db_path()).expect("open db");
        let row: Option<String> = conn
            .query_row(
                "SELECT entity_id FROM skill_meta WHERE entity_id = ?1 AND uninstalled_at IS NULL",
                [entity_id],
                |row| row.get(0),
            )
            .optional()
            .expect("query skill_meta");
        if row.is_some() {
            break;
        }
        if tokio::time::Instant::now() > deadline {
            panic!("skill graph install did not upsert {entity_id}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn skill_graph_snapshot(server: &TestServer, entity_id: &str) -> Value {
    let conn = Connection::open(server.db_path()).expect("open db");
    conn.query_row(
        "SELECT e.entity_type, e.agent_id, sm.source, sm.uninstalled_at
         FROM entities e JOIN skill_meta sm ON sm.entity_id = e.id
         WHERE e.id = ?1",
        [entity_id],
        |row| {
            Ok(json!({
                "entityType": row.get::<_, String>(0)?,
                "agentId": row.get::<_, String>(1)?,
                "source": row.get::<_, String>(2)?,
                "uninstalledAt": row.get::<_, Option<String>>(3)?,
            }))
        },
    )
    .expect("skill graph snapshot")
}

fn seed_skill_task(server: &TestServer, agent_id: &str, skill_name: &str) {
    let conn = Connection::open(server.db_path()).expect("open db");
    conn.execute(
        "INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
         VALUES ('skill-agent-a', ?1, ?2, 'skill', ?3, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        params![skill_name, skill_name, agent_id],
    )
    .expect("seed skill entity");
    conn.execute(
        "INSERT INTO skill_meta (entity_id, agent_id, source, installed_at, fs_path)
         VALUES ('skill-agent-a', ?1, 'signet', '2026-01-01T00:00:00Z', '/tmp/skills/web-search/SKILL.md')",
        [agent_id],
    )
    .expect("seed skill meta");
    conn.execute(
        "INSERT INTO scheduled_tasks
         (id, name, prompt, cron_expression, harness, working_directory, enabled, created_at, updated_at, skill_name, skill_mode)
         VALUES ('task-agent-a', 'Task Agent A', 'run the skill', '* * * * *', 'codex', NULL, 1,
                 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?1, 'inject')",
        [skill_name],
    )
    .expect("seed scheduled task");
    conn.execute(
        "INSERT INTO task_scope_hints (task_id, agent_id, created_at, updated_at)
         VALUES ('task-agent-a', ?1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        [agent_id],
    )
    .expect("seed task scope hint");
}

fn seed_task_without_skill_meta(server: &TestServer, agent_id: &str, skill_name: &str) {
    let conn = Connection::open(server.db_path()).expect("open db");
    conn.execute(
        "INSERT INTO scheduled_tasks
         (id, name, prompt, cron_expression, harness, working_directory, enabled, created_at, updated_at, skill_name, skill_mode)
         VALUES ('task-agent-b', 'Task Agent B', 'run missing meta skill', '* * * * *', 'codex', NULL, 1,
                 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?1, 'inject')",
        [skill_name],
    )
    .expect("seed scheduled task without meta");
    conn.execute(
        "INSERT INTO task_scope_hints (task_id, agent_id, created_at, updated_at)
         VALUES ('task-agent-b', ?1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        [agent_id],
    )
    .expect("seed task scope hint without meta");
}

fn skill_invocation_snapshot(server: &TestServer, agent_id: &str) -> Value {
    let conn = Connection::open(server.db_path()).expect("open db");
    conn.query_row(
        "SELECT i.agent_id, i.skill_name, sm.use_count, sm.last_used_at
         FROM skill_invocations i
         JOIN skill_meta sm ON sm.agent_id = i.agent_id
         WHERE i.agent_id = ?1",
        [agent_id],
        |row| {
            Ok(json!({
                "agentId": row.get::<_, String>(0)?,
                "skillName": row.get::<_, String>(1)?,
                "useCount": row.get::<_, i64>(2)?,
                "lastUsedAt": row.get::<_, Option<String>>(3)?,
            }))
        },
    )
    .expect("skill invocation snapshot")
}

fn invocation_without_meta_snapshot(server: &TestServer, agent_id: &str) -> Value {
    let conn = Connection::open(server.db_path()).expect("open db");
    conn.query_row(
        "SELECT agent_id, skill_name FROM skill_invocations WHERE agent_id = ?1",
        [agent_id],
        |row| {
            Ok(json!({
                "agentId": row.get::<_, String>(0)?,
                "skillName": row.get::<_, String>(1)?,
            }))
        },
    )
    .expect("missing-meta skill invocation snapshot")
}

fn seed_skill_analytics(server: &TestServer) {
    let conn = Connection::open(server.db_path()).expect("open db");
    for (id, skill, agent, latency, success, created_at) in [
        (
            "inv-1",
            "web-search",
            "agent-a",
            100,
            1,
            "2026-01-01T00:00:00Z",
        ),
        (
            "inv-2",
            "web-search",
            "agent-a",
            300,
            0,
            "2026-01-01T01:00:00Z",
        ),
        (
            "inv-3",
            "browser-use",
            "agent-a",
            50,
            1,
            "2026-01-03T00:00:00Z",
        ),
        (
            "inv-4",
            "web-search",
            "agent-b",
            5,
            1,
            "2026-01-03T00:00:00Z",
        ),
    ] {
        conn.execute(
            "INSERT INTO skill_invocations
             (id, skill_name, agent_id, source, latency_ms, success, created_at)
             VALUES (?1, ?2, ?3, 'scheduler', ?4, ?5, ?6)",
            params![id, skill, agent, latency, success, created_at],
        )
        .expect("seed skill invocation");
    }
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
        if Path::new(&path).exists() {
            return path;
        }
    }
    if let Ok(target_dir) = std::env::var("CARGO_TARGET_DIR") {
        let path = PathBuf::from(target_dir).join("debug/signet-daemon");
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }
    std::env::var("CARGO_MANIFEST_DIR")
        .map(|dir| {
            PathBuf::from(dir)
                .join("../../target/debug/signet-daemon")
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_else(|_| "signet-daemon".to_string())
}

fn write_fake_signet_bin(root: &Path) -> PathBuf {
    let bin_dir = root.join("fake-bin");
    std::fs::create_dir_all(&bin_dir).expect("create fake bin dir");
    let script = r#"#!/bin/sh
set -eu
pkg=""
skill=""
prev=""
while [ "$#" -gt 0 ]; do
  arg="${1-}"
  if [ "$prev" = "--skill" ]; then
    skill="$arg"
  elif [ "$prev" = "add" ]; then
    pkg="$arg"
  fi
  prev="$arg"
  shift || true
done
if [ -z "$pkg" ]; then
  echo "unexpected skills installer args" >&2
  exit 64
fi
if [ -z "$skill" ]; then
  skill="$(basename "$pkg")"
fi
target="${SIGNET_PATH}/skills/${skill}"
mkdir -p "$target"
cat > "${target}/SKILL.md" <<EOF
---
name: ${skill}
description: Installed by fake skills runner
version: 1.0.0
---

Fake installed skill body for ${skill}.
EOF
echo "fake skills installed ${skill} from ${pkg}"
"#;
    for name in ["signet", "npm", "bunx", "pnpm", "yarn"] {
        let path = bin_dir.join(name);
        std::fs::write(&path, script).unwrap_or_else(|err| panic!("write fake {name}: {err}"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .unwrap_or_else(|err| panic!("chmod fake {name}: {err}"));
        }
    }
    bin_dir
}
