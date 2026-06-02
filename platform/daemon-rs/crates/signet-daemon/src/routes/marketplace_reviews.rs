//! Marketplace review routes.
//!
//! File-backed implementation matching the TypeScript daemon's local
//! marketplace review contract. This preserves review data in
//! `<SIGNET_PATH>/marketplace/{reviews.json,reviews-config.json}` so clients can
//! switch between TS and Rust daemon runtimes without data-shape drift.

use std::{
    io::Write,
    net::SocketAddr,
    sync::{Arc, LazyLock, Mutex},
};

use axum::{
    Json,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::{
        middleware::{authenticate_headers, require_permission_guard},
        types::Permission,
    },
    state::AppState,
    workspace_paths,
};

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchReviewBody {
    display_name: Option<String>,
    rating: Option<f64>,
    title: Option<String>,
    body: Option<String>,
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

fn read_reviews(state: &AppState) -> Result<Vec<MarketplaceReview>, String> {
    let path = reviews_path(state).map_err(|e| e.to_string())?;
    // lgtm[rust/path-injection] reviews_path resolves a constant file under the canonical Signet workspace root via workspace_paths::child_file.
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<Vec<MarketplaceReview>>(&raw)
            .map_err(|e| format!("failed to parse reviews.json: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("failed to read reviews.json: {e}")),
    }
}

fn atomic_write_json(path: &std::path::Path, raw: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "marketplace path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "marketplace path has invalid file name".to_string())?;
    let tmp_name = format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    );
    let tmp_path = parent.join(tmp_name);

    let write_result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp_path)
            .map_err(|e| e.to_string())?;
        file.write_all(raw.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&tmp_path, path).map_err(|e| e.to_string())?;
        if let Ok(parent_dir) = std::fs::File::open(parent) {
            let _ = parent_dir.sync_all();
        }
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    write_result
}

fn write_reviews(state: &AppState, reviews: &[MarketplaceReview]) -> Result<(), String> {
    let path = reviews_path(state).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(reviews).map_err(|e| e.to_string())?;
    atomic_write_json(&path, &raw)
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
    atomic_write_json(&path, &raw)
}

fn validate_endpoint_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("endpointUrl must not be empty".to_string());
    }
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| "endpointUrl must be a valid HTTPS URL".to_string())?;
    if url.scheme() != "https" {
        return Err("endpointUrl must use https".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("endpointUrl must not include credentials".to_string());
    }
    if url.fragment().is_some() {
        return Err("endpointUrl must not include a fragment".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "endpointUrl must include a host".to_string())?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return Err("endpointUrl must not target localhost".to_string());
    }
    if !host.eq_ignore_ascii_case("reviews.signetai.sh") {
        return Err("endpointUrl host must be reviews.signetai.sh".to_string());
    }
    let parsed_ip = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .ok();
    if let Some(ip) = parsed_ip {
        match ip {
            std::net::IpAddr::V4(ip) => {
                if ip.is_private()
                    || ip.is_loopback()
                    || ip.is_link_local()
                    || ip.is_unspecified()
                    || ip.is_broadcast()
                {
                    return Err(
                        "endpointUrl must not target a private or local address".to_string()
                    );
                }
            }
            std::net::IpAddr::V6(ip) => {
                if ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local()
                {
                    return Err(
                        "endpointUrl must not target a private or local address".to_string()
                    );
                }
            }
        }
    }
    Ok(url.to_string())
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
    let raw = value?;
    if !(1.0..=5.0).contains(&raw) {
        return None;
    }
    Some(raw.round() as i64)
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

fn require_authenticated_or_response(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    permission: Permission,
) -> Result<(), Response> {
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        headers,
        is_local,
    )
    .map_err(|resp| *resp)?;
    require_permission_guard(&auth, permission, auth_runtime.mode, is_local).map_err(|resp| *resp)
}

/// GET /api/marketplace/reviews
pub async fn list(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ListReviewsQuery>,
) -> Response {
    if let Err(resp) = require_authenticated_or_response(&state, peer, &headers, Permission::Recall)
    {
        return resp;
    }
    let target_type = parse_target_type(query.target_type);
    let target_id = parse_text(query.id);
    let limit = page_limit(query.limit);
    let offset = query.offset.unwrap_or(0);

    let mut reviews = match read_reviews(&state) {
        Ok(reviews) => reviews,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };
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

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "reviews": page,
            "total": filtered.len(),
            "limit": limit,
            "offset": offset,
            "summary": {"count": filtered.len(), "avgRating": avg_rating(&filtered)}
        })),
    )
        .into_response()
}

/// POST /api/marketplace/reviews
pub async fn create(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CreateReviewBody>,
) -> Response {
    if let Err(resp) = require_authenticated_or_response(&state, peer, &headers, Permission::Modify)
    {
        return resp;
    }
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
        ).into_response();
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
    let mut reviews = match read_reviews(&state) {
        Ok(reviews) => reviews,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };
    reviews.insert(0, review.clone());
    if let Err(e) = write_reviews(&state, &reviews) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response();
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({"success": true, "review": review})),
    )
        .into_response()
}

/// GET /api/marketplace/reviews/config
pub async fn get_config(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_authenticated_or_response(&state, peer, &headers, Permission::Recall)
    {
        return resp;
    }
    let config = read_config(&state);
    let pending = read_reviews(&state)
        .unwrap_or_default()
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
    .into_response()
}

/// PATCH /api/marketplace/reviews/config
pub async fn patch_config(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<PatchConfigBody>,
) -> Response {
    if let Err(resp) = require_authenticated_or_response(&state, peer, &headers, Permission::Modify)
    {
        return resp;
    }
    let current = read_config(&state);
    let endpoint_url = if let Some(endpoint_url) = body.endpoint_url.as_deref() {
        match validate_endpoint_url(endpoint_url) {
            Ok(url) => url,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": error})),
                )
                    .into_response();
            }
        }
    } else {
        current.endpoint_url
    };

    let next = ReviewsSyncConfig {
        enabled: body.enabled.unwrap_or(current.enabled),
        endpoint_url,
        last_sync_at: current.last_sync_at,
        last_sync_error: current.last_sync_error,
    };

    if let Err(e) = write_config(&state, &next) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response();
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({"success": true, "config": next})),
    )
        .into_response()
}

/// PATCH /api/marketplace/reviews/:id
pub async fn patch_review(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PatchReviewBody>,
) -> Response {
    if let Err(resp) = require_authenticated_or_response(&state, peer, &headers, Permission::Modify)
    {
        return resp;
    }

    let _guard = match REVIEWS_FILE_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let reviews = match read_reviews(&state) {
        Ok(reviews) => reviews,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };
    let Some(existing) = reviews.iter().find(|item| item.id == id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Review not found"})),
        )
            .into_response();
    };

    let display_name = if body.display_name.is_some() {
        parse_text(body.display_name)
    } else {
        Some(existing.display_name.clone())
    };
    let rating = if body.rating.is_some() {
        parse_rating(body.rating)
    } else {
        Some(existing.rating)
    };
    let title = if body.title.is_some() {
        parse_text(body.title)
    } else {
        Some(existing.title.clone())
    };
    let review_body = if body.body.is_some() {
        parse_text(body.body)
    } else {
        Some(existing.body.clone())
    };

    let (Some(display_name), Some(rating), Some(title), Some(review_body)) =
        (display_name, rating, title, review_body)
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                serde_json::json!({"error": "displayName, rating, title, and body must be valid when provided"}),
            ),
        )
            .into_response();
    };

    let updated = MarketplaceReview {
        display_name,
        rating,
        title,
        body: review_body,
        updated_at: chrono::Utc::now().to_rfc3339(),
        synced_at: None,
        ..existing
    };
    let next: Vec<MarketplaceReview> = reviews
        .into_iter()
        .map(|item| if item.id == id { updated.clone() } else { item })
        .collect();
    if let Err(e) = write_reviews(&state, &next) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response();
    }
    Json(serde_json::json!({"success": true, "review": updated})).into_response()
}

/// DELETE /api/marketplace/reviews/:id
pub async fn delete_review(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(resp) = require_authenticated_or_response(&state, peer, &headers, Permission::Modify)
    {
        return resp;
    }

    let _guard = match REVIEWS_FILE_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let reviews = match read_reviews(&state) {
        Ok(reviews) => reviews,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };
    if !reviews.iter().any(|item| item.id == id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Review not found"})),
        )
            .into_response();
    }
    let next: Vec<MarketplaceReview> = reviews.into_iter().filter(|item| item.id != id).collect();
    if let Err(e) = write_reviews(&state, &next) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response();
    }
    Json(serde_json::json!({"success": true, "id": id})).into_response()
}

/// POST /api/marketplace/reviews/sync
pub async fn sync_reviews(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_authenticated_or_response(&state, peer, &headers, Permission::Modify)
    {
        return resp;
    }

    let config = read_config(&state);
    if !config.enabled || config.endpoint_url.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                serde_json::json!({"success": false, "error": "Review sync endpoint is not configured"}),
            ),
        )
            .into_response();
    }

    let reviews = match read_reviews(&state) {
        Ok(reviews) => reviews,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };
    let pending: Vec<MarketplaceReview> = reviews
        .iter()
        .filter(|item| {
            item.synced_at
                .as_ref()
                .map(|synced| item.updated_at > *synced)
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    if pending.is_empty() {
        return Json(serde_json::json!({
            "success": true,
            "sent": 0,
            "synced": 0,
            "message": "No pending reviews"
        }))
        .into_response();
    }

    let response = reqwest::Client::new()
        .post(&config.endpoint_url)
        .header("Content-Type", "application/json")
        .header("X-Signet-Sync", "1")
        .json(&serde_json::json!({
            "source": "signet-marketplace",
            "type": "reviews-sync",
            "sentAt": chrono::Utc::now().to_rfc3339(),
            "reviews": pending,
        }))
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            let message = error.to_string();
            let _ = write_config(
                &state,
                &ReviewsSyncConfig {
                    last_sync_error: Some(message.clone()),
                    ..config
                },
            );
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"success": false, "error": message})),
            )
                .into_response();
        }
    };

    if !response.status().is_success() {
        let error_text = format!("Sync endpoint returned HTTP {}", response.status().as_u16());
        let _ = write_config(
            &state,
            &ReviewsSyncConfig {
                last_sync_error: Some(error_text.clone()),
                ..config
            },
        );
        return (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"success": false, "error": error_text})),
        )
            .into_response();
    }

    let synced_at = chrono::Utc::now().to_rfc3339();
    let pending_ids: std::collections::HashSet<String> =
        pending.iter().map(|item| item.id.clone()).collect();
    let _guard = match REVIEWS_FILE_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let latest = read_reviews(&state).unwrap_or_default();
    let next: Vec<MarketplaceReview> = latest
        .into_iter()
        .map(|item| {
            if pending_ids.contains(&item.id) {
                MarketplaceReview {
                    source: "synced".to_string(),
                    synced_at: Some(synced_at.clone()),
                    ..item
                }
            } else {
                item
            }
        })
        .collect();
    if let Err(e) = write_reviews(&state, &next) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response();
    }
    if let Err(e) = write_config(
        &state,
        &ReviewsSyncConfig {
            last_sync_at: Some(synced_at.clone()),
            last_sync_error: None,
            ..config
        },
    ) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "sent": pending_ids.len(),
        "synced": pending_ids.len(),
        "syncedAt": synced_at,
    }))
    .into_response()
}
