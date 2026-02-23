use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, Manager,
};

use crate::commands;

const TRAY_ID: &str = "signet-tray";

// Embed icons at compile time so they work in release builds
const ICON_RUNNING: &[u8] = include_bytes!("../../icons/signet-running.png");
const ICON_STOPPED: &[u8] = include_bytes!("../../icons/signet-stopped.png");
const ICON_ERROR: &[u8] = include_bytes!("../../icons/signet-error.png");

fn decode_png(data: &[u8]) -> Image<'static> {
    let decoder = png::Decoder::new(data);
    let mut reader = decoder.read_info().expect("valid PNG header");
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).expect("valid PNG frame");
    buf.truncate(info.buffer_size());

    // Convert to RGBA if needed
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => {
            let mut rgba = Vec::with_capacity(buf.len() / 3 * 4);
            for chunk in buf.chunks(3) {
                rgba.extend_from_slice(chunk);
                rgba.push(255);
            }
            rgba
        }
        png::ColorType::GrayscaleAlpha => {
            let mut rgba = Vec::with_capacity(buf.len() * 2);
            for chunk in buf.chunks(2) {
                let g = chunk[0];
                let a = chunk[1];
                rgba.extend_from_slice(&[g, g, g, a]);
            }
            rgba
        }
        _ => buf, // Best effort
    };

    Image::new_owned(rgba, info.width, info.height)
}

pub fn icon_for_state(state: &str) -> Image<'static> {
    let bytes = match state {
        "running" => ICON_RUNNING,
        "error" => ICON_ERROR,
        _ => ICON_STOPPED,
    };
    decode_png(bytes)
}

pub fn setup(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = build_stopped_menu(app)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon_for_state("stopped"))
        .menu(&menu)
        .tooltip("Signet — Checking...")
        .on_menu_event(handle_menu_event)
        .build(app)?;

    Ok(())
}

fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        "open-dashboard" => {
            let _ = open::that("http://localhost:3850");
        }
        "start-daemon" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = commands::start_daemon_inner(&handle).await;
            });
        }
        "stop-daemon" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = commands::stop_daemon_inner(&handle).await;
            });
        }
        "restart-daemon" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = commands::restart_daemon_inner(&handle).await;
            });
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

pub fn build_running_menu(
    app: &tauri::AppHandle,
    version: &str,
    health_label: &str,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .item(
            &MenuItemBuilder::with_id(
                "status",
                format!("Signet {version} — Running"),
            )
            .enabled(false)
            .build(app)?,
        )
        .item(&PredefinedMenuItem::separator(app)?)
        .item(
            &MenuItemBuilder::with_id("open-dashboard", "Open Dashboard")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("stop-daemon", "Stop Daemon")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("restart-daemon", "Restart Daemon")
                .build(app)?,
        )
        .item(&PredefinedMenuItem::separator(app)?)
        .item(
            &MenuItemBuilder::with_id("health", health_label.to_string())
                .enabled(false)
                .build(app)?,
        )
        .item(&PredefinedMenuItem::separator(app)?)
        .item(
            &MenuItemBuilder::with_id("quit", "Quit Signet Tray")
                .build(app)?,
        )
        .build()?;
    Ok(menu)
}

pub fn build_stopped_menu(
    app: &impl Manager<tauri::Wry>,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .item(
            &MenuItemBuilder::with_id("status", "Signet — Stopped")
                .enabled(false)
                .build(app)?,
        )
        .item(&PredefinedMenuItem::separator(app)?)
        .item(
            &MenuItemBuilder::with_id("start-daemon", "Start Daemon")
                .build(app)?,
        )
        .item(&PredefinedMenuItem::separator(app)?)
        .item(
            &MenuItemBuilder::with_id("quit", "Quit Signet Tray")
                .build(app)?,
        )
        .build()?;
    Ok(menu)
}

pub fn build_error_menu(
    app: &tauri::AppHandle,
    error: &str,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .item(
            &MenuItemBuilder::with_id(
                "status",
                format!("Signet — Error: {error}"),
            )
            .enabled(false)
            .build(app)?,
        )
        .item(&PredefinedMenuItem::separator(app)?)
        .item(
            &MenuItemBuilder::with_id("start-daemon", "Start Daemon")
                .build(app)?,
        )
        .item(&PredefinedMenuItem::separator(app)?)
        .item(
            &MenuItemBuilder::with_id("quit", "Quit Signet Tray")
                .build(app)?,
        )
        .build()?;
    Ok(menu)
}
