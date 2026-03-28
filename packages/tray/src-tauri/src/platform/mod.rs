use std::path::PathBuf;

pub trait DaemonManager {
    fn start(&self) -> Result<(), Box<dyn std::error::Error>>;
    fn stop(&self) -> Result<(), Box<dyn std::error::Error>>;
    fn is_running(&self) -> bool;
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "macos")]
pub mod autostart;

#[cfg(target_os = "windows")]
#[path = "autostart_windows.rs"]
pub mod autostart;

fn daemon_name(path: &std::path::Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };

    if !name.starts_with("signet-daemon") {
        return false;
    }

    #[cfg(target_os = "windows")]
    {
        return name.ends_with(".exe");
    }

    #[cfg(not(target_os = "windows"))]
    {
        return !name.ends_with(".exe");
    }
}

fn scan_dir(dir: &PathBuf) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    for item in entries.flatten() {
        let path = item.path();
        if !path.is_file() {
            continue;
        }
        if !daemon_name(&path) {
            continue;
        }
        return Some(path.to_string_lossy().to_string());
    }
    None
}

pub fn find_bundled_daemon() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let root = exe.parent()?;

    #[cfg(target_os = "macos")]
    {
        let dirs = vec![
            root.to_path_buf(),
            root.join("../Resources"),
        ];

        for dir in dirs {
            if let Some(path) = scan_dir(&dir) {
                return Some(path);
            }
        }

        return None;
    }

    #[cfg(not(target_os = "macos"))]
    let dirs = vec![root.to_path_buf()];

    for dir in dirs {
        if let Some(path) = scan_dir(&dir) {
            return Some(path);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::daemon_name;

    #[test]
    fn accepts_prefixed_binary_name() {
        #[cfg(target_os = "windows")]
        assert!(daemon_name(Path::new("signet-daemon-x86_64-pc-windows-msvc.exe")));

        #[cfg(not(target_os = "windows"))]
        assert!(daemon_name(Path::new("signet-daemon-x86_64-unknown-linux-gnu")));
    }

    #[test]
    fn rejects_non_daemon_prefix() {
        assert!(!daemon_name(Path::new("daemon-helper")));
    }
}

pub fn create_manager() -> Box<dyn DaemonManager> {
    #[cfg(target_os = "linux")]
    { Box::new(linux::LinuxManager) }

    #[cfg(target_os = "macos")]
    { Box::new(macos::MacosManager) }

    #[cfg(target_os = "windows")]
    { Box::new(windows::WindowsManager) }
}
