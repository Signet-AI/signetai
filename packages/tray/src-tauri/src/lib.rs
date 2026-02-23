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
            commands::quit_app,
        ])
        .setup(|app| {
            tray::setup(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running signet tray");
}
