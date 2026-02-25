use std::fs;
use std::path::PathBuf;
use std::process::Command;

const LAUNCHD_LABEL: &str = "ai.signet.tray";
const PLIST_FILENAME: &str = "ai.signet.tray.plist";

/// Find the .app bundle path by walking up from current_exe().
/// Returns None if not running inside a .app bundle (e.g. dev mode).
fn app_bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // Walk up looking for a directory ending in .app
    let mut path = exe.as_path();
    loop {
        if let Some(name) = path.file_name() {
            if name.to_string_lossy().ends_with(".app") {
                return Some(path.to_path_buf());
            }
        }
        path = path.parent()?;
    }
}

fn launch_agents_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join("Library/LaunchAgents"))
}

fn plist_path() -> Option<PathBuf> {
    Some(launch_agents_dir()?.join(PLIST_FILENAME))
}

fn generate_plist(app_path: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/open</string>
        <string>-a</string>
        <string>{app_path}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
"#
    )
}

/// Install LaunchAgent plist if not present, or update if app has moved.
/// No-ops if not running inside a .app bundle.
pub fn ensure_autostart() {
    let Some(app_path) = app_bundle_path() else {
        // Not in a .app bundle (dev mode) — skip
        return;
    };

    let app_str = app_path.to_string_lossy().to_string();
    let Some(plist) = plist_path() else { return };

    // Ensure LaunchAgents directory exists
    if let Some(dir) = launch_agents_dir() {
        let _ = fs::create_dir_all(&dir);
    }

    // Check if plist already exists with the correct path
    if plist.exists() {
        if let Ok(existing) = fs::read_to_string(&plist) {
            if existing.contains(&app_str) {
                // Already correct — nothing to do
                return;
            }
            // App has moved — unload old, rewrite
            let _ = Command::new("launchctl")
                .args(["unload", &plist.to_string_lossy()])
                .output();
        }
    }

    let content = generate_plist(&app_str);
    if fs::write(&plist, &content).is_ok() {
        let _ = Command::new("launchctl")
            .args(["load", &plist.to_string_lossy()])
            .output();
    }
}

/// Remove LaunchAgent plist and unload the service.
pub fn remove_autostart() {
    let Some(plist) = plist_path() else { return };

    if plist.exists() {
        let _ = Command::new("launchctl")
            .args(["unload", &plist.to_string_lossy()])
            .output();
        let _ = fs::remove_file(&plist);
    }
}

/// Check if the autostart plist exists.
pub fn is_autostart_enabled() -> bool {
    plist_path().map(|p| p.exists()).unwrap_or(false)
}
