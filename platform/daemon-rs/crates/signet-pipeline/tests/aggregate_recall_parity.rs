use std::cell::RefCell;
use std::collections::HashMap;

use chrono::{TimeZone, Utc};
use rusqlite::{Connection, params};
use serde_json::json;
use signet_pipeline::aggregate_recall::*;

fn setup_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("run migrations");
    conn
}

fn row(id: &str, content: &str) -> RecallResult {
    RecallResult {
        id: id.to_string(),
        content: content.to_string(),
        content_length: content.len(),
        truncated: false,
        score: 0.9,
        source: "hybrid".to_string(),
        source_id: None,
        memory_type: "semantic".to_string(),
        tags: None,
        pinned: false,
        importance: 0.7,
        who: "test".to_string(),
        project: None,
        created_at: "2026-05-20T12:00:00.000Z".to_string(),
        visibility: Some("global".to_string()),
        scope: None,
    }
}

fn response(query: &str, results: Vec<RecallResult>) -> RecallResponse {
    let total_returned = results.len();
    RecallResponse {
        results,
        query: query.to_string(),
        method: "hybrid".to_string(),
        meta: RecallMeta {
            total_returned,
            has_supplementary: false,
            no_hits: total_returned == 0,
            timings: RecallTimings::default(),
        },
        aggregate: None,
    }
}

#[derive(Default)]
struct StaticRecall {
    calls: RefCell<Vec<String>>,
    by_query: HashMap<String, Vec<RecallResult>>,
}

impl StaticRecall {
    fn with(mut self, query: &str, rows: Vec<RecallResult>) -> Self {
        self.by_query.insert(query.to_string(), rows);
        self
    }

    fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }
}

impl AggregateRecallProvider for StaticRecall {
    fn recall<'a>(
        &'a self,
        _conn: &'a Connection,
        params: AggregateRecallParams,
    ) -> BoxAggregateFuture<'a, Result<RecallResponse, AggregateRecallError>> {
        Box::pin(async move {
            self.calls.borrow_mut().push(params.query.clone());
            let rows = self
                .by_query
                .get(&params.query)
                .cloned()
                .unwrap_or_default();
            Ok(response(&params.query, rows))
        })
    }
}

struct StaticRouter {
    synthesis_text: String,
    calls: RefCell<Vec<AggregateRouteRequest>>,
    prompts: RefCell<Vec<String>>,
    opts: RefCell<Vec<AggregateInferenceOptions>>,
}

impl Default for StaticRouter {
    fn default() -> Self {
        Self {
            synthesis_text: "Aggregate answer from memory evidence.".to_string(),
            calls: RefCell::new(Vec::new()),
            prompts: RefCell::new(Vec::new()),
            opts: RefCell::new(Vec::new()),
        }
    }
}

impl StaticRouter {
    fn with_synthesis(text: &str) -> Self {
        Self {
            synthesis_text: text.to_string(),
            ..Self::default()
        }
    }

    fn call_operations(&self) -> Vec<String> {
        self.calls
            .borrow()
            .iter()
            .map(|call| call.operation.clone())
            .collect()
    }
}

impl AggregateInferenceRouter for StaticRouter {
    fn execute<'a>(
        &'a self,
        request: AggregateRouteRequest,
        prompt: String,
        opts: AggregateInferenceOptions,
    ) -> BoxAggregateFuture<'a, Result<AggregateInferenceResult, AggregateRouterError>> {
        Box::pin(async move {
            self.calls.borrow_mut().push(request);
            self.prompts.borrow_mut().push(prompt);
            self.opts.borrow_mut().push(opts);
            let call_number = self.calls.borrow().len();
            let text = if call_number == 1 {
                json!({"queries": ["follow up one", "follow up two"]}).to_string()
            } else {
                self.synthesis_text.clone()
            };
            Ok(AggregateInferenceResult {
                text,
                usage: Some(LlmUsage {
                    input_tokens: Some((call_number * 10) as f64),
                    output_tokens: Some(call_number as f64),
                    cache_read_tokens: Some(call_number as f64),
                    cache_creation_tokens: None,
                    total_cost: Some(call_number as f64 / 1000.0),
                    total_duration_ms: Some((call_number * 100) as f64),
                }),
                attempts: vec![AggregateInferenceAttempt {
                    target_ref: "test-router/default".to_string(),
                    ok: true,
                    duration_ms: (call_number * 100) as f64,
                    usage: Some(LlmUsage {
                        input_tokens: Some((call_number * 10) as f64),
                        output_tokens: Some(call_number as f64),
                        cache_read_tokens: Some(call_number as f64),
                        cache_creation_tokens: None,
                        total_cost: Some(call_number as f64 / 1000.0),
                        total_duration_ms: Some((call_number * 100) as f64),
                    }),
                }],
            })
        })
    }
}

#[test]
fn budget_parsing_matches_ts_defaults_and_rejections() {
    assert_eq!(
        parse_aggregate_recall_budget(None),
        Some(AggregateRecallBudget::Small)
    );
    assert_eq!(
        parse_aggregate_recall_budget(Some("small")),
        Some(AggregateRecallBudget::Small)
    );
    assert_eq!(
        parse_aggregate_recall_budget(Some("medium")),
        Some(AggregateRecallBudget::Medium)
    );
    assert_eq!(
        parse_aggregate_recall_budget(Some("large")),
        Some(AggregateRecallBudget::Large)
    );
    assert_eq!(parse_aggregate_recall_budget(Some("maximum")), None);

    let input = json!({"aggregate_budget": "large", "aggregateBudget": "small"});
    assert_eq!(
        parse_aggregate_recall_budget_json(read_aggregate_recall_budget_input(&input)),
        Some(AggregateRecallBudget::Small),
        "camelCase input takes precedence over snake_case"
    );
    assert_eq!(
        parse_aggregate_recall_budget_json(read_aggregate_recall_budget_input(&json!({}))),
        Some(AggregateRecallBudget::Small)
    );
    assert_eq!(
        parse_aggregate_recall_budget_json(read_aggregate_recall_budget_input(
            &json!({"aggregateBudget": null})
        )),
        None
    );
}

#[tokio::test]
async fn rejects_invalid_aggregate_budget() {
    let conn = setup_conn();
    let recall = StaticRecall::default();
    let router = StaticRouter::default();
    let err = aggregate_recall(
        &conn,
        AggregateRecallParams {
            query: "what happened".to_string(),
            aggregate: true,
            aggregate_budget: Some("maximum".to_string()),
            ..AggregateRecallParams::default()
        },
        AggregateRecallDeps {
            recall: Some(&recall),
            router: Some(&router),
            ..AggregateRecallDeps::default()
        },
    )
    .await
    .expect_err("invalid budgets should reject");
    assert!(matches!(err, AggregateRecallError::InvalidBudget));
}

#[tokio::test]
async fn orchestrates_planning_followups_synthesis_save_and_links_evidence() {
    let conn = setup_conn();
    let recall = StaticRecall::default()
        .with("what happened", vec![row("mem-1", "First evidence")])
        .with("follow up one", vec![row("mem-2", "Second evidence")])
        .with("follow up two", vec![row("mem-3", "Third evidence")]);
    let router = StaticRouter::default();
    let now = || Utc.with_ymd_and_hms(2026, 5, 20, 12, 0, 0).unwrap();
    let id = || "aggregate-1".to_string();

    let result = aggregate_recall(
        &conn,
        AggregateRecallParams {
            query: "what happened".to_string(),
            aggregate: true,
            aggregate_budget: Some("small".to_string()),
            agent_id: Some("agent-a".to_string()),
            read_policy: Some("isolated".to_string()),
            ..AggregateRecallParams::default()
        },
        AggregateRecallDeps {
            recall: Some(&recall),
            router: Some(&router),
            now: Some(&now),
            id_factory: Some(&id),
            ..AggregateRecallDeps::default()
        },
    )
    .await
    .expect("aggregate recall succeeds");

    assert_eq!(
        recall.calls(),
        vec!["what happened", "follow up one", "follow up two"]
    );
    assert_eq!(
        router.call_operations(),
        vec!["session_synthesis", "session_synthesis"]
    );
    assert!(
        router.prompts.borrow()[1].contains("one concise atomic memory note"),
        "synthesis prompt should match TS intent"
    );
    assert!(
        router.prompts.borrow()[1].contains("INSUFFICIENT_EVIDENCE"),
        "synthesis prompt should carry insufficient-evidence sentinel"
    );
    assert!(
        router
            .opts
            .borrow()
            .iter()
            .all(|opts| opts.acpx_hooks.as_deref() == Some("disabled"))
    );

    assert_eq!(result.results.len(), 1);
    assert_eq!(result.results[0].id, "aggregate-1");
    let aggregate = result.aggregate.expect("aggregate metadata");
    assert_eq!(aggregate.saved_memory_id.as_deref(), Some("aggregate-1"));
    assert!(aggregate.saved);
    assert!(!aggregate.deduped);
    assert_eq!(
        aggregate.stopped_reason,
        AggregateRecallStoppedReason::Complete
    );
    assert_eq!(aggregate.source_memory_ids, vec!["mem-1", "mem-2", "mem-3"]);
    assert_eq!(
        aggregate.queries,
        vec!["what happened", "follow up one", "follow up two"]
    );
    let usage = aggregate.usage.expect("usage stats");
    assert_eq!(usage.input_tokens, Some(30.0));
    assert_eq!(usage.output_tokens, Some(3.0));
    assert_eq!(usage.cache_read_tokens, Some(3.0));
    assert_eq!(usage.total_cost, Some(0.003));
    assert_eq!(usage.total_duration_ms, Some(300.0));
    assert_eq!(
        usage
            .stages
            .iter()
            .map(|stage| stage.name.as_str())
            .collect::<Vec<_>>(),
        vec!["planning", "synthesis"]
    );
    assert_eq!(
        result
            .meta
            .timings
            .stages
            .iter()
            .map(|stage| stage.name.as_str())
            .collect::<Vec<_>>(),
        vec![
            "aggregate_initial_recall",
            "aggregate_planning",
            "aggregate_followup_recalls",
            "aggregate_synthesis",
            "aggregate_save",
        ]
    );

    let saved: (String, String, String, String, String, String) = conn
        .query_row(
            "SELECT source_type, idempotency_key, tags, who, type, extraction_status FROM memories WHERE id = ?1",
            params!["aggregate-1"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .expect("saved aggregate memory");
    assert_eq!(saved.0, "aggregate-recall");
    assert!(saved.1.starts_with("aggregate-recall:"));
    assert_eq!(saved.2, "aggregate,recall");
    assert_eq!(saved.3, "signet");
    assert_eq!(saved.4, "semantic");
    assert_eq!(saved.5, "none");

    let links = conn
        .prepare(
            "SELECT source_memory_id FROM aggregate_memory_sources WHERE aggregate_memory_id = ?1 ORDER BY source_memory_id",
        )
        .expect("prepare links")
        .query_map(params!["aggregate-1"], |row| row.get::<_, String>(0))
        .expect("query links")
        .collect::<Result<Vec<_>, _>>()
        .expect("read links");
    assert_eq!(links, vec!["mem-1", "mem-2", "mem-3"]);

    let hint: String = conn
        .query_row(
            "SELECT hint FROM memory_hints WHERE memory_id = ?1",
            params!["aggregate-1"],
            |row| row.get(0),
        )
        .expect("query hint");
    assert_eq!(hint, "what happened");
}

#[tokio::test]
async fn router_unavailable_and_no_evidence_stop_without_saving() {
    let conn = setup_conn();
    let recall =
        StaticRecall::default().with("what happened", vec![row("mem-1", "First evidence")]);
    let result = aggregate_recall(
        &conn,
        AggregateRecallParams {
            query: "what happened".to_string(),
            aggregate: true,
            agent_id: Some("agent-a".to_string()),
            ..AggregateRecallParams::default()
        },
        AggregateRecallDeps {
            recall: Some(&recall),
            router: None,
            ..AggregateRecallDeps::default()
        },
    )
    .await
    .expect("router-unavailable result");
    let aggregate = result.aggregate.expect("aggregate metadata");
    assert_eq!(
        aggregate.stopped_reason,
        AggregateRecallStoppedReason::RouterUnavailable
    );
    assert_eq!(aggregate.source_memory_ids, vec!["mem-1"]);
    assert!(!aggregate.saved);

    let empty_recall = StaticRecall::default().with("no hits", Vec::new());
    let router = StaticRouter::default();
    let empty = aggregate_recall(
        &conn,
        AggregateRecallParams {
            query: "no hits".to_string(),
            aggregate: true,
            agent_id: Some("agent-a".to_string()),
            ..AggregateRecallParams::default()
        },
        AggregateRecallDeps {
            recall: Some(&empty_recall),
            router: Some(&router),
            ..AggregateRecallDeps::default()
        },
    )
    .await
    .expect("no-evidence result");
    let aggregate = empty.aggregate.expect("aggregate metadata");
    assert_eq!(
        aggregate.stopped_reason,
        AggregateRecallStoppedReason::NoEvidence
    );
    assert!(empty.results.is_empty());
    assert!(!aggregate.saved);
}

#[tokio::test]
async fn empty_synthesis_stops_without_saving() {
    let conn = setup_conn();
    let recall =
        StaticRecall::default().with("what happened", vec![row("mem-1", "First evidence")]);
    let router = StaticRouter::with_synthesis("");

    let result = aggregate_recall(
        &conn,
        AggregateRecallParams {
            query: "what happened".to_string(),
            aggregate: true,
            agent_id: Some("agent-a".to_string()),
            ..AggregateRecallParams::default()
        },
        AggregateRecallDeps {
            recall: Some(&recall),
            router: Some(&router),
            ..AggregateRecallDeps::default()
        },
    )
    .await
    .expect("synthesis failure result");

    let aggregate = result.aggregate.expect("aggregate metadata");
    assert_eq!(
        aggregate.stopped_reason,
        AggregateRecallStoppedReason::SynthesisFailed
    );
    assert_eq!(aggregate.source_memory_ids, vec!["mem-1"]);
    assert!(!aggregate.saved);
    assert!(result.results.is_empty());
}

#[tokio::test]
async fn save_policy_requires_global_evidence_and_savable_synthesis() {
    let conn = setup_conn();
    let mut private = row("private", "Private evidence");
    private.visibility = Some("private".to_string());
    let recall = StaticRecall::default().with("private history", vec![private]);
    let router = StaticRouter::default();
    let id = || "aggregate-private".to_string();

    let result = aggregate_recall(
        &conn,
        AggregateRecallParams {
            query: "private history".to_string(),
            aggregate: true,
            agent_id: Some("agent-a".to_string()),
            ..AggregateRecallParams::default()
        },
        AggregateRecallDeps {
            recall: Some(&recall),
            router: Some(&router),
            id_factory: Some(&id),
            ..AggregateRecallDeps::default()
        },
    )
    .await
    .expect("private aggregate result");
    let aggregate = result.aggregate.expect("aggregate metadata");
    assert_eq!(
        aggregate.stopped_reason,
        AggregateRecallStoppedReason::Complete
    );
    assert!(!aggregate.saved);
    assert_eq!(aggregate.saved_memory_id, None);
    assert!(result.results[0].id.ends_with(":unsaved"));
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE id = ?1",
            params!["aggregate-private"],
            |row| row.get(0),
        )
        .expect("count aggregate rows");
    assert_eq!(count, 0);

    let insufficient_recall =
        StaticRecall::default().with("favorite food", vec![row("mem-1", "Tea evidence")]);
    let insufficient_router = StaticRouter::with_synthesis(
        "There isn't enough evidence here to determine the favorite food.",
    );
    let insufficient = aggregate_recall(
        &conn,
        AggregateRecallParams {
            query: "favorite food".to_string(),
            aggregate: true,
            agent_id: Some("agent-a".to_string()),
            ..AggregateRecallParams::default()
        },
        AggregateRecallDeps {
            recall: Some(&insufficient_recall),
            router: Some(&insufficient_router),
            ..AggregateRecallDeps::default()
        },
    )
    .await
    .expect("insufficient aggregate result");
    let aggregate = insufficient.aggregate.expect("aggregate metadata");
    assert_eq!(
        aggregate.stopped_reason,
        AggregateRecallStoppedReason::Complete
    );
    assert!(!aggregate.saved);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM memory_hints", [], |row| row
            .get::<_, i64>(0))
            .expect("hint count"),
        0
    );
}

#[tokio::test]
async fn synthesized_recall_rows_are_not_evidence_sources() {
    let conn = setup_conn();
    let mut synthetic = row("summary:abc", "Synthetic summary should not be provenance");
    synthetic.source = "llm_summary".to_string();
    let recall = StaticRecall::default().with(
        "what happened",
        vec![synthetic, row("mem-1", "Real evidence")],
    );
    let router = StaticRouter::default();
    let now = || Utc.with_ymd_and_hms(2026, 5, 20, 12, 0, 0).unwrap();
    let id = || "aggregate-sources".to_string();

    let result = aggregate_recall(
        &conn,
        AggregateRecallParams {
            query: "what happened".to_string(),
            aggregate: true,
            agent_id: Some("agent-a".to_string()),
            ..AggregateRecallParams::default()
        },
        AggregateRecallDeps {
            recall: Some(&recall),
            router: Some(&router),
            now: Some(&now),
            id_factory: Some(&id),
            ..AggregateRecallDeps::default()
        },
    )
    .await
    .expect("aggregate result");

    assert_eq!(
        result
            .aggregate
            .expect("aggregate metadata")
            .source_memory_ids,
        vec!["mem-1"]
    );
    let links = conn
        .prepare(
            "SELECT source_memory_id FROM aggregate_memory_sources WHERE aggregate_memory_id = ?1 ORDER BY source_memory_id",
        )
        .expect("prepare links")
        .query_map(params!["aggregate-sources"], |row| row.get::<_, String>(0))
        .expect("query links")
        .collect::<Result<Vec<_>, _>>()
        .expect("read links");
    assert_eq!(links, vec!["mem-1"]);
}
