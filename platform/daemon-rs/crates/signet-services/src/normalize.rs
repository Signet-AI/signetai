//! Content normalization and hashing for memory deduplication.
//!
//! Mirrors the TS `normalizeAndHashContent` logic:
//! 1. Storage normalization: normalize line endings + trim outer whitespace
//! 2. Semantic normalization: lowercase + collapse whitespace + strip trailing punctuation
//! 3. Hash basis: semantic normalized, or storage lowercased if empty
//! 4. SHA-256 hex digest of the hash basis

use sha2::{Digest, Sha256};

/// Result of normalizing and hashing memory content.
#[derive(Debug, Clone)]
pub struct NormalizedContent {
    /// Content for DB storage (trimmed, whitespace collapsed).
    pub storage: String,
    /// Content for comparison (lowercased, trailing punct stripped).
    pub normalized: String,
    /// SHA-256 hex digest of the hash basis.
    pub hash: String,
}

/// Normalize content and compute its hash.
pub fn normalize_and_hash(content: &str) -> NormalizedContent {
    // Step 1: Storage normalization — preserve line structure
    let storage = normalize_storage(content);

    // Step 2: Semantic normalization — lowercase + collapse whitespace
    let lowered = collapse_whitespace(&storage.to_lowercase());
    let normalized = strip_trailing_punct(&lowered).trim().to_string();

    // Step 3: Hash basis
    let basis = if normalized.is_empty() {
        storage.to_lowercase()
    } else {
        normalized.clone()
    };

    // Step 4: SHA-256
    let mut hasher = Sha256::new();
    hasher.update(basis.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    NormalizedContent {
        storage,
        normalized,
        hash,
    }
}

fn normalize_storage(s: &str) -> String {
    s.replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_string()
}

fn collapse_whitespace(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut prev_ws = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !prev_ws {
                result.push(' ');
            }
            prev_ws = true;
        } else {
            result.push(c);
            prev_ws = false;
        }
    }
    result
}

fn strip_trailing_punct(s: &str) -> &str {
    s.trim_end_matches(['.', ',', '!', '?', ';', ':'])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_normalization() {
        let r = normalize_and_hash("  Hello   World!  ");
        assert_eq!(r.storage, "Hello   World!");
        assert_eq!(r.normalized, "hello world");
        assert!(!r.hash.is_empty());
        assert_eq!(r.hash.len(), 64); // SHA-256 hex
    }

    #[test]
    fn trailing_punctuation_stripped() {
        let r = normalize_and_hash("This is a fact...");
        assert_eq!(r.normalized, "this is a fact");
    }

    #[test]
    fn same_content_same_hash() {
        let a = normalize_and_hash("Hello World!");
        let b = normalize_and_hash("  hello   world!  ");
        assert_eq!(a.hash, b.hash);
    }

    #[test]
    fn different_content_different_hash() {
        let a = normalize_and_hash("Hello World");
        let b = normalize_and_hash("Goodbye World");
        assert_ne!(a.hash, b.hash);
    }

    #[test]
    fn empty_normalized_uses_storage() {
        // Content that normalizes to empty after punct stripping
        let r = normalize_and_hash("...");
        assert_eq!(r.storage, "...");
        assert!(r.normalized.is_empty());
        // Hash is based on lowered storage
        assert!(!r.hash.is_empty());
    }

    #[test]
    fn storage_preserves_multiline_markdown() {
        let r = normalize_and_hash(
            "  ## Session Logs\r\n\r\n| id | kind |\r\n|----|------|\r\n| a | summary |\r\n",
        );
        assert_eq!(
            r.storage,
            "## Session Logs\n\n| id | kind |\n|----|------|\n| a | summary |"
        );
        assert_eq!(
            r.normalized,
            "## session logs | id | kind | |----|------| | a | summary |"
        );
    }
}
