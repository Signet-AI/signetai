use std::process::Command;

use super::DaemonManager;

pub struct MacosManager;

const LAUNCHD_LABEL: &str = "ai.signet.daemon";

impl MacosManager {
    /// Check if a launchd plist exists for the signet daemon.
    fn launchd_plist_exists(&self) -> bool {
        let home = dirs::home_dir().unwrap_or_default();
        home.join("Library/LaunchAgents")
            .join(format!("{LAUNCHD_LABEL}.plist"))
            .exists()
    }

    /// Check if the launchd service is currently loaded.
    fn launchd_is_loaded(&self) -> bool {
        Command::new("launchctl")
            .args(["list", LAUNCHD_LABEL])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn find_bun(&self) -> Option<String> {
        let candidates = [
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
        ];

        for path in &candidates {
            if std::path::Path::new(path).exists() {
                return Some(path.to_string());
            }
        }

        // Check ~/.bun/bin/bun
        if let Some(home) = dirs::home_dir() {
            let bun_home = home.join(".bun/bin/bun");
            if bun_home.exists() {
                return Some(bun_home.to_string_lossy().to_string());
            }
        }

        // Fall back to PATH lookup
        Command::new("which")
            .arg("bun")
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
    }

    fn find_daemon_js(&self) -> Option<String> {
        let candidates = [
            // Homebrew global install
            "/opt/homebrew/lib/node_modules/signetai/dist/daemon.js",
        ];

        for path in &candidates {
            if std::path::Path::new(path).exists() {
                return Some(path.to_string());
            }
        }

        // Check ~/.bun/install/global/node_modules
        if let Some(home) = dirs::home_dir() {
            let bun_global = home.join(
                ".bun/install/global/node_modules/signetai/dist/daemon.js",
            );
            if bun_global.exists() {
                return Some(bun_global.to_string_lossy().to_string());
            }
        }

        None
    }

    fn find_signet_cli(&self) -> Option<String> {
        let candidates = [
            "/opt/homebrew/bin/signet",
            "/usr/local/bin/signet",
        ];

        for path in &candidates {
            if std::path::Path::new(path).exists() {
                return Some(path.to_string());
            }
        }

        Command::new("which")
            .arg("signet")
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
    }

    /// Check if a process is alive using kill(pid, 0).
    fn process_alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }
}

impl DaemonManager for MacosManager {
    fn start(&self) -> Result<(), Box<dyn std::error::Error>> {
        // If launchd plist exists, use launchctl
        if self.launchd_plist_exists() {
            let output = if self.launchd_is_loaded() {
                // Already loaded — kickstart it
                Command::new("launchctl")
                    .args(["kickstart", &format!("gui/{}/{LAUNCHD_LABEL}", unsafe {
                        libc::getuid()
                    })])
                    .output()?
            } else {
                // Bootstrap (load) the plist
                let home = dirs::home_dir().ok_or("no home dir")?;
                let plist = home
                    .join("Library/LaunchAgents")
                    .join(format!("{LAUNCHD_LABEL}.plist"));
                Command::new("launchctl")
                    .args(["load", &plist.to_string_lossy()])
                    .output()?
            };

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                // launchctl sometimes returns non-zero even when it works
                if !stderr.is_empty() {
                    eprintln!("launchctl warning: {stderr}");
                }
            }

            return Ok(());
        }

        // Try `signet daemon start` CLI first
        if let Some(signet) = self.find_signet_cli() {
            Command::new(&signet)
                .args(["daemon", "start"])
                .spawn()?;
            return Ok(());
        }

        // Direct bun fallback
        let bun = self
            .find_bun()
            .ok_or("bun not found — install bun to run signet daemon")?;

        // Try daemon.js directly
        if let Some(daemon_js) = self.find_daemon_js() {
            Command::new(&bun)
                .arg(&daemon_js)
                .spawn()?;
            return Ok(());
        }

        // Last resort: bunx
        Command::new(&bun)
            .args(["x", "signetai", "daemon", "start"])
            .spawn()?;

        Ok(())
    }

    fn stop(&self) -> Result<(), Box<dyn std::error::Error>> {
        // If launchd plist exists and is loaded, use launchctl
        if self.launchd_plist_exists() && self.launchd_is_loaded() {
            let home = dirs::home_dir().ok_or("no home dir")?;
            let plist = home
                .join("Library/LaunchAgents")
                .join(format!("{LAUNCHD_LABEL}.plist"));
            let output = Command::new("launchctl")
                .args(["unload", &plist.to_string_lossy()])
                .output()?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if !stderr.is_empty() {
                    eprintln!("launchctl unload warning: {stderr}");
                }
            }

            return Ok(());
        }

        // Direct process: read PID file, send SIGTERM
        let home = dirs::home_dir().ok_or("no home dir")?;
        let pid_path = home.join(".agents/.daemon/pid");

        if !pid_path.exists() {
            return Ok(()); // Already stopped
        }

        let pid_str = std::fs::read_to_string(&pid_path)?;
        let pid: i32 = pid_str.trim().parse()?;

        // Send SIGTERM
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }

        // Wait up to 3s for process to exit
        for _ in 0..30 {
            if !Self::process_alive(pid) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // Force kill if still alive
        if Self::process_alive(pid) {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        let _ = std::fs::remove_file(&pid_path);
        Ok(())
    }

    fn is_running(&self) -> bool {
        // Check launchd first
        if self.launchd_plist_exists() && self.launchd_is_loaded() {
            // Service is loaded — check if the PID is alive
            let home = match dirs::home_dir() {
                Some(h) => h,
                None => return false,
            };
            let pid_path = home.join(".agents/.daemon/pid");
            if let Ok(content) = std::fs::read_to_string(&pid_path) {
                if let Ok(pid) = content.trim().parse::<i32>() {
                    return Self::process_alive(pid);
                }
            }
            // Loaded but no PID file — could still be starting
            return true;
        }

        // Fall back to PID file check
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return false,
        };

        let pid_path = home.join(".agents/.daemon/pid");
        if !pid_path.exists() {
            return false;
        }

        match std::fs::read_to_string(&pid_path) {
            Ok(content) => {
                if let Ok(pid) = content.trim().parse::<i32>() {
                    Self::process_alive(pid)
                } else {
                    false
                }
            }
            Err(_) => false,
        }
    }
}
