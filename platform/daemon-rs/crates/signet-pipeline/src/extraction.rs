//! Fact and entity extraction from LLM output.
//!
//! Parses JSON responses from the extraction model, validates structure,
//! and returns typed results with confidence scores.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Extraction types
// ---------------------------------------------------------------------------

/// A fact extracted from content by the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedFact {
    pub content: String,
    #[serde(rename = "type", default = "default_fact_type")]
    pub fact_type: String,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
}

fn default_fact_type() -> String {
    "fact".into()
}

fn default_confidence() -> f64 {
    0.5
}

/// An entity relationship extracted from content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedEntity {
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub relationship: Option<String>,
    pub source_type: Option<String>,
    pub target_type: Option<String>,
}

/// Result of extraction — facts + entities + warnings.
#[derive(Debug, Clone)]
pub struct ExtractionResult {
    pub facts: Vec<ExtractedFact>,
    pub entities: Vec<ExtractedEntity>,
    pub warnings: Vec<String>,
}

/// Raw JSON shape from the LLM.
#[derive(Deserialize)]
struct RawExtraction {
    #[serde(default)]
    facts: Vec<serde_json::Value>,
    #[serde(default)]
    entities: Vec<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FACTS: usize = 20;
const MAX_ENTITIES: usize = 15;
const MIN_FACT_LEN: usize = 80;
const MAX_FACT_LEN: usize = 2000;
const MAX_INPUT_CHARS: usize = 12_000;

const VALID_FACT_TYPES: &[&str] = &[
    "fact",
    "preference",
    "decision",
    "rationale",
    "procedural",
    "semantic",
];

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

/// Build the extraction prompt for the LLM.
pub fn build_prompt(content: &str) -> String {
    let truncated = if content.len() > MAX_INPUT_CHARS {
        &content[..MAX_INPUT_CHARS]
    } else {
        content
    };

    format!(
        r#"Extract key facts and entity relationships from the following content.

Return a JSON object with:
- "facts": array of objects with "content" (string, 80-2000 chars, atomic and self-contained), "type" (one of: fact, preference, decision, rationale, procedural, semantic), "confidence" (0.0-1.0)
- "entities": array of objects with "source" (string), "target" (string), "relationship" (string), "source_type" (optional string), "target_type" (optional string)

Rules:
- Each fact must be understandable without the original context (atomic, self-contained)
- Maximum 20 facts, 15 entities
- Only extract genuinely useful information, skip routine/obvious content
- Confidence reflects how certain you are the fact is correct and useful

BAD fact: "install() writes bundled plugin"
GOOD fact: "The @signet/connector-opencode install() function writes pre-bundled signet.mjs to ~/.config/opencode/plugins/"

Content:
{truncated}

Respond with only the JSON object, no markdown fences or explanation."#
    )
}

// ---------------------------------------------------------------------------
// Parse extraction output
// ---------------------------------------------------------------------------

/// Parse raw LLM output into validated extraction results.
pub fn parse(raw: &str) -> ExtractionResult {
    let mut warnings = Vec::new();

    // Strip markdown fences if present
    let cleaned = strip_fences(raw);

    // Strip <think> blocks (qwen3 CoT)
    let cleaned = strip_think_blocks(&cleaned);

    // Try to extract JSON object
    let json = match extract_json(&cleaned) {
        Some(j) => j,
        None => {
            warnings.push("failed to extract JSON from LLM output".into());
            return ExtractionResult {
                facts: vec![],
                entities: vec![],
                warnings,
            };
        }
    };

    // Parse the raw structure
    let raw: RawExtraction = match serde_json::from_str(&json) {
        Ok(r) => r,
        Err(e) => {
            warnings.push(format!("JSON parse error: {e}"));
            return ExtractionResult {
                facts: vec![],
                entities: vec![],
                warnings,
            };
        }
    };

    // Validate facts
    let mut facts = Vec::new();
    for (i, val) in raw.facts.into_iter().enumerate() {
        if facts.len() >= MAX_FACTS {
            break;
        }

        match serde_json::from_value::<ExtractedFact>(val) {
            Ok(mut fact) => {
                // Validate content length
                if fact.content.len() < MIN_FACT_LEN {
                    warnings.push(format!(
                        "fact {i}: too short ({} chars)",
                        fact.content.len()
                    ));
                    continue;
                }
                if fact.content.len() > MAX_FACT_LEN {
                    fact.content.truncate(MAX_FACT_LEN);
                }

                // Validate type
                if !VALID_FACT_TYPES.contains(&fact.fact_type.as_str()) {
                    fact.fact_type = "fact".into();
                }

                // Clamp confidence
                fact.confidence = fact.confidence.clamp(0.0, 1.0);

                facts.push(fact);
            }
            Err(e) => {
                warnings.push(format!("fact {i}: invalid structure: {e}"));
            }
        }
    }

    // Validate entities
    let mut entities = Vec::new();
    for (i, val) in raw.entities.into_iter().enumerate() {
        if entities.len() >= MAX_ENTITIES {
            break;
        }

        match serde_json::from_value::<ExtractedEntity>(val) {
            Ok(entity) => {
                if entity.source.is_empty() || entity.target.is_empty() {
                    warnings.push(format!("entity {i}: source and target are required"));
                    continue;
                }
                entities.push(entity);
            }
            Err(e) => {
                warnings.push(format!("entity {i}: invalid structure: {e}"));
            }
        }
    }

    ExtractionResult {
        facts,
        entities,
        warnings,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Strip ```json ... ``` fences.
fn strip_fences(s: &str) -> String {
    let trimmed = s.trim();

    // Handle ```json ... ```
    if let Some(rest) = trimmed.strip_prefix("```json")
        && let Some(inner) = rest.strip_suffix("```")
    {
        return inner.trim().to_string();
    }

    // Handle ``` ... ```
    if let Some(rest) = trimmed.strip_prefix("```")
        && let Some(inner) = rest.strip_suffix("```")
    {
        return inner.trim().to_string();
    }

    trimmed.to_string()
}

/// Strip <think>...</think> blocks (qwen3 chain-of-thought).
fn strip_think_blocks(s: &str) -> String {
    let mut result = s.to_string();
    while let Some(start) = result.find("<think>") {
        if let Some(end) = result[start..].find("</think>") {
            result = format!(
                "{}{}",
                &result[..start],
                &result[start + end + "</think>".len()..]
            );
        } else {
            break;
        }
    }
    result.trim().to_string()
}

/// Extract a JSON array from raw LLM output (strips fences, think blocks).
pub fn parse_json_array(raw: &str) -> String {
    let cleaned = strip_fences(raw);
    let cleaned = strip_think_blocks(&cleaned);

    // Try to find a JSON array
    if let Some(start) = cleaned.find('[') {
        let bytes = cleaned.as_bytes();
        let mut depth = 0;
        let mut in_string = false;
        let mut escaped = false;

        for (i, &b) in bytes[start..].iter().enumerate() {
            if escaped {
                escaped = false;
                continue;
            }
            match b {
                b'\\' if in_string => escaped = true,
                b'"' => in_string = !in_string,
                b'[' if !in_string => depth += 1,
                b']' if !in_string => {
                    depth -= 1;
                    if depth == 0 {
                        return cleaned[start..start + i + 1].to_string();
                    }
                }
                _ => {}
            }
        }
    }

    "[]".to_string()
}

/// Extract the first balanced JSON object from a string.
fn extract_json(s: &str) -> Option<String> {
    let start = s.find('{')?;
    let bytes = s.as_bytes();
    let mut depth = 0;
    let mut in_string = false;
    let mut escaped = false;

    for (i, &b) in bytes[start..].iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        match b {
            b'\\' if in_string => escaped = true,
            b'"' => in_string = !in_string,
            b'{' if !in_string => depth += 1,
            b'}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return Some(s[start..start + i + 1].to_string());
                }
            }
            _ => {}
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valid_extraction() {
        let raw = r#"{"facts":[{"content":"The user prefers async/await over callbacks for all new TypeScript and Rust code in this project","type":"preference","confidence":0.9}],"entities":[{"source":"UserService","target":"Database","relationship":"queries"}]}"#;

        let result = parse(raw);
        assert_eq!(result.facts.len(), 1);
        assert_eq!(result.entities.len(), 1);
        assert!(result.warnings.is_empty());
        assert_eq!(result.facts[0].fact_type, "preference");
        assert!((result.facts[0].confidence - 0.9).abs() < f64::EPSILON);
    }

    #[test]
    fn parse_with_fences() {
        let raw = r#"```json
{"facts":[{"content":"Rust 2024 edition supports let-chain syntax in if-let expressions for cleaner pattern matching","type":"fact","confidence":0.85}],"entities":[]}
```"#;

        let result = parse(raw);
        assert_eq!(result.facts.len(), 1);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn parse_with_think_blocks() {
        let raw = r#"<think>
Let me analyze the content...
</think>
{"facts":[{"content":"The signet daemon uses WAL journal mode for SQLite to improve concurrent read performance under load","type":"fact","confidence":0.95}],"entities":[]}"#;

        let result = parse(raw);
        assert_eq!(result.facts.len(), 1);
    }

    #[test]
    fn parse_rejects_short_facts() {
        let raw = r#"{"facts":[{"content":"short","type":"fact","confidence":0.5}],"entities":[]}"#;

        let result = parse(raw);
        assert_eq!(result.facts.len(), 0);
        assert_eq!(result.warnings.len(), 1);
    }

    #[test]
    fn parse_normalizes_unknown_type() {
        let raw = r#"{"facts":[{"content":"Some fact about the project configuration that is long enough to pass the validation length gate","type":"unknown_type","confidence":0.5}],"entities":[]}"#;

        let result = parse(raw);
        assert_eq!(result.facts.len(), 1);
        assert_eq!(result.facts[0].fact_type, "fact");
    }

    #[test]
    fn parse_clamps_confidence() {
        let raw = r#"{"facts":[{"content":"A fact about the signet daemon configuration with an over-confident score that should be clamped","type":"fact","confidence":1.5}],"entities":[]}"#;

        let result = parse(raw);
        assert_eq!(result.facts.len(), 1);
        assert!((result.facts[0].confidence - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn extract_json_balanced() {
        assert_eq!(
            extract_json(r#"prefix {"key": "value"} suffix"#),
            Some(r#"{"key": "value"}"#.to_string())
        );
        assert_eq!(
            extract_json(r#"{"nested": {"inner": 1}}"#),
            Some(r#"{"nested": {"inner": 1}}"#.to_string())
        );
        assert_eq!(extract_json("no json here"), None);
    }
}
