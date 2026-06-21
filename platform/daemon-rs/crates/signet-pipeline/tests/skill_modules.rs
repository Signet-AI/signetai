use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use signet_core::queries::embedding::vector_to_blob;
use signet_pipeline::skill_enrichment::parse_enrichment_output;
use signet_pipeline::skill_reconciler::{
    ReconcileResult, SkillFrontmatter, SkillInstallInput, SkillReconcilerConfig,
    install_skill_node, reconcile_once, skill_embedding_hash, skill_entity_id,
};
use uuid::Uuid;

fn setup_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("run migrations");
    conn
}

fn temp_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("signet-skill-modules-{name}-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create temp root");
    root
}

fn write_skill(root: &Path, skill: &str, frontmatter: &str, body: &str) -> PathBuf {
    let dir = root.join("skills").join(skill);
    fs::create_dir_all(&dir).expect("create skill dir");
    let file = dir.join("SKILL.md");
    fs::write(&file, format!("---\n{frontmatter}\n---\n{body}")).expect("write skill file");
    file
}

fn query_string(conn: &Connection, sql: &str, value: &str) -> Option<String> {
    conn.query_row(sql, params![value], |row| row.get(0))
        .optional()
        .expect("query string")
}

fn query_nullable_string(conn: &Connection, sql: &str, value: &str) -> Option<String> {
    conn.query_row(sql, params![value], |row| row.get::<_, Option<String>>(0))
        .optional()
        .expect("query nullable string")
        .flatten()
}

// Port of platform/daemon/src/pipeline/skill-enrichment.test.ts:18-61.
#[test]
fn enrichment_parser_accepts_prose_fences_trailing_commas_and_prefers_final_object() {
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
#[test]
fn reconciler_does_not_loop_when_enriched_embedding_text_differs_from_raw_frontmatter_hash() {
    let conn = setup_conn();
    let root = temp_root("no-loop");
    let skill = "loop-skill";
    let file = write_skill(
        &root,
        skill,
        "name: loop-skill\ndescription: tiny",
        "this skill helps with reconciliation loop debugging and metadata enrichment.",
    );
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
    .expect("insert entity");
    conn.execute(
        "INSERT INTO skill_meta (entity_id, agent_id, source, role, installed_at, fs_path)
         VALUES (?1, 'default', 'reconciler', 'utility', '2026-06-20T00:00:00.000Z', ?2)",
        params![entity_id, file.to_string_lossy()],
    )
    .expect("insert skill meta");
    conn.execute(
        "INSERT INTO embeddings
         (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
         VALUES ('emb-loop', ?1, ?2, 3, 'skill', ?3, ?4, '2026-06-20T00:00:00.000Z', 'default')",
        params![
            hash,
            vector_to_blob(&[0.1_f32, 0.2, 0.3]),
            entity_id,
            "loop-skill — debug a reconciliation loop in signet and inspect skill metadata drift",
        ],
    )
    .expect("insert embedding");

    let pass = reconcile_once(&conn, &root, &SkillReconcilerConfig::default(), |_| {
        panic!("reconcile_once should not reinstall unchanged enriched skills")
    })
    .expect("reconcile");

    assert_eq!(
        pass,
        ReconcileResult {
            installed: 0,
            updated: 0,
            removed: 0
        }
    );
    fs::remove_dir_all(root).ok();
}

// Port of platform/daemon/src/pipeline/skill-reconciler.test.ts:123-205.
#[test]
fn reconciler_updates_when_frontmatter_metadata_changes_and_keeps_hash_stable() {
    let conn = setup_conn();
    let root = temp_root("metadata-drift");
    let skill = "meta-skill";
    let file = write_skill(
        &root,
        skill,
        "name: meta-skill\ndescription: metadata drift test\nversion: 1.0.0\nauthor: nicholai",
        "this skill helps verify metadata reconciliation.",
    );
    let raw = SkillFrontmatter {
        name: skill.to_string(),
        description: "metadata drift test".to_string(),
        version: Some("1.0.0".to_string()),
        author: Some("nicholai".to_string()),
        license: None,
        triggers: None,
        tags: None,
        permissions: None,
        role: None,
    };

    let first = install_skill_node(
        &conn,
        SkillInstallInput {
            frontmatter: raw.clone(),
            body: "this skill helps verify metadata reconciliation.".to_string(),
            source: "reconciler".to_string(),
            fs_path: file.clone(),
            agent_id: None,
        },
        &SkillReconcilerConfig::default(),
        |_| Some(vec![0.1, 0.2, 0.3]),
    )
    .expect("initial install");
    assert_eq!(
        query_string(
            &conn,
            "SELECT content_hash FROM embeddings WHERE source_type = 'skill' AND source_id = ?1",
            &first.entity_id,
        )
        .as_deref(),
        Some(skill_embedding_hash(&first.entity_id, &raw).as_str())
    );

    fs::write(
        &file,
        "---\nname: meta-skill\ndescription: metadata drift test\nversion: 1.0.1\nauthor: nicholai\n---\nthis skill helps verify metadata reconciliation.",
    )
    .expect("rewrite skill file");

    let mut calls = 0;
    let pass = reconcile_once(&conn, &root, &SkillReconcilerConfig::default(), |_| {
        calls += 1;
        Some(vec![0.4, 0.5, 0.6])
    })
    .expect("reconcile metadata drift");

    assert_eq!(
        pass,
        ReconcileResult {
            installed: 0,
            updated: 1,
            removed: 0
        }
    );
    assert_eq!(calls, 1);
    let expected = SkillFrontmatter {
        version: Some("1.0.1".to_string()),
        ..raw
    };
    assert_eq!(
        query_string(
            &conn,
            "SELECT content_hash FROM embeddings WHERE source_type = 'skill' AND source_id = ?1",
            &first.entity_id,
        )
        .as_deref(),
        Some(skill_embedding_hash(&first.entity_id, &expected).as_str())
    );
    fs::remove_dir_all(root).ok();
}

#[test]
fn reconciler_upsert_clears_uninstalled_at_for_existing_skill_meta_rows() {
    let conn = setup_conn();
    let root = temp_root("uninstalled-clear");
    let skill = "restore-skill";
    let file = write_skill(
        &root,
        skill,
        "name: restore-skill\ndescription: restore deleted metadata\nversion: 2.0.0",
        "this skill verifies uninstalled_at clearing during reconciliation.",
    );
    let entity_id = skill_entity_id("default", skill);
    conn.execute(
        "INSERT INTO entities
         (id, name, canonical_name, entity_type, agent_id, description, mentions, created_at, updated_at)
         VALUES (?1, ?2, ?2, 'skill', 'default', 'old', 0, '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z')",
        params![entity_id, skill],
    )
    .expect("insert entity");
    conn.execute(
        "INSERT INTO skill_meta
         (entity_id, agent_id, source, role, installed_at, fs_path, uninstalled_at)
         VALUES (?1, 'default', 'reconciler', 'utility', '2026-06-20T00:00:00.000Z', ?2, '2026-06-20T00:01:00.000Z')",
        params![entity_id, file.to_string_lossy()],
    )
    .expect("insert uninstalled skill meta");
    conn.execute(
        "INSERT INTO embeddings
         (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
         VALUES ('emb-restore', 'stale-hash', ?1, 3, 'skill', ?2, 'old', '2026-06-20T00:00:00.000Z', 'default')",
        params![vector_to_blob(&[0.0_f32, 0.0, 1.0]), entity_id],
    )
    .expect("insert stale embedding");

    let pass = reconcile_once(&conn, &root, &SkillReconcilerConfig::default(), |_| {
        Some(vec![0.7, 0.8, 0.9])
    })
    .expect("reconcile restore");

    assert_eq!(pass.updated, 1);
    let uninstalled_at = query_nullable_string(
        &conn,
        "SELECT uninstalled_at FROM skill_meta WHERE entity_id = ?1",
        &entity_id,
    );
    assert_eq!(uninstalled_at, None);
    fs::remove_dir_all(root).ok();
}
