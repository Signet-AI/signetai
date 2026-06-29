//! Aggregate recall orchestration parity for the Rust daemon.
//!
//! This module ports the deterministic parts of
//! `platform/daemon/src/aggregate-recall.ts`: budget validation, recall
//! orchestration, planner/synthesis prompts, evidence linking, save policy, and
//! usage/timing accounting. The LLM call is intentionally abstracted behind
//! [`AggregateInferenceRouter`] so the daemon can plug in its runtime inference
//! provider while tests use deterministic mocks.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::time::Instant;

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use signet_core::error::CoreError;
use signet_core::queries::job::{EnqueueJob, enqueue};
use signet_core::search::{SearchOptions, hybrid_search};
use signet_services::normalize::normalize_and_hash;
use signet_services::transactions::{IngestEnvelopeInput, tx_ingest_envelope};
use thiserror::Error;
use uuid::Uuid;

const BUDGET_QUERY_LIMITS: [(AggregateRecallBudget, usize); 3] = [
    (AggregateRecallBudget::Small, 3),
    (AggregateRecallBudget::Medium, 5),
    (AggregateRecallBudget::Large, 8),
];

pub type BoxAggregateFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AggregateRecallBudget {
    Small,
    Medium,
    Large,
}

impl AggregateRecallBudget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Large => "large",
        }
    }

    pub fn query_limit(self) -> usize {
        BUDGET_QUERY_LIMITS
            .iter()
            .find_map(|(budget, limit)| (*budget == self).then_some(*limit))
            .unwrap_or(3)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AggregateRecallStoppedReason {
    Complete,
    NoEvidence,
    RouterUnavailable,
    SynthesisFailed,
}

impl AggregateRecallStoppedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::NoEvidence => "no_evidence",
            Self::RouterUnavailable => "router_unavailable",
            Self::SynthesisFailed => "synthesis_failed",
        }
    }
}

#[derive(Debug, Error)]
pub enum AggregateRecallError {
    #[error("Invalid aggregateBudget. Expected one of: small, medium, large.")]
    InvalidBudget,
    #[error(transparent)]
    Core(#[from] CoreError),
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
}

/// Rust equivalent of TS `parseAggregateRecallBudget`.
///
/// `None` represents an omitted/undefined input and defaults to `small`; any
/// non-matching string is rejected by returning `None`.
pub fn parse_aggregate_recall_budget(raw: Option<&str>) -> Option<AggregateRecallBudget> {
    match raw {
        None => Some(AggregateRecallBudget::Small),
        Some("small") => Some(AggregateRecallBudget::Small),
        Some("medium") => Some(AggregateRecallBudget::Medium),
        Some("large") => Some(AggregateRecallBudget::Large),
        Some(_) => None,
    }
}

#[derive(Debug, Clone, Copy)]
pub enum AggregateRecallBudgetJsonInput<'a> {
    Missing,
    Value(&'a Value),
}

/// Rust equivalent of TS `readAggregateRecallBudgetInput` for JSON request
/// bodies: prefer `aggregateBudget`, then `aggregate_budget`, then missing.
pub fn read_aggregate_recall_budget_input(input: &Value) -> AggregateRecallBudgetJsonInput<'_> {
    let Some(object) = input.as_object() else {
        return AggregateRecallBudgetJsonInput::Missing;
    };
    if let Some(value) = object.get("aggregateBudget") {
        return AggregateRecallBudgetJsonInput::Value(value);
    }
    if let Some(value) = object.get("aggregate_budget") {
        return AggregateRecallBudgetJsonInput::Value(value);
    }
    AggregateRecallBudgetJsonInput::Missing
}

pub fn parse_aggregate_recall_budget_json(
    raw: AggregateRecallBudgetJsonInput<'_>,
) -> Option<AggregateRecallBudget> {
    match raw {
        AggregateRecallBudgetJsonInput::Missing => Some(AggregateRecallBudget::Small),
        AggregateRecallBudgetJsonInput::Value(Value::String(value)) => {
            parse_aggregate_recall_budget(Some(value.as_str()))
        }
        AggregateRecallBudgetJsonInput::Value(_) => None,
    }
}

fn normalize_budget(raw: Option<&str>) -> Result<AggregateRecallBudget, AggregateRecallError> {
    parse_aggregate_recall_budget(raw).ok_or(AggregateRecallError::InvalidBudget)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregateRecallParams {
    pub query: String,
    #[serde(default)]
    pub aggregate: bool,
    #[serde(default, alias = "aggregate_budget")]
    pub aggregate_budget: Option<String>,
    #[serde(default, alias = "save_aggregate")]
    pub save_aggregate: Option<bool>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub read_policy: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
}

impl AggregateRecallParams {
    pub fn budget_input(&self) -> Option<&str> {
        self.aggregate_budget.as_deref()
    }

    pub fn agent_id_or_default(&self) -> &str {
        self.agent_id.as_deref().unwrap_or("default")
    }

    pub fn source_project(&self) -> Option<&str> {
        self.project
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecallResult {
    pub id: String,
    pub content: String,
    pub content_length: usize,
    pub truncated: bool,
    pub score: f64,
    pub source: String,
    pub source_id: Option<String>,
    #[serde(rename = "type")]
    pub memory_type: String,
    pub tags: Option<String>,
    pub pinned: bool,
    pub importance: f64,
    pub who: String,
    pub project: Option<String>,
    pub created_at: String,
    pub visibility: Option<String>,
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecallTimingStage {
    pub name: String,
    pub duration_ms: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RecallTimings {
    pub total_ms: f64,
    pub stages: Vec<RecallTimingStage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecallMeta {
    pub total_returned: usize,
    pub has_supplementary: bool,
    pub no_hits: bool,
    pub timings: RecallTimings,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecallResponse {
    pub results: Vec<RecallResult>,
    pub query: String,
    pub method: String,
    pub meta: RecallMeta,
    pub aggregate: Option<AggregateRecallMeta>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AggregateRecallMeta {
    pub saved_memory_id: Option<String>,
    pub saved: bool,
    pub deduped: bool,
    pub budget: AggregateRecallBudget,
    pub queries: Vec<String>,
    pub source_memory_ids: Vec<String>,
    pub stopped_reason: AggregateRecallStoppedReason,
    pub usage: Option<AggregateRecallUsage>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LlmUsage {
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub cache_read_tokens: Option<f64>,
    pub cache_creation_tokens: Option<f64>,
    pub total_cost: Option<f64>,
    pub total_duration_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AggregateRecallUsageStage {
    pub name: String,
    pub target_ref: Option<String>,
    pub attempt_count: usize,
    pub fallback_count: usize,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub cache_read_tokens: Option<f64>,
    pub cache_creation_tokens: Option<f64>,
    pub total_cost: Option<f64>,
    pub total_duration_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AggregateRecallUsage {
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub cache_read_tokens: Option<f64>,
    pub cache_creation_tokens: Option<f64>,
    pub total_cost: Option<f64>,
    pub total_duration_ms: Option<f64>,
    pub stages: Vec<AggregateRecallUsageStage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AggregateInferenceAttempt {
    pub target_ref: String,
    pub ok: bool,
    pub duration_ms: f64,
    pub usage: Option<LlmUsage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AggregateInferenceResult {
    pub text: String,
    pub usage: Option<LlmUsage>,
    pub attempts: Vec<AggregateInferenceAttempt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AggregateRouteRequest {
    pub agent_id: Option<String>,
    pub operation: String,
    pub prompt_preview: String,
    pub expected_output_tokens: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AggregateRouterError {
    pub message: String,
}

pub trait AggregateInferenceRouter {
    fn execute<'a>(
        &'a self,
        request: AggregateRouteRequest,
        prompt: String,
        opts: AggregateInferenceOptions,
    ) -> BoxAggregateFuture<'a, Result<AggregateInferenceResult, AggregateRouterError>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AggregateInferenceOptions {
    pub timeout_ms: Option<u64>,
    pub max_tokens: Option<usize>,
    pub refresh: Option<bool>,
    pub acpx_hooks: Option<String>,
}

pub trait AggregateRecallProvider {
    fn recall<'a>(
        &'a self,
        conn: &'a Connection,
        params: AggregateRecallParams,
    ) -> BoxAggregateFuture<'a, Result<RecallResponse, AggregateRecallError>>;
}

type IngestEnvelopeFn =
    for<'a> fn(&Connection, &IngestEnvelopeInput<'a>) -> Result<String, CoreError>;

#[derive(Default)]
pub struct AggregateRecallDeps<'a> {
    pub recall: Option<&'a dyn AggregateRecallProvider>,
    pub router: Option<&'a dyn AggregateInferenceRouter>,
    pub now: Option<&'a dyn Fn() -> DateTime<Utc>>,
    pub id_factory: Option<&'a dyn Fn() -> String>,
    pub ingest_envelope: Option<IngestEnvelopeFn>,
}

#[derive(Debug, Clone)]
struct AggregateMemoryRow {
    id: String,
    content: String,
    source_type: Option<String>,
    source_id: Option<String>,
    memory_type: String,
    tags: Option<String>,
    pinned: bool,
    importance: f64,
    who: Option<String>,
    project: Option<String>,
    visibility: Option<String>,
    created_at: String,
}

#[derive(Debug, Clone)]
struct ContentHashMatch {
    row: RecallResult,
    visible_for_aggregate: bool,
    aggregate_recall_memory: bool,
}

#[derive(Debug, Clone)]
struct AggregateDuplicateResolution {
    row: RecallResult,
    saved: bool,
}

struct TimingCollector {
    start: Instant,
    stages: Vec<RecallTimingStage>,
}

impl TimingCollector {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            stages: Vec::new(),
        }
    }

    fn time<T>(&mut self, name: &str, f: impl FnOnce() -> T) -> T {
        let started = Instant::now();
        let result = f();
        self.record(name, started);
        result
    }

    async fn time_async<T, Fut>(&mut self, name: &str, f: impl FnOnce() -> Fut) -> T
    where
        Fut: Future<Output = T>,
    {
        let started = Instant::now();
        let result = f().await;
        self.record(name, started);
        result
    }

    fn record(&mut self, name: &str, started: Instant) {
        self.stages.push(RecallTimingStage {
            name: name.to_string(),
            duration_ms: round_duration(started.elapsed().as_secs_f64() * 1000.0),
        });
    }

    fn finish(self) -> RecallTimings {
        RecallTimings {
            total_ms: round_duration(self.start.elapsed().as_secs_f64() * 1000.0),
            stages: self.stages,
        }
    }
}

fn round_duration(ms: f64) -> f64 {
    (ms * 100.0).round() / 100.0
}

fn add_nullable_numbers(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    match (left, right) {
        (None, None) => None,
        (left, right) => Some(left.unwrap_or(0.0) + right.unwrap_or(0.0)),
    }
}

fn usage_stage(name: &str, result: &AggregateInferenceResult) -> AggregateRecallUsageStage {
    let ok_attempt = result.attempts.iter().find(|attempt| attempt.ok);
    let usage = result
        .usage
        .as_ref()
        .or_else(|| ok_attempt.and_then(|attempt| attempt.usage.as_ref()));
    AggregateRecallUsageStage {
        name: name.to_string(),
        target_ref: ok_attempt.map(|attempt| attempt.target_ref.clone()),
        attempt_count: if result.attempts.is_empty() {
            1
        } else {
            result.attempts.len()
        },
        fallback_count: result.attempts.iter().filter(|attempt| !attempt.ok).count(),
        input_tokens: usage.and_then(|usage| usage.input_tokens),
        output_tokens: usage.and_then(|usage| usage.output_tokens),
        cache_read_tokens: usage.and_then(|usage| usage.cache_read_tokens),
        cache_creation_tokens: usage.and_then(|usage| usage.cache_creation_tokens),
        total_cost: usage.and_then(|usage| usage.total_cost),
        total_duration_ms: usage
            .and_then(|usage| usage.total_duration_ms)
            .or_else(|| ok_attempt.map(|attempt| attempt.duration_ms)),
    }
}

fn build_aggregate_usage(stages: Vec<AggregateRecallUsageStage>) -> Option<AggregateRecallUsage> {
    if stages.is_empty() {
        return None;
    }
    let totals = stages
        .iter()
        .fold(LlmUsage::default(), |total, stage| LlmUsage {
            input_tokens: add_nullable_numbers(total.input_tokens, stage.input_tokens),
            output_tokens: add_nullable_numbers(total.output_tokens, stage.output_tokens),
            cache_read_tokens: add_nullable_numbers(
                total.cache_read_tokens,
                stage.cache_read_tokens,
            ),
            cache_creation_tokens: add_nullable_numbers(
                total.cache_creation_tokens,
                stage.cache_creation_tokens,
            ),
            total_cost: add_nullable_numbers(total.total_cost, stage.total_cost),
            total_duration_ms: add_nullable_numbers(
                total.total_duration_ms,
                stage.total_duration_ms,
            ),
        });
    Some(AggregateRecallUsage {
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        cache_read_tokens: totals.cache_read_tokens,
        cache_creation_tokens: totals.cache_creation_tokens,
        total_cost: totals.total_cost,
        total_duration_ms: totals.total_duration_ms,
        stages,
    })
}

fn empty_aggregate_response(
    params: &AggregateRecallParams,
    budget: AggregateRecallBudget,
    queries: Vec<String>,
    source_memory_ids: Vec<String>,
    stopped_reason: AggregateRecallStoppedReason,
) -> RecallResponse {
    RecallResponse {
        results: Vec::new(),
        query: params.query.clone(),
        method: "hybrid".to_string(),
        meta: RecallMeta {
            total_returned: 0,
            has_supplementary: false,
            no_hits: true,
            timings: RecallTimings::default(),
        },
        aggregate: Some(AggregateRecallMeta {
            saved_memory_id: None,
            saved: false,
            deduped: false,
            budget,
            queries,
            source_memory_ids,
            stopped_reason,
            usage: None,
        }),
    }
}

fn normalize_query(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn unique_queries(query: &str, candidates: &[String], max: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for candidate in std::iter::once(query.to_string()).chain(candidates.iter().cloned()) {
        let trimmed = candidate.trim().to_string();
        let key = normalize_query(&trimmed);
        if trimmed.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        result.push(trimmed);
        if result.len() >= max {
            break;
        }
    }
    result
}

fn parse_planner_queries(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        if let Some(array) = parsed.as_array() {
            return array
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect();
        }
        if let Some(array) = parsed.get("queries").and_then(Value::as_array) {
            return array
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect();
        }
    }
    trimmed
        .lines()
        .map(|line| {
            line.trim_start_matches(|ch: char| {
                ch == '-' || ch == '*' || ch == '.' || ch.is_ascii_digit() || ch.is_whitespace()
            })
            .trim()
            .to_string()
        })
        .filter(|line| !line.is_empty())
        .collect()
}

fn is_aggregate_recall_row(row: &RecallResult) -> bool {
    row.source == "aggregate-recall"
        || row
            .source_id
            .as_deref()
            .is_some_and(|source_id| source_id.starts_with("aggregate-recall:"))
}

fn is_source_memory_row(row: &RecallResult) -> bool {
    row.source != "llm_summary"
        && !is_aggregate_recall_row(row)
        && !row.id.starts_with("constructed:")
        && !row.id.starts_with("summary:")
        && !row.id.starts_with("source-chunk:")
        && !row.id.starts_with("native-artifact:")
}

fn unique_evidence(rows: &[RecallResult]) -> Vec<RecallResult> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for row in rows {
        if !is_source_memory_row(row) || seen.contains(&row.id) {
            continue;
        }
        seen.insert(row.id.clone());
        result.push(row.clone());
    }
    result
}

fn evidence_can_save_as_global_aggregate(rows: &[RecallResult]) -> bool {
    rows.iter()
        .all(|row| row.visibility.as_deref() == Some("global") && row.scope.as_deref().is_none())
}

fn is_insufficient_aggregate_answer(text: &str) -> bool {
    let normalized = normalize_query(text);
    normalized == "insufficient_evidence"
        || ((normalized.starts_with("there isn't enough")
            || normalized.starts_with("there is not enough")
            || normalized.starts_with("not enough")
            || normalized.starts_with("insufficient")
            || normalized.starts_with("no useful"))
            && normalized.contains("evidence"))
        || ((normalized.starts_with("can't")
            || normalized.starts_with("cannot")
            || normalized.starts_with("could not")
            || normalized.starts_with("unable to"))
            && (normalized.contains("determine")
                || normalized.contains("answer")
                || normalized.contains("infer")))
}

fn is_conversational_aggregate_answer(text: &str) -> bool {
    let normalized = normalize_query(text);
    ["yes", "no", "probably", "maybe"]
        .iter()
        .any(|prefix| normalized == *prefix || normalized.starts_with(&format!("{prefix} ")))
        || normalized.contains("based on evidence")
        || normalized.contains("based on the evidence")
        || normalized.contains("from the evidence")
        || normalized.contains("the evidence says")
        || normalized.contains("the evidence shows")
        || normalized.contains("the evidence suggests")
        || normalized.contains("the read is")
        || normalized.contains("so the read is")
        || normalized.starts_with("answer:")
        || normalized.starts_with("response:")
}

fn aggregate_answer_can_be_saved(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.len() >= 12
        && !is_insufficient_aggregate_answer(trimmed)
        && !is_conversational_aggregate_answer(trimmed)
}

pub fn aggregate_key(
    agent_id: &str,
    project: Option<&str>,
    query: &str,
    budget: AggregateRecallBudget,
    source_memory_ids: &[String],
) -> String {
    let mut sorted_source_ids = source_memory_ids.to_vec();
    sorted_source_ids.sort();
    let mut hasher = Sha256::new();
    hasher.update(agent_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(project.unwrap_or("").as_bytes());
    hasher.update(b"\0");
    hasher.update(normalize_query(query).as_bytes());
    hasher.update(b"\0");
    hasher.update(budget.as_str().as_bytes());
    hasher.update(b"\0");
    hasher.update(sorted_source_ids.join("\0").as_bytes());
    format!("aggregate-recall:{:x}", hasher.finalize())
}

fn row_to_recall_result(row: AggregateMemoryRow) -> RecallResult {
    let content_length = row.content.len();
    RecallResult {
        id: row.id,
        content: row.content,
        content_length,
        truncated: false,
        score: 1.0,
        source: "aggregate-recall".to_string(),
        source_id: row.source_id,
        memory_type: row.memory_type,
        tags: row.tags,
        pinned: row.pinned,
        importance: row.importance,
        who: row.who.unwrap_or_default(),
        project: row.project,
        created_at: row.created_at,
        visibility: row.visibility,
        scope: None,
    }
}

fn load_aggregate_memory(
    conn: &Connection,
    id: &str,
) -> Result<Option<RecallResult>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, content, source_type, source_id, type, tags, pinned, importance, who, project, visibility, created_at
         FROM memories
         WHERE id = ?1 AND COALESCE(is_deleted, 0) = 0",
        params![id],
        |row| {
            Ok(AggregateMemoryRow {
                id: row.get(0)?,
                content: row.get(1)?,
                source_type: row.get(2)?,
                source_id: row.get(3)?,
                memory_type: row.get(4)?,
                tags: row.get(5)?,
                pinned: row.get::<_, i64>(6)? == 1,
                importance: row.get(7)?,
                who: row.get(8)?,
                project: row.get(9)?,
                visibility: row.get(10)?,
                created_at: row.get(11)?,
            })
        },
    )
    .optional()
    .map(|row| row.map(row_to_recall_result))
}

fn load_aggregate_by_key(
    conn: &Connection,
    key: &str,
    agent_id: &str,
    project: Option<&str>,
) -> Result<Option<RecallResult>, rusqlite::Error> {
    let row = conn
        .query_row(
            "SELECT id, content, source_type, source_id, type, tags, pinned, importance, who, project, visibility, created_at
             FROM memories
             WHERE idempotency_key = ?1
               AND COALESCE(NULLIF(agent_id, ''), 'default') = ?2
               AND source_type = 'aggregate-recall'
               AND visibility = 'global'
               AND scope IS NULL
               AND COALESCE(is_deleted, 0) = 0
             LIMIT 1",
            params![key, agent_id],
            |row| {
                Ok(AggregateMemoryRow {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    source_type: row.get(2)?,
                    source_id: row.get(3)?,
                    memory_type: row.get(4)?,
                    tags: row.get(5)?,
                    pinned: row.get::<_, i64>(6)? == 1,
                    importance: row.get(7)?,
                    who: row.get(8)?,
                    project: row.get(9)?,
                    visibility: row.get(10)?,
                    created_at: row.get(11)?,
                })
            },
        )
        .optional()?;
    let Some(row) = row else {
        return Ok(None);
    };
    if project.is_some() && row.project.as_deref() != project {
        return Ok(None);
    }
    Ok(Some(row_to_recall_result(row)))
}

fn load_memory_by_content_hash(
    conn: &Connection,
    content_hash: &str,
    agent_id: &str,
    project: Option<&str>,
) -> Result<Option<ContentHashMatch>, rusqlite::Error> {
    let row = conn
        .query_row(
            "SELECT id, content, source_type, source_id, type, tags, pinned, importance, who, project, visibility, created_at
             FROM memories
             WHERE content_hash = ?1
               AND COALESCE(NULLIF(agent_id, ''), 'default') = ?2
               AND scope IS NULL
               AND COALESCE(is_deleted, 0) = 0
             LIMIT 1",
            params![content_hash, agent_id],
            |row| {
                Ok(AggregateMemoryRow {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    source_type: row.get(2)?,
                    source_id: row.get(3)?,
                    memory_type: row.get(4)?,
                    tags: row.get(5)?,
                    pinned: row.get::<_, i64>(6)? == 1,
                    importance: row.get(7)?,
                    who: row.get(8)?,
                    project: row.get(9)?,
                    visibility: row.get(10)?,
                    created_at: row.get(11)?,
                })
            },
        )
        .optional()?;
    Ok(row.map(|row| {
        let visible_for_aggregate = row.visibility.as_deref() == Some("global")
            && (project.is_none() || row.project.as_deref() == project);
        let aggregate_recall_memory = row.source_type.as_deref() == Some("aggregate-recall");
        ContentHashMatch {
            row: row_to_recall_result(row),
            visible_for_aggregate,
            aggregate_recall_memory,
        }
    }))
}

fn link_aggregate_sources(
    conn: &Connection,
    aggregate_memory_id: &str,
    source_memory_ids: &[String],
    agent_id: &str,
    now: &str,
) -> Result<(), rusqlite::Error> {
    for source_memory_id in source_memory_ids {
        conn.execute(
            "INSERT OR IGNORE INTO aggregate_memory_sources
             (aggregate_memory_id, source_memory_id, agent_id, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![aggregate_memory_id, source_memory_id, agent_id, now],
        )?;
    }
    Ok(())
}

fn link_aggregate_query_hint(
    conn: &Connection,
    aggregate_memory_id: &str,
    agent_id: &str,
    query: &str,
    now: &str,
) -> Result<(), rusqlite::Error> {
    let hint = query.trim();
    if hint.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO memory_hints (id, memory_id, agent_id, hint, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            Uuid::new_v4().to_string(),
            aggregate_memory_id,
            agent_id,
            hint,
            now
        ],
    )?;
    Ok(())
}

fn unsaved_aggregate_result(content: &str, key: &str, project: Option<&str>) -> RecallResult {
    RecallResult {
        id: format!("{key}:unsaved"),
        content: content.to_string(),
        content_length: content.len(),
        truncated: false,
        score: 1.0,
        source: "aggregate-recall".to_string(),
        source_id: Some(key.to_string()),
        memory_type: "semantic".to_string(),
        tags: Some("aggregate,recall".to_string()),
        pinned: false,
        importance: 0.75,
        who: "signet".to_string(),
        project: project.map(str::to_string),
        created_at: Utc::now().to_rfc3339(),
        visibility: Some("global".to_string()),
        scope: None,
    }
}

fn resolve_aggregate_duplicate(
    conn: &Connection,
    key: &str,
    agent_id: &str,
    project: Option<&str>,
    query: &str,
    content_hash: &str,
    answer: &str,
    source_memory_ids: &[String],
    now: &str,
) -> Result<Option<AggregateDuplicateResolution>, AggregateRecallError> {
    if let Some(existing) = load_aggregate_by_key(conn, key, agent_id, project)? {
        link_aggregate_sources(conn, &existing.id, source_memory_ids, agent_id, now)?;
        link_aggregate_query_hint(conn, &existing.id, agent_id, query, now)?;
        return Ok(Some(AggregateDuplicateResolution {
            row: existing,
            saved: true,
        }));
    }

    let Some(duplicate_content) =
        load_memory_by_content_hash(conn, content_hash, agent_id, project)?
    else {
        return Ok(None);
    };
    if !duplicate_content.visible_for_aggregate || !duplicate_content.aggregate_recall_memory {
        return Ok(Some(AggregateDuplicateResolution {
            row: unsaved_aggregate_result(answer, key, project),
            saved: false,
        }));
    }
    link_aggregate_sources(
        conn,
        &duplicate_content.row.id,
        source_memory_ids,
        agent_id,
        now,
    )?;
    link_aggregate_query_hint(conn, &duplicate_content.row.id, agent_id, query, now)?;
    Ok(Some(AggregateDuplicateResolution {
        row: duplicate_content.row,
        saved: true,
    }))
}

fn is_unique_constraint_error(error: &CoreError) -> bool {
    let text = error.to_string().to_lowercase();
    text.contains("unique constraint failed") || text.contains("constraint failed")
}

fn enqueue_extraction_job(conn: &Connection, memory_id: &str, now: &str) -> Result<(), CoreError> {
    let id = format!("extract-{memory_id}");
    match enqueue(
        conn,
        &EnqueueJob {
            id: &id,
            memory_id: Some(memory_id),
            job_type: "extract",
            payload: None,
            max_attempts: 3,
            now,
            document_id: None,
        },
    ) {
        Ok(_) => Ok(()),
        Err(CoreError::Db(rusqlite::Error::SqliteFailure(error, _)))
            if error.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

async fn plan_queries(
    router: &dyn AggregateInferenceRouter,
    params: &AggregateRecallParams,
    budget: AggregateRecallBudget,
    max_queries: usize,
    initial_rows: &[RecallResult],
) -> (Vec<String>, Option<AggregateRecallUsageStage>) {
    let remaining = max_queries.saturating_sub(1);
    if remaining == 0 {
        return (Vec::new(), None);
    }
    let mut lines = vec![
        "Propose focused follow-up memory recall queries.".to_string(),
        "Return only JSON with this shape: {\"queries\":[\"...\"]}.".to_string(),
        format!("Original query: {}", params.query),
        format!(
            "Budget: {}; maximum follow-up queries: {remaining}.",
            budget.as_str()
        ),
        "Current evidence:".to_string(),
    ];
    lines.extend(
        initial_rows
            .iter()
            .take(8)
            .enumerate()
            .map(|(index, row)| format!("{}. {}", index + 1, row.content)),
    );
    let result = router
        .execute(
            AggregateRouteRequest {
                agent_id: params.agent_id.clone(),
                operation: "session_synthesis".to_string(),
                prompt_preview: params.query.clone(),
                expected_output_tokens: 300,
            },
            lines.join("\n"),
            AggregateInferenceOptions {
                max_tokens: Some(300),
                timeout_ms: Some(20_000),
                acpx_hooks: Some("disabled".to_string()),
                refresh: None,
            },
        )
        .await;
    match result {
        Ok(value) => (
            parse_planner_queries(&value.text)
                .into_iter()
                .take(remaining)
                .collect(),
            Some(usage_stage("planning", &value)),
        ),
        Err(_) => (Vec::new(), None),
    }
}

async fn synthesize(
    router: &dyn AggregateInferenceRouter,
    params: &AggregateRecallParams,
    evidence: &[RecallResult],
) -> (Option<String>, Option<AggregateRecallUsageStage>) {
    let mut lines = vec![
        "Write one concise atomic memory note from the memory evidence below.".to_string(),
        "Use only the evidence.".to_string(),
        "Write in third person as a standalone memory, not as a direct reply to the question."
            .to_string(),
        "Restate the question's subject or relationship in the memory so the note is useful without the original query."
            .to_string(),
        "If the evidence partially answers the question, save the stable known facts and omit unknowns or speculation."
            .to_string(),
        "Do not begin with \"yes\", \"no\", \"based on the evidence\", \"the evidence says\", or similar conversational framing."
            .to_string(),
        "If there are no useful stable facts relevant to the question, return exactly: INSUFFICIENT_EVIDENCE"
            .to_string(),
        format!("Question: {}", params.query),
        String::new(),
        "Evidence:".to_string(),
    ];
    lines.extend(evidence.iter().enumerate().map(|(index, row)| {
        let created_at = row.created_at.get(0..10).unwrap_or(row.created_at.as_str());
        format!(
            "{}. [{}; {}; {}] {}",
            index + 1,
            row.id,
            created_at,
            row.memory_type,
            row.content
        )
    }));
    let result = router
        .execute(
            AggregateRouteRequest {
                agent_id: params.agent_id.clone(),
                operation: "session_synthesis".to_string(),
                prompt_preview: params.query.clone(),
                expected_output_tokens: 700,
            },
            lines.join("\n"),
            AggregateInferenceOptions {
                max_tokens: Some(700),
                timeout_ms: Some(30_000),
                acpx_hooks: Some("disabled".to_string()),
                refresh: None,
            },
        )
        .await;
    match result {
        Ok(value) => {
            let answer = value.text.trim().to_string();
            let usage = usage_stage("synthesis", &value);
            if answer.is_empty() {
                (None, Some(usage))
            } else {
                (Some(answer), Some(usage))
            }
        }
        Err(_) => (None, None),
    }
}

async fn run_recall(
    conn: &Connection,
    provider: Option<&dyn AggregateRecallProvider>,
    params: AggregateRecallParams,
) -> Result<RecallResponse, AggregateRecallError> {
    if let Some(provider) = provider {
        provider.recall(conn, params).await
    } else {
        default_hybrid_recall(conn, &params)
    }
}

fn default_hybrid_recall(
    conn: &Connection,
    params: &AggregateRecallParams,
) -> Result<RecallResponse, AggregateRecallError> {
    let hits = hybrid_search(
        conn,
        &SearchOptions {
            query: params.query.clone(),
            vector: None,
            limit: 10,
            ..SearchOptions::default()
        },
    )?;
    let mut results = Vec::with_capacity(hits.len());
    for hit in hits {
        let row = conn
            .query_row(
                "SELECT source_id, tags, pinned, importance, who, project, created_at, visibility, scope
                 FROM memories WHERE id = ?1",
                params![hit.id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, f64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                },
            )
            .optional()?;
        let (source_id, tags, pinned, importance, who, project, created_at, visibility, scope) =
            row.unwrap_or((
                None,
                None,
                0,
                hit.confidence,
                None,
                None,
                Utc::now().to_rfc3339(),
                Some("global".to_string()),
                None,
            ));
        results.push(RecallResult {
            id: hit.id,
            content_length: hit.content.len(),
            content: hit.content,
            truncated: false,
            score: hit.score,
            source: hit.source.as_str().to_string(),
            source_id,
            memory_type: hit.memory_type,
            tags,
            pinned: pinned == 1,
            importance,
            who: who.unwrap_or_default(),
            project,
            created_at,
            visibility,
            scope,
        });
    }
    let total_returned = results.len();
    Ok(RecallResponse {
        results,
        query: params.query.clone(),
        method: "hybrid".to_string(),
        meta: RecallMeta {
            total_returned,
            has_supplementary: false,
            no_hits: total_returned == 0,
            timings: RecallTimings::default(),
        },
        aggregate: None,
    })
}

pub async fn aggregate_recall(
    conn: &Connection,
    params: AggregateRecallParams,
    deps: AggregateRecallDeps<'_>,
) -> Result<RecallResponse, AggregateRecallError> {
    let budget = normalize_budget(params.budget_input())?;
    let max_queries = budget.query_limit();
    let save_aggregate = deps.router.is_some() && params.save_aggregate != Some(false);
    let mut timings = TimingCollector::new();
    let mut usage_stages: Vec<AggregateRecallUsageStage> = Vec::new();
    let now = deps
        .now
        .map(|now| now())
        .unwrap_or_else(Utc::now)
        .to_rfc3339();

    let first = timings
        .time_async("aggregate_initial_recall", || {
            run_recall(conn, deps.recall, params.clone())
        })
        .await?;

    let Some(router) = deps.router else {
        let source_memory_ids = unique_evidence(&first.results)
            .into_iter()
            .map(|row| row.id)
            .collect::<Vec<_>>();
        let reason = if source_memory_ids.is_empty() {
            AggregateRecallStoppedReason::NoEvidence
        } else {
            AggregateRecallStoppedReason::RouterUnavailable
        };
        return Ok(finish_response(
            timings,
            usage_stages,
            empty_aggregate_response(
                &params,
                budget,
                vec![params.query.clone()],
                source_memory_ids,
                reason,
            ),
        ));
    };

    let first_planning_evidence = unique_evidence(&first.results);
    let (planned_queries, planning_usage) = timings
        .time_async("aggregate_planning", || {
            plan_queries(
                router,
                &params,
                budget,
                max_queries,
                &first_planning_evidence,
            )
        })
        .await;
    if let Some(usage) = planning_usage {
        usage_stages.push(usage);
    }
    let queries = unique_queries(&params.query, &planned_queries, max_queries);
    let mut recalls = vec![first];
    let followup_queries = queries.iter().skip(1).cloned().collect::<Vec<_>>();
    if !followup_queries.is_empty() {
        let followups = timings
            .time_async("aggregate_followup_recalls", || async {
                let mut responses = Vec::with_capacity(followup_queries.len());
                for query in followup_queries {
                    let mut followup = params.clone();
                    followup.query = query;
                    followup.aggregate = false;
                    responses.push(run_recall(conn, deps.recall, followup).await?);
                }
                Ok::<_, AggregateRecallError>(responses)
            })
            .await?;
        recalls.extend(followups);
    }

    let all_rows = recalls
        .iter()
        .flat_map(|response| response.results.iter().cloned())
        .collect::<Vec<_>>();
    let evidence = unique_evidence(&all_rows);
    let source_memory_ids = evidence
        .iter()
        .map(|row| row.id.clone())
        .collect::<Vec<_>>();
    if evidence.is_empty() {
        return Ok(finish_response(
            timings,
            usage_stages,
            empty_aggregate_response(
                &params,
                budget,
                queries,
                Vec::new(),
                AggregateRecallStoppedReason::NoEvidence,
            ),
        ));
    }

    let (answer, synthesis_usage) = timings
        .time_async("aggregate_synthesis", || {
            synthesize(router, &params, &evidence)
        })
        .await;
    if let Some(usage) = synthesis_usage {
        usage_stages.push(usage);
    }
    let Some(answer) = answer else {
        return Ok(finish_response(
            timings,
            usage_stages,
            empty_aggregate_response(
                &params,
                budget,
                queries,
                source_memory_ids,
                AggregateRecallStoppedReason::SynthesisFailed,
            ),
        ));
    };

    let agent_id = params.agent_id_or_default().to_string();
    let project = params.source_project().map(str::to_string);
    let key = aggregate_key(
        &agent_id,
        project.as_deref(),
        &params.query,
        budget,
        &source_memory_ids,
    );
    let mut row: Option<RecallResult>;
    let mut deduped = false;
    let mut saved = false;

    if save_aggregate
        && evidence_can_save_as_global_aggregate(&evidence)
        && aggregate_answer_can_be_saved(&answer)
    {
        let normalized = normalize_and_hash(&answer);
        row = timings.time("aggregate_save", || {
            let duplicate = resolve_aggregate_duplicate(
                conn,
                &key,
                &agent_id,
                project.as_deref(),
                &params.query,
                &normalized.hash,
                &answer,
                &source_memory_ids,
                &now,
            )?;
            if let Some(duplicate) = duplicate {
                deduped = true;
                saved = duplicate.saved;
                if duplicate.saved {
                    enqueue_extraction_job(conn, &duplicate.row.id, &now)?;
                }
                return Ok::<_, AggregateRecallError>(Some(duplicate.row));
            }

            let id = deps
                .id_factory
                .map(|id_factory| id_factory())
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let ingest = deps.ingest_envelope.unwrap_or(tx_ingest_envelope);
            let envelope = IngestEnvelopeInput {
                id: &id,
                content: &normalized.storage,
                normalized_content: Some(if normalized.normalized.is_empty() {
                    normalized.storage.as_str()
                } else {
                    normalized.normalized.as_str()
                }),
                content_hash: &normalized.hash,
                who: Some("signet"),
                why: Some("aggregate recall"),
                project: project.as_deref(),
                importance: 0.75,
                memory_type: "semantic",
                tags: Some("aggregate,recall"),
                pinned: false,
                extraction_status: "none",
                embedding_model: None,
                extraction_model: None,
                source_type: Some("aggregate-recall"),
                source_id: Some(&key),
                source_path: None,
                source_root: None,
                source_memory_id: None,
                idempotency_key: Some(&key),
                runtime_path: None,
                agent_id: &agent_id,
                visibility: "global",
                scope: None,
                created_at: &now,
                updated_by: "signet",
            };
            if let Err(error) = ingest(conn, &envelope) {
                if !is_unique_constraint_error(&error) {
                    return Err(AggregateRecallError::Core(error));
                }
                let raced_duplicate = resolve_aggregate_duplicate(
                    conn,
                    &key,
                    &agent_id,
                    project.as_deref(),
                    &params.query,
                    &normalized.hash,
                    &answer,
                    &source_memory_ids,
                    &now,
                )?;
                deduped = true;
                if let Some(raced_duplicate) = raced_duplicate {
                    saved = raced_duplicate.saved;
                    if raced_duplicate.saved {
                        enqueue_extraction_job(conn, &raced_duplicate.row.id, &now)?;
                    }
                    return Ok(Some(raced_duplicate.row));
                }
                saved = false;
                return Ok(Some(unsaved_aggregate_result(
                    &answer,
                    &key,
                    project.as_deref(),
                )));
            }
            link_aggregate_sources(conn, &id, &source_memory_ids, &agent_id, &now)?;
            link_aggregate_query_hint(conn, &id, &agent_id, &params.query, &now)?;
            enqueue_extraction_job(conn, &id, &now)?;
            saved = true;
            load_aggregate_memory(conn, &id).map_err(AggregateRecallError::from)
        })?;
    } else {
        row = Some(unsaved_aggregate_result(&answer, &key, project.as_deref()));
    }

    let results = row.take().into_iter().collect::<Vec<_>>();
    let total_returned = results.len();
    Ok(finish_response(
        timings,
        usage_stages,
        RecallResponse {
            results: results.clone(),
            query: params.query.clone(),
            method: "hybrid".to_string(),
            meta: RecallMeta {
                total_returned,
                has_supplementary: false,
                no_hits: total_returned == 0,
                timings: RecallTimings::default(),
            },
            aggregate: Some(AggregateRecallMeta {
                saved_memory_id: if saved {
                    results.first().map(|row| row.id.clone())
                } else {
                    None
                },
                saved,
                deduped,
                budget,
                queries,
                source_memory_ids,
                stopped_reason: AggregateRecallStoppedReason::Complete,
                usage: None,
            }),
        },
    ))
}

fn finish_response(
    timings: TimingCollector,
    usage_stages: Vec<AggregateRecallUsageStage>,
    mut response: RecallResponse,
) -> RecallResponse {
    response.meta.timings = timings.finish();
    if let Some(aggregate) = response.aggregate.as_mut() {
        aggregate.usage = build_aggregate_usage(usage_stages);
    }
    response
}
