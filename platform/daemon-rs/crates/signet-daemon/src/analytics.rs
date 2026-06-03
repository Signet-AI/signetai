use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Instant;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use serde::Serialize;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EndpointStats {
    pub count: i64,
    pub errors: i64,
    pub total_latency_ms: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ActorStats {
    pub requests: i64,
    pub remembers: i64,
    pub recalls: i64,
    pub mutations: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStats {
    pub calls: i64,
    pub failures: i64,
    pub total_latency_ms: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorStats {
    pub syncs: i64,
    pub errors: i64,
    pub documents_processed: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageCounters {
    pub endpoints: HashMap<String, EndpointStats>,
    pub actors: HashMap<String, ActorStats>,
    pub providers: HashMap<String, ProviderStats>,
    pub connectors: HashMap<String, ConnectorStats>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEntry {
    pub timestamp: String,
    pub stage: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LatencySnapshot {
    pub p50: i64,
    pub p95: i64,
    pub p99: i64,
    pub count: i64,
    pub mean: i64,
}

#[derive(Debug, Clone)]
struct LatencyHistogram {
    samples: VecDeque<i64>,
    capacity: usize,
}

impl LatencyHistogram {
    fn new() -> Self {
        Self {
            samples: VecDeque::new(),
            capacity: 1000,
        }
    }

    fn record(&mut self, ms: i64) {
        if self.samples.len() >= self.capacity {
            self.samples.pop_front();
        }
        self.samples.push_back(ms.max(0));
    }

    fn snapshot(&self) -> LatencySnapshot {
        if self.samples.is_empty() {
            return LatencySnapshot {
                p50: 0,
                p95: 0,
                p99: 0,
                count: 0,
                mean: 0,
            };
        }
        let mut sorted = self.samples.iter().copied().collect::<Vec<_>>();
        sorted.sort_unstable();
        let sum = sorted.iter().sum::<i64>();
        LatencySnapshot {
            p50: percentile(&sorted, 50),
            p95: percentile(&sorted, 95),
            p99: percentile(&sorted, 99),
            count: sorted.len() as i64,
            mean: ((sum as f64) / (sorted.len() as f64)).round() as i64,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum LatencyOperation {
    Remember,
    Recall,
    Mutate,
    Jobs,
    PredictorScore,
    PredictorTrain,
}

impl LatencyOperation {
    fn key(self) -> &'static str {
        match self {
            Self::Remember => "remember",
            Self::Recall => "recall",
            Self::Mutate => "mutate",
            Self::Jobs => "jobs",
            Self::PredictorScore => "predictor_score",
            Self::PredictorTrain => "predictor_train",
        }
    }
}

#[derive(Debug)]
struct AnalyticsInner {
    endpoints: HashMap<String, EndpointStats>,
    actors: HashMap<String, ActorStats>,
    providers: HashMap<String, ProviderStats>,
    connectors: HashMap<String, ConnectorStats>,
    errors: VecDeque<ErrorEntry>,
    latencies: HashMap<LatencyOperation, LatencyHistogram>,
}

impl AnalyticsInner {
    fn new() -> Self {
        let mut latencies = HashMap::new();
        for op in [
            LatencyOperation::Remember,
            LatencyOperation::Recall,
            LatencyOperation::Mutate,
            LatencyOperation::Jobs,
            LatencyOperation::PredictorScore,
            LatencyOperation::PredictorTrain,
        ] {
            latencies.insert(op, LatencyHistogram::new());
        }
        Self {
            endpoints: HashMap::new(),
            actors: HashMap::new(),
            providers: HashMap::new(),
            connectors: HashMap::new(),
            errors: VecDeque::new(),
            latencies,
        }
    }
}

#[derive(Debug)]
pub struct AnalyticsCollector {
    inner: Mutex<AnalyticsInner>,
}

const ERROR_CAPACITY: usize = 500;

impl Default for AnalyticsCollector {
    fn default() -> Self {
        Self {
            inner: Mutex::new(AnalyticsInner::new()),
        }
    }
}

impl AnalyticsCollector {
    pub fn record_request(
        &self,
        method: &str,
        path: &str,
        status: u16,
        duration_ms: i64,
        actor: Option<&str>,
    ) {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        };
        let endpoint = inner
            .endpoints
            .entry(format!("{method} {path}"))
            .or_default();
        endpoint.count += 1;
        endpoint.total_latency_ms += duration_ms.max(0);
        if status >= 400 {
            endpoint.errors += 1;
        }

        if let Some(actor) = actor.filter(|actor| !actor.trim().is_empty()) {
            let stats = inner.actors.entry(actor.to_string()).or_default();
            match classify_actor_operation(path) {
                ActorOperation::Remember => stats.remembers += 1,
                ActorOperation::Recall => stats.recalls += 1,
                ActorOperation::Mutation => stats.mutations += 1,
                ActorOperation::Request => stats.requests += 1,
            }
        }

        if let Some(operation) = classify_latency_operation(path) {
            inner
                .latencies
                .entry(operation)
                .or_insert_with(LatencyHistogram::new)
                .record(duration_ms);
        }
    }

    pub fn record_error(&self, entry: ErrorEntry) {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        };
        if inner.errors.len() >= ERROR_CAPACITY {
            inner.errors.pop_front();
        }
        inner.errors.push_back(entry);
    }

    pub fn errors(
        &self,
        stage: Option<&str>,
        since: Option<&str>,
        limit: usize,
    ) -> Vec<ErrorEntry> {
        let inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut filtered = inner
            .errors
            .iter()
            .filter(|entry| stage.is_none_or(|stage| entry.stage == stage))
            .filter(|entry| since.is_none_or(|since| entry.timestamp.as_str() >= since))
            .cloned()
            .collect::<Vec<_>>();
        if filtered.len() > limit {
            filtered.drain(0..filtered.len() - limit);
        }
        filtered
    }

    pub fn error_summary(&self) -> HashMap<String, i64> {
        let inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut summary = HashMap::new();
        for entry in &inner.errors {
            *summary.entry(entry.code.clone()).or_insert(0) += 1;
        }
        summary
    }

    pub fn usage(&self) -> UsageCounters {
        let inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        };
        UsageCounters {
            endpoints: inner.endpoints.clone(),
            actors: inner.actors.clone(),
            providers: inner.providers.clone(),
            connectors: inner.connectors.clone(),
        }
    }

    pub fn latency(&self) -> HashMap<String, LatencySnapshot> {
        let inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        };
        [
            LatencyOperation::Remember,
            LatencyOperation::Recall,
            LatencyOperation::Mutate,
            LatencyOperation::Jobs,
            LatencyOperation::PredictorScore,
            LatencyOperation::PredictorTrain,
        ]
        .into_iter()
        .map(|op| {
            (
                op.key().to_string(),
                inner
                    .latencies
                    .get(&op)
                    .map(LatencyHistogram::snapshot)
                    .unwrap_or_else(|| LatencyHistogram::new().snapshot()),
            )
        })
        .collect()
    }
}

#[derive(Debug, Clone, Copy)]
enum ActorOperation {
    Remember,
    Recall,
    Mutation,
    Request,
}

fn classify_actor_operation(path: &str) -> ActorOperation {
    if path.contains("/remember") || path.contains("/save") {
        ActorOperation::Remember
    } else if path.contains("/recall") || path.contains("/search") || path.contains("/similar") {
        ActorOperation::Recall
    } else if path.contains("/modify") || path.contains("/forget") || path.contains("/recover") {
        ActorOperation::Mutation
    } else {
        ActorOperation::Request
    }
}

fn classify_latency_operation(path: &str) -> Option<LatencyOperation> {
    match classify_actor_operation(path) {
        ActorOperation::Remember => Some(LatencyOperation::Remember),
        ActorOperation::Recall => Some(LatencyOperation::Recall),
        ActorOperation::Mutation => Some(LatencyOperation::Mutate),
        ActorOperation::Request => None,
    }
}

fn percentile(sorted: &[i64], p: usize) -> i64 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((p * sorted.len()).div_ceil(100)).saturating_sub(1);
    *sorted.get(idx).unwrap_or(&0)
}

pub async fn analytics_middleware(
    State(state): State<std::sync::Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let actor = req
        .headers()
        .get("x-signet-actor")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let started = Instant::now();
    let response = next.run(req).await;
    state.analytics.record_request(
        &method,
        &path,
        response.status().as_u16(),
        started.elapsed().as_millis().try_into().unwrap_or(i64::MAX),
        actor.as_deref(),
    );
    response
}
