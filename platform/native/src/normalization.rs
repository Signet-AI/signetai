use napi_derive::napi;
use sha2::{Digest, Sha256};
#[napi(object)]
pub struct NormalizedMemoryContent {
    pub storage_content: String,
    pub normalized_content: String,
    pub hash_basis: String,
    pub content_hash: String,
}

#[napi]
pub fn normalize_content_for_storage(content: String) -> String {
    content
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_string()
}

#[napi]
pub fn derive_normalized_content(storage_content: String) -> String {
    let lowered = collapse_whitespace(&storage_content.to_lowercase());
    let trimmed =
        lowered.trim_end_matches(|c: char| matches!(c, '.' | ',' | '!' | '?' | ';' | ':'));
    trimmed.trim().to_string()
}

#[napi]
pub fn normalize_and_hash_content(content: String) -> NormalizedMemoryContent {
    let storage_content = normalize_content_for_storage(content);
    let normalized_content = derive_normalized_content(storage_content.clone());

    let hash_basis = if normalized_content.is_empty() {
        storage_content.to_lowercase()
    } else {
        normalized_content.clone()
    };

    let mut hasher = Sha256::new();
    hasher.update(hash_basis.as_bytes());
    let content_hash = format!("{:x}", hasher.finalize());

    NormalizedMemoryContent {
        storage_content,
        normalized_content,
        hash_basis,
        content_hash,
    }
}

fn collapse_whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev_whitespace = false;

    for ch in input.chars() {
        if ch.is_whitespace() {
            if !prev_whitespace {
                out.push(' ');
            }
            prev_whitespace = true;
        } else {
            out.push(ch);
            prev_whitespace = false;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::{
        derive_normalized_content, normalize_and_hash_content, normalize_content_for_storage,
    };

    #[test]
    fn storage_preserves_multiline_markdown() {
        let input =
            "  ## Session Logs\r\n\r\n| id | kind |\r\n|----|------|\r\n| a | summary |\r\n";
        let result = normalize_content_for_storage(input.to_string());
        assert_eq!(
            result,
            "## Session Logs\n\n| id | kind |\n|----|------|\n| a | summary |"
        );
    }

    #[test]
    fn semantic_normalization_collapses_whitespace() {
        let result = derive_normalized_content("## Session Logs\n\n| a | b |".to_string());
        assert_eq!(result, "## session logs | a | b |");
    }

    #[test]
    fn formatting_only_differences_keep_same_hash() {
        let multi = normalize_and_hash_content(
            "## Session Logs\n\n| id | kind |\n|----|------|\n| a | summary |".to_string(),
        );
        let flat = normalize_and_hash_content(
            "## Session Logs | id | kind | |----|------| | a | summary |".to_string(),
        );

        assert!(multi.storage_content.contains('\n'));
        assert_eq!(multi.normalized_content, flat.normalized_content);
        assert_eq!(multi.content_hash, flat.content_hash);
    }
}
