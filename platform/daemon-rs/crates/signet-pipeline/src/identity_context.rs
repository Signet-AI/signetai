//! Profile-managed identity context parity with `platform/daemon/src/identity-context.ts`.
//!
//! Loads root or agent-specific identity files, applies per-file token/character
//! budgets, and rejects symlink-resolved paths outside safe markdown identity
//! areas.

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use serde::Deserialize;
use tiktoken_rs::{CoreBPE, cl100k_base};

pub type IdentityFileMap = HashMap<String, PathBuf>;

const TRUNCATED_MARKER: &str = "\n[truncated]";
const IDENTITY_FILES: &[&str] = &[
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "MEMORY.md",
    "BOOTSTRAP.md",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityContextSection {
    pub path: String,
    pub header: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ContextIdentityFileConfig {
    pub path: String,
    pub header: Option<String>,
    pub role: Option<String>,
    pub enabled: Option<bool>,
    pub max_tokens: Option<usize>,
    pub max_chars: Option<usize>,
    pub budget: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ContextIdentityConfig {
    pub include: Option<bool>,
    pub files: Option<Vec<ContextIdentityFileConfig>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentIdentity {
    pub name: String,
    pub description: Option<String>,
}

fn identity_header_for(path: &str, entry: Option<&ContextIdentityFileConfig>) -> String {
    if let Some(header) = entry.and_then(|entry| entry.header.as_ref()) {
        return header.clone();
    }
    let filename = path
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(path);
    match filename {
        "AGENTS.md" => "Agent Instructions".to_string(),
        "SOUL.md" => "Soul".to_string(),
        "IDENTITY.md" => "Identity".to_string(),
        "USER.md" => "About Your User".to_string(),
        "MEMORY.md" => "Working Memory".to_string(),
        _ => entry
            .and_then(|entry| entry.role.clone())
            .unwrap_or_else(|| strip_md_suffix(filename).to_string()),
    }
}

fn strip_md_suffix(value: &str) -> &str {
    if value.len() >= 3 && value[value.len() - 3..].eq_ignore_ascii_case(".md") {
        &value[..value.len() - 3]
    } else {
        value
    }
}

fn trim_file_content(content: String) -> String {
    content.trim().to_string()
}

fn read_identity_path(file_path: Option<&Path>, char_budget: usize) -> Option<String> {
    let file_path = file_path?;
    if !file_path.exists() {
        return None;
    }
    let content = trim_file_content(fs::read_to_string(file_path).ok()?);
    if content.is_empty() {
        return None;
    }
    if content.chars().count() <= char_budget {
        return Some(content);
    }
    Some(format!(
        "{}{}",
        take_chars(&content, char_budget),
        TRUNCATED_MARKER
    ))
}

pub fn read_identity_file(
    agents_dir: &Path,
    file_name: &str,
    char_budget: usize,
    identity_files: Option<&IdentityFileMap>,
) -> Option<String> {
    let override_path = identity_files.and_then(|files| files.get(file_name));
    let owned;
    let path = match override_path {
        Some(path) => path.as_path(),
        None => {
            owned = agents_dir.join(file_name);
            owned.as_path()
        }
    };
    read_identity_path(Some(path), char_budget)
}

pub fn read_memory_md(
    agents_dir: &Path,
    char_budget: usize,
    identity_files: Option<&IdentityFileMap>,
) -> Option<String> {
    read_identity_file(agents_dir, "MEMORY.md", char_budget, identity_files)
}

pub fn read_agents_md(
    agents_dir: &Path,
    char_budget: usize,
    identity_files: Option<&IdentityFileMap>,
) -> Option<String> {
    read_identity_file(agents_dir, "AGENTS.md", char_budget, identity_files)
}

fn tokenizer() -> Result<&'static CoreBPE, String> {
    static TOK: OnceLock<Result<CoreBPE, String>> = OnceLock::new();
    match TOK.get_or_init(|| cl100k_base().map_err(|err| err.to_string())) {
        Ok(tok) => Ok(tok),
        Err(err) => Err(err.clone()),
    }
}

pub fn count_tokens(text: &str) -> usize {
    tokenizer()
        .map(|tok| tok.encode_ordinary(text).len())
        .unwrap_or_else(|_| text.split_whitespace().count())
}

pub fn truncate_to_tokens(text: &str, limit: usize) -> String {
    if limit < 1 {
        return String::new();
    }
    match tokenizer() {
        Ok(tok) => {
            let mut tokens = tok.encode_ordinary(text);
            if tokens.len() <= limit {
                return text.to_string();
            }
            tokens.truncate(limit);
            tok.decode(tokens)
                .map(|value| value.trim_end().to_string())
                .unwrap_or_default()
        }
        Err(_) => text
            .split_whitespace()
            .take(limit)
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn read_identity_path_with_budget(
    file_path: Option<&Path>,
    budget: &ContextIdentityFileConfig,
) -> Option<String> {
    let file_path = file_path?;
    if !file_path.exists() {
        return None;
    }
    let content = trim_file_content(fs::read_to_string(file_path).ok()?);
    if content.is_empty() {
        return None;
    }

    if let Some(max_tokens) = budget.max_tokens {
        if max_tokens == 0 {
            return None;
        }
        if count_tokens(&content) <= max_tokens {
            return Some(content);
        }
        let marker_tokens = count_tokens(TRUNCATED_MARKER);
        if marker_tokens >= max_tokens {
            return Some(truncate_to_tokens(&content, max_tokens));
        }
        return Some(format!(
            "{}{}",
            truncate_to_tokens(&content, max_tokens - marker_tokens),
            TRUNCATED_MARKER
        ));
    }

    if let Some(char_budget) = budget.max_chars.or(budget.budget) {
        if char_budget == 0 {
            return None;
        }
        if content.chars().count() <= char_budget {
            return Some(content);
        }
        let marker_chars = TRUNCATED_MARKER.chars().count();
        if marker_chars >= char_budget {
            return Some(take_chars(&content, char_budget));
        }
        return Some(format!(
            "{}{}",
            take_chars(&content, char_budget - marker_chars),
            TRUNCATED_MARKER
        ));
    }

    Some(content)
}

fn take_chars(value: &str, count: usize) -> String {
    value.chars().take(count).collect()
}

fn identity_path_for(
    agents_dir: &Path,
    path: &str,
    identity_files: Option<&IdentityFileMap>,
) -> PathBuf {
    identity_files
        .and_then(|files| files.get(path).cloned())
        .unwrap_or_else(|| agents_dir.join(path.trim_start_matches(['/', '\\'])))
}

pub fn is_safe_resolved_identity_path(agents_dir: &Path, file_path: &Path) -> bool {
    let Ok(base) = fs::canonicalize(agents_dir) else {
        return false;
    };
    let Ok(target) = fs::canonicalize(file_path) else {
        return false;
    };
    if !target
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        return false;
    }
    let Ok(rel) = target.strip_prefix(&base) else {
        return false;
    };
    if rel.as_os_str().is_empty() {
        return false;
    }
    let denied_dirs = [".daemon", ".secrets", "memory"];
    rel.components().all(|component| match component {
        Component::Normal(part) => {
            let normalized = part.to_string_lossy().to_lowercase();
            !normalized.starts_with('.') && !denied_dirs.contains(&normalized.as_str())
        }
        _ => false,
    })
}

pub fn read_context_identity_sections(
    agents_dir: &Path,
    identity: Option<&ContextIdentityConfig>,
    identity_files: Option<&IdentityFileMap>,
) -> Option<Vec<IdentityContextSection>> {
    if identity.and_then(|identity| identity.include) == Some(false) {
        return Some(Vec::new());
    }
    let files = identity.and_then(|identity| identity.files.as_ref())?;

    let mut sections = Vec::new();
    for entry in files {
        if entry.enabled == Some(false) {
            continue;
        }
        let file_path = identity_path_for(agents_dir, &entry.path, identity_files);
        if !is_safe_resolved_identity_path(agents_dir, &file_path) {
            continue;
        }
        let Some(content) = read_identity_path_with_budget(Some(&file_path), entry) else {
            continue;
        };
        sections.push(IdentityContextSection {
            path: entry.path.clone(),
            header: identity_header_for(&entry.path, Some(entry)),
            content,
        });
    }
    Some(sections)
}

pub fn resolve_identity_files(agent_id: &str, agents_dir: &Path) -> IdentityFileMap {
    if agent_id.is_empty() || agent_id == "default" {
        return IdentityFileMap::new();
    }
    let agent_dir = agents_dir.join("agents").join(agent_id);
    let mut result = IdentityFileMap::new();
    for file in IDENTITY_FILES {
        let specific = agent_dir.join(file);
        let fallback = agents_dir.join(file);
        if specific.exists() {
            result.insert((*file).to_string(), specific);
        } else if fallback.exists() {
            result.insert((*file).to_string(), fallback);
        }
    }
    result
}

#[derive(Debug, Deserialize)]
struct AgentYamlRoot {
    agent: Option<AgentYamlAgent>,
}

#[derive(Debug, Deserialize)]
struct AgentYamlAgent {
    name: Option<String>,
    description: Option<String>,
}

pub fn parse_identity_markdown(content: &str) -> AgentIdentity {
    let mut name_match: Option<String> = None;
    let mut you_are_match: Option<String> = None;
    let mut description: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();
        if name_match.is_none() && lower.starts_with("name:") {
            name_match = Some(trimmed[5..].trim().to_string());
        }
        if you_are_match.is_none() {
            let without_heading = trimmed.trim_start_matches('#').trim_start();
            let lower_without_heading = without_heading.to_lowercase();
            if lower_without_heading.starts_with("you are ") {
                let raw = &without_heading[8..];
                let end = raw.find('.').unwrap_or(raw.len());
                you_are_match = Some(raw[..end].trim().to_string());
            }
        }
        if description.is_none() && (lower.starts_with("creature:") || lower.starts_with("role:")) {
            let idx = trimmed.find(':').unwrap_or(0);
            description = Some(trimmed[idx + 1..].trim().to_string());
        }
    }

    AgentIdentity {
        name: name_match
            .or(you_are_match)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Agent".to_string()),
        description: description.filter(|value| !value.is_empty()),
    }
}

pub fn load_identity(agents_dir: &Path, identity_files: Option<&IdentityFileMap>) -> AgentIdentity {
    if let Some(identity_md) = identity_files.and_then(|files| files.get("IDENTITY.md")) {
        if identity_md.exists() {
            if let Ok(content) = fs::read_to_string(identity_md) {
                return parse_identity_markdown(&content);
            }
        }
    }

    let agent_yaml = agents_dir.join("agent.yaml");
    if agent_yaml.exists() {
        if let Ok(content) = fs::read_to_string(&agent_yaml) {
            if let Ok(config) = serde_yml::from_str::<AgentYamlRoot>(&content) {
                if let Some(agent) = config.agent {
                    if let Some(name) = agent.name.filter(|name| !name.is_empty()) {
                        return AgentIdentity {
                            name,
                            description: agent.description,
                        };
                    }
                }
            }
        }
    }

    let root_identity_md = agents_dir.join("IDENTITY.md");
    if root_identity_md.exists() {
        if let Ok(content) = fs::read_to_string(root_identity_md) {
            return parse_identity_markdown(&content);
        }
    }

    AgentIdentity {
        name: "Agent".to_string(),
        description: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("signet-identity-context-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_markdown_and_loads_agent_yaml_before_root_identity() {
        // Parity: TS identity-context.ts:162-207 parses markdown identity and
        // loadIdentity checks agent.yaml before root IDENTITY.md.
        assert_eq!(
            parse_identity_markdown("name: Ada\nrole: coding assistant"),
            AgentIdentity {
                name: "Ada".to_string(),
                description: Some("coding assistant".to_string()),
            }
        );

        let dir = temp_dir();
        fs::write(
            dir.join("agent.yaml"),
            "agent:\n  name: YAML Agent\n  description: from yaml\n",
        )
        .unwrap();
        fs::write(dir.join("IDENTITY.md"), "name: Markdown Agent\n").unwrap();
        assert_eq!(
            load_identity(&dir, None),
            AgentIdentity {
                name: "YAML Agent".to_string(),
                description: Some("from yaml".to_string()),
            }
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn renders_sections_in_order_with_hard_token_and_char_budgets() {
        // Parity: TS identity-context.ts:79-99 reserves truncation marker room
        // so maxTokens/maxChars outputs never exceed declared budgets.
        let dir = temp_dir();
        fs::write(dir.join("AGENTS.md"), "word ".repeat(400)).unwrap();
        fs::write(dir.join("USER.md"), "x".repeat(4000)).unwrap();
        let token_budget = 40;
        let char_budget = 100;
        let sections = read_context_identity_sections(
            &dir,
            Some(&ContextIdentityConfig {
                include: None,
                files: Some(vec![
                    ContextIdentityFileConfig {
                        path: "AGENTS.md".to_string(),
                        max_tokens: Some(token_budget),
                        ..Default::default()
                    },
                    ContextIdentityFileConfig {
                        path: "USER.md".to_string(),
                        max_chars: Some(char_budget),
                        ..Default::default()
                    },
                ]),
            }),
            None,
        )
        .unwrap();
        assert_eq!(sections[0].header, "Agent Instructions");
        assert_eq!(sections[1].header, "About Your User");
        assert!(sections[0].content.contains("[truncated]"));
        assert!(count_tokens(&sections[0].content) <= token_budget);
        assert!(sections[1].content.contains("[truncated]"));
        assert!(sections[1].content.chars().count() <= char_budget);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tiny_budgets_never_overflow_marker() {
        // Parity: TS identity-context.ts:86-98 caps without marker when marker
        // cannot fit inside a tiny maxTokens/maxChars budget.
        let dir = temp_dir();
        fs::write(
            dir.join("AGENTS.md"),
            "alpha beta gamma delta epsilon zeta eta theta",
        )
        .unwrap();
        fs::write(dir.join("USER.md"), "user preference detail goes here").unwrap();
        let sections = read_context_identity_sections(
            &dir,
            Some(&ContextIdentityConfig {
                include: None,
                files: Some(vec![
                    ContextIdentityFileConfig {
                        path: "AGENTS.md".to_string(),
                        max_tokens: Some(1),
                        ..Default::default()
                    },
                    ContextIdentityFileConfig {
                        path: "USER.md".to_string(),
                        max_chars: Some(1),
                        ..Default::default()
                    },
                ]),
            }),
            None,
        )
        .unwrap();
        assert!(count_tokens(&sections[0].content) <= 1);
        assert!(sections[1].content.chars().count() <= 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_unsafe_symlink_targets_and_include_false() {
        // Parity: TS identity-context.ts:111-145 canonicalizes paths, requires
        // .md targets, rejects denied/hidden dirs, and include:false returns [].
        let dir = temp_dir();
        fs::create_dir_all(dir.join(".secrets")).unwrap();
        fs::write(dir.join(".secrets/secret.md"), "do not leak").unwrap();
        symlink(dir.join(".secrets/secret.md"), dir.join("context.md")).unwrap();
        let config = ContextIdentityConfig {
            include: None,
            files: Some(vec![ContextIdentityFileConfig {
                path: "context.md".to_string(),
                max_tokens: Some(20),
                ..Default::default()
            }]),
        };
        assert_eq!(
            read_context_identity_sections(&dir, Some(&config), None),
            Some(vec![])
        );

        fs::remove_file(dir.join("context.md")).unwrap();
        fs::write(dir.join("agent.yaml"), "agent:\n  name: Do Not Inject\n").unwrap();
        symlink(dir.join("agent.yaml"), dir.join("context.md")).unwrap();
        assert_eq!(
            read_context_identity_sections(&dir, Some(&config), None),
            Some(vec![])
        );

        let suppressed = ContextIdentityConfig {
            include: Some(false),
            files: None,
        };
        assert_eq!(
            read_context_identity_sections(&dir, Some(&suppressed), None),
            Some(vec![])
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_identity_file_through_override_map_and_resolves_agent_files() {
        // Parity: TS identity-context.ts:44-67 reads override paths; lines
        // 148-150 delegate named agents to getAgentIdentityFiles.
        let dir = temp_dir();
        let override_path = dir.join("override.md");
        fs::write(&override_path, "abcdef").unwrap();
        let files = IdentityFileMap::from([("USER.md".to_string(), override_path)]);
        assert_eq!(
            read_identity_file(&dir, "USER.md", 4, Some(&files)),
            Some("abcd\n[truncated]".to_string())
        );

        fs::create_dir_all(dir.join("agents/agent-a")).unwrap();
        fs::write(dir.join("AGENTS.md"), "root").unwrap();
        fs::write(dir.join("agents/agent-a/IDENTITY.md"), "name: Agent A").unwrap();
        let resolved = resolve_identity_files("agent-a", &dir);
        assert_eq!(resolved.get("AGENTS.md"), Some(&dir.join("AGENTS.md")));
        assert_eq!(
            resolved.get("IDENTITY.md"),
            Some(&dir.join("agents/agent-a/IDENTITY.md"))
        );
        assert!(resolve_identity_files("default", &dir).is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
}
