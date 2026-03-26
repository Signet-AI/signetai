use crate::config::{agent_yaml_path, load_agent_config, AgentConfig};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tracing::{debug, error, info};

/// Events emitted when agent.yaml changes
#[derive(Debug, Clone)]
pub enum ConfigEvent {
    /// The config was reloaded successfully
    Reloaded(Box<AgentConfig>),
    /// Config reload failed
    Error(String),
}

/// Watches ~/.agents/agent.yaml for changes and emits ConfigEvents.
///
/// This enables Forge to react in real-time when the user or dashboard
/// modifies extraction models, embedding config, or other settings.
pub struct ConfigWatcher {
    _watcher: RecommendedWatcher,
}

impl ConfigWatcher {
    /// Start watching agent.yaml. Returns a receiver for config change events.
    pub fn start() -> Result<(Self, mpsc::Receiver<ConfigEvent>), String> {
        let (tx, rx) = mpsc::channel::<ConfigEvent>(16);
        let path = agent_yaml_path();

        let watch_dir = path
            .parent()
            .ok_or_else(|| "Cannot determine agent.yaml parent directory".to_string())?
            .to_path_buf();

        let target_filename = path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| "agent.yaml".to_string());

        info!("Watching {} for changes", path.display());

        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            match res {
                Ok(event) => {
                    // Only react to write/modify events on agent.yaml
                    let is_relevant = matches!(
                        event.kind,
                        EventKind::Modify(_) | EventKind::Create(_)
                    ) && event.paths.iter().any(|p| {
                        p.file_name()
                            .map(|f| f.to_string_lossy().contains(&target_filename))
                            .unwrap_or(false)
                    });

                    if !is_relevant {
                        return;
                    }

                    debug!("agent.yaml changed, reloading config");

                    match load_agent_config() {
                        Ok(config) => {
                            info!(
                                "Config reloaded: {}",
                                config.pipeline_summary()
                            );
                            let _ = tx.blocking_send(ConfigEvent::Reloaded(Box::new(config)));
                        }
                        Err(e) => {
                            error!("Failed to reload agent.yaml: {e}");
                            let _ = tx.blocking_send(ConfigEvent::Error(e.to_string()));
                        }
                    }
                }
                Err(e) => {
                    error!("File watcher error: {e}");
                }
            }
        })
        .map_err(|e| format!("Failed to create file watcher: {e}"))?;

        watcher
            .watch(&watch_dir, RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch {}: {e}", watch_dir.display()))?;

        Ok((Self { _watcher: watcher }, rx))
    }
}
