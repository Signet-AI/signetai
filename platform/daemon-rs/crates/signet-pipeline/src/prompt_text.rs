//! Prompt text cleanup and recall-query helpers.
//!
//! Rust parity for `platform/daemon/src/prompt-text.ts`: removes untrusted
//! metadata envelopes, extracts substantive prompt terms, builds recall query
//! shapes, and checks whether anchor identifiers are missing from recall rows.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

static RECALL_STOPWORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "a",
        "about",
        "actually",
        "after",
        "all",
        "also",
        "am",
        "an",
        "and",
        "any",
        "are",
        "as",
        "at",
        "be",
        "been",
        "before",
        "but",
        "by",
        "can",
        "could",
        "did",
        "do",
        "does",
        "doing",
        "done",
        "for",
        "from",
        "get",
        "go",
        "had",
        "has",
        "have",
        "hey",
        "hi",
        "how",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "just",
        "kind",
        "like",
        "make",
        "me",
        "more",
        "my",
        "need",
        "now",
        "of",
        "ok",
        "okay",
        "on",
        "or",
        "our",
        "out",
        "please",
        "pretty",
        "really",
        "right",
        "say",
        "should",
        "so",
        "some",
        "something",
        "still",
        "sure",
        "thanks",
        "thank",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "to",
        "too",
        "uh",
        "um",
        "use",
        "very",
        "want",
        "was",
        "we",
        "well",
        "were",
        "what",
        "when",
        "which",
        "who",
        "why",
        "will",
        "with",
        "would",
        "yeah",
        "yes",
        "you",
        "your",
    ]
    .into_iter()
    .collect()
});

/// Recall query shape consumed by memory/search surfaces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallQueryShape {
    pub keyword_terms: Vec<String>,
    pub vector_query: String,
}

/// Remove untrusted metadata header blocks and adjacent JSON envelopes.
pub fn strip_untrusted_metadata(text: &str) -> String {
    let mut remaining = text.to_string();

    while let Some((block_start, match_end)) = find_untrusted_metadata_header(&remaining) {
        let mut block_end = skip_whitespace(&remaining, match_end);

        if remaining[block_end..].starts_with('{')
            && let Some(json_end) = find_json_object_end(&remaining, block_end)
            && json_end > block_end
        {
            block_end = json_end + 1;
        }

        let before = remaining[..block_start].trim_end();
        let after = remaining[block_end..].trim_start();
        remaining = match (before.is_empty(), after.is_empty()) {
            (true, true) => String::new(),
            (true, false) => after.to_string(),
            (false, true) => before.to_string(),
            (false, false) => format!("{before}\n\n{after}"),
        };
    }

    remaining.trim().to_string()
}

/// Extract substantive terms for recall telemetry/anchor overlap.
pub fn extract_substantive_words(text: &str) -> Vec<String> {
    let cleaned = strip_discord_mentions(&strip_untrusted_metadata(text));

    let mut seen = HashSet::new();
    let mut terms = Vec::new();

    for term in extract_hyphenated_terms(&cleaned)
        .into_iter()
        .chain(split_words(&cleaned))
    {
        if seen.insert(term.clone()) {
            terms.push(term);
        }
    }

    terms
}

/// Count substantive prompt terms present in `text`.
pub fn count_prompt_term_overlap(text: &str, prompt_terms: &[String]) -> usize {
    if prompt_terms.is_empty() {
        return 0;
    }

    let hay: HashSet<String> = extract_substantive_words(text).into_iter().collect();
    prompt_terms
        .iter()
        .filter(|term| hay.contains(*term))
        .count()
}

/// Extract anchor-like identifiers from text.
pub fn extract_anchor_terms(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut terms = Vec::new();

    for token in anchor_tokens(text) {
        if token.len() < 6 {
            continue;
        }
        let has_digit = token.chars().any(|ch| ch.is_ascii_digit());
        let has_marker = token
            .chars()
            .any(|ch| matches!(ch, '_' | ':' | '/' | '.' | '-'));
        let is_very_long = token.len() >= 18;
        if !has_digit && !has_marker && !is_very_long {
            continue;
        }
        if seen.insert(token.clone()) {
            terms.push(token);
            if terms.len() >= 8 {
                break;
            }
        }
    }

    terms
}

/// Return true when query anchors are absent from the first eight recall rows.
pub fn query_anchors_missing_from_recall<I, S>(query: &str, results: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let anchors = extract_anchor_terms(&strip_untrusted_metadata(query));
    if anchors.is_empty() {
        return false;
    }

    let anchor_set: HashSet<String> = anchors.into_iter().collect();
    let mut saw_result = false;

    for content in results.into_iter().take(8) {
        saw_result = true;
        for row_anchor in extract_anchor_terms(content.as_ref()) {
            if anchor_set.contains(&row_anchor) {
                return false;
            }
        }
    }

    saw_result
}

/// Build vector and keyword query strings from a user prompt.
pub fn build_recall_query_shape(user_prompt: &str) -> RecallQueryShape {
    let vector_query = strip_untrusted_metadata(user_prompt)
        .trim()
        .chars()
        .take(200)
        .collect();
    let keyword_terms = extract_substantive_words(user_prompt);

    RecallQueryShape {
        keyword_terms,
        vector_query,
    }
}

fn find_untrusted_metadata_header(text: &str) -> Option<(usize, usize)> {
    let lower = text.to_ascii_lowercase();
    let mut best: Option<(usize, usize)> = None;

    for prefix in [
        "conversation info (untrusted metadata)",
        "chat history since last reply",
        "untrusted context",
    ] {
        for start in find_all(&lower, prefix) {
            if let Some(end) = consume_whitespace_colon(&lower, start + prefix.len()) {
                best = earliest(best, (start, end));
            }
        }
    }

    for marker in [
        "<<<external_untrusted_content",
        "end_external_untrusted_content",
    ] {
        for start in find_all(&lower, marker) {
            best = earliest(best, (start, start + marker.len()));
        }
    }

    for start in find_all(&lower, "sender (untrusted") {
        let mut cursor = start + "sender (untrusted".len();
        if let Some(close_rel) = lower[cursor..].find(')') {
            cursor += close_rel + 1;
            if let Some(end) = consume_whitespace_colon(&lower, cursor) {
                best = earliest(best, (start, end));
            }
        }
    }

    best
}

fn find_all(haystack: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut offset = 0;
    while let Some(pos) = haystack[offset..].find(needle) {
        let absolute = offset + pos;
        out.push(absolute);
        offset = absolute + needle.len();
    }
    out
}

fn earliest(current: Option<(usize, usize)>, candidate: (usize, usize)) -> Option<(usize, usize)> {
    match current {
        Some(existing) if existing.0 <= candidate.0 => Some(existing),
        _ => Some(candidate),
    }
}

fn consume_whitespace_colon(text: &str, cursor: usize) -> Option<usize> {
    let cursor = skip_whitespace(text, cursor);
    text[cursor..].starts_with(':').then_some(cursor + 1)
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

fn find_json_object_end(text: &str, start_index: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (index, ch) in text[start_index..].char_indices() {
        let absolute = start_index + index;

        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(absolute);
                }
            }
            _ => {}
        }
    }

    None
}

fn strip_discord_mentions(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;

    while cursor < text.len() {
        if let Some(end) = discord_mention_end(text, cursor) {
            cursor = end;
            continue;
        }
        let ch = text[cursor..].chars().next().expect("cursor is in bounds");
        out.push(ch);
        cursor += ch.len_utf8();
    }

    out
}

fn discord_mention_end(text: &str, cursor: usize) -> Option<usize> {
    let rest = text.get(cursor..)?;
    let mut bytes = rest.as_bytes().iter().copied();
    if bytes.next()? != b'<' || bytes.next()? != b'@' {
        return None;
    }

    let mut consumed = 2;
    if rest.as_bytes().get(consumed) == Some(&b'!') {
        consumed += 1;
    }

    let digit_start = consumed;
    while rest
        .as_bytes()
        .get(consumed)
        .is_some_and(u8::is_ascii_digit)
    {
        consumed += 1;
    }
    if consumed == digit_start || rest.as_bytes().get(consumed) != Some(&b'>') {
        return None;
    }

    Some(cursor + consumed + 1)
}

fn extract_hyphenated_terms(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for token in text.split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '-')) {
        if is_hyphenated_identifier(token) {
            terms.push(token.to_lowercase());
        }
    }
    terms
}

fn is_hyphenated_identifier(token: &str) -> bool {
    let Some(first) = token.chars().next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() || !token.contains('-') {
        return false;
    }

    token
        .split('-')
        .all(|segment| !segment.is_empty() && segment.chars().all(|ch| ch.is_ascii_alphanumeric()))
}

fn split_words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
        .filter(|word| {
            word.len() >= 3
                && !RECALL_STOPWORDS.contains(*word)
                && !word.chars().all(|ch| ch.is_ascii_digit())
        })
        .map(ToString::to_string)
        .collect()
}

fn anchor_tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|ch: char| {
            !(ch.is_ascii_alphanumeric() || matches!(ch, '_' | ':' | '/' | '.' | '-'))
        })
        .filter(|token| !token.is_empty())
        .map(ToString::to_string)
        .collect()
}
