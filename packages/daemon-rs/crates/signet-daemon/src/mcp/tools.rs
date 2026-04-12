//! MCP tool definitions and execution.
//!
//! 23 built-in tools that delegate to daemon services.

use std::sync::Arc;

use super::protocol::{ToolCallResult, ToolDefinition};
use crate::feedback::parse_scores;
use crate::state::AppState;
use signet_core::db::Priority;

fn session_agent_id(session_key: &str) -> Option<String> {
    let mut parts = session_key.splitn(3, ':');
    if parts.next() != Some("agent") {
        return None;
    }
    let id = parts.next().unwrap_or("").trim();
    if id.is_empty() {
        return None;
    }
    Some(id.to_string())
}

fn resolve_agent_id(
    explicit: Option<&str>,
    session_key: Option<&str>,
) -> Result<String, String> {
    let bound = session_key.and_then(session_agent_id);
    let explicit = explicit.map(str::trim).filter(|s| !s.is_empty());
    if let Some(agent) = explicit {
        if let Some(bound) = bound.as_deref()
            && agent != bound
        {
            return Err("agent_id does not match session scope".to_string());
        }
        return Ok(agent.to_string());
    }
    if let Some(bound) = bound {
        return Ok(bound);
    }
    Ok("default".to_string())
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/// Build the complete list of MCP tool definitions.
pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        // Memory operations (7)
        ToolDefinition {
            name: "memory_search".into(),
            description: "Search memories using hybrid vector+keyword search".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query" },
                    "limit": { "type": "integer", "description": "Max results (default: 10)" },
                    "min_score": { "type": "number", "description": "Minimum relevance score" },
                    "type": { "type": "string", "description": "Filter by memory type" },
                },
                "required": ["query"],
            }),
        },
        ToolDefinition {
            name: "memory_store".into(),
            description: "Store a new memory".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "Memory content" },
                    "type": { "type": "string", "description": "Memory type" },
                    "importance": { "type": "number", "description": "Importance score 0-1" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "session_key": { "type": "string", "description": "Session key for scoped writes (agent:{id}:...)" },
                    "agent_id": { "type": "string", "description": "Agent id scope (requires matching session_key for non-default)" },
                    "visibility": { "type": "string", "enum": ["global", "private", "archived"], "description": "Memory visibility (requires session_key for non-default)" },
                    "scope": { "type": "string", "description": "Optional scope partition key (requires session_key when set)" },
                    "pinned": { "type": "boolean", "description": "Pin this memory — prevents decay, bypasses 0.95^days aging" },
                },
                "required": ["content"],
            }),
        },
        ToolDefinition {
            name: "memory_get".into(),
            description: "Retrieve a memory by ID".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Memory ID" },
                },
                "required": ["id"],
            }),
        },
        ToolDefinition {
            name: "memory_list".into(),
            description: "List memories with optional filters".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer" },
                    "offset": { "type": "integer" },
                    "type": { "type": "string" },
                    "sort": { "type": "string", "enum": ["created_at", "updated_at", "importance"] },
                },
            }),
        },
        ToolDefinition {
            name: "memory_modify".into(),
            description: "Modify an existing memory".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Memory ID" },
                    "content": { "type": "string", "description": "New content" },
                    "importance": { "type": "number" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "pinned": { "type": "boolean", "description": "Pin or unpin this memory" },
                },
                "required": ["id"],
            }),
        },
        ToolDefinition {
            name: "memory_forget".into(),
            description: "Soft-delete a memory".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Memory ID to forget" },
                },
                "required": ["id"],
            }),
        },
        ToolDefinition {
            name: "memory_feedback".into(),
            description: "Rate the relevance of a recalled memory".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "session_key": { "type": "string", "description": "Current session key" },
                    "agent_id": { "type": "string", "description": "Agent id scope (default: default)" },
                    "ratings": {
                        "type": "object",
                        "additionalProperties": { "type": "number" },
                        "description": "Map of memory ID to score (-1 to 1)"
                    },
                    "paths": {
                        "type": "object",
                        "description": "Optional path provenance keyed by memory id"
                    },
                    "rewards": {
                        "type": "object",
                        "description": "Optional reward signals keyed by memory id"
                    }
                },
                "required": ["session_key", "ratings"],
            }),
        },
        // Knowledge graph (1)
        ToolDefinition {
            name: "knowledge_expand".into(),
            description: "Expand knowledge about an entity from the graph".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "entity": { "type": "string", "description": "Entity name to expand" },
                    "depth": { "type": "integer", "description": "Traversal depth (default: 1)" },
                },
                "required": ["entity"],
            }),
        },
        // Cross-agent communication (3)
        ToolDefinition {
            name: "agent_peers".into(),
            description: "List active agent sessions".into(),
            input_schema: serde_json::json!({ "type": "object", "properties": {} }),
        },
        ToolDefinition {
            name: "agent_message_send".into(),
            description: "Send a structured message to another agent".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "Target session key" },
                    "type": { "type": "string", "enum": ["info", "question", "request", "response"] },
                    "content": { "type": "string" },
                },
                "required": ["to", "type", "content"],
            }),
        },
        ToolDefinition {
            name: "agent_message_inbox".into(),
            description: "Read inbound messages from other agents".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "since": { "type": "string", "description": "ISO timestamp filter" },
                    "limit": { "type": "integer" },
                },
            }),
        },
        // Secrets (2)
        ToolDefinition {
            name: "secret_list".into(),
            description: "List available secret names (not values)".into(),
            input_schema: serde_json::json!({ "type": "object", "properties": {} }),
        },
        ToolDefinition {
            name: "secret_exec".into(),
            description: "Execute a command with secrets injected as environment variables".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command to execute" },
                    "secrets": { "type": "array", "items": { "type": "string" }, "description": "Secret names to inject" },
                    "cwd": { "type": "string", "description": "Working directory" },
                },
                "required": ["command", "secrets"],
            }),
        },
        // MCP server management (9)
        ToolDefinition {
            name: "mcp_server_list".into(),
            description: "List installed MCP servers and their tools".into(),
            input_schema: serde_json::json!({ "type": "object", "properties": {} }),
        },
        ToolDefinition {
            name: "mcp_server_search".into(),
            description: "Search available MCP tools".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer" },
                },
                "required": ["query"],
            }),
        },
        ToolDefinition {
            name: "mcp_server_call".into(),
            description: "Invoke a tool on an external MCP server".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "server_id": { "type": "string" },
                    "tool_name": { "type": "string" },
                    "arguments": { "type": "object" },
                },
                "required": ["server_id", "tool_name"],
            }),
        },
        ToolDefinition {
            name: "mcp_server_enable".into(),
            description: "Enable an MCP server".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "server_id": { "type": "string" },
                },
                "required": ["server_id"],
            }),
        },
        ToolDefinition {
            name: "mcp_server_disable".into(),
            description: "Disable an MCP server".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "server_id": { "type": "string" },
                },
                "required": ["server_id"],
            }),
        },
        ToolDefinition {
            name: "mcp_server_scope_get".into(),
            description: "Get scope rules for an MCP server".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "server_id": { "type": "string" },
                },
                "required": ["server_id"],
            }),
        },
        ToolDefinition {
            name: "mcp_server_scope_set".into(),
            description: "Set scope rules for an MCP server".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "server_id": { "type": "string" },
                    "scope": { "type": "object" },
                },
                "required": ["server_id", "scope"],
            }),
        },
        ToolDefinition {
            name: "mcp_server_policy_get".into(),
            description: "Get MCP tool exposure policy".into(),
            input_schema: serde_json::json!({ "type": "object", "properties": {} }),
        },
        ToolDefinition {
            name: "mcp_server_policy_set".into(),
            description: "Update MCP tool exposure policy".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "mode": { "type": "string", "enum": ["compact", "hybrid", "expanded"] },
                    "max_search_results": { "type": "integer" },
                    "max_expanded_tools": { "type": "integer" },
                },
            }),
        },
        // Session management (1)
        ToolDefinition {
            name: "session_bypass".into(),
            description: "Toggle memory bypass for a session".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "session_key": { "type": "string" },
                    "enabled": { "type": "boolean" },
                },
                "required": ["session_key", "enabled"],
            }),
        },
    ]
}

/// Execute an MCP tool call. Delegates to daemon services.
pub async fn execute(
    state: &Arc<AppState>,
    name: &str,
    args: &serde_json::Value,
) -> ToolCallResult {
    match name {
        "memory_search" => exec_memory_search(state, args).await,
        "memory_store" => exec_memory_store(state, args).await,
        "memory_get" => exec_memory_get(state, args).await,
        "memory_list" => exec_memory_list(state, args).await,
        "memory_forget" => exec_memory_forget(state, args).await,
        "memory_feedback" => exec_memory_feedback(state, args).await,
        "session_bypass" => exec_session_bypass(state, args).await,
        // Tools that need further service integration
        "memory_modify"
        | "knowledge_expand"
        | "agent_peers"
        | "agent_message_send"
        | "agent_message_inbox"
        | "secret_list"
        | "secret_exec"
        | "mcp_server_list"
        | "mcp_server_search"
        | "mcp_server_call"
        | "mcp_server_enable"
        | "mcp_server_disable"
        | "mcp_server_scope_get"
        | "mcp_server_scope_set"
        | "mcp_server_policy_get"
        | "mcp_server_policy_set" => {
            ToolCallResult::error(format!("tool '{name}' not yet implemented in Rust daemon"))
        }
        _ => ToolCallResult::error(format!("unknown tool: {name}")),
    }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async fn exec_memory_search(state: &Arc<AppState>, args: &serde_json::Value) -> ToolCallResult {
    let query = match args.get("query").and_then(|v| v.as_str()) {
        Some(q) => q.to_string(),
        None => return ToolCallResult::error("missing required parameter: query"),
    };
    let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(10) as usize;

    let mem_type = args
        .get("type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let q = query.clone();
    let result = state
        .pool
        .read(move |conn| {
            let filter = signet_core::search::RecallFilter {
                memory_type: mem_type.as_deref(),
                ..Default::default()
            };
            let results = signet_core::search::fts_search(conn, &q, limit, &filter)?;
            // Convert to serializable form
            let hits: Vec<serde_json::Value> = results
                .iter()
                .map(|h| serde_json::json!({"id": h.id, "score": h.score}))
                .collect();
            Ok(hits)
        })
        .await;

    match result {
        Ok(hits) => {
            let json = serde_json::to_string_pretty(&hits).unwrap_or_default();
            ToolCallResult::success(json)
        }
        Err(e) => ToolCallResult::error(format!("search failed: {e}")),
    }
}

async fn exec_memory_store(state: &Arc<AppState>, args: &serde_json::Value) -> ToolCallResult {
    let content = match args.get("content").and_then(|v| v.as_str()) {
        Some(c) => c.to_string(),
        None => return ToolCallResult::error("missing required parameter: content"),
    };

    let mem_type = args
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("fact")
        .to_string();
    let importance = args
        .get("importance")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.5);
    let tags: Vec<String> = args
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let session_key = args
        .get("session_key")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let explicit_agent = args
        .get("agent_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let agent_id = match resolve_agent_id(explicit_agent, session_key.as_deref()) {
        Ok(id) => id,
        Err(err) => return ToolCallResult::error(err),
    };

    let visibility = match args.get("visibility").and_then(|v| v.as_str()) {
        None => "global".to_string(),
        Some(raw) => {
            let v = raw.trim().to_lowercase();
            if v == "global" || v == "private" || v == "archived" {
                v
            } else {
                return ToolCallResult::error(
                    "visibility must be one of: global, private, archived".to_string(),
                );
            }
        }
    };
    let scope = args
        .get("scope")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let pinned = args.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);
    if session_key.is_none() && (visibility != "global" || scope.is_some()) {
        return ToolCallResult::error(
            "non-default visibility/scope requires session_key".to_string(),
        );
    }
    let scoped = agent_id != "default" || visibility != "global" || scope.is_some();
    if scoped {
        let Some(key) = session_key.as_deref() else {
            return ToolCallResult::error("session_key is required".to_string());
        };
        if state.sessions.get_path(key).is_none() {
            return ToolCallResult::error("session_key is not active".to_string());
        }
        let Some(bound) = session_agent_id(key) else {
            return ToolCallResult::error("session_key must be agent scoped".to_string());
        };
        if agent_id != "default" && agent_id != bound {
            return ToolCallResult::error("agent_id does not match session scope".to_string());
        }
    }

    let result = state
        .pool
        .write(signet_core::db::Priority::High, move |conn| {
            let input = signet_services::transactions::IngestInput {
                content: &content,
                memory_type: &mem_type,
                tags,
                who: None,
                why: None,
                project: None,
                importance,
                pinned,
                source_type: None,
                source_id: None,
                idempotency_key: None,
                runtime_path: None,
                actor: "mcp-server",
                agent_id: &agent_id,
                visibility: &visibility,
                scope: scope.as_deref(),
            };
            let result = signet_services::transactions::ingest(conn, &input)?;
            Ok(serde_json::json!({
                "id": result.id,
                "hash": result.hash,
                "duplicate_of": result.duplicate_of,
            }))
        })
        .await;

    match result {
        Ok(val) => {
            let json = serde_json::to_string_pretty(&val).unwrap_or_default();
            ToolCallResult::success(json)
        }
        Err(e) => ToolCallResult::error(format!("store failed: {e}")),
    }
}

async fn exec_memory_get(state: &Arc<AppState>, args: &serde_json::Value) -> ToolCallResult {
    let id = match args.get("id").and_then(|v| v.as_str()) {
        Some(i) => i.to_string(),
        None => return ToolCallResult::error("missing required parameter: id"),
    };

    let mid = id.clone();
    let result = state
        .pool
        .read(move |conn| signet_core::queries::memory::get(conn, &mid))
        .await;

    match result {
        Ok(Some(mem)) => {
            let json = serde_json::to_string_pretty(&mem).unwrap_or_default();
            ToolCallResult::success(json)
        }
        Ok(None) => ToolCallResult::error(format!("memory not found: {id}")),
        Err(e) => ToolCallResult::error(format!("get failed: {e}")),
    }
}

async fn exec_memory_list(state: &Arc<AppState>, args: &serde_json::Value) -> ToolCallResult {
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(20) as usize;
    let offset = args.get("offset").and_then(|v| v.as_i64()).unwrap_or(0) as usize;
    let mem_type = args
        .get("type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let result = state
        .pool
        .read(move |conn| {
            signet_core::queries::memory::list(conn, mem_type.as_deref(), limit, offset)
        })
        .await;

    match result {
        Ok(memories) => {
            let json = serde_json::to_string_pretty(&memories).unwrap_or_default();
            ToolCallResult::success(json)
        }
        Err(e) => ToolCallResult::error(format!("list failed: {e}")),
    }
}

async fn exec_memory_forget(state: &Arc<AppState>, args: &serde_json::Value) -> ToolCallResult {
    let id = match args.get("id").and_then(|v| v.as_str()) {
        Some(i) => i.to_string(),
        None => return ToolCallResult::error("missing required parameter: id"),
    };

    let result = state
        .pool
        .write(signet_core::db::Priority::High, move |conn| {
            let input = signet_services::transactions::ForgetInput {
                id: &id,
                force: false,
                if_version: None,
                actor: "mcp-server",
                reason: None,
                actor_type: None,
            };
            let result = signet_services::transactions::forget(conn, &input)?;
            Ok(serde_json::json!({"result": format!("{result:?}")}))
        })
        .await;

    match result {
        Ok(val) => ToolCallResult::success(val.to_string()),
        Err(e) => ToolCallResult::error(format!("forget failed: {e}")),
    }
}

async fn exec_memory_feedback(state: &Arc<AppState>, args: &serde_json::Value) -> ToolCallResult {
    let session_key = match args.get("session_key").and_then(|v| v.as_str()) {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => return ToolCallResult::error("missing required parameter: session_key"),
    };
    let Some(ratings) = parse_scores(args.get("ratings")) else {
        return ToolCallResult::error(
            "invalid ratings: expected map of memory ID to score (-1 to 1)",
        );
    };
    let recorded = ratings.len() as i64;

    let result = state
        .pool
        .write(Priority::High, move |conn| {
            let mut stmt = conn.prepare_cached(
                "UPDATE session_memories
                 SET agent_relevance_score = CASE
                         WHEN agent_relevance_score IS NULL THEN ?1
                         ELSE (agent_relevance_score * agent_feedback_count + ?1) / (agent_feedback_count + 1)
                     END,
                     agent_feedback_count = COALESCE(agent_feedback_count, 0) + 1
                 WHERE session_key = ?2 AND memory_id = ?3",
            )?;
            let mut accepted = 0_i64;
            for (memory_id, score) in ratings {
                let changed = stmt.execute(rusqlite::params![score, session_key, memory_id])?;
                accepted += changed as i64;
            }
            Ok(serde_json::json!({ "accepted": accepted }))
        })
        .await;

    match result {
        Ok(val) => {
            let accepted = val.get("accepted").and_then(|v| v.as_i64()).unwrap_or(0);
            let body = serde_json::json!({
                "ok": true,
                "recorded": recorded,
                "accepted": accepted,
                "propagated": 0,
                "cooccurrenceUpdated": 0,
                "dependenciesUpdated": 0
            });
            let text = serde_json::to_string_pretty(&body).unwrap_or_default();
            ToolCallResult::success(text)
        }
        Err(e) => ToolCallResult::error(format!("feedback failed: {e}")),
    }
}

async fn exec_session_bypass(state: &Arc<AppState>, args: &serde_json::Value) -> ToolCallResult {
    let key = match args.get("session_key").and_then(|v| v.as_str()) {
        Some(k) => k,
        None => return ToolCallResult::error("missing required parameter: session_key"),
    };
    let key = key.strip_prefix("session:").unwrap_or(key);
    let enabled = args
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    if enabled {
        state.sessions.bypass(key);
    } else {
        state.sessions.unbypass(key);
    }
    let status = if enabled { "enabled" } else { "disabled" };
    ToolCallResult::success(format!("bypass {status} for session {key}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_count() {
        assert_eq!(definitions().len(), 23);
    }

    #[test]
    fn tool_names_unique() {
        let defs = definitions();
        let mut names: Vec<&str> = defs.iter().map(|t| t.name.as_str()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 23);
    }

    #[test]
    fn all_tools_have_schemas() {
        for tool in definitions() {
            assert!(
                tool.input_schema.is_object(),
                "tool {} missing schema",
                tool.name
            );
        }
    }

    #[test]
    fn memory_store_schema_includes_scoped_write_fields() {
        let defs = definitions();
        let tool = defs
            .iter()
            .find(|tool| tool.name == "memory_store")
            .expect("memory_store tool");
        let props = tool
            .input_schema
            .get("properties")
            .and_then(|value| value.as_object())
            .expect("memory_store.properties");
        assert!(props.contains_key("session_key"));
        assert!(props.contains_key("agent_id"));
        assert!(props.contains_key("visibility"));
        assert!(props.contains_key("scope"));
        assert!(props.contains_key("pinned"));
    }

    #[test]
    fn session_agent_id_parses_agent_session_key() {
        assert_eq!(
            session_agent_id("agent:alpha:sess-1").as_deref(),
            Some("alpha")
        );
        assert_eq!(session_agent_id("sess-1"), None);
    }

    #[test]
    fn resolve_agent_id_inherits_session_scope_when_missing() {
        let agent = resolve_agent_id(None, Some("agent:alpha:sess-1")).unwrap();
        assert_eq!(agent, "alpha");
    }

    #[test]
    fn resolve_agent_id_rejects_session_scope_mismatch() {
        let err = resolve_agent_id(Some("beta"), Some("agent:alpha:sess-1")).unwrap_err();
        assert_eq!(err, "agent_id does not match session scope");
    }
}
