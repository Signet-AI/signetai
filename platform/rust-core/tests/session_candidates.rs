use rusqlite::Connection;
use serde_json::json;
use signet_core_native::{Core, Operation};
use tempfile::tempdir;

#[test]
fn session_candidates_are_scoped_idempotent_and_temporally_filtered() {
    let dir = tempdir().unwrap();
    let core = Core::open(&dir.path().join("memory.db"), 32).unwrap();
    core.initialize().unwrap();
    let memory = core.submit(Operation::Remember { agent_id: "agent-a".into(), content: "keep this memory".into(), metadata: json!({}) }).unwrap();
    let id = memory["id"].as_str().unwrap().to_string();
    let candidate = json!({"id": id, "source":"effective", "effScore":0.85, "finalScore":0.9, "pathJson":{"entity_ids":["e1"]}});
    let op = || Operation::SessionCandidatesRecord { agent_id:"agent-a".into(), workspace_id:"ws-a".into(), session_key:"session-a".into(), candidates:vec![candidate.clone()], injected_ids:vec![id.clone()] };
    core.submit(op()).unwrap();
    core.submit(op()).unwrap();
    let assembled = core.submit(Operation::SessionCandidatesAssemble { agent_id:"agent-a".into(), workspace_id:"ws-a".into(), session_key:"session-a".into(), token_budget:10 }).unwrap();
    assert_eq!(assembled["items"].as_array().unwrap().len(), 1);
    assert_eq!(assembled["items"][0]["effectiveScore"], json!(0.85));
    assert_eq!(assembled["items"][0]["wasInjected"], json!(1));
    assert_eq!(assembled["items"][0]["pathJson"], json!(r#"{"entity_ids":["e1"]}"#));
}

#[test]
fn session_candidates_preserve_ts_fields_and_budget_zero_is_empty() {
    let dir = tempdir().unwrap();
    let core = Core::open(&dir.path().join("memory.db"), 32).unwrap();
    core.initialize().unwrap();
    let memory = core.submit(Operation::Remember { agent_id: "agent-a".into(), content: "one two three".into(), metadata: json!({}) }).unwrap();
    let id = memory["id"].as_str().unwrap().to_string();
    core.submit(Operation::SessionCandidatesRecord {
        agent_id: "agent-a".into(), workspace_id: "ws-a".into(), session_key: "session-a".into(),
        candidates: vec![json!({"id":id,"source":"effective","effScore":0.4,"finalScore":0.5,"relevanceScore":0.7,"ftsHitCount":2,"entitySlot":1,"aspectSlot":2,"isConstraint":true,"structuralDensity":3,"predictorScore":0.2,"agentPreference":"prefer"})], injected_ids: vec![id.clone()]
    }).unwrap();
    let assembled = core.submit(Operation::SessionCandidatesAssemble { agent_id:"agent-a".into(), workspace_id:"ws-a".into(), session_key:"session-a".into(), token_budget:0 }).unwrap();
    assert!(assembled["items"].as_array().unwrap().is_empty());
    let assembled = core.submit(Operation::SessionCandidatesAssemble { agent_id:"agent-a".into(), workspace_id:"ws-a".into(), session_key:"session-a".into(), token_budget:10 }).unwrap();
    let item = &assembled["items"][0];
    assert_eq!(item["relevanceScore"], json!(0.7));
    assert_eq!(item["ftsHitCount"], json!(2));
    assert_eq!(item["entitySlot"], json!(1));
    assert_eq!(item["isConstraint"], json!(1));
}

#[test]
fn session_candidates_exclude_all_lifecycle_invalid_rows() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("memory.db");
    let core = Core::open(&path, 32).unwrap();
    core.initialize().unwrap();

    let remember = |content: &str, metadata: serde_json::Value| {
        core.submit(Operation::Remember {
            agent_id: "agent-a".into(),
            content: content.into(),
            metadata,
        })
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let live = remember("live memory", json!({}));
    let deleted = remember("deleted memory", json!({}));
    let stale = remember("stale memory", json!({"staleAt": "2025-01-01T00:00:00Z"}));
    let superseded = remember("superseded memory", json!({"supersededBy": "replacement"}));
    let aggregate = remember("aggregate projection", json!({"sourceType": "aggregate-recall"}));

    let candidates = [
        live.clone(),
        deleted.clone(),
        stale.clone(),
        superseded.clone(),
        aggregate.clone(),
    ]
        .into_iter()
        .map(|id| json!({"id": id, "source": "effective", "effScore": 0.9}))
        .collect();
    core.submit(Operation::SessionCandidatesRecord {
        agent_id: "agent-a".into(),
        workspace_id: "ws-a".into(),
        session_key: "session-lifecycle".into(),
        candidates,
        injected_ids: vec![
            live.clone(),
            deleted.clone(),
            stale.clone(),
            superseded.clone(),
            aggregate.clone(),
        ],
    })
    .unwrap();
    drop(core);

    let db = Connection::open(&path).unwrap();
    db.execute("UPDATE memories SET deleted = 1 WHERE id = ?", [&deleted])
        .unwrap();
    drop(db);

    let core = Core::open(&path, 32).unwrap();
    let assembled = core
        .submit(Operation::SessionCandidatesAssemble {
            agent_id: "agent-a".into(),
            workspace_id: "ws-a".into(),
            session_key: "session-lifecycle".into(),
            token_budget: 100,
        })
        .unwrap();
    let items = assembled["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["memoryId"], json!(live));
}

