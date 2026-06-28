//! Daily reflection worker runtime parity for the TypeScript daemon.
//!
//! The worker collects recent source material, builds the daily-brief prompt,
//! parses and deduplicates model output, and persists `daily_reflections` rows.
//! The model call is intentionally abstracted behind [`ReflectionInsightGenerator`]
//! so tests and daemon wiring can provide deterministic or live providers.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use signet_core::db::{DbPool, Priority};
use thiserror::Error;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};
use uuid::Uuid;

const POLL_INTERVAL_MS: i64 = 300_000;
const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 24 * 60 * MINUTE_MS;
const DAILY_BRIEF_MEMORY_BATCH_SIZE: usize = 50;

#[derive(Debug, Error)]
pub enum ReflectionWorkerError {
    #[error("database error: {0}")]
    Database(String),
    #[error("generation failed: {0}")]
    Generation(String),
    #[error("filesystem error: {0}")]
    Filesystem(String),
}

#[derive(Debug, Clone)]
pub struct ReflectionConfig {
    pub enabled: bool,
    pub time_window_hours: i64,
    pub max_memories: usize,
    pub max_summaries: usize,
    pub schedule: String,
    pub timeout_ms: u64,
    pub max_tokens: usize,
    pub model: String,
    pub agents_dir: PathBuf,
    pub poll_interval_ms: i64,
}

impl Default for ReflectionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            time_window_hours: 24,
            max_memories: 10,
            max_summaries: 10,
            schedule: "daily".to_string(),
            timeout_ms: 30_000,
            max_tokens: 512,
            model: "default".to_string(),
            agents_dir: PathBuf::from("."),
            poll_interval_ms: POLL_INTERVAL_MS,
        }
    }
}

pub trait ReflectionInsightGenerator: Send + Sync {
    fn generate(
        &self,
        prompt: &str,
        timeout_ms: u64,
        max_tokens: usize,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectionMemory {
    pub id: Option<String>,
    pub content: String,
    pub memory_type: String,
    pub tags: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectionSummary {
    pub id: Option<String>,
    pub content: String,
    pub created_at: String,
    pub latest_at: Option<String>,
    pub session_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectionTranscript {
    pub session_key: String,
    pub content: String,
    pub created_at: String,
    pub project: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectionGraphFact {
    pub entity: String,
    pub kind: String,
    pub detail: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingReflection {
    pub id: String,
    pub question: Option<String>,
    pub summary: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReflectionSourceContext {
    pub memories: Vec<ReflectionMemory>,
    pub summaries: Vec<ReflectionSummary>,
    pub transcripts: Vec<ReflectionTranscript>,
    pub graph_facts: Vec<ReflectionGraphFact>,
    pub existing_reflections: Vec<ExistingReflection>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DailyBriefInsight {
    pub summary: String,
    pub question: Option<String>,
    pub patterns: Vec<String>,
}

#[derive(Debug, Default)]
struct WorkerState {
    running: bool,
    stopped: bool,
    generating: bool,
}

pub struct ReflectionWorkerHandle {
    pool: DbPool,
    generator: Arc<dyn ReflectionInsightGenerator + Send + Sync>,
    config: ReflectionConfig,
    state: Arc<Mutex<WorkerState>>,
    scheduler: Mutex<Option<JoinHandle<()>>>,
}

fn today_date(now: DateTime<Utc>) -> String {
    now.format("%Y-%m-%d").to_string()
}

fn scheduled_time_for(schedule: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let parts = schedule.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 5 || parts[2] != "*" || parts[3] != "*" || parts[4] != "*" {
        return None;
    }
    let minute = parts[0].parse::<u32>().ok()?;
    let hour = parts[1].parse::<u32>().ok()?;
    if minute > 59 || hour > 23 {
        return None;
    }
    now.date_naive()
        .and_hms_opt(hour, minute, 0)
        .map(|naive| DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
}

/// Port of `nextReflectionDelayMs` from the TypeScript worker.
pub fn next_reflection_delay_ms(
    schedule: &str,
    last_date: Option<&str>,
    now: DateTime<Utc>,
) -> i64 {
    let Some(scheduled) = scheduled_time_for(schedule, now) else {
        return POLL_INTERVAL_MS;
    };

    let date = today_date(now);
    if last_date == Some(date.as_str()) {
        return (scheduled.timestamp_millis() + DAY_MS - now.timestamp_millis()).max(0);
    }
    if now.timestamp_millis() < scheduled.timestamp_millis() {
        return (scheduled.timestamp_millis() - now.timestamp_millis()).max(0);
    }
    POLL_INTERVAL_MS
}

fn normalize_insight(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_space = false;
    for ch in text.chars().flat_map(|ch| ch.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn trim_line(text: &str, max: usize) -> String {
    let single = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single.chars().count() > max {
        let mut trimmed = single
            .chars()
            .take(max.saturating_sub(1))
            .collect::<String>();
        trimmed = trimmed.trim().to_string();
        format!("{trimmed}…")
    } else {
        single
    }
}

fn is_question_led_insight(text: &str) -> bool {
    let normalized = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if normalized.ends_with('?') {
        return true;
    }
    let first = normalized.split_whitespace().next().unwrap_or_default();
    if !matches!(
        first,
        "has"
            | "have"
            | "does"
            | "did"
            | "do"
            | "is"
            | "are"
            | "was"
            | "were"
            | "can"
            | "could"
            | "will"
            | "would"
            | "should"
            | "what"
            | "which"
            | "who"
            | "when"
            | "where"
            | "why"
            | "how"
    ) {
        return false;
    }
    normalized
        .chars()
        .take_while(|ch| !matches!(ch, '.' | '!' | '?'))
        .count()
        < normalized.chars().count()
        && normalized
            .chars()
            .take_while(|ch| !matches!(ch, '.' | '!'))
            .any(|ch| ch == '?')
}

pub fn parse_daily_brief_insights(text: &str, limit: usize) -> Vec<DailyBriefInsight> {
    let mut insights = Vec::new();
    let mut pending: Option<String> = None;
    let mut pending_is_question = false;
    let mut patterns: Vec<String> = Vec::new();

    fn flush(
        insights: &mut Vec<DailyBriefInsight>,
        pending: &mut Option<String>,
        pending_is_question: &mut bool,
        patterns: &mut Vec<String>,
    ) {
        let Some(raw) = pending.take() else { return };
        let summary = trim_line(&raw, 560);
        if !summary.is_empty() {
            let question = if *pending_is_question || is_question_led_insight(&summary) {
                Some(summary.clone())
            } else {
                None
            };
            insights.push(DailyBriefInsight {
                question,
                summary,
                patterns: std::mem::take(patterns),
            });
        } else {
            patterns.clear();
        }
        *pending_is_question = false;
    }

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let cleaned = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("* "))
            .unwrap_or(line)
            .trim();
        if let Some((label, value)) = cleaned.split_once(':') {
            let label_upper = label.trim().to_ascii_uppercase();
            if matches!(
                label_upper.as_str(),
                "ASK" | "QUESTION" | "BRIEF" | "GAP" | "INSIGHT" | "SUMMARY"
            ) {
                flush(
                    &mut insights,
                    &mut pending,
                    &mut pending_is_question,
                    &mut patterns,
                );
                pending = Some(value.trim().to_string());
                pending_is_question = matches!(label_upper.as_str(), "ASK" | "QUESTION");
                continue;
            }
            if pending.is_some() && matches!(label_upper.as_str(), "FOCUS" | "PATTERNS" | "TAGS") {
                patterns = value
                    .split(',')
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .take(5)
                    .map(ToOwned::to_owned)
                    .collect();
            }
        }
    }
    flush(
        &mut insights,
        &mut pending,
        &mut pending_is_question,
        &mut patterns,
    );

    if insights.is_empty() {
        let has_structured_label = text.lines().any(|line| {
            let cleaned = line
                .trim()
                .strip_prefix("- ")
                .or_else(|| line.trim().strip_prefix("* "))
                .unwrap_or(line.trim());
            let Some((label, _)) = cleaned.split_once(':') else {
                return false;
            };
            matches!(
                label.trim().to_ascii_uppercase().as_str(),
                "ASK"
                    | "BRIEF"
                    | "FOCUS"
                    | "GAP"
                    | "INSIGHT"
                    | "PATTERNS"
                    | "QUESTION"
                    | "SUMMARY"
                    | "TAGS"
            )
        });
        let fallback = trim_line(text, 560);
        if !has_structured_label && !fallback.is_empty() {
            let question = if is_question_led_insight(&fallback) {
                Some(fallback.clone())
            } else {
                None
            };
            insights.push(DailyBriefInsight {
                question,
                summary: fallback,
                patterns: Vec::new(),
            });
        }
    }

    let mut seen = HashSet::new();
    insights
        .into_iter()
        .filter(|item| {
            let key = normalize_insight(&item.summary);
            !key.is_empty() && seen.insert(key)
        })
        .take(limit)
        .collect()
}

pub fn build_reflection_prompt(context: &ReflectionSourceContext, count: usize) -> String {
    let plural = if count == 1 { "question" } else { "questions" };
    let mut lines = vec![
        "You are the question generator for a daily memory brief.".to_string(),
        "You will receive a mechanically selected bundle of recent user memories. It is not curated for a topic. Treat it as raw memory evidence.".to_string(),
        String::new(),
        format!("Goal: write {count} {plural} the user might actually want to answer today."),
        String::new(),
        "Pattern to prefer:".to_string(),
        "- Find an earlier/later pair, repeated thread, or gentle mismatch in the memories.".to_string(),
        "- Shape: \"You wrote/said X, and later Y showed up. How does that fit/feel now?\"".to_string(),
        "- The question should be a memory prompt, not a task prompt.".to_string(),
        String::new(),
        "Rules:".to_string(),
        "- Address the user by name only if the name is clear from the memories.".to_string(),
        "- Use concrete details from the memories: people, projects, quotes, places, dates, or repeated phrases.".to_string(),
        "- Ask about a real remembered tension, change, or open feeling.".to_string(),
        "- Do not ask what Signet, an agent, or a tool should do.".to_string(),
        "- Do not ask for productivity planning unless the memories themselves clearly center on an active decision.".to_string(),
        "- Do not invent hypotheticals or future scenarios.".to_string(),
        "- Do not over-compress into vague labels like \"hidden mess,\" \"small kind thing,\" or \"relationship architecture.\"".to_string(),
        "- Keep each question natural and answerable on first read. 45-85 words is fine.".to_string(),
        String::new(),
        "Output only lines in this format:".to_string(),
        "QUESTION: <daily brief question>".to_string(),
        String::new(),
    ];

    if !context.existing_reflections.is_empty() {
        lines.push("Existing brief items to avoid repeating:".to_string());
        for reflection in context.existing_reflections.iter().take(12) {
            lines.push(format!(
                "  [{}] {}",
                &reflection.created_at[..reflection.created_at.len().min(10)],
                trim_line(&reflection.summary, 220)
            ));
            if let Some(question) = &reflection.question {
                if normalize_insight(question) != normalize_insight(&reflection.summary) {
                    lines.push(format!(
                        "  [{}] {}",
                        &reflection.created_at[..reflection.created_at.len().min(10)],
                        trim_line(question, 220)
                    ));
                }
            }
        }
        lines.push(String::new());
    }

    lines.push("Recent saved memories:".to_string());
    for memory in &context.memories {
        let date = &memory.created_at[..memory.created_at.len().min(10)];
        let tags = if memory.tags.is_empty() {
            String::new()
        } else {
            format!("[{}] ", memory.tags)
        };
        lines.push(format!(
            "  [{date}] ({}) {tags}{}",
            memory.memory_type,
            trim_line(&memory.content, 500)
        ));
    }

    lines.join("\n")
}

pub async fn collect_reflection_context(
    pool: &DbPool,
    agent_id: &str,
    _config: &ReflectionConfig,
) -> Result<ReflectionSourceContext, ReflectionWorkerError> {
    let agent_id = agent_id.to_string();

    pool.read(move |conn| {
        let memories = {
            let mut stmt = conn.prepare_cached(
                "SELECT id, content, type, tags, created_at FROM memories
                 WHERE agent_id = ?1 AND is_deleted = 0
                 ORDER BY created_at DESC LIMIT ?2",
            )?;
            stmt.query_map(
                params![agent_id, DAILY_BRIEF_MEMORY_BATCH_SIZE as i64],
                |row| {
                    Ok(ReflectionMemory {
                        id: row.get(0)?,
                        content: row.get(1)?,
                        memory_type: row.get(2)?,
                        tags: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        created_at: row.get(4)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };

        let existing_reflections = {
            let mut stmt = conn.prepare_cached(
                "SELECT id, question, summary, created_at FROM daily_reflections
                 WHERE agent_id = ?1
                 ORDER BY created_at DESC LIMIT 24",
            )?;
            stmt.query_map(params![agent_id], |row| {
                Ok(ExistingReflection {
                    id: row.get(0)?,
                    question: row.get(1)?,
                    summary: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };

        Ok(ReflectionSourceContext {
            memories,
            summaries: Vec::new(),
            transcripts: Vec::new(),
            graph_facts: Vec::new(),
            existing_reflections,
        })
    })
    .await
    .map_err(|e| ReflectionWorkerError::Database(e.to_string()))
}

pub async fn generate_daily_brief_insights(
    pool: &DbPool,
    generator: Arc<dyn ReflectionInsightGenerator + Send + Sync>,
    agent_id: &str,
    config: &ReflectionConfig,
    count: usize,
) -> Result<Vec<String>, ReflectionWorkerError> {
    let context = collect_reflection_context(pool, agent_id, config).await?;
    if context.memories.is_empty() {
        return Ok(Vec::new());
    }

    let prompt = build_reflection_prompt(&context, count);
    let raw = generator
        .generate(&prompt, config.timeout_ms, config.max_tokens)
        .await
        .map_err(ReflectionWorkerError::Generation)?;

    let mut existing = context
        .existing_reflections
        .iter()
        .flat_map(|r| [Some(r.summary.as_str()), r.question.as_deref()])
        .flatten()
        .map(normalize_insight)
        .filter(|key| !key.is_empty())
        .collect::<HashSet<_>>();

    let insights = parse_daily_brief_insights(&raw, (count * 2).max(count))
        .into_iter()
        .filter(|insight| {
            let key = normalize_insight(&insight.summary);
            !key.is_empty() && existing.insert(key)
        })
        .take(count)
        .collect::<Vec<_>>();

    if insights.is_empty() {
        return Ok(Vec::new());
    }

    let agent_id = agent_id.to_string();
    let now = Utc::now().to_rfc3339();
    let date = today_date(Utc::now());
    let model = config.model.clone();
    let memory_ids = serde_json::to_string(
        &context
            .memories
            .iter()
            .filter_map(|memory| memory.id.clone())
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".to_string());
    let summary_ids = serde_json::to_string(
        &context
            .summaries
            .iter()
            .filter_map(|summary| summary.id.clone())
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".to_string());

    let inserted = pool
        .write_tx(Priority::High, move |conn| {
            let mut ids = Vec::new();
            for insight in insights {
                let id = Uuid::new_v4().to_string();
                let content_key = normalize_insight(&insight.summary);
                let patterns =
                    serde_json::to_string(&insight.patterns).unwrap_or_else(|_| "[]".to_string());
                let changes = conn.execute(
                    "INSERT OR IGNORE INTO daily_reflections
                     (id, agent_id, date, summary, patterns, question, content_key,
                      memory_ids, summary_ids, model, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        id,
                        agent_id,
                        date,
                        insight.summary,
                        patterns,
                        insight.question,
                        content_key,
                        memory_ids,
                        summary_ids,
                        model,
                        now,
                    ],
                )?;
                if changes > 0 {
                    ids.push(id);
                }
            }
            Ok(serde_json::json!(ids))
        })
        .await
        .map_err(|e| ReflectionWorkerError::Database(e.to_string()))?;

    Ok(serde_json::from_value(inserted).unwrap_or_default())
}

fn percent_encode_agent_id(agent_id: &str) -> String {
    if agent_id == "default" {
        return "default".to_string();
    }
    let mut encoded = String::new();
    for byte in agent_id.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn last_reflection_path(agents_dir: &Path, agent_id: &str) -> PathBuf {
    agents_dir.join(".daemon").join(format!(
        "last-reflection.{}.json",
        percent_encode_agent_id(agent_id)
    ))
}

pub fn read_last_reflection_time(agents_dir: &Path, agent_id: &str) -> Option<String> {
    let raw = fs::read_to_string(last_reflection_path(agents_dir, agent_id)).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    value["lastDate"].as_str().map(ToOwned::to_owned)
}

pub fn write_last_reflection_time(
    agents_dir: &Path,
    agent_id: &str,
    date: &str,
) -> Result<(), ReflectionWorkerError> {
    let dir = agents_dir.join(".daemon");
    fs::create_dir_all(&dir).map_err(|e| ReflectionWorkerError::Filesystem(e.to_string()))?;
    fs::write(
        last_reflection_path(agents_dir, agent_id),
        serde_json::json!({ "lastDate": date }).to_string(),
    )
    .map_err(|e| ReflectionWorkerError::Filesystem(e.to_string()))
}

impl ReflectionWorkerHandle {
    pub fn stop(&self) {
        {
            let mut state = self.state.lock().expect("reflection worker state");
            state.stopped = true;
            state.running = false;
        }
        if let Some(handle) = self.scheduler.lock().expect("reflection scheduler").take() {
            handle.abort();
        }
    }

    pub fn running(&self) -> bool {
        self.state.lock().expect("reflection worker state").running
    }

    pub async fn trigger_now(&self, agent_id: Option<&str>) -> Result<(), ReflectionWorkerError> {
        if let Some(agent_id) = agent_id {
            self.run_reflection(agent_id).await;
        } else {
            self.run_due_agents().await?;
        }
        Ok(())
    }

    async fn run_reflection(&self, agent_id: &str) {
        match generate_daily_brief_insights(
            &self.pool,
            self.generator.clone(),
            agent_id,
            &self.config,
            1,
        )
        .await
        {
            Ok(ids) if ids.is_empty() => {
                debug!(
                    agent_id,
                    "no source material or fresh insight to reflect on"
                );
            }
            Ok(ids) => {
                if let Err(e) = write_last_reflection_time(
                    &self.config.agents_dir,
                    agent_id,
                    &today_date(Utc::now()),
                ) {
                    warn!(agent_id, error = %e, "failed to persist reflection timestamp");
                }
                info!(agent_id, count = ids.len(), "generated daily brief question");
            }
            Err(e) => warn!(agent_id, error = %e, "reflection generation failed"),
        }
    }

    async fn list_active_agent_ids(&self) -> Result<Vec<String>, ReflectionWorkerError> {
        list_active_agent_ids(&self.pool, &self.config).await
    }

    async fn run_due_agents(&self) -> Result<(), ReflectionWorkerError> {
        let date = today_date(Utc::now());
        for agent_id in self.list_active_agent_ids().await? {
            let last_date = read_last_reflection_time(&self.config.agents_dir, &agent_id);
            if last_date.as_deref() != Some(date.as_str())
                && next_reflection_delay_ms(&self.config.schedule, last_date.as_deref(), Utc::now())
                    == POLL_INTERVAL_MS
            {
                self.run_reflection(&agent_id).await;
            }
        }
        Ok(())
    }

    async fn next_worker_delay_ms(&self) -> i64 {
        match self.list_active_agent_ids().await {
            Ok(agent_ids) => agent_ids
                .iter()
                .map(|agent_id| {
                    next_reflection_delay_ms(
                        &self.config.schedule,
                        read_last_reflection_time(&self.config.agents_dir, agent_id).as_deref(),
                        Utc::now(),
                    )
                })
                .min()
                .unwrap_or(self.config.poll_interval_ms),
            Err(e) => {
                warn!(error = %e, "failed to compute reflection worker delay");
                self.config.poll_interval_ms
            }
        }
    }
}

pub async fn list_active_agent_ids(
    pool: &DbPool,
    _config: &ReflectionConfig,
) -> Result<Vec<String>, ReflectionWorkerError> {
    let ids = pool
        .read(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT DISTINCT agent_id FROM memories
                 WHERE is_deleted = 0",
            )?;
            stmt.query_map([], |row| row.get::<_, Option<String>>(0))?
                .filter_map(Result::ok)
                .flatten()
                .collect::<Vec<_>>()
                .pipe(Ok)
        })
        .await
        .map_err(|e| ReflectionWorkerError::Database(e.to_string()))?;

    if ids.is_empty() {
        Ok(vec!["default".to_string()])
    } else {
        Ok(ids)
    }
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

pub fn start_reflection_worker(
    pool: DbPool,
    generator: Arc<dyn ReflectionInsightGenerator + Send + Sync>,
    config: ReflectionConfig,
) -> ReflectionWorkerHandle {
    let state = Arc::new(Mutex::new(WorkerState {
        running: true,
        stopped: false,
        generating: false,
    }));

    let handle = ReflectionWorkerHandle {
        pool: pool.clone(),
        generator: generator.clone(),
        config: config.clone(),
        state: state.clone(),
        scheduler: Mutex::new(None),
    };

    let scheduler_handle = ReflectionWorkerHandle {
        pool,
        generator,
        config,
        state: state.clone(),
        scheduler: Mutex::new(None),
    };

    let task = tokio::spawn(async move {
        loop {
            let delay_ms = scheduler_handle.next_worker_delay_ms().await.max(0) as u64;
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            {
                let mut guard = state.lock().expect("reflection worker state");
                if guard.stopped {
                    break;
                }
                if guard.generating {
                    continue;
                }
                guard.generating = true;
            }
            let _ = scheduler_handle.run_due_agents().await;
            let mut guard = state.lock().expect("reflection worker state");
            guard.generating = false;
            if guard.stopped {
                break;
            }
        }
    });

    *handle.scheduler.lock().expect("reflection scheduler") = Some(task);
    handle
}

#[allow(dead_code)]
fn reflection_exists(
    conn: &rusqlite::Connection,
    agent_id: &str,
    content_key: &str,
    date: &str,
) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT 1 FROM daily_reflections WHERE agent_id = ?1 AND content_key = ?2 AND date = ?3 LIMIT 1",
        params![agent_id, content_key, date],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
}
