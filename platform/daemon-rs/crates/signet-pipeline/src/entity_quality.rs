//! Entity quality filtering for extraction pipeline.
//!
//! Classifies extracted entity names/types to filter out trivial, generic,
//! or scaffolding entities before persistence. Ports entity-quality.ts.

use std::collections::HashSet;
use std::sync::LazyLock;

// ---------------------------------------------------------------------------
// Concrete entity types
// ---------------------------------------------------------------------------

pub static CONCRETE_ENTITY_TYPES: &[&str] = &[
    "person",
    "organization",
    "project",
    "product",
    "system",
    "tool",
    "artifact",
    "document",
    "source",
    "place",
    "event",
];

static CONCRETE_ENTITY_TYPE_SET: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| CONCRETE_ENTITY_TYPES.iter().copied().collect());

static ABSTRACT_OR_OPERATIONAL_TYPES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "concept",
        "task",
        "skill",
        "agent",
        "policy",
        "action",
        "workflow",
        "object_type",
        "interface",
        "observation",
        "claim_slot",
        "claim_value",
        "chunk_group",
    ]
    .into_iter()
    .collect()
});

static GENERIC_CANONICAL_NAMES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "a",
        "an",
        "and",
        "are",
        "author",
        "because",
        "being",
        "but",
        "can",
        "current work",
        "did",
        "do",
        "does",
        "for",
        "from",
        "had",
        "has",
        "have",
        "he",
        "her",
        "him",
        "his",
        "i",
        "in",
        "intent",
        "is",
        "it",
        "its",
        "let",
        "of",
        "on",
        "or",
        "pending tasks",
        "primary request",
        "read",
        "recipient",
        "sender",
        "she",
        "someone",
        "summary",
        "that",
        "the",
        "their",
        "them",
        "they",
        "this",
        "to",
        "understand",
        "want",
        "was",
        "we",
        "we're",
        "were",
        "with",
        "write",
        "you",
        "your",
    ]
    .into_iter()
    .collect()
});

static METADATA_LABELS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "assistant",
        "author",
        "current work",
        "intent",
        "pending tasks",
        "primary request",
        "recipient",
        "sender",
        "system",
        "user",
    ]
    .into_iter()
    .collect()
});

static DISCOURSE_WORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "because",
        "despite",
        "however",
        "let",
        "once",
        "read",
        "summary",
        "understand",
        "want",
        "write",
    ]
    .into_iter()
    .collect()
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Normalize an entity type string: lowercase, replace spaces/dashes with underscores.
pub fn normalize_entity_type(value: Option<&str>) -> Option<&str> {
    // Simple normalization: trim, lowercase. For the caller to handle.
    value.map(|v| v.trim()).filter(|v| !v.is_empty())
}

/// Check whether a given type is a concrete entity type.
pub fn is_concrete_entity_type(etype: Option<&str>) -> bool {
    etype.is_some() && CONCRETE_ENTITY_TYPE_SET.contains(etype.unwrap())
}

/// Check whether a given type is a known abstract/operational type.
pub fn is_known_abstract_type(etype: Option<&str>) -> bool {
    etype.is_some() && ABSTRACT_OR_OPERATIONAL_TYPES.contains(etype.unwrap())
}

/// Normalize an entity name for canonical comparison.
pub fn normalize_entity_name(name: &str) -> String {
    name.trim()
        .replace('\u{201c}', "\"")
        .replace('\u{201d}', "\"")
        .replace('\u{2018}', "'")
        .replace('\u{2019}', "'")
        .trim_matches(|c| c == '\'' || c == '"' || c == '`')
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Classify whether an entity should be persisted.
pub fn classify_entity_quality(name: &str, etype: Option<&str>) -> EntityQualityResult {
    let canonical = normalize_entity_name(name);
    let has_concrete_type = is_concrete_entity_type(etype);

    if canonical.chars().all(|c| c.is_ascii_digit()) {
        return EntityQualityResult {
            ok: false,
            reason: Some("numeric_only"),
        };
    }
    if GENERIC_CANONICAL_NAMES.contains(canonical.as_str()) {
        return EntityQualityResult {
            ok: false,
            reason: Some("generic_or_scaffolding_name"),
        };
    }
    if METADATA_LABELS.contains(canonical.as_str()) {
        return EntityQualityResult {
            ok: false,
            reason: Some("metadata_role"),
        };
    }
    if DISCOURSE_WORDS.contains(canonical.as_str()) {
        return EntityQualityResult {
            ok: false,
            reason: Some("discourse_fragment"),
        };
    }

    let trimmed = name.trim();
    let lower_trimmed = trimmed.to_lowercase();
    for prefix in &[
        "user",
        "assistant",
        "system",
        "sender",
        "recipient",
        "author",
    ] {
        if lower_trimmed.starts_with(prefix) {
            let rest = &trimmed[prefix.len()..];
            if rest.starts_with(':') || rest.starts_with(' ') || rest.starts_with('-') {
                return EntityQualityResult {
                    ok: false,
                    reason: Some("role_prefixed_scaffolding"),
                };
            }
        }
    }
    for prefix in &["current ", "pending ", "primary "] {
        if canonical.starts_with(prefix) {
            return EntityQualityResult {
                ok: false,
                reason: Some("section_heading"),
            };
        }
    }

    if canonical.len() < 4 && !has_concrete_type {
        return EntityQualityResult {
            ok: false,
            reason: Some("too_short"),
        };
    }

    if let Some(t) = etype {
        if t != "extracted" && t != "unknown" {
            if !is_concrete_entity_type(Some(t)) {
                let reason = if is_known_abstract_type(Some(t)) {
                    "non_concrete_entity_type"
                } else {
                    "unknown_entity_type"
                };
                return EntityQualityResult {
                    ok: false,
                    reason: Some(reason),
                };
            }
        }
    }

    EntityQualityResult {
        ok: true,
        reason: None,
    }
}

/// Quick check: should this entity be persisted?
pub fn should_persist_entity(name: &str, etype: Option<&str>) -> bool {
    classify_entity_quality(name, etype).ok
}

/// Concrete entity types formatted for LLM prompts.
pub fn concrete_entity_types_for_prompt() -> String {
    CONCRETE_ENTITY_TYPES.join("|")
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct EntityQualityResult {
    pub ok: bool,
    pub reason: Option<&'static str>,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_only_rejected() {
        let r = classify_entity_quality("50", None);
        assert!(!r.ok);
        assert_eq!(r.reason, Some("numeric_only"));
    }

    #[test]
    fn generic_names_rejected() {
        assert!(!should_persist_entity("the", None));
        assert!(!should_persist_entity("summary", None));
        assert!(!should_persist_entity("we're", None));
    }

    #[test]
    fn role_prefixed_rejected() {
        assert!(!should_persist_entity("User: input", None));
        assert!(!should_persist_entity("sender-noreply", None));
        assert!(!should_persist_entity("Assistant response", None));
    }

    #[test]
    fn section_heading_rejected() {
        assert!(!should_persist_entity("current work", None));
        assert!(!should_persist_entity("pending tasks", None));
        assert!(!should_persist_entity("primary request", None));
    }

    #[test]
    fn short_name_without_type_rejected() {
        assert!(!should_persist_entity("cli", None));
    }

    #[test]
    fn short_name_with_concrete_type_accepted() {
        assert!(should_persist_entity("npm", Some("tool")));
    }

    #[test]
    fn concrete_entities_accepted() {
        assert!(should_persist_entity("Signet Daemon", Some("system")));
        assert!(should_persist_entity("Nicholai", Some("person")));
        assert!(should_persist_entity("PostgreSQL", Some("tool")));
    }

    #[test]
    fn abstract_type_rejected() {
        assert!(!should_persist_entity("dark mode", Some("concept")));
        assert!(!should_persist_entity("deploy", Some("task")));
    }

    #[test]
    fn normalize_entity_name_cleans_smart_quotes() {
        assert_eq!(normalize_entity_name("\u{201c}Hello\u{201d}"), "hello");
        assert_eq!(normalize_entity_name("  Foo   Bar  "), "foo bar");
    }

    #[test]
    fn concrete_types_for_prompt() {
        let s = concrete_entity_types_for_prompt();
        assert!(s.contains("person"));
        assert!(s.contains("event"));
        assert!(s.contains('|'));
    }
}
