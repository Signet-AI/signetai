use signet_core_native::{Core, NewMemory, Operation};
use tempfile::{tempdir, TempDir};

struct TestCore {
    core: Core,
    _dir: TempDir,
}

impl TestCore {
    fn new() -> Self {
        let dir = tempdir().unwrap();
        let path = dir.path().join("recall.sqlite");
        let core = Core::open(&path, 2).unwrap();
        Self { core, _dir: dir }
    }
}

#[test]
fn recall_treats_like_wildcards_as_literal_substrings() {
    let fixture = TestCore::new();
    fixture
        .core
        .remember("agent", NewMemory::text("literal % marker"))
        .unwrap();
    fixture
        .core
        .remember("agent", NewMemory::text("literal _ marker"))
        .unwrap();
    fixture
        .core
        .remember("agent", NewMemory::text("literal \\ marker"))
        .unwrap();
    fixture
        .core
        .remember("agent", NewMemory::text("literal x marker"))
        .unwrap();

    assert_eq!(fixture.core.recall("agent", "%").unwrap().len(), 1);
    assert_eq!(fixture.core.recall("agent", "_").unwrap().len(), 1);
    assert_eq!(fixture.core.recall("agent", "\\").unwrap().len(), 1);
}

#[test]
fn operation_recall_treats_like_wildcards_as_literal_substrings() {
    let fixture = TestCore::new();
    for text in [
        "literal % marker",
        "literal _ marker",
        "literal \\ marker",
        "literal x marker",
    ] {
        fixture
            .core
            .remember("agent", NewMemory::text(text))
            .unwrap();
    }

    for query in ["%", "_", "\\"] {
        let result = fixture
            .core
            .submit(Operation::Recall {
                agent_id: "agent".into(),
                query: query.into(),
            })
            .unwrap();
        assert_eq!(result.as_array().unwrap().len(), 1, "query {query:?}");
    }
}
