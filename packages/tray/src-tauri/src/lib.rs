mod commands;
mod daemon;
mod platform;
mod tray;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
            commands::perception_start,
            commands::perception_stop,
            commands::perception_status,
            commands::perception_toggle_channel,
            commands::perception_pause,
            commands::perception_resume,
            commands::get_cognitive_profile,
            commands::get_expertise_graph,
            commands::open_perception_dashboard,
            commands::quit_perception_window,
        ])
        .setup(|app| {
            tray::setup(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running signet tray");
}
