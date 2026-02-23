use serde::Deserialize;
use tauri::AppHandle;

use crate::daemon;
use crate::tray;

const TRAY_ID: &str = "signet-tray";

#[derive(Deserialize)]
#[serde(tag = "kind")]
pub enum TrayState {
    #[serde(rename = "running")]
    Running {
        version: String,
        health_score: Option<u32>,
        health_status: Option<String>,
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
        } => {
            let health_label = match (health_score, health_status.as_deref())
            {
                (Some(score), Some(status)) => {
                    format!("Health: {status} ({score}/100)")
                }
                (Some(score), None) => format!("Health: {score}/100"),
                _ => "Health: Unknown".to_string(),
            };

            let menu =
                tray::build_running_menu(&app, version, &health_label)
                    .map_err(|e| e.to_string())?;
            tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
            tray.set_tooltip(Some(&format!(
                "Signet {version} — Running"
            )))
            .map_err(|e| e.to_string())?;
            let _ = tray.set_icon(Some(tray::icon_for_state("running")));
        }
        TrayState::Stopped => {
            let menu = tray::build_stopped_menu(&app)
                .map_err(|e| e.to_string())?;
            tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
            tray.set_tooltip(Some("Signet — Stopped"))
                .map_err(|e| e.to_string())?;
            let _ = tray.set_icon(Some(tray::icon_for_state("stopped")));
        }
        TrayState::Error { message } => {
            let menu = tray::build_error_menu(&app, message)
                .map_err(|e| e.to_string())?;
            tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
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
pub async fn quit_app(app: AppHandle) {
    app.exit(0);
}
