use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::constants::{DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_HYBRID_ALPHA, DEFAULT_PORT};

// ---------------------------------------------------------------------------
// Daemon runtime config (resolved from env + agent.yaml)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct DaemonConfig {
    pub base_path: PathBuf,
    pub db_path: PathBuf,
    pub port: u16,
    pub host: String,
    pub bind: Option<String>,
    pub manifest: AgentManifest,
}

impl DaemonConfig {
    pub fn from_env() -> Result<Self, String> {
        let base = std::env::var("SIGNET_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs_home().join(".agents"));

        let manifest = match load_manifest(&base) {
            Ok(Some(manifest)) => manifest,
            Ok(None) => AgentManifest::default(),
            Err(ManifestLoadError::Fatal(error)) => {
                return Err(format!("Invalid agent.yaml: {error}"));
            }
            Err(ManifestLoadError::Recoverable(error)) => {
                tracing::warn!(
                    error = %error,
                    "invalid or unreadable agent.yaml; falling back to default manifest"
                );
                AgentManifest::default()
            }
        };
        let (cfg_host, cfg_bind) = resolve_network_binding(
            manifest
                .network
                .as_ref()
                .and_then(|network| network.mode.as_deref()),
        );
        let db = base.join("memory").join("memories.db");
        let port = std::env::var("SIGNET_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_PORT);
        let host_env = std::env::var("SIGNET_HOST").ok();
        let host_from_env = host_env.is_some();
        let bind_env = std::env::var("SIGNET_BIND").ok();
        let host = host_env.unwrap_or_else(|| cfg_host.to_string());
        let bind = bind_env.or_else(|| {
            if host_from_env {
                Some(host.clone())
            } else {
                Some(cfg_bind.to_string())
            }
        });

        Ok(Self {
            base_path: base,
            db_path: db,
            port,
            host,
            bind,
            manifest,
        })
    }

    pub fn memory_dir(&self) -> PathBuf {
        self.base_path.join("memory")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.base_path.join(".daemon").join("logs")
    }

    pub fn secrets_dir(&self) -> PathBuf {
        self.base_path.join(".secrets")
    }

    pub fn skills_dir(&self) -> PathBuf {
        self.base_path.join("skills")
    }
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            tracing::warn!(
                "neither HOME nor USERPROFILE is set; falling back to current directory"
            );
            PathBuf::from(".")
        })
}

enum ManifestLoadError {
    Recoverable(String),
    Fatal(String),
}

fn should_fail_fast_for_manifest_error_context(raw: &serde_yml::Value, error: &str) -> bool {
    let raw_pipeline = raw_child(raw, "memory").and_then(|value| raw_child(value, "pipelineV2"));
    let extraction_provider = raw_pipeline
        .and_then(|value| raw_child(value, "extraction"))
        .and_then(|value| raw_string(value, "provider"))
        .or_else(|| raw_pipeline.and_then(|value| raw_string(value, "extractionProvider")));
    let synthesis_provider = raw_pipeline
        .and_then(|value| raw_child(value, "synthesis"))
        .and_then(|value| raw_string(value, "provider"))
        .or_else(|| raw_pipeline.and_then(|value| raw_string(value, "synthesisProvider")));

    extraction_provider.is_some_and(|provider| provider == "command")
        || synthesis_provider.is_some_and(|provider| provider == "command")
        || error.contains("memory.pipelineV2.extraction.command")
        || error.contains("memory.pipelineV2.synthesis.provider='command'")
}

fn load_manifest(base: &Path) -> Result<Option<AgentManifest>, ManifestLoadError> {
    let path = base.join("agent.yaml");
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(ManifestLoadError::Recoverable(format!(
                "failed to read {}: {err}",
                path.to_string_lossy()
            )))
        }
    };
    let raw: serde_yml::Value = serde_yml::from_str(&content)
        .map_err(|err| ManifestLoadError::Recoverable(format!("YAML parse error: {err}")))?;
    parse_manifest_from_raw(&content, &raw)
        .map(Some)
        .map_err(|error| {
            if should_fail_fast_for_manifest_error_context(&raw, &error) {
                ManifestLoadError::Fatal(error)
            } else {
                ManifestLoadError::Recoverable(error)
            }
        })
}

#[cfg(test)]
fn parse_manifest(content: &str) -> Option<AgentManifest> {
    parse_manifest_result(content).ok()
}

#[cfg(test)]
fn parse_manifest_result(content: &str) -> Result<AgentManifest, String> {
    let raw: serde_yml::Value =
        serde_yml::from_str(content).map_err(|err| format!("YAML parse error: {err}"))?;
    parse_manifest_from_raw(content, &raw)
}

fn parse_manifest_from_raw(
    content: &str,
    raw: &serde_yml::Value,
) -> Result<AgentManifest, String> {
    let manifest: AgentManifest =
        serde_yml::from_str(content).map_err(|err| format!("manifest shape error: {err}"))?;
    normalize_manifest(manifest, raw)
}

fn normalize_manifest(
    mut manifest: AgentManifest,
    raw: &serde_yml::Value,
) -> Result<AgentManifest, String> {
    let Some(memory) = manifest.memory.as_mut() else {
        return Ok(manifest);
    };
    let Some(pipeline) = memory.pipeline_v2.as_mut() else {
        return Ok(manifest);
    };
    let raw_pipeline = raw_child(raw, "memory").and_then(|value| raw_child(value, "pipelineV2"));
    normalize_pipeline_extraction(pipeline, raw_pipeline)?;
    normalize_pipeline_synthesis(pipeline, raw_pipeline)?;
    Ok(manifest)
}

fn normalize_pipeline_extraction(
    pipeline: &mut PipelineV2Config,
    raw: Option<&serde_yml::Value>,
) -> Result<(), String> {
    let extraction_raw = raw.and_then(|value| raw_child(value, "extraction"));
    if pipeline.extraction.provider != "command" {
        return Ok(());
    }

    if pipeline.extraction.command.is_none() {
        let legacy = raw.and_then(|value| raw_string(value, "extractionCommand"));
        pipeline.extraction.command = legacy.and_then(parse_command_argv);
    }

    let mut command = pipeline.extraction.command.clone().ok_or_else(|| {
        "memory.pipelineV2.extraction.command is required when extraction.provider='command'"
            .to_string()
    })?;
    command.bin = command.bin.trim().to_string();
    if command.bin.is_empty() {
        return Err(
            "memory.pipelineV2.extraction.command.bin is required when extraction.provider='command'"
                .to_string(),
        );
    }
    if command.args.iter().any(|arg| arg.trim().is_empty()) {
        command.args.retain(|arg| !arg.trim().is_empty());
    }

    if command.env.is_none() {
        if let Some(raw_env) = extraction_raw
            .and_then(|value| raw_child(value, "command"))
            .and_then(|value| raw_child(value, "env"))
            .and_then(|value| value.as_mapping())
        {
            let mut env = HashMap::new();
            for (key, value) in raw_env {
                let Some(k) = key.as_str() else {
                    continue;
                };
                if !is_valid_env_key(k) {
                    continue;
                }
                let Some(v) = value.as_str() else {
                    continue;
                };
                env.insert(k.to_string(), v.to_string());
            }
            if !env.is_empty() {
                command.env = Some(env);
            }
        }
    } else if let Some(env) = command.env.as_mut() {
        env.retain(|key, _| is_valid_env_key(key));
        if env.is_empty() {
            command.env = None;
        }
    }

    pipeline.extraction.command = Some(command);
    Ok(())
}

fn normalize_pipeline_synthesis(
    pipeline: &mut PipelineV2Config,
    raw: Option<&serde_yml::Value>,
) -> Result<(), String> {
    let extraction = pipeline.extraction.clone();
    let fallback = SynthesisConfig::default();
    let inherits_extraction = extraction.provider != "command";
    let synthesis_raw = raw.and_then(|value| raw_child(value, "synthesis"));
    if synthesis_raw
        .and_then(|value| raw_string(value, "provider"))
        .is_some_and(|provider| provider == "command")
    {
        return Err(
            "memory.pipelineV2.synthesis.provider='command' is not supported. Use extraction.provider='command' instead."
                .to_string(),
        );
    }
    let provider = raw
        .and_then(|value| raw_child(value, "synthesis"))
        .and_then(|value| raw_string(value, "provider"))
        .filter(|value| is_synthesis_provider(value));
    let model = raw
        .and_then(|value| raw_child(value, "synthesis"))
        .and_then(|value| raw_string(value, "model"));
    let endpoint = raw
        .and_then(|value| raw_child(value, "synthesis"))
        .and_then(|value| {
            raw_string(value, "endpoint").or_else(|| raw_string(value, "base_url"))
        });
    let timeout = raw
        .and_then(|value| raw_child(value, "synthesis"))
        .and_then(|value| raw_u64(value, "timeout"));
    let provider_won = provider.is_some();

    pipeline.synthesis.provider = provider
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            if inherits_extraction {
                extraction.provider.clone()
            } else {
                fallback.provider.clone()
            }
        });
    pipeline.synthesis.model = model.map(ToOwned::to_owned).unwrap_or_else(|| {
        if provider_won {
            default_pipeline_model(&pipeline.synthesis.provider).to_string()
        } else if inherits_extraction {
            extraction.model.clone()
        } else {
            fallback.model.clone()
        }
    });
    pipeline.synthesis.endpoint = endpoint.map(ToOwned::to_owned).or_else(|| {
        if provider_won || !inherits_extraction {
            None
        } else {
            extraction.endpoint.clone()
        }
    });
    pipeline.synthesis.timeout = timeout.unwrap_or_else(|| {
        if provider_won || !inherits_extraction {
            fallback.timeout
        } else {
            extraction.timeout
        }
    });
    if pipeline.synthesis.provider == "none" {
        pipeline.synthesis.enabled = false;
    }
    Ok(())
}

fn raw_child<'a>(value: &'a serde_yml::Value, key: &str) -> Option<&'a serde_yml::Value> {
    value
        .as_mapping()?
        .get(serde_yml::Value::String(key.to_string()))
}

fn raw_string<'a>(value: &'a serde_yml::Value, key: &str) -> Option<&'a str> {
    raw_child(value, key)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn raw_u64(value: &serde_yml::Value, key: &str) -> Option<u64> {
    raw_child(value, key)?.as_u64()
}

fn parse_command_argv(raw: &str) -> Option<ExtractionCommandConfig> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in raw.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    if tokens.is_empty() {
        return None;
    }

    let bin = tokens.first()?.trim().to_string();
    if bin.is_empty() {
        return None;
    }
    let args = tokens
        .iter()
        .skip(1)
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();

    Some(ExtractionCommandConfig {
        bin,
        args,
        cwd: None,
        env: None,
    })
}

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(ch) if ch == '_' || ch.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn is_pipeline_provider(value: &str) -> bool {
    matches!(
        value,
        "none" | "ollama" | "claude-code" | "opencode" | "codex" | "anthropic" | "openrouter" | "command"
    )
}

fn is_synthesis_provider(value: &str) -> bool {
    is_pipeline_provider(value) && value != "command"
}

fn default_pipeline_model(provider: &str) -> &'static str {
    match provider {
        "none" => "",
        "command" => "",
        "claude-code" | "anthropic" => "haiku",
        "codex" => "gpt-5-codex-mini",
        "opencode" => "anthropic/claude-haiku-4-5-20251001",
        "openrouter" => "openai/gpt-4o-mini",
        _ => "qwen3:4b",
    }
}

fn resolve_network_binding(mode: Option<&str>) -> (&'static str, &'static str) {
    match mode {
        Some("tailscale") => ("127.0.0.1", "0.0.0.0"),
        _ => ("127.0.0.1", "127.0.0.1"),
    }
}

pub fn network_mode_from_bind(bind: &str) -> &'static str {
    match bind {
        "127.0.0.1" | "localhost" | "::1" | "::ffff:127.0.0.1" => "localhost",
        _ => "tailscale",
    }
}

// ---------------------------------------------------------------------------
// AgentManifest (agent.yaml)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentManifest {
    pub version: Option<serde_json::Value>,
    pub schema: Option<String>,
    pub agent: AgentIdentity,
    pub network: Option<NetworkConfig>,
    pub owner: Option<OwnerConfig>,
    pub harnesses: Option<Vec<String>>,
    pub embedding: Option<EmbeddingConfig>,
    pub search: Option<SearchConfig>,
    pub memory: Option<MemoryManifestConfig>,
    pub trust: Option<TrustConfig>,
    pub services: Option<ServicesConfig>,
    pub home: Option<HomeConfig>,
    pub auth: Option<AuthConfig>,
    pub capabilities: Option<Vec<String>>,
    #[serde(rename = "harnessCompatibility")]
    pub harness_compatibility: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NetworkConfig {
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentIdentity {
    pub name: String,
    pub description: Option<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnerConfig {
    pub address: Option<String>,
    #[serde(rename = "localId")]
    pub local_id: Option<String>,
    pub ens: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingConfig {
    pub provider: String,
    pub model: String,
    pub dimensions: usize,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

impl Default for EmbeddingConfig {
    fn default() -> Self {
        Self {
            provider: "ollama".to_string(),
            model: "nomic-embed-text".to_string(),
            dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
            base_url: None,
            api_key: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        network_mode_from_bind, parse_manifest, resolve_network_binding,
        should_fail_fast_for_manifest_error_context, PipelineV2Config,
    };

    #[test]
    fn resolves_localhost_binding_by_default() {
        assert_eq!(resolve_network_binding(None), ("127.0.0.1", "127.0.0.1"));
    }

    #[test]
    fn resolves_tailscale_binding_from_manifest() {
        assert_eq!(
            resolve_network_binding(Some("tailscale")),
            ("127.0.0.1", "0.0.0.0")
        );
    }

    #[test]
    fn infers_network_mode_from_bind_host() {
        assert_eq!(network_mode_from_bind("127.0.0.1"), "localhost");
        assert_eq!(network_mode_from_bind("0.0.0.0"), "tailscale");
    }

    #[test]
    fn synthesis_defaults_stay_local_when_pipeline_block_omits_them() {
        let manifest = parse_manifest(
            r#"
memory:
  pipelineV2:
    extraction:
      provider: ollama
      model: qwen3.5:4b
"#,
        )
        .expect("parse manifest");

        let pipeline = manifest
            .memory
            .and_then(|memory| memory.pipeline_v2)
            .expect("pipeline config");

        assert_eq!(pipeline.extraction.provider, "ollama");
        assert_eq!(pipeline.extraction.model, "qwen3.5:4b");
        assert_eq!(pipeline.synthesis.provider, "ollama");
        assert_eq!(pipeline.synthesis.model, "qwen3.5:4b");
        assert_eq!(pipeline.synthesis.timeout, pipeline.extraction.timeout);
    }

    #[test]
    fn synthesis_enabled_only_keeps_inheriting_extraction_values() {
        let manifest = parse_manifest(
            r#"
memory:
  pipelineV2:
    extraction:
      provider: ollama
      model: qwen3.5:4b
      endpoint: http://127.0.0.1:11434
      timeout: 75000
    synthesis:
      enabled: true
"#,
        )
        .expect("parse manifest");

        let pipeline = manifest
            .memory
            .and_then(|memory| memory.pipeline_v2)
            .expect("pipeline config");

        assert_eq!(pipeline.synthesis.provider, "ollama");
        assert_eq!(pipeline.synthesis.model, "qwen3.5:4b");
        assert_eq!(
            pipeline.synthesis.endpoint.as_deref(),
            Some("http://127.0.0.1:11434")
        );
        assert_eq!(pipeline.synthesis.timeout, 75_000);
    }

    #[test]
    fn inherited_none_provider_disables_synthesis() {
        let manifest = parse_manifest(
            r#"
memory:
  pipelineV2:
    extraction:
      provider: none
"#,
        )
        .expect("parse manifest");

        let pipeline = manifest
            .memory
            .and_then(|memory| memory.pipeline_v2)
            .expect("pipeline config");

        assert_eq!(pipeline.synthesis.provider, "none");
        assert!(!pipeline.synthesis.enabled);
    }

    #[test]
    fn explicit_none_provider_disables_synthesis() {
        let manifest = parse_manifest(
            r#"
memory:
  pipelineV2:
    synthesis:
      enabled: true
      provider: none
"#,
        )
        .expect("parse manifest");

        let pipeline = manifest
            .memory
            .and_then(|memory| memory.pipeline_v2)
            .expect("pipeline config");

        assert_eq!(pipeline.synthesis.provider, "none");
        assert!(!pipeline.synthesis.enabled);
    }

    #[test]
    fn explicit_synthesis_provider_uses_provider_default_model() {
        let manifest = parse_manifest(
            r#"
memory:
  pipelineV2:
    extraction:
      provider: ollama
      model: qwen3.5:4b
    synthesis:
      provider: codex
"#,
        )
        .expect("parse manifest");

        let pipeline = manifest
            .memory
            .and_then(|memory| memory.pipeline_v2)
            .expect("pipeline config");

        assert_eq!(pipeline.synthesis.provider, "codex");
        assert_eq!(pipeline.synthesis.model, "gpt-5-codex-mini");
    }

    #[test]
    fn extraction_command_provider_parses_command_block() {
        let manifest = parse_manifest(
            r#"
memory:
  pipelineV2:
    extraction:
      provider: command
      command:
        bin: node
        args:
          - script.mjs
          - --transcript
          - $TRANSCRIPT
        cwd: /tmp/signet
        env:
          SIGNET_MODE: pipeline
"#,
        )
        .expect("parse manifest");

        let pipeline = manifest
            .memory
            .and_then(|memory| memory.pipeline_v2)
            .expect("pipeline config");

        assert_eq!(pipeline.extraction.provider, "command");
        assert_eq!(pipeline.extraction.timeout, 90_000);
        let command = pipeline
            .extraction
            .command
            .expect("command config should parse");
        assert_eq!(command.bin, "node");
        assert_eq!(
            command.args,
            vec![
                "script.mjs".to_string(),
                "--transcript".to_string(),
                "$TRANSCRIPT".to_string()
            ]
        );
        assert_eq!(command.cwd.as_deref(), Some("/tmp/signet"));
        assert_eq!(
            command
                .env
                .and_then(|env| env.get("SIGNET_MODE").cloned())
                .as_deref(),
            Some("pipeline")
        );
        assert_eq!(pipeline.synthesis.provider, "ollama");
        assert_eq!(pipeline.synthesis.model, "qwen3:4b");
    }

    #[test]
    fn synthesis_command_provider_is_rejected() {
        let manifest = parse_manifest(
            r#"
memory:
  pipelineV2:
    extraction:
      provider: ollama
      model: qwen3.5:4b
    synthesis:
      provider: command
"#,
        );
        assert!(manifest.is_none());
    }

    #[test]
    fn extraction_command_provider_rejects_missing_command_config() {
        let manifest = parse_manifest(
            r#"
memory:
  pipelineV2:
    extraction:
      provider: command
"#,
        );
        assert!(manifest.is_none());
    }

    #[test]
    fn extraction_command_provider_parses_legacy_extraction_command() {
        let manifest = parse_manifest(
            r#"
memory:
  pipelineV2:
    extraction:
      provider: command
    extractionCommand: node ./extract.mjs --transcript "$TRANSCRIPT" --session "$SESSION_KEY"
"#,
        )
        .expect("parse manifest");

        let pipeline = manifest
            .memory
            .and_then(|memory| memory.pipeline_v2)
            .expect("pipeline config");

        let command = pipeline
            .extraction
            .command
            .expect("legacy extractionCommand should be normalized");
        assert_eq!(command.bin, "node");
        assert_eq!(
            command.args,
            vec![
                "./extract.mjs".to_string(),
                "--transcript".to_string(),
                "$TRANSCRIPT".to_string(),
                "--session".to_string(),
                "$SESSION_KEY".to_string()
            ]
        );
    }

    #[test]
    fn extraction_timeout_default_matches_typescript_timeout() {
        let pipeline = PipelineV2Config::default();
        assert_eq!(pipeline.extraction.timeout, 90_000);
    }

    #[test]
    fn startup_fail_fast_scopes_to_command_provider_manifest_errors() {
        let extraction_command_raw: serde_yml::Value = serde_yml::from_str(
            r#"
memory:
  pipelineV2:
    extraction:
      provider: command
      command: []
"#,
        )
        .expect("raw parse");
        assert!(should_fail_fast_for_manifest_error_context(
            &extraction_command_raw,
            "manifest shape error: invalid type: sequence, expected struct ExtractionCommandConfig"
        ));

        let synthesis_command_raw: serde_yml::Value = serde_yml::from_str(
            r#"
memory:
  pipelineV2:
    synthesis:
      provider: command
"#,
        )
        .expect("raw parse");
        assert!(should_fail_fast_for_manifest_error_context(
            &synthesis_command_raw,
            "memory.pipelineV2.synthesis.provider='command' is not supported"
        ));

        let generic_raw: serde_yml::Value =
            serde_yml::from_str("agent:\n  name: default\n").expect("raw parse");
        assert!(!should_fail_fast_for_manifest_error_context(
            &generic_raw,
            "manifest shape error: missing field `agent`"
        ));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchConfig {
    pub alpha: f64,
    pub top_k: usize,
    pub min_score: f64,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            alpha: DEFAULT_HYBRID_ALPHA,
            top_k: 20,
            min_score: 0.1,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemoryManifestConfig {
    pub database: Option<String>,
    pub vectors: Option<String>,
    pub session_budget: Option<usize>,
    pub decay_rate: Option<f64>,
    #[serde(rename = "pipelineV2")]
    pub pipeline_v2: Option<PipelineV2Config>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustConfig {
    pub verification: String,
    pub registry: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServicesConfig {
    pub openclaw: Option<OpenClawServiceConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenClawServiceConfig {
    pub restart_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomeConfig {
    #[serde(rename = "spotlightEntity")]
    pub spotlight_entity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    pub method: String,
    #[serde(rename = "chainId")]
    pub chain_id: Option<u64>,
    pub mode: Option<String>,
    #[serde(rename = "rateLimits")]
    pub rate_limits: Option<HashMap<String, RateLimitConfig>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitConfig {
    #[serde(rename = "windowMs")]
    pub window_ms: Option<u64>,
    pub max: Option<u64>,
}

// ---------------------------------------------------------------------------
// Pipeline V2 Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PipelineV2Config {
    pub enabled: bool,
    pub paused: bool,
    pub shadow_mode: bool,
    /// Spawn the native Rust daemon as a shadow on :3851. Distinct from
    /// `shadow_mode` (extract-without-write). Only meaningful when read
    /// by the TS daemon; the Rust daemon ignores this field at runtime.
    pub native_shadow_enabled: bool,
    pub mutations_frozen: bool,
    pub semantic_contradiction_enabled: bool,
    pub semantic_contradiction_timeout_ms: u64,
    pub telemetry_enabled: bool,
    pub extraction: ExtractionConfig,
    pub worker: WorkerConfig,
    pub graph: GraphConfig,
    pub traversal: Option<TraversalConfig>,
    pub reranker: RerankerConfig,
    pub autonomous: AutonomousConfig,
    pub repair: RepairConfig,
    pub documents: DocumentsConfig,
    pub guardrails: GuardrailsConfig,
    pub telemetry: TelemetryConfig,
    pub continuity: ContinuityConfig,
    pub embedding_tracker: EmbeddingTrackerConfig,
    pub synthesis: SynthesisConfig,
    pub procedural: ProceduralConfig,
    pub structural: StructuralConfig,
    pub feedback: FeedbackConfig,
    pub significance: Option<SignificanceConfig>,
    pub predictor: Option<PredictorConfig>,
    pub predictor_pipeline: PredictorPipelineConfig,
    pub model_registry: ModelRegistryConfig,
}

impl Default for PipelineV2Config {
    fn default() -> Self {
        Self {
            enabled: true,
            paused: false,
            shadow_mode: false,
            native_shadow_enabled: false,
            mutations_frozen: false,
            semantic_contradiction_enabled: true,
            semantic_contradiction_timeout_ms: 120_000,
            telemetry_enabled: false,
            extraction: ExtractionConfig::default(),
            worker: WorkerConfig::default(),
            graph: GraphConfig::default(),
            traversal: Some(TraversalConfig::default()),
            reranker: RerankerConfig::default(),
            autonomous: AutonomousConfig::default(),
            repair: RepairConfig::default(),
            documents: DocumentsConfig::default(),
            guardrails: GuardrailsConfig::default(),
            telemetry: TelemetryConfig::default(),
            continuity: ContinuityConfig::default(),
            embedding_tracker: EmbeddingTrackerConfig::default(),
            synthesis: SynthesisConfig::default(),
            procedural: ProceduralConfig::default(),
            structural: StructuralConfig::default(),
            feedback: FeedbackConfig::default(),
            significance: Some(SignificanceConfig::default()),
            predictor: Some(PredictorConfig::default()),
            predictor_pipeline: PredictorPipelineConfig::default(),
            model_registry: ModelRegistryConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtractionConfig {
    pub provider: String,
    pub model: String,
    pub strength: String,
    pub endpoint: Option<String>,
    pub timeout: u64,
    pub min_confidence: f64,
    pub command: Option<ExtractionCommandConfig>,
    pub escalation: Option<EscalationConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtractionCommandConfig {
    pub bin: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
}

impl Default for ExtractionCommandConfig {
    fn default() -> Self {
        Self {
            bin: String::new(),
            args: Vec::new(),
            cwd: None,
            env: None,
        }
    }
}

impl Default for ExtractionConfig {
    fn default() -> Self {
        Self {
            provider: "ollama".to_string(),
            model: "qwen3:4b".to_string(),
            strength: "medium".to_string(),
            endpoint: None,
            timeout: 90_000,
            min_confidence: 0.5,
            command: None,
            escalation: Some(EscalationConfig::default()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EscalationConfig {
    pub max_new_entities_per_chunk: usize,
    pub max_new_attributes_per_entity: usize,
    pub level2_max_entities: usize,
}

impl Default for EscalationConfig {
    fn default() -> Self {
        Self {
            max_new_entities_per_chunk: 3,
            max_new_attributes_per_entity: 5,
            level2_max_entities: 10,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkerConfig {
    pub poll_ms: u64,
    pub max_retries: u32,
    pub lease_timeout_ms: u64,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            poll_ms: 2_000,
            max_retries: 3,
            lease_timeout_ms: 60_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GraphConfig {
    pub enabled: bool,
    pub boost_weight: f64,
    pub boost_timeout_ms: u64,
}

impl Default for GraphConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            boost_weight: 0.15,
            boost_timeout_ms: 2_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TraversalConfig {
    pub enabled: bool,
    pub max_aspects_per_entity: usize,
    pub max_attributes_per_aspect: usize,
    pub max_dependency_hops: usize,
    pub min_dependency_strength: f64,
    pub timeout_ms: u64,
    pub boost_weight: f64,
    pub constraint_budget_chars: usize,
}

impl Default for TraversalConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_aspects_per_entity: 5,
            max_attributes_per_aspect: 3,
            max_dependency_hops: 2,
            min_dependency_strength: 0.3,
            timeout_ms: 3_000,
            boost_weight: 0.1,
            constraint_budget_chars: 4_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RerankerConfig {
    pub enabled: bool,
    pub model: String,
    pub top_n: usize,
    pub timeout_ms: u64,
}

impl Default for RerankerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            model: "nomic-embed-text".to_string(),
            top_n: 10,
            timeout_ms: 5_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AutonomousConfig {
    pub enabled: bool,
    pub frozen: bool,
    pub allow_update_delete: bool,
    pub maintenance_interval_ms: u64,
    pub maintenance_mode: String,
}

impl Default for AutonomousConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            frozen: false,
            allow_update_delete: false,
            maintenance_interval_ms: 3_600_000,
            maintenance_mode: "observe".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RepairConfig {
    pub reembed_cooldown_ms: u64,
    pub reembed_hourly_budget: u64,
    pub requeue_cooldown_ms: u64,
    pub requeue_hourly_budget: u64,
    pub dedup_cooldown_ms: u64,
    pub dedup_hourly_budget: u64,
    pub dedup_semantic_threshold: f64,
    pub dedup_batch_size: usize,
}

impl Default for RepairConfig {
    fn default() -> Self {
        Self {
            reembed_cooldown_ms: 300_000,
            reembed_hourly_budget: 100,
            requeue_cooldown_ms: 60_000,
            requeue_hourly_budget: 50,
            dedup_cooldown_ms: 600_000,
            dedup_hourly_budget: 20,
            dedup_semantic_threshold: 0.92,
            dedup_batch_size: 50,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DocumentsConfig {
    pub worker_interval_ms: u64,
    pub chunk_size: usize,
    pub chunk_overlap: usize,
    pub max_content_bytes: usize,
}

impl Default for DocumentsConfig {
    fn default() -> Self {
        Self {
            worker_interval_ms: 5_000,
            chunk_size: 1_500,
            chunk_overlap: 200,
            max_content_bytes: 10_000_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GuardrailsConfig {
    pub max_content_chars: usize,
    pub chunk_target_chars: usize,
    pub recall_truncate_chars: usize,
}

impl Default for GuardrailsConfig {
    fn default() -> Self {
        Self {
            max_content_chars: 10_000,
            chunk_target_chars: 2_000,
            recall_truncate_chars: 50_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TelemetryConfig {
    pub posthog_host: String,
    pub posthog_api_key: String,
    pub flush_interval_ms: u64,
    pub flush_batch_size: usize,
    pub retention_days: u64,
}

impl Default for TelemetryConfig {
    fn default() -> Self {
        Self {
            posthog_host: String::new(),
            posthog_api_key: String::new(),
            flush_interval_ms: 60_000,
            flush_batch_size: 50,
            retention_days: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ContinuityConfig {
    pub enabled: bool,
    pub prompt_interval: u64,
    pub time_interval_ms: u64,
    pub max_checkpoints_per_session: usize,
    pub retention_days: u64,
    pub recovery_budget_chars: usize,
}

impl Default for ContinuityConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            prompt_interval: 5,
            time_interval_ms: 300_000,
            max_checkpoints_per_session: 10,
            retention_days: 30,
            recovery_budget_chars: 8_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EmbeddingTrackerConfig {
    pub enabled: bool,
    pub poll_ms: u64,
    pub batch_size: usize,
}

impl Default for EmbeddingTrackerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            poll_ms: 5_000,
            batch_size: 50,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SynthesisConfig {
    pub enabled: bool,
    pub provider: String,
    pub model: String,
    pub endpoint: Option<String>,
    pub timeout: u64,
    pub max_tokens: usize,
    pub idle_gap_minutes: u64,
}

impl Default for SynthesisConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: "ollama".to_string(),
            model: "qwen3:4b".to_string(),
            endpoint: None,
            timeout: 60_000,
            max_tokens: 4_096,
            idle_gap_minutes: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProceduralConfig {
    pub enabled: bool,
    pub decay_rate: f64,
    pub min_importance: f64,
    pub importance_on_install: f64,
    pub enrich_on_install: bool,
    pub enrich_min_description: usize,
    pub reconcile_interval_ms: u64,
}

impl Default for ProceduralConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            decay_rate: 0.99,
            min_importance: 0.1,
            importance_on_install: 0.7,
            enrich_on_install: true,
            enrich_min_description: 50,
            reconcile_interval_ms: 300_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StructuralConfig {
    pub enabled: bool,
    pub classify_batch_size: usize,
    pub dependency_batch_size: usize,
    pub poll_interval_ms: u64,
    pub synthesis_enabled: bool,
    pub synthesis_interval_ms: u64,
    pub synthesis_top_entities: usize,
    pub synthesis_max_facts: usize,
}

impl Default for StructuralConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            classify_batch_size: 10,
            dependency_batch_size: 10,
            poll_interval_ms: 10_000,
            synthesis_enabled: true,
            synthesis_interval_ms: 60_000,
            synthesis_top_entities: 20,
            synthesis_max_facts: 10,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FeedbackConfig {
    pub enabled: bool,
    pub fts_weight_delta: f64,
    pub max_aspect_weight: f64,
    pub min_aspect_weight: f64,
    pub decay_enabled: bool,
    pub decay_rate: f64,
    pub stale_days: u64,
    pub decay_interval_sessions: u64,
}

impl Default for FeedbackConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            fts_weight_delta: 0.05,
            max_aspect_weight: 2.0,
            min_aspect_weight: 0.1,
            decay_enabled: true,
            decay_rate: 0.95,
            stale_days: 30,
            decay_interval_sessions: 5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SignificanceConfig {
    pub enabled: bool,
    pub min_turns: usize,
    pub min_entity_overlap: usize,
    pub novelty_threshold: f64,
}

impl Default for SignificanceConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            min_turns: 3,
            min_entity_overlap: 1,
            novelty_threshold: 0.3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PredictorConfig {
    pub enabled: bool,
    pub train_interval_sessions: u64,
    pub min_training_sessions: u64,
    pub score_timeout_ms: u64,
    pub train_timeout_ms: u64,
    pub crash_disable_threshold: u64,
    pub rrf_k: f64,
    pub exploration_rate: f64,
    pub drift_reset_window: u64,
    pub binary_path: Option<String>,
    pub binary_args: Option<Vec<String>>,
    pub checkpoint_path: Option<String>,
}

impl Default for PredictorConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            train_interval_sessions: 5,
            min_training_sessions: 10,
            score_timeout_ms: 5_000,
            train_timeout_ms: 30_000,
            crash_disable_threshold: 3,
            rrf_k: 60.0,
            exploration_rate: 0.1,
            drift_reset_window: 50,
            binary_path: None,
            binary_args: None,
            checkpoint_path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PredictorPipelineConfig {
    pub agent_feedback: bool,
    pub training_telemetry: bool,
}

impl Default for PredictorPipelineConfig {
    fn default() -> Self {
        Self {
            agent_feedback: true,
            training_telemetry: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelRegistryConfig {
    pub enabled: bool,
    pub refresh_interval_ms: u64,
}

impl Default for ModelRegistryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            refresh_interval_ms: 3_600_000,
        }
    }
}
