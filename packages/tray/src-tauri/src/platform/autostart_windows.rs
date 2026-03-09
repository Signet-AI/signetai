use std::process::Command;

const REG_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "Signet";

/// Add Signet to Windows startup via registry.
pub fn ensure_autostart() {
    let exe = match std::env::current_exe() {
        Ok(e) => e.to_string_lossy().to_string(),
        Err(_) => return,
    };

    let _ = Command::new("reg")
        .args([
            "add", REG_KEY,
            "/v", VALUE_NAME,
            "/t", "REG_SZ",
            "/d", &exe,
            "/f",
        ])
        .output();
}

/// Remove Signet from Windows startup.
pub fn remove_autostart() {
    let _ = Command::new("reg")
        .args(["delete", REG_KEY, "/v", VALUE_NAME, "/f"])
        .output();
}

/// Check if Signet is set to start at login.
pub fn is_autostart_enabled() -> bool {
    Command::new("reg")
        .args(["query", REG_KEY, "/v", VALUE_NAME])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
