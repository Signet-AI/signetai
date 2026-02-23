use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::daemon;
use crate::tray;

const TRAY_ID: &str = "signet-tray";
const DAEMON_URL: &str = "http://localhost:3850";

#[derive(Deserialize, Clone)]
#[allow(dead_code)]
pub struct RecentMemory {
    pub content: String,
    pub created_at: String,
    pub who: String,
    pub importance: f64,
}

#[derive(Deserialize)]
#[serde(tag = "kind")]
pub enum TrayState {
    #[serde(rename = "running")]
    Running {
        version: String,
        health_score: Option<f64>,
        health_status: Option<String>,
        memory_count: Option<u64>,
        memories_today: Option<u64>,
        critical_memories: Option<u64>,
        embedding_coverage: Option<f64>,
        embedding_provider: Option<String>,
        queue_depth: Option<u64>,
        recent_memories: Option<Vec<RecentMemory>>,
        ingestion_rate: Option<f64>,
    },
    #[serde(rename = "stopped")]
    Stopped,
    #[serde(rename = "error")]
    Error { message: String },
}

pub(crate) async fn start_daemon_inner(
    _app: &AppHandle,
) -> Result<(), String> {
    daemon::start().map_err(|e| e.to_string())
}

pub(crate) async fn stop_daemon_inner(
    _app: &AppHandle,
) -> Result<(), String> {
    daemon::stop().map_err(|e| e.to_string())
}

pub(crate) async fn restart_daemon_inner(
    _app: &AppHandle,
) -> Result<(), String> {
    daemon::stop().map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(500));
    daemon::start().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_daemon(app: AppHandle) -> Result<(), String> {
    start_daemon_inner(&app).await
}

#[tauri::command]
pub async fn stop_daemon(app: AppHandle) -> Result<(), String> {
    stop_daemon_inner(&app).await
}

#[tauri::command]
pub async fn restart_daemon(app: AppHandle) -> Result<(), String> {
    restart_daemon_inner(&app).await
}

#[tauri::command]
pub async fn get_daemon_pid() -> Result<Option<u32>, String> {
    daemon::read_pid().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_dashboard() -> Result<(), String> {
    open::that("http://localhost:3850").map_err(|e| e.to_string())
}

/// Format a number with comma separators
fn format_count(n: u64) -> String {
    let s = n.to_string();
    let mut result = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            result.push(',');
        }
        result.push(c);
    }
    result.chars().rev().collect()
}

#[tauri::command]
pub async fn update_tray(
    app: AppHandle,
    state: TrayState,
) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or("tray not found")?;

    match &state {
        TrayState::Running {
            version,
            health_score,
            health_status,
            memory_count,
            memories_today,
            critical_memories,
            embedding_coverage,
            embedding_provider,
            queue_depth,
            recent_memories,
            ingestion_rate,
        } => {
            let empty_memories = Vec::new();
            let memories = recent_memories.as_deref().unwrap_or(&empty_memories);

            let menu = tray::build_running_menu(
                &app,
                version,
                *health_score,
                health_status.as_deref(),
                *memory_count,
                *memories_today,
                *critical_memories,
                *embedding_coverage,
                embedding_provider.as_deref(),
                *queue_depth,
                memories,
                *ingestion_rate,
            )
            .map_err(|e| e.to_string())?;

            tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;

            // Set menu bar title with memory count
            if let Some(count) = memory_count {
                let title = format_count(*count);
                let _ = tray.set_title(Some(&title));
            } else {
                let _ = tray.set_title(Some("..."));
            }

            tray.set_tooltip(Some(&format!(
                "Signet v{version} — Running"
            )))
            .map_err(|e| e.to_string())?;
            let _ = tray.set_icon(Some(tray::icon_for_state("running")));
        }
        TrayState::Stopped => {
            let menu = tray::build_stopped_menu(&app)
                .map_err(|e| e.to_string())?;
            tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
            let _ = tray.set_title(None::<&str>);
            tray.set_tooltip(Some("Signet — Stopped"))
                .map_err(|e| e.to_string())?;
            let _ = tray.set_icon(Some(tray::icon_for_state("stopped")));
        }
        TrayState::Error { message } => {
            let menu = tray::build_error_menu(&app, message)
                .map_err(|e| e.to_string())?;
            tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
            let _ = tray.set_title(Some("⚠"));
            tray.set_tooltip(Some(&format!(
                "Signet — Error: {message}"
            )))
            .map_err(|e| e.to_string())?;
            let _ = tray.set_icon(Some(tray::icon_for_state("error")));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn quick_capture(content: String) -> Result<(), String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "content": content,
        "who": "tray-capture",
        "importance": 0.7
    });

    let res = client
        .post(format!("{}/api/memory/remember", DAEMON_URL))
        .json(&body)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("Failed to send: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    Ok(())
}

#[tauri::command]
pub async fn search_memories(
    query: String,
    limit: Option<u32>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "query": query,
        "limit": limit.unwrap_or(10)
    });

    let res = client
        .post(format!("{}/api/memory/recall", DAEMON_URL))
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to send: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    let text = res.text().await.map_err(|e| format!("Failed to read body: {}", e))?;
    Ok(text)
}

#[tauri::command]
pub async fn quit_capture_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("capture") {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn quit_search_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("search") {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn quit_app(app: AppHandle) {
    app.exit(0);
}
