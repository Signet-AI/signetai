//! Compatibility routes for TS daemon API surfaces that are intentionally
//! lightweight in the Rust daemon until their backing subsystems are fully
//! native.

use std::sync::Arc;

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde_json::json;

use crate::state::AppState;

pub async fn inference_status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let extraction = state.extraction_state.read().await.clone();
    Json(json!({
        "status": "ok",
        "runtime": "rust",
        "router": {
            "initialized": true,
            "mode": extraction.as_ref().map(|s| s.status.as_str()).unwrap_or("disabled"),
            "effectiveProvider": extraction.as_ref().map(|s| s.effective.as_str()).unwrap_or("none"),
            "configuredProvider": extraction.as_ref().and_then(|s| s.configured.as_deref()).unwrap_or("none"),
        },
        "concurrency": {
            "execute": {"active": 0},
            "stream": {"active": 0}
        }
    }))
}

pub async fn inference_history() -> Json<serde_json::Value> {
    Json(json!({
        "enabled": false,
        "events": [],
        "summary": {"total": 0, "failures": 0, "fallbacks": 0, "cancelled": 0}
    }))
}

pub async fn inference_explain() -> impl IntoResponse {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "error": "inference execution is not configured in the Rust daemon",
            "details": null
        })),
    )
}

pub async fn inference_execute() -> impl IntoResponse {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "error": "inference execution is not configured in the Rust daemon",
            "details": null
        })),
    )
}

pub async fn inference_stream() -> impl IntoResponse {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "error": "inference streaming is not configured in the Rust daemon",
            "details": null
        })),
    )
}

pub async fn inference_request_delete() -> Json<serde_json::Value> {
    Json(json!({"ok": true, "cancelled": false}))
}
