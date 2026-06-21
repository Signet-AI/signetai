use std::collections::VecDeque;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, params};
use signet_core::db::{DbPool, Priority};
use signet_core::queries::embedding::vector_to_blob;
use signet_pipeline::model_registry::{
    ModelRegistryEntry, ModelTier, get_available_models, get_models_by_provider,
    get_registry_status, mark_deprecated_versions,
};
use signet_pipeline::prospective_index::{build_prompt, parse_hints};
use signet_pipeline::provider::{
    GenerateOpts, GenerateResult, LlmProvider, LlmSemaphore, ProviderError,
};
use signet_pipeline::skill_enrichment::parse_enrichment_output;
use signet_pipeline::skill_reconciler::{
    ReconcileResult, SkillFrontmatter, SkillReconcilerConfig, reconcile_once, skill_embedding_hash,
    skill_entity_id,
};
use signet_pipeline::synthesis::{SynthesisConfig, start as start_synthesis_worker};
use signet_services::graph::get_graph_boost_ids;
use uuid::Uuid;

fn setup_conn() -> Connection {
    signet_core::db::register_vec_extension();
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::db::configure_pragmas_pub(&conn).expect("configure pragmas");
    signet_core::migrations::run(&conn).expect("run migrations");
    signet_core::db::ensure_fts_pub(&conn).expect("ensure fts");
    signet_core::db::ensure_vec_table_pub(&conn).expect("ensure vec table");
    conn
}

fn insert_graph_memory(
    conn: &Connection,
    entity_id: &str,
    name: &str,
    memory_id: &str,
    deleted: bool,
) {
    let now = "2026-06-20T00:00:00Z";
    conn.execute(
        "INSERT OR IGNORE INTO entities
         (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'extracted', 'default', 1, ?4, ?4)",
        params![entity_id, name, name.to_lowercase(), now],
    )
    .expect("insert graph entity");
    conn.execute(
        "INSERT OR IGNORE INTO memories
         (id, content, normalized_content, content_hash, type, agent_id, updated_by, created_at, updated_at, is_deleted)
         VALUES (?1, ?2, ?2, ?3, 'fact', 'default', 'test', ?4, ?4, ?5)",
        params![
            memory_id,
            format!("Memory about {name}"),
            format!("hash-{memory_id}"),
            now,
            if deleted { 1 } else { 0 }
        ],
    )
    .expect("insert graph memory");
    conn.execute(
        "INSERT OR IGNORE INTO memory_entity_mentions (memory_id, entity_id, confidence, created_at)
         VALUES (?1, ?2, 0.9, ?3)",
        params![memory_id, entity_id, now],
    )
    .expect("insert graph mention");
}

// Port of platform/daemon/src/pipeline/graph-search.test.ts:37-48,
// :50-69, and :86-107. The Rust graph-search primitive must return directly
// linked memories, include one-hop relation neighbors, and filter soft-deleted
// memories.
#[test]
fn graph_search_collects_direct_neighbor_memories_and_filters_deleted() {
    let conn = setup_conn();
    insert_graph_memory(&conn, "ent-react", "React", "mem-react", false);
    insert_graph_memory(&conn, "ent-jsx", "JSX", "mem-jsx", false);
    insert_graph_memory(&conn, "ent-deleted", "Deleted", "mem-deleted", true);
    conn.execute(
        "INSERT INTO relations
         (id, source_entity_id, target_entity_id, relation_type, strength, mentions, confidence, created_at)
         VALUES ('rel-react-jsx', 'ent-react', 'ent-jsx', 'uses', 1.0, 1, 0.9, '2026-06-20T00:00:00Z')",
        [],
    )
    .expect("insert graph relation");

    let direct = get_graph_boost_ids(&conn, "typescript react", 5_000);
    assert!(!direct.timed_out);
    assert_eq!(direct.entity_hits, 1);
    assert!(direct.linked_ids.contains("mem-react"));
    assert!(direct.linked_ids.contains("mem-jsx"));

    let deleted = get_graph_boost_ids(&conn, "deleted", 5_000);
    assert!(!deleted.linked_ids.contains("mem-deleted"));
    assert!(deleted.linked_ids.is_empty());

    let missing = get_graph_boost_ids(&conn, "nonexistent thing", 5_000);
    assert_eq!(missing.entity_hits, 0);
    assert!(missing.linked_ids.is_empty());
    assert!(!missing.timed_out);
}

struct ScriptedProvider {
    outputs: Mutex<VecDeque<String>>,
}

impl ScriptedProvider {
    fn new(outputs: Vec<String>) -> Self {
        Self {
            outputs: Mutex::new(outputs.into()),
        }
    }
}

impl LlmProvider for ScriptedProvider {
    fn generate(
        &self,
        _prompt: &str,
        _opts: &GenerateOpts,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<GenerateResult, ProviderError>> + Send + '_>>
    {
        let text = self
            .outputs
            .lock()
            .expect("scripted provider lock")
            .pop_front()
            .unwrap_or_else(|| {
                "Synthesis worker rendered MEMORY.md from existing summaries.".to_string()
            });
        Box::pin(async move { Ok(GenerateResult { text, usage: None }) })
    }

    fn name(&self) -> &str {
        "synthesis-tail-test"
    }
}

fn unique_db_path(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!("signet-{prefix}-{}.db", Uuid::new_v4()))
}

fn unique_root(prefix: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("signet-{prefix}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("create test root");
    root
}

// Port of platform/daemon/src/pipeline/synthesis-worker.test.ts:62. The TS
// test covers the worker runtime; Rust exposes the synthesis worker start hook,
// so this locks the observable daemon-rs behavior: completed summaries trigger
// deterministic MEMORY.md projection without changing production code.
#[tokio::test]
async fn synthesis_worker_renders_projection_from_existing_summaries() {
    let path = unique_db_path("synthesis-tail");
    let root = unique_root("synthesis-tail-root");
    let (pool, writer) = DbPool::open(&path).expect("open synthesis db");
    pool.write(Priority::High, |conn| {
        conn.execute(
            "INSERT INTO session_summaries (
                id, project, depth, kind, content, token_count, earliest_at, latest_at,
                session_key, harness, agent_id, source_type, source_ref, meta_json, created_at
             ) VALUES (
                'tail-summary-1', 'project-tail', 0, 'session',
                'Tail synthesis summary preserved daemon-rs MEMORY.md projection context.', 10,
                '2026-06-20T00:00:00Z', '2026-06-20T00:00:01Z', 'session-tail',
                'codex', 'default', 'summary', 'session-tail', '{}', '2026-06-20T00:00:01Z')",
            [],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .expect("seed synthesis summary");

    let handle = start_synthesis_worker(
        pool.clone(),
        Arc::new(ScriptedProvider::new(Vec::new())),
        Arc::new(LlmSemaphore::new(1)),
        SynthesisConfig {
            poll_ms: 5,
            min_interval_secs: 0,
            timeout_ms: 1_000,
            max_tokens: 1_024,
            agents_dir: root.display().to_string(),
        },
    );

    let projection = root.join("MEMORY.md");
    let mut rendered = String::new();
    for _ in 0..100 {
        if let Ok(content) = std::fs::read_to_string(&projection) {
            if content.contains("Tail synthesis summary") {
                rendered = content;
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    handle.stop().await;

    assert!(rendered.contains("Tail synthesis summary"));
    assert!(rendered.contains("project-tail"));

    drop(pool);
    writer.abort();
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_dir_all(root);
}

// platform/daemon/src/pipeline/contradiction.test.ts:17 documents semantic
// contradiction JSON extraction from prose/fences/trailing commas. Rust only
// exposes antonym/token primitives in signet-pipeline/src/antonyms.rs; no
// public JSON-from-prose contradiction parser exists to port.
#[test]
#[ignore = "gap: Rust has antonym primitives but no public contradiction JSON extraction module"]
fn gap_contradiction_json_from_prose_parser_missing() {}

// platform/daemon/src/pipeline/continuity-scoring.test.ts:114 documents the
// TS session continuity scoring schema and round trip. There is no Rust
// continuity-scoring module in signet-pipeline or signet-services.
#[test]
#[ignore = "gap: no Rust continuity-scoring module"]
fn gap_continuity_scoring_module_missing() {}

// platform/daemon/src/pipeline/dreaming-worker.test.ts:55 covers the TS
// dreaming worker runtime and manual trigger scoping. Rust has route/logic
// coverage elsewhere, but no exposed dreaming worker runtime equivalent.
#[test]
#[ignore = "gap: route/logic covered elsewhere; Rust dreaming worker runtime is not exposed"]
fn gap_dreaming_worker_runtime_missing() {}

// Port of platform/daemon/src/pipeline/model-registry.test.ts:5-43 and
// platform/core/src/llm-model-catalog.ts:21-69. The Rust static registry must
// preserve checked catalog entries, expose provider grouping/status, and avoid
// synthesizing deprecation from model names.
#[test]
fn model_registry_exposes_checked_static_catalog_without_synthesized_deprecation() {
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

    let status = get_registry_status();
    assert!(status.initialized);
    assert_eq!(status.last_refresh_at, 0);
    assert_eq!(status.model_counts["acpx"], 3);
    assert_eq!(status.model_counts["codex"], 6);

    let entries = vec![ModelRegistryEntry {
        id: "provider/known-older".to_string(),
        provider: "checked-provider".to_string(),
        label: "Known older".to_string(),
        tier: ModelTier::Mid,
        deprecated: false,
    }];
    let cloned = mark_deprecated_versions(&entries);
    assert_eq!(cloned, entries);
    assert_ne!(cloned.as_ptr(), entries.as_ptr());
}

// Port of platform/daemon/src/pipeline/prospective-index.ts:41-53 and
// prospective-index.test.ts:292-370. Rust hint generation must use the same
// prompt scaffold and line filtering for clean, think-tag, noisy, residue,
// numbered, empty, and too-short LLM outputs.
#[test]
fn prospective_index_builds_ts_prompt_and_filters_hint_lines() {
    let prompt = build_prompt("Caroline moved to Seattle", 5);
    assert!(prompt.contains("Given this fact stored in a personal memory system:"));
    assert!(prompt.contains("\"Caroline moved to Seattle\""));
    assert!(prompt.contains("Generate 5 diverse questions or cues"));
    assert!(prompt.ends_with("Return ONLY the questions, one per line. No numbering, no bullets."));

    let hints = parse_hints(
        "<think>\nI should generate diverse questions.\n</think>\n\
         1. Where does Caroline live now?\n\
         Let's craft diverse questions:\n\
         Who is Caroline's roommate in Seattle?\n\
         Short?\n\
         What model did Jake request for the iMessage agent on Apr 27?",
    );
    assert_eq!(
        hints,
        vec![
            "Where does Caroline live now?".to_string(),
            "Who is Caroline's roommate in Seattle?".to_string(),
            "What model did Jake request for the iMessage agent on Apr 27?".to_string(),
        ]
    );
}

// platform/daemon/src/pipeline/provider.test.ts:134 covers Bun/Node subprocess
// ACPX/ACP provider execution, environment/cwd safety, and process timeouts.
// That subprocess protocol is JS-runtime-specific and has no Rust equivalent.
#[test]
#[ignore = "skip: ACPX/ACP subprocess provider protocol is Bun/Node runtime-specific"]
fn skip_provider_acpx_acp_subprocess_protocol() {}

// platform/daemon/src/pipeline/rate-limit.test.ts:43 covers a TS token-bucket
// wrapper around generate/generateWithUsage. Rust has auth rate limiting, not
// this provider wrapper equivalent.
#[test]
#[ignore = "skip: TS provider token-bucket wrapper has no Rust equivalent"]
fn skip_provider_token_bucket_wrapper() {}

// platform/daemon/src/pipeline/reflection-worker.test.ts:104 covers TS
// reflection worker scheduling/source collection. Rust route shapes are covered
// elsewhere; no Rust reflection worker exists.
#[test]
#[ignore = "gap: no Rust reflection worker runtime"]
fn gap_reflection_worker_missing() {}

// platform/daemon/src/pipeline/reranker-llm.live.test.ts:62 is a live Ollama
// smoke test. daemon-rs unit parity should not depend on a live Ollama server.
#[test]
#[ignore = "skip: live Ollama reranker smoke has external runtime dependency"]
fn skip_reranker_llm_live_ollama() {}

// Port of platform/daemon/src/pipeline/skill-enrichment.test.ts:17-79.
// Rust enrichment parsing must accept prose/fenced JSON, tolerate trailing
// commas, and prefer the final balanced object over earlier examples.
#[test]
fn skill_enrichment_parser_matches_ts_json_extraction() {
    let prose = parse_enrichment_output(
        "We need to output JSON only.\n\n{\"description\":\"Best practices for Remotion video creation and dynamic media generation.\",\"triggers\":[\"build remotion animation\",\"make video composition\"],\"tags\":[\"video\",\"animation\"]}",
    )
    .expect("parse prose wrapped JSON");
    assert!(prose.description.contains("Remotion"));
    assert!(
        prose
            .triggers
            .contains(&"build remotion animation".to_string())
    );
    assert!(prose.tags.contains(&"video".to_string()));

    let fenced = parse_enrichment_output(
        r#"```json
{
  "description": "Guidance for creating and optimizing Remotion compositions.",
  "triggers": ["render remotion videos", "optimize remotion compositions",],
  "tags": ["video", "performance",]
}
```"#,
    )
    .expect("parse fenced trailing comma JSON");
    assert_eq!(fenced.triggers.len(), 2);
    assert!(fenced.tags.contains(&"performance".to_string()));

    let final_object = parse_enrichment_output(
        "Example: {\"description\":\"\",\"triggers\":[],\"tags\":[]}\nFinal: {\"description\":\"Practical guidance for producing Remotion compositions with reusable patterns.\",\"triggers\":[\"build remotion video\"],\"tags\":[\"video\"]}",
    )
    .expect("parse final enrichment object");
    assert!(final_object.description.contains("Remotion"));
    assert!(
        final_object
            .triggers
            .contains(&"build remotion video".to_string())
    );
}

// Port of platform/daemon/src/pipeline/skill-reconciler.test.ts:54-121.
// The Rust reconciler must not loop after install-time enrichment changes only
// the stored embedding text while the raw frontmatter hash remains unchanged.
#[test]
fn skill_reconciler_does_not_loop_after_enriched_embedding_text() {
    let conn = setup_conn();
    let root = unique_root("skill-tail-root");
    let skill = "loop-skill";
    let skill_dir = root.join("skills").join(skill);
    std::fs::create_dir_all(&skill_dir).expect("create skill dir");
    let file = skill_dir.join("SKILL.md");
    std::fs::write(
        &file,
        "---\nname: loop-skill\ndescription: tiny\n---\nthis skill helps with reconciliation loop debugging and metadata enrichment.",
    )
    .expect("write skill file");

    let fm = SkillFrontmatter {
        name: skill.to_string(),
        description: "tiny".to_string(),
        version: None,
        author: None,
        license: None,
        triggers: None,
        tags: None,
        permissions: None,
        role: None,
    };
    let entity_id = skill_entity_id("default", skill);
    let hash = skill_embedding_hash(&entity_id, &fm);
    conn.execute(
        "INSERT INTO entities
         (id, name, canonical_name, entity_type, agent_id, description, mentions, created_at, updated_at)
         VALUES (?1, ?2, ?2, 'skill', 'default', ?3, 0, '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z')",
        params![entity_id, skill, fm.description],
    )
    .expect("insert skill entity");
    conn.execute(
        "INSERT INTO skill_meta (entity_id, agent_id, source, role, installed_at, fs_path)
         VALUES (?1, 'default', 'reconciler', 'utility', '2026-06-20T00:00:00.000Z', ?2)",
        params![entity_id, file.to_string_lossy()],
    )
    .expect("insert skill meta");
    conn.execute(
        "INSERT INTO embeddings
         (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
         VALUES ('emb-loop-tail', ?1, ?2, 3, 'skill', ?3, ?4, '2026-06-20T00:00:00.000Z', 'default')",
        params![
            hash,
            vector_to_blob(&[0.1_f32, 0.2, 0.3]),
            entity_id,
            "loop-skill — debug a reconciliation loop in signet and inspect skill metadata drift",
        ],
    )
    .expect("insert enriched embedding");

    let pass = reconcile_once(&conn, &root, &SkillReconcilerConfig::default(), |_| {
        panic!("reconcile_once should not reinstall unchanged enriched skills")
    })
    .expect("reconcile unchanged skill");

    assert_eq!(
        pass,
        ReconcileResult {
            installed: 0,
            updated: 0,
            removed: 0,
        }
    );
    std::fs::remove_dir_all(root).ok();
}

// platform/daemon/src/pipeline/structured-evidence.test.ts:4 and
// structured-path-evidence.test.ts:11 cover structured evidence ranking boosts.
// Rust recall shaping APIs are private/internal here, so no direct port is
// available from signet-pipeline integration tests.
#[test]
#[ignore = "gap: structured evidence ranking APIs are private/internal in Rust"]
fn gap_structured_evidence_private_apis() {}
