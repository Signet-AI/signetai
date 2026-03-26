//! Plugin system for loading third-party tools from executable files.
//!
//! Plugins are discovered from `~/.config/forge/plugins/`. Each plugin is an
//! executable (script or binary) that follows a simple protocol:
//!
//! - `plugin --manifest` → prints JSON tool definition to stdout
//! - `plugin --execute <json_input>` → runs the tool and prints result to stdout
//!
//! ## Manifest format
//!
//! ```json
//! {
//!   "name": "my-tool",
//!   "description": "Does something useful",
//!   "input_schema": { "type": "object", "properties": { ... } },
//!   "permission": "read"
//! }
//! ```

use crate::Tool;
use async_trait::async_trait;
use forge_core::{ToolCall, ToolDefinition, ToolPermission, ToolResult};
use serde::Deserialize;
use std::path::PathBuf;
use tokio::process::Command;
use tracing::{debug, warn};

/// A plugin tool loaded from an external executable.
pub struct PluginTool {
    /// Display name (from manifest)
    name: String,
    /// Tool definition for the LLM
    definition: ToolDefinition,
    /// Permission level
    permission: ToolPermission,
    /// Path to the plugin executable
    path: PathBuf,
}

/// JSON manifest returned by `plugin --manifest`
#[derive(Debug, Deserialize)]
struct PluginManifest {
    name: String,
    description: String,
    input_schema: serde_json::Value,
    /// Permission level: "read", "write", or "dangerous". Defaults to "write".
    #[serde(default = "default_permission_str")]
    permission: String,
}

fn default_permission_str() -> String {
    "write".to_string()
}

impl PluginManifest {
    fn to_permission(&self) -> ToolPermission {
        match self.permission.as_str() {
            "read" | "readonly" => ToolPermission::ReadOnly,
            "dangerous" => ToolPermission::Dangerous,
            _ => ToolPermission::Write,
        }
    }
}

impl PluginTool {
    /// The default directory where plugins are discovered.
    pub fn plugin_dir() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("forge")
            .join("plugins")
    }

    /// Discover all valid plugins from the plugin directory.
    ///
    /// Scans `~/.config/forge/plugins/` for executable files, runs each with
    /// `--manifest`, and parses the JSON output into a `PluginTool`.
    /// Invalid or non-responding plugins are silently skipped.
    pub async fn discover() -> Vec<Self> {
        let plugin_dir = Self::plugin_dir();
        if !plugin_dir.exists() {
            debug!("Plugin directory does not exist: {}", plugin_dir.display());
            return Vec::new();
        }

        let entries = match std::fs::read_dir(&plugin_dir) {
            Ok(e) => e,
            Err(e) => {
                warn!("Failed to read plugin directory: {e}");
                return Vec::new();
            }
        };

        let mut plugins = Vec::new();

        for entry in entries.flatten() {
            let path = entry.path();

            // Skip directories and non-executable files
            if path.is_dir() {
                continue;
            }

            // On Unix, check executable bit
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = path.metadata() {
                    if meta.permissions().mode() & 0o111 == 0 {
                        continue;
                    }
                }
            }

            // Try to load manifest
            match Self::load_manifest(&path).await {
                Ok(plugin) => {
                    debug!("Loaded plugin: {} from {}", plugin.name, path.display());
                    plugins.push(plugin);
                }
                Err(e) => {
                    warn!(
                        "Failed to load plugin manifest from {}: {e}",
                        path.display()
                    );
                }
            }
        }

        plugins
    }

    /// Run `plugin --manifest` and parse the JSON output.
    async fn load_manifest(path: &PathBuf) -> Result<Self, String> {
        let output = Command::new(path)
            .arg("--manifest")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn: {e}"))?;

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            output.wait_with_output(),
        )
        .await
        .map_err(|_| "Plugin manifest timed out (5s)".to_string())?
        .map_err(|e| format!("Failed to run: {e}"))?;

        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            return Err(format!(
                "Plugin exited with code {}: {stderr}",
                result.status.code().unwrap_or(-1)
            ));
        }

        let stdout = String::from_utf8_lossy(&result.stdout);
        let manifest: PluginManifest =
            serde_json::from_str(&stdout).map_err(|e| format!("Invalid manifest JSON: {e}"))?;

        let permission = manifest.to_permission();

        Ok(PluginTool {
            name: manifest.name.clone(),
            definition: ToolDefinition {
                name: manifest.name,
                description: manifest.description,
                input_schema: manifest.input_schema,
            },
            permission,
            path: path.clone(),
        })
    }
}

#[async_trait]
impl Tool for PluginTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn permission(&self) -> ToolPermission {
        self.permission
    }

    async fn execute(&self, call: &ToolCall) -> ToolResult {
        let input_json = match serde_json::to_string(&call.input) {
            Ok(j) => j,
            Err(e) => {
                return ToolResult::error(&call.id, format!("Failed to serialize input: {e}"))
            }
        };

        debug!(
            "Executing plugin {} with input: {}",
            self.name,
            &input_json[..input_json.len().min(200)]
        );

        let child = match Command::new(&self.path)
            .arg("--execute")
            .arg(&input_json)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                return ToolResult::error(
                    &call.id,
                    format!("Failed to spawn plugin {}: {e}", self.name),
                )
            }
        };

        // 2 minute timeout for plugin execution
        let timeout = std::time::Duration::from_secs(120);

        match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();

                if output.status.success() {
                    if stdout.is_empty() && !stderr.is_empty() {
                        // Some plugins write to stderr for info
                        ToolResult::success(&call.id, stderr)
                    } else {
                        ToolResult::success(&call.id, stdout)
                    }
                } else {
                    let code = output.status.code().unwrap_or(-1);
                    let mut msg = format!("Plugin {} exited with code {code}", self.name);
                    if !stdout.is_empty() {
                        msg.push('\n');
                        msg.push_str(&stdout);
                    }
                    if !stderr.is_empty() {
                        msg.push('\n');
                        msg.push_str(&stderr);
                    }
                    ToolResult::error(&call.id, msg)
                }
            }
            Ok(Err(e)) => ToolResult::error(
                &call.id,
                format!("Failed to execute plugin {}: {e}", self.name),
            ),
            Err(_) => ToolResult::error(
                &call.id,
                format!("Plugin {} timed out after 120s", self.name),
            ),
        }
    }
}
