//! MCP JSON-RPC protocol types.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// JSON-RPC base types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<serde_json::Value>,
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl JsonRpcResponse {
    pub fn success(id: Option<serde_json::Value>, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Option<serde_json::Value>, code: i64, message: String) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message,
                data: None,
            }),
        }
    }

    pub fn method_not_found(id: Option<serde_json::Value>, method: &str) -> Self {
        Self::error(id, -32601, format!("method not found: {method}"))
    }
}

// ---------------------------------------------------------------------------
// MCP protocol constants
// ---------------------------------------------------------------------------

pub const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

pub const SERVER_NAME: &str = "signet";

// JSON-RPC error codes
pub const PARSE_ERROR: i64 = -32700;
#[allow(dead_code)] // Available for future MCP error handling
pub const INVALID_REQUEST: i64 = -32600;
#[allow(dead_code)] // Available for future MCP error handling
pub const INTERNAL_ERROR: i64 = -32603;

// ---------------------------------------------------------------------------
// MCP types
// ---------------------------------------------------------------------------

/// MCP tool definition.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// MCP tool call result content.
#[derive(Debug, Clone, Serialize)]
pub struct ToolContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: String,
}

impl ToolContent {
    pub fn text(s: impl Into<String>) -> Self {
        Self {
            content_type: "text".into(),
            text: s.into(),
        }
    }
}

/// MCP tool call result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallResult {
    pub content: Vec<ToolContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

impl ToolCallResult {
    pub fn success(text: impl Into<String>) -> Self {
        Self {
            content: vec![ToolContent::text(text)],
            is_error: None,
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            content: vec![ToolContent::text(text)],
            is_error: Some(true),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_success_serializes() {
        let resp = JsonRpcResponse::success(Some(serde_json::json!(1)), serde_json::json!({}));
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["jsonrpc"], "2.0");
        assert_eq!(json["id"], 1);
        assert!(json.get("error").is_none());
    }

    #[test]
    fn response_error_serializes() {
        let resp = JsonRpcResponse::error(Some(serde_json::json!(1)), -32601, "not found".into());
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["error"]["code"], -32601);
    }

    #[test]
    fn tool_result_success() {
        let result = ToolCallResult::success("ok");
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["content"][0]["type"], "text");
        assert_eq!(json["content"][0]["text"], "ok");
        assert!(json.get("isError").is_none());
    }

    #[test]
    fn tool_result_error() {
        let result = ToolCallResult::error("failed");
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["isError"], true);
    }
}
