//! Memory artifact filename filters ported from the TypeScript daemon.

pub const MIN_MEMORY_CHUNK_BODY_CHARS: usize = 80;

const ARTIFACT_SUFFIXES: [&str; 4] = [
    "--summary.md",
    "--transcript.md",
    "--compaction.md",
    "--manifest.md",
];
const MEMORY_BACKUP_PREFIXES: [&str; 3] = ["MEMORY.backup-", "MEMORY.bak-", "MEMORY.pre-"];

/// Mirrors `ARTIFACT_FILENAME_RE = /--(?:summary|transcript|compaction|manifest)\.md$/`.
pub fn is_artifact_filename(filename: &str) -> bool {
    ARTIFACT_SUFFIXES
        .iter()
        .any(|suffix| filename.ends_with(suffix))
}

/// Mirrors `MEMORY_BACKUP_FILENAME_RE = /^MEMORY\.(?:backup|bak|pre)-.+\.md$/`.
pub fn is_memory_backup_filename(filename: &str) -> bool {
    MEMORY_BACKUP_PREFIXES.iter().any(|prefix| {
        filename
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.len() >= ".md".len() + 1 && rest.ends_with(".md"))
    })
}

pub fn should_exclude_memory_ingest_filename(filename: &str) -> bool {
    is_artifact_filename(filename) || is_memory_backup_filename(filename)
}

pub fn memory_chunk_body_len(text: &str, header: &str) -> usize {
    if header.is_empty() {
        text.trim().len()
    } else {
        text.strip_prefix(header).unwrap_or(text).trim().len()
    }
}

pub fn should_ingest_memory_chunk(text: &str, header: &str) -> bool {
    memory_chunk_body_len(text, header) >= MIN_MEMORY_CHUNK_BODY_CHARS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_memory_backup_filenames_from_ts_contract() {
        // Covers platform/daemon/src/memory-ingest-filter.test.ts:13-23.
        assert!(is_memory_backup_filename(
            "MEMORY.backup-2026-03-31T21-17-05.md"
        ));
        assert!(is_memory_backup_filename(
            "MEMORY.bak-2026-03-31T21-17-05.md"
        ));
        assert!(is_memory_backup_filename(
            "MEMORY.pre-2026-03-31T21-17-05.md"
        ));
    }

    #[test]
    fn matches_artifact_filenames_from_ts_contract() {
        // Covers platform/daemon/src/memory-ingest-filter.test.ts:25-39.
        assert!(is_artifact_filename(
            "2026-03-01T00-09-52.500Z--eej6phr2ekkn46eo--summary.md"
        ));
        assert!(is_artifact_filename(
            "2026-03-01T00-09-52.500Z--o4ebayj7w4fs3grh--transcript.md"
        ));
        assert!(is_artifact_filename(
            "2026-03-25T08-06-26.000Z--abc12345--compaction.md"
        ));
        assert!(is_artifact_filename(
            "2026-03-01T00-09-53.500Z--o4ebayj7w4fs3grh--manifest.md"
        ));
    }

    #[test]
    fn leaves_user_memory_filenames_ingestable() {
        // Covers platform/daemon/src/memory-ingest-filter.test.ts:41-66.
        for filename in [
            "MEMORY.md",
            "2026-01-20.md",
            "2026-02-10-signet.md",
            "2026-02-22-dashboard-umap-projection-migration.md",
            "2026-03-01-phase-2-pre-compaction-capture-implementation-plan.md",
        ] {
            assert!(
                !is_memory_backup_filename(filename),
                "backup matched {filename}"
            );
            assert!(
                !is_artifact_filename(filename),
                "artifact matched {filename}"
            );
            assert!(!should_exclude_memory_ingest_filename(filename));
        }
    }

    #[test]
    fn applies_chunk_body_length_gate_from_ts_contract() {
        // Covers platform/daemon/src/memory-ingest-filter.test.ts:69-103.
        assert!(!should_ingest_memory_chunk(
            "## Section Title",
            "## Section Title"
        ));
        assert!(!should_ingest_memory_chunk(
            "## Section Title\n\nShort content here.",
            "## Section Title"
        ));
        assert!(should_ingest_memory_chunk(
            "## Section Title\n\nThis chunk contains a meaningful amount of content that describes the system configuration and behavior in enough detail to be useful.",
            "## Section Title"
        ));
        assert!(should_ingest_memory_chunk(
            "This standalone paragraph contains enough detail about the project's architecture to be worth storing as a memory.",
            ""
        ));
        assert!(!should_ingest_memory_chunk("Just a brief note.", ""));
    }
}
