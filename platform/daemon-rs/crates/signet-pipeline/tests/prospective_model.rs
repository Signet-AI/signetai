use std::future::Future;
use std::pin::Pin;

use rusqlite::Connection;
use signet_pipeline::model_registry::{
    ModelRegistryEntry, get_available_models, get_models_by_provider, get_registry_status,
    mark_deprecated_versions,
};
use signet_pipeline::prospective_index::{
    HintGenerationConfig, HintJobOutcome, build_prompt, enqueue_hints_job, generate_hints,
    parse_hints, process_next_hint_job,
};
use signet_pipeline::provider::{GenerateOpts, GenerateResult, LlmProvider, ProviderError};

struct StaticProvider {
    text: &'static str,
    fail: bool,
}

impl StaticProvider {
    fn ok(text: &'static str) -> Self {
        Self { text, fail: false }
    }

    fn err() -> Self {
        Self {
            text: "",
            fail: true,
        }
    }
}

impl LlmProvider for StaticProvider {
    fn generate(
        &self,
        _prompt: &str,
        _opts: &GenerateOpts,
    ) -> Pin<Box<dyn Future<Output = Result<GenerateResult, ProviderError>> + Send + '_>> {
        Box::pin(async move {
            if self.fail {
                Err(ProviderError::Other(
                    "Ollama timeout after 30000ms".to_string(),
                ))
            } else {
                Ok(GenerateResult {
                    text: self.text.to_string(),
                    usage: None,
                })
            }
        })
    }

    fn name(&self) -> &str {
        "static-test"
    }
}

fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open sqlite");
    conn.execute_batch(
        r#"
        CREATE TABLE memory_jobs (
            id TEXT PRIMARY KEY,
            memory_id TEXT,
            job_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            payload TEXT,
            result TEXT,
            attempts INTEGER DEFAULT 0,
            max_attempts INTEGER DEFAULT 3,
            leased_at TEXT,
            completed_at TEXT,
            failed_at TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE memory_hints (
            id TEXT PRIMARY KEY,
            memory_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            hint TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(memory_id, hint)
        );
        CREATE VIRTUAL TABLE memory_hints_fts USING fts5(
            hint,
            content='memory_hints', content_rowid='rowid'
        );
        CREATE TRIGGER memory_hints_fts_ai AFTER INSERT ON memory_hints BEGIN
            INSERT INTO memory_hints_fts(rowid, hint) VALUES (new.rowid, new.hint);
        END;
        "#,
    )
    .expect("create schema");
    conn
}

#[test]
fn prompt_matches_ts_scaffold() {
    // TS source: platform/daemon/src/pipeline/prospective-index.ts:41-53.
    let prompt = build_prompt("Caroline moved to Seattle", 5);
    assert!(prompt.contains("Given this fact stored in a personal memory system:"));
    assert!(prompt.contains("\"Caroline moved to Seattle\""));
    assert!(prompt.contains("Generate 5 diverse questions or cues"));
    assert!(prompt.ends_with("Return ONLY the questions, one per line. No numbering, no bullets."));
}

#[test]
fn parses_and_filters_llm_lines_like_ts_tests() {
    // TS expectations: prospective-index.test.ts:292-347.
    let clean = parse_hints(
        "Where does Caroline live now?\n\
         When did Caroline move to Seattle?\n\
         Who helped Caroline with the move?\n\
         Tell me about Caroline's relocation\n\
         Did Caroline leave Portland?",
    );
    assert_eq!(clean.len(), 5);
    assert_eq!(clean[0], "Where does Caroline live now?");
    assert_eq!(clean[4], "Did Caroline leave Portland?");

    let thinking = parse_hints(
        "<think>\nThe user stored a fact.\nI should generate diverse questions.\n</think>\n\
         Where does Caroline live now?\n\
         When did Caroline relocate from Portland?\n\
         Tell me about Caroline's move to Seattle",
    );
    assert_eq!(thinking.len(), 3);
    assert!(thinking.contains(&"Tell me about Caroline's move to Seattle".to_string()));
    assert!(
        thinking
            .iter()
            .all(|hint| !hint.contains("I should generate"))
    );

    let noisy = parse_hints(
        "We are given the fact about Caroline moving.\n\
         Let's craft diverse questions:\n\
         Make sure each is distinct.\n\
         Where does Caroline live now?\n\
         The third should be relational:\n\
         Who is Caroline's roommate in Seattle?\n\
         When did Caroline move to Seattle?\n\
         Now for conversational cues:\n\
         Tell me about Caroline's relocation from Portland",
    );
    assert_eq!(noisy.len(), 4);
    assert!(noisy.contains(&"Who is Caroline's roommate in Seattle?".to_string()));
    assert!(
        noisy
            .iter()
            .all(|hint| !hint.contains("Let's craft") && !hint.contains("Make sure"))
    );

    let residue = parse_hints(
        "Who requested: Jake\n\
         When: Apr 27\n\
         However, the problem says: 5 diverse questions or cues\n\
         But note: the fact says Jake requested this on Apr 27\n\
         Alternatively, ask about the connection\n\
         We need to be diverse and avoid repeating the same type.\n\
         When did Jake switch the iMessage agent model from GLM 5.1 to gpt-5.5?\n\
         What model did Jake request for the iMessage agent on Apr 27?",
    );
    assert_eq!(
        residue,
        vec![
            "When did Jake switch the iMessage agent model from GLM 5.1 to gpt-5.5?",
            "What model did Jake request for the iMessage agent on Apr 27?",
        ]
    );

    let numbered = parse_hints(
        "1. Where does Caroline live?\n\
         2) When did she move?\n\
         3. Who helped with the move?\n\
         - Tell me about Caroline's new city\n\
         * Has Caroline settled in Seattle?",
    );
    assert_eq!(
        numbered,
        vec![
            "Where does Caroline live?",
            "When did she move?",
            "Who helped with the move?",
            "Tell me about Caroline's new city",
            "Has Caroline settled in Seattle?",
        ]
    );

    assert_eq!(parse_hints(""), Vec::<String>::new());
    assert_eq!(
        parse_hints("Short?\nWhere does Caroline live now?"),
        vec!["Where does Caroline live now?"]
    );
}

#[tokio::test]
async fn generate_hints_propagates_provider_errors() {
    // TS expectation: prospective-index.test.ts:354-356.
    let err = generate_hints(
        &StaticProvider::err(),
        "test",
        HintGenerationConfig::default(),
    )
    .await
    .expect_err("provider error should propagate");
    assert!(err.to_string().contains("Ollama timeout"));
}

#[tokio::test]
async fn enqueue_and_process_job_writes_deduped_hints_and_fts() {
    // TS source: prospective-index.ts:180-192 and 235-249; tests at
    // prospective-index.test.ts:365-437 and 456-477.
    let conn = test_conn();
    enqueue_hints_job(
        &conn,
        "memory-1",
        "Caroline moved from Portland to Seattle in 2019",
    )
    .expect("enqueue");

    let status: String = conn
        .query_row(
            "SELECT status FROM memory_jobs WHERE memory_id = 'memory-1'",
            [],
            |row| row.get(0),
        )
        .expect("job status");
    assert_eq!(status, "pending");

    let provider = StaticProvider::ok(
        "Where does Caroline live now?\n\
         When did Caroline move to Seattle?\n\
         Who helped Caroline with the move?\n\
         Tell me about Caroline's relocation\n\
         Did Caroline leave Portland?",
    );
    let outcome =
        process_next_hint_job(&conn, &provider, HintGenerationConfig::default(), "default")
            .await
            .expect("process job");
    assert_eq!(
        outcome,
        HintJobOutcome::Completed {
            memory_id: "memory-1".to_string(),
            hints: 5
        }
    );

    let completed: String = conn
        .query_row(
            "SELECT status FROM memory_jobs WHERE memory_id = 'memory-1'",
            [],
            |row| row.get(0),
        )
        .expect("completed status");
    assert_eq!(completed, "completed");

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_hints WHERE memory_id = 'memory-1'",
            [],
            |row| row.get(0),
        )
        .expect("hint count");
    assert_eq!(count, 5);

    enqueue_hints_job(
        &conn,
        "memory-1",
        "Caroline moved from Portland to Seattle in 2019",
    )
    .expect("enqueue duplicate");
    let outcome =
        process_next_hint_job(&conn, &provider, HintGenerationConfig::default(), "default")
            .await
            .expect("process duplicate job");
    assert!(matches!(
        outcome,
        HintJobOutcome::Completed { hints: 5, .. }
    ));
    let deduped: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_hints WHERE memory_id = 'memory-1'",
            [],
            |row| row.get(0),
        )
        .expect("deduped count");
    assert_eq!(deduped, 5);

    let fts_hit: String = conn
        .query_row(
            "SELECT h.memory_id
             FROM memory_hints_fts f
             JOIN memory_hints h ON h.rowid = f.rowid
             WHERE memory_hints_fts MATCH '\"Caroline\" \"live\"'",
            [],
            |row| row.get(0),
        )
        .expect("fts hit");
    assert_eq!(fts_hit, "memory-1");
}

#[tokio::test]
async fn throwing_job_requeues_with_failed_at() {
    // TS expectation: prospective-index.test.ts:479-502.
    let conn = test_conn();
    enqueue_hints_job(&conn, "memory-2", "test content").expect("enqueue");

    let outcome = process_next_hint_job(
        &conn,
        &StaticProvider::err(),
        HintGenerationConfig::default(),
        "default",
    )
    .await
    .expect("process throwing job");
    assert!(matches!(outcome, HintJobOutcome::Failed { .. }));

    let (status, attempts, failed_at): (String, i64, Option<String>) = conn
        .query_row(
            "SELECT status, attempts, failed_at FROM memory_jobs WHERE memory_id = 'memory-2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("failed job row");
    assert_eq!(status, "pending");
    assert_eq!(attempts, 1);
    assert!(failed_at.is_some());
}

#[test]
fn model_registry_matches_static_ts_catalog() {
    // TS source: model-registry.ts:13-61 and llm-model-catalog.ts:21-76.
    let acpx: Vec<_> = get_available_models(Some("acpx"), false)
        .into_iter()
        .map(|model| model.id)
        .collect();
    assert!(acpx.contains(&"gpt-5.4-mini".to_string()));
    assert!(acpx.contains(&"haiku".to_string()));
    assert!(acpx.contains(&"google/gemini-2.5-flash".to_string()));
    assert!(!acpx.contains(&"gpt-5-codex".to_string()));
    assert!(!acpx.contains(&"gpt-5-codex-mini".to_string()));

    let by_provider = get_models_by_provider();
    let codex: Vec<_> = by_provider["codex"]
        .iter()
        .map(|model| model.id.as_str())
        .collect();
    assert_eq!(
        codex,
        vec![
            "gpt-5.4-mini",
            "gpt-5.4",
            "gpt-5.5",
            "gpt-5.3-codex",
            "gpt-5.3-codex-spark",
            "gpt-5.2",
        ]
    );
    assert_eq!(
        get_available_models(Some("constructor"), false),
        Vec::<ModelRegistryEntry>::new()
    );

    let status = get_registry_status();
    assert!(status.initialized);
    assert_eq!(status.last_refresh_at, 0);
    assert_eq!(status.model_counts["acpx"], 3);
    assert_eq!(status.model_counts["codex"], 6);

    let entries = vec![ModelRegistryEntry {
        id: "provider/known-older".to_string(),
        provider: "checked-provider".to_string(),
        label: "Known older".to_string(),
        tier: signet_pipeline::model_registry::ModelTier::Mid,
        deprecated: false,
    }];
    let cloned = mark_deprecated_versions(&entries);
    assert_eq!(cloned, entries);
    assert_ne!(cloned.as_ptr(), entries.as_ptr());
}
