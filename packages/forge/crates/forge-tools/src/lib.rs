pub mod bash;
pub mod edit;
pub mod glob;
pub mod grep;
pub mod marketplace;
pub mod plugin;
pub mod read;
pub mod signet;
pub mod subagent;
pub mod webfetch;
pub mod websearch;
pub mod write;

use async_trait::async_trait;
use forge_core::{ToolCall, ToolDefinition, ToolPermission, ToolResult};
use std::sync::Arc;

/// Trait for built-in tool implementations
#[async_trait]
pub trait Tool: Send + Sync {
    /// Tool name (matches the name in ToolDefinition)
    fn name(&self) -> &str;

    /// Tool definition for the LLM
    fn definition(&self) -> ToolDefinition;

    /// Permission level required
    fn permission(&self) -> ToolPermission;

    /// Execute the tool with the given input
    async fn execute(&self, call: &ToolCall) -> ToolResult;
}

/// Get all built-in tool definitions
pub fn all_definitions() -> Vec<ToolDefinition> {
    all_tools().iter().map(|t| t.definition()).collect()
}

/// Get all built-in tool instances
pub fn all_tools() -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(bash::BashTool),
        Box::new(read::ReadTool),
        Box::new(write::WriteTool),
        Box::new(edit::EditTool),
        Box::new(glob::GlobTool),
        Box::new(grep::GrepTool),
        Box::new(websearch::WebSearchTool),
        Box::new(webfetch::WebFetchTool),
    ]
}

/// Get all tools including Signet daemon tools (when connected)
pub fn all_tools_with_signet(daemon_url: &str) -> Vec<Box<dyn Tool>> {
    let mut tools = all_tools();
    tools.push(Box::new(signet::MemorySearchTool { daemon_url: daemon_url.to_string() }));
    tools.push(Box::new(signet::MemoryStoreTool { daemon_url: daemon_url.to_string() }));
    tools.push(Box::new(signet::KnowledgeExpandTool { daemon_url: daemon_url.to_string() }));
    tools.push(Box::new(signet::SecretExecTool { daemon_url: daemon_url.to_string() }));
    tools
}

/// Get all tools including Signet tools and SubAgent (requires provider reference)
pub fn all_tools_with_subagent(
    daemon_url: &str,
    provider: Arc<dyn forge_provider::Provider>,
) -> Vec<Box<dyn Tool>> {
    let mut tools = all_tools_with_signet(daemon_url);
    tools.push(Box::new(subagent::SubAgentTool::new(provider)));
    tools
}

/// Get all tool definitions including Signet tools
pub fn all_definitions_with_signet(daemon_url: &str) -> Vec<ToolDefinition> {
    all_tools_with_signet(daemon_url).iter().map(|t| t.definition()).collect()
}

/// Get all tool definitions including Signet tools and SubAgent
pub fn all_definitions_with_subagent(
    daemon_url: &str,
    provider: Arc<dyn forge_provider::Provider>,
) -> Vec<ToolDefinition> {
    all_tools_with_subagent(daemon_url, provider)
        .iter()
        .map(|t| t.definition())
        .collect()
}

/// Find a tool by name (including Signet tools)
pub fn find_tool(name: &str) -> Option<Box<dyn Tool>> {
    all_tools().into_iter().find(|t| t.name() == name)
}

/// Find a tool by name with Signet tools
pub fn find_tool_with_signet(name: &str, daemon_url: &str) -> Option<Box<dyn Tool>> {
    all_tools_with_signet(daemon_url).into_iter().find(|t| t.name() == name)
}

/// Find a tool by name with Signet tools and SubAgent
pub fn find_tool_with_subagent(
    name: &str,
    daemon_url: &str,
    provider: Arc<dyn forge_provider::Provider>,
) -> Option<Box<dyn Tool>> {
    all_tools_with_subagent(daemon_url, provider)
        .into_iter()
        .find(|t| t.name() == name)
}
