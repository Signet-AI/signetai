use std::collections::HashMap;

use signet_pipeline::structured_evidence::{
    EvidenceCandidateInput, shape_by_facet_coverage, shape_structured_evidence,
};

fn candidate(id: &str) -> EvidenceCandidateInput {
    EvidenceCandidateInput {
        id: id.to_string(),
        ..EvidenceCandidateInput::default()
    }
}

// Port of platform/daemon/src/pipeline/structured-evidence.test.ts:5-13.
#[test]
fn structured_evidence_caps_traversal_only_below_anchored_evidence() {
    let mut swordfish = candidate("swordfish");
    swordfish.source = Some("traversal".to_string());
    swordfish.traversal = Some(1.0);

    let mut commute = candidate("commute");
    commute.source = Some("hybrid".to_string());
    commute.lexical = Some(0.6);
    commute.semantic = Some(0.7);
    commute.traversal = Some(0.3);

    let shaped = shape_structured_evidence(&[swordfish, commute]);

    assert_eq!(shaped.first().map(|row| row.id.as_str()), Some("commute"));
    assert!(
        shaped
            .iter()
            .find(|row| row.id == "swordfish")
            .is_some_and(|row| row.score <= 0.35)
    );
}

// Port of platform/daemon/src/pipeline/structured-evidence.test.ts:15-23.
#[test]
fn structured_evidence_lets_hint_rescue_class_to_instance_match() {
    let mut netflix = candidate("netflix");
    netflix.source = Some("hybrid".to_string());
    netflix.lexical = Some(0.85);
    netflix.semantic = Some(0.6);

    let mut spotify = candidate("spotify");
    spotify.source = Some("hint".to_string());
    spotify.lexical = Some(0.35);
    spotify.semantic = Some(0.6);
    spotify.hint = Some(1.0);

    let shaped = shape_structured_evidence(&[netflix, spotify]);

    assert_eq!(shaped.first().map(|row| row.id.as_str()), Some("spotify"));
    assert_eq!(shaped.first().map(|row| row.source.as_str()), Some("hint"));
}

// Port of platform/daemon/src/pipeline/structured-evidence.test.ts:25-33.
#[test]
fn structured_evidence_preserves_sec_structured_path_ranking_gains() {
    let mut social_justice = candidate("social-justice");
    social_justice.source = Some("hybrid".to_string());
    social_justice.lexical = Some(0.56);
    social_justice.hint = Some(0.73);
    social_justice.traversal = Some(0.9);
    social_justice.structured = Some(0.28);

    let mut virtual_coffee = candidate("virtual-coffee");
    virtual_coffee.source = Some("hybrid".to_string());
    virtual_coffee.lexical = Some(0.72);
    virtual_coffee.traversal = Some(0.9);
    virtual_coffee.structured = Some(0.82);

    let shaped = shape_structured_evidence(&[social_justice, virtual_coffee]);

    assert_eq!(
        shaped.first().map(|row| row.id.as_str()),
        Some("virtual-coffee")
    );
    assert_eq!(shaped.first().map(|row| row.source.as_str()), Some("sec"));
}

// Port of platform/daemon/src/pipeline/structured-evidence.test.ts:35-43.
#[test]
fn structured_evidence_strong_structured_only_beats_generic_semantic_neighbors() {
    let mut generic_streaming = candidate("generic-streaming");
    generic_streaming.source = Some("vector".to_string());
    generic_streaming.semantic = Some(0.82);

    let mut music_platform = candidate("music-platform");
    music_platform.source = Some("structured".to_string());
    music_platform.structured = Some(0.53);

    let shaped = shape_structured_evidence(&[generic_streaming, music_platform]);

    assert_eq!(
        shaped.first().map(|row| row.id.as_str()),
        Some("music-platform")
    );
    assert_eq!(
        shaped.first().map(|row| row.source.as_str()),
        Some("structured")
    );
}

// Port of platform/daemon/src/pipeline/structured-evidence.test.ts:45-53.
#[test]
fn structured_evidence_moderate_structured_matches_beat_lexical_advice_noise() {
    let mut mountain_trip = candidate("mountain-trip");
    mountain_trip.source = Some("hybrid".to_string());
    mountain_trip.lexical = Some(0.38);
    mountain_trip.semantic = Some(0.9);

    let mut virtual_coffee = candidate("virtual-coffee");
    virtual_coffee.source = Some("hybrid".to_string());
    virtual_coffee.semantic = Some(0.82);
    virtual_coffee.structured = Some(0.39);

    let shaped = shape_structured_evidence(&[mountain_trip, virtual_coffee]);

    assert_eq!(
        shaped.first().map(|row| row.id.as_str()),
        Some("virtual-coffee")
    );
    assert_eq!(shaped.first().map(|row| row.source.as_str()), Some("sec"));
}

// Port of platform/daemon/src/pipeline/structured-evidence.test.ts:55-71.
#[test]
fn structured_evidence_prefers_candidates_that_add_uncovered_query_facets() {
    let mut commute = candidate("commute");
    commute.lexical = Some(0.7);
    commute.semantic = Some(0.6);

    let mut duplicate = candidate("commute-duplicate");
    duplicate.lexical = Some(0.68);
    duplicate.semantic = Some(0.6);

    let mut routine = candidate("routine");
    routine.lexical = Some(0.62);
    routine.semantic = Some(0.6);

    let candidates = shape_structured_evidence(&[commute, duplicate, routine]);
    let content = HashMap::from([
        (
            "commute".to_string(),
            "daily commute to work takes thirty minutes".to_string(),
        ),
        (
            "commute-duplicate".to_string(),
            "work commute includes podcasts".to_string(),
        ),
        (
            "routine".to_string(),
            "morning routine takes one hour to get ready".to_string(),
        ),
    ]);

    let shaped = shape_by_facet_coverage("get ready and commute to work", &candidates, &content, 3);
    let first_two = shaped
        .iter()
        .take(2)
        .map(|row| row.id.as_str())
        .collect::<Vec<_>>();

    assert!(first_two.contains(&"routine"));
    assert!(first_two.contains(&"commute"));
}
