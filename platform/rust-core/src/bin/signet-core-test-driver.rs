use serde_json::{Value, json};
use signet_core_native::{Core, Operation};
use std::{
    env,
    io::{self, BufRead, Write},
    path::PathBuf,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = env::args().nth(1).ok_or("database path required")?;
    let path = PathBuf::from(path);
    let core = Core::open(&path, 32)?;
    eprintln!(
        "backend=fresh-rust artifact=signet-core-test-driver process=direct-core pid={} account=driver",
        std::process::id()
    );
    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = serde_json::from_str(&line)?;
        let result = match request["op"].as_str() {
            Some("init") => {
                core.initialize()?;
                json!({"ok": true})
            }
            Some("remember") => core.submit(Operation::Remember {
                agent_id: request["agentId"].as_str().unwrap_or("default").into(),
                content: request["content"]
                    .as_str()
                    .ok_or("content required")?
                    .into(),
                metadata: request["metadata"].clone(),
            })?,
            Some("get") => core.submit(Operation::Get {
                agent_id: request["agentId"].as_str().unwrap_or("default").into(),
                id: request["id"].as_str().ok_or("id required")?.into(),
            })?,
            Some("ontologyContradictionList") => {
                core.submit(Operation::OntologyContradictionList {
                    request: signet_core_native::OntologyContradictionListRequest {
                        agent_id: request["agentId"].as_str().unwrap_or("default").into(),
                        entity: request["entity"].as_str().map(str::to_owned),
                        entity_id: request["entityId"].as_str().map(str::to_owned),
                        aspect_id: request["aspectId"].as_str().map(str::to_owned),
                        group_key: request["groupKey"].as_str().map(str::to_owned),
                        claim_key: request["claimKey"].as_str().map(str::to_owned),
                        source_id: request["sourceId"].as_str().map(str::to_owned),
                        status: request["status"].as_str().map(str::to_owned),
                        limit: request["limit"].as_u64().map(|value| value as usize),
                        offset: request["offset"].as_u64().map(|value| value as usize),
                    },
                })?
            }
            Some("ontologyContradictionGet") => {
                core.submit(Operation::OntologyContradictionGet {
                    request: signet_core_native::OntologyContradictionGetRequest {
                        agent_id: request["agentId"].as_str().unwrap_or("default").into(),
                        id: request["id"].as_str().ok_or("id required")?.into(),
                    },
                })?
            }
            Some("close") => break,
            _ => return Err("unknown operation".into()),
        };
        println!(
            "{}",
            serde_json::to_string(&json!({"ok": true, "result": result}))?
        );
        io::stdout().flush()?;
    }
    Ok(())
}
