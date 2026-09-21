use crate::routes::auth;
use crate::{agent, execute, source_workspace, AgentQuery, ApiError, AppState};
use axum::http::StatusCode;
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use serde_json::Value;
use signet_core_native::Operation;
use std::time::Duration;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Default)]
struct ReflectionConfig {
    enabled: bool,
    count: usize,
    model: Option<String>,
    timeout_ms: u64,
    max_tokens: u64,
    timezone: Option<String>,
}

fn reflection_config(text: &str) -> ReflectionConfig {
    let mut config = ReflectionConfig {
        enabled: true,
        count: 3,
        model: Some("qwen3:4b".to_owned()),
        timeout_ms: 120_000,
        max_tokens: 4_000,
        ..Default::default()
    };
    let mut active = false;
    let mut parent_indent = 0usize;
    let mut pipeline_indent = 0usize;
    let mut memory_indent = 0usize;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if trimmed == "memory:" {
            memory_indent = indent;
            continue;
        }
        if trimmed == "pipelineV2:" && indent > memory_indent {
            pipeline_indent = indent;
            continue;
        }
        if trimmed == "reflections:" && pipeline_indent > 0 && indent > pipeline_indent {
            active = true;
            parent_indent = indent;
            continue;
        }
        if !active {
            continue;
        }
        if indent <= parent_indent {
            active = false;
            continue;
        }
        let Some((key, raw)) = trimmed.split_once(':') else {
            continue;
        };
        let value = raw.trim().trim_matches(['\"', '\'']);
        match key.trim() {
            "enabled" => config.enabled = value.eq_ignore_ascii_case("true"),
            "count" => config.count = value.parse().unwrap_or(1),
            "model" if !value.is_empty() => config.model = Some(value.to_owned()),
            "timeout" | "timeoutMs" => config.timeout_ms = value.parse().unwrap_or(30_000),
            "maxTokens" | "max_tokens" => config.max_tokens = value.parse().unwrap_or(4096),
            "timezone" if !value.is_empty() => config.timezone = Some(value.to_owned()),
            _ => {}
        }
    }
    config
}

fn parse_reflection_entries(content: &str) -> Vec<Value> {
    if let Ok(parsed) = serde_json::from_str::<Value>(content) {
        return parsed
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .or_else(|| parsed.get("insights").and_then(Value::as_array).cloned())
            .unwrap_or_default();
    }
    content
        .lines()
        .filter_map(|line| {
            let (_, value) = line.split_once(':')?;
            let value = value.trim();
            (!value.is_empty())
                .then(|| json!({"summary": value, "question": value, "patterns": []}))
        })
        .collect()
}

fn reflection_timezone(timezone: Option<&str>) -> Result<String, ApiError> {
    if let Some(timezone) = timezone {
        return Ok(timezone.to_owned());
    }
    if let Some(timezone) = std::env::var_os("TZ").and_then(|value| value.into_string().ok()) {
        let path = std::path::Path::new("/usr/share/zoneinfo").join(&timezone);
        if timezone == "UTC" || path.is_file() {
            return Ok(timezone);
        }
    }
    if let Ok(path) = std::fs::canonicalize("/etc/localtime") {
        let marker = std::path::Path::new("/usr/share/zoneinfo");
        if let Ok(relative) = path.strip_prefix(marker) {
            let timezone = relative.to_string_lossy().into_owned();
            if !timezone.is_empty() {
                return Ok(timezone);
            }
        }
    }
    Ok("UTC".to_owned())
}

fn reflection_date(timezone: Option<&str>) -> Result<String, ApiError> {
    let timezone = reflection_timezone(timezone)?;
    if timezone != "UTC"
        && !std::path::Path::new("/usr/share/zoneinfo")
            .join(&timezone)
            .exists()
    {
        return Err(ApiError::bad_request("invalid reflection timezone"));
    }
    let output = std::process::Command::new("date")
        .env("TZ", timezone)
        .args(["+%Y-%m-%d"])
        .output()
        .map_err(|_| ApiError::bad_request("invalid reflection timezone"))?;
    if !output.status.success() {
        return Err(ApiError::bad_request("invalid reflection timezone"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
#[derive(Debug, Deserialize)]
pub(crate) struct ReflectionQuery {
    pub limit: Option<usize>,
    #[serde(alias = "agentId")]
    pub agent_id: Option<String>,
    pub count: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct AnswerBody {
    answer: Option<String>,
}

fn limit(query: &ReflectionQuery) -> usize {
    query.limit.unwrap_or(30).clamp(1, 100)
}

async fn authorize_reflection_read(
    state: &AppState,
    headers: &HeaderMap,
    agent_id: &str,
) -> Result<(), ApiError> {
    let claims = auth::gate(state, headers).await?;
    let workspace = source_workspace(headers, None)?;
    let mut scope = json!({"agent": agent_id});
    if claims
        .get("scope")
        .and_then(Value::as_object)
        .is_some_and(|authority_scope| authority_scope.contains_key("workspace"))
    {
        scope["workspace"] = json!(workspace);
    }
    if !auth::authority_allows(&claims, "agent", &scope, &["recall".to_owned()]) {
        return Err(ApiError::forbidden("recall permission required"));
    }
    Ok(())
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReflectionQuery>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(
        &headers,
        Some(&AgentQuery {
            agent_id: query.agent_id.clone(),
            agent_id_camel: None,
            ..Default::default()
        }),
        None,
    )?;
    authorize_reflection_read(&state, &headers, &agent_id).await?;
    Ok(Json(
        execute(
            &state,
            Operation::ReflectionList {
                agent_id,
                limit: limit(&query),
            },
        )
        .await?,
    ))
}

async fn today(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReflectionQuery>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(
        &headers,
        Some(&AgentQuery {
            agent_id: query.agent_id.clone(),
            agent_id_camel: None,
            ..Default::default()
        }),
        None,
    )?;
    authorize_reflection_read(&state, &headers, &agent_id).await?;
    let workspace = std::env::var_os("SIGNET_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let config = std::fs::read_to_string(workspace.join("agent.yaml")).unwrap_or_default();
    let date = reflection_date(reflection_config(&config).timezone.as_deref())?;
    Ok(Json(
        execute(
            &state,
            Operation::ReflectionToday {
                agent_id,
                date,
                limit: limit(&query),
            },
        )
        .await?,
    ))
}

async fn generate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReflectionQuery>,
) -> Result<Json<Value>, ApiError> {
    let claims = auth::gate(&state, &headers).await?;
    if !auth::authority_allows(
        &claims,
        "agent",
        &json!({"agent": agent(&headers, None, None)?}),
        &["admin".into()],
    ) {
        return Err(ApiError::forbidden("admin permission required"));
    }
    let agent_id = agent(
        &headers,
        Some(&AgentQuery {
            agent_id: query.agent_id.clone(),
            agent_id_camel: None,
            ..Default::default()
        }),
        None,
    )?;
    let workspace = std::env::var_os("SIGNET_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let config = std::fs::read_to_string(workspace.join("agent.yaml")).unwrap_or_default();
    let reflection = reflection_config(&config);
    let date = reflection_date(reflection.timezone.as_deref())?;
    if !reflection.enabled {
        return Err(ApiError::bad_request(
            "Reflections are disabled in pipeline config",
        ));
    }
    let count = query.count.unwrap_or(reflection.count).clamp(1, 6);
    let model = reflection
        .model
        .or_else(|| std::env::var("SIGNET_OPENAI_MODEL").ok())
        .ok_or_else(|| ApiError::bad_request("model is required"))?;
    let memories = execute(
        &state,
        Operation::ReflectionMemories {
            agent_id: agent_id.clone(),
            limit: 50,
        },
    )
    .await?;
    let prompt = format!("Review these memories and return JSON with an entries array containing up to {count} reflective questions. Memories: {}", serde_json::to_string(&memories).unwrap_or_default());
    let response = tokio::time::timeout(
        Duration::from_millis(reflection.timeout_ms.clamp(1, 120_000)),
        super::inference::call_openai(
            &std::env::var("SIGNET_OPENAI_BASE_URL")
                .map_err(|_| ApiError::upstream("provider is not configured"))?,
            std::env::var("SIGNET_OPENAI_API_KEY").ok(),
            json!({"model":model,"messages":[{"role":"user","content":prompt}],"max_tokens":reflection.max_tokens.clamp(1, 16_384)}),
        ),
    )
    .await
    .map_err(|_| ApiError { status: StatusCode::INTERNAL_SERVER_ERROR, code: "internal_error", message: "LLM generation failed".into() })?
    .map_err(|_| ApiError { status: StatusCode::INTERNAL_SERVER_ERROR, code: "internal_error", message: "LLM generation failed".into() })?;
    let content = response
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal_error",
            message: "LLM generation failed".into(),
        })?;
    let entries = parse_reflection_entries(content);
    let inserted = execute(
        &state,
        Operation::ReflectionInsert {
            agent_id: agent_id.clone(),
            date: date.clone(),
            model,
            entries,
        },
    )
    .await?;
    let inserted_count = inserted
        .get("inserted")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let reflections = execute(
        &state,
        Operation::ReflectionToday {
            agent_id,
            date,
            limit: 6,
        },
    )
    .await?;
    Ok(Json(
        json!({"reflection": reflections.get("reflection").cloned().unwrap_or(Value::Null), "reflections": reflections.get("reflections").cloned().unwrap_or(json!([])), "generated": inserted_count}),
    ))
}

async fn answer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReflectionQuery>,
    Path(id): Path<String>,
    body: Result<Json<AnswerBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let claims = auth::gate(&state, &headers).await?;
    let agent_id = agent(
        &headers,
        Some(&AgentQuery {
            agent_id: query.agent_id.clone(),
            agent_id_camel: None,
            ..Default::default()
        }),
        None,
    )?;
    if !auth::authority_allows(
        &claims,
        "agent",
        &json!({"agent": agent_id}),
        &["modify".into()],
    ) {
        return Err(ApiError::forbidden("modify permission required"));
    }
    let Json(body) = body.map_err(|_| ApiError::bad_request("Invalid JSON body"))?;
    let answer = body
        .answer
        .ok_or_else(|| ApiError::bad_request("answer is required"))?;
    let answer = answer.trim().to_owned();
    if answer.is_empty() {
        return Err(ApiError::bad_request("answer is required"));
    }
    if answer.chars().count() > 10_000 {
        return Err(ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            code: "payload_too_large",
            message: "answer exceeds 10000 characters".into(),
        });
    }
    let result = execute(
        &state,
        Operation::ReflectionAnswer {
            agent_id,
            id,
            answer,
            memory_id: Uuid::new_v4().to_string(),
            answered_at: OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
        },
    )
    .await;
    match result {
        Err(error)
            if error.message == "already answered" || error.message == "Already answered" =>
        {
            Err(ApiError {
                status: StatusCode::CONFLICT,
                code: "conflict",
                message: error.message,
            })
        }
        other => other.map(Json),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_reads_only_nested_memory_pipeline_reflections() {
        let config = reflection_config("reflections:\n  enabled: true\nmemory:\n  pipelineV2:\n    reflections:\n      enabled: true\n      count: 9\n      model: nested\n      timeout: 1234\n      maxTokens: 77\n      timezone: America/Denver\n");
        assert!(config.enabled);
        assert_eq!(config.count, 9);
        assert_eq!(config.model.as_deref(), Some("nested"));
        assert_eq!(config.timeout_ms, 1234);
        assert_eq!(config.max_tokens, 77);
        assert_eq!(config.timezone.as_deref(), Some("America/Denver"));
    }

    #[test]
    fn omitted_reflections_use_current_typescript_defaults() {
        let config = reflection_config("memory:\n  pipelineV2:\n    enabled: true\n");
        assert!(config.enabled);
        assert_eq!(config.model.as_deref(), Some("qwen3:4b"));
        assert_eq!(config.count, 3);
        assert_eq!(config.timeout_ms, 120_000);
        assert_eq!(config.max_tokens, 4_000);
    }

    #[test]
    fn omitted_timezone_uses_runtime_local_timezone_instead_of_forcing_utc() {
        let previous = std::env::var_os("TZ");
        std::env::set_var("TZ", "America/Denver");
        assert_eq!(
            reflection_timezone(None).unwrap_or_default(),
            "America/Denver"
        );
        match previous {
            Some(value) => std::env::set_var("TZ", value),
            None => std::env::remove_var("TZ"),
        }
    }

    #[test]
    fn configured_timezone_uses_local_calendar_date_at_utc_boundary() {
        let output = std::process::Command::new("date")
            .env("TZ", "America/Denver")
            .args(["-d", "@1704067200", "+%Y-%m-%d"])
            .output()
            .expect("date command");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "2023-12-31");
    }

    #[test]
    fn parses_json_and_labeled_provider_entries() {
        let json_entries = parse_reflection_entries(
            r#"{"entries":[{"question":"one?"}],"insights":[{"question":"two?"}]}"#,
        );
        assert_eq!(json_entries.len(), 1);
        let labeled = parse_reflection_entries("BRIEF: notice\nQUESTION: ask?\nINSIGHT: another");
        assert_eq!(labeled.len(), 3);
        assert_eq!(labeled[0]["question"], "notice");
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/reflections", get(list))
        .route("/api/reflections/today", get(today))
        .route("/api/reflections/generate", post(generate))
        .route("/api/reflections/{id}/answer", post(answer))
}
