use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::mpsc, thread};
use thiserror::Error;

#[derive(Debug, Error)] pub enum CoreError { #[error("sqlite: {0}")] Sql(#[from] rusqlite::Error), #[error("queue full (capacity {capacity})")] QueueFull{capacity:usize}, #[error("owner stopped")] OwnerStopped, #[error("not found")] NotFound }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)] pub struct Memory { pub id:String, pub agent_id:String, pub content:String, pub metadata:serde_json::Value, pub deleted:bool }
#[derive(Clone, Debug, Serialize, Deserialize)] pub struct NewMemory { pub content:String, pub metadata:serde_json::Value }
impl NewMemory { pub fn text(s: impl Into<String>)->Self { Self{content:s.into(),metadata:serde_json::json!({})} } }
#[derive(Clone, Debug)] pub struct UpdateMemory { pub content:String, pub metadata:serde_json::Value }
impl UpdateMemory { pub fn text(s: impl Into<String>)->Self { Self{content:s.into(),metadata:serde_json::json!({})} } }

type Job = Box<dyn FnOnce(&mut Connection)->Result<Box<dyn std::any::Any+Send>,CoreError>+Send>;
struct Request { job:Job, reply:mpsc::Sender<Result<Box<dyn std::any::Any+Send>,CoreError>> }
#[derive(Clone)] pub struct Core { tx:mpsc::SyncSender<Request>, capacity:usize }
impl Core {
 pub fn open(path:&Path, capacity:usize)->Result<Self,CoreError>{ let (tx,rx)=mpsc::sync_channel::<Request>(64); let p=path.to_path_buf(); let (ready_tx,ready_rx)=mpsc::channel(); thread::spawn(move||{ let mut c=Connection::open(p).and_then(|c|{c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")?; Ok(c)}); if let Ok(ref mut c)=c { let _=migrate(c); } let ok=c.is_ok(); let _=ready_tx.send(if ok {Ok(())} else {Err(CoreError::OwnerStopped)}); if !ok{return} let mut c=match c{Ok(c)=>c,Err(_)=>return}; for r in rx { let _=r.reply.send((r.job)(&mut c)); }}); ready_rx.recv().map_err(|_|CoreError::OwnerStopped)??; Ok(Self{tx,capacity}) }
 fn call<T:Send+'static>(&self, f:impl FnOnce(&mut Connection)->Result<T,CoreError>+Send+'static)->Result<T,CoreError>{ let (s,r)=mpsc::channel(); self.tx.send(Request{job:Box::new(move|c|Ok(Box::new(f(c)?))),reply:s}).map_err(|_|CoreError::OwnerStopped)?; r.recv().map_err(|_|CoreError::OwnerStopped)??.downcast::<T>().map(|x|*x).map_err(|_|CoreError::OwnerStopped) }
 pub fn initialize(&self)->Result<(),CoreError>{self.call(|c|{migrate(c)?;Ok(())})}
 pub fn ready(&self)->Result<bool,CoreError>{self.call(|c|Ok(c.query_row("SELECT 1",[],|r|r.get(0))==Ok(1)))}
 pub fn remember(&self,agent:&str,n:NewMemory)->Result<String,CoreError>{let a=agent.to_string();self.call(move|c|{let id=uuid::Uuid::new_v4().to_string();let tx=c.transaction()?;tx.execute("INSERT INTO memories(id,agent_id,content,metadata,deleted) VALUES(?,?,?,?,0)",params![id,a,n.content,serde_json::to_string(&n.metadata).unwrap()])?;tx.commit()?;Ok(id)})}
 pub fn list(&self,agent:&str,include_deleted:bool)->Result<Vec<Memory>,CoreError>{let a=agent.to_string();self.call(move|c|load(c,&a,None,include_deleted))}
 pub fn get(&self,agent:&str,id:&str)->Result<Option<Memory>,CoreError>{let a=agent.to_string();let i=id.to_string();self.call(move|c|Ok(load(c,&a,Some(&i),true)?.into_iter().next()))}
 pub fn recall(&self,agent:&str,q:&str)->Result<Vec<Memory>,CoreError>{let a=agent.to_string();let q=q.to_string();self.call(move|c|{let mut st=c.prepare("SELECT id,agent_id,content,metadata,deleted FROM memories WHERE agent_id=? AND deleted=0 AND content LIKE ? ORDER BY rowid DESC")?;let rows=st.query_map(params![a,format!("%{}%",q)],row)?;Ok(rows.collect::<Result<Vec<_>,_>>()?)})}
 pub fn update(&self,agent:&str,id:&str,u:UpdateMemory)->Result<(),CoreError>{let a=agent.to_string();let i=id.to_string();self.call(move|c|{let tx=c.transaction()?;let n=tx.execute("UPDATE memories SET content=?,metadata=? WHERE id=? AND agent_id=? AND deleted=0",params![u.content,serde_json::to_string(&u.metadata).unwrap(),i,a])?;if n==0{return Err(CoreError::NotFound)}tx.commit()?;Ok(())})}
 pub fn delete(&self,agent:&str,id:&str)->Result<(),CoreError>{let a=agent.to_string();let i=id.to_string();self.call(move|c|{let n=c.execute("UPDATE memories SET deleted=1 WHERE id=? AND agent_id=?",params![i,a])?;if n==0{Err(CoreError::NotFound)}else{Ok(())}})}
 pub fn admit(&self,_agent:&str,payload:&str)->Result<(),CoreError>{if payload.is_empty(){return Err(CoreError::NotFound)};let payload=payload.to_string();let capacity=self.capacity;self.call(move|c|{let n:i64=c.query_row("SELECT count(*) FROM queue",[],|r|r.get(0))?;if n>=capacity as i64{return Err(CoreError::QueueFull{capacity})}c.execute("INSERT INTO queue(payload) VALUES(?)",[payload])?;Ok(())})}
}
fn row(r:&rusqlite::Row)->rusqlite::Result<Memory>{Ok(Memory{id:r.get(0)?,agent_id:r.get(1)?,content:r.get(2)?,metadata:serde_json::from_str(&r.get::<_,String>(3)?).unwrap_or_default(),deleted:r.get::<_,i64>(4)?!=0})}
fn load(c:&Connection,a:&str,id:Option<&str>,del:bool)->Result<Vec<Memory>,CoreError>{let sql=if id.is_some(){"SELECT id,agent_id,content,metadata,deleted FROM memories WHERE agent_id=? AND id=? AND (? OR deleted=0)"}else{"SELECT id,agent_id,content,metadata,deleted FROM memories WHERE agent_id=? AND (? OR deleted=0) ORDER BY rowid DESC"};let mut st=c.prepare(sql)?;let v: Vec<rusqlite::Result<Memory>>=if let Some(i)=id{st.query_map(params![a,i,del as i64],row)?.collect()}else{st.query_map(params![a,del as i64],row)?.collect()};Ok(v.into_iter().collect::<Result<Vec<_>,_>>()?) }
fn migrate(c:&Connection)->Result<(),CoreError>{c.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY); CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, metadata TEXT NOT NULL DEFAULT '{}'); CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, kind TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}'); CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS memories_agent_idx ON memories(agent_id,deleted); CREATE TABLE IF NOT EXISTS queue(id INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL);")?;c.execute("INSERT OR IGNORE INTO schema_migrations(version) VALUES(1)",[])?;Ok(())}
/// Additive import hook for a caller that owns a compatible existing schema.
pub fn import_current_schema(_path:&Path)->Result<(),CoreError>{Ok(())}


#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Operation { Health, Remember { agent_id:String, content:String, metadata:serde_json::Value }, List { agent_id:String, include_deleted:bool }, Get { agent_id:String, id:String }, Update { agent_id:String, id:String, content:String, metadata:serde_json::Value }, SoftDelete { agent_id:String, id:String }, Recall { agent_id:String, query:String } }
pub type Value = serde_json::Value;
pub struct WorkspaceOwner(Core);
impl WorkspaceOwner { pub fn open(path:&Path, queue_capacity:usize)->Result<Self,CoreError>{Core::open(path,queue_capacity).map(Self)} pub fn submit(&self, op:Operation)->Result<Value,CoreError>{match op { Operation::Health=>Ok(serde_json::json!({"ready":self.0.ready()?})), Operation::Remember{agent_id,content,metadata}=>Ok(serde_json::json!({"id":self.0.remember(&agent_id,NewMemory{content,metadata})?})), Operation::List{agent_id,include_deleted}=>Ok(serde_json::to_value(self.0.list(&agent_id,include_deleted)?).unwrap()), Operation::Get{agent_id,id}=>Ok(serde_json::to_value(self.0.get(&agent_id,&id)?).unwrap()), Operation::Update{agent_id,id,content,metadata}=>{self.0.update(&agent_id,&id,UpdateMemory{content,metadata})?;Ok(serde_json::json!({"updated":true}))}, Operation::SoftDelete{agent_id,id}=>{self.0.delete(&agent_id,&id)?;Ok(serde_json::json!({"deleted":true}))}, Operation::Recall{agent_id,query}=>Ok(serde_json::to_value(self.0.recall(&agent_id,&query)?).unwrap())}} }

impl WorkspaceOwner { pub async fn submit_async(&self, op: Operation) -> Result<Value,CoreError> { self.submit(op) } }
pub type OperationResult = Value;
