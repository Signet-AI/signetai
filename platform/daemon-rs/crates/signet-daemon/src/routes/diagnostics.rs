//! Diagnostics and log routes.
//!
//! Health diagnostics, log listing, and version/update endpoints.

use std::{collections::HashMap, path::Path as StdPath, sync::Arc, time::Duration};

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::Html,
    response::IntoResponse,
};
use chrono::Timelike;
use rusqlite::{Connection, types::ValueRef};
use serde::{Deserialize, Serialize};
use signet_pipeline::provider::GenerateOpts;

use crate::state::{
    AppState, OpenClawHeartbeat, OpenClawHeartbeatData, UpdateChannel, UpdateInfo,
    UpdateRuntimeConfig,
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET / — dashboard fallback when static assets are unavailable.
pub async fn dashboard_unavailable() -> Html<&'static str> {
    Html(
        r#"<!doctype html>
<html>
  <head>
    <title>Signet Daemon</title>
  </head>
  <body>
    <h1>Signet Daemon</h1>
    <p>The daemon is running, but the dashboard is not installed.</p>
    <p>API endpoints are available under <code>/api/*</code>.</p>
  </body>
</html>"#,
    )
}

/// GET /api/diagnostics — composite health report
pub async fn report(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .read(|conn| {
            let memories: i64 = conn
                .query_row("SELECT COUNT(*) FROM memories WHERE is_deleted = 0", [], |r| {
                    r.get(0)
                })
                .unwrap_or(0);
            let tombstones: i64 = conn
                .query_row("SELECT COUNT(*) FROM memories WHERE is_deleted = 1", [], |r| {
                    r.get(0)
                })
                .unwrap_or(0);
            let entities: i64 = conn
                .query_row("SELECT COUNT(*) FROM entities", [], |r| r.get(0))
                .unwrap_or(0);
            let embeddings: i64 = conn
                .query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))
                .unwrap_or(0);
            let pending_jobs: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pipeline_jobs WHERE status = 'pending'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let dead_jobs: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pipeline_jobs WHERE status = 'dead'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let total = memories + tombstones;
            let tombstone_ratio = if total > 0 {
                tombstones as f64 / total as f64
            } else {
                0.0
            };

            let embedding_coverage = if memories > 0 {
                embeddings as f64 / memories as f64
            } else {
                1.0
            };

            // Simple health score: 1.0 = perfect, 0.0 = critical
            let mut score = 1.0_f64;
            if tombstone_ratio > 0.3 {
                score -= 0.2;
            }
            if embedding_coverage < 0.8 {
                score -= 0.2;
            }
            if dead_jobs > 10 {
                score -= 0.1;
            }
            if pending_jobs > 100 {
                score -= 0.1;
            }

            Ok(serde_json::json!({
                "score": score.max(0.0),
                "status": if score > 0.7 { "healthy" } else if score > 0.4 { "degraded" } else { "critical" },
                "domains": {
                    "storage": {
                        "memories": memories,
                        "tombstones": tombstones,
                        "tombstoneRatio": tombstone_ratio,
                        "entities": entities,
                    },
                    "index": {
                        "embeddings": embeddings,
                        "coverage": embedding_coverage,
                    },
                    "queue": {
                        "pending": pending_jobs,
                        "dead": dead_jobs,
                    },
                }
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

/// GET /api/diagnostics/:domain — single domain health
pub async fn domain(
    State(state): State<Arc<AppState>>,
    Path(domain): Path<String>,
) -> impl IntoResponse {
    // Reuse the full report and extract the domain
    let result = state
        .pool
        .read(move |conn| {
            let val = match domain.as_str() {
                "storage" => {
                    let memories: i64 = conn
                        .query_row(
                            "SELECT COUNT(*) FROM memories WHERE is_deleted = 0",
                            [],
                            |r| r.get(0),
                        )
                        .unwrap_or(0);
                    let tombstones: i64 = conn
                        .query_row(
                            "SELECT COUNT(*) FROM memories WHERE is_deleted = 1",
                            [],
                            |r| r.get(0),
                        )
                        .unwrap_or(0);
                    serde_json::json!({"memories": memories, "tombstones": tombstones, "score": 1.0})
                }
                "queue" => {
                    let pending: i64 = conn
                        .query_row(
                            "SELECT COUNT(*) FROM pipeline_jobs WHERE status = 'pending'",
                            [],
                            |r| r.get(0),
                        )
                        .unwrap_or(0);
                    let dead: i64 = conn
                        .query_row(
                            "SELECT COUNT(*) FROM pipeline_jobs WHERE status = 'dead'",
                            [],
                            |r| r.get(0),
                        )
                        .unwrap_or(0);
                    serde_json::json!({"pending": pending, "dead": dead, "score": 1.0})
                }
                "index" => {
                    let embeddings: i64 = conn
                        .query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))
                        .unwrap_or(0);
                    serde_json::json!({"embeddings": embeddings, "score": 1.0})
                }
                _ => serde_json::json!({"error": "unknown domain"}),
            };
            Ok(val)
        })
        .await;

    match result {
        Ok(val) if val.get("error").is_some() => (StatusCode::NOT_FOUND, Json(val)),
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

/// GET /api/home/greeting — short dashboard greeting.
pub async fn home_greeting(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let hour = chrono::Local::now().hour();
    let time_of_day = if hour < 12 {
        "morning"
    } else if hour < 17 {
        "afternoon"
    } else {
        "evening"
    };
    let fallback = format!("good {time_of_day}");

    if let Some(provider) = state.llm.read().await.clone() {
        let soul_content = std::fs::read_to_string(state.config.base_path.join("SOUL.md"))
            .unwrap_or_default()
            .chars()
            .take(500)
            .collect::<String>();
        let prompt = format!(
            "Given this agent personality description:\n\n{soul_content}\n\nGenerate a brief {time_of_day} greeting in this character's voice. Max 15 words. No emojis. No quotes around the greeting."
        );
        if let Ok(text) = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            provider.generate(
                &prompt,
                &GenerateOpts {
                    timeout_ms: Some(10_000),
                    max_tokens: Some(50),
                },
            ),
        )
        .await
        {
            if let Ok(text) = text {
                let greeting = text.text.trim().trim_matches(['"', '\'']).to_string();
                if !greeting.is_empty() {
                    return (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "greeting": greeting,
                            "cachedAt": chrono::Utc::now().to_rfc3339(),
                        })),
                    );
                }
            }
        }
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "greeting": fallback,
            "cachedAt": chrono::Utc::now().to_rfc3339(),
        })),
    )
}

fn clipped_string(value: Option<&serde_json::Value>, max: usize) -> Option<String> {
    value
        .and_then(|value| value.as_str())
        .map(|value| value.chars().take(max).collect())
}

fn non_negative_i64(value: Option<&serde_json::Value>) -> i64 {
    value
        .and_then(|value| value.as_i64().or_else(|| value.as_u64().map(|v| v as i64)))
        .unwrap_or(0)
        .max(0)
}

fn number_or_zero(value: Option<&serde_json::Value>) -> f64 {
    value
        .and_then(|value| value.as_f64())
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

/// POST /api/diagnostics/openclaw/heartbeat
pub async fn openclaw_heartbeat(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let Some(body) = body.as_object() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Body must be an object"})),
        );
    };
    let Some(plugin_version) = clipped_string(body.get("pluginVersion"), 128) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "pluginVersion (string) is required"})),
        );
    };

    let hooks_registered = body
        .get("hooksRegistered")
        .and_then(|value| value.as_array())
        .map(|hooks| {
            hooks
                .iter()
                .filter_map(|hook| hook.as_str())
                .map(|hook| hook.chars().take(128).collect::<String>())
                .take(50)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let failed_delta =
        non_negative_i64(body.get("hooksFailed")).max(non_negative_i64(body.get("errorCount")));
    let succeeded_delta = non_negative_i64(body.get("hooksSucceeded"));

    let previous = state.openclaw_heartbeat.read().await.clone();
    let data = OpenClawHeartbeatData {
        plugin_version,
        hooks_registered,
        last_error: clipped_string(body.get("lastError"), 512),
        latency_ms: number_or_zero(body.get("latencyMs")),
        total_succeeded: previous
            .as_ref()
            .map(|heartbeat| heartbeat.data.total_succeeded)
            .unwrap_or(0)
            + succeeded_delta,
        total_failed: previous
            .as_ref()
            .map(|heartbeat| heartbeat.data.total_failed)
            .unwrap_or(0)
            + failed_delta,
    };

    *state.openclaw_heartbeat.write().await = Some(OpenClawHeartbeat {
        timestamp: chrono::Utc::now().to_rfc3339(),
        data,
    });
    state.stamp_harness("openclaw").await;
    (StatusCode::OK, Json(serde_json::json!({"ok": true})))
}

/// GET /api/diagnostics/openclaw
pub async fn openclaw_health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let heartbeat = state.openclaw_heartbeat.read().await.clone();
    let Some(heartbeat) = heartbeat else {
        return (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "never-seen",
                "lastHeartbeat": serde_json::Value::Null,
                "pluginVersion": serde_json::Value::Null,
                "hooksRegistered": [],
                "hooksSucceeded": 0,
                "hooksFailed": 0,
                "lastLatencyMs": 0,
                "lastError": serde_json::Value::Null,
            })),
        );
    };

    let parsed = chrono::DateTime::parse_from_rfc3339(&heartbeat.timestamp)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());
    let stale = chrono::Utc::now()
        .signed_duration_since(parsed)
        .num_milliseconds()
        >= 10 * 60 * 1000;
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "status": if stale { "stale" } else { "connected" },
            "lastHeartbeat": heartbeat.timestamp,
            "pluginVersion": heartbeat.data.plugin_version,
            "hooksRegistered": heartbeat.data.hooks_registered,
            "hooksSucceeded": heartbeat.data.total_succeeded,
            "hooksFailed": heartbeat.data.total_failed,
            "lastLatencyMs": heartbeat.data.latency_ms,
            "lastError": heartbeat.data.last_error,
        })),
    )
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // since filter planned
pub struct LogsQuery {
    pub limit: Option<usize>,
    pub level: Option<String>,
    pub since: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SampleQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug)]
struct SqliteMasterRow {
    name: String,
    kind: String,
    sql: Option<String>,
}

fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn group_for_table(name: &str) -> &'static str {
    match name {
        "entities"
        | "memories"
        | "memory_entity_mentions"
        | "relations"
        | "entity_aspects"
        | "entity_attributes"
        | "entity_dependencies"
        | "entity_dependency_history"
        | "entity_communities"
        | "ontology_proposals" => "core",
        "documents"
        | "document_memories"
        | "memory_artifacts"
        | "memory_artifact_chunks"
        | "conversations"
        | "session_transcripts"
        | "session_summaries"
        | "session_summary_memories" => "provenance",
        "embeddings"
        | "memory_hints"
        | "session_memories"
        | "session_scores"
        | "umap_cache"
        | "predictor_training_runs"
        | "path_feedback_events"
        | "path_feedback_stats"
        | "session_checkpoints"
        | "memories_cold"
        | "schema_migrations"
        | "schema_migrations_audit"
        | "memory_jobs"
        | "summary_jobs"
        | "telemetry_events"
        | "connectors"
        | "connector_documents"
        | "skill_meta"
        | "skill_invocations"
        | "daily_reflections" => "runtime",
        "vec_embeddings" | "entities_fts" | "memories_fts" | "memory_hints_fts" => "internal",
        _ if name.contains("_fts") || name.starts_with("fts_") || name.starts_with("vec_") => {
            "internal"
        }
        _ if name.contains("job") || name.contains("telemetry") || name.contains("cache") => {
            "runtime"
        }
        _ if name.contains("session") || name.contains("document") || name.contains("artifact") => {
            "provenance"
        }
        _ => "other",
    }
}

fn is_virtual_table(sql: Option<&str>) -> bool {
    sql.is_some_and(|sql| sql.to_ascii_uppercase().contains("CREATE VIRTUAL TABLE"))
}

fn sample_blocked_reason(row: &SqliteMasterRow) -> Option<&'static str> {
    if matches!(
        row.name.as_str(),
        "vec_embeddings" | "entities_fts" | "memories_fts" | "memory_hints_fts"
    ) {
        return Some("internal index table");
    }
    if is_virtual_table(row.sql.as_deref()) {
        return Some("virtual table");
    }
    None
}

fn parse_bounded(raw: Option<i64>, default: i64, min: i64, max: i64) -> i64 {
    raw.unwrap_or(default).clamp(min, max)
}

fn list_tables(conn: &Connection) -> rusqlite::Result<Vec<SqliteMasterRow>> {
    let mut stmt = conn.prepare(
        "SELECT name, type, sql
         FROM sqlite_master
         WHERE type IN ('table', 'view')
           AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE '%_fts_data'
           AND name NOT LIKE '%_fts_idx'
           AND name NOT LIKE '%_fts_docsize'
           AND name NOT LIKE '%_fts_config'
         ORDER BY name ASC",
    )?;
    stmt.query_map([], |row| {
        Ok(SqliteMasterRow {
            name: row.get(0)?,
            kind: row.get(1)?,
            sql: row.get(2)?,
        })
    })?
    .collect()
}

fn safe_count(conn: &Connection, table: &str) -> Option<i64> {
    conn.query_row(
        &format!("SELECT COUNT(*) AS count FROM {}", quote_identifier(table)),
        [],
        |row| row.get(0),
    )
    .ok()
}

fn read_columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", quote_identifier(table)))?;
    stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "cid": row.get::<_, i64>(0).unwrap_or(0),
            "name": row.get::<_, String>(1).unwrap_or_default(),
            "type": row.get::<_, String>(2).unwrap_or_default(),
            "notNull": row.get::<_, i64>(3).unwrap_or(0) > 0,
            "defaultValue": row.get::<_, Option<String>>(4).unwrap_or(None),
            "primaryKey": row.get::<_, i64>(5).unwrap_or(0) > 0,
        }))
    })?
    .collect()
}

fn read_indexes(conn: &Connection, table: &str) -> rusqlite::Result<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare(&format!("PRAGMA index_list({})", quote_identifier(table)))?;
    let indexes: Vec<(String, bool, String, bool)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1).unwrap_or_default(),
                row.get::<_, i64>(2).unwrap_or(0) > 0,
                row.get::<_, String>(3).unwrap_or_default(),
                row.get::<_, i64>(4).unwrap_or(0) > 0,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;

    indexes
        .into_iter()
        .map(|(name, unique, origin, partial)| {
            let mut col_stmt =
                conn.prepare(&format!("PRAGMA index_info({})", quote_identifier(&name)))?;
            let columns = col_stmt
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "seqno": row.get::<_, i64>(0).unwrap_or(0),
                        "cid": row.get::<_, i64>(1).unwrap_or(-1),
                        "name": row.get::<_, String>(2).unwrap_or_default(),
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(serde_json::json!({
                "name": name,
                "unique": unique,
                "origin": origin,
                "partial": partial,
                "columns": columns,
            }))
        })
        .collect()
}

fn read_foreign_keys(conn: &Connection, table: &str) -> rusqlite::Result<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare(&format!(
        "PRAGMA foreign_key_list({})",
        quote_identifier(table)
    ))?;
    stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "id": row.get::<_, i64>(0).unwrap_or(0),
            "seq": row.get::<_, i64>(1).unwrap_or(0),
            "table": row.get::<_, String>(2).unwrap_or_default(),
            "from": row.get::<_, String>(3).unwrap_or_default(),
            "to": row.get::<_, String>(4).unwrap_or_default(),
            "onUpdate": row.get::<_, String>(5).unwrap_or_default(),
            "onDelete": row.get::<_, String>(6).unwrap_or_default(),
            "match": row.get::<_, String>(7).unwrap_or_default(),
        }))
    })?
    .collect()
}

fn serialize_cell(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(value) => serde_json::json!(value),
        ValueRef::Real(value) => serde_json::json!(value),
        ValueRef::Text(value) => serde_json::json!(String::from_utf8_lossy(value).to_string()),
        ValueRef::Blob(value) => serde_json::json!(format!("[blob {} bytes]", value.len())),
    }
}

/// GET /api/diagnostics/database/schema — SQLite schema inventory.
pub async fn database_schema(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .read(|conn| {
            let tables = list_tables(conn)?
                .into_iter()
                .map(|row| {
                    let blocked = sample_blocked_reason(&row);
                    let group = group_for_table(&row.name);
                    let mut table = serde_json::json!({
                        "name": row.name,
                        "group": group,
                        "kind": row.kind,
                        "rowCount": safe_count(conn, &row.name),
                        "sampleAllowed": blocked.is_none(),
                        "columns": read_columns(conn, &row.name)?,
                        "indexes": read_indexes(conn, &row.name)?,
                        "foreignKeys": read_foreign_keys(conn, &row.name)?,
                        "sql": row.sql,
                    });
                    if let Some(reason) = blocked {
                        table["sampleBlockedReason"] = serde_json::json!(reason);
                    }
                    Ok((group.to_string(), table))
                })
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut groups = HashMap::from([
                ("core".to_string(), 0),
                ("provenance".to_string(), 0),
                ("runtime".to_string(), 0),
                ("internal".to_string(), 0),
                ("other".to_string(), 0),
            ]);
            let tables: Vec<_> = tables
                .into_iter()
                .map(|(group, table)| {
                    *groups.entry(group).or_insert(0) += 1;
                    table
                })
                .collect();
            Ok(serde_json::json!({
                "generatedAt": chrono::Utc::now().to_rfc3339(),
                "tables": tables,
                "groups": groups,
            }))
        })
        .await;

    match result {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{error}")})),
        ),
    }
}

/// GET /api/diagnostics/database/tables/:table/sample — bounded table sample.
pub async fn database_table_sample(
    State(state): State<Arc<AppState>>,
    Path(table): Path<String>,
    Query(query): Query<SampleQuery>,
) -> impl IntoResponse {
    let limit = parse_bounded(query.limit, 25, 1, 100);
    let offset = parse_bounded(query.offset, 0, 0, i64::MAX);
    let result = state
        .pool
        .read(move |conn| {
            let row = list_tables(conn)?.into_iter().find(|row| row.name == table);
            let Some(row) = row else {
                return Ok(Err((
                    StatusCode::NOT_FOUND,
                    serde_json::json!({"error": "unknown table"}),
                )));
            };
            if let Some(reason) = sample_blocked_reason(&row) {
                return Ok(Err((
                    StatusCode::BAD_REQUEST,
                    serde_json::json!({"error": format!("sample unavailable: {reason}")}),
                )));
            }
            let columns: Vec<String> = read_columns(conn, &row.name)?
                .into_iter()
                .filter_map(|col| {
                    col.get("name")
                        .and_then(|name| name.as_str())
                        .map(String::from)
                })
                .collect();
            let mut stmt = conn.prepare(&format!(
                "SELECT * FROM {} LIMIT ? OFFSET ?",
                quote_identifier(&row.name)
            ))?;
            let rows = stmt
                .query_map([limit + 1, offset], |sample_row| {
                    let mut out = serde_json::Map::new();
                    let row_ref = sample_row.as_ref();
                    for i in 0..row_ref.column_count() {
                        let name = row_ref.column_name(i).unwrap_or("").to_string();
                        let value = sample_row.get_ref(i).map(serialize_cell)?;
                        out.insert(name, value);
                    }
                    Ok(serde_json::Value::Object(out))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let has_more = rows.len() > limit as usize;
            let rows = rows.into_iter().take(limit as usize).collect::<Vec<_>>();
            Ok(Ok(serde_json::json!({
                "table": row.name,
                "columns": columns,
                "rows": rows,
                "limit": limit,
                "offset": offset,
                "rowCount": safe_count(conn, &row.name),
                "hasMore": has_more,
            })))
        })
        .await;

    match result {
        Ok(Ok(value)) => (StatusCode::OK, Json(value)),
        Ok(Err((status, value))) => (status, Json(value)),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{error}")})),
        ),
    }
}

/// GET /api/logs — list recent log entries
pub async fn logs(
    State(state): State<Arc<AppState>>,
    Query(params): Query<LogsQuery>,
) -> impl IntoResponse {
    let limit = params.limit.unwrap_or(100);
    let log_dir = state.config.logs_dir();

    // Read from latest log file
    let entries = tokio::task::spawn_blocking(move || {
        let mut files: Vec<_> = std::fs::read_dir(&log_dir)
            .ok()
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter(|e| {
                        e.path()
                            .extension()
                            .map(|ext| ext == "log" || ext == "jsonl")
                            .unwrap_or(false)
                    })
                    .collect()
            })
            .unwrap_or_default();

        files.sort_by(|a, b| {
            b.metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
                .cmp(
                    &a.metadata()
                        .and_then(|m| m.modified())
                        .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                )
        });

        let mut logs = Vec::new();
        for file in files.into_iter().take(3) {
            if let Ok(content) = std::fs::read_to_string(file.path()) {
                for line in content.lines().rev().take(limit) {
                    if let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(ref level) = params.level
                            && entry
                                .get("level")
                                .and_then(|v| v.as_str())
                                .map(|l| !l.eq_ignore_ascii_case(level))
                                .unwrap_or(true)
                        {
                            continue;
                        }
                        logs.push(entry);
                    }
                    if logs.len() >= limit {
                        break;
                    }
                }
            }
            if logs.len() >= limit {
                break;
            }
        }
        logs
    })
    .await
    .unwrap_or_default();

    let count = entries.len();
    (
        StatusCode::OK,
        Json(serde_json::json!({"logs": entries, "count": count})),
    )
}

/// GET /api/logs/stream — SSE stream of live log events.
pub async fn logs_stream() -> impl IntoResponse {
    (
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-cache"),
            ("connection", "keep-alive"),
        ],
        "data: {\"type\":\"connected\"}\n\n",
    )
}

/// GET /api/version — version info
pub async fn version() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "runtime": "rust",
        "target": std::env::consts::ARCH,
    }))
}

const MIN_UPDATE_INTERVAL_SECONDS: i64 = 300;
const MAX_UPDATE_INTERVAL_SECONDS: i64 = 604_800;
const UPDATE_CACHE_TTL_SECONDS: i64 = 3_600;
const UPDATE_HTTP_TIMEOUT_SECONDS: u64 = 10;
const UPDATE_INSTALL_TIMEOUT_SECONDS: u64 = 15 * 60;

fn update_config_payload(
    config: &UpdateRuntimeConfig,
    pending_restart_version: Option<&str>,
    last_auto_update_at: Option<&str>,
    last_auto_update_error: Option<&str>,
    install_in_progress: bool,
) -> serde_json::Value {
    serde_json::json!({
        "autoInstall": config.auto_install,
        "checkInterval": config.check_interval,
        "channel": config.channel.as_str(),
        "minInterval": MIN_UPDATE_INTERVAL_SECONDS,
        "maxInterval": MAX_UPDATE_INTERVAL_SECONDS,
        "pendingRestartVersion": pending_restart_version,
        "lastAutoUpdateAt": last_auto_update_at,
        "lastAutoUpdateError": last_auto_update_error,
        "updateInProgress": install_in_progress,
    })
}

fn parse_update_bool(value: &serde_json::Value) -> Option<bool> {
    match value {
        serde_json::Value::Bool(value) => Some(*value),
        serde_json::Value::String(value) if value == "true" => Some(true),
        serde_json::Value::String(value) if value == "false" => Some(false),
        _ => None,
    }
}

fn parse_update_interval(value: &serde_json::Value) -> Option<i64> {
    let parsed = value
        .as_i64()
        .or_else(|| value.as_str().and_then(|raw| raw.parse::<i64>().ok()))?;
    if (MIN_UPDATE_INTERVAL_SECONDS..=MAX_UPDATE_INTERVAL_SECONDS).contains(&parsed) {
        Some(parsed)
    } else {
        None
    }
}

fn parse_update_channel(value: &str) -> Option<UpdateChannel> {
    match value.trim().to_ascii_lowercase().as_str() {
        "stable" | "latest" => Some(UpdateChannel::Stable),
        "nightly" | "next" => Some(UpdateChannel::Nightly),
        _ => None,
    }
}

#[derive(Debug)]
struct ParsedVersion {
    core: Vec<u64>,
    prerelease: Vec<String>,
}

fn parse_version(value: &str) -> Option<ParsedVersion> {
    let without_prefix = value.trim().trim_start_matches(['v', 'V']);
    let without_build = without_prefix.split('+').next().unwrap_or_default();
    if without_build.is_empty() {
        return None;
    }
    let (core_part, prerelease_part) = without_build
        .split_once('-')
        .map_or((without_build, ""), |(core, pre)| (core, pre));
    let mut core = Vec::new();
    for part in core_part.split('.') {
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        core.push(part.parse::<u64>().ok()?);
    }
    let prerelease = if prerelease_part.is_empty() {
        Vec::new()
    } else {
        let parts = prerelease_part
            .split('.')
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if parts.iter().any(|part| {
            part.is_empty() || !part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        }) {
            return None;
        }
        parts
    };
    Some(ParsedVersion { core, prerelease })
}

fn compare_prerelease(left: &[String], right: &[String]) -> std::cmp::Ordering {
    match (left.is_empty(), right.is_empty()) {
        (true, true) => return std::cmp::Ordering::Equal,
        (true, false) => return std::cmp::Ordering::Greater,
        (false, true) => return std::cmp::Ordering::Less,
        (false, false) => {}
    }
    for index in 0..left.len().max(right.len()) {
        let Some(left_part) = left.get(index) else {
            return std::cmp::Ordering::Less;
        };
        let Some(right_part) = right.get(index) else {
            return std::cmp::Ordering::Greater;
        };
        let left_numeric = left_part.chars().all(|c| c.is_ascii_digit());
        let right_numeric = right_part.chars().all(|c| c.is_ascii_digit());
        match (left_numeric, right_numeric) {
            (true, true) => {
                let ordering = left_part
                    .parse::<u64>()
                    .unwrap_or(0)
                    .cmp(&right_part.parse::<u64>().unwrap_or(0));
                if !ordering.is_eq() {
                    return ordering;
                }
            }
            (true, false) => return std::cmp::Ordering::Less,
            (false, true) => return std::cmp::Ordering::Greater,
            (false, false) => {
                let ordering = left_part.cmp(right_part);
                if !ordering.is_eq() {
                    return ordering;
                }
            }
        }
    }
    std::cmp::Ordering::Equal
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let Some(left) = parse_version(left) else {
        return left
            .trim()
            .trim_start_matches(['v', 'V'])
            .cmp(right.trim().trim_start_matches(['v', 'V']));
    };
    let Some(right) = parse_version(right) else {
        return left
            .core
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(".")
            .as_str()
            .cmp(right.trim().trim_start_matches(['v', 'V']));
    };
    for index in 0..left.core.len().max(right.core.len()) {
        let ordering = left
            .core
            .get(index)
            .copied()
            .unwrap_or(0)
            .cmp(&right.core.get(index).copied().unwrap_or(0));
        if !ordering.is_eq() {
            return ordering;
        }
    }
    compare_prerelease(&left.prerelease, &right.prerelease)
}

fn is_version_newer(candidate: &str, current: &str) -> bool {
    compare_versions(candidate, current).is_gt()
}

fn is_major_upgrade(current: &str, candidate: &str) -> bool {
    parse_version(candidate)
        .and_then(|version| version.core.first().copied())
        .unwrap_or(0)
        > parse_version(current)
            .and_then(|version| version.core.first().copied())
            .unwrap_or(0)
}

fn normalize_target_version(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim().trim_start_matches(['v', 'V']);
    if value.is_empty() {
        return None;
    }
    let (without_build, build_valid) =
        value
            .split_once('+')
            .map_or((value, true), |(version, build)| {
                (
                    version,
                    !build.is_empty()
                        && build
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.'),
                )
            });
    if !build_valid || parse_version(without_build).is_none() {
        return None;
    }
    Some(value.to_string())
}

fn config_path(base_path: &StdPath) -> Option<std::path::PathBuf> {
    ["agent.yaml", "AGENT.yaml"]
        .into_iter()
        .map(|name| base_path.join(name))
        .find(|path| path.exists())
}

fn format_updates_section(config: &UpdateRuntimeConfig) -> String {
    format!(
        "updates:\n  auto_install: {}\n  check_interval: {}\n  channel: {}\n",
        config.auto_install,
        config.check_interval,
        config.channel.as_str()
    )
}

fn replace_updates_section(current: &str, config: &UpdateRuntimeConfig) -> String {
    let replacement = format_updates_section(config);
    let mut output = Vec::new();
    let mut inserted = false;
    let mut skipping_updates = false;
    for line in current.lines() {
        if line.trim_start().starts_with("updates:") && !line.starts_with([' ', '\t']) {
            if !inserted {
                output.extend(replacement.trim_end().lines().map(ToOwned::to_owned));
                inserted = true;
            }
            skipping_updates = true;
            continue;
        }
        if skipping_updates {
            if line.starts_with([' ', '\t']) || line.trim().is_empty() {
                continue;
            }
            skipping_updates = false;
        }
        output.push(line.to_string());
    }
    if !inserted {
        if !output.is_empty() {
            output.push(String::new());
        }
        output.extend(replacement.trim_end().lines().map(ToOwned::to_owned));
    }
    format!("{}\n", output.join("\n"))
}

fn persist_update_config(base_path: &StdPath, config: &UpdateRuntimeConfig) -> bool {
    let Some(path) = config_path(base_path) else {
        return false;
    };
    let Ok(current) = std::fs::read_to_string(&path) else {
        return false;
    };
    let updated = replace_updates_section(&current, config);
    if updated == current {
        return true;
    }
    std::fs::write(path, updated).is_ok()
}

#[derive(Deserialize)]
pub struct UpdateCheckQuery {
    force: Option<String>,
}

#[derive(Deserialize)]
struct GitHubReleaseResponse {
    tag_name: String,
    html_url: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    draft: Option<bool>,
    prerelease: Option<bool>,
}

#[derive(Deserialize)]
struct NpmDistTagResponse {
    version: Option<String>,
}

async fn fetch_stable_from_github()
-> Result<(String, Option<String>, Option<String>, Option<String>), String> {
    if let Ok(version) = std::env::var("SIGNET_UPDATE_MOCK_GITHUB_VERSION") {
        return Ok((
            version,
            std::env::var("SIGNET_UPDATE_MOCK_RELEASE_URL").ok(),
            std::env::var("SIGNET_UPDATE_MOCK_RELEASE_NOTES").ok(),
            std::env::var("SIGNET_UPDATE_MOCK_PUBLISHED_AT").ok(),
        ));
    }
    let response = reqwest::Client::new()
        .get("https://api.github.com/repos/Signet-AI/signetai/releases/latest")
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "signet-daemon")
        .timeout(Duration::from_secs(UPDATE_HTTP_TIMEOUT_SECONDS))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub releases lookup failed ({})",
            response.status()
        ));
    }
    let release = response
        .json::<GitHubReleaseResponse>()
        .await
        .map_err(|error| error.to_string())?;
    if release.draft.unwrap_or(false) || release.prerelease.unwrap_or(false) {
        return Err("GitHub latest release is not stable".to_string());
    }
    Ok((
        release.tag_name.trim_start_matches(['v', 'V']).to_string(),
        release.html_url,
        release.body.map(|body| body.chars().take(500).collect()),
        release.published_at,
    ))
}

async fn fetch_latest_from_npm(channel: &UpdateChannel) -> Result<String, String> {
    if let Ok(version) = std::env::var("SIGNET_UPDATE_MOCK_NPM_VERSION") {
        return Ok(version);
    }
    let response = reqwest::Client::new()
        .get(format!(
            "https://registry.npmjs.org/signetai/{}",
            channel.npm_tag()
        ))
        .timeout(Duration::from_secs(UPDATE_HTTP_TIMEOUT_SECONDS))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "npm registry lookup failed ({})",
            response.status()
        ));
    }
    response
        .json::<NpmDistTagResponse>()
        .await
        .map_err(|error| error.to_string())?
        .version
        .ok_or_else(|| "npm registry response missing version".to_string())
}

async fn check_for_updates(state: &Arc<AppState>) -> UpdateInfo {
    {
        let mut update = state.update_state.write().await;
        update.check_in_progress = true;
    }

    let (current_version, channel, pending_restart_version) = {
        let update = state.update_state.read().await;
        (
            update.current_version.clone(),
            update.config.channel.clone(),
            update.pending_restart_version.clone(),
        )
    };

    let mut result = UpdateInfo {
        current_version: current_version.clone(),
        latest_version: None,
        update_available: false,
        release_url: None,
        release_notes: None,
        published_at: None,
        check_error: None,
        restart_required: false,
        pending_version: None,
        is_major_upgrade: false,
    };
    let mut errors = Vec::new();

    if channel == UpdateChannel::Stable {
        match fetch_stable_from_github().await {
            Ok((version, url, notes, published)) => {
                result.latest_version = Some(version);
                result.release_url = url;
                result.release_notes = notes;
                result.published_at = published;
            }
            Err(error) => errors.push(error),
        }
    }

    if result.latest_version.is_none() {
        match fetch_latest_from_npm(&channel).await {
            Ok(version) => result.latest_version = Some(version),
            Err(error) => errors.push(error),
        }
    }

    if let Some(latest) = result.latest_version.as_deref() {
        result.update_available = is_version_newer(latest, &current_version);
        result.is_major_upgrade = is_major_upgrade(&current_version, latest);
    }
    if let Some(pending) = pending_restart_version {
        result.restart_required = true;
        result.pending_version = Some(pending.clone());
        if result
            .latest_version
            .as_deref()
            .map(|latest| compare_versions(latest, &pending).is_eq())
            .unwrap_or(false)
        {
            result.update_available = false;
        }
    }
    if result.latest_version.is_none() && !errors.is_empty() {
        result.check_error = Some(errors.join(" | "));
    }

    let checked_at = chrono::Utc::now().to_rfc3339();
    {
        let mut update = state.update_state.write().await;
        update.last_check = Some(result.clone());
        update.last_check_time = Some(checked_at);
        update.check_in_progress = false;
    }
    result
}

fn update_check_payload(
    info: &UpdateInfo,
    cached: bool,
    checked_at: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "currentVersion": info.current_version,
        "latestVersion": info.latest_version,
        "updateAvailable": info.update_available,
        "releaseUrl": info.release_url,
        "releaseNotes": info.release_notes,
        "publishedAt": info.published_at,
        "checkError": info.check_error,
        "restartRequired": info.restart_required,
        "pendingVersion": info.pending_version,
        "isMajorUpgrade": info.is_major_upgrade,
        "cached": cached,
        "checkedAt": checked_at,
    })
}

/// GET /api/update — update status
pub async fn update_status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let update = state.update_state.read().await;
    Json(serde_json::json!({
        "available": update
            .last_check
            .as_ref()
            .map(|check| check.update_available)
            .unwrap_or(false),
        "current": update.current_version,
        "latest": update.last_check.as_ref().and_then(|check| check.latest_version.clone()),
        "restartRequired": update.pending_restart_version.is_some(),
        "pendingVersion": update.pending_restart_version,
        "checkInProgress": update.check_in_progress,
        "installInProgress": update.install_in_progress,
    }))
}

/// GET /api/update/check — explicit update check status.
pub async fn update_check(
    State(state): State<Arc<AppState>>,
    Query(query): Query<UpdateCheckQuery>,
) -> Json<serde_json::Value> {
    let force = query.force.as_deref() == Some("true");
    if !force {
        let cached = state.update_state.read().await;
        if let (Some(last_check), Some(last_check_time)) =
            (cached.last_check.as_ref(), cached.last_check_time.as_ref())
            && chrono::DateTime::parse_from_rfc3339(last_check_time)
                .map(|time| {
                    chrono::Utc::now()
                        .signed_duration_since(time.with_timezone(&chrono::Utc))
                        .num_seconds()
                        < UPDATE_CACHE_TTL_SECONDS
                })
                .unwrap_or(false)
        {
            return Json(update_check_payload(
                last_check,
                true,
                Some(last_check_time.as_str()),
            ));
        }
    }

    let info = check_for_updates(&state).await;
    let checked_at = state.update_state.read().await.last_check_time.clone();
    Json(update_check_payload(&info, false, checked_at.as_deref()))
}

/// GET /api/update/config — update scheduler config.
pub async fn update_config(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let update = state.update_state.read().await;
    Json(update_config_payload(
        &update.config,
        update.pending_restart_version.as_deref(),
        update.last_auto_update_at.as_deref(),
        update.last_auto_update_error.as_deref(),
        update.install_in_progress,
    ))
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct UpdateConfigBody {
    auto_install: Option<serde_json::Value>,
    #[serde(rename = "autoInstall")]
    auto_install_camel: Option<serde_json::Value>,
    check_interval: Option<serde_json::Value>,
    #[serde(rename = "checkInterval")]
    check_interval_camel: Option<serde_json::Value>,
    channel: Option<String>,
}

/// POST /api/update/config — validate and persist update scheduler config.
pub async fn update_config_save(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UpdateConfigBody>,
) -> impl IntoResponse {
    let auto_install = body.auto_install_camel.or(body.auto_install);
    if let Some(value) = auto_install.as_ref()
        && parse_update_bool(value).is_none()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "success": false,
                "error": "autoInstall must be true or false"
            })),
        )
            .into_response();
    }

    let parsed_auto_install = auto_install.as_ref().and_then(parse_update_bool);
    let check_interval = body.check_interval_camel.or(body.check_interval);
    if let Some(value) = check_interval.as_ref()
        && parse_update_interval(value).is_none()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "success": false,
                "error": format!(
                    "checkInterval must be between {MIN_UPDATE_INTERVAL_SECONDS} and {MAX_UPDATE_INTERVAL_SECONDS} seconds"
                )
            })),
        )
            .into_response();
    }
    let parsed_check_interval = check_interval.as_ref().and_then(parse_update_interval);

    let parsed_channel = body.channel.as_deref().and_then(parse_update_channel);
    if body.channel.as_deref().is_some() && parsed_channel.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "success": false,
                "error": "channel must be stable or nightly"
            })),
        )
            .into_response();
    }

    let mut update = state.update_state.write().await;
    let changed = parsed_auto_install.is_some()
        || parsed_check_interval.is_some()
        || parsed_channel.is_some();
    if let Some(value) = parsed_auto_install {
        update.config.auto_install = value;
    }
    if let Some(value) = parsed_check_interval {
        update.config.check_interval = value;
    }
    if let Some(value) = parsed_channel {
        update.config.channel = value;
    }
    let persisted = if changed {
        persist_update_config(&state.config.base_path, &update.config)
    } else {
        true
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": true,
            "config": {
                "autoInstall": update.config.auto_install,
                "checkInterval": update.config.check_interval,
                "channel": update.config.channel.as_str(),
            },
            "persisted": persisted,
            "pendingRestartVersion": update.pending_restart_version,
            "lastAutoUpdateAt": update.last_auto_update_at,
            "lastAutoUpdateError": update.last_auto_update_error,
        })),
    )
        .into_response()
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct UpdateRunBody {
    #[serde(rename = "targetVersion")]
    target_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRunResult {
    success: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    installed_version: Option<String>,
    restart_required: bool,
}

fn clip_update_output(output: &str) -> Option<String> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() <= 6_000 {
        Some(trimmed.to_string())
    } else {
        Some(trimmed[trimmed.len() - 6_000..].to_string())
    }
}

async fn command_exists(command: &str) -> bool {
    tokio::process::Command::new(command)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .map(|output| output.status.success())
        .unwrap_or(false)
}

async fn run_update_install(target_version: &str) -> UpdateRunResult {
    if let Ok(result) = std::env::var("SIGNET_UPDATE_MOCK_RUN_RESULT") {
        return if result == "success" {
            UpdateRunResult {
                success: true,
                message: "Update installed. Restart daemon to apply.".to_string(),
                output: None,
                installed_version: Some(target_version.to_string()),
                restart_required: true,
            }
        } else {
            UpdateRunResult {
                success: false,
                message: result,
                output: None,
                installed_version: None,
                restart_required: false,
            }
        };
    }

    let install_package = format!("signetai@{target_version}");
    let (command, args): (&str, Vec<String>) = if command_exists("bun").await {
        ("bun", vec!["add".into(), "-g".into(), install_package])
    } else {
        ("npm", vec!["install".into(), "-g".into(), install_package])
    };
    let output = match tokio::time::timeout(
        Duration::from_secs(UPDATE_INSTALL_TIMEOUT_SECONDS),
        tokio::process::Command::new(command).args(&args).output(),
    )
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return UpdateRunResult {
                success: false,
                message: format!("Update failed: {error}"),
                output: None,
                installed_version: None,
                restart_required: false,
            };
        }
        Err(_) => {
            return UpdateRunResult {
                success: false,
                message: "Update failed: install command timed out".to_string(),
                output: None,
                installed_version: None,
                restart_required: false,
            };
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let clipped = clip_update_output(&format!("{stdout}\n{stderr}"));
    if !output.status.success() {
        return UpdateRunResult {
            success: false,
            message: format!(
                "Update failed: {}",
                if stderr.trim().is_empty() {
                    "Unknown error"
                } else {
                    stderr.trim()
                }
            ),
            output: clipped,
            installed_version: None,
            restart_required: false,
        };
    }
    UpdateRunResult {
        success: true,
        message: "Update installed. Restart daemon to apply.".to_string(),
        output: clipped,
        installed_version: Some(target_version.to_string()),
        restart_required: true,
    }
}

/// POST /api/update/run — install an available update or explicit target version.
pub async fn update_run(
    State(state): State<Arc<AppState>>,
    body: Option<Json<UpdateRunBody>>,
) -> Json<serde_json::Value> {
    let body_target = body.and_then(|Json(body)| body.target_version);
    if body_target.is_some() && normalize_target_version(body_target.as_deref()).is_none() {
        return Json(serde_json::json!({
            "success": false,
            "message": format!("Invalid targetVersion '{}'", body_target.unwrap_or_default()),
            "restartRequired": false,
        }));
    }

    {
        let mut update = state.update_state.write().await;
        if update.install_in_progress {
            return Json(serde_json::json!({
                "success": false,
                "message": "Update already in progress",
                "restartRequired": false,
            }));
        }
        update.install_in_progress = true;
    }

    let mut target_version = normalize_target_version(body_target.as_deref());
    if target_version.is_none() {
        let check = check_for_updates(&state).await;
        if check.restart_required && !check.update_available {
            let installed = check
                .pending_version
                .clone()
                .or(check.latest_version.clone())
                .unwrap_or_else(|| "already".to_string());
            let mut update = state.update_state.write().await;
            update.install_in_progress = false;
            return Json(serde_json::json!({
                "success": true,
                "message": format!("Update {installed} installed. Restart daemon to apply."),
                "installedVersion": installed,
                "restartRequired": true,
            }));
        }
        if !check.update_available {
            let installed = check.latest_version.unwrap_or(check.current_version);
            let mut update = state.update_state.write().await;
            update.install_in_progress = false;
            return Json(serde_json::json!({
                "success": true,
                "message": "Already running the latest version.",
                "installedVersion": installed,
                "restartRequired": false,
            }));
        }
        target_version = check.latest_version;
    }

    let Some(target_version) = target_version else {
        let mut update = state.update_state.write().await;
        update.install_in_progress = false;
        return Json(serde_json::json!({
            "success": false,
            "message": "Update failed: no target version available",
            "restartRequired": false,
        }));
    };

    let result = run_update_install(&target_version).await;
    {
        let mut update = state.update_state.write().await;
        update.install_in_progress = false;
        if result.success {
            update.pending_restart_version = result.installed_version.clone();
            update.last_check = None;
            update.last_check_time = None;
        }
    }
    Json(serde_json::to_value(result).unwrap_or_else(|_| {
        serde_json::json!({
            "success": false,
            "message": "Update failed: could not serialize result",
            "restartRequired": false,
        })
    }))
}
