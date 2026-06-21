//! Semantic contradiction response parsing.
//!
//! Rust parity for `platform/daemon/src/pipeline/contradiction.ts`: builds the
//! semantic contradiction prompt and extracts the final contradiction JSON object
//! from raw LLM prose, markdown fences, and objects containing trailing commas.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::provider::{GenerateOpts, LlmProvider};

/// Semantic contradiction assessment returned by the parser/detector.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SemanticContradictionResult {
    pub detected: bool,
    pub confidence: f64,
    pub reasoning: String,
}

impl SemanticContradictionResult {
    fn no_contradiction() -> Self {
        Self {
            detected: false,
            confidence: 0.0,
            reasoning: String::new(),
        }
    }
}

/// Build the LLM prompt for semantic contradiction detection.
pub fn build_prompt(fact_content: &str, target_content: &str) -> String {
    format!(
        r#"Do these two statements contradict each other? Consider semantic contradictions (not just syntactic).

Statement A: {fact_content}
Statement B: {target_content}

Return ONLY a JSON object (no markdown fences, no other text):
{{"contradicts": true/false, "confidence": 0.0-1.0, "reasoning": "brief explanation"}}

Examples of contradictions:
- "Uses PostgreSQL for the auth service" vs "Migrated the auth service to MongoDB" → contradicts
- "Dark mode is enabled by default" vs "Light mode is the default theme" → contradicts
- "The API uses REST" vs "The API endpoint returns JSON" → does NOT contradict (complementary info)"#
    )
}

/// Run semantic contradiction detection through an LLM provider.
pub async fn detect_semantic_contradiction<P: LlmProvider + ?Sized>(
    fact_content: &str,
    target_content: &str,
    provider: &P,
    timeout_ms: Option<u64>,
) -> SemanticContradictionResult {
    let prompt = build_prompt(fact_content, target_content);
    let opts = GenerateOpts {
        timeout_ms: Some(timeout_ms.unwrap_or(120_000)),
        max_tokens: None,
    };

    match provider.generate(&prompt, &opts).await {
        Ok(result) => parse_semantic_contradiction(&result.text)
            .unwrap_or_else(SemanticContradictionResult::no_contradiction),
        Err(error) => {
            tracing::warn!(
                target: "pipeline",
                error = %error,
                provider = provider.name(),
                "Semantic contradiction check failed"
            );
            SemanticContradictionResult::no_contradiction()
        }
    }
}

/// Parse a raw LLM contradiction response into a normalized result.
pub fn parse_semantic_contradiction(raw: &str) -> Option<SemanticContradictionResult> {
    let payload = parse_contradiction_payload(raw)?;
    Some(SemanticContradictionResult {
        detected: payload
            .get("contradicts")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        confidence: normalize_confidence(payload.get("confidence")),
        reasoning: payload
            .get("reasoning")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// Extract the preferred JSON object containing `contradicts` from raw output.
pub fn parse_contradiction_payload(raw: &str) -> Option<Map<String, Value>> {
    let stripped = strip_fences(raw);
    let mut candidates = vec![raw.trim().to_string(), stripped.clone()];

    let raw_objects = extract_balanced_json_objects(raw);
    candidates.extend(raw_objects.into_iter().rev());

    let stripped_objects = extract_balanced_json_objects(&stripped);
    candidates.extend(stripped_objects.into_iter().rev());

    let mut seen = HashSet::new();
    for candidate in candidates {
        let text = candidate.trim();
        if text.is_empty() || !seen.insert(text.to_string()) {
            continue;
        }
        let Some(Value::Object(object)) = try_parse_json(text) else {
            continue;
        };
        if object.contains_key("contradicts") {
            return Some(object);
        }
    }

    None
}

/// Strip model `<think>` blocks and markdown JSON fences, then fall back to the
/// text beginning at the first JSON object.
pub fn strip_fences(raw: &str) -> String {
    let stripped = strip_think_blocks(raw);
    if let Some(fenced) = first_fenced_block(&stripped) {
        return fenced.trim().to_string();
    }

    let trimmed = stripped.trim();
    if let Some(brace) = trimmed.find('{')
        && brace > 0
    {
        return trimmed[brace..].to_string();
    }

    trimmed.to_string()
}

/// Parse JSON, retrying once with trailing commas before `}` or `]` removed.
pub fn try_parse_json(candidate: &str) -> Option<Value> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return None;
    }

    for attempt in [trimmed.to_string(), remove_trailing_commas(trimmed)] {
        if let Ok(parsed) = serde_json::from_str::<Value>(&attempt) {
            if let Value::String(inner) = parsed {
                return serde_json::from_str::<Value>(&inner)
                    .ok()
                    .or(Some(Value::String(inner)));
            }
            return Some(parsed);
        }
    }

    None
}

/// Extract all balanced JSON objects in encounter order.
pub fn extract_balanced_json_objects(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaping = false;
    let mut start: Option<usize> = None;

    for (index, ch) in raw.char_indices() {
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

        match ch {
            '"' => in_string = true,
            '{' => {
                if depth == 0 {
                    start = Some(index);
                }
                depth += 1;
            }
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0
                    && let Some(start_index) = start.take()
                {
                    out.push(raw[start_index..index + ch.len_utf8()].to_string());
                }
            }
            _ => {}
        }
    }

    out
}

fn normalize_confidence(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|confidence| confidence.is_finite())
        .unwrap_or(0.5)
        .clamp(0.0, 1.0)
}

fn strip_think_blocks(raw: &str) -> String {
    let mut result = raw.to_string();
    while let Some(start) = result.find("<think>") {
        let Some(end_rel) = result[start..].find("</think>") else {
            break;
        };
        let end = start + end_rel + "</think>".len();
        result.replace_range(start..end, "");
    }
    result
}

fn first_fenced_block(raw: &str) -> Option<String> {
    let start = raw.find("```")?;
    let mut content_start = start + 3;

    if raw[content_start..].starts_with("json") {
        content_start += 4;
    }

    content_start = skip_whitespace(raw, content_start);
    let end_rel = raw[content_start..].find("```")?;
    Some(raw[content_start..content_start + end_rel].to_string())
}

fn skip_whitespace(text: &str, cursor: usize) -> usize {
    let mut out = cursor;
    for (rel, ch) in text[cursor..].char_indices() {
        if !ch.is_whitespace() {
            return cursor + rel;
        }
        out = cursor + rel + ch.len_utf8();
    }
    out
}

fn remove_trailing_commas(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.char_indices().peekable();
    let mut in_string = false;
    let mut escaping = false;

    while let Some((_, ch)) = chars.next() {
        if in_string {
            out.push(ch);
            if escaping {
                escaping = false;
            } else if ch == '\\' {
                escaping = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            out.push(ch);
            continue;
        }

        if ch == ',' {
            let mut lookahead = chars.clone();
            let mut trailing = false;
            while let Some((_, next)) = lookahead.peek().copied() {
                if next.is_whitespace() {
                    lookahead.next();
                    continue;
                }
                trailing = matches!(next, '}' | ']');
                break;
            }
            if trailing {
                continue;
            }
        }

        out.push(ch);
    }

    out
}
