mod commands;
mod daemon;
mod platform;
mod tray;

use tauri::Manager;

pub fn run() {
    // Wayland compatibility: NVIDIA drivers need explicit sync disabled
    // to avoid rendering issues on Wayland compositors.
    #[cfg(target_os = "linux")]
    if std::env::var("WAYLAND_DISPLAY").is_ok()
        || std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland")
    {
        // NVIDIA-specific: prevent explicit sync issues
        if std::path::Path::new("/proc/driver/nvidia").exists()
            && std::env::var("__NV_DISABLE_EXPLICIT_SYNC").is_err()
        {
            unsafe {
                std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second instance tried to launch — show the main window
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            commands::start_daemon,
            commands::stop_daemon,
            commands::restart_daemon,
            commands::get_daemon_pid,
            commands::open_dashboard,
            commands::update_tray,
            commands::quick_capture,
            commands::search_memories,
            commands::quit_capture_window,
            commands::quit_search_window,
            commands::quit_app,
            commands::check_for_update,
        ])
        .on_window_event(|window, event| {
            // Hide main window on close instead of destroying it,
            // so "Open Dashboard" from tray can re-show it without
            // recreating from scratch.
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            platform::autostart::ensure_autostart();

            tray::setup(app)?;

            // Auto-start daemon if not running
            let manager = platform::create_manager();
            if !manager.is_running() {
                let _ = daemon::start();
            }

            // Debug: open devtools (also fixes WebKit2GTK input regions on Wayland)
            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running signet");
}
