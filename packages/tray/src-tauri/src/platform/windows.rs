use std::process::Command;

use super::DaemonManager;

pub struct WindowsManager;

impl WindowsManager {
    fn find_bun(&self) -> Option<String> {
        // Check %LOCALAPPDATA%\bun\bun.exe
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let bun_path = std::path::Path::new(&local_app_data)
                .join("bun")
                .join("bun.exe");
            if bun_path.exists() {
                return Some(bun_path.to_string_lossy().to_string());
            }
        }

        // Fall back to PATH lookup
        Command::new("where")
            .arg("bun")
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    String::from_utf8_lossy(&o.stdout)
                        .lines()
                        .next()
                        .map(|s| s.trim().to_string())
                } else {
                    None
                }
            })
    }

    fn find_daemon_js(&self) -> Option<String> {
        // %LOCALAPPDATA%\bun\install\global\node_modules\signetai\dist\daemon.js
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let path = std::path::Path::new(&local_app_data)
                .join("bun/install/global/node_modules/signetai/dist/daemon.js");
            if path.exists() {
                return Some(path.to_string_lossy().to_string());
            }
        }

        // %APPDATA%\npm\node_modules\signetai\dist\daemon.js
        if let Ok(app_data) = std::env::var("APPDATA") {
            let path =
                std::path::Path::new(&app_data).join("npm/node_modules/signetai/dist/daemon.js");
            if path.exists() {
                return Some(path.to_string_lossy().to_string());
            }
        }

        None
    }

    fn find_signet_cli(&self) -> Option<String> {
        Command::new("where")
            .arg("signet")
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    String::from_utf8_lossy(&o.stdout)
                        .lines()
                        .next()
                        .map(|s| s.trim().to_string())
                } else {
                    None
                }
            })
    }

    fn read_pid(&self) -> Option<u32> {
        let home = dirs::home_dir()?;
        let pid_path = home.join(".agents/.daemon/pid");
        let content = std::fs::read_to_string(&pid_path).ok()?;
        content.trim().parse().ok()
    }

    /// Terminate a process by PID using Windows API (no shell).
    fn terminate_process(pid: u32) -> Result<(), Box<dyn std::error::Error>> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, false, pid)?;
            let result = TerminateProcess(handle, 1);
            let _ = CloseHandle(handle);
            result?;
        }
        Ok(())
    }

    fn process_alive(pid: u32) -> bool {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

        unsafe {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(handle) => {
                    let _ = CloseHandle(handle);
                    true
                }
                Err(_) => false,
            }
        }
    }
}

impl DaemonManager for WindowsManager {
    fn start(&self) -> Result<(), Box<dyn std::error::Error>> {
        use std::os::windows::process::CommandExt;
        // Suppress console window flash when spawning daemon
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // Try `signet daemon start` CLI first
        if let Some(signet) = self.find_signet_cli() {
            Command::new(&signet)
                .args(["daemon", "start"])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()?;
            return Ok(());
        }

        if let Some(bun) = self.find_bun() {
            // Try daemon.js directly
            if let Some(daemon_js) = self.find_daemon_js() {
                Command::new(&bun)
                    .arg(&daemon_js)
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()?;
                return Ok(());
            }

            // Last resort: bunx
            Command::new(&bun)
                .args(["x", "signetai", "daemon", "start"])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()?;
            return Ok(());
        }

        if let Some(bin) = super::find_bundled_daemon() {
            Command::new(&bin)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()?;
            return Ok(());
        }

        Err("bun not found and no bundled daemon runtime is available".into())
    }

    fn stop(&self) -> Result<(), Box<dyn std::error::Error>> {
        let Some(pid) = self.read_pid() else {
            return Ok(()); // Already stopped
        };

        // Terminate via Windows API
        Self::terminate_process(pid)?;

        // Wait up to 3s for process to exit
        for _ in 0..30 {
            if !Self::process_alive(pid) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // Clean up PID file
        if let Some(home) = dirs::home_dir() {
            let pid_path = home.join(".agents/.daemon/pid");
            let _ = std::fs::remove_file(&pid_path);
        }

        Ok(())
    }

    fn is_running(&self) -> bool {
        match self.read_pid() {
            Some(pid) => Self::process_alive(pid),
            None => false,
        }
    }
}
