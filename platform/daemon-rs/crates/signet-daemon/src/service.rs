//! System service install/uninstall for systemd (Linux) and launchd (macOS).

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use anyhow::{Context, Result};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            eprintln!(
                "warning: neither HOME nor USERPROFILE is set; falling back to current directory"
            );
            PathBuf::from(".")
        })
}

fn agents_dir() -> PathBuf {
    std::env::var("SIGNET_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".agents"))
}

fn log_dir() -> PathBuf {
    agents_dir().join(".daemon").join("logs")
}

fn launchd_plist() -> PathBuf {
    home()
        .join("Library")
        .join("LaunchAgents")
        .join("ai.signet.daemon.plist")
}

fn systemd_unit() -> PathBuf {
    home()
        .join(".config")
        .join("systemd")
        .join("user")
        .join("signet.service")
}

/// Resolve the path to the currently-running binary.
fn binary_path() -> Result<PathBuf> {
    std::env::current_exe().context("cannot resolve binary path")
}

// ---------------------------------------------------------------------------
// systemd
// ---------------------------------------------------------------------------

fn systemd_contents(port: u16) -> Result<String> {
    let bin = binary_path()?;
    let agents = agents_dir();
    let logs = log_dir();

    Ok(format!(
        "[Unit]\n\
         Description=Signet Daemon\n\
         After=network.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={bin}\n\
         Environment=SIGNET_PORT={port}\n\
         Environment=SIGNET_PATH={agents}\n\
         WorkingDirectory={agents}\n\
         Restart=always\n\
         RestartSec=5\n\
         \n\
         StandardOutput=append:{logs}/daemon.out.log\n\
         StandardError=append:{logs}/daemon.err.log\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        bin = bin.display(),
        agents = agents.display(),
        logs = logs.display(),
    ))
}

fn install_systemd(port: u16) -> Result<()> {
    let unit = systemd_unit();
    let dir = unit.parent().unwrap();
    fs::create_dir_all(dir)?;
    fs::create_dir_all(log_dir())?;

    // Stop if running
    let _ = Command::new("systemctl")
        .args(["--user", "stop", "signet.service"])
        .output();

    fs::write(&unit, systemd_contents(port)?)?;

    Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status()
        .context("systemctl daemon-reload")?;

    Command::new("systemctl")
        .args(["--user", "enable", "signet.service"])
        .status()
        .context("systemctl enable")?;

    Command::new("systemctl")
        .args(["--user", "start", "signet.service"])
        .status()
        .context("systemctl start")?;

    Ok(())
}

fn uninstall_systemd() -> Result<()> {
    let _ = Command::new("systemctl")
        .args(["--user", "stop", "signet.service"])
        .output();
    let _ = Command::new("systemctl")
        .args(["--user", "disable", "signet.service"])
        .output();

    let unit = systemd_unit();
    if unit.exists() {
        fs::remove_file(&unit)?;
    }

    let _ = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output();

    Ok(())
}

fn is_systemd_running() -> bool {
    Command::new("systemctl")
        .args(["--user", "is-active", "signet.service"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "active")
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// launchd
// ---------------------------------------------------------------------------

fn launchd_contents(port: u16) -> Result<String> {
    let bin = binary_path()?;
    let agents = agents_dir();
    let logs = log_dir();

    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.signet.daemon</string>

    <key>ProgramArguments</key>
    <array>
        <string>{bin}</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>SIGNET_PORT</key>
        <string>{port}</string>
        <key>SIGNET_PATH</key>
        <string>{agents}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>{logs}/daemon.out.log</string>

    <key>StandardErrorPath</key>
    <string>{logs}/daemon.err.log</string>

    <key>WorkingDirectory</key>
    <string>{agents}</string>
</dict>
</plist>"#,
        bin = bin.display(),
        agents = agents.display(),
        logs = logs.display(),
    ))
}

fn install_launchd(port: u16) -> Result<()> {
    let plist = launchd_plist();
    let dir = plist.parent().unwrap();
    fs::create_dir_all(dir)?;
    fs::create_dir_all(log_dir())?;

    let _ = Command::new("launchctl")
        .args(["unload", &plist.to_string_lossy()])
        .output();

    if cfg!(target_os = "macos") {
        let bin = binary_path()?;
        let _ = Command::new("/usr/bin/codesign")
            .args(["-s", "-", "--force", "--identifier", "ai.signet.daemon"])
            .arg(&bin)
            .output();
    }

    fs::write(&plist, launchd_contents(port)?)?;

    Command::new("launchctl")
        .args(["load", &plist.to_string_lossy()])
        .status()
        .context("launchctl load")?;

    Ok(())
}

fn uninstall_launchd() -> Result<()> {
    let plist = launchd_plist();

    if plist.exists() {
        let _ = Command::new("launchctl")
            .args(["unload", &plist.to_string_lossy()])
            .output();
        fs::remove_file(&plist)?;
    }

    Ok(())
}

fn is_launchd_running() -> bool {
    Command::new("launchctl")
        .args(["list", "ai.signet.daemon"])
        .output()
        .map(|o| {
            let out = String::from_utf8_lossy(&o.stdout);
            o.status.success() && !out.contains("Could not find")
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Install the daemon as a user-level system service.
pub fn install(port: u16) -> Result<()> {
    if cfg!(target_os = "macos") {
        install_launchd(port)
    } else if cfg!(target_os = "linux") {
        install_systemd(port)
    } else {
        // Windows: no system service manager integration yet;
        // the TS daemon layer handles start-on-demand via startDirect().
        Ok(())
    }
}

/// Uninstall the daemon system service.
pub fn uninstall() -> Result<()> {
    if cfg!(target_os = "macos") {
        uninstall_launchd()
    } else if cfg!(target_os = "linux") {
        uninstall_systemd()
    } else {
        Ok(())
    }
}

/// Check whether the service is currently running.
pub fn is_running() -> bool {
    if cfg!(target_os = "macos") {
        is_launchd_running()
    } else if cfg!(target_os = "linux") {
        is_systemd_running()
    } else {
        false
    }
}

/// Check whether the service unit file is installed.
pub fn is_installed() -> bool {
    if cfg!(target_os = "macos") {
        launchd_plist().exists()
    } else if cfg!(target_os = "linux") {
        systemd_unit().exists()
    } else {
        false
    }
}
