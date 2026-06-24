//! Auth types for Signet daemon deployment modes.
//!
//! Modes: local (default, no auth), team (token-required),
//! hybrid (localhost free, remote requires token).

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Auth mode
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    #[default]
    Local,
    Team,
    Hybrid,
}

impl AuthMode {
    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "team" => Self::Team,
            "hybrid" => Self::Hybrid,
            _ => Self::Local,
        }
    }
}

// ---------------------------------------------------------------------------
// Token roles
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenRole {
    Admin,
    Operator,
    Agent,
    Readonly,
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Remember,
    Recall,
    Modify,
    Forget,
    Recover,
    Admin,
    Documents,
    Connectors,
    Diagnostics,
    Analytics,
}

// ---------------------------------------------------------------------------
// Token scope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenScope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
}

impl TokenScope {
    pub fn is_empty(&self) -> bool {
        self.project.is_none() && self.agent.is_none() && self.user.is_none()
    }
}

// ---------------------------------------------------------------------------
// Token claims
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenClaims {
    pub sub: String,
    pub scope: TokenScope,
    pub role: TokenRole,
    pub iat: i64,
    pub exp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Vec<Permission>>,
}

// ---------------------------------------------------------------------------
// Auth result
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AuthResult {
    pub authenticated: bool,
    pub claims: Option<TokenClaims>,
    pub error: Option<String>,
}

impl AuthResult {
    pub fn unauthenticated() -> Self {
        Self {
            authenticated: false,
            claims: None,
            error: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Policy decision
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PolicyDecision {
    pub allowed: bool,
    pub reason: Option<String>,
}

// ---------------------------------------------------------------------------
// Rate limit check
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct RateLimitCheck {
    pub allowed: bool,
    pub remaining: u64,
    pub reset_at: u64,
}
