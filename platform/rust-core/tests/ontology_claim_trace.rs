use rusqlite::{params, Connection};
use serde_json::{json, Value};
use signet_core_native::{Core, OntologyClaimTraceRequest, Operation};
use tempfile::{tempdir, TempDir};

fn request(project: Option<&str>, session_key: Option<&str>) -> OntologyClaimTraceRequest {
    OntologyClaimTraceRequest {
        agent_id: "agent-a".into(),
        entity: "Ant".into(),
        aspect: "Profile".into(),
        group_key: "general".into(),
        claim_key: "status".into(),
        kind: Some("attribute".into()),
        version_limit: Some(10),
        premise_limit: Some(10),
        reverse_limit: Some(10),
        max_depth: Some(2),
        session_key: session_key.map(str::to_owned),
        project: project.map(str::to_owned),
    }
}

fn seeded(evidence: Value, deleted: bool, derived_kind: &str) -> (Core, TempDir) {
    let dir = tempdir().unwrap();
    let path = dir.path().join("claim-trace.sqlite");
    let core = Core::open(&path, 2).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "INSERT INTO entities(id,agent_id,workspace_id,name,status) VALUES('entity-a','agent-a','default','Ant','active');
             INSERT INTO entity_aspects(id,entity_id,agent_id,workspace_id,name,canonical_name,weight,status,created_at,updated_at) VALUES('aspect-a','entity-a','agent-a','default','Profile','profile',1.0,'active',datetime('now'),datetime('now'));
             INSERT INTO memories(id,agent_id,content,metadata,deleted,created_at,updated_at,project,visibility,scope,memory_kind,is_deleted,source_type,source_id) VALUES('memory-current','agent-a','The canonical quote is stable.','{}',0,datetime('now'),datetime('now'),'project-a','global',NULL,'episodic',0,'note','memory-current');
             INSERT INTO memories(id,agent_id,content,metadata,deleted,created_at,updated_at,project,visibility,scope,memory_kind,is_deleted,source_type,source_id) VALUES('memory-old','agent-a','The old quote was superseded.','{}',0,datetime('now'),datetime('now'),'project-a','global',NULL,'episodic',0,'note','memory-old');
             INSERT INTO memories(id,agent_id,content,metadata,deleted,created_at,updated_at,project,visibility,scope,memory_kind,is_deleted,source_type,source_id) VALUES('memory-dependent','agent-a','A dependent derived claim.','{}',0,datetime('now'),datetime('now'),'project-a','global',NULL,'episodic',0,'note','memory-dependent');
             INSERT INTO entity_attributes(id,aspect_id,agent_id,workspace_id,memory_id,kind,content,normalized_content,group_key,claim_key,confidence,importance,status,superseded_by,version,version_root_id,previous_attribute_id,created_at,updated_at,proposal_evidence) VALUES('attribute-current','aspect-a','agent-a','default','memory-current','attribute','Stable','stable','general','status',0.99,0.9,'active',NULL,2,'attribute-old','attribute-old',datetime('now'),datetime('now'),'[]');
             INSERT INTO entity_attributes(id,aspect_id,agent_id,workspace_id,memory_id,kind,content,normalized_content,group_key,claim_key,confidence,importance,status,superseded_by,version,version_root_id,previous_attribute_id,created_at,updated_at,proposal_evidence) VALUES('attribute-old','aspect-a','agent-a','default','memory-old','attribute','Old','old','general','status',0.6,0.4,'superseded','attribute-current',1,'attribute-old',NULL,datetime('now','-1 minute'),datetime('now','-1 minute'),'[]');
             INSERT INTO entity_attributes(id,aspect_id,agent_id,workspace_id,memory_id,kind,content,normalized_content,group_key,claim_key,confidence,importance,status,superseded_by,version,version_root_id,previous_attribute_id,created_at,updated_at,proposal_evidence) VALUES('attribute-dependent','aspect-a','agent-a','default','memory-dependent','attribute','Dependent','dependent','general','dependent',0.8,0.5,'active',NULL,1,'attribute-dependent',NULL,datetime('now'),datetime('now'),'[]');
             INSERT INTO derived_memory_sources(derived_memory_id,source_kind,source_id,source_path,agent_id,created_at) VALUES('memory-current','memory', 'memory-current',NULL,'agent-a',datetime('now'));
             INSERT INTO derived_memory_sources(derived_memory_id,source_kind,source_id,source_path,agent_id,created_at) VALUES('memory-dependent','memory','memory-current',NULL,'agent-a',datetime('now'));
             INSERT INTO epistemic_assertions(id,agent_id,subject_entity_id,claim_attribute_id,predicate,content,normalized_content,asserted_at,confidence,evidence,status,created_by,created_at,updated_at) VALUES('assertion-deny','agent-a','entity-a','attribute-current','denies','A denial','a denial',datetime('now'),0.8,'[]','active','test',datetime('now'),datetime('now'));",
        )
        .unwrap();
    connection
        .execute(
            "UPDATE memories SET is_deleted=? WHERE id='memory-current'",
            [if deleted { 1 } else { 0 }],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE entity_attributes SET proposal_evidence=? WHERE id='attribute-current'",
            [evidence.to_string()],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE derived_memory_sources SET source_kind=? WHERE derived_memory_id='memory-current'",
            [derived_kind],
        )
        .unwrap();
    drop(connection);
    (core, dir)
}

fn run(
    core: &Core,
    req: OntologyClaimTraceRequest,
) -> Result<Value, signet_core_native::CoreError> {
    core.submit(Operation::OntologyClaimTrace { request: req })
}

fn add_artifact(dir: &TempDir, source_node_id: &str, source_path: &str) {
    let connection = Connection::open(dir.path().join("claim-trace.sqlite")).unwrap();
    connection
        .execute(
            "INSERT INTO memory_artifacts(
                agent_id,source_path,source_sha256,source_kind,session_id,session_key,session_token,
                project,captured_at,source_node_id,content,updated_at
             ) VALUES(?,?,?,?,?,?,?,?,datetime('now'),?,?,datetime('now'))",
            params![
                "agent-a",
                source_path,
                "sha-artifact",
                "file",
                "session-real",
                "session-real",
                "token-real",
                "project-a",
                source_node_id,
                "Artifact canonical quote."
            ],
        )
        .unwrap();
}

#[test]
fn owner_claim_trace_returns_history_premises_assertions_and_reverse_lineage() {
    let (core, _dir) = seeded(
        json!([{"source_ref":"memory:memory-current","quote":"canonical quote"}]),
        false,
        "memory",
    );
    let result = run(&core, request(Some("project-a"), None)).unwrap();
    assert_eq!(result["integrity"]["status"], "verified");
    assert_eq!(result["current"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["versions"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(result["premises"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["assertions"][0]["predicate"], "denies");
    assert_eq!(
        result["competing"]["contradictoryAssertions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        result["reverse"]["items"][0]["memoryId"],
        "memory-dependent"
    );
    assert!(result["traversal"]["bounded"].as_bool().unwrap());
}

#[test]
fn owner_claim_trace_rejects_project_and_session_scope_crossings() {
    let (core, _dir) = seeded(
        json!([{"source_ref":"memory:memory-current","quote":"canonical quote"}]),
        false,
        "memory",
    );
    let error = run(&core, request(Some("project-b"), None)).unwrap_err();
    assert!(error
        .to_string()
        .contains("outside the authorized project scope"));
}

#[test]
fn owner_claim_trace_rejects_quote_mismatch() {
    let (core, _dir) = seeded(
        json!([{"source_ref":"memory:memory-current","quote":"not present"}]),
        false,
        "memory",
    );
    let error = run(&core, request(None, None)).unwrap_err();
    assert!(error
        .to_string()
        .contains("quote does not match the immutable source"));
}

#[test]
fn owner_claim_trace_ignores_noncanonical_lineage_and_reports_deleted_state() {
    let (core, _dir) = seeded(json!([]), true, "ontology_proposal");
    let result = run(&core, request(None, None)).unwrap();
    assert_eq!(result["premises"]["items"].as_array().unwrap().len(), 0);
    assert_eq!(result["integrity"]["status"], "unverified");

    let (core, _dir) = seeded(
        json!([{"source_ref":"memory:memory-current","quote":"canonical quote"}]),
        true,
        "memory",
    );
    let result = run(&core, request(None, None)).unwrap();
    assert_eq!(result["integrity"]["status"], "invalidated");
    assert_eq!(
        result["premises"]["items"][0]["evidence"]["state"],
        "deleted"
    );
}

#[test]
fn owner_claim_trace_reports_reverse_truncation() {
    let (core, dir) = seeded(
        json!([{"source_ref":"memory:memory-current","quote":"canonical quote"}]),
        false,
        "memory",
    );
    let connection = Connection::open(dir.path().join("claim-trace.sqlite")).unwrap();
    connection
        .execute_batch(
            "INSERT INTO memories(id,agent_id,content,metadata,deleted,created_at,updated_at,project,visibility,scope,memory_kind,is_deleted,source_type,source_id) VALUES('memory-dependent-2','agent-a','A second dependent claim.','{}',0,datetime('now'),datetime('now'),'project-a','global',NULL,'episodic',0,'note','memory-dependent-2');
             INSERT INTO derived_memory_sources(derived_memory_id,source_kind,source_id,source_path,agent_id,created_at) VALUES('memory-dependent-2','memory','memory-current',NULL,'agent-a',datetime('now'));
             INSERT INTO memories(id,agent_id,content,metadata,deleted,created_at,updated_at,project,visibility,scope,memory_kind,is_deleted,source_type,source_id) VALUES('memory-null-visibility','agent-a','A null visibility claim.','{}',0,datetime('now'),datetime('now'),'project-a',NULL,NULL,'episodic',0,'note','memory-null-visibility');
             INSERT INTO derived_memory_sources(derived_memory_id,source_kind,source_id,source_path,agent_id,created_at) VALUES('memory-null-visibility','memory','memory-current',NULL,'agent-a',datetime('now'));",
        )
        .unwrap();
    let mut req = request(None, None);
    req.reverse_limit = Some(1);
    let result = run(&core, req).unwrap();
    assert_eq!(result["reverse"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["reverse"]["truncated"], true);

    let mut depth_limited = request(None, None);
    depth_limited.max_depth = Some(1);
    let result = run(&core, depth_limited).unwrap();
    assert_eq!(result["reverse"]["truncated"], true);
    assert_eq!(result["traversal"]["maxDepthReached"], 1);
    assert!(!result["reverse"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["memoryId"] == "memory-null-visibility"));
}

#[test]
fn owner_claim_trace_resolves_artifact_candidates_and_memory_session_links() {
    let (core, dir) = seeded(
        json!([
            {"source_ref":"memory:memory-current","quote":"canonical quote"},
            {"source_ref":"artifact:memory:artifact-node","quote":"Artifact canonical quote"}
        ]),
        false,
        "memory",
    );
    add_artifact(&dir, "artifact-node", "/workspace/source.md");
    add_artifact(&dir, "memory-current", "/workspace/linked.md");

    let mut artifact_request = request(Some("project-a"), None);
    let artifact_result = run(&core, artifact_request.clone()).unwrap();
    assert_eq!(artifact_result["integrity"]["status"], "verified");

    let mut session_request = request(Some("project-a"), Some("session-real"));
    session_request.claim_key = "status".into();
    let session_result = run(&core, session_request).unwrap();
    assert_eq!(session_result["integrity"]["status"], "verified");

    artifact_request.session_key = Some("session-wrong".into());
    let error = run(&core, artifact_request).unwrap_err();
    assert!(error
        .to_string()
        .contains("crosses the authorized session boundary"));
}

#[test]
fn owner_claim_trace_preserves_assertion_evidence_reference_shape() {
    let (core, dir) = seeded(
        json!([{"source_ref":"memory:memory-current","quote":"canonical quote"}]),
        false,
        "memory",
    );
    let connection = Connection::open(dir.path().join("claim-trace.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE epistemic_assertions SET evidence=? WHERE id='assertion-deny'",
            [r#"[{"source_ref":"memory:memory-current","quote":"canonical quote"}]"#],
        )
        .unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys=OFF;")
        .unwrap();
    connection
        .execute(
            "INSERT INTO epistemic_assertions(id,agent_id,subject_entity_id,claim_attribute_id,predicate,content,normalized_content,asserted_at,confidence,evidence,status,created_by,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                "assertion-orphan",
                "agent-a",
                "missing-entity",
                "attribute-current",
                "denies",
                "Orphan denial",
                "orphan denial",
                "2026-01-01T00:00:01Z",
                0.8,
                "[]",
                "active",
                "test",
                "2026-01-01T00:00:01Z",
                "2026-01-01T00:00:01Z"
            ],
        )
        .unwrap();
    let result = run(&core, request(None, None)).unwrap();
    let assertion_ids = result["assertions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|assertion| assertion["id"].as_str())
        .collect::<Vec<_>>();
    assert!(!assertion_ids.contains(&"assertion-orphan"));
    assert_eq!(
        result["competing"]["contradictoryAssertions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let reference = &result["assertions"][0]["evidenceRefs"][0];
    assert_eq!(reference["sourceKind"], "memory");
    assert_eq!(reference["sourceId"], "memory-current");
    assert_eq!(reference["quote"], "canonical quote");
    assert_eq!(reference["strict"], true);
    assert_eq!(
        reference["reference"]["source_ref"],
        "memory:memory-current"
    );
}

#[test]
fn owner_claim_trace_rejects_empty_claim_path() {
    let (core, _dir) = seeded(json!([]), false, "memory");
    let mut req = request(None, None);
    req.claim_key.clear();
    let error = run(&core, req).unwrap_err();
    assert!(error.to_string().contains("Claim path has no versions"));
}

#[test]
fn owner_claim_trace_marks_available_source_without_quote_unverified() {
    let (core, _dir) = seeded(
        json!([{"source_ref":"memory:memory-current"}]),
        false,
        "memory",
    );
    let result = run(&core, request(None, None)).unwrap();
    assert_eq!(
        result["premises"]["items"][0]["evidence"]["state"],
        "quote_unverified"
    );
    assert_eq!(result["integrity"]["status"], "unverified");
}

#[test]
fn owner_claim_trace_preserves_caller_path_keys() {
    let (core, _dir) = seeded(
        json!([{"source_ref":"memory:memory-current","quote":"canonical quote"}]),
        false,
        "memory",
    );
    let mut req = request(None, None);
    req.group_key = "General".into();
    req.claim_key = "Status".into();
    let result = run(&core, req).unwrap();
    assert_eq!(result["path"]["groupKey"], "General");
    assert_eq!(result["path"]["claimKey"], "Status");
}
