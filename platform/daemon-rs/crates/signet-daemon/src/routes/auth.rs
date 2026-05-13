use std::sync::Arc;

use axum::{Json, extract::State};
use serde_json::{Value, json};

use crate::state::AppState;

/// GET /api/auth/whoami
///
/// Mirrors the TypeScript daemon's local-mode shape: unauthenticated callers
/// still receive a 200 with auth status, null claims, and the configured mode.
pub async fn whoami(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "authenticated": false,
        "claims": null,
        "mode": state.auth_mode,
    }))
}
