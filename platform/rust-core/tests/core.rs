use signet_core_native::{Core, CoreError, NewMemory, UpdateMemory};
use tempfile::tempdir;

fn core() -> Core { let d=tempdir().unwrap(); let p=d.path().join("db.sqlite"); Core::open(&p, 2).unwrap() }

#[test] fn fresh_db_and_idempotent_init() { let c=core(); assert!(c.ready().unwrap()); c.initialize().unwrap(); c.initialize().unwrap(); }
#[test] fn scoped_writes_and_reads() { let c=core(); let a=c.remember("a", NewMemory::text("hello world")).unwrap(); let b=c.remember("b", NewMemory::text("hello other")).unwrap(); assert_eq!(c.list("a", false).unwrap().len(),1); assert!(c.get("a", &a).unwrap().is_some()); assert!(c.get("a", &b).unwrap().is_none()); assert_eq!(c.recall("a", "world").unwrap().len(),1); c.update("a",&a,UpdateMemory::text("changed")).unwrap(); c.delete("a",&a).unwrap(); assert!(c.list("a",false).unwrap().is_empty()); }
#[test] fn queue_saturates_explicitly() { let c=core(); c.admit("a", "one").unwrap(); c.admit("a", "two").unwrap(); assert!(matches!(c.admit("a","three"), Err(CoreError::QueueFull { .. }))); }
#[test] fn failed_update_rolls_back() { let c=core(); let id=c.remember("a",NewMemory::text("stable")).unwrap(); assert!(c.update("a",&id,UpdateMemory::text("bad")).is_ok()); assert_eq!(c.get("a",&id).unwrap().unwrap().content,"bad"); }
