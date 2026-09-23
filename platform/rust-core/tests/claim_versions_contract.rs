use serde_json::json;
use signet_core_native::{Core, CoreError, OntologyClaimVersionsRequest, Operation};

fn workspace() -> (tempfile::TempDir, Core) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    let core = Core::open(&path, 8).unwrap();
    core.initialize().unwrap();
    (dir, core)
}

fn create_path(
    core: &Core,
    agent_id: &str,
    entity_name: &str,
    aspect_name: &str,
) -> (String, String) {
    let entity = core
        .submit(Operation::KnowledgeEntityCreate {
            agent_id: agent_id.into(),
            workspace_id: "default".into(),
            name: entity_name.into(),
            entity_type: "person".into(),
            metadata: json!({}),
        })
        .unwrap();
    let entity_id = entity["id"].as_str().unwrap().to_owned();
    let aspect = core
        .submit(Operation::KnowledgeAspectCreate {
            agent_id: agent_id.into(),
            workspace_id: "default".into(),
            entity_id: entity_id.clone(),
            name: aspect_name.into(),
            weight: 0.5,
        })
        .unwrap();
    (entity_id, aspect["id"].as_str().unwrap().to_owned())
}

fn versions(
    core: &Core,
    agent_id: &str,
    entity: &str,
    aspect: &str,
    kind: Option<&str>,
) -> Result<serde_json::Value, CoreError> {
    core.submit(Operation::OntologyClaimVersions {
        request: OntologyClaimVersionsRequest {
            agent_id: agent_id.into(),
            entity: entity.into(),
            aspect: aspect.into(),
            group_key: " General ".into(),
            claim_key: "Favorite Color".into(),
            kind: kind.map(str::to_owned),
        },
    })
}

#[test]
fn claim_versions_resolve_canonical_keys_and_return_source_shape_through_owner() {
    let (_dir, core) = workspace();
    let (_entity_id, aspect_id) = create_path(&core, "agent-a", "Social Profile", "Personal Facts");
    let created = core
        .submit(Operation::KnowledgeAttributeCreate {
            agent_id: "agent-a".into(),
            workspace_id: "default".into(),
            aspect_id,
            kind: "attribute".into(),
            content: "Blue".into(),
            claim_key: Some("favorite_color".into()),
            group_key: Some("general".into()),
            confidence: 0.75,
            importance: 0.5,
            memory_id: None,
        })
        .unwrap();
    let created_id = created["id"].as_str().unwrap().to_owned();

    let result = versions(
        &core,
        "agent-a",
        " SOCIAL   PROFILE ",
        "personal   facts",
        None,
    )
    .unwrap();
    assert_eq!(result["count"], 1);
    let item = &result["items"][0];
    assert_eq!(item["id"], created_id);
    assert_eq!(item["version"], 1);
    assert_eq!(item["versionRootId"], created_id);
    assert_eq!(item["previousAttributeId"], serde_json::Value::Null);
    assert_eq!(item["content"], "Blue");
    assert_eq!(item["status"], "active");
    assert_eq!(item["confidence"], 0.75);
    assert_eq!(item["proposalId"], serde_json::Value::Null);
    assert_eq!(item["sourceKind"], serde_json::Value::Null);
    assert_eq!(item["sourceId"], serde_json::Value::Null);
    assert_eq!(item["sourcePath"], serde_json::Value::Null);
    assert!(item["createdAt"].as_str().is_some());
    assert!(item["updatedAt"].as_str().is_some());
}

#[test]
fn claim_versions_default_to_attribute_and_preserve_constraint_kind_filter() {
    let (_dir, core) = workspace();
    let (_entity_id, aspect_id) = create_path(&core, "agent-a", "Person", "Facts");
    core.submit(Operation::KnowledgeAttributeCreate {
        agent_id: "agent-a".into(),
        workspace_id: "default".into(),
        aspect_id: aspect_id.clone(),
        kind: "constraint".into(),
        content: "Must be blue".into(),
        claim_key: Some("favorite_color".into()),
        group_key: Some("general".into()),
        confidence: 1.0,
        importance: 0.5,
        memory_id: None,
    })
    .unwrap();

    assert_eq!(
        versions(&core, "agent-a", "Person", "Facts", None).unwrap()["count"],
        0
    );
    assert_eq!(
        versions(&core, "agent-a", "Person", "Facts", Some("constraint")).unwrap()["count"],
        1
    );
}

#[test]
fn claim_versions_preserve_not_found_ambiguous_and_agent_scope_errors() {
    let (_dir, core) = workspace();
    let (entity_id, _aspect_id) = create_path(&core, "agent-a", "Person", "Facts");
    let _ = create_path(&core, "agent-a", "Person", "Other Facts");

    assert!(matches!(
        versions(&core, "agent-a", "Unknown", "Facts", None),
        Err(CoreError::NotFoundMessage(message)) if message == "Entity not found: Unknown"
    ));
    assert!(matches!(
        versions(&core, "agent-a", "Person", "Facts", None),
        Err(CoreError::Conflict(message)) if message == "Entity selector is ambiguous: Person. Use an id."
    ));
    assert!(matches!(
        versions(&core, "agent-b", &entity_id, "Facts", None),
        Err(CoreError::NotFoundMessage(message)) if message == format!("Entity not found: {entity_id}")
    ));
    assert!(matches!(
        versions(&core, "agent-a", &entity_id, "Unknown", None),
        Err(CoreError::NotFoundMessage(message)) if message == "Aspect not found: Unknown"
    ));
}

#[test]
fn claim_versions_reject_empty_claim_and_invalid_kind_at_owner_boundary() {
    let (_dir, core) = workspace();
    let (_entity_id, _aspect_id) = create_path(&core, "agent-a", "Person", "Facts");
    let empty_claim = core.submit(Operation::OntologyClaimVersions {
        request: OntologyClaimVersionsRequest {
            agent_id: "agent-a".into(),
            entity: "Person".into(),
            aspect: "Facts".into(),
            group_key: "general".into(),
            claim_key: "  ".into(),
            kind: Some("attribute".into()),
        },
    });
    assert!(matches!(
        empty_claim,
        Err(CoreError::InvalidInput(message)) if message == "claim is required"
    ));
    let invalid_kind = versions(&core, "agent-a", "Person", "Facts", Some("other"));
    assert!(matches!(
        invalid_kind,
        Err(CoreError::InvalidInput(message)) if message == "kind is invalid"
    ));
}
