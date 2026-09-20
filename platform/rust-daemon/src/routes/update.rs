use crate::AppState;
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

const MAX_BODY: usize = 64 * 1024;

/// Update lifecycle is intentionally bounded until fresh Rust core operations
/// own durable configuration, release discovery, and installation.
fn unsupported(operation: &'static str) -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "success": false,
            "error": "unsupported",
            "errorCode": "unsupported",
            "message": format!("native {operation} is not supported by this installation"),
            "operation": operation,
            "supported": false,
            "restartRequired": false,
            "pendingVersion": Value::Null,
            "installMethod": Value::Null,
            "activeExecutableVerified": false,
        })),
    )
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/update/check", get(check))
        .route("/api/update/config", get(get_config).post(set_config))
        .route("/api/update/run", post(run))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY))
}

async fn check() -> impl IntoResponse {
    unsupported("update check")
}

async fn get_config() -> impl IntoResponse {
    unsupported("update configuration read")
}

async fn set_config(State(_state): State<AppState>) -> impl IntoResponse {
    unsupported("update configuration write")
}

async fn run() -> impl IntoResponse {
    unsupported("package update")
}
