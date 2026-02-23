use std::process::Command;

use super::DaemonManager;

pub struct LinuxManager;

impl LinuxManager {
    fn systemd_unit_exists(&self) -> bool {
        let home = dirs::home_dir().unwrap_or_default();
        home.join(".config/systemd/user/signet.service").exists()
    }

    fn find_bun(&self) -> Option<String> {
        // Check common locations
        let candidates = [
            "/usr/bin/bun",
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
        let home = dirs::home_dir()?;

        let candidates = [
            home.join(".bun/install/global/node_modules/signetai/dist/daemon.js"),
            // Local dev build
            home.join("signet/signetai/packages/daemon/dist/daemon.js"),
        ];

        for path in &candidates {
            if path.exists() {
                return Some(path.to_string_lossy().to_string());
            }
        }

        None
    }
}

impl DaemonManager for LinuxManager {
    fn start(&self) -> Result<(), Box<dyn std::error::Error>> {
        if self.systemd_unit_exists() {
            let output = Command::new("systemctl")
                .args(["--user", "start", "signet.service"])
                .output()?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("systemctl start failed: {stderr}").into());
            }

            return Ok(());
        }

        // Direct process fallback
        let bun = self
            .find_bun()
            .ok_or("bun not found — install bun to run signet daemon")?;

        // Try `signet-daemon` binary first (global install)
        if let Ok(output) = Command::new("which").arg("signet-daemon").output() {
            if output.status.success() {
                let bin = String::from_utf8_lossy(&output.stdout).trim().to_string();
                Command::new(&bun)
                    .arg(&bin)
                    .spawn()?;
                return Ok(());
            }
        }

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
        if self.systemd_unit_exists() {
            let output = Command::new("systemctl")
                .args(["--user", "stop", "signet.service"])
                .output()?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("systemctl stop failed: {stderr}").into());
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
            if !std::path::Path::new(&format!("/proc/{pid}")).exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        let _ = std::fs::remove_file(&pid_path);
        Ok(())
    }

    fn is_running(&self) -> bool {
        if self.systemd_unit_exists() {
            return Command::new("systemctl")
                .args(["--user", "is-active", "--quiet", "signet.service"])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
        }

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
                if let Ok(pid) = content.trim().parse::<u32>() {
                    std::path::Path::new(&format!("/proc/{pid}")).exists()
                } else {
                    false
                }
            }
            Err(_) => false,
        }
    }
}
