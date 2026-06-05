use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::response::IntoResponse;
use serde::Serialize;
use tokio::sync::broadcast;
use tracing::Level;
use tracing_subscriber::Layer;

const KEEPALIVE_SECS: u64 = 30;

#[derive(Clone, Serialize)]
pub struct DashboardLogEntry {
    pub timestamp: String,
    pub level: String,
    pub category: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

pub struct LogBroadcaster {
    tx: broadcast::Sender<String>,
}

impl LogBroadcaster {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    pub fn layer(&self) -> LogBroadcastLayer {
        LogBroadcastLayer {
            tx: self.tx.clone(),
        }
    }
}

pub struct LogBroadcastLayer {
    tx: broadcast::Sender<String>,
}

impl<S> Layer<S> for LogBroadcastLayer
where
    S: tracing::Subscriber,
    S: for<'lookup> tracing_subscriber::registry::LookupSpan<'lookup>,
{
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let metadata = event.metadata();

        if metadata.level() > &Level::INFO {
            return;
        }

        let level = match *metadata.level() {
            Level::ERROR => "error",
            Level::WARN => "warn",
            Level::INFO => "info",
            Level::DEBUG => "debug",
            Level::TRACE => "trace",
        };

        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);

        let target = metadata.target();
        let category = derive_category(target);

        let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let entry = DashboardLogEntry {
            timestamp,
            level: level.to_string(),
            category: category.to_string(),
            message: visitor.message,
            data: if visitor.fields.is_empty() {
                None
            } else {
                Some(serde_json::Value::Object(visitor.fields))
            },
        };

        if let Ok(json) = serde_json::to_string(&entry) {
            let _ = self.tx.send(format!("data: {json}\n\n"));
        }
    }
}

fn derive_category(target: &str) -> &'static str {
    if target.starts_with("signet_daemon") {
        "daemon"
    } else if target.starts_with("signet_pipeline::summary") {
        "pipeline"
    } else if target.starts_with("signet_pipeline::synthesis") {
        "pipeline"
    } else if target.starts_with("signet_pipeline::document") {
        "document-worker"
    } else if target.starts_with("signet_pipeline::embedding") {
        "embedding-tracker"
    } else if target.starts_with("signet_pipeline") {
        "pipeline"
    } else if target.starts_with("signet_core") {
        "core"
    } else if target.starts_with("signet_services") {
        "services"
    } else if target.starts_with("signet_shadow") {
        "shadow"
    } else if target.contains("watcher") {
        "watcher"
    } else if target.contains("git") {
        "git"
    } else {
        "system"
    }
}

#[derive(Default)]
struct FieldVisitor {
    message: String,
    fields: serde_json::Map<String, serde_json::Value>,
}

impl tracing::field::Visit for FieldVisitor {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.fields.insert(
                field.name().to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        } else {
            self.fields.insert(
                field.name().to_string(),
                serde_json::Value::String(format!("{value:?}")),
            );
        }
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.fields.insert(
            field.name().to_string(),
            serde_json::Value::Number(value.into()),
        );
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.fields.insert(
            field.name().to_string(),
            serde_json::Value::Number(value.into()),
        );
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.fields.insert(
            field.name().to_string(),
            serde_json::Value::Bool(value),
        );
    }

    fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
        if let Some(n) = serde_json::Number::from_f64(value) {
            self.fields.insert(field.name().to_string(), serde_json::Value::Number(n));
        }
    }

    fn record_error(
        &mut self,
        field: &tracing::field::Field,
        value: &(dyn std::error::Error + 'static),
    ) {
        if field.name() == "message" || field.name() == "error" {
            self.message = value.to_string();
        } else {
            self.fields.insert(
                field.name().to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }
    }
}

pub async fn sse_log_stream(broadcaster: Arc<LogBroadcaster>) -> impl IntoResponse {
    let rx = broadcaster.subscribe();

    let (tx, rx_body) = tokio::sync::mpsc::channel::<Result<String, std::convert::Infallible>>(16);
    let _ = tx.send(Ok(format!("data: {{\"type\":\"connected\"}}\n\n"))).await;

    tokio::spawn(async move {
        let mut rx = rx;
        loop {
            match tokio::time::timeout(Duration::from_secs(KEEPALIVE_SECS), rx.recv()).await {
                Ok(Ok(msg)) => {
                    if tx.send(Ok(msg)).await.is_err() {
                        break;
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                    continue;
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => {
                    break;
                }
                Err(_) => {
                    if tx.send(Ok(": keepalive\n\n".to_string())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    let body = Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx_body));

    (
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-cache"),
            ("connection", "keep-alive"),
        ],
        body,
    )
}
