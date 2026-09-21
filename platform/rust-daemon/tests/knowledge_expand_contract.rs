#[test]
fn session_expand_contract_is_registered_in_native_route_source() {
    let source = include_str!("../src/routes/knowledge.rs");
    assert!(source.contains("/api/knowledge/expand/session"));
    assert!(source.contains("entityName is required"));
    assert!(source.contains("KnowledgeSessionExpand"));
}
