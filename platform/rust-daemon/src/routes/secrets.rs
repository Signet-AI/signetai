use crate::{execute, routes::auth, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize, Default)]
struct ListQuery {
    limit: Option<usize>,
}
#[derive(Deserialize)]
struct SecretBody {
    name: String,
    value: String,
}

fn bounded(value: &str, label: &str, max: usize) -> Result<String, ApiError> {
    if value.is_empty()
        || value.trim().is_empty()
        || value.len() > max
        || !value.is_char_boundary(value.len())
    {
        return Err(ApiError::bad_request(format!(
            "{label} must be 1-{max} UTF-8 bytes"
        )));
    }
    Ok(value.to_owned())
}
fn header_alias(
    headers: &HeaderMap,
    names: &[&str],
    label: &str,
) -> Result<Option<String>, ApiError> {
    let mut values = Vec::new();
    for name in names {
        for value in headers.get_all(*name).iter() {
            values.push(value.to_str().map(str::trim).map_err(|_| {
                ApiError::bad_request(format!("{label} header must be valid UTF-8"))
            })?);
        }
    }
    if let Some(first) = values.first() {
        if values.iter().any(|value| value != first) {
            return Err(ApiError::bad_request(format!(
                "conflicting {label} aliases"
            )));
        }
    }
    Ok(values
        .first()
        .filter(|value| !value.is_empty())
        .map(|value| (*value).to_owned()))
}
async fn authority(
    state: &AppState,
    headers: &HeaderMap,
    capability: &str,
) -> Result<(String, String), ApiError> {
    let claims = auth::gate(state, headers).await?;
    if claims.get("role").and_then(Value::as_str) != Some("admin") {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: "admin authority is required".into(),
        });
    }
    let permissions = claims
        .get("permissions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let scoped =
        !permissions.is_empty() && !permissions.iter().any(|p| p.as_str() == Some(capability));
    if scoped {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: format!("{capability} capability is required"),
        });
    }
    let agent = header_alias(headers, &["x-signet-agent-id", "x-signet-agent"], "agent")?
        .or_else(|| {
            claims
                .get("agentId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| ApiError::unauthorized("agent identity is required"))?;
    let workspace = header_alias(
        headers,
        &[
            "x-signet-workspace-id",
            "x-signet-workspace",
            "x-workspace-id",
        ],
        "workspace",
    )?
    .unwrap_or_else(|| "default".to_owned());
    let scope = claims.get("scope").and_then(Value::as_object);
    if let Some(scope) = scope {
        if scope
            .get("agent")
            .and_then(Value::as_str)
            .is_some_and(|v| v != agent)
            || scope
                .get("workspace")
                .and_then(Value::as_str)
                .is_some_and(|v| v != workspace)
        {
            return Err(ApiError {
                status: StatusCode::FORBIDDEN,
                code: "forbidden",
                message: "requested scope exceeds authenticated authority".into(),
            });
        }
    }
    Ok((
        bounded(&agent, "agent id", 256)?,
        bounded(&workspace, "workspace id", 256)?,
    ))
}
pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/secrets", get(list).post(upsert))
        .route("/api/secrets/{name}", post(upsert_named).delete(remove))
        .route("/api/secrets/exec", post(unsupported_exec))
        .route("/api/secrets/exec/{job_id}", get(unsupported_exec_status))
        .route("/api/secrets/{name}/exec", post(unsupported_exec))
        .route(
            "/api/secrets/1password/{*rest}",
            get(unsupported_provider).post(unsupported_provider),
        )
        .route(
            "/api/secrets/bitwarden/{*rest}",
            get(unsupported_provider).post(unsupported_provider),
        )
}
async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let (agent_id, workspace_id) = authority(&state, &headers, "secrets:list").await?;
    let limit = q.limit.unwrap_or(100);
    if limit == 0 || limit > 100 {
        return Err(ApiError::bad_request("limit must be between 1 and 100"));
    }
    let result = execute(
        &state,
        signet_core_native::Operation::SecretList {
            agent_id,
            workspace_id,
            limit,
        },
    )
    .await?;
    Ok(Json(
        serde_json::json!({ "secrets": result.get("items").cloned().unwrap_or_else(|| Value::Array(vec![])), "provider": "local" }),
    ))
}
async fn upsert(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SecretBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    upsert_inner(state, headers, body.name, body.value).await
}
async fn upsert_named(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let value = body
        .get("value")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("value is required"))?;
    upsert_inner(state, headers, name, value.to_owned()).await
}
async fn upsert_inner(
    state: AppState,
    headers: HeaderMap,
    name: String,
    value: String,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (agent_id, workspace_id) = authority(&state, &headers, "secrets:write").await?;
    let name = bounded(&name, "secret name", 256)?;
    let value = bounded(&value, "secret value", 64 * 1024)?;
    let result = execute(
        &state,
        signet_core_native::Operation::SecretUpsert {
            agent_id,
            workspace_id,
            name: name.clone(),
            value,
        },
    )
    .await?;
    let _ = result;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "success": true, "name": name })),
    ))
}
async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (agent_id, workspace_id) = authority(&state, &headers, "secrets:delete").await?;
    let name = bounded(&name, "secret name", 256)?;
    execute(
        &state,
        signet_core_native::Operation::SecretDelete {
            agent_id,
            workspace_id,
            name: name.clone(),
        },
    )
    .await?;
    Ok(Json(serde_json::json!({ "success": true, "name": name })))
}
async fn unsupported_exec(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let _ = authority(&state, &headers, "secrets:exec").await?;
    Err(ApiError {
        status: StatusCode::NOT_IMPLEMENTED,
        code: "unsupported",
        message: "secret execution is unsupported".into(),
    })
}
async fn unsupported_exec_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(_job_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    unsupported_exec(State(state), headers).await
}
async fn unsupported_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let _ = authority(&state, &headers, "secrets:providers:list").await?;
    Err(ApiError {
        status: StatusCode::NOT_IMPLEMENTED,
        code: "unsupported",
        message: "external secret providers are unsupported".into(),
    })
}
