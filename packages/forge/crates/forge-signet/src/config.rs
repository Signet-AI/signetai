use forge_core::ForgeError;
use serde::Deserialize;
use std::path::PathBuf;
use tracing::{debug, info};

/// Signet agent.yaml configuration (subset relevant to Forge).
///
/// The agent.yaml controls FOUR separate model configurations:
///
/// 1. **Conversational model** — Forge's provider (NOT in agent.yaml, controlled by Forge CLI/picker)
/// 2. **Synthesis model** — memory.pipelineV2.synthesis.{provider,model} — used by the daemon's
///    summary worker to extract facts from transcripts after session-end
/// 3. **Extraction model** — memory.pipelineV2.extraction.{provider,model} — used by the daemon's
///    extraction worker for deeper fact/entity analysis (typically qwen3:4b via Ollama)
/// 4. **Embedding model** — embedding.{provider,model} — used to compute vector embeddings for
///    memory search (typically nomic-embed-text via Ollama or native WASM)
///
/// Forge NEVER directly calls models 2-4. The daemon handles all of that.
/// Forge only sends hook data (transcripts, prompts) and the daemon processes them
/// using its own configured models.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct AgentConfig {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub memory: Option<MemoryConfig>,
    #[serde(default)]
    pub embedding: Option<EmbeddingConfig>,
    // Flat keys written by dashboard (take precedence over nested)
    #[serde(default, rename = "extractionProvider")]
    pub extraction_provider_flat: Option<String>,
    #[serde(default, rename = "extractionModel")]
    pub extraction_model_flat: Option<String>,
    #[serde(default)]
    pub agents: Option<AgentsConfig>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct MemoryConfig {
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub session_budget: Option<usize>,
    #[serde(default)]
    pub decay_rate: Option<f64>,
    #[serde(default, rename = "pipelineV2")]
    pub pipeline_v2: Option<PipelineV2Config>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PipelineV2Config {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub extraction: Option<ExtractionConfig>,
    #[serde(default)]
    pub synthesis: Option<SynthesisConfig>,
}

/// Extraction model config — the daemon uses this, NOT the conversational model
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ExtractionConfig {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub strength: Option<String>,
    #[serde(default)]
    pub timeout: Option<u64>,
}

/// Synthesis model config — the daemon uses this for summary generation
#[derive(Debug, Clone, Deserialize, Default)]
pub struct SynthesisConfig {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// Embedding model config — daemon uses for vector search
#[derive(Debug, Clone, Deserialize, Default)]
pub struct EmbeddingConfig {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub dimensions: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AgentsConfig {
    #[serde(default)]
    pub list: Vec<AgentWorkspaceConfig>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AgentWorkspaceConfig {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default, alias = "workspacePath")]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

impl AgentConfig {
    /// Get the effective extraction provider (flat key takes precedence)
    pub fn extraction_provider(&self) -> Option<&str> {
        self.extraction_provider_flat
            .as_deref()
            .or_else(|| {
                self.memory
                    .as_ref()?
                    .pipeline_v2
                    .as_ref()?
                    .extraction
                    .as_ref()?
                    .provider
                    .as_deref()
            })
    }

    /// Get the effective extraction model (flat key takes precedence)
    pub fn extraction_model(&self) -> Option<&str> {
        self.extraction_model_flat
            .as_deref()
            .or_else(|| {
                self.memory
                    .as_ref()?
                    .pipeline_v2
                    .as_ref()?
                    .extraction
                    .as_ref()?
                    .model
                    .as_deref()
            })
    }

    /// Get the embedding provider
    pub fn embedding_provider(&self) -> Option<&str> {
        self.embedding.as_ref()?.provider.as_deref()
    }

    /// Get the embedding model
    pub fn embedding_model(&self) -> Option<&str> {
        self.embedding.as_ref()?.model.as_deref()
    }

    /// Summary of the extraction/embedding config for display
    pub fn pipeline_summary(&self) -> String {
        let ext_provider = self.extraction_provider().unwrap_or("ollama");
        let ext_model = self.extraction_model().unwrap_or("qwen3:4b");
        let emb_provider = self.embedding_provider().unwrap_or("native");
        let emb_model = self.embedding_model().unwrap_or("nomic-embed-text");

        format!(
            "extraction: {ext_model} ({ext_provider}) | embedding: {emb_model} ({emb_provider})"
        )
    }

    /// Resolve a configured agent profile by CLI name/ID (case-insensitive).
    pub fn find_agent_profile(&self, agent_name: &str) -> Option<&AgentWorkspaceConfig> {
        self.agents
            .as_ref()?
            .list
            .iter()
            .find(|entry| {
                entry
                    .id
                    .as_deref()
                    .map(|id| normalize_agent_id(id) == normalize_agent_id(agent_name))
                    .unwrap_or(false)
            })
    }
}

/// Load agent.yaml from the standard Signet location
pub fn load_agent_config() -> Result<AgentConfig, ForgeError> {
    let path = agent_yaml_path();
    debug!("Loading agent config from {}", path.display());

    if !path.exists() {
        info!(
            "No agent.yaml found at {} — using defaults",
            path.display()
        );
        return Ok(AgentConfig::default());
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| ForgeError::config(format!("Failed to read agent.yaml: {e}")))?;

    let config: AgentConfig = serde_yml::from_str(&content)
        .map_err(|e| ForgeError::config(format!("Failed to parse agent.yaml: {e}")))?;

    debug!("Loaded agent config: name={:?}", config.name);
    debug!(
        "Pipeline config: {}",
        config.pipeline_summary()
    );
    Ok(config)
}

/// Load an identity file (SOUL.md, IDENTITY.md, USER.md, AGENTS.md)
pub fn load_identity_file(name: &str) -> Option<String> {
    let path = agents_dir().join(name);
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            debug!("Loaded identity file: {name} ({} bytes)", content.len());
            Some(content)
        }
        Err(_) => {
            debug!("Identity file not found: {name}");
            None
        }
    }
}

/// Extract the agent name from IDENTITY.md (looks for **name:** or name: field)
pub fn agent_name() -> String {
    load_identity_file("IDENTITY.md")
        .and_then(|content| {
            for line in content.lines() {
                let trimmed = line.trim();
                // Match "**name:** Boogy" or "name: Boogy"
                if let Some(rest) = trimmed.strip_prefix("**name:**") {
                    return Some(rest.trim().to_string());
                }
                if let Some(rest) = trimmed.strip_prefix("name:") {
                    return Some(rest.trim().to_string());
                }
            }
            None
        })
        .unwrap_or_else(|| "Assistant".to_string())
}

/// Get the agent_id for daemon API calls.
/// Returns the agent name lowercased, or "default" if no name is found.
pub fn agent_id() -> String {
    let name = agent_name();
    if name == "Assistant" {
        "default".to_string()
    } else {
        name.to_lowercase()
    }
}

/// Load identity files for a specific named agent.
/// Checks `~/.agents/agents/{name}/` first, falls back to root `~/.agents/`.
pub fn load_agent_identity_files(agent_name: &str) -> Vec<(String, String)> {
    let cfg = load_agent_config().ok();
    let agent_dir = resolve_agent_workspace_path(agent_name, cfg.as_ref());
    let root_dir = agents_dir();
    let files = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md"];
    let mut loaded = Vec::new();

    for name in &files {
        let agent_path = agent_dir.join(name);
        let root_path = root_dir.join(name);

        let content = if agent_path.exists() {
            debug!(
                "Loading per-agent identity file: {}/{}",
                agent_name, name
            );
            std::fs::read_to_string(&agent_path).ok()
        } else if root_path.exists() {
            debug!(
                "Falling back to root identity file: {}",
                name
            );
            std::fs::read_to_string(&root_path).ok()
        } else {
            None
        };

        if let Some(text) = content {
            loaded.push((name.to_string(), text));
        }
    }

    loaded
}

/// Build the system prompt from per-agent identity files (with root fallback)
pub fn build_agent_identity_prompt(agent_name: &str) -> String {
    let files = load_agent_identity_files(agent_name);
    let mut parts = Vec::new();

    for (name, content) in &files {
        let section = match name.as_str() {
            "AGENTS.md" => "Agent Instructions",
            "SOUL.md" => "Soul",
            "IDENTITY.md" => "Identity",
            "USER.md" => "About Your User",
            _ => continue,
        };
        parts.push(format!("## {section}\n\n{content}"));
    }

    parts.join("\n\n")
}

/// Build the system prompt from Signet identity files
pub fn build_identity_prompt() -> String {
    let mut parts = Vec::new();

    if let Some(agents) = load_identity_file("AGENTS.md") {
        parts.push(format!("## Agent Instructions\n\n{agents}"));
    }

    if let Some(soul) = load_identity_file("SOUL.md") {
        parts.push(format!("## Soul\n\n{soul}"));
    }

    if let Some(identity) = load_identity_file("IDENTITY.md") {
        parts.push(format!("## Identity\n\n{identity}"));
    }

    if let Some(user) = load_identity_file("USER.md") {
        parts.push(format!("## About Your User\n\n{user}"));
    }

    parts.join("\n\n")
}

/// Normalize user-supplied agent IDs into stable daemon keys.
pub fn normalize_agent_id(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "default".to_string();
    }
    trimmed.to_lowercase()
}

/// Resolve the workspace path for a named agent.
///
/// Priority:
/// 1) `agent.yaml -> agents.list[].workspace_path` (matching id)
/// 2) default `~/.agents/agents/<agent>`
pub fn resolve_agent_workspace_path(agent_name: &str, cfg: Option<&AgentConfig>) -> PathBuf {
    if let Some(profile) = cfg.and_then(|c| c.find_agent_profile(agent_name)) {
        if let Some(raw) = profile.workspace_path.as_deref() {
            let expanded = expand_home(raw);
            return if expanded.is_absolute() {
                expanded
            } else {
                agents_dir().join(expanded)
            };
        }
    }
    agents_dir().join("agents").join(agent_name)
}

/// Ensure a named-agent workspace exists and contains Phase A scaffold files.
///
/// Files created if missing:
/// - AGENTS.md
/// - SOUL.md
/// - IDENTITY.md
/// - MEMORY.md
pub fn ensure_agent_workspace_scaffold(
    agent_name: &str,
    cfg: Option<&AgentConfig>,
) -> Result<PathBuf, ForgeError> {
    let dir = resolve_agent_workspace_path(agent_name, cfg);
    std::fs::create_dir_all(&dir)
        .map_err(|e| ForgeError::config(format!("Failed to create agent workspace {}: {e}", dir.display())))?;

    ensure_scaffold_file(&dir, "AGENTS.md", "## Agent Instructions\n\n")?;
    ensure_scaffold_file(&dir, "SOUL.md", "## Soul\n\n")?;
    ensure_scaffold_file(
        &dir,
        "IDENTITY.md",
        &format!("name: {agent_name}\nrole: assistant\n"),
    )?;
    ensure_scaffold_file(&dir, "MEMORY.md", "# Working Memory\n\n")?;

    Ok(dir)
}

/// Extract display name from IDENTITY.md in the named-agent workspace,
/// falling back to root workspace, then "Assistant".
pub fn agent_name_for(selected_agent: Option<&str>, cfg: Option<&AgentConfig>) -> String {
    if let Some(agent_name) = selected_agent {
        let dir = resolve_agent_workspace_path(agent_name, cfg);
        if let Some(identity) = std::fs::read_to_string(dir.join("IDENTITY.md")).ok() {
            if let Some(name) = extract_identity_name(&identity) {
                return name;
            }
        }
    }
    agent_name()
}

/// Path to ~/.agents/agent.yaml
pub fn agent_yaml_path() -> PathBuf {
    agents_dir().join("agent.yaml")
}

/// Path to ~/.agents/
pub fn agents_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agents")
}

fn ensure_scaffold_file(dir: &std::path::Path, name: &str, fallback_content: &str) -> Result<(), ForgeError> {
    let path = dir.join(name);
    if path.exists() {
        return Ok(());
    }

    let root_fallback = agents_dir().join(name);
    let content = std::fs::read_to_string(&root_fallback).unwrap_or_else(|_| fallback_content.to_string());
    std::fs::write(&path, content)
        .map_err(|e| ForgeError::config(format!("Failed to write scaffold file {}: {e}", path.display())))
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(rest);
    }
    PathBuf::from(path)
}

fn extract_identity_name(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("**name:**") {
            return Some(rest.trim().to_string());
        }
        if let Some(rest) = trimmed.strip_prefix("name:") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_agent_id, resolve_agent_workspace_path, AgentConfig, AgentsConfig,
        AgentWorkspaceConfig,
    };

    #[test]
    fn normalize_agent_id_trims_and_lowercases() {
        assert_eq!(normalize_agent_id("  RESEARCH "), "research");
        assert_eq!(normalize_agent_id(""), "default");
    }

    #[test]
    fn resolve_workspace_prefers_configured_path() {
        let cfg = AgentConfig {
            agents: Some(AgentsConfig {
                list: vec![AgentWorkspaceConfig {
                    id: Some("Research".to_string()),
                    workspace_path: Some("agents/research-box".to_string()),
                    model: None,
                }],
            }),
            ..Default::default()
        };

        let path = resolve_agent_workspace_path("research", Some(&cfg));
        assert!(path.ends_with("agents/research-box"));
    }
}
