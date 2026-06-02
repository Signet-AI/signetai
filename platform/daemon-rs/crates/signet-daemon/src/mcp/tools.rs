//! MCP tool definitions and execution.
//!
//! 23 built-in tools that delegate to daemon services.

use std::sync::Arc;

use super::protocol::{ToolCallResult, ToolDefinition};
use crate::feedback::parse_scores;
use crate::routes::{knowledge, marketplace, secrets};
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

fn resolve_agent_id(explicit: Option<&str>, session_key: Option<&str>) -> Result<String, String> {
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
                    "type": { "type": "string", "description": "New type" },
                    "importance": { "type": "number" },
                    "tags": { "type": "string", "description": "New tags (comma-separated)" },
                    "pinned": { "type": "boolean", "description": "Pin or unpin this memory" },
                    "reason": { "type": "string", "description": "Why this edit is being made" },
                },
                "required": ["id", "reason"],
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
                    "entity_name": { "type": "string", "description": "Entity name to expand" },
                    "aspect_filter": { "type": "string", "description": "Filter to a specific aspect by name substring" },
                    "question": { "type": "string", "description": "Question or context for the expansion" },
                    "max_tokens": { "type": "integer", "description": "Response budget in tokens" },
                    "agent_id": { "type": "string", "description": "Agent scope (default: default)" },
                },
                "required": ["entity_name"],
            }),
        },
        // Cross-agent communication (3)
        ToolDefinition {
            name: "agent_peers".into(),
            description: "List active agent sessions".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "agent_id": { "type": "string", "description": "Current agent id (default: default)" },
                    "session_key": { "type": "string", "description": "Current session key (excluded from peers)" },
                    "include_self": { "type": "boolean", "description": "Include sessions owned by the current agent" },
                    "project": { "type": "string", "description": "Optional project path filter" },
                    "limit": { "type": "integer", "description": "Max sessions to return" },
                },
            }),
        },
        ToolDefinition {
            name: "agent_message_send".into(),
            description: "Send a structured message to another agent".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "from_agent_id": { "type": "string", "description": "Sender agent id" },
                    "from_session_key": { "type": "string", "description": "Sender session key" },
                    "to_agent_id": { "type": "string", "description": "Target agent id" },
                    "to_session_key": { "type": "string", "description": "Target session key" },
                    "broadcast": { "type": "boolean", "description": "Broadcast to all active sessions" },
                    "type": { "type": "string", "enum": ["assist_request", "decision_update", "info", "question"] },
                    "content": { "type": "string" },
                    "via": { "type": "string", "enum": ["local", "acp"] },
                },
                "required": ["content"],
            }),
        },
        ToolDefinition {
            name: "agent_message_inbox".into(),
            description: "Read inbound messages from other agents".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "agent_id": { "type": "string", "description": "Recipient agent id (default: default)" },
                    "session_key": { "type": "string", "description": "Recipient session key" },
                    "since": { "type": "string", "description": "ISO timestamp filter" },
                    "limit": { "type": "integer" },
                    "include_sent": { "type": "boolean", "description": "Include messages sent by this agent" },
                    "include_broadcast": { "type": "boolean", "description": "Include broadcast messages" },
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
                    "secrets": {
                        "type": "object",
                        "additionalProperties": { "type": "string" },
                        "description": "Map of env var name to secret reference"
                    },
                    "timeoutSeconds": { "type": "integer", "description": "Maximum subprocess runtime" },
                },
                "required": ["command", "secrets"],
            }),
        },
        ToolDefinition {
            name: "secret_exec_status".into(),
            description: "Poll a queued secret_exec job by id".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "jobId": { "type": "string", "description": "Job id returned by secret_exec" },
                },
                "required": ["jobId"],
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
                    "tool": { "type": "string" },
                    "args": { "type": "object" },
                },
                "required": ["server_id", "tool"],
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
                    "harnesses": { "type": "array", "items": { "type": "string" } },
                    "workspaces": { "type": "array", "items": { "type": "string" } },
                    "channels": { "type": "array", "items": { "type": "string" } },
                },
                "required": ["server_id"],
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
        "memory_modify" => exec_memory_modify(state, args).await,
        "memory_forget" => exec_memory_forget(state, args).await,
        "memory_feedback" => exec_memory_feedback(state, args).await,
        "session_bypass" => exec_session_bypass(state, args).await,
        "agent_peers" => exec_agent_peers(state, args).await,
        "agent_message_send" => exec_agent_message_send(state, args).await,
        "agent_message_inbox" => exec_agent_message_inbox(state, args).await,
        "knowledge_expand" => exec_knowledge_expand(state, args).await,
        "secret_list" => exec_secret_list(state, args).await,
        "secret_exec" => exec_secret_exec(state, args).await,
        "secret_exec_status" => exec_secret_exec_status(state, args).await,
        "mcp_server_list" => exec_mcp_server_list(state, args).await,
        "mcp_server_search" => exec_mcp_server_search(state, args).await,
        "mcp_server_call" => exec_mcp_server_call(state, args).await,
        "mcp_server_enable" => exec_mcp_server_enabled(state, args, true).await,
        "mcp_server_disable" => exec_mcp_server_enabled(state, args, false).await,
        "mcp_server_scope_get" => exec_mcp_server_scope_get(state, args).await,
        "mcp_server_scope_set" => exec_mcp_server_scope_set(state, args).await,
        "mcp_server_policy_get" => exec_mcp_server_policy_get(state, args).await,
        "mcp_server_policy_set" => exec_mcp_server_policy_set(state, args).await,
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
    let pinned = args
        .get("pinned")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
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
                source_path: None,
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

async fn exec_memory_modify(state: &Arc<AppState>, args: &serde_json::Value) -> ToolCallResult {
    let id = match required_string(args, "id") {
        Ok(value) => value.to_string(),
        Err(error) => return error,
    };
    let reason = match required_string(args, "reason") {
        Ok(value) => value.to_string(),
        Err(error) => return error,
    };
    let content = match args.get("content") {
        Some(value) => match value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => Some(value.to_string()),
            None => return ToolCallResult::error("content must be a non-empty string"),
        },
        None => None,
    };
    let memory_type = match args.get("type") {
        Some(value) => match value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => Some(value.to_string()),
            None => return ToolCallResult::error("type must be a non-empty string"),
        },
        None => None,
    };
    let tags = match args.get("tags") {
        Some(value) if value.is_array() => Some(
            value
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|item| item.as_str().map(str::trim))
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>(),
        ),
        Some(value) => match value.as_str() {
            Some(raw) => Some(
                raw.split(',')
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>(),
            ),
            None => return ToolCallResult::error("tags must be a string or array of strings"),
        },
        None => None,
    };
    let importance = match args.get("importance") {
        Some(value) => match value.as_f64() {
            Some(value) if value.is_finite() => Some(value.clamp(0.0, 1.0)),
            _ => return ToolCallResult::error("importance must be a finite number"),
        },
        None => None,
    };
    let pinned = match args.get("pinned") {
        Some(value) => match value.as_bool() {
            Some(value) => Some(value),
            None => return ToolCallResult::error("pinned must be a boolean"),
        },
        None => None,
    };
    if content.is_none()
        && memory_type.is_none()
        && tags.is_none()
        && importance.is_none()
        && pinned.is_none()
    {
        return ToolCallResult::error(
            "at least one of content, type, tags, importance, pinned is required",
        );
    }
    let content_changed = content.is_some();
    let result = state
        .pool
        .write(Priority::High, move |conn| {
            let result = signet_services::transactions::modify(
                conn,
                &signet_services::transactions::ModifyInput {
                    id: &id,
                    content: content.as_deref(),
                    memory_type: memory_type.as_deref(),
                    tags,
                    importance,
                    pinned,
                    if_version: None,
                    actor: "mcp-server",
                    reason: Some(reason.as_str()),
                },
            )?;
            Ok(match result {
                signet_services::transactions::ModifyResult::Updated { new_version } => {
                    serde_json::json!({
                        "id": id,
                        "status": "updated",
                        "currentVersion": new_version - 1,
                        "newVersion": new_version,
                        "contentChanged": content_changed,
                    })
                }
                signet_services::transactions::ModifyResult::NoChanges => serde_json::json!({
                    "id": id,
                    "status": "no_changes",
                }),
                signet_services::transactions::ModifyResult::NotFound => serde_json::json!({
                    "id": id,
                    "status": "not_found",
                    "error": "Not found",
                }),
                signet_services::transactions::ModifyResult::Deleted => serde_json::json!({
                    "id": id,
                    "status": "deleted",
                    "error": "Cannot modify deleted memory",
                }),
                signet_services::transactions::ModifyResult::VersionConflict { current } => {
                    serde_json::json!({
                        "id": id,
                        "status": "version_conflict",
                        "currentVersion": current,
                        "error": "Version conflict",
                    })
                }
                signet_services::transactions::ModifyResult::DuplicateHash { existing_id } => {
                    serde_json::json!({
                        "id": id,
                        "status": "duplicate_content_hash",
                        "duplicateMemoryId": existing_id,
                        "error": "Duplicate content hash",
                    })
                }
            })
        })
        .await;

    match result {
        Ok(value) => ToolCallResult::success(pretty_json(value)),
        Err(error) => ToolCallResult::error(format!("modify failed: {error}")),
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

fn optional_trimmed_string(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

async fn exec_agent_peers(state: &Arc<AppState>, args: &serde_json::Value) -> ToolCallResult {
    let agent_id =
        optional_trimmed_string(args, "agent_id").unwrap_or_else(|| "default".to_string());
    let session_key = optional_trimmed_string(args, "session_key");
    let project = optional_trimmed_string(args, "project");
    let include_self = args
        .get("include_self")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let limit = args
        .get("limit")
        .and_then(|value| value.as_u64())
        .map(|value| value.clamp(1, 200) as usize)
        .unwrap_or(50);

    let result = state
        .pool
        .read(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT key, session_key, agent_id, harness, project, runtime_path, provider, started_at, last_seen_at
                   FROM agent_presence
                  WHERE (?1 IS NULL OR project = ?1)
                    AND (?2 IS NULL OR session_key != ?2)
                    AND (?3 = 1 OR agent_id IS NULL OR agent_id != ?4)
                  ORDER BY last_seen_at DESC
                  LIMIT ?5",
            )?;
            let rows = stmt
                .query_map(
                    rusqlite::params![
                        project,
                        session_key,
                        if include_self { 1_i64 } else { 0_i64 },
                        agent_id,
                        limit as i64
                    ],
                    |row| {
                        Ok(serde_json::json!({
                            "key": row.get::<_, String>(0)?,
                            "sessionKey": row.get::<_, Option<String>>(1)?,
                            "agentId": row.get::<_, Option<String>>(2)?,
                            "harness": row.get::<_, Option<String>>(3)?,
                            "project": row.get::<_, Option<String>>(4)?,
                            "runtimePath": row.get::<_, Option<String>>(5)?,
                            "provider": row.get::<_, Option<String>>(6)?,
                            "startedAt": row.get::<_, String>(7)?,
                            "lastSeenAt": row.get::<_, String>(8)?,
                        }))
                    },
                )?
                .filter_map(Result::ok)
                .collect::<Vec<_>>();
            Ok(serde_json::json!({
                "sessions": rows,
                "count": rows.len(),
            }))
        })
        .await;

    match result {
        Ok(value) => ToolCallResult::success(pretty_json(value)),
        Err(error) => ToolCallResult::error(format!("Peer list failed: {error}")),
    }
}

async fn exec_agent_message_send(
    state: &Arc<AppState>,
    args: &serde_json::Value,
) -> ToolCallResult {
    let via = optional_trimmed_string(args, "via").unwrap_or_else(|| "local".to_string());
    if via != "local" {
        return ToolCallResult::error("ACP relay is not supported by Rust daemon");
    }
    let content = match required_string(args, "content") {
        Ok(value) => value.to_string(),
        Err(error) => return error,
    };
    let msg_type = optional_trimmed_string(args, "type").unwrap_or_else(|| "info".to_string());
    if !matches!(
        msg_type.as_str(),
        "assist_request" | "decision_update" | "info" | "question"
    ) {
        return ToolCallResult::error(
            "type must be assist_request, decision_update, info, or question",
        );
    }
    let from_agent_id =
        optional_trimmed_string(args, "from_agent_id").unwrap_or_else(|| "default".to_string());
    let from_session_key = optional_trimmed_string(args, "from_session_key");
    let to_agent_id = optional_trimmed_string(args, "to_agent_id");
    let to_session_key = optional_trimmed_string(args, "to_session_key");
    let broadcast = args
        .get("broadcast")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !broadcast && to_agent_id.is_none() && to_session_key.is_none() {
        return ToolCallResult::error("to_agent_id, to_session_key, or broadcast is required");
    }

    let result = state
        .pool
        .write(Priority::High, move |conn| {
            let id = uuid::Uuid::new_v4().to_string();
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO agent_messages
                 (id, created_at, from_agent_id, from_session_key, to_agent_id, to_session_key, content, type, broadcast)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    id,
                    now,
                    from_agent_id,
                    from_session_key,
                    to_agent_id,
                    to_session_key,
                    content,
                    msg_type,
                    if broadcast { 1_i64 } else { 0_i64 }
                ],
            )?;
            Ok(serde_json::json!({
                "id": id,
                "createdAt": now,
                "fromAgentId": from_agent_id,
                "fromSessionKey": from_session_key,
                "toAgentId": to_agent_id,
                "toSessionKey": to_session_key,
                "content": content,
                "type": msg_type,
                "broadcast": broadcast,
                "via": "local",
            }))
        })
        .await;

    match result {
        Ok(value) => ToolCallResult::success(pretty_json(value)),
        Err(error) => ToolCallResult::error(format!("Send failed: {error}")),
    }
}

async fn exec_agent_message_inbox(
    state: &Arc<AppState>,
    args: &serde_json::Value,
) -> ToolCallResult {
    let agent_id =
        optional_trimmed_string(args, "agent_id").unwrap_or_else(|| "default".to_string());
    let session_key = optional_trimmed_string(args, "session_key");
    let since = optional_trimmed_string(args, "since");
    let include_sent = args
        .get("include_sent")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let include_broadcast = args
        .get("include_broadcast")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    let limit = args
        .get("limit")
        .and_then(|value| value.as_u64())
        .map(|value| value.clamp(1, 500) as usize)
        .unwrap_or(100);

    let result = state
        .pool
        .read(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, created_at, from_agent_id, from_session_key, to_agent_id, to_session_key, content, type, broadcast
                   FROM agent_messages
                  WHERE (?1 IS NULL OR created_at > ?1)
                    AND (
                      to_agent_id = ?2
                      OR (?3 IS NOT NULL AND to_session_key = ?3)
                      OR (?4 = 1 AND from_agent_id = ?2)
                      OR (?5 = 1 AND broadcast = 1)
                    )
                  ORDER BY created_at DESC
                  LIMIT ?6",
            )?;
            let rows = stmt
                .query_map(
                    rusqlite::params![
                        since,
                        agent_id,
                        session_key,
                        if include_sent { 1_i64 } else { 0_i64 },
                        if include_broadcast { 1_i64 } else { 0_i64 },
                        limit as i64,
                    ],
                    |row| {
                        Ok(serde_json::json!({
                            "id": row.get::<_, String>(0)?,
                            "createdAt": row.get::<_, String>(1)?,
                            "fromAgentId": row.get::<_, Option<String>>(2)?,
                            "fromSessionKey": row.get::<_, Option<String>>(3)?,
                            "toAgentId": row.get::<_, Option<String>>(4)?,
                            "toSessionKey": row.get::<_, Option<String>>(5)?,
                            "content": row.get::<_, String>(6)?,
                            "type": row.get::<_, String>(7)?,
                            "broadcast": row.get::<_, bool>(8)?,
                        }))
                    },
                )?
                .filter_map(Result::ok)
                .collect::<Vec<_>>();
            Ok(serde_json::json!({
                "items": rows,
                "count": rows.len(),
            }))
        })
        .await;

    match result {
        Ok(value) => ToolCallResult::success(pretty_json(value)),
        Err(error) => ToolCallResult::error(format!("Inbox read failed: {error}")),
    }
}

async fn exec_knowledge_expand(state: &Arc<AppState>, args: &serde_json::Value) -> ToolCallResult {
    let entity_name = args
        .get("entity_name")
        .or_else(|| args.get("entity"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(entity_name) = entity_name else {
        return ToolCallResult::error("missing required parameter: entity_name");
    };
    let agent_id = match resolve_agent_id(args.get("agent_id").and_then(|v| v.as_str()), None) {
        Ok(agent_id) => agent_id,
        Err(error) => return ToolCallResult::error(error),
    };
    let aspect_filter = args
        .get("aspect_filter")
        .or_else(|| args.get("aspect"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let max_tokens = args
        .get("max_tokens")
        .or_else(|| args.get("maxTokens"))
        .and_then(|value| value.as_u64())
        .map(|value| value.min(10_000) as usize)
        .unwrap_or(2000);

    match knowledge::expand_entity_value(
        state,
        agent_id,
        entity_name.to_string(),
        aspect_filter,
        max_tokens,
    )
    .await
    {
        Ok(value) => {
            if value.get("_code").and_then(|code| code.as_u64()) == Some(404) {
                let error = value
                    .get("error")
                    .and_then(|error| error.as_str())
                    .unwrap_or("Entity not found");
                return ToolCallResult::error(error);
            }
            ToolCallResult::success(pretty_json(value))
        }
        Err(error) => ToolCallResult::error(format!("Expand failed: {error}")),
    }
}

async fn exec_secret_list(state: &Arc<AppState>, _args: &serde_json::Value) -> ToolCallResult {
    ToolCallResult::success(pretty_json(serde_json::json!({
        "secrets": secrets::secret_names(state),
    })))
}

async fn exec_secret_exec(state: &Arc<AppState>, args: &serde_json::Value) -> ToolCallResult {
    let command = match required_string(args, "command") {
        Ok(value) => value.to_string(),
        Err(error) => return error,
    };
    let Some(secret_map) = args.get("secrets").and_then(|value| value.as_object()) else {
        return ToolCallResult::error("non-empty secrets map is required");
    };
    let secrets = secret_map
        .iter()
        .filter_map(|(key, value)| {
            value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| (key.clone(), value.to_string()))
        })
        .collect::<std::collections::HashMap<_, _>>();
    if secrets.len() != secret_map.len() || secrets.is_empty() {
        return ToolCallResult::error("non-empty secrets map is required");
    }
    let timeout_ms = args
        .get("timeoutSeconds")
        .and_then(|value| value.as_u64())
        .map(|seconds| seconds.saturating_mul(1000));

    match secrets::queue_secret_exec(
        state.clone(),
        secrets::ExecBody {
            command,
            secrets,
            cwd: None,
            timeout_ms,
        },
    )
    .await
    {
        Ok(job) => ToolCallResult::success(pretty_json(job)),
        Err((_status, body)) => {
            let error = body
                .get("error")
                .and_then(|value| value.as_str())
                .unwrap_or("secret exec failed");
            ToolCallResult::error(error)
        }
    }
}

async fn exec_secret_exec_status(
    state: &Arc<AppState>,
    args: &serde_json::Value,
) -> ToolCallResult {
    let job_id = args
        .get("jobId")
        .or_else(|| args.get("job_id"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(job_id) = job_id else {
        return ToolCallResult::error("missing required parameter: jobId");
    };
    match secrets::secret_exec_status_value(state, job_id).await {
        Some(job) => ToolCallResult::success(pretty_json(job)),
        None => ToolCallResult::error("secret exec job not found"),
    }
}

fn pretty_json(value: serde_json::Value) -> String {
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
}

fn required_string<'a>(args: &'a serde_json::Value, key: &str) -> Result<&'a str, ToolCallResult> {
    args.get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolCallResult::error(format!("missing required parameter: {key}")))
}

async fn exec_mcp_server_list(state: &Arc<AppState>, _args: &serde_json::Value) -> ToolCallResult {
    let servers = marketplace::load_servers(state);
    let mut tools = Vec::new();
    let mut health = Vec::new();
    for server in servers.iter().filter(|server| server.enabled) {
        let (server_tools, server_health) = marketplace::discover_server_tools(server).await;
        tools.extend(server_tools);
        health.push(server_health);
    }
    ToolCallResult::success(pretty_json(serde_json::json!({
        "count": tools.len(),
        "tools": tools,
        "servers": health,
        "policy": marketplace::load_policy(state),
    })))
}

async fn exec_mcp_server_search(state: &Arc<AppState>, args: &serde_json::Value) -> ToolCallResult {
    let query = match required_string(args, "query") {
        Ok(query) if query.len() >= 2 => query.to_string(),
        Ok(_) => return ToolCallResult::error("query must be at least 2 characters"),
        Err(error) => return error,
    };
    let policy = marketplace::load_policy(state);
    let limit = args
        .get("limit")
        .and_then(|value| value.as_u64())
        .map(|value| value.clamp(1, 50) as usize)
        .unwrap_or(policy.max_search_results as usize);
    let servers = marketplace::load_servers(state);
    let mut tools = Vec::new();
    for server in servers.iter().filter(|server| server.enabled) {
        tools.extend(marketplace::discover_server_tools(server).await.0);
    }
    let results = marketplace::rank_tools(tools, &query, limit);
    ToolCallResult::success(pretty_json(serde_json::json!({
        "query": query,
        "count": results.len(),
        "results": results,
        "promoted": args.get("promote").and_then(|value| value.as_bool()).unwrap_or(true),
        "mode": policy.mode,
        "maxExpandedTools": policy.max_expanded_tools,
    })))
}

async fn exec_mcp_server_call(state: &Arc<AppState>, args: &serde_json::Value) -> ToolCallResult {
    let server_id = match required_string(args, "server_id") {
        Ok(value) => value,
        Err(error) => return error,
    };
    let tool_name = match args
        .get("tool")
        .or_else(|| args.get("tool_name"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value,
        None => return ToolCallResult::error("missing required parameter: tool"),
    };
    let Some(server) = marketplace::load_servers(state)
        .into_iter()
        .find(|server| server.id == server_id && server.enabled)
    else {
        return ToolCallResult::error("Server not found, disabled, or out of scope");
    };
    let tool_args = args
        .get("args")
        .or_else(|| args.get("arguments"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    match marketplace::mcp_request(
        &server,
        "tools/call",
        serde_json::json!({
            "name": tool_name,
            "arguments": tool_args,
        }),
    )
    .await
    {
        Ok(result) => ToolCallResult::success(pretty_json(result)),
        Err(error) => ToolCallResult::error(format!("Tool server call failed: {error}")),
    }
}

async fn exec_mcp_server_enabled(
    state: &Arc<AppState>,
    args: &serde_json::Value,
    enabled: bool,
) -> ToolCallResult {
    let server_id = match required_string(args, "server_id") {
        Ok(value) => value,
        Err(error) => return error,
    };
    let mut servers = marketplace::load_servers(state);
    let Some(pos) = servers.iter().position(|server| server.id == server_id) else {
        return ToolCallResult::error(format!("server not found: {server_id}"));
    };
    servers[pos].enabled = enabled;
    servers[pos].updated_at = chrono::Utc::now().to_rfc3339();
    let server = servers[pos].clone();
    match marketplace::save_servers(state, &servers) {
        Ok(()) => ToolCallResult::success(pretty_json(serde_json::json!({
            "success": true,
            "server": server,
        }))),
        Err(error) => ToolCallResult::error(error),
    }
}

async fn exec_mcp_server_scope_get(
    state: &Arc<AppState>,
    args: &serde_json::Value,
) -> ToolCallResult {
    let servers = marketplace::load_servers(state);
    if let Some(server_id) = args
        .get("server_id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let Some(server) = servers.into_iter().find(|server| server.id == server_id) else {
            return ToolCallResult::error(format!("server not found: {server_id}"));
        };
        return ToolCallResult::success(pretty_json(serde_json::json!({ "server": server })));
    }
    let count = servers.len();
    ToolCallResult::success(pretty_json(serde_json::json!({
        "servers": servers,
        "count": count,
        "scoped": false,
        "context": {},
    })))
}

async fn exec_mcp_server_scope_set(
    state: &Arc<AppState>,
    args: &serde_json::Value,
) -> ToolCallResult {
    let server_id = match required_string(args, "server_id") {
        Ok(value) => value,
        Err(error) => return error,
    };
    let scope_value = args.get("scope").cloned().unwrap_or_else(|| {
        serde_json::json!({
            "harnesses": args.get("harnesses").cloned().unwrap_or_else(|| serde_json::json!([])),
            "workspaces": args.get("workspaces").cloned().unwrap_or_else(|| serde_json::json!([])),
            "channels": args.get("channels").cloned().unwrap_or_else(|| serde_json::json!([])),
        })
    });
    let mut servers = marketplace::load_servers(state);
    let Some(pos) = servers.iter().position(|server| server.id == server_id) else {
        return ToolCallResult::error(format!("server not found: {server_id}"));
    };
    servers[pos].scope = marketplace::normalize_scope(Some(&scope_value));
    servers[pos].updated_at = chrono::Utc::now().to_rfc3339();
    let server = servers[pos].clone();
    match marketplace::save_servers(state, &servers) {
        Ok(()) => ToolCallResult::success(pretty_json(serde_json::json!({
            "success": true,
            "server": server,
        }))),
        Err(error) => ToolCallResult::error(error),
    }
}

async fn exec_mcp_server_policy_get(
    state: &Arc<AppState>,
    _args: &serde_json::Value,
) -> ToolCallResult {
    ToolCallResult::success(pretty_json(serde_json::json!({
        "policy": marketplace::load_policy(state),
    })))
}

async fn exec_mcp_server_policy_set(
    state: &Arc<AppState>,
    args: &serde_json::Value,
) -> ToolCallResult {
    let mut policy = marketplace::load_policy(state);
    if let Some(mode) = args.get("mode").and_then(|value| value.as_str()) {
        if !matches!(mode, "compact" | "hybrid" | "expanded") {
            return ToolCallResult::error("mode must be compact, hybrid, or expanded");
        }
        policy.mode = mode.to_string();
    }
    if let Some(value) = args
        .get("max_expanded_tools")
        .or_else(|| args.get("maxExpandedTools"))
        .and_then(|value| value.as_u64())
    {
        policy.max_expanded_tools = value.min(100) as u32;
    }
    if let Some(value) = args
        .get("max_search_results")
        .or_else(|| args.get("maxSearchResults"))
        .and_then(|value| value.as_u64())
    {
        policy.max_search_results = value.clamp(1, 50) as u32;
    }
    policy.updated_at = chrono::Utc::now().to_rfc3339();
    match marketplace::save_policy(state, &policy) {
        Ok(()) => ToolCallResult::success(pretty_json(serde_json::json!({
            "success": true,
            "policy": policy,
        }))),
        Err(error) => ToolCallResult::error(error),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_count() {
        assert_eq!(definitions().len(), 24);
    }

    #[test]
    fn tool_names_unique() {
        let defs = definitions();
        let mut names: Vec<&str> = defs.iter().map(|t| t.name.as_str()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 24);
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
