use std::path::PathBuf;
use std::sync::Arc;

use axum::{Json, extract::State};
use serde_json::json;

use crate::state::AppState;

const FORGE_PRIMARY_MARKER: &str = "Signet's native AI terminal";
const FORGE_FALLBACK_MARKERS: &[&str] = &[
    "Signet daemon URL",
    "SIGNET_TOKEN",
    "signet-token",
    "signet-dark",
    "Starting Signet daemon",
    "Signet provides memory, identity, and extraction for Forge",
];
const FORGE_COMPAT_MARKER_GROUPS: &[&[&str]] = &[
    &[
        FORGE_PRIMARY_MARKER,
        "Forge — First Run",
        "Forge — Provider auth needed",
        "Forge TUI starting — model:",
    ],
    &[
        "FORGE_SIGNET_TOKEN",
        "SIGNET_AUTH_TOKEN",
        "SIGNET_TOKEN",
        "Signet daemon URL",
        "Signet provides memory, identity, and extraction for Forge",
    ],
    &[
        "signet-dark",
        "Dashboard (Ctrl+D)",
        "/forge-usage",
        "Switch theme (signet-dark, signet-light, midnight, amber)",
        "Open main dashboard in browser",
    ],
];

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn binary_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn signet_managed_forge_path(home: &std::path::Path) -> PathBuf {
    home.join(".config").join("signet").join("bin").join(binary_name("forge"))
}

fn workspace_forge_candidate_paths(agents_dir: &std::path::Path) -> Vec<PathBuf> {
    let binary = binary_name("forge");
    vec![
        agents_dir.join(&binary),
        agents_dir.join("target").join("release").join(&binary),
        agents_dir.join("target").join("debug").join(&binary),
        agents_dir
            .join("packages")
            .join("forge")
            .join("target")
            .join("release")
            .join(&binary),
        agents_dir
            .join("packages")
            .join("forge")
            .join("target")
            .join("debug")
            .join(&binary),
    ]
}

fn forge_candidate_paths(home: &std::path::Path, agents_dir: &std::path::Path) -> Vec<PathBuf> {
    let binary = binary_name("forge");
    let mut paths = workspace_forge_candidate_paths(agents_dir);
    paths.extend([
        signet_managed_forge_path(home),
        home.join(".cargo").join("bin").join(&binary),
        home.join(".local").join("bin").join(&binary),
        PathBuf::from("/usr/local/bin").join(&binary),
        PathBuf::from("/opt/homebrew/bin").join(&binary),
    ]);

    // Read install record from the global managed location, matching
    // the CLI install path (~/.config/signet/bin/.forge-install.json).
    let record_path = home
        .join(".config")
        .join("signet")
        .join("bin")
        .join(".forge-install.json");
    if let Ok(raw) = std::fs::read_to_string(&record_path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(path_str) = value.get("binaryPath").and_then(|v| v.as_str()) {
                let candidate = PathBuf::from(path_str);
                if candidate.is_absolute() {
                    if let Ok(resolved) = candidate.canonicalize() {
                        paths.insert(0, resolved);
                    }
                }
            }
        }
    }

    let mut deduped = Vec::with_capacity(paths.len());
    for candidate in paths {
        if !deduped.contains(&candidate) {
            deduped.push(candidate);
        }
    }

    deduped
}

fn is_executable_file(path: &std::path::Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(windows)]
    {
        true
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        (metadata.permissions().mode() & 0o111) != 0
    }
}

fn is_signet_forge_binary(path: &std::path::Path) -> bool {
    if !is_executable_file(path) {
        return false;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    if bytes.windows(FORGE_PRIMARY_MARKER.len()).any(|w| w == FORGE_PRIMARY_MARKER.as_bytes()) {
        return true;
    }
    let matches = FORGE_FALLBACK_MARKERS
        .iter()
        .filter(|marker| bytes.windows(marker.len()).any(|w| w == marker.as_bytes()))
        .count();
    matches >= 2
}

fn is_compatible_forge_binary(path: &std::path::Path) -> bool {
    if !is_executable_file(path) {
        return false;
    }
    if is_signet_forge_binary(path) {
        return true;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    FORGE_COMPAT_MARKER_GROUPS.iter().all(|group| {
        group.iter().any(|marker| {
            bytes.windows(marker.len())
                .any(|w| w == marker.as_bytes())
        })
    })
}

fn find_signet_forge_binary_with_home(
    home: &std::path::Path,
    agents_dir: &std::path::Path,
) -> Option<PathBuf> {
    for candidate in forge_candidate_paths(home, agents_dir) {
        if candidate.exists() && is_compatible_forge_binary(&candidate) {
            return Some(candidate);
        }
    }

    let lookup = if cfg!(windows) { "where" } else { "which" };
    let Ok(output) = std::process::Command::new(lookup).arg("forge").output() else {
        return None;
    };
    if !output.status.success() {
        return None;
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let candidate = PathBuf::from(line.trim());
        if candidate.exists() && is_compatible_forge_binary(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn find_signet_forge_binary(agents_dir: &std::path::Path) -> Option<PathBuf> {
    find_signet_forge_binary_with_home(&home_dir(), agents_dir)
}

fn resolve_safe_agents_dir(base_path: &std::path::Path) -> Option<PathBuf> {
    base_path.canonicalize().ok()
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let home = home_dir();
    let safe_agents_dir = resolve_safe_agents_dir(&state.config.base_path);
    let openclaw_path = safe_agents_dir
        .as_ref()
        .map(|dir| dir.join("AGENTS.md"))
        .unwrap_or_else(|| state.config.base_path.join("AGENTS.md"));
    let openclaw_exists = safe_agents_dir
        .as_ref()
        .map(|dir| dir.join("AGENTS.md").exists())
        .unwrap_or(false);
    let verified_forge_path = safe_agents_dir
        .as_ref()
        .and_then(|dir| find_signet_forge_binary(dir));
    let forge_path = verified_forge_path
        .clone()
        .unwrap_or_else(|| signet_managed_forge_path(&home));
    let forge_exists = verified_forge_path.is_some();
    let claude_last_seen = state.harness_last_seen("claude-code").await;
    let opencode_last_seen = state.harness_last_seen("opencode").await;
    let openclaw_last_seen = state.harness_last_seen("openclaw").await;
    let forge_last_seen = state.harness_last_seen("forge").await;

    let harnesses = vec![
        json!({
            "name": "Claude Code",
            "id": "claude-code",
            "path": home.join(".claude").join("settings.json"),
            "exists": home.join(".claude").join("settings.json").exists(),
            "lastSeen": claude_last_seen,
        }),
        json!({
            "name": "OpenCode",
            "id": "opencode",
            "path": home.join(".config").join("opencode").join("AGENTS.md"),
            "exists": home.join(".config").join("opencode").join("AGENTS.md").exists(),
            "lastSeen": opencode_last_seen,
        }),
        json!({
            "name": "OpenClaw",
            "id": "openclaw",
            "path": openclaw_path,
            "exists": openclaw_exists,
            "lastSeen": openclaw_last_seen,
        }),
        json!({
            "name": "Forge",
            "id": "forge",
            "path": forge_path,
            "exists": forge_exists,
            "lastSeen": forge_last_seen,
        }),
    ];

    Json(json!({ "harnesses": harnesses }))
}

#[cfg(test)]
mod tests {
    use super::find_signet_forge_binary_with_home;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    #[test]
    fn detects_workspace_local_forge_builds_before_path_lookup() {
        let home = tempdir().unwrap();
        let workspace = tempdir().unwrap();

        let binary = workspace
            .path()
            .join("packages")
            .join("forge")
            .join("target")
            .join("release")
            .join("forge");
        fs::create_dir_all(binary.parent().unwrap()).unwrap();
        fs::write(
            &binary,
            "Forge — First Run\nFORGE_SIGNET_TOKEN\nDashboard (Ctrl+D)\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            let mut perms = fs::metadata(&binary).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&binary, perms).unwrap();
        }

        assert_eq!(
            find_signet_forge_binary_with_home(home.path(), workspace.path()),
            Some(binary)
        );
    }
}
