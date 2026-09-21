use std::{
    env,
    net::TcpListener,
    process::{Command, Stdio},
    time::Duration,
};

#[tokio::test]
async fn session_expand_live_http_requires_recall_authority() {
    let workspace = std::env::temp_dir().join(format!("signet-session-expand-{}", std::process::id()));
    std::fs::create_dir_all(&workspace).unwrap();
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let binary = env::var_os("SIGNET_DAEMON_BIN")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_exe().ok().and_then(|p| p.parent()?.parent().map(|p| p.join("signet-daemon"))))
        .expect("fresh daemon binary");
    let mut child = Command::new(binary)
        .env("SIGNET_PATH", &workspace)
        .env("SIGNET_PORT", port.to_string())
        .env("SIGNET_BIND", "127.0.0.1")
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/api/knowledge/expand/session");
    let mut ready = false;
    for _ in 0..100 {
        if client.get(format!("http://127.0.0.1:{port}/health/ready")).send().await.is_ok() { ready = true; break; }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if !ready {
        let out = child.wait_with_output().unwrap();
        panic!("daemon did not become ready: stdout={} stderr={}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    }
    let response = client.post(url).json(&serde_json::json!({"entityName":"x"})).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(workspace);
}
