use signet_pipeline::contradiction::parse_semantic_contradiction;
use signet_pipeline::prompt_text::{
    build_recall_query_shape, extract_substantive_words, query_anchors_missing_from_recall,
    strip_untrusted_metadata,
};

#[test]
fn prompt_text_strips_untrusted_metadata_json_envelopes() {
    let cleaned = strip_untrusted_metadata(
        "Conversation info (untrusted metadata):\n{\"conversation_label\":\"OpenClaw Session\",\"message_id\":\"msg_123\",\"sender_id\":\"user_456\"}\n\nCan you reiterate the release checklist?",
    );

    assert_eq!(cleaned, "Can you reiterate the release checklist?");
}

#[test]
fn prompt_text_extracts_substantive_words_without_mentions_or_stopwords() {
    let words = extract_substantive_words("<@123> Please inspect KA-6 pre-compaction behavior now");

    assert_eq!(
        words,
        vec![
            "ka-6",
            "pre-compaction",
            "inspect",
            "pre",
            "compaction",
            "behavior",
        ]
    );
}

#[test]
fn prompt_text_builds_recall_query_shape_from_cleaned_prompt_text() {
    let shape = build_recall_query_shape(
        "Conversation info (untrusted metadata):\n{\"channel\":\"discord\"}\n\nFind ultra-needle-transcript-only-5529931 please",
    );

    assert_eq!(
        shape.vector_query,
        "Find ultra-needle-transcript-only-5529931 please"
    );
    assert!(
        shape
            .keyword_terms
            .contains(&"ultra-needle-transcript-only-5529931".to_string())
    );
    assert!(!shape.keyword_terms.contains(&"discord".to_string()));
}

#[test]
fn prompt_text_detects_missing_anchor_terms_in_recall_results() {
    assert!(!query_anchors_missing_from_recall(
        "locate ultra-needle-transcript-only-5529931",
        Vec::<&str>::new(),
    ));
    assert!(query_anchors_missing_from_recall(
        "locate ultra-needle-transcript-only-5529931",
        ["some unrelated memory"],
    ));
    assert!(!query_anchors_missing_from_recall(
        "locate ultra-needle-transcript-only-5529931",
        ["found ultra-needle-transcript-only-5529931 in the transcript"],
    ));
}

#[test]
fn contradiction_parser_parses_json_wrapped_in_explanatory_prose() {
    let result = parse_semantic_contradiction(
        "We should compare these carefully.\n{\"contradicts\": true, \"confidence\": 0.91, \"reasoning\": \"Default theme changed from dark to light.\"}\nThis is my final answer.",
    )
    .expect("contradiction payload should parse");

    assert!(result.detected);
    assert!((result.confidence - 0.91).abs() < f64::EPSILON);
    assert!(result.reasoning.contains("theme"));
}

#[test]
fn contradiction_parser_parses_fenced_json_with_trailing_commas() {
    let result = parse_semantic_contradiction(
        r#"```json
{
  "contradicts": false,
  "confidence": 0.8,
  "reasoning": "These statements are complementary.",
}
```"#,
    )
    .expect("contradiction payload should parse");

    assert!(!result.detected);
    assert!((result.confidence - 0.8).abs() < f64::EPSILON);
}

#[test]
fn contradiction_parser_prefers_final_object_over_earlier_examples() {
    let result = parse_semantic_contradiction(
        "Example: {\"contradicts\": false, \"confidence\": 0.2, \"reasoning\": \"example\"}\nFinal: {\"contradicts\": true, \"confidence\": 0.95, \"reasoning\": \"actual answer\"}",
    )
    .expect("contradiction payload should parse");

    assert!(result.detected);
    assert!((result.confidence - 0.95).abs() < f64::EPSILON);
    assert!(result.reasoning.contains("actual answer"));
}
