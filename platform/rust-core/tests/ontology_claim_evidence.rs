use rusqlite::Connection;
use serde_json::Value;
use signet_core_native::{Core, OntologyClaimEvidenceRequest, Operation};
use tempfile::{tempdir, TempDir};

fn seeded() -> (Core, TempDir) {
    let dir = tempdir().unwrap();
    let path = dir.path().join("claim-evidence.sqlite");
    let core = Core::open(&path, 2).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "INSERT INTO entities(id,agent_id,workspace_id,name,status)
             VALUES('entity-a','agent-a','default','Ant','active');
             INSERT INTO entity_aspects(id,entity_id,agent_id,workspace_id,name,canonical_name,weight,status,created_at,updated_at)
             VALUES('aspect-a','entity-a','agent-a','default','Profile','profile',1.0,'active','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
             INSERT INTO entity_attributes(
                id,aspect_id,agent_id,workspace_id,memory_id,kind,content,normalized_content,
                group_key,claim_key,confidence,importance,status,superseded_by,version,
                version_root_id,previous_attribute_id,source_kind,source_id,source_path,
                source_root,created_at,updated_at,proposal_evidence
             ) VALUES
             ('attribute-current','aspect-a','agent-a','default',NULL,'attribute','Current','current',
              'general','status',0.99,0.9,'active',NULL,2,'attribute-old','attribute-old',
              'artifact','artifact-node',NULL,NULL,'2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','[]'),
             ('attribute-old','aspect-a','agent-a','default',NULL,'attribute','Old','old',
              'general','status',0.60,0.4,'superseded','attribute-current',1,'attribute-old',NULL,
              'artifact','artifact-node','/workspace/source.md',NULL,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','[]');
             INSERT INTO memory_artifacts(
                agent_id,source_path,source_sha256,source_kind,session_id,session_key,session_token,
                project,captured_at,source_node_id,content,updated_at
             ) VALUES(
                'agent-a','/workspace/source.md','sha-artifact','file','session-real','session-real','token-real',
                'project-a','2026-01-02T00:00:00Z','artifact-node','Artifact evidence content','2026-01-02T00:00:00Z'
             );",
        )
        .unwrap();
    drop(connection);
    (core, dir)
}

fn request(agent_id: &str) -> OntologyClaimEvidenceRequest {
    OntologyClaimEvidenceRequest {
        agent_id: agent_id.into(),
        entity: "Ant".into(),
        aspect: "Profile".into(),
        group_key: "General".into(),
        claim_key: "Status".into(),
        kind: Some("attribute".into()),
        status: None,
        limit: Some(20),
        offset: Some(0),
    }
}

fn run(
    core: &Core,
    request: OntologyClaimEvidenceRequest,
) -> Result<Value, signet_core_native::CoreError> {
    core.submit(Operation::OntologyClaimEvidence { request })
}

#[test]
fn claim_evidence_defaults_to_active_and_resolves_source() {
    let (core, _dir) = seeded();
    let result = run(&core, request("agent-a")).unwrap();
    assert_eq!(result["entity"]["id"], "entity-a");
    assert_eq!(result["aspect"]["id"], "aspect-a");
    assert_eq!(result["groupKey"], "General");
    assert_eq!(result["claimKey"], "Status");
    assert_eq!(result["count"], 1);
    assert_eq!(result["items"][0]["attribute"]["id"], "attribute-current");
    assert_eq!(result["items"][0]["evidenceCount"], 1);
    assert_eq!(result["items"][0]["evidence"][0]["kind"], "memory_artifact");
    assert_eq!(result["items"][0]["evidence"][0]["found"], true);
    assert_eq!(
        result["items"][0]["evidence"][0]["sourceId"],
        "session-real"
    );
}

#[test]
fn claim_evidence_all_status_paginates_old_and_new_rows() {
    let (core, _dir) = seeded();
    let mut all = request("agent-a");
    all.status = Some("all".into());
    all.limit = Some(1);
    let first = run(&core, all.clone()).unwrap();
    assert_eq!(first["count"], 1);
    assert_eq!(first["items"][0]["attribute"]["id"], "attribute-current");
    all.offset = Some(1);
    let second = run(&core, all).unwrap();
    assert_eq!(second["count"], 1);
    assert_eq!(second["items"][0]["attribute"]["id"], "attribute-old");
}

#[test]
fn claim_evidence_is_scoped_and_missing_paths_are_not_found() {
    let (core, _dir) = seeded();
    let error = run(&core, request("agent-b")).unwrap_err();
    assert!(error.to_string().contains("Claim path not found"));

    let mut missing = request("agent-a");
    missing.claim_key = "missing".into();
    let result = run(&core, missing).unwrap();
    assert_eq!(result["count"], 0);
}

#[test]
fn claim_evidence_rejects_invalid_filters() {
    let (core, _dir) = seeded();
    let mut invalid_kind = request("agent-a");
    invalid_kind.kind = Some("other".into());
    assert!(run(&core, invalid_kind)
        .unwrap_err()
        .to_string()
        .contains("kind is invalid"));

    let mut invalid_status = request("agent-a");
    invalid_status.status = Some("other".into());
    assert!(run(&core, invalid_status)
        .unwrap_err()
        .to_string()
        .contains("status is invalid"));
}
