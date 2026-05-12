//! Marketplace review routes.
//!
//! File-backed implementation matching the TypeScript daemon's local
//! marketplace review contract. This preserves review data in
//! `<SIGNET_PATH>/marketplace/{reviews.json,reviews-config.json}` so clients can
//! switch between TS and Rust daemon runtimes without data-shape drift.

use std::sync::{Arc, LazyLock, Mutex};

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};

use crate::state::AppState;
use crate::workspace_paths;

const REVIEWS_SYNC_URL: &str = "https://reviews.signetai.sh/api/reviews/sync";
static REVIEWS_FILE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketplaceReview {
    id: String,
    target_type: String,
    target_id: String,
    display_name: String,
    rating: i64,
    title: String,
    body: String,
    source: String,
    created_at: String,
    updated_at: String,
    synced_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewsSyncConfig {
    enabled: bool,
    endpoint_url: String,
    last_sync_at: Option<String>,
    last_sync_error: Option<String>,
}

impl Default for ReviewsSyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint_url: REVIEWS_SYNC_URL.to_string(),
            last_sync_at: None,
            last_sync_error: None,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ListReviewsQuery {
    #[serde(rename = "type")]
    target_type: Option<String>,
    id: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReviewBody {
    target_type: Option<String>,
    target_id: Option<String>,
    display_name: Option<String>,
    rating: Option<f64>,
    title: Option<String>,
    body: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchConfigBody {
    enabled: Option<bool>,
    endpoint_url: Option<String>,
}

fn reviews_path(state: &AppState) -> std::io::Result<std::path::PathBuf> {
    workspace_paths::child_file(&state.config.base_path, &["marketplace", "reviews.json"])
}

fn config_path(state: &AppState) -> std::io::Result<std::path::PathBuf> {
    workspace_paths::child_file(
        &state.config.base_path,
        &["marketplace", "reviews-config.json"],
    )
}

fn read_reviews(state: &AppState) -> Vec<MarketplaceReview> {
    let Ok(path) = reviews_path(state) else {
        return Vec::new();
    };
    // lgtm[rust/path-injection] reviews_path resolves a constant file under the canonical Signet workspace root via workspace_paths::child_file.
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<Vec<MarketplaceReview>>(&raw).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn write_reviews(state: &AppState, reviews: &[MarketplaceReview]) -> Result<(), String> {
    let path = reviews_path(state).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(reviews).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

fn read_config(state: &AppState) -> ReviewsSyncConfig {
    let Ok(path) = config_path(state) else {
        return ReviewsSyncConfig::default();
    };
    // lgtm[rust/path-injection] config_path resolves a constant file under the canonical Signet workspace root via workspace_paths::child_file.
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<ReviewsSyncConfig>(&raw).unwrap_or_default(),
        Err(_) => ReviewsSyncConfig::default(),
    }
}

fn write_config(state: &AppState, config: &ReviewsSyncConfig) -> Result<(), String> {
    let path = config_path(state).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

fn parse_target_type(value: Option<String>) -> Option<String> {
    match value.as_deref() {
        Some("skill") => Some("skill".to_string()),
        Some("mcp") => Some("mcp".to_string()),
        _ => None,
    }
}

fn parse_text(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn parse_rating(value: Option<f64>) -> Option<i64> {
    let rounded = value?.round();
    if (1.0..=5.0).contains(&rounded) {
        Some(rounded as i64)
    } else {
        None
    }
}

fn page_limit(raw: Option<usize>) -> usize {
    raw.unwrap_or(20).clamp(1, 100)
}

fn avg_rating(reviews: &[MarketplaceReview]) -> f64 {
    if reviews.is_empty() {
        return 0.0;
    }
    let total: i64 = reviews.iter().map(|r| r.rating).sum();
    ((total as f64 / reviews.len() as f64) * 100.0).round() / 100.0
}

/// GET /api/marketplace/reviews
pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListReviewsQuery>,
) -> Json<serde_json::Value> {
    let target_type = parse_target_type(query.target_type);
    let target_id = parse_text(query.id);
    let limit = page_limit(query.limit);
    let offset = query.offset.unwrap_or(0);

    let mut reviews = read_reviews(&state);
    reviews.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let filtered: Vec<MarketplaceReview> = reviews
        .into_iter()
        .filter(|item| {
            if target_type.as_ref().is_some_and(|t| &item.target_type != t) {
                return false;
            }
            if target_id.as_ref().is_some_and(|id| &item.target_id != id) {
                return false;
            }
            true
        })
        .collect();
    let page: Vec<MarketplaceReview> = filtered.iter().skip(offset).take(limit).cloned().collect();

    Json(serde_json::json!({
        "reviews": page,
        "total": filtered.len(),
        "limit": limit,
        "offset": offset,
        "summary": {"count": filtered.len(), "avgRating": avg_rating(&filtered)}
    }))
}

/// POST /api/marketplace/reviews
pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateReviewBody>,
) -> impl IntoResponse {
    let target_type = parse_target_type(body.target_type);
    let target_id = parse_text(body.target_id);
    let display_name = parse_text(body.display_name);
    let rating = parse_rating(body.rating);
    let title = parse_text(body.title);
    let review_body = parse_text(body.body);

    let (
        Some(target_type),
        Some(target_id),
        Some(display_name),
        Some(rating),
        Some(title),
        Some(review_body),
    ) = (
        target_type,
        target_id,
        display_name,
        rating,
        title,
        review_body,
    )
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                serde_json::json!({"error": "targetType, targetId, displayName, rating, title, and body are required"}),
            ),
        );
    };

    let now = chrono::Utc::now().to_rfc3339();
    let review = MarketplaceReview {
        id: uuid::Uuid::new_v4().to_string(),
        target_type,
        target_id,
        display_name,
        rating,
        title,
        body: review_body,
        source: "local".to_string(),
        created_at: now.clone(),
        updated_at: now,
        synced_at: None,
    };

    let _guard = match REVIEWS_FILE_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut reviews = read_reviews(&state);
    reviews.insert(0, review.clone());
    if let Err(e) = write_reviews(&state, &reviews) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({"success": true, "review": review})),
    )
}

/// GET /api/marketplace/reviews/config
pub async fn get_config(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let config = read_config(&state);
    let pending = read_reviews(&state)
        .iter()
        .filter(|item| {
            item.synced_at
                .as_ref()
                .map(|synced| item.updated_at > *synced)
                .unwrap_or(true)
        })
        .count();
    Json(serde_json::json!({
        "enabled": config.enabled,
        "endpointUrl": config.endpoint_url,
        "lastSyncAt": config.last_sync_at,
        "lastSyncError": config.last_sync_error,
        "pending": pending,
    }))
}

/// PATCH /api/marketplace/reviews/config
pub async fn patch_config(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PatchConfigBody>,
) -> impl IntoResponse {
    let current = read_config(&state);
    let next = ReviewsSyncConfig {
        enabled: body.enabled.unwrap_or(current.enabled),
        endpoint_url: body
            .endpoint_url
            .map(|s| s.trim().to_string())
            .unwrap_or(current.endpoint_url),
        last_sync_at: current.last_sync_at,
        last_sync_error: current.last_sync_error,
    };

    if let Err(e) = write_config(&state, &next) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({"success": true, "config": next})),
    )
}
