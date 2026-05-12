pub const DEFAULT_EMBEDDING_DIMENSIONS: usize = 768;

/// All valid dependency types for entity_dependencies.
pub const DEPENDENCY_TYPES: &[&str] = &[
    // core
    "uses",
    "requires",
    "owned_by",
    "owns",
    "blocks",
    "informs",
    "maintains",
    "implements",
    // knowledge
    "built",
    "depends_on",
    "related_to",
    "learned_from",
    "teaches",
    "knows",
    "assumes",
    "supports_claim",
    "authored_by",
    "links_to",
    // structural
    "contains",
    "contains_note",
    "contradicts",
    "supersedes",
    "part_of",
    "produced_artifact",
    // temporal / execution flow
    "precedes",
    "follows",
    "triggers",
    "may_execute",
    "requires_approval_from",
    // impact
    "impacts",
    "produces",
    "consumes",
];
pub const DEFAULT_HYBRID_ALPHA: f64 = 0.7;
pub const DEFAULT_REPLAY_WINDOW_MS: u64 = 5 * 60 * 1000;
pub const SCHEMA_VERSION: u32 = 3;
pub const SPEC_VERSION: &str = "1.0";
pub const SCHEMA_ID: &str = "signet/v1";
pub const DEFAULT_PORT: u16 = 3850;
pub const DEFAULT_HOST: &str = "localhost";

// Read pool size for concurrent readers
pub const READ_POOL_SIZE: u32 = 4;

// Writer channel capacities
pub const HIGH_PRIORITY_CAPACITY: usize = 64;
pub const LOW_PRIORITY_CAPACITY: usize = 256;
