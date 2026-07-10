//! Shared entity-quality policy for extraction, persistence, and repair.
//!
//! Keep this policy behaviorally aligned with `platform/daemon/src/entity-quality.ts`.

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
        "current",
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
        "result",
        "sender",
        "she",
        "someone",
        "status",
        "summary",
        "that",
        "the",
        "their",
        "them",
        "they",
        "this",
        "to",
        "understand",
        "update",
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
pub fn normalize_entity_type(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase().replace([' ', '-'], "_"))
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
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_js_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Match a JavaScript `\bword\b` expression for an ASCII word.
fn has_word_signal(value: &str, word: &str) -> bool {
    value.match_indices(word).any(|(start, _)| {
        let end = start + word.len();
        let before_is_word = start > 0 && is_js_word_byte(value.as_bytes()[start - 1]);
        let after_is_word = end < value.len() && is_js_word_byte(value.as_bytes()[end]);
        !before_is_word && !after_is_word
    })
}

fn has_date_or_time_signal(value: &str) -> bool {
    const MONTH_WORDS: &[&str] = &[
        "jan",
        "january",
        "feb",
        "february",
        "mar",
        "march",
        "apr",
        "april",
        "may",
        "jun",
        "june",
        "jul",
        "july",
        "aug",
        "august",
        "sep",
        "sept",
        "september",
        "oct",
        "october",
        "nov",
        "november",
        "dec",
        "december",
        "today",
        "yesterday",
    ];
    if MONTH_WORDS.iter().any(|word| has_word_signal(value, word)) {
        return true;
    }

    for word in ["night", "week", "month", "year", "daily"] {
        let mut offset = 0;
        while let Some(relative) = value[offset..].find("last") {
            let start = offset + relative;
            let after_last = start + 4;
            let before_is_word = start > 0 && is_js_word_byte(value.as_bytes()[start - 1]);
            if !before_is_word {
                let whitespace_len = value[after_last..]
                    .bytes()
                    .take_while(|byte| byte.is_ascii_whitespace())
                    .count();
                let word_start = after_last + whitespace_len;
                if whitespace_len > 0
                    && value[word_start..].starts_with(word)
                    && (word_start + word.len() == value.len()
                        || !is_js_word_byte(value.as_bytes()[word_start + word.len()]))
                {
                    return true;
                }
            }
            offset = after_last;
        }
    }

    let bytes = value.as_bytes();
    for start in 0..bytes.len() {
        let before_is_word = start > 0 && is_js_word_byte(bytes[start - 1]);
        if before_is_word {
            continue;
        }
        let is_digit = |index: usize| index < bytes.len() && bytes[index].is_ascii_digit();
        let iso_date = start + 10 <= bytes.len()
            && is_digit(start)
            && is_digit(start + 1)
            && is_digit(start + 2)
            && is_digit(start + 3)
            && bytes[start + 4] == b'-'
            && is_digit(start + 5)
            && is_digit(start + 6)
            && bytes[start + 7] == b'-'
            && is_digit(start + 8)
            && is_digit(start + 9);
        let one_digit_time = start + 4 <= bytes.len()
            && is_digit(start)
            && bytes[start + 1] == b':'
            && is_digit(start + 2)
            && is_digit(start + 3);
        let two_digit_time = start + 5 <= bytes.len()
            && is_digit(start)
            && is_digit(start + 1)
            && bytes[start + 2] == b':'
            && is_digit(start + 3)
            && is_digit(start + 4);
        let end = if iso_date {
            start + 10
        } else if one_digit_time {
            start + 4
        } else if two_digit_time {
            start + 5
        } else {
            continue;
        };
        if end == bytes.len() || !is_js_word_byte(bytes[end]) {
            return true;
        }
    }
    false
}

fn has_event_signal(value: &str) -> bool {
    [
        "announce",
        "announced",
        "announcement",
        "created",
        "decided",
        "deployed",
        "digest",
        "installed",
        "launched",
        "meeting",
        "merged",
        "published",
        "released",
        "started",
        "stopped",
        "updated",
    ]
    .iter()
    .any(|word| has_word_signal(value, word))
}

/// Classify whether an entity should be persisted.
pub fn classify_entity_quality(name: &str, etype: Option<&str>) -> EntityQualityResult {
    let canonical = normalize_entity_name(name);
    let normalized_type = normalize_entity_type(etype);
    let normalized_type = normalized_type.as_deref();
    let has_concrete_type = is_concrete_entity_type(normalized_type);

    if canonical.is_empty() {
        return EntityQualityResult {
            ok: false,
            reason: Some(if name.trim().is_empty() {
                "too_short"
            } else {
                "punctuation_only"
            }),
        };
    }
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
    if canonical.chars().count() < 4 && !has_concrete_type {
        return EntityQualityResult {
            ok: false,
            reason: Some("too_short"),
        };
    }

    if let Some(t) = normalized_type {
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
        if t == "event" && !has_date_or_time_signal(&canonical) && !has_event_signal(&canonical) {
            return EntityQualityResult {
                ok: false,
                reason: Some("event_without_time_or_event_signal"),
            };
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
    fn markdown_and_standalone_structural_labels_rejected() {
        for name in [
            "Current",
            "**Status:**",
            "Status:**",
            "## Summary",
            "Result",
            "Update",
            "!!!",
        ] {
            assert!(
                !should_persist_entity(name, None),
                "expected {name:?} to be rejected"
            );
        }
    }

    #[test]
    fn specific_structural_word_names_are_accepted() {
        for name in ["Status Page", "Current Project", "Summary Report"] {
            assert!(
                should_persist_entity(name, None),
                "expected {name:?} to be accepted"
            );
        }
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
    fn event_signals_match_the_typescript_boundary_rules() {
        for (name, expected) in [
            ("Maybelline", false),
            ("last banana", false),
            ("Alpha 202X", false),
            ("17:00", true),
            ("1:00", true),
            ("123:45", false),
            ("2026-07-10", true),
            ("last week", true),
        ] {
            assert_eq!(
                should_persist_entity(name, Some("event")),
                expected,
                "unexpected event result for {name:?}"
            );
        }
    }

    #[test]
    fn concrete_types_for_prompt() {
        let s = concrete_entity_types_for_prompt();
        assert!(s.contains("person"));
        assert!(s.contains("event"));
        assert!(s.contains('|'));
    }
}
