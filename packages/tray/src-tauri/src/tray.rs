use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    App, Manager, WebviewWindowBuilder, WebviewUrl,
};

use crate::commands;

pub const TRAY_ID: &str = "signet-tray";

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
    let id = event.id();
    let id_str = id.as_ref();

    match id_str {
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
        "quick-capture" => {
            open_quick_capture(app);
        }
        "search-memories" => {
            open_search_window(app);
        }
        "quit" => {
            app.exit(0);
        }
        "perception-start" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let channels = vec![
                    "screen".to_string(),
                    "files".to_string(),
                    "terminal".to_string(),
                ];
                let _ = commands::perception_start(channels).await;
                // Emit event so TypeScript poller picks up the change
                let _ = handle.emit("perception-changed", ());
            });
        }
        "perception-stop" => {
            tauri::async_runtime::spawn(async move {
                let _ = commands::perception_stop().await;
            });
        }
        "perception-ch-screen" => {
            tauri::async_runtime::spawn(async move {
                // Toggle: we don't know current state from here, so we toggle
                // The label says ON or OFF; the TypeScript layer manages actual state.
                // For simplicity, always toggle to the opposite of what's shown.
                let _ = commands::perception_toggle_channel(
                    "screen".to_string(),
                    true,
                )
                .await;
            });
        }
        "perception-ch-files" => {
            tauri::async_runtime::spawn(async move {
                let _ = commands::perception_toggle_channel(
                    "files".to_string(),
                    true,
                )
                .await;
            });
        }
        "perception-ch-terminal" => {
            tauri::async_runtime::spawn(async move {
                let _ = commands::perception_toggle_channel(
                    "terminal".to_string(),
                    true,
                )
                .await;
            });
        }
        "perception-ch-voice" => {
            tauri::async_runtime::spawn(async move {
                let _ = commands::perception_toggle_channel(
                    "voice".to_string(),
                    true,
                )
                .await;
            });
        }
        "perception-pause" => {
            tauri::async_runtime::spawn(async move {
                let _ = commands::perception_pause().await;
            });
        }
        "perception-resume" => {
            tauri::async_runtime::spawn(async move {
                let _ = commands::perception_resume().await;
            });
        }
        "perception-view-profile" => {
            let _ = open::that("http://localhost:3850/perception/profile");
        }
        "perception-view-dashboard" => {
            open_perception_dashboard(app);
        }
        _ => {
            // Handle recent memory clicks (copy content to clipboard)
            if id_str.starts_with("recent-memory-") {
                // The content is stored in the menu item text; users can see it in the menu.
                // We don't need clipboard for submenu items — they're informational.
            }
        }
    }
}

fn open_quick_capture(app: &tauri::AppHandle) {
    // If window already exists, just focus it
    if let Some(win) = app.get_webview_window("capture") {
        let _ = win.set_focus();
        return;
    }

    let url = WebviewUrl::App("capture.html".into());
    let _ = WebviewWindowBuilder::new(app, "capture", url)
        .title("Quick Capture")
        .inner_size(400.0, 160.0)
        .resizable(false)
        .always_on_top(true)
        .center()
        .visible(true)
        .build();
}

fn open_perception_dashboard(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("perception") {
        let _ = win.set_focus();
        return;
    }

    let url = WebviewUrl::App("perception.html".into());
    let _ = WebviewWindowBuilder::new(app, "perception", url)
        .title("Signet Perception")
        .inner_size(900.0, 700.0)
        .resizable(true)
        .center()
        .visible(true)
        .build();
}

fn open_search_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("search") {
        let _ = win.set_focus();
        return;
    }

    let url = WebviewUrl::App("search.html".into());
    let _ = WebviewWindowBuilder::new(app, "search", url)
        .title("Search Memories")
        .inner_size(500.0, 420.0)
        .resizable(true)
        .always_on_top(true)
        .center()
        .visible(true)
        .build();
}

/// Format a number with thousands separators (e.g. 4605 → "4,605")
fn format_number(n: u64) -> String {
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

/// Compute a relative time string from ISO timestamp
fn time_ago(iso: &str) -> String {
    let Ok(ts) = chrono::DateTime::parse_from_rfc3339(iso) else {
        // Try parsing without timezone
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S%.f") {
            let now = chrono::Utc::now().naive_utc();
            let dur = now.signed_duration_since(naive);
            return format_duration(dur);
        }
        return "just now".to_string();
    };
    let now = chrono::Utc::now();
    let dur = now.signed_duration_since(ts.with_timezone(&chrono::Utc));
    format_duration(dur)
}

fn format_duration(dur: chrono::Duration) -> String {
    let secs = dur.num_seconds();
    if secs < 60 {
        "just now".to_string()
    } else if secs < 3600 {
        let m = secs / 60;
        format!("{}m ago", m)
    } else if secs < 86400 {
        let h = secs / 3600;
        format!("{}h ago", h)
    } else {
        let d = secs / 86400;
        format!("{}d ago", d)
    }
}

/// Truncate a string to max chars, adding "..." if truncated
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut result: String = s.chars().take(max - 3).collect();
        result.push_str("...");
        result
    }
}

pub fn build_running_menu(
    app: &tauri::AppHandle,
    version: &str,
    health_score: Option<f64>,
    health_status: Option<&str>,
    memory_count: Option<u64>,
    memories_today: Option<u64>,
    _critical_memories: Option<u64>,
    embedding_coverage: Option<f64>,
    embedding_provider: Option<&str>,
    queue_depth: Option<u64>,
    recent_memories: &[commands::RecentMemory],
    _ingestion_rate: Option<f64>,
    perception_active: Option<bool>,
    perception_channels: Option<&[String]>,
    perception_captures_today: Option<u64>,
    perception_skills_count: Option<u64>,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let mut builder = MenuBuilder::new(app);

    // Status line
    builder = builder.item(
        &MenuItemBuilder::with_id(
            "status",
            format!("Signet v{version} — Running"),
        )
        .enabled(false)
        .build(app)?,
    );

    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    // Stats section
    let mem_label = match (memory_count, memories_today) {
        (Some(total), Some(today)) => {
            format!("📊 {} memories ({} today)", format_number(total), format_number(today))
        }
        (Some(total), None) => format!("📊 {} memories", format_number(total)),
        _ => "📊 Memories: loading...".to_string(),
    };
    builder = builder.item(
        &MenuItemBuilder::with_id("info-memories", &mem_label)
            .enabled(false)
            .build(app)?,
    );

    let embed_label = match embedding_coverage {
        Some(cov) => {
            let pct = (cov * 100.0).round() as u32;
            let provider_suffix = embedding_provider
                .map(|p| format!(" ({})", p))
                .unwrap_or_default();
            format!("🧠 Embeddings: {}% coverage{}", pct, provider_suffix)
        }
        None => "🧠 Embeddings: loading...".to_string(),
    };
    builder = builder.item(
        &MenuItemBuilder::with_id("info-embeddings", &embed_label)
            .enabled(false)
            .build(app)?,
    );

    let queue_label = match queue_depth {
        Some(depth) => format!("⚡ Queue: {} pending", format_number(depth)),
        None => "⚡ Queue: loading...".to_string(),
    };
    builder = builder.item(
        &MenuItemBuilder::with_id("info-queue", &queue_label)
            .enabled(false)
            .build(app)?,
    );

    let health_label = match (health_score, health_status) {
        (Some(score), Some(status)) => {
            let score_display = (score * 100.0).round() as u32;
            let emoji = if score >= 0.8 {
                "💚"
            } else if score >= 0.5 {
                "💛"
            } else {
                "❤️"
            };
            format!("{} Health: {} ({}/100)", emoji, status, score_display)
        }
        (Some(score), None) => {
            let score_display = (score * 100.0).round() as u32;
            format!("💚 Health: {}/100", score_display)
        }
        _ => "💚 Health: loading...".to_string(),
    };
    builder = builder.item(
        &MenuItemBuilder::with_id("info-health", &health_label)
            .enabled(false)
            .build(app)?,
    );

    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    // Actions
    builder = builder.item(
        &MenuItemBuilder::with_id("quick-capture", "✏️ Quick Capture...")
            .build(app)?,
    );
    builder = builder.item(
        &MenuItemBuilder::with_id("search-memories", "🔍 Search Memories...")
            .build(app)?,
    );

    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    // Recent memories submenu
    if !recent_memories.is_empty() {
        let mut submenu = SubmenuBuilder::new(app, "Recent Memories");

        for (i, mem) in recent_memories.iter().take(10).enumerate() {
            let content_preview = truncate(
                &mem.content.replace('\n', " "),
                50,
            );
            let ago = time_ago(&mem.created_at);
            let label = format!("\"{}\" — {}", content_preview, ago);
            let id = format!("recent-memory-{}", i);

            submenu = submenu.item(
                &MenuItemBuilder::with_id(&id, &label)
                    .enabled(false)
                    .build(app)?,
            );
        }

        builder = builder.item(&submenu.build()?);
        builder = builder.item(&PredefinedMenuItem::separator(app)?);
    }

    // Perception submenu
    {
        let is_active = perception_active.unwrap_or(false);
        let active_channels: Vec<&str> = perception_channels
            .map(|chs| chs.iter().map(|s| s.as_str()).collect())
            .unwrap_or_default();

        let mut perception = SubmenuBuilder::new(app, "👁 Perception");

        // Start / Stop toggle
        if is_active {
            perception = perception.item(
                &MenuItemBuilder::with_id("perception-stop", "⏹ Stop Perception")
                    .build(app)?,
            );
        } else {
            perception = perception.item(
                &MenuItemBuilder::with_id("perception-start", "▶ Start Perception")
                    .build(app)?,
            );
        }

        perception = perception.item(&PredefinedMenuItem::separator(app)?);

        // Channel toggles
        let screen_on = active_channels.contains(&"screen");
        perception = perception.item(
            &MenuItemBuilder::with_id(
                "perception-ch-screen",
                if screen_on { "🖥 Screen Capture: ON" } else { "🖥 Screen Capture: OFF" },
            )
            .build(app)?,
        );

        let files_on = active_channels.contains(&"files");
        perception = perception.item(
            &MenuItemBuilder::with_id(
                "perception-ch-files",
                if files_on { "📁 File Watching: ON" } else { "📁 File Watching: OFF" },
            )
            .build(app)?,
        );

        let terminal_on = active_channels.contains(&"terminal");
        perception = perception.item(
            &MenuItemBuilder::with_id(
                "perception-ch-terminal",
                if terminal_on { "⌨️ Terminal: ON" } else { "⌨️ Terminal: OFF" },
            )
            .build(app)?,
        );

        let voice_on = active_channels.contains(&"voice");
        perception = perception.item(
            &MenuItemBuilder::with_id(
                "perception-ch-voice",
                if voice_on { "🎤 Voice: ON" } else { "🎤 Voice: OFF" },
            )
            .build(app)?,
        );

        perception = perception.item(&PredefinedMenuItem::separator(app)?);

        // Meeting mode (pause / resume)
        if is_active {
            perception = perception.item(
                &MenuItemBuilder::with_id("perception-pause", "⏸ Meeting Mode (Pause All)")
                    .build(app)?,
            );
        } else {
            perception = perception.item(
                &MenuItemBuilder::with_id("perception-resume", "▶ Resume")
                    .build(app)?,
            );
        }

        perception = perception.item(&PredefinedMenuItem::separator(app)?);

        // Stats line
        let captures_label = match perception_captures_today {
            Some(n) => format!("📸 {} captures today", format_number(n)),
            None => "📸 Captures: --".to_string(),
        };
        perception = perception.item(
            &MenuItemBuilder::with_id("perception-info-captures", &captures_label)
                .enabled(false)
                .build(app)?,
        );

        let skills_label = match perception_skills_count {
            Some(n) => format!("🧩 {} skills detected", format_number(n)),
            None => "🧩 Skills: --".to_string(),
        };
        perception = perception.item(
            &MenuItemBuilder::with_id("perception-info-skills", &skills_label)
                .enabled(false)
                .build(app)?,
        );

        perception = perception.item(&PredefinedMenuItem::separator(app)?);

        // Views
        perception = perception.item(
            &MenuItemBuilder::with_id("perception-view-profile", "View Profile...")
                .build(app)?,
        );
        perception = perception.item(
            &MenuItemBuilder::with_id("perception-view-dashboard", "View Dashboard...")
                .build(app)?,
        );

        builder = builder.item(&perception.build()?);
        builder = builder.item(&PredefinedMenuItem::separator(app)?);
    }

    // Controls
    builder = builder.item(
        &MenuItemBuilder::with_id("open-dashboard", "Open Dashboard")
            .build(app)?,
    );
    builder = builder.item(
        &MenuItemBuilder::with_id("stop-daemon", "Stop Daemon")
            .build(app)?,
    );
    builder = builder.item(
        &MenuItemBuilder::with_id("restart-daemon", "Restart Daemon")
            .build(app)?,
    );

    builder = builder.item(&PredefinedMenuItem::separator(app)?);
    builder = builder.item(
        &MenuItemBuilder::with_id("quit", "Quit Signet Tray")
            .build(app)?,
    );

    Ok(builder.build()?)
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
        .item(
            &MenuItemBuilder::with_id("restart-daemon", "Restart Daemon")
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
