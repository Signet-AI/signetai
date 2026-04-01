use forge_core::{
    PolicyBlockReason, absolutize_path, classify_command_block_reason, classify_path_block_reason,
    expand_home_path, normalize_path, normalize_with_ancestor_fallback,
};
use std::path::PathBuf;

/// Workspace policy derived from Forge runtime env vars.
#[derive(Debug, Clone, Default)]
pub struct WorkspacePolicy {
    pub workspace_only: bool,
    pub workspace_root: PathBuf,
    pub allowed_paths: Vec<PathBuf>,
    pub allowed_commands: Vec<String>,
}

impl WorkspacePolicy {
    pub fn from_env() -> Self {
        let workspace_only = std::env::var("FORGE_WORKSPACE_ONLY")
            .ok()
            .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or(true);

        let workspace_root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

        let allowed_paths = std::env::var("FORGE_ALLOWED_PATHS")
            .ok()
            .map(|raw| {
                raw.split(':')
                    .filter(|s| !s.trim().is_empty())
                    .map(expand_home_path)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let allowed_commands = std::env::var("FORGE_ALLOWED_COMMANDS")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .filter_map(|s| {
                        let t = s.trim().to_lowercase();
                        if t.is_empty() { None } else { Some(t) }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        Self {
            workspace_only,
            workspace_root,
            allowed_paths,
            allowed_commands,
        }
    }

    pub fn is_command_allowed(&self, command: &str) -> Result<(), String> {
        if let Some(reason) = self.command_block_reason(command) {
            return Err(format!(
                "Command rejected by policy ({}){}",
                reason.code(),
                if self.allowed_commands.is_empty() {
                    String::new()
                } else {
                    format!(". Allowed commands: {}", self.allowed_commands.join(", "))
                }
            ));
        }
        Ok(())
    }

    pub fn ensure_path_allowed(&self, raw_path: &str) -> Result<PathBuf, String> {
        let abs = absolutize_path(raw_path, &self.workspace_root);
        let normalized = normalize_with_ancestor_fallback(&abs);
        if let Some(reason) = self.path_block_reason_for_normalized(&normalized) {
            return Err(format!(
                "Path '{}' rejected by policy ({})",
                normalized.display(),
                reason.code()
            ));
        }
        Ok(normalized)
    }

    pub fn command_block_reason(&self, command: &str) -> Option<PolicyBlockReason> {
        classify_command_block_reason(command, &self.allowed_commands)
    }

    pub fn path_block_reason(&self, raw_path: &str) -> Option<PolicyBlockReason> {
        let abs = absolutize_path(raw_path, &self.workspace_root);
        let normalized = normalize_with_ancestor_fallback(&abs);
        self.path_block_reason_for_normalized(&normalized)
    }

    fn path_block_reason_for_normalized(&self, normalized: &std::path::Path) -> Option<PolicyBlockReason> {
        let allowed = self
            .allowed_paths
            .iter()
            .map(|p| normalize_path(p.as_path()))
            .collect::<Vec<_>>();
        let workspace = normalize_with_ancestor_fallback(&self.workspace_root);
        classify_path_block_reason(normalized, &workspace, self.workspace_only, &allowed)
    }
}

#[cfg(test)]
mod tests {
    use super::WorkspacePolicy;
    use std::path::PathBuf;

    #[test]
    fn command_allowlist_blocks_unknown_commands() {
        let policy = WorkspacePolicy {
            allowed_commands: vec!["git".into(), "ls".into()],
            ..Default::default()
        };
        assert!(policy.is_command_allowed("git status").is_ok());
        assert!(policy.is_command_allowed("rm -rf /").is_err());
    }

    #[test]
    fn workspace_policy_blocks_outside_paths() {
        let policy = WorkspacePolicy {
            workspace_only: true,
            workspace_root: PathBuf::from("/tmp/work"),
            allowed_paths: vec![],
            allowed_commands: vec![],
        };
        assert!(policy.ensure_path_allowed("/tmp/work/a.txt").is_ok());
        assert!(policy.ensure_path_allowed("/etc/passwd").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_policy_blocks_symlink_parent_escape_for_new_files() {
        use std::fs::{create_dir_all, remove_dir_all};
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!("forge-policy-{}", std::process::id()));
        let _ = remove_dir_all(&base);
        let workspace = base.join("workspace");
        let outside = base.join("outside");
        create_dir_all(&workspace).unwrap();
        create_dir_all(&outside).unwrap();

        let link = workspace.join("escape");
        symlink(&outside, &link).unwrap();

        let policy = WorkspacePolicy {
            workspace_only: true,
            workspace_root: workspace.clone(),
            allowed_paths: vec![],
            allowed_commands: vec![],
        };

        // This path lexically looks inside workspace, but parent symlink points outside.
        let escaped = link.join("new.txt");
        assert!(policy.ensure_path_allowed(&escaped.display().to_string()).is_err());

        let _ = remove_dir_all(&base);
    }
}
