//! OS integration routes.

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use signet_core::db::Priority;
use signet_core::error::CoreError;
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;

use crate::{
    state::{AppState, OsAgentSession},
    workspace_paths,
};

const EVENT_BUFFER_SIZE: usize = 500;
const DEFAULT_WINDOW_MS: i64 = 300_000;
const MAX_CONTEXT_EVENTS: usize = 100;
const DEDUP_WINDOW_MS: i64 = 500;
const GRID_COLS: i64 = 12;

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

pub async fn agent_events(Query(query): Query<AgentEventsQuery>) -> Response {
    let (tx, rx) = mpsc::channel::<Result<Bytes, Infallible>>(32);
    let mut bus_rx = agent_event_bus().tx.subscribe();
    agent_event_bus().subscribers.fetch_add(1, Ordering::SeqCst);
    let session_filter = query.session.clone();
    let replay = agent_event_bus().recent(None, 50, DEFAULT_WINDOW_MS);
    tokio::spawn(async move {
        let _subscriber = SubscriberGuard::new(agent_event_bus());
        if !send_sse(&tx, json!({"type": "connected"})).await {
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
    let probe = make_probe_result(&server);
    match store_probe_result(&state, &id, probe.clone()).await {
        Ok(()) => Json(json!({"success": true, "probe": probe})).into_response(),
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
    let status = if body.get("html").and_then(Value::as_str).is_some() {
        "cached"
    } else {
        "generating"
    };
    if let Err(error) = upsert_widget_job(&state, server_id, status, body.clone()).await {
        return internal_error(error).into_response();
    }
    event_bus().emit(
        "widget",
        "widget.generation",
        json!({"serverId": server_id, "status": status}),
    );
    if status == "cached" {
        Json(json!({"status": "cached", "html": body["html"].clone()})).into_response()
    } else {
        (StatusCode::ACCEPTED, Json(json!({"status": "generating"}))).into_response()
    }
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

fn make_probe_result(server: &Value) -> Value {
    let name = server
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("MCP Server");
    let id = server.get("id").and_then(Value::as_str).unwrap_or("server");
    json!({
        "ok": true,
        "serverId": id,
        "checkedAt": chrono::Utc::now().to_rfc3339(),
        "declaredManifest": null,
        "autoCard": {
            "name": name,
            "tools": [],
            "resources": [],
            "hasAppResources": false,
            "defaultSize": {"w": 4, "h": 3},
        }
    })
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
