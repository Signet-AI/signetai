//! Shared antonym pairs for contradiction detection.
//!
//! Used by both the pipeline worker (prospective contradiction risk)
//! and the supersession module (retroactive attribute contradiction).

use std::collections::HashSet;
use std::sync::LazyLock;

pub static NEGATION_TOKENS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "not", "no", "never", "cannot", "cant", "doesnt", "dont", "isnt", "wasnt", "wont",
        "without",
    ]
    .into_iter()
    .collect()
});

/// Narrow set of boolean/toggle antonyms for prospective contradiction risk
/// scoring on UPDATE/DELETE proposals. Kept separate from the full set to
/// avoid widening the false-positive surface.
pub static PROSPECTIVE_ANTONYM_PAIRS: &[(&str, &str)] = &[
    ("enabled", "disabled"),
    ("allow", "deny"),
    ("accept", "reject"),
    ("always", "never"),
    ("on", "off"),
    ("true", "false"),
];

pub static ANTONYM_PAIRS: &[(&str, &str)] = &[
    // boolean / toggle
    ("enabled", "disabled"),
    ("allow", "deny"),
    ("accept", "reject"),
    ("always", "never"),
    ("on", "off"),
    ("true", "false"),
    ("yes", "no"),
    // relationship
    ("together", "apart"),
    ("dating", "single"),
    ("married", "divorced"),
    ("friends", "strangers"),
    ("close", "distant"),
    // preference
    ("love", "hate"),
    ("like", "dislike"),
    ("prefer", "avoid"),
    ("enjoy", "dread"),
    ("want", "refuse"),
    // state
    ("start", "stop"),
    ("begin", "end"),
    ("open", "close"),
    ("join", "leave"),
    ("arrive", "depart"),
    ("buy", "sell"),
    ("alive", "dead"),
    ("active", "inactive"),
    // value / direction
    ("positive", "negative"),
    ("increase", "decrease"),
    ("before", "after"),
];

/// Bidirectional set for O(1) lookup in either direction.
pub static ANTONYM_SET: LazyLock<HashSet<String>> = LazyLock::new(|| {
    ANTONYM_PAIRS
        .iter()
        .flat_map(|(a, b)| [format!("{a}:{b}"), format!("{b}:{a}")])
        .collect()
});

/// Tokenize text into lowercase alphanumeric tokens (>= 2 chars).
pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|token| token.len() >= 2)
        .map(String::from)
        .collect()
}

/// Check if any token is a negation word.
pub fn has_negation(tokens: &[String]) -> bool {
    tokens
        .iter()
        .any(|token| NEGATION_TOKENS.contains(token.as_str()))
}

/// Count token overlap between two token lists.
pub fn overlap_count(left: &[String], right: &[String]) -> usize {
    let right_set: HashSet<&str> = right.iter().map(|s| s.as_str()).collect();
    left.iter()
        .filter(|t| right_set.contains(t.as_str()))
        .count()
}

/// Check if two token sets have an antonym conflict.
pub fn has_antonym_conflict(
    left_tokens: &HashSet<&str>,
    right_tokens: &HashSet<&str>,
    pairs: &[(&str, &str)],
) -> bool {
    for (a, b) in pairs {
        let left_has_a = left_tokens.contains(a);
        let left_has_b = left_tokens.contains(b);
        let right_has_a = right_tokens.contains(a);
        let right_has_b = right_tokens.contains(b);

        let left_exclusive = left_has_a != left_has_b;
        let right_exclusive = right_has_a != right_has_b;
        let opposite = (left_has_a && right_has_b) || (left_has_b && right_has_a);

        if left_exclusive && right_exclusive && opposite {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_splits_on_non_alnum() {
        let tokens = tokenize("Hello, World! foo-bar baz");
        assert_eq!(tokens, vec!["hello", "world", "foo", "bar", "baz"]);
    }

    #[test]
    fn tokenize_filters_short() {
        let tokens = tokenize("I am a big cat");
        assert_eq!(tokens, vec!["am", "big", "cat"]);
    }

    #[test]
    fn has_negation_detects_not() {
        assert!(has_negation(&["not".into(), "happy".into()]));
        assert!(!has_negation(&["very".into(), "happy".into()]));
    }

    #[test]
    fn overlap_count_returns_intersection_size() {
        let left = vec!["hello".into(), "world".into(), "foo".into()];
        let right = vec!["world".into(), "bar".into()];
        assert_eq!(overlap_count(&left, &right), 1);
    }

    #[test]
    fn antonym_conflict_detects_opposites() {
        let left: HashSet<&str> = ["enabled"].into_iter().collect();
        let right: HashSet<&str> = ["disabled"].into_iter().collect();
        assert!(has_antonym_conflict(&left, &right, ANTONYM_PAIRS));
    }

    #[test]
    fn antonym_conflict_no_conflict_for_same() {
        let left: HashSet<&str> = ["enabled"].into_iter().collect();
        let right: HashSet<&str> = ["enabled"].into_iter().collect();
        assert!(!has_antonym_conflict(&left, &right, ANTONYM_PAIRS));
    }

    #[test]
    fn antonym_set_is_bidirectional() {
        assert!(ANTONYM_SET.contains("enabled:disabled"));
        assert!(ANTONYM_SET.contains("disabled:enabled"));
        assert!(!ANTONYM_SET.contains("enabled:enabled"));
    }

    #[test]
    fn prospective_pairs_are_subset() {
        for (a, b) in PROSPECTIVE_ANTONYM_PAIRS.iter() {
            assert!(ANTONYM_SET.contains(&format!("{a}:{b}")));
        }
    }
}
