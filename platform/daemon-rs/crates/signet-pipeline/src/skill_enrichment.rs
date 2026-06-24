//! Skill frontmatter enrichment parser parity.
//!
//! Native port of `platform/daemon/src/pipeline/skill-enrichment.ts` JSON
//! extraction behavior: strip fenced JSON/prose, tolerate trailing commas, and
//! prefer the final balanced object when model output includes examples first.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::warn;

use crate::provider::{GenerateOpts, LlmProvider};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillEnrichmentInput {
    pub name: String,
    pub description: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEnrichmentResult {
    pub description: String,
    pub triggers: Vec<String>,
    pub tags: Vec<String>,
}

pub fn build_enrichment_prompt(input: &SkillEnrichmentInput) -> String {
    let body_preview = if input.body.chars().count() > 3000 {
        format!(
            "{}\n[truncated]",
            input.body.chars().take(3000).collect::<String>()
        )
    } else {
        input.body.clone()
    };
    let description = if input.description.is_empty() {
        "(none)"
    } else {
        &input.description
    };

    format!(
        r#"You are analyzing an AI agent skill to generate discovery metadata.

Skill name: {name}
Current description: {description}

Skill content:
{body_preview}

Generate:
1. "description": A rich 1-2 sentence description explaining what this skill does and when to use it. Focus on mechanism and use-case.
2. "triggers": A list of 3-8 short phrases a user might say when they need this skill. These are discovery keywords, not commands. Examples: "help me write tests", "optimize database queries", "create a new component".
3. "tags": A list of 2-5 domain tags for grouping. Use lowercase, single words or hyphenated compounds. Examples: "testing", "database", "ui", "code-review", "deployment".

Return ONLY a JSON object with these three keys. No other text.
{{"description": "...", "triggers": ["...", "..."], "tags": ["...", "..."]}}"#,
        name = input.name,
    )
}

/// Parse a model enrichment response using the same candidate order as the TS
/// parser (`skill-enrichment.ts:50-83`).
pub fn parse_enrichment_output(raw: &str) -> Option<SkillEnrichmentResult> {
    let stripped = strip_fences(raw);
    let mut candidates = vec![raw.trim().to_string(), stripped.clone()];

    let raw_objs = extract_balanced_json_objects(raw);
    for obj in raw_objs.into_iter().rev() {
        candidates.push(obj);
    }
    let stripped_objs = extract_balanced_json_objects(&stripped);
    for obj in stripped_objs.into_iter().rev() {
        candidates.push(obj);
    }

    let mut seen = HashSet::new();
    for candidate in candidates {
        let text = candidate.trim();
        if text.is_empty() || !seen.insert(text.to_string()) {
            continue;
        }

        let Some(Value::Object(obj)) = try_parse_json(text) else {
            continue;
        };

        let description = obj
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let triggers = string_array_field(obj.get("triggers"));
        let tags = string_array_field(obj.get("tags"));

        if description.is_empty() && triggers.is_empty() {
            continue;
        }

        return Some(SkillEnrichmentResult {
            description,
            triggers,
            tags,
        });
    }

    None
}

pub async fn enrich_skill_frontmatter(
    input: &SkillEnrichmentInput,
    provider: &dyn LlmProvider,
) -> Option<SkillEnrichmentResult> {
    let prompt = build_enrichment_prompt(input);
    match provider
        .generate(
            &prompt,
            &GenerateOpts {
                timeout_ms: None,
                max_tokens: Some(512),
            },
        )
        .await
    {
        Ok(result) => parse_enrichment_output(&result.text),
        Err(err) => {
            warn!(skill = %input.name, error = %err, "skill enrichment LLM call failed");
            None
        }
    }
}

fn string_array_field(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|item| !item.trim().is_empty())
            // TS filters only; it does not trim returned array values.
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn strip_fences(raw: &str) -> String {
    let stripped = strip_think_blocks(raw);
    if let Some(fenced) = extract_fenced_json(&stripped) {
        return fenced.trim().to_string();
    }

    if let Some(array) = extract_balanced_json_array(&stripped) {
        return array;
    }

    let trimmed = stripped.trim();
    if let Some(brace) = trimmed.find('{') {
        if brace > 0 {
            return trimmed[brace..].to_string();
        }
    }
    trimmed.to_string()
}

fn strip_think_blocks(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        let after_start = &rest[start + "<think>".len()..];
        if let Some(end) = after_start.find("</think>") {
            rest = &after_start[end + "</think>".len()..];
        } else {
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

fn extract_fenced_json(raw: &str) -> Option<String> {
    let start = raw.find("```")?;
    let after_ticks = &raw[start + 3..];
    let content_start = if let Some(rest) = after_ticks.strip_prefix("json") {
        let whitespace = rest.len() - rest.trim_start().len();
        3 + "json".len() + whitespace
    } else {
        let whitespace = after_ticks.len() - after_ticks.trim_start().len();
        if whitespace == 0 {
            return None;
        }
        3 + whitespace
    };
    let content = &raw[start + content_start..];
    let end = content.find("```")?;
    Some(content[..end].to_string())
}

fn try_parse_json(candidate: &str) -> Option<Value> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return None;
    }

    for attempt in [trimmed.to_string(), remove_trailing_commas(trimmed)] {
        if let Ok(parsed) = serde_json::from_str::<Value>(&attempt) {
            if let Value::String(inner) = &parsed {
                return serde_json::from_str::<Value>(inner).ok().or(Some(parsed));
            }
            return Some(parsed);
        }
    }

    None
}

fn remove_trailing_commas(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    let mut in_string = false;
    let mut escaping = false;

    while let Some(ch) = chars.next() {
        if in_string {
            if escaping {
                escaping = false;
            } else if ch == '\\' {
                escaping = true;
            } else if ch == '"' {
                in_string = false;
            }
            out.push(ch);
            continue;
        }

        if ch == '"' {
            in_string = true;
            out.push(ch);
            continue;
        }

        if ch == ',' {
            let mut clone = chars.clone();
            while matches!(clone.peek(), Some(next) if next.is_whitespace()) {
                clone.next();
            }
            if matches!(clone.peek(), Some('}' | ']')) {
                continue;
            }
        }
        out.push(ch);
    }

    out
}

pub fn extract_balanced_json_objects(raw: &str) -> Vec<String> {
    extract_balanced(raw, '{', '}')
}

fn extract_balanced_json_array(raw: &str) -> Option<String> {
    extract_balanced(raw, '[', ']').into_iter().last()
}

fn extract_balanced(raw: &str, open: char, close: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escaping = false;
    let mut start: Option<usize> = None;

    for (idx, ch) in raw.char_indices() {
        if in_string {
            if escaping {
                escaping = false;
                continue;
            }
            if ch == '\\' {
                escaping = true;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            continue;
        }

        if ch == open {
            if depth == 0 {
                start = Some(idx);
            }
            depth += 1;
        } else if ch == close && depth > 0 {
            depth -= 1;
            if depth == 0 {
                if let Some(start_idx) = start.take() {
                    out.push(raw[start_idx..idx + ch.len_utf8()].to_string());
                }
            }
        }
    }

    out
}
