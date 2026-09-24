use signet_core_native::{Core, CoreError, Operation};
use tempfile::tempdir;

fn core() -> (Core, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let core = Core::open(&dir.path().join("source-delete.sqlite"), 2).unwrap();
    (core, dir)
}

fn create(owner: &Core) {
    owner
        .submit(Operation::CreateSource {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            kind: "notes".into(),
            name: "source".into(),
            config: serde_json::json!({}),
            source_id: Some("source-id".into()),
        })
        .unwrap();
}

#[test]
fn both_delete_operations_are_scoped_to_the_requested_workspace() {
    for with_generation in [false, true] {
        let (owner, _dir) = core();
        create(&owner);
        let result = if with_generation {
            owner.submit(Operation::DeleteSourceWithGeneration {
                agent_id: "agent".into(),
                workspace_id: "other-workspace".into(),
                source_id: "source-id".into(),
                generation: None,
            })
        } else {
            owner.submit(Operation::DeleteSource {
                agent_id: "agent".into(),
                workspace_id: "other-workspace".into(),
                source_id: "source-id".into(),
            })
        };
        assert!(matches!(result, Err(CoreError::NotFound)));
        let sources = owner
            .submit(Operation::ListSources {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
            })
            .unwrap();
        assert_eq!(sources.as_array().unwrap().len(), 1);
        assert_eq!(sources[0]["id"], "source-id");
    }
}

#[test]
fn both_delete_operations_require_agent_and_fence_generation_and_pending_lease() {
    for with_generation in [false, true] {
        let (owner, _dir) = core();
        create(&owner);
        let missing_agent = if with_generation {
            owner.submit(Operation::DeleteSourceWithGeneration {
                agent_id: " ".into(),
                workspace_id: "workspace".into(),
                source_id: "source-id".into(),
                generation: None,
            })
        } else {
            owner.submit(Operation::DeleteSource {
                agent_id: " ".into(),
                workspace_id: "workspace".into(),
                source_id: "source-id".into(),
            })
        };
        assert!(matches!(missing_agent, Err(CoreError::InvalidInput(_))));
        let wrong_scope = if with_generation {
            owner.submit(Operation::DeleteSourceWithGeneration {
                agent_id: "other-agent".into(),
                workspace_id: "workspace".into(),
                source_id: "source-id".into(),
                generation: None,
            })
        } else {
            owner.submit(Operation::DeleteSource {
                agent_id: "other-agent".into(),
                workspace_id: "workspace".into(),
                source_id: "source-id".into(),
            })
        };
        assert!(matches!(wrong_scope, Err(CoreError::NotFound)));
        assert_eq!(
            owner
                .submit(Operation::ListSources {
                    agent_id: "agent".into(),
                    workspace_id: "workspace".into()
                })
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let stale = owner.submit(Operation::DeleteSourceWithGeneration {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            source_id: "source-id".into(),
            generation: Some(99),
        });
        assert!(matches!(stale, Err(CoreError::NotFound)));
        owner
            .submit(Operation::AcquireSourceRemovalLease {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
                source_id: "source-id".into(),
                generation: Some(0),
            })
            .unwrap();
        let deletion = if with_generation {
            owner.submit(Operation::DeleteSourceWithGeneration {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
                source_id: "source-id".into(),
                generation: Some(0),
            })
        } else {
            owner.submit(Operation::DeleteSource {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
                source_id: "source-id".into(),
            })
        };
        assert!(
            matches!(deletion, Err(CoreError::InvalidInput(message)) if message.contains("removal pending"))
        );
        assert_eq!(
            owner
                .submit(Operation::ListSources {
                    agent_id: "agent".into(),
                    workspace_id: "workspace".into()
                })
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}
