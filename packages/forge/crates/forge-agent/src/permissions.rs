use forge_core::ToolPermission;
use tokio::sync::oneshot;

/// User's response to a permission request
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionResponse {
    /// Allow this one time
    Allow,
    /// Allow for the rest of this session
    AlwaysAllow,
    /// Deny execution
    Deny,
}

/// A permission request sent to the TUI, with a channel to receive the response
pub struct PermissionRequest {
    pub tool_name: String,
    pub tool_input: serde_json::Value,
    pub response_tx: oneshot::Sender<PermissionResponse>,
}

/// Manages tool permissions and approval
pub struct PermissionManager {
    /// Tools that are always auto-approved
    auto_approve: Vec<String>,
    /// Tools approved for this session (via "Always Allow")
    session_approved: Vec<String>,
}

impl PermissionManager {
    pub fn new(auto_approve: Vec<String>) -> Self {
        Self {
            auto_approve,
            session_approved: Vec::new(),
        }
    }

    /// Check if a tool is approved for execution without asking
    pub fn is_auto_approved(&self, tool_name: &str, permission: ToolPermission) -> bool {
        match permission {
            ToolPermission::ReadOnly => true,
            ToolPermission::Write => {
                self.auto_approve.contains(&tool_name.to_string())
                    || self.session_approved.contains(&tool_name.to_string())
            }
            ToolPermission::Dangerous => false,
        }
    }

    /// Mark a tool as approved for the remainder of this session
    pub fn approve_for_session(&mut self, tool_name: &str) {
        if !self.session_approved.contains(&tool_name.to_string()) {
            self.session_approved.push(tool_name.to_string());
        }
    }
}
