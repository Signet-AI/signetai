use forge_core::ForgeError;
use std::path::PathBuf;
use tracing::{debug, info};

/// A loaded skill from ~/.agents/skills/
#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub user_invocable: bool,
    pub arg_hint: Option<String>,
    pub content: String,
}

/// Load all skills from ~/.agents/skills/
pub fn load_skills() -> Vec<Skill> {
    let skills_dir = skills_dir();
    if !skills_dir.exists() {
        debug!("Skills directory not found: {}", skills_dir.display());
        return Vec::new();
    }

    let mut skills = Vec::new();

    let entries = match std::fs::read_dir(&skills_dir) {
        Ok(e) => e,
        Err(e) => {
            debug!("Failed to read skills directory: {e}");
            return Vec::new();
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();

        // Skills can be directories (with SKILL.md inside) or .md files
        let skill_file = if path.is_dir() {
            let skill_md = path.join("SKILL.md");
            if skill_md.exists() {
                skill_md
            } else {
                continue;
            }
        } else if path.extension().map(|e| e == "md").unwrap_or(false) {
            path.clone()
        } else {
            continue;
        };

        match parse_skill_file(&skill_file) {
            Ok(skill) => {
                debug!("Loaded skill: {} (invocable: {})", skill.name, skill.user_invocable);
                skills.push(skill);
            }
            Err(e) => {
                debug!("Failed to parse skill {}: {e}", skill_file.display());
            }
        }
    }

    info!("Loaded {} skills from {}", skills.len(), skills_dir.display());
    skills
}

/// Parse a SKILL.md file with YAML frontmatter
fn parse_skill_file(path: &PathBuf) -> Result<Skill, ForgeError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| ForgeError::config(format!("Failed to read {}: {e}", path.display())))?;

    // Parse YAML frontmatter (between --- delimiters)
    let (frontmatter, body) = parse_frontmatter(&content);

    let name = frontmatter
        .get("name")
        .cloned()
        .or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "unknown".to_string());

    let description = frontmatter
        .get("description")
        .cloned()
        .unwrap_or_default();

    let user_invocable = frontmatter
        .get("user_invocable")
        .map(|v| v == "true")
        .unwrap_or(true);

    let arg_hint = frontmatter.get("arg_hint").cloned();

    Ok(Skill {
        name,
        description,
        user_invocable,
        arg_hint,
        content: body,
    })
}

/// Simple YAML frontmatter parser
fn parse_frontmatter(content: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut map = std::collections::HashMap::new();

    if !content.starts_with("---") {
        return (map, content.to_string());
    }

    let rest = &content[3..];
    let end = match rest.find("---") {
        Some(pos) => pos,
        None => return (map, content.to_string()),
    };

    let frontmatter = &rest[..end];
    let body = rest[end + 3..].trim_start().to_string();

    for line in frontmatter.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_string();
            let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
            map.insert(key, value);
        }
    }

    (map, body)
}

/// Path to ~/.agents/skills/
fn skills_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agents")
        .join("skills")
}

/// Get all user-invocable skills as slash commands
pub fn slash_commands(skills: &[Skill]) -> Vec<(&Skill, String)> {
    skills
        .iter()
        .filter(|s| s.user_invocable)
        .map(|s| {
            let usage = if let Some(hint) = &s.arg_hint {
                format!("/{} {}", s.name, hint)
            } else {
                format!("/{}", s.name)
            };
            (s, usage)
        })
        .collect()
}
