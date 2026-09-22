use signet_core_native::{Core, NewMemory};
use tempfile::tempdir;

fn core() -> Core {
    let dir = tempdir().unwrap();
    let path = dir.path().join("recall.sqlite");
    let _dir = Box::leak(Box::new(dir));
    Core::open(&path, 2).unwrap()
}

#[test]
fn recall_treats_like_wildcards_as_literal_substrings() {
    let core = core();
    core.remember("agent", NewMemory::text("literal % marker")).unwrap();
    core.remember("agent", NewMemory::text("literal _ marker")).unwrap();
    core.remember("agent", NewMemory::text(r"literal \ marker")).unwrap();
    core.remember("agent", NewMemory::text("literal x marker")).unwrap();

    assert_eq!(core.recall("agent", "%").unwrap().len(), 1);
    assert_eq!(core.recall("agent", "_").unwrap().len(), 1);
    assert_eq!(core.recall("agent", r"\").unwrap().len(), 1);
}
