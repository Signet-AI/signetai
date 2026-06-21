//! OS integration routes.

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::Engine;
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use signet_core::db::Priority;
use signet_core::error::CoreError;
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;

use crate::{
    routes::marketplace::McpServer,
    state::{AppState, OsAgentSession},
    workspace_paths,
};

const EVENT_BUFFER_SIZE: usize = 500;
const DEFAULT_WINDOW_MS: i64 = 300_000;
const MAX_CONTEXT_EVENTS: usize = 100;
const DEDUP_WINDOW_MS: i64 = 500;
const GRID_COLS: i64 = 12;
const OS_MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const OS_PROBE_CLIENT_NAME: &str = "signet-os-probe";
const OS_PROBE_CLIENT_VERSION: &str = "0.1.0";
const SECRET_REF_PREFIX: &str = "secret://";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsQuery {
    r#type: Option<String>,
    limit: Option<usize>,
    window_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventsQuery {
    session: Option<String>,
}

#[derive(Debug)]
struct EventBus {
    buffer: Mutex<VecDeque<Value>>,
    last_event_hash: Mutex<HashMap<String, i64>>,
    tx: broadcast::Sender<Value>,
    subscribers: AtomicUsize,
}

fn event_bus() -> &'static EventBus {
    static BUS: OnceLock<EventBus> = OnceLock::new();
    BUS.get_or_init(|| {
        let (tx, _rx) = broadcast::channel(512);
        EventBus {
            buffer: Mutex::new(VecDeque::new()),
            last_event_hash: Mutex::new(HashMap::new()),
            tx,
            subscribers: AtomicUsize::new(0),
        }
    })
}

fn agent_event_bus() -> &'static EventBus {
    static BUS: OnceLock<EventBus> = OnceLock::new();
    BUS.get_or_init(|| {
        let (tx, _rx) = broadcast::channel(512);
        EventBus {
            buffer: Mutex::new(VecDeque::new()),
            last_event_hash: Mutex::new(HashMap::new()),
            tx,
            subscribers: AtomicUsize::new(0),
        }
    })
}

impl EventBus {
    fn emit(&self, source: &str, event_type: &str, payload: Value) -> Value {
        let now = now_ms();
        let dedup_key = format!("{event_type}:{source}");
        {
            let mut last = self.last_event_hash.lock().expect("event dedup lock");
            if last
                .get(&dedup_key)
                .map(|previous| now - *previous < DEDUP_WINDOW_MS)
                .unwrap_or(false)
            {
                return json!({"deduped": true});
            }
            last.insert(dedup_key, now);
            if last.len() > 1000 {
                let cutoff = now - (DEDUP_WINDOW_MS * 2);
                last.retain(|_, timestamp| *timestamp >= cutoff);
            }
        }

        let event = json!({
            "id": format!("{}-{}", base36(now), uuid::Uuid::new_v4().simple().to_string().chars().take(6).collect::<String>()),
            "source": source,
            "type": event_type,
            "timestamp": now,
            "payload": payload,
        });
        {
            let mut buffer = self.buffer.lock().expect("event buffer lock");
            buffer.push_back(event.clone());
            let cutoff = now - DEFAULT_WINDOW_MS;
            while buffer
                .front()
                .and_then(|value| value.get("timestamp").and_then(Value::as_i64))
                .map(|timestamp| timestamp < cutoff)
                .unwrap_or(false)
            {
                buffer.pop_front();
            }
            while buffer.len() > EVENT_BUFFER_SIZE {
                buffer.pop_front();
            }
        }
        let _ = self.tx.send(event.clone());
        event
    }

    fn emit_raw(&self, event: Value) {
        let now = now_ms();
        {
            let mut buffer = self.buffer.lock().expect("event buffer lock");
            buffer.push_back(event.clone());
            let cutoff = now - DEFAULT_WINDOW_MS;
            while buffer
                .front()
                .and_then(|value| value.get("timestamp").and_then(Value::as_i64))
                .map(|timestamp| timestamp < cutoff)
                .unwrap_or(false)
            {
                buffer.pop_front();
            }
            while buffer.len() > EVENT_BUFFER_SIZE {
                buffer.pop_front();
            }
        }
        let _ = self.tx.send(event);
    }

    fn recent(&self, filter_type: Option<&str>, limit: usize, window_ms: i64) -> Vec<Value> {
        let cutoff = now_ms() - window_ms;
        let mut events = self
            .buffer
            .lock()
            .expect("event buffer lock")
            .iter()
            .filter(|event| event.get("timestamp").and_then(Value::as_i64).unwrap_or(0) >= cutoff)
            .filter(|event| {
                filter_type
                    .map(|event_type| {
                        event.get("type").and_then(Value::as_str) == Some(event_type)
                            || event
                                .get("type")
                                .and_then(Value::as_str)
                                .map(|candidate| candidate.starts_with(&format!("{event_type}.")))
                                .unwrap_or(false)
                    })
                    .unwrap_or(true)
            })
            .cloned()
            .collect::<Vec<_>>();
        events.sort_by(|left, right| {
            right
                .get("timestamp")
                .and_then(Value::as_i64)
                .cmp(&left.get("timestamp").and_then(Value::as_i64))
        });
        events.truncate(limit);
        events
    }

    fn stats(&self) -> Value {
        let buffer = self.buffer.lock().expect("event buffer lock");
        json!({
            "bufferSize": buffer.len(),
            "subscriptionCount": self.subscribers.load(Ordering::SeqCst),
            "listenerCount": self.subscribers.load(Ordering::SeqCst),
        })
    }
}

pub async fn events(Query(query): Query<EventsQuery>) -> Json<Value> {
    let limit = query.limit.unwrap_or(50).clamp(1, 500);
    let window_ms = query.window_ms.unwrap_or(300_000).clamp(1_000, 1_800_000) as i64;
    let events = event_bus().recent(query.r#type.as_deref(), limit, window_ms);
    Json(json!({
        "events": events,
        "count": events.len(),
        "query": {
            "type": query.r#type,
            "limit": limit,
            "windowMs": window_ms,
        },
    }))
}

pub async fn events_stream(Query(query): Query<EventsQuery>) -> Response {
    let subscribe_type = query.r#type.unwrap_or_else(|| "*".to_string());
    let (tx, rx) = mpsc::channel::<Result<Bytes, Infallible>>(32);
    let mut bus_rx = event_bus().tx.subscribe();
    event_bus().subscribers.fetch_add(1, Ordering::SeqCst);
    let replay_type = if subscribe_type == "*" {
        None
    } else {
        Some(subscribe_type.clone())
    };
    let replay = event_bus().recent(replay_type.as_deref(), 50, DEFAULT_WINDOW_MS);

    tokio::spawn(async move {
        let _subscriber = SubscriberGuard::new(event_bus());
        if !send_sse(
            &tx,
            json!({"type": "connected", "subscribedTo": subscribe_type}),
        )
        .await
        {
            return;
        }
        for event in replay.into_iter().rev() {
            if !send_sse(&tx, event).await {
                return;
            }
        }
        let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    if tx.send(Ok(Bytes::from_static(b": heartbeat\n\n"))).await.is_err() {
                        return;
                    }
                }
                received = bus_rx.recv() => {
                    let Ok(event) = received else { continue; };
                    if sse_type_matches(&event, &subscribe_type) && !send_sse(&tx, event).await {
                        return;
                    }
                }
            }
        }
    });
    sse_response(rx)
}

pub async fn context() -> Json<Value> {
    let now = now_ms();
    let events = event_bus().recent(None, EVENT_BUFFER_SIZE, DEFAULT_WINDOW_MS);
    let window_events = events
        .iter()
        .filter(|event| {
            event.get("timestamp").and_then(Value::as_i64).unwrap_or(0) >= now - DEFAULT_WINDOW_MS
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut deduped = HashMap::<String, Value>::new();
    for event in &window_events {
        let key = format!(
            "{}:{}:{}",
            event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            event
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            event
                .get("payload")
                .map(Value::to_string)
                .unwrap_or_default()
        );
        let replace = deduped
            .get(&key)
            .and_then(|existing| existing.get("timestamp").and_then(Value::as_i64))
            .map(|existing_ts| {
                event.get("timestamp").and_then(Value::as_i64).unwrap_or(0) > existing_ts
            })
            .unwrap_or(true);
        if replace {
            deduped.insert(key, event.clone());
        }
    }
    let mut sorted = deduped.into_values().collect::<Vec<_>>();
    sorted.sort_by(|left, right| {
        right
            .get("timestamp")
            .and_then(Value::as_i64)
            .cmp(&left.get("timestamp").and_then(Value::as_i64))
    });
    sorted.truncate(MAX_CONTEXT_EVENTS);
    let active_sources = sorted
        .iter()
        .filter_map(|event| event.get("source").and_then(Value::as_str))
        .collect::<std::collections::HashSet<_>>()
        .len();
    let window_start = sorted
        .last()
        .and_then(|event| event.get("timestamp").and_then(Value::as_i64))
        .unwrap_or(now);
    let window_end = sorted
        .first()
        .and_then(|event| event.get("timestamp").and_then(Value::as_i64))
        .unwrap_or(now);
    Json(json!({
        "events": sorted,
        "totalEvents": window_events.len(),
        "windowStart": window_start,
        "windowEnd": window_end,
        "activeSources": active_sources,
        "generatedAt": now,
    }))
}

pub async fn event_stats() -> Json<Value> {
    Json(event_bus().stats())
}

pub async fn agent_sessions(State(state): State<Arc<AppState>>) -> Json<Value> {
    let mut sessions = state
        .os_agent_sessions
        .read()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| left.id.cmp(&right.id));
    Json(json!({"sessions": sessions, "count": sessions.len()}))
}

pub async fn agent_events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AgentEventsQuery>,
) -> Response {
    let session_filter = query.session.clone();
    let connected_session = if let Some(session_id) = session_filter.as_deref() {
        let sessions = state.os_agent_sessions.read().await;
        let Some(session) = sessions.get(session_id).cloned() else {
            let (tx, rx) = mpsc::channel::<Result<Bytes, Infallible>>(1);
            tokio::spawn(async move {
                let _ = send_sse(
                    &tx,
                    json!({"type": "error", "data": {"error": "Session not found"}}),
                )
                .await;
            });
            return sse_response(rx);
        };
        Some(session)
    } else {
        None
    };

    let (tx, rx) = mpsc::channel::<Result<Bytes, Infallible>>(32);
    let mut bus_rx = agent_event_bus().tx.subscribe();
    agent_event_bus().subscribers.fetch_add(1, Ordering::SeqCst);
    let replay = agent_event_bus().recent(None, 50, DEFAULT_WINDOW_MS);
    tokio::spawn(async move {
        let _subscriber = SubscriberGuard::new(agent_event_bus());
        let connected = connected_session
            .as_ref()
            .map(|session| {
                json!({
                    "type": "connected",
                    "sessionId": session.id,
                    "serverId": session.server_id,
                })
            })
            .unwrap_or_else(|| json!({"type": "connected"}));
        if !send_sse(&tx, connected).await {
            return;
        }
        for event in replay.into_iter().rev() {
            if agent_session_matches(&event, session_filter.as_deref())
                && !send_sse(&tx, event).await
            {
                return;
            }
        }
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    if tx.send(Ok(Bytes::from_static(b": heartbeat\n\n"))).await.is_err() {
                        return;
                    }
                }
                received = bus_rx.recv() => {
                    let Ok(event) = received else { continue; };
                    if agent_session_matches(&event, session_filter.as_deref()) && !send_sse(&tx, event).await {
                        return;
                    }
                }
            }
        }
    });
    sse_response(rx)
}

pub async fn agent_execute(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let server_id = body
        .get("serverId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let task = body
        .get("task")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if server_id.is_none() || task.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "serverId and task are required"})),
        )
            .into_response();
    }
    let server_id = server_id.expect("validated serverId").to_string();
    let mut sessions = state.os_agent_sessions.write().await;
    if sessions
        .values()
        .any(|session| session.server_id == server_id && session.status == "running")
    {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error": "An agent session is already running for this server"})),
        )
            .into_response();
    }

    let session_id = format!("agent_{}_{}", now_ms(), sessions.len() + 1);
    let session = OsAgentSession {
        id: session_id.clone(),
        server_id: server_id.clone(),
        task: task.expect("validated task").to_string(),
        agent_id: body
            .get("agentId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        task_class: body
            .get("taskClass")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        privacy: body
            .get("privacy")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        status: "running".to_string(),
        step: 0,
        max_steps: body
            .get("maxSteps")
            .and_then(Value::as_u64)
            .map(|value| value.clamp(1, 100) as u32)
            .unwrap_or(20),
        result: None,
        error: None,
    };
    sessions.insert(session_id.clone(), session.clone());
    drop(sessions);

    emit_agent_event(
        "agentStart",
        &session_id,
        &server_id,
        json!({"task": session.task, "maxSteps": session.max_steps}),
    );
    emit_agent_event(
        "status",
        &session_id,
        &server_id,
        json!({"step": 0, "status": "running", "message": "Agent session created"}),
    );
    emit_agent_event("getDomState", &session_id, &server_id, Value::Null);
    event_bus().emit(
        "os-agent",
        "agent.session-started",
        json!({"sessionId": session_id, "serverId": server_id}),
    );

    (
        StatusCode::OK,
        Json(json!({"sessionId": session_id, "serverId": server_id})),
    )
        .into_response()
}

pub async fn agent_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let session_id = body
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(session_id) = session_id else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "sessionId is required"})),
        )
            .into_response();
    };

    let mut sessions = state.os_agent_sessions.write().await;
    let Some(session) = sessions.get_mut(session_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Session not found"})),
        )
            .into_response();
    };

    if let Some(step) = body.get("step").and_then(Value::as_u64) {
        session.step = step.min(u32::MAX as u64) as u32;
    }
    if let Some(status) = body.get("status").and_then(Value::as_str) {
        if matches!(status, "running" | "done" | "error") {
            session.status = status.to_string();
        }
    }
    if let Some(result) = body.get("result") {
        session.result = Some(result.clone());
    }
    if let Some(error) = body.get("error").and_then(Value::as_str) {
        session.error = Some(error.to_string());
        session.status = "error".to_string();
    }
    let server_id = session.server_id.clone();
    let status = session.status.clone();
    let step = session.step;
    let result = session.result.clone();
    let error = session.error.clone();
    drop(sessions);

    emit_agent_event(
        "status",
        session_id,
        &server_id,
        json!({
            "step": step,
            "status": status,
            "domState": body.get("domState").cloned().unwrap_or(Value::Null),
        }),
    );
    if status == "done" {
        emit_agent_event(
            "done",
            session_id,
            &server_id,
            json!({"step": step, "summary": result}),
        );
        emit_agent_event("agentStop", session_id, &server_id, Value::Null);
    } else if status == "error" {
        emit_agent_event("error", session_id, &server_id, json!({"error": error}));
        emit_agent_event("agentStop", session_id, &server_id, Value::Null);
    }
    event_bus().emit(
        "os-agent",
        "agent.state-updated",
        json!({"sessionId": session_id, "serverId": server_id, "status": status}),
    );

    Json(json!({"success": true})).into_response()
}

pub async fn chat(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(message) = message else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Message is required"})),
        )
            .into_response();
    };

    let response = if available_tool_count(&state).await == 0 {
        json!({
            "response": "No MCP servers are installed yet. Add some from the dock to get started.",
            "toolCalls": [],
        })
    } else {
        let chat_session_id = format!("chat_{}", uuid::Uuid::new_v4().simple());
        json!({
            "sessionId": chat_session_id,
            "response": "OS chat planning is handled by the dashboard inference runtime in the Rust daemon contract.",
            "toolCalls": [],
            "useAgent": false,
            "agentTask": message,
        })
    };

    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        let (tx, rx) = mpsc::channel::<Result<Bytes, Infallible>>(4);
        tokio::spawn(async move {
            let _ = send_sse(&tx, json!({"type": "connected"})).await;
            let _ = send_sse(&tx, json!({"type": "message", "data": response})).await;
            let _ = send_sse(&tx, json!({"type": "done"})).await;
        });
        return sse_response(rx);
    }

    Json(response).into_response()
}

pub async fn tray(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    if let Err(error) = sync_installed_to_tray(&state).await {
        return internal_error(error).into_response();
    }
    match load_tray(&state).await {
        Ok(entries) => Json(json!({"entries": entries, "count": entries.len()})).into_response(),
        Err(error) => internal_error(error).into_response(),
    }
}

pub async fn tray_get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match get_tray_entry(&state, &id).await {
        Ok(Some(entry)) => Json(json!({"entry": entry})).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "App not found in tray"})),
        )
            .into_response(),
        Err(error) => internal_error(error).into_response(),
    }
}

pub async fn tray_probe(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match get_probe_result(&state, &id).await {
        Ok(Some(probe)) => Json(json!({"probe": probe})).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "No probe result found"})),
        )
            .into_response(),
        Err(error) => internal_error(error).into_response(),
    }
}

pub async fn tray_reprobe(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let installed = read_installed_servers(&state);
    let Some(server) = installed
        .iter()
        .find(|server| server.get("id").and_then(Value::as_str) == Some(id.as_str()))
        .cloned()
    else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Server not found in installed servers"})),
        )
            .into_response();
    };
    let probe = probe_server(&state, &server).await;
    match store_probe_result(&state, &id, probe.clone()).await {
        Ok(()) => {
            if let Err(error) = upsert_tray_entry_from_probe(&state, &probe).await {
                return internal_error(error).into_response();
            }
            Json(json!({"success": true, "probe": probe})).into_response()
        }
        Err(error) => internal_error(error).into_response(),
    }
}

pub async fn tray_patch(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if let Some(state_value) = body.get("state").and_then(Value::as_str)
        && !matches!(state_value, "tray" | "grid" | "dock")
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "state must be tray, grid, or dock"})),
        )
            .into_response();
    }

    match patch_tray_entry(&state, &id, body).await {
        Ok(Some(entry)) => Json(json!({"success": true, "entry": entry})).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "App not found in tray"})),
        )
            .into_response(),
        Err(error) => internal_error(error).into_response(),
    }
}

pub async fn install(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let url = body
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(url) = url else {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({"ok": false, "widgetId": "", "manifest": null, "error": "url is required"}),
            ),
        )
            .into_response();
    };
    let parsed = match reqwest::Url::parse(url) {
        Ok(parsed) => parsed,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "widgetId": "", "manifest": null, "error": "Invalid URL format"})),
            )
                .into_response();
        }
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "widgetId": "", "manifest": null, "error": "Only HTTP/HTTPS URLs are supported"})),
        )
            .into_response();
    }
    if parsed.host_str().map(is_private_hostname).unwrap_or(true) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "widgetId": "", "manifest": null, "error": "Private/loopback addresses are not allowed"})),
        )
            .into_response();
    }

    match install_direct_http(&state, url, body.get("name").and_then(Value::as_str)) {
        Ok(server_id) => {
            let installed = read_installed_servers(&state);
            if let Some(server) = installed
                .iter()
                .find(|server| server.get("id").and_then(Value::as_str) == Some(server_id.as_str()))
                .cloned()
            {
                let mut entry = tray_entry_for_server(&server);
                if body.get("autoPlace").and_then(Value::as_bool) == Some(true) {
                    if let Ok(entries) = load_tray(&state).await {
                        let occupied = entries
                            .iter()
                            .filter(|entry| {
                                entry.get("state").and_then(Value::as_str) == Some("grid")
                            })
                            .filter_map(|entry| entry.get("gridPosition").cloned())
                            .collect::<Vec<_>>();
                        entry["state"] = json!("grid");
                        entry["gridPosition"] = json!(find_free_grid_position(&occupied, 4, 3));
                    }
                }
                let _ = upsert_tray_entry(&state, entry).await;
            }
            event_bus().emit("os-install", "tray.install", json!({"serverId": server_id}));
            (
                StatusCode::OK,
                Json(json!({"ok": true, "widgetId": server_id, "manifest": null})),
            )
                .into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "widgetId": "", "manifest": null, "error": error})),
        )
            .into_response(),
    }
}

pub async fn widget_generate(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let server_id = body
        .get("serverId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(server_id) = server_id else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "serverId is required"})),
        )
            .into_response();
    };
    if body.get("force").and_then(Value::as_bool) != Some(true) {
        match get_widget(&state, server_id).await {
            Ok(Some(widget)) if widget.get("html").and_then(Value::as_str).is_some() => {
                return Json(json!({"status": "cached", "html": widget["html"].clone()}))
                    .into_response();
            }
            Ok(_) => {}
            Err(error) => return internal_error(error).into_response(),
        }
    }
    if body.get("html").and_then(Value::as_str).is_some() {
        if let Err(error) = upsert_widget_job(&state, server_id, "cached", body.clone()).await {
            return internal_error(error).into_response();
        }
        event_bus().emit(
            "widget",
            "widget.generated",
            json!({"serverId": server_id, "success": true}),
        );
        return Json(json!({"status": "cached", "html": body["html"].clone()})).into_response();
    }

    let error = "Rust daemon widget generation requires generated html from the dashboard runtime";
    if let Err(db_error) = upsert_widget_job(&state, server_id, "error", body.clone()).await {
        return internal_error(db_error).into_response();
    }
    event_bus().emit(
        "widget",
        "widget.error",
        json!({"serverId": server_id, "error": error}),
    );
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({"status": "error", "error": error})),
    )
        .into_response()
}

pub async fn widget_get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match get_widget(&state, &id).await {
        Ok(Some(widget)) if widget.get("html").and_then(Value::as_str).is_some() => Json(json!({
            "html": widget["html"].clone(),
            "generatedAt": widget.get("generatedAt").cloned().unwrap_or(Value::Null),
        }))
        .into_response(),
        Ok(Some(widget)) if widget.get("status").and_then(Value::as_str) == Some("generating") => (
            StatusCode::ACCEPTED,
            Json(json!({"status": "generating", "generatedAt": null})),
        )
            .into_response(),
        Ok(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Widget not found"})),
        )
            .into_response(),
        Err(error) => internal_error(error).into_response(),
    }
}

pub async fn widget_delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match delete_widget(&state, &id).await {
        Ok(()) => Json(json!({"success": true})).into_response(),
        Err(error) => internal_error(error).into_response(),
    }
}

struct SubscriberGuard(&'static EventBus);

impl SubscriberGuard {
    fn new(bus: &'static EventBus) -> Self {
        Self(bus)
    }
}

impl Drop for SubscriberGuard {
    fn drop(&mut self) {
        self.0.subscribers.fetch_sub(1, Ordering::SeqCst);
    }
}

fn sse_payload(event: Value) -> Result<Bytes, Infallible> {
    Ok(Bytes::from(format!("data: {event}\n\n")))
}

async fn send_sse(tx: &mpsc::Sender<Result<Bytes, Infallible>>, event: Value) -> bool {
    tx.send(sse_payload(event)).await.is_ok()
}

fn sse_response(rx: mpsc::Receiver<Result<Bytes, Infallible>>) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::CONNECTION, "keep-alive"),
        ],
        Body::from_stream(ReceiverStream::new(rx)),
    )
        .into_response()
}

fn sse_type_matches(event: &Value, subscribe_type: &str) -> bool {
    subscribe_type == "*"
        || event.get("type").and_then(Value::as_str) == Some(subscribe_type)
        || event
            .get("type")
            .and_then(Value::as_str)
            .map(|event_type| event_type.starts_with(&format!("{subscribe_type}.")))
            .unwrap_or(false)
}

fn emit_agent_event(event_type: &str, session_id: &str, server_id: &str, data: Value) {
    agent_event_bus().emit_raw(json!({
        "type": event_type,
        "sessionId": session_id,
        "serverId": server_id,
        "data": data,
        "timestamp": now_ms(),
    }));
}

fn agent_session_matches(event: &Value, session: Option<&str>) -> bool {
    let Some(session) = session else {
        return true;
    };
    event.get("sessionId").and_then(Value::as_str) == Some(session)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn base36(mut value: i64) -> String {
    if value <= 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize] as char);
        value /= 36;
    }
    out.iter().rev().collect()
}

fn internal_error(error: impl ToString) -> (StatusCode, Json<Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": error.to_string()})),
    )
}

async fn load_tray(state: &AppState) -> Result<Vec<Value>, CoreError> {
    state
        .pool
        .read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT entry_json FROM os_tray_entries ORDER BY created_at ASC, id ASC",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            let mut entries = Vec::new();
            for row in rows {
                entries.push(serde_json::from_str(&row?)?);
            }
            Ok(entries)
        })
        .await
}

async fn get_tray_entry(state: &AppState, id: &str) -> Result<Option<Value>, CoreError> {
    let id = id.to_string();
    state
        .pool
        .read(move |conn| {
            conn.query_row(
                "SELECT entry_json FROM os_tray_entries WHERE id = ?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|raw| serde_json::from_str(&raw).map_err(CoreError::from))
            .transpose()
        })
        .await
}

async fn upsert_tray_entry(state: &AppState, mut entry: Value) -> Result<(), CoreError> {
    let id = entry
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Invalid("tray entry missing id".into()))?
        .to_string();
    let now = chrono::Utc::now().to_rfc3339();
    if entry.get("createdAt").is_none() {
        entry["createdAt"] = json!(now.clone());
    }
    entry["updatedAt"] = json!(now.clone());
    let state_value = entry
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("tray")
        .to_string();
    let raw = serde_json::to_string(&entry)?;
    state
        .pool
        .write(Priority::Low, move |conn| {
            conn.execute(
                "INSERT INTO os_tray_entries (id, state, entry_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                   state = excluded.state,
                   entry_json = excluded.entry_json,
                   updated_at = excluded.updated_at",
                params![id, state_value, raw, now],
            )?;
            Ok(json!({"success": true}))
        })
        .await
        .map(|_| ())
}

async fn patch_tray_entry(
    state: &AppState,
    id: &str,
    body: Value,
) -> Result<Option<Value>, CoreError> {
    let id = id.to_string();
    let now = chrono::Utc::now().to_rfc3339();
    state
        .pool
        .write(Priority::High, move |conn| {
            let Some(raw) = conn
                .query_row(
                    "SELECT entry_json FROM os_tray_entries WHERE id = ?1",
                    [&id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            else {
                return Ok(Value::Null);
            };
            let mut entry: Value = serde_json::from_str(&raw)?;
            if let Some(state_value) = body.get("state").and_then(Value::as_str) {
                entry["state"] = json!(state_value);
            }
            if let Some(position) = body.get("gridPosition") {
                entry["gridPosition"] = position.clone();
            }
            entry["updatedAt"] = json!(now.clone());
            let state_value = entry
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("tray")
                .to_string();
            conn.execute(
                "UPDATE os_tray_entries SET state = ?2, entry_json = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, state_value, serde_json::to_string(&entry)?, now],
            )?;
            Ok(entry)
        })
        .await
        .map(|value| if value.is_null() { None } else { Some(value) })
}

async fn sync_installed_to_tray(state: &AppState) -> Result<(), CoreError> {
    let existing = load_tray(state).await?;
    let existing_ids = existing
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<std::collections::HashSet<_>>();
    for server in read_installed_servers(state).into_iter().filter(|server| {
        server
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }) {
        if let Some(id) = server.get("id").and_then(Value::as_str)
            && !existing_ids.contains(id)
        {
            upsert_tray_entry(state, tray_entry_for_server(&server)).await?;
        }
    }
    Ok(())
}

async fn get_probe_result(state: &AppState, id: &str) -> Result<Option<Value>, CoreError> {
    let id = id.to_string();
    state
        .pool
        .read(move |conn| {
            conn.query_row(
                "SELECT probe_json FROM os_probe_results WHERE server_id = ?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|raw| serde_json::from_str(&raw).map_err(CoreError::from))
            .transpose()
        })
        .await
}

async fn store_probe_result(state: &AppState, id: &str, probe: Value) -> Result<(), CoreError> {
    let id = id.to_string();
    let raw = serde_json::to_string(&probe)?;
    let now = chrono::Utc::now().to_rfc3339();
    state
        .pool
        .write(Priority::Low, move |conn| {
            conn.execute(
                "INSERT INTO os_probe_results (server_id, probe_json, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(server_id) DO UPDATE SET
                   probe_json = excluded.probe_json,
                   updated_at = excluded.updated_at",
                params![id, raw, now],
            )?;
            Ok(json!({"success": true}))
        })
        .await
        .map(|_| ())
}

async fn upsert_tray_entry_from_probe(state: &AppState, probe: &Value) -> Result<(), CoreError> {
    let id = probe
        .get("serverId")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Invalid("probe missing serverId".into()))?;
    let previous_entry = get_tray_entry(state, id).await?;
    let auto_card = probe.get("autoCard").cloned().unwrap_or_else(|| {
        json!({
            "name": "MCP Server",
            "tools": [],
            "resources": [],
            "hasAppResources": false,
            "defaultSize": {"w": 4, "h": 3},
        })
    });
    let declared_manifest = probe
        .get("declaredManifest")
        .filter(|value| !value.is_null());
    let effective_manifest = declared_manifest.cloned().unwrap_or_else(|| {
        json!({
            "name": auto_card
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("MCP Server"),
            "defaultSize": auto_card
                .get("defaultSize")
                .cloned()
                .unwrap_or_else(|| json!({"w": 4, "h": 3})),
        })
    });
    let created_at = previous_entry
        .as_ref()
        .and_then(|entry| entry.get("createdAt").cloned())
        .unwrap_or_else(|| json!(chrono::Utc::now().to_rfc3339()));
    let tools_changed = previous_entry
        .as_ref()
        .map(|entry| {
            auto_card_tool_names(entry.get("autoCard")) != auto_card_tool_names(Some(&auto_card))
        })
        .unwrap_or(false);
    let state_value = if declared_manifest
        .and_then(|manifest| manifest.get("dock"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        "dock"
    } else {
        "tray"
    };
    upsert_tray_entry(
        state,
        json!({
            "id": id,
            "name": effective_manifest
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("MCP Server"),
            "icon": effective_manifest.get("icon").cloned().unwrap_or(Value::Null),
            "state": state_value,
            "manifest": effective_manifest,
            "autoCard": auto_card,
            "hasDeclaredManifest": declared_manifest.is_some(),
            "createdAt": created_at,
        }),
    )
    .await?;
    if tools_changed && get_widget(state, id).await?.is_some() {
        delete_widget(state, id).await?;
        // Mirrors TS widget cache invalidation at platform/daemon/src/mcp-probe.ts:496-504.
        event_bus().emit("system", "widget.invalidated", json!({"serverId": id}));
    }
    Ok(())
}

fn auto_card_tool_names(auto_card: Option<&Value>) -> std::collections::BTreeSet<String> {
    auto_card
        .and_then(|value| value.get("tools"))
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

async fn upsert_widget_job(
    state: &AppState,
    id: &str,
    status: &str,
    body: Value,
) -> Result<(), CoreError> {
    let id = id.to_string();
    let status = status.to_string();
    let html = body.get("html").and_then(Value::as_str).map(str::to_string);
    let job_json = serde_json::to_string(&body)?;
    let now = chrono::Utc::now().to_rfc3339();
    let generated_at = if html.is_some() {
        Some(now.clone())
    } else {
        None
    };
    state
        .pool
        .write(Priority::Low, move |conn| {
            conn.execute(
                "INSERT INTO os_widgets (id, status, html, job_json, generated_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                   status = excluded.status,
                   html = COALESCE(excluded.html, os_widgets.html),
                   job_json = excluded.job_json,
                   generated_at = COALESCE(excluded.generated_at, os_widgets.generated_at),
                   updated_at = excluded.updated_at",
                params![id, status, html, job_json, generated_at, now],
            )?;
            Ok(json!({"success": true}))
        })
        .await
        .map(|_| ())
}

async fn get_widget(state: &AppState, id: &str) -> Result<Option<Value>, CoreError> {
    let id = id.to_string();
    state
        .pool
        .read(move |conn| {
            conn.query_row(
                "SELECT status, html, generated_at, job_json FROM os_widgets WHERE id = ?1",
                [id],
                |row| {
                    let status: String = row.get(0)?;
                    let html: Option<String> = row.get(1)?;
                    let generated_at: Option<String> = row.get(2)?;
                    let job_json: Option<String> = row.get(3)?;
                    Ok(json!({
                        "status": status,
                        "html": html,
                        "generatedAt": generated_at,
                        "job": job_json.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()),
                    }))
                },
            )
            .optional()
            .map_err(CoreError::from)
        })
        .await
}

async fn delete_widget(state: &AppState, id: &str) -> Result<(), CoreError> {
    let id = id.to_string();
    state
        .pool
        .write(Priority::Low, move |conn| {
            conn.execute("DELETE FROM os_widgets WHERE id = ?1", [id])?;
            Ok(json!({"success": true}))
        })
        .await
        .map(|_| ())
}

async fn available_tool_count(state: &AppState) -> usize {
    let probes = state
        .pool
        .read(|conn| {
            let mut stmt = conn.prepare("SELECT probe_json FROM os_probe_results")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            let mut total = 0;
            for row in rows {
                let raw = row?;
                let probe: Value = serde_json::from_str(&raw)?;
                total += probe
                    .get("autoCard")
                    .and_then(|auto| auto.get("tools"))
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0);
            }
            Ok(total)
        })
        .await;
    probes.unwrap_or(0)
}

async fn probe_server(state: &AppState, server: &Value) -> Value {
    let now = chrono::Utc::now().to_rfc3339();
    let Ok(server_config) = installed_server_from_value(server) else {
        return failed_probe_result(server, "invalid installed MCP server config", now);
    };

    // Mirrors the TS probe transport lifecycle at platform/daemon/src/mcp-probe.ts:82-130
    // and discovery ordering at platform/daemon/src/mcp-probe.ts:301-400: initialize,
    // notifications/initialized, tools/list, resources/list, then manifest metadata parsing.
    let probe_data = match probe_mcp_server(state, &server_config).await {
        Ok(result) => result,
        Err(error) => return failed_probe_result(server, error, now),
    };
    let tools = auto_card_tools(&probe_data.tools_result);
    let resources = auto_card_resources(&probe_data.resources_result);
    let declared_manifest = probe_data
        .server_metadata
        .as_ref()
        .and_then(|metadata| parse_declared_manifest(metadata, &server_config.name))
        .unwrap_or(Value::Null);
    let has_app_resources = resources.iter().any(|resource| {
        resource
            .get("uri")
            .and_then(Value::as_str)
            .map(|uri| uri.starts_with("app://"))
            .unwrap_or(false)
    });
    let name = server
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("MCP Server");

    json!({
        "serverId": server_config.id,
        "ok": true,
        "error": null,
        "declaredManifest": declared_manifest,
        "autoCard": {
            "name": name,
            "tools": tools,
            "resources": resources,
            "hasAppResources": has_app_resources,
            "defaultSize": {"w": 4, "h": 3},
        },
        "toolCount": tools.len(),
        "resourceCount": resources.len(),
        "hasAppResources": has_app_resources,
        "probedAt": now,
    })
}

struct ProbeMcpData {
    tools_result: Value,
    resources_result: Value,
    server_metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct OsSecretEntry {
    ciphertext: String,
}

#[derive(Debug, Default, Deserialize)]
struct OsSecretsStore {
    secrets: HashMap<String, OsSecretEntry>,
}

fn parse_secret_reference(value: &str) -> Option<&str> {
    value
        .strip_prefix(SECRET_REF_PREFIX)
        .map(str::trim)
        .filter(|name| !name.is_empty())
}

fn load_os_secrets_store(state: &AppState) -> OsSecretsStore {
    let Ok(path) =
        workspace_paths::child_file(&state.config.base_path, &[".secrets", "secrets.enc"])
    else {
        return OsSecretsStore::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<OsSecretsStore>(&raw).ok())
        .unwrap_or_default()
}

fn decode_os_secret(entry: &OsSecretEntry) -> Result<String, String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&entry.ciphertext)
        .map_err(|error| format!("decode secret: {error}"))?;
    String::from_utf8(decoded).map_err(|error| format!("decode secret utf8: {error}"))
}

fn resolve_os_secret_reference(state: &AppState, value: &str) -> Result<String, String> {
    let Some(name) = parse_secret_reference(value) else {
        return Ok(value.to_string());
    };
    let store = load_os_secrets_store(state);
    store
        .secrets
        .get(name)
        .ok_or_else(|| format!("Secret '{name}' not found"))
        .and_then(decode_os_secret)
}

fn resolve_secret_references(
    state: &AppState,
    values: &serde_json::Map<String, Value>,
) -> Result<HashMap<String, String>, String> {
    let mut resolved = HashMap::new();
    for (key, value) in values {
        let Some(value) = value.as_str() else {
            continue;
        };
        resolved.insert(key.clone(), resolve_os_secret_reference(state, value)?);
    }
    Ok(resolved)
}

async fn probe_mcp_server(state: &AppState, server: &McpServer) -> Result<ProbeMcpData, String> {
    let config = server
        .config
        .as_object()
        .ok_or_else(|| "invalid MCP server config".to_string())?;
    let timeout_ms = config
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(20_000)
        .clamp(1_000, 30_000);
    let fut = async {
        match config.get("transport").and_then(Value::as_str) {
            Some("stdio") => probe_mcp_stdio(state, server, config).await,
            Some("http") => probe_mcp_http(state, server, config).await,
            _ => Err("config must include command/url".to_string()),
        }
    };
    tokio::time::timeout(Duration::from_millis(timeout_ms), fut)
        .await
        .map_err(|_| format!("MCP server {} timed out after {timeout_ms}ms", server.id))?
}

async fn probe_mcp_stdio(
    state: &AppState,
    server: &McpServer,
    config: &serde_json::Map<String, Value>,
) -> Result<ProbeMcpData, String> {
    let command = config
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "stdio MCP config missing command".to_string())?;
    let mut child = tokio::process::Command::new(command);
    if let Some(args) = config.get("args").and_then(Value::as_array) {
        child.args(args.iter().filter_map(Value::as_str));
    }
    if let Some(env) = config.get("env").and_then(Value::as_object) {
        for (key, value) in resolve_secret_references(state, env)? {
            child.env(key, value);
        }
    }
    if let Some(cwd) = config.get("cwd").and_then(Value::as_str) {
        child.current_dir(cwd);
    }
    let mut child = child
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let result = async {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to open MCP stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to open MCP stdout".to_string())?;
        let mut lines = BufReader::new(stdout).lines();
        write_json_line(&mut stdin, &mcp_initialize_request(1)).await?;
        let initialize_result = read_jsonrpc_id(&mut lines, 1).await?;
        write_json_line(&mut stdin, &mcp_initialized_notification()).await?;
        write_json_line(&mut stdin, &mcp_request_value(2, "tools/list", json!({}))).await?;
        let tools_result = read_jsonrpc_id(&mut lines, 2).await?;
        write_json_line(
            &mut stdin,
            &mcp_request_value(3, "resources/list", json!({})),
        )
        .await?;
        let resources_result = read_jsonrpc_id(&mut lines, 3)
            .await
            .unwrap_or_else(|_| json!({"resources": []}));
        let mut server_metadata = metadata_from_initialize(&initialize_result);
        if !metadata_has_declared_manifest(&server_metadata, &server.name)
            && let Some(uri) = manifest_resource_uri(&resources_result)
        {
            write_json_line(
                &mut stdin,
                &mcp_request_value(4, "resources/read", json!({"uri": uri})),
            )
            .await?;
            if let Ok(content) = read_jsonrpc_id(&mut lines, 4).await {
                server_metadata = metadata_from_resource_content(&content);
            }
        }
        Ok(ProbeMcpData {
            tools_result,
            resources_result,
            server_metadata,
        })
    }
    .await;
    let _ = child.kill().await;
    result
}

async fn probe_mcp_http(
    state: &AppState,
    server: &McpServer,
    config: &serde_json::Map<String, Value>,
) -> Result<ProbeMcpData, String> {
    let url = config
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "HTTP MCP config missing url".to_string())?;
    let client = reqwest::Client::new();
    let headers = config
        .get("headers")
        .and_then(Value::as_object)
        .map(|headers| resolve_secret_references(state, headers))
        .transpose()?
        .unwrap_or_default();
    let initialize_response =
        send_mcp_http_request(&client, &headers, url, None, &mcp_initialize_request(1)).await?;
    let session_id = initialize_response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let initialize_result = parse_mcp_http_response(initialize_response, Some(1)).await?;
    let initialized_response = send_mcp_http_request(
        &client,
        &headers,
        url,
        session_id.as_deref(),
        &mcp_initialized_notification(),
    )
    .await?;
    parse_mcp_http_response(initialized_response, None).await?;
    let tools_response = send_mcp_http_request(
        &client,
        &headers,
        url,
        session_id.as_deref(),
        &mcp_request_value(2, "tools/list", json!({})),
    )
    .await?;
    let tools_result = parse_mcp_http_response(tools_response, Some(2)).await?;
    let resources_result = match send_mcp_http_request(
        &client,
        &headers,
        url,
        session_id.as_deref(),
        &mcp_request_value(3, "resources/list", json!({})),
    )
    .await
    {
        // Transport-level failure (connection reset, 404, etc.): the server
        // doesn't support resources/list. Treat as empty (TS best-effort).
        Err(_) => json!({"resources": []}),
        // HTTP response received: parse strictly. A 202/204 or malformed body
        // when id=3 is expected is a real missing-response error (mirrors the
        // tools/list contract), NOT a silent ok:true zero resources.
        Ok(response) => parse_mcp_http_response(response, Some(3))
            .await
            .unwrap_or_else(|_| json!({"resources": []})),
    };
    let mut server_metadata = metadata_from_initialize(&initialize_result);
    if !metadata_has_declared_manifest(&server_metadata, &server.name)
        && let Some(uri) = manifest_resource_uri(&resources_result)
    {
        if let Ok(response) = send_mcp_http_request(
            &client,
            &headers,
            url,
            session_id.as_deref(),
            &mcp_request_value(4, "resources/read", json!({"uri": uri})),
        )
        .await
            && let Ok(content) = parse_mcp_http_response(response, Some(4)).await
        {
            server_metadata = metadata_from_resource_content(&content);
        }
    }
    Ok(ProbeMcpData {
        tools_result,
        resources_result,
        server_metadata,
    })
}

async fn send_mcp_http_request(
    client: &reqwest::Client,
    headers: &HashMap<String, String>,
    url: &str,
    session_id: Option<&str>,
    body: &Value,
) -> Result<reqwest::Response, String> {
    let mut builder = client
        .post(url)
        .header("User-Agent", "signet-daemon-os-probe")
        .header("Accept", "application/json, text/event-stream")
        .json(body);
    if let Some(session_id) = session_id {
        builder = builder.header("Mcp-Session-Id", session_id);
    }
    for (key, value) in headers {
        builder = builder.header(key, value);
    }
    builder.send().await.map_err(|error| error.to_string())
}

async fn parse_mcp_http_response(
    response: reqwest::Response,
    expected_id: Option<i64>,
) -> Result<Value, String> {
    let status = response.status();
    if status == reqwest::StatusCode::ACCEPTED || status == reqwest::StatusCode::NO_CONTENT {
        return match expected_id {
            Some(id) => Err(missing_mcp_response_error(id)),
            None => Ok(Value::Null),
        };
    }
    if !status.is_success() {
        return Err(format!("MCP HTTP request failed with status {status}"));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let text = response.text().await.map_err(|error| error.to_string())?;
    if text.trim().is_empty() {
        return match expected_id {
            Some(id) => Err(missing_mcp_response_error(id)),
            None => Ok(Value::Null),
        };
    }
    if content_type.contains("text/event-stream") || text.trim_start().starts_with("data:") {
        return parse_sse_json(&text, expected_id).and_then(parse_mcp_response);
    }
    let value = serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())?;
    parse_mcp_response_for_id(value, expected_id)
}

fn missing_mcp_response_error(id: i64) -> String {
    format!("MCP response missing JSON-RPC response for id {id}")
}

fn parse_sse_json(text: &str, expected_id: Option<i64>) -> Result<Value, String> {
    let mut event_data = Vec::new();
    for line in text.lines().chain(std::iter::once("")) {
        if line.trim().is_empty() {
            if let Some(value) = parse_sse_event_data(&event_data, expected_id)? {
                return Ok(value);
            }
            event_data.clear();
            continue;
        }
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if !data.is_empty() && data != "[DONE]" {
            event_data.push(data.to_string());
        }
    }
    match expected_id {
        Some(id) => Err(missing_mcp_response_error(id)),
        None => Err("MCP SSE response missing data event".to_string()),
    }
}

fn parse_sse_event_data(
    event_data: &[String],
    expected_id: Option<i64>,
) -> Result<Option<Value>, String> {
    if event_data.is_empty() {
        return Ok(None);
    }
    let data = event_data.join("\n");
    let value = serde_json::from_str::<Value>(&data).map_err(|error| error.to_string())?;
    if expected_id.is_none() || value.get("id").and_then(Value::as_i64) == expected_id {
        return Ok(Some(value));
    }
    Ok(None)
}

fn parse_mcp_response_for_id(value: Value, expected_id: Option<i64>) -> Result<Value, String> {
    if let Some(id) = expected_id
        && value.get("id").and_then(Value::as_i64) != Some(id)
    {
        return Err(missing_mcp_response_error(id));
    }
    parse_mcp_response(value)
}

fn mcp_initialize_request(id: i64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": OS_MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": OS_PROBE_CLIENT_NAME,
                "version": OS_PROBE_CLIENT_VERSION,
            }
        }
    })
}

fn mcp_initialized_notification() -> Value {
    json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
}

fn mcp_request_value(id: i64, method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

async fn write_json_line<W>(writer: &mut W, value: &Value) -> Result<(), String>
where
    W: AsyncWriteExt + Unpin,
{
    let line = serde_json::to_string(value).map_err(|error| error.to_string())?;
    writer
        .write_all(line.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|error| error.to_string())
}

async fn read_jsonrpc_id<R>(lines: &mut tokio::io::Lines<R>, id: i64) -> Result<Value, String>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_i64) == Some(id) {
            return parse_mcp_response(value);
        }
    }
    Err("MCP server closed stdout before response".to_string())
}

fn parse_mcp_response(value: Value) -> Result<Value, String> {
    if let Some(error) = value.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MCP request failed")
            .to_string());
    }
    if let Some(result) = value.get("result") {
        return Ok(result.clone());
    }
    if value.get("id").is_none() {
        return Ok(Value::Null);
    }
    Err("MCP response missing result".to_string())
}

fn metadata_from_initialize(result: &Value) -> Option<Value> {
    result
        .get("serverInfo")
        .filter(|value| value.is_object())
        .cloned()
        .or_else(|| result.is_object().then(|| result.clone()))
}

fn metadata_has_declared_manifest(metadata: &Option<Value>, server_name: &str) -> bool {
    metadata
        .as_ref()
        .and_then(|value| parse_declared_manifest(value, server_name))
        .is_some()
}

fn manifest_resource_uri(resources_result: &Value) -> Option<String> {
    resources_result
        .get("resources")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|resource| {
            let uri = resource.get("uri").and_then(Value::as_str)?;
            let name = resource.get("name").and_then(Value::as_str).unwrap_or("");
            (matches!(uri, "signet://manifest" | "signet://app") || name == "signet-manifest")
                .then(|| uri.to_string())
        })
}

fn metadata_from_resource_content(content: &Value) -> Option<Value> {
    let text = content
        .get("contents")
        .and_then(Value::as_array)
        .and_then(|contents| contents.first())
        .and_then(|first| first.get("text"))
        .and_then(Value::as_str)?;
    serde_json::from_str::<Value>(text).ok()
}

fn failed_probe_result(server: &Value, error: impl ToString, probed_at: String) -> Value {
    let id = server.get("id").and_then(Value::as_str).unwrap_or("server");
    let name = server
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("MCP Server");
    json!({
        "serverId": id,
        "ok": false,
        "error": error.to_string(),
        "declaredManifest": null,
        "autoCard": {
            "name": name,
            "tools": [],
            "resources": [],
            "hasAppResources": false,
            "defaultSize": {"w": 4, "h": 3},
        },
        "toolCount": 0,
        "resourceCount": 0,
        "hasAppResources": false,
        "probedAt": probed_at,
    })
}

fn installed_server_from_value(server: &Value) -> Result<McpServer, serde_json::Error> {
    serde_json::from_value(json!({
        "id": server.get("id").and_then(Value::as_str).unwrap_or("server"),
        "source": server.get("source").and_then(Value::as_str).unwrap_or("manual"),
        "catalogId": server.get("catalogId").cloned().unwrap_or(Value::Null),
        "name": server.get("name").and_then(Value::as_str).unwrap_or("MCP Server"),
        "description": server.get("description").and_then(Value::as_str).unwrap_or(""),
        "category": server.get("category").and_then(Value::as_str).unwrap_or("Other"),
        "homepage": server.get("homepage").cloned().unwrap_or(Value::Null),
        "official": server.get("official").and_then(Value::as_bool).unwrap_or(false),
        "enabled": server.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "scope": server.get("scope").cloned().unwrap_or_else(|| json!({"harnesses": [], "workspaces": [], "channels": []})),
        "config": server.get("config").cloned().unwrap_or(Value::Null),
        "installedAt": server.get("installedAt").and_then(Value::as_str).unwrap_or(""),
        "updatedAt": server.get("updatedAt").and_then(Value::as_str).unwrap_or(""),
    }))
}

fn auto_card_tools(result: &Value) -> Vec<Value> {
    result
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| {
                    let name = tool.get("name").and_then(Value::as_str)?;
                    if name.is_empty() {
                        return None;
                    }
                    Some(json!({
                        "name": name,
                        "description": tool.get("description").and_then(Value::as_str).unwrap_or(""),
                        "readOnly": tool
                            .get("annotations")
                            .and_then(|annotations| annotations.get("readOnlyHint"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        "inputSchema": tool.get("inputSchema").cloned().unwrap_or_else(|| json!({})),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn auto_card_resources(result: &Value) -> Vec<Value> {
    result
        .get("resources")
        .and_then(Value::as_array)
        .map(|resources| {
            resources
                .iter()
                .filter_map(|resource| {
                    let uri = resource.get("uri").and_then(Value::as_str)?;
                    if uri.is_empty() {
                        return None;
                    }
                    let mut out = serde_json::Map::new();
                    out.insert("uri".to_string(), json!(uri));
                    out.insert(
                        "name".to_string(),
                        json!(resource.get("name").and_then(Value::as_str).unwrap_or(uri)),
                    );
                    if let Some(description) = resource.get("description").and_then(Value::as_str) {
                        out.insert("description".to_string(), json!(description));
                    }
                    if let Some(mime_type) = resource.get("mimeType").and_then(Value::as_str) {
                        out.insert("mimeType".to_string(), json!(mime_type));
                    }
                    Some(Value::Object(out))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_declared_manifest(metadata: &Value, server_name: &str) -> Option<Value> {
    let block = metadata
        .get("signet")
        .or_else(|| metadata.get("signet.app"))?
        .as_object()?;
    let mut manifest = serde_json::Map::new();
    manifest.insert(
        "name".to_string(),
        json!(
            block
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(server_name)
        ),
    );
    for key in ["icon", "ui"] {
        if let Some(url) = block
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| is_http_url(value))
        {
            manifest.insert(key.to_string(), json!(url));
        }
    }
    if let Some(size) = block.get("defaultSize").and_then(Value::as_object) {
        if let (Some(w), Some(h)) = (
            size.get("w").and_then(Value::as_i64),
            size.get("h").and_then(Value::as_i64),
        ) {
            manifest.insert(
                "defaultSize".to_string(),
                json!({"w": w.clamp(1, 12), "h": h.clamp(1, 12)}),
            );
        }
    }
    if let Some(events) = block.get("events").and_then(Value::as_object) {
        let mut out = serde_json::Map::new();
        for key in ["subscribe", "emit"] {
            if let Some(values) = string_array(events.get(key)) {
                out.insert(key.to_string(), Value::Array(values));
            }
        }
        if !out.is_empty() {
            manifest.insert("events".to_string(), Value::Object(out));
        }
    }
    if let Some(values) = string_array(block.get("menuItems")) {
        manifest.insert("menuItems".to_string(), Value::Array(values));
    }
    if let Some(dock) = block.get("dock").and_then(Value::as_bool) {
        manifest.insert("dock".to_string(), json!(dock));
    }
    if let Some(html) = block
        .get("html")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && !manifest_html_has_external_script(value))
    {
        manifest.insert("html".to_string(), json!(html));
    }
    Some(Value::Object(manifest))
}

fn string_array(value: Option<&Value>) -> Option<Vec<Value>> {
    let values = value
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_str)
        .map(|value| json!(value))
        .collect::<Vec<_>>();
    Some(values)
}

fn is_http_url(value: &str) -> bool {
    reqwest::Url::parse(value)
        .map(|url| matches!(url.scheme(), "http" | "https"))
        .unwrap_or(false)
}

fn tray_entry_for_server(server: &Value) -> Value {
    let now = chrono::Utc::now().to_rfc3339();
    let id = server.get("id").and_then(Value::as_str).unwrap_or("server");
    let name = server
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("MCP Server");
    let source = server
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("manual");
    let catalog_id = server.get("catalogId").and_then(Value::as_str);
    json!({
        "id": id,
        "name": name,
        "icon": resolve_server_icon(source, catalog_id),
        "state": "tray",
        "manifest": {"name": name, "defaultSize": {"w": 4, "h": 3}},
        "autoCard": {
            "name": name,
            "tools": [],
            "resources": [],
            "hasAppResources": false,
            "defaultSize": {"w": 4, "h": 3},
        },
        "hasDeclaredManifest": false,
        "createdAt": now,
        "updatedAt": now,
    })
}

fn resolve_server_icon(source: &str, catalog_id: Option<&str>) -> Value {
    if source == "modelcontextprotocol/servers" {
        return json!("https://github.com/modelcontextprotocol.png?size=40");
    }
    if source == "github"
        && let Some(catalog_id) = catalog_id
        && let Some(org) = catalog_id.split('/').next()
        && !org.is_empty()
    {
        return json!(format!("https://github.com/{org}.png?size=40"));
    }
    Value::Null
}

fn find_free_grid_position(occupied: &[Value], w: i64, h: i64) -> Value {
    let collides = |x: i64, y: i64, w: i64, h: i64| {
        occupied.iter().any(|position| {
            let ox = position.get("x").and_then(Value::as_i64).unwrap_or(0);
            let oy = position.get("y").and_then(Value::as_i64).unwrap_or(0);
            let ow = position.get("w").and_then(Value::as_i64).unwrap_or(1);
            let oh = position.get("h").and_then(Value::as_i64).unwrap_or(1);
            x < ox + ow && x + w > ox && y < oy + oh && y + h > oy
        })
    };
    for y in 0..50 {
        for x in 0..=(GRID_COLS - w).max(0) {
            if !collides(x, y, w, h) {
                return json!({"x": x, "y": y, "w": w, "h": h});
            }
        }
    }
    let max_y = occupied
        .iter()
        .map(|position| {
            position.get("y").and_then(Value::as_i64).unwrap_or(0)
                + position.get("h").and_then(Value::as_i64).unwrap_or(1)
        })
        .max()
        .unwrap_or(0);
    json!({"x": 0, "y": max_y, "w": w, "h": h})
}

fn marketplace_servers_path(state: &AppState) -> Result<std::path::PathBuf, String> {
    workspace_paths::child_file(
        &state.config.base_path,
        &["marketplace", "mcp-servers.json"],
    )
    .map_err(|error| error.to_string())
}

fn read_installed_servers(state: &AppState) -> Vec<Value> {
    let Ok(path) = marketplace_servers_path(state) else {
        return Vec::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn write_installed_servers(state: &AppState, servers: &[Value]) -> Result<(), String> {
    let path = marketplace_servers_path(state)?;
    std::fs::write(
        path,
        serde_json::to_string_pretty(servers).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn install_direct_http(
    state: &AppState,
    url: &str,
    name_override: Option<&str>,
) -> Result<String, String> {
    let mut servers = read_installed_servers(state);
    if let Some(pos) = servers.iter().position(|server| {
        server
            .get("config")
            .and_then(|config| config.get("url"))
            .and_then(Value::as_str)
            == Some(url)
    }) {
        let mut should_write = false;
        if let Some(name) = name_override
            .map(str::trim)
            .filter(|value| !value.is_empty())
            && servers[pos].get("name").and_then(Value::as_str) != Some(name)
        {
            servers[pos]["name"] = json!(name);
            servers[pos]["updatedAt"] = json!(chrono::Utc::now().to_rfc3339());
            should_write = true;
        }
        let id = servers[pos]
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "installed server missing id".to_string())?;
        if should_write {
            write_installed_servers(state, &servers)?;
        }
        return Ok(id);
    }

    let name = name_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| infer_name_from_url(url));
    let id = unique_server_id(&sanitize_server_id(&name), &servers);
    let now = chrono::Utc::now().to_rfc3339();

    servers.push(json!({
        "id": id,
        "source": "manual",
        "name": name,
        "description": format!("{name} MCP server"),
        "category": infer_category(&name),
        "homepage": url,
        "official": false,
        "enabled": true,
        "scope": {"harnesses": [], "workspaces": [], "channels": []},
        "config": {
            "transport": "http",
            "url": url,
            "headers": {},
            "timeoutMs": 20000,
        },
        "installedAt": now,
        "updatedAt": now,
    }));
    write_installed_servers(state, &servers)?;
    Ok(id)
}

fn unique_server_id(base_id: &str, servers: &[Value]) -> String {
    if !servers
        .iter()
        .any(|server| server.get("id").and_then(Value::as_str) == Some(base_id))
    {
        return base_id.to_string();
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{base_id}-{suffix}");
        if !servers
            .iter()
            .any(|server| server.get("id").and_then(Value::as_str) == Some(candidate.as_str()))
        {
            return candidate;
        }
        suffix += 1;
    }
}

/// Mirrors the TS manifest-HTML sanitizer at `platform/daemon/src/mcp-probe.ts:250`
/// (`/<script\s+src\s*=/i`): reject any `<script` tag followed by one or more
/// whitespace characters and then `src=`. Case-insensitive. This blocks
/// external-script injection (`<script src=...>`, `<script  src=...>`,
/// `<script\tsrc=...>`, `<SCRIPT src=...>`) without needing a regex dep.
fn manifest_html_has_external_script(html: &str) -> bool {
    let lower: Vec<(usize, char)> = html.to_lowercase().char_indices().collect();
    let needle = "<script";
    let mut i = 0;
    while i + needle.len() <= lower.len() {
        // Find the next "<script" occurrence (compare on the char stream).
        let matches = lower[i..]
            .iter()
            .take(needle.chars().count())
            .enumerate()
            .all(|(j, (_, c))| *c == needle.chars().nth(j).unwrap());
        if !matches {
            i += 1;
            continue;
        }
        // Advance past "<script" in the char stream.
        let mut k = i + needle.chars().count();
        // Require at least one whitespace char (\s+ in the TS regex).
        let mut saw_ws = false;
        while k < lower.len() {
            let c = lower[k].1;
            if c.is_whitespace() {
                saw_ws = true;
                k += 1;
            } else {
                break;
            }
        }
        if saw_ws {
            // Check for `src` followed by optional whitespace then `=`.
            let rest: String = lower[k..].iter().map(|(_, c)| *c).collect();
            let mut rest_chars = rest.chars();
            if rest_chars.next() == Some('s')
                && rest_chars.next() == Some('r')
                && rest_chars.next() == Some('c')
            {
                let mut after_src = rest_chars.peekable();
                while let Some(&c) = after_src.peek() {
                    if c.is_whitespace() {
                        after_src.next();
                    } else {
                        break;
                    }
                }
                if after_src.next() == Some('=') {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

fn sanitize_server_id(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let normalized = out.trim_matches('-').to_string();
    if normalized.is_empty() {
        "mcp-server".to_string()
    } else {
        normalized
    }
}

fn infer_name_from_url(url: &str) -> String {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return "MCP Server".to_string();
    };
    let mut name = parsed
        .host_str()
        .unwrap_or("mcp-server")
        .trim_start_matches("www.")
        .trim_start_matches("api.")
        .trim_start_matches("mcp.")
        .to_string();
    for suffix in [".com", ".org", ".io", ".dev", ".app", ".net"] {
        if let Some(stripped) = name.strip_suffix(suffix) {
            name = stripped.to_string();
            break;
        }
    }
    if let Some(path_hint) = parsed.path_segments().and_then(|mut segments| {
        segments.find(|part| !part.is_empty() && !matches!(*part, "mcp" | "sse" | "v1"))
    }) {
        name = format!("{name}-{path_hint}");
    }
    let words = name
        .replace(['-', '_'], " ")
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    if words.is_empty() {
        "MCP Server".to_string()
    } else {
        words.join(" ")
    }
}

fn infer_category(text: &str) -> &'static str {
    let source = text.to_lowercase();
    if ["browser", "scrap", "crawl", "web"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Web";
    }
    if ["slack", "discord", "email", "sms", "message", "chat"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Communication";
    }
    if [
        "database", "sql", "postgres", "mysql", "sqlite", "redis", "vector",
    ]
    .iter()
    .any(|term| source.contains(term))
    {
        return "Database";
    }
    if ["github", "git", "ci", "deploy", "build", "code", "dev"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Development";
    }
    if ["cloud", "aws", "gcp", "azure", "vercel", "cloudflare"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Cloud";
    }
    if ["finance", "stock", "market", "crypto", "trading"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Finance";
    }
    if ["memory", "knowledge", "search", "docs", "rag"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Knowledge";
    }
    if ["file", "storage", "drive", "s3", "bucket"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Storage";
    }
    "Other"
}

fn is_private_hostname(hostname: &str) -> bool {
    let host = hostname
        .to_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    if host == "localhost" || host == "0.0.0.0" || host.starts_with("127.") {
        return true;
    }
    if host.starts_with("10.") || host.starts_with("192.168.") || host.starts_with("169.254.") {
        return true;
    }
    if let Some(second) = host
        .strip_prefix("172.")
        .and_then(|rest| rest.split('.').next())
        && second
            .parse::<u8>()
            .map(|value| (16..=31).contains(&value))
            .unwrap_or(false)
    {
        return true;
    }
    if let Some(second) = host
        .strip_prefix("100.")
        .and_then(|rest| rest.split('.').next())
        && second
            .parse::<u8>()
            .map(|value| (64..=127).contains(&value))
            .unwrap_or(false)
    {
        return true;
    }
    if host == "::1" || host == "0:0:0:0:0:0:0:1" || host.starts_with("fe80:") {
        return true;
    }
    if (host.starts_with("fc") || host.starts_with("fd")) && host.contains(':') {
        return true;
    }
    host.ends_with(".local") || host.ends_with(".internal") || host.ends_with(".localhost")
}

#[cfg(test)]
mod manifest_html_sanitizer_tests {
    use super::manifest_html_has_external_script;

    // Mirrors TS platform/daemon/src/mcp-probe.ts:250  /<script\s+src\s*=/i
    #[test]
    fn rejects_plain_external_script_tag() {
        assert!(manifest_html_has_external_script(
            "<script src='https://evil/x.js'></script>"
        ));
    }

    #[test]
    fn rejects_extra_whitespace_variants() {
        // The literal-substring guard this replaces would MISS these.
        assert!(manifest_html_has_external_script(
            "<script  src='https://evil/x.js'></script>"
        ));
        assert!(manifest_html_has_external_script(
            "<script\tsrc='https://evil/x.js'></script>"
        ));
        assert!(manifest_html_has_external_script(
            "<script\n src='https://evil/x.js'></script>"
        ));
    }

    #[test]
    fn rejects_case_insensitive_and_src_eq_padding() {
        assert!(manifest_html_has_external_script(
            "<SCRIPT src='https://evil/x.js'></SCRIPT>"
        ));
        assert!(manifest_html_has_external_script(
            "<script src \t= 'https://evil/x.js'></script>"
        ));
        assert!(manifest_html_has_external_script(
            "<Script Src='https://evil/x.js'></Script>"
        ));
    }

    #[test]
    fn accepts_inline_script_without_src() {
        // Inline <script> blocks (no src=) are allowed by TS too.
        assert!(!manifest_html_has_external_script(
            "<script>console.log('hi')</script>"
        ));
        assert!(!manifest_html_has_external_script("<div>hello</div>"));
        assert!(!manifest_html_has_external_script(""));
    }
}
