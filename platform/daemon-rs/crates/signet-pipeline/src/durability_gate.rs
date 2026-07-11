//! Deterministic durability gate — Rust mirror of the TS `pipeline/durability-gate`.
//!
//! Rejects transient operational content (task progress, run/test status,
//! queue/process/resource counts, temporary paths, short-validity hedging,
//! self-diagnostics) before it is persisted as durable memory. Complements
//! the surprisal-based write gate, which cannot distinguish durable from
//! transient content. See issue #897.
//!
//! Matching is phrase-based (no regex dependency) and mirrors the TS gate on
//! the #897 regression matrix: the same transient inputs are rejected and the
//! same durable look-alikes are preserved.

#[derive(Debug, Clone, Copy)]
pub struct DurabilityConfig {
    pub enabled: bool,
}

impl Default for DurabilityConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurabilityReason {
    GateDisabled,
    DecisionType,
    TransientOperational,
    Durable,
}

#[derive(Debug, Clone)]
pub struct DurabilityResult {
    pub durable: bool,
    pub reason: DurabilityReason,
    pub category: Option<&'static str>,
}

/// Returns the transient category if `lower` (already lowercased) matches any.
fn transient_category(lower: &str) -> Option<&'static str> {
    // Temporary / runtime filesystem artifacts (NOT durable config paths).
    if lower.contains("/tmp/")
        || lower.contains("/var/folders/")
        || lower.contains("/private/tmp/")
        || lower.contains("$tmpdir/")
    {
        return Some("temporary_path");
    }
    if (lower.contains("runtime/") || lower.contains("temp/") || lower.contains("tmp/"))
        && (lower.contains(".log")
            || lower.contains(".pid")
            || lower.contains(".tmp")
            || lower.contains(".out"))
    {
        return Some("temporary_path");
    }

    // Queue / process / resource counts (operational state, goes stale fast).
    const QUEUE_NOUNS: &[&str] = &[
        "items", "tasks", "jobs", "messages", "requests", "rows", "records",
    ];
    const PROC_NOUNS: &[&str] = &["processes", "threads", "workers", "connections", "handlers"];
    const RESOURCES: &[&str] = &["cpu", "memory", "ram", "disk"];
    if QUEUE_NOUNS.iter().any(|n| lower.contains(n))
        && (lower.contains("queued")
            || lower.contains("pending")
            || lower.contains("backlogged")
            || lower.contains("in queue")
            || lower.contains("in the queue"))
    {
        return Some("queue_or_resource_count");
    }
    if PROC_NOUNS.iter().any(|n| lower.contains(n))
        && (lower.contains("running")
            || lower.contains("active")
            || lower.contains("connected")
            || lower.contains("spawned"))
    {
        return Some("queue_or_resource_count");
    }
    if RESOURCES.iter().any(|r| lower.contains(r))
        && (lower.contains("usage") || lower.contains("utilization"))
        && lower.contains('%')
    {
        return Some("queue_or_resource_count");
    }

    // Active run / test / command status.
    if lower.contains("test suite is") && lower.contains("running") {
        return Some("run_status");
    }
    if lower.contains("failures so far") || lower.contains("failure so far") {
        return Some("run_status");
    }
    if lower.contains("exit code") {
        return Some("run_status");
    }
    const RUNNING_NOW: &[&str] = &[
        "currently running",
        "currently executing",
        "currently building",
        "currently deploying",
        "currently compiling",
        "currently scanning",
    ];
    if RUNNING_NOW.iter().any(|p| lower.contains(p)) {
        return Some("run_status");
    }

    // In-progress work (unfinished, expected to change).
    if lower.contains("in progress") {
        return Some("in_progress");
    }
    if lower.contains("currently working on") {
        return Some("in_progress");
    }
    if lower.contains("% done") || lower.contains("% complete") || lower.contains("% finished") {
        return Some("in_progress");
    }
    if lower.contains("halfway") {
        return Some("in_progress");
    }

    // Short-validity hedging (the speaker signals it is not yet settled).
    const SHORT_VALIDITY: &[&str] = &[
        "still checking",
        "still verifying",
        "still investigating",
        "not sure yet",
        "tentatively",
        "pending confirmation",
        "to be determined",
        "to be confirmed",
        "tbd",
    ];
    if SHORT_VALIDITY.iter().any(|p| lower.contains(p)) {
        return Some("short_validity");
    }

    // Task progress / todo (forward-looking operational steps).
    const TASK_PROGRESS: &[&str] = &[
        "next i need to",
        "next we need to",
        "next i will",
        "next we will",
        "next i should",
        "next step is",
        "still need to",
    ];
    if TASK_PROGRESS.iter().any(|p| lower.contains(p)) {
        return Some("task_progress");
    }
    if lower.contains("todo:") || lower.contains("remaining:") || lower.contains("outstanding:") {
        return Some("task_progress");
    }

    // Self-diagnostic performance metrics about Signet itself during a session.
    const SIG_OPS: &[&str] = &[
        "recall",
        "search",
        "embedding",
        "extraction",
        "ingest",
        "query",
    ];
    const MEASURE: &[&str] = &["averaged", " was ", " of ", "around", "about"];
    if lower.contains("latency")
        && SIG_OPS.iter().any(|s| lower.contains(s))
        && MEASURE.iter().any(|m| lower.contains(m))
    {
        return Some("self_diagnostic");
    }
    if lower.contains("throughput")
        && (lower.contains("req/s") || lower.contains("ops/s") || lower.contains("qps"))
    {
        return Some("self_diagnostic");
    }

    None
}

/// Assess whether extracted content is durable enough to persist.
///
/// Decisions bypass (durable by definition; the write gate bypasses them too).
/// Everything else is classified by content. Deterministic and conservative.
pub fn assess_durability(
    content: &str,
    fact_type: &str,
    cfg: &DurabilityConfig,
) -> DurabilityResult {
    if !cfg.enabled {
        return DurabilityResult {
            durable: true,
            reason: DurabilityReason::GateDisabled,
            category: None,
        };
    }
    if fact_type == "decision" {
        return DurabilityResult {
            durable: true,
            reason: DurabilityReason::DecisionType,
            category: None,
        };
    }
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return DurabilityResult {
            durable: true,
            reason: DurabilityReason::Durable,
            category: None,
        };
    }
    let lower = trimmed.to_lowercase();
    match transient_category(&lower) {
        Some(category) => DurabilityResult {
            durable: false,
            reason: DurabilityReason::TransientOperational,
            category: Some(category),
        },
        None => DurabilityResult {
            durable: true,
            reason: DurabilityReason::Durable,
            category: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENABLED: DurabilityConfig = DurabilityConfig { enabled: true };

    // Reject cases map 1:1 to issue #897's reported transient categories.
    const REJECT: &[(&str, &str)] = &[
        (
            "temporary_path",
            "Scan output was written to /tmp/signet-audit-7f3a.log",
        ),
        (
            "temporary_path",
            "The runtime trace is at /var/folders/xx/run-42.log",
        ),
        (
            "queue_or_resource_count",
            "There are 5 items currently queued for processing",
        ),
        (
            "queue_or_resource_count",
            "8 background processes are running with 3 connections active",
        ),
        (
            "queue_or_resource_count",
            "Memory usage is at 72% during the indexing run",
        ),
        (
            "run_status",
            "The test suite is currently running with 3 failures so far",
        ),
        ("run_status", "The build currently exited with exit code 1"),
        (
            "in_progress",
            "The embedding backfill is in progress and about 60% done",
        ),
        (
            "in_progress",
            "Currently working on the auth refactor, halfway through",
        ),
        (
            "short_validity",
            "Still checking whether the migration is reversible",
        ),
        (
            "short_validity",
            "Tentatively, the fix might land in the next release",
        ),
        (
            "task_progress",
            "Next I need to debug the stale lease in worker.ts",
        ),
        (
            "task_progress",
            "TODO: wire the new gate into the Rust worker",
        ),
        (
            "self_diagnostic",
            "Recall latency averaged 140ms during this diagnostic session",
        ),
    ];

    // Durable look-alikes (paths, numbers, PRs, "tests/running") must survive.
    const PRESERVE: &[&str] = &[
        "Signet stores its database at $HOME/.agents/memory/memories.db",
        "The auth service uses PostgreSQL on port 5432",
        "Nicholai prefers to review PRs in small batches",
        "CI runs the full test suite on every push to main",
        "The team chose SQLite over Postgres for local state",
        "The daemon listens on port 3850 by default",
        "Bun compiles the native binary with --target=bun-darwin-arm64",
    ];

    #[test]
    fn rejects_transient_operational_content() {
        for (expected, content) in REJECT {
            let result = assess_durability(content, "fact", &ENABLED);
            assert!(!result.durable, "should reject: {content}");
            assert_eq!(result.reason, DurabilityReason::TransientOperational);
            assert_eq!(result.category, Some(*expected), "category for: {content}");
        }
    }

    #[test]
    fn preserves_durable_look_alikes() {
        for content in PRESERVE {
            let result = assess_durability(content, "fact", &ENABLED);
            assert!(result.durable, "should preserve: {content}");
            assert_eq!(result.reason, DurabilityReason::Durable);
        }
    }

    #[test]
    fn bypasses_for_decision_facts() {
        let result = assess_durability(
            "Decided to queue the release while the build is in progress",
            "decision",
            &ENABLED,
        );
        assert!(result.durable);
        assert_eq!(result.reason, DurabilityReason::DecisionType);
    }

    #[test]
    fn passes_everything_when_disabled() {
        let result = assess_durability(
            "There are 5 items currently queued for processing",
            "fact",
            &DurabilityConfig { enabled: false },
        );
        assert!(result.durable);
        assert_eq!(result.reason, DurabilityReason::GateDisabled);
    }

    #[test]
    fn treats_empty_content_as_durable() {
        let result = assess_durability("   ", "fact", &ENABLED);
        assert!(result.durable);
        assert_eq!(result.reason, DurabilityReason::Durable);
    }
}
