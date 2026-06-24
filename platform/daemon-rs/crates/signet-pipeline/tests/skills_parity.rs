//! Skills parity tests ported from the TypeScript daemon tail corpus.
//!
//! These tests exercise source artifacts shared by the Rust pipeline package and
//! cite the TypeScript test ranges they replay.

#[test]
fn built_in_dreaming_skill_keeps_graph_first_ontology_contract() {
    // TS parity: platform/daemon/src/dreaming-skill.test.ts:5-31.
    let skill_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../skills/dreaming/SKILL.md");
    let content = std::fs::read_to_string(&skill_path).expect("read built-in dreaming skill");

    for required in [
        "name: dreaming",
        "Maintain Signet's living ontology and memory substrate",
        "transcripts, memory artifacts, source artifacts, notes, summaries, and imported",
        "entities, aspects, groups, claims, attributes, and links",
        "Apply first with provenance is the blanket rule",
        "recently saved memory artifacts",
        "flexible bulk ingestion",
        "Memory artifacts are evidence\nfor attributes",
        "source-attributed epistemic assertions",
        "source-backed memory artifacts",
        "not the API\n  `remember` endpoint",
        "signet ontology assertion create",
        "signet ontology assertion import --file assertions.json",
        "signet ontology entity merge \"Canonical Entity\"",
        "signet ontology entity merge-plan",
        "signet ontology stream apply ops.jsonl --json",
        "signet ontology stream apply proposals.jsonl --propose --json",
        "Use dry-run only when the operator asks",
        "pending proposals only for massive graph refactors",
        "Do not edit SQLite directly.",
        "Do not create pending proposals for normal dreaming or graph maintenance",
        "Do not call `/api/memory/remember`",
    ] {
        assert!(
            content.contains(required),
            "dreaming skill must retain graph-first clause: {required}"
        );
    }

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
