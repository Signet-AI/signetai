//! Skills parity tests ported from the TypeScript daemon tail corpus.
//!
//! These tests exercise source artifacts shared by the Rust pipeline package and
//! cite the TypeScript test ranges they replay.

#[test]
fn built_in_dreaming_skill_keeps_ingest_first_contract() {
    // TS parity: platform/daemon/src/dreaming-skill.test.ts.
    let skill_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../skills/dreaming/SKILL.md");
    let content = std::fs::read_to_string(&skill_path).expect("read built-in dreaming skill");

    // Identity + conceptual framing preserved across the re-point.
    for required in [
        "name: dreaming",
        "Maintain Signet's living ontology and memory substrate",
        "transcripts, memory artifacts, source artifacts, notes, summaries, and imported",
        "entities, aspects, groups, claims, attributes, and links",
        "Apply first with provenance is the blanket rule",
        "flexible bulk ingestion",
        "source-backed recall rows",
        // Ingest-first agentic workflow (the re-point from graph-first CLI).
        "signet ingest lease --agent",
        "signet ingest apply-plan",
        "--lease-token",
        "IngestPlan",
        "nothing to drain",
        "filePatches",
        "graphOps",
        // The full ontology op vocabulary is expressed as ingest graphOps now.
        "merge_entities",
        "set_claim_value",
        "create_entity",
        // Preserved guarantees asserted under the new ingest verbs.
        "pending proposals only for massive graph refactors",
        "flows through ingest apply",
        "Do not edit SQLite directly.",
        "Do not create pending proposals for normal dreaming or graph maintenance",
        "Do not call `/api/memory/remember`",
    ] {
        assert!(
            content.contains(required),
            "dreaming skill must retain ingest-first clause: {required}"
        );
    }

    // The old graph-first apply path must be gone — the runner no longer drives
    // `signet ontology stream apply` itself; the daemon applies the posted
    // IngestPlan.
    for removed in [
        "signet ontology stream apply ops.jsonl --json",
        "signet ontology stream apply proposals.jsonl --propose --json",
        "signet ontology assertion create",
        "signet ontology entity merge-plan",
    ] {
        assert!(
            !content.contains(removed),
            "dreaming skill must drop graph-first clause: {removed}"
        );
    }

    // Unsafe wording must not regress.
    for forbidden in [
        "Default mode is proposal-first",
        "proposal-first by default",
        "Start with `--dry-run`",
        "not to create JSON",
        "sqlite3 ",
        "UPDATE entity_attributes",
    ] {
        assert!(
            !content.contains(forbidden),
            "dreaming skill must not regress to unsafe/proposal-first wording: {forbidden}"
        );
    }
}
