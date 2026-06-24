use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use signet_pipeline::native_memory_sources::{
    NativeMemorySyncOptions, NativeMemorySyncState, claude_code_native_memory_source,
    clear_native_memory_fingerprint_cache, codex_native_memory_source, index_native_memory_file,
    purge_native_memory_source_artifacts, remove_native_memory_file, safe_relative_path,
    sync_native_memory_sources,
};

fn setup_conn() -> Connection {
    clear_native_memory_fingerprint_cache();
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("run migrations");
    conn
}

fn temp_root(name: &str) -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "signet-native-sources-{name}-{}-{now}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).expect("create temp root");
    dir
}

fn write(path: &Path, body: &str) {
    fs::create_dir_all(path.parent().expect("file parent")).expect("create parent");
    fs::write(path, body).expect("write file");
}

fn artifact_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM memory_artifacts", [], |row| {
        row.get(0)
    })
    .expect("count artifacts")
}

#[test]
fn codex_patterns_index_external_artifacts_with_source_metadata() {
    // Ports the deterministic contract covered by
    // platform/daemon/src/native-memory-sources.test.ts:31, :54, :76, and :109.
    let conn = setup_conn();
    let dir = temp_root("codex-index");
    let root = dir.join(".codex");
    let skill = root.join("memories/skills/debugging/SKILL.md");
    let note = root.join("memories/extensions/ad_hoc/notes/2026-05-24-note.md");
    let rollout = root.join("memories/rollout_summaries/2026-05-24-run.jsonl");
    let automation = root.join("automations/obsidian-wiki/memory.md");
    write(&skill, "# Debugging\n\nUse repo truth first.\n");
    write(&note, "Remember the Codex note bridge.\n");
    write(
        &rollout,
        "{\"session_meta\":{\"payload\":{\"id\":\"019e5b4c-c317-74b0-bc52-a658b16e0f5d\"}}}\n{\"event\":\"done\"}\n",
    );
    write(
        &automation,
        "# Automation Memory\n\nThe Obsidian wiki automation processed agent-memory research.\n",
    );

    let source = codex_native_memory_source(&root);
    assert!(index_native_memory_file(&conn, &source, &skill, "agent-native").unwrap());
    assert!(index_native_memory_file(&conn, &source, &note, "agent-native").unwrap());
    assert!(index_native_memory_file(&conn, &source, &rollout, "agent-native").unwrap());
    assert!(index_native_memory_file(&conn, &source, &automation, "agent-native").unwrap());

    let rows = conn
        .prepare(
            "SELECT source_path, source_kind, harness, source_id, source_root,
                    source_external_id, source_parent_path, source_meta_json, content
             FROM memory_artifacts
             WHERE agent_id = 'agent-native'
             ORDER BY source_kind, source_path",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    let kinds = rows.iter().map(|row| row.1.as_str()).collect::<Vec<_>>();
    assert_eq!(
        kinds,
        vec![
            "native_ad_hoc_note",
            "native_automation_memory",
            "native_rollout_summary",
            "native_skill_memory",
        ]
    );
    assert!(rows.iter().all(|row| row.2 == "codex"));
    assert!(rows.iter().all(|row| {
        row.3
            .as_deref()
            .is_some_and(|id| id.starts_with("codex_native_memory:"))
    }));
    assert!(
        rows.iter()
            .all(|row| row.4.as_deref() == Some(root.to_str().unwrap()))
    );
    assert!(
        rows.iter()
            .any(|row| row.5.as_deref() == Some("memories/skills/debugging/SKILL.md"))
    );
    assert!(
        rows.iter()
            .any(|row| row.6.as_deref() == Some("memories/skills/debugging"))
    );

    let rollout_meta: serde_json::Value = rows
        .iter()
        .find(|row| row.1 == "native_rollout_summary")
        .and_then(|row| row.7.as_deref())
        .map(|raw| serde_json::from_str(raw).unwrap())
        .unwrap();
    assert_eq!(
        rollout_meta["rolloutId"],
        "019e5b4c-c317-74b0-bc52-a658b16e0f5d"
    );
    assert_eq!(rollout_meta["lineEnd"], 2);
    assert!(
        rows.iter()
            .any(|row| row.8.contains("Obsidian wiki automation"))
    );

    fs::remove_dir_all(dir).ok();
}

#[test]
fn rejects_symlinks_outside_roots_and_unknown_codex_patterns() {
    // Ports platform/daemon/src/native-memory-sources.test.ts:140, :501, and :510.
    let conn = setup_conn();
    let dir = temp_root("codex-reject");
    let root = dir.join(".codex");
    let outside = dir.join("outside.md");
    let link = root.join("memories/MEMORY.md");
    write(&outside, "Do not index through a symlink.\n");
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    make_symlink(&outside, &link);

    let source = codex_native_memory_source(&root);
    assert!(!index_native_memory_file(&conn, &source, &link, "agent-native").unwrap());
    assert_eq!(artifact_count(&conn), 0);

    let nested = root.join("automations/obsidian-wiki/nested/memory.md");
    write(&nested, "not a direct automation memory surface");
    assert!(!index_native_memory_file(&conn, &source, &nested, "agent-native").unwrap());

    let unknown = root.join("memories/notes.md");
    write(&unknown, "not a Codex native memory surface");
    assert!(!index_native_memory_file(&conn, &source, &unknown, "agent-native").unwrap());

    assert!(safe_relative_path(&root, dir.join("outside.md")).is_none());
    assert!(safe_relative_path(&root, root.join(".git/config.md")).is_none());
    assert_eq!(artifact_count(&conn), 0);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn claude_code_patterns_match_project_index_agent_and_session_memory() {
    // Ports platform/daemon/src/native-memory-sources.test.ts:153 and :176.
    let conn = setup_conn();
    let dir = temp_root("claude-index");
    let root = dir.join(".claude");
    let project = root.join("projects/repo/memory/project-note.md");
    let index = root.join("projects/repo/memory/MEMORY.md");
    let agent = root.join("agent-memory/builder/preference.md");
    let local = root.join("agent-memory-local/builder/local.md");
    let session = root.join("session-memory/2026-06-20/session.md");
    write(
        &project,
        "---\ntype: project\n---\n\nClaude remembered the native memdir contract.\n",
    );
    write(
        &index,
        "# Memory Index\n\n- [project] project-note.md: contract note\n",
    );
    write(
        &agent,
        "Builder agent prefers clean native memory bridges.\n",
    );
    write(&local, "Builder agent keeps local-only context.\n");
    write(
        &session,
        "Claude session memory preserves task continuity.\n",
    );

    let source = claude_code_native_memory_source(&root);
    for file in [&project, &index, &agent, &local, &session] {
        assert!(index_native_memory_file(&conn, &source, file, "agent-native").unwrap());
    }

    let rows = conn
        .prepare("SELECT source_kind, harness, source_id, source_root, source_external_id FROM memory_artifacts ORDER BY source_kind")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        rows.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
        vec![
            "native_claude_agent_memory",
            "native_claude_agent_memory_local",
            "native_claude_memory",
            "native_claude_memory_index",
            "native_claude_session_memory",
        ]
    );
    assert!(rows.iter().all(|row| row.1 == "claude-code"));
    assert!(
        rows.iter()
            .all(|row| row.2.is_none() && row.3.is_none() && row.4.is_none())
    );
    fs::remove_dir_all(dir).ok();
}

#[test]
fn dedupe_uses_content_hash_and_soft_deleted_rows_are_restored() {
    // Ports platform/daemon/src/native-memory-sources.test.ts:216, :268, :294, :315, and :336.
    let conn = setup_conn();
    let dir = temp_root("dedupe");
    let root = dir.join(".codex");
    let file = root.join("memories/memory_summary.md");
    write(&file, "Codex remembered alpha state.\n");
    let source = codex_native_memory_source(&root);

    assert!(index_native_memory_file(&conn, &source, &file, "agent-native").unwrap());
    assert!(!index_native_memory_file(&conn, &source, &file, "agent-native").unwrap());
    assert_eq!(artifact_count(&conn), 1);

    conn.execute(
        "DELETE FROM memory_artifacts WHERE agent_id = ?1 AND source_path = ?2",
        params!["agent-native", file.to_str().unwrap()],
    )
    .unwrap();
    assert!(index_native_memory_file(&conn, &source, &file, "agent-native").unwrap());
    assert_eq!(artifact_count(&conn), 1);

    write(&file, "Codex remembered bravo state.\n");
    assert!(index_native_memory_file(&conn, &source, &file, "agent-native").unwrap());
    let content: String = conn
        .query_row(
            "SELECT content FROM memory_artifacts WHERE agent_id = ?1 AND source_path = ?2",
            params!["agent-native", file.to_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(content.contains("bravo state"));

    remove_native_memory_file(&conn, &source, &file, "agent-native").unwrap();
    let deleted: i64 = conn
        .query_row(
            "SELECT is_deleted FROM memory_artifacts WHERE agent_id = ?1 AND source_path = ?2",
            params!["agent-native", file.to_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(deleted, 1);
    assert!(index_native_memory_file(&conn, &source, &file, "agent-native").unwrap());
    let restored: (i64, Option<String>) = conn
        .query_row(
            "SELECT is_deleted, deleted_at FROM memory_artifacts WHERE agent_id = ?1 AND source_path = ?2",
            params!["agent-native", file.to_str().unwrap()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(restored, (0, None));
    fs::remove_dir_all(dir).ok();
}

#[test]
fn sync_discovers_current_files_and_soft_deletes_stale_files_by_source_root() {
    // Ports platform/daemon/src/native-memory-sources.test.ts:397, :427, and :452.
    let conn = setup_conn();
    let dir = temp_root("sync-stale");
    let root_a = dir.join(".codex-a");
    let root_b = dir.join(".codex-b");
    let file_a = root_a.join("memories/memory_summary.md");
    let file_b = root_b.join("memories/memory_summary.md");
    write(&file_a, "Codex remembered source A.\n");
    write(&file_b, "Codex remembered source B.\n");
    let sources = vec![
        codex_native_memory_source(&root_a),
        codex_native_memory_source(&root_b),
    ];
    let mut state = NativeMemorySyncState::default();

    let first = sync_native_memory_sources(
        &conn,
        &sources,
        "agent-native",
        &mut state,
        NativeMemorySyncOptions::default(),
    )
    .unwrap();
    assert_eq!(first.changed, 2);
    assert_eq!(first.events.len(), 2);
    let second = sync_native_memory_sources(
        &conn,
        &sources,
        "agent-native",
        &mut state,
        NativeMemorySyncOptions::default(),
    )
    .unwrap();
    assert_eq!(second.changed, 0);

    fs::remove_file(&file_a).unwrap();
    let stale = sync_native_memory_sources(
        &conn,
        &sources,
        "agent-native",
        &mut state,
        NativeMemorySyncOptions::default(),
    )
    .unwrap();
    assert_eq!(stale.changed, 0);
    let rows = conn
        .prepare("SELECT source_path, is_deleted FROM memory_artifacts WHERE agent_id = ?1 ORDER BY source_path")
        .unwrap()
        .query_map(params!["agent-native"], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            (file_a.to_str().unwrap().to_string(), 1),
            (file_b.to_str().unwrap().to_string(), 0)
        ]
    );

    fs::remove_dir_all(&root_b).unwrap();
    sync_native_memory_sources(
        &conn,
        &sources,
        "agent-native",
        &mut state,
        NativeMemorySyncOptions::default(),
    )
    .unwrap();
    let deleted_b: i64 = conn
        .query_row(
            "SELECT is_deleted FROM memory_artifacts WHERE source_path = ?1",
            params![file_b.to_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(deleted_b, 1);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn purge_uses_source_id_or_bounded_root_prefix_without_sql_wildcards() {
    // Ports platform/daemon/src/native-memory-sources.test.ts:704 and :733 for Codex/Claude roots.
    let conn = setup_conn();
    let dir = temp_root("purge");
    let root = dir.join("claude_%");
    let sibling_root = dir.join("claude_AX");
    let file = root.join("agent-memory/builder/remove.md");
    let sibling = sibling_root.join("agent-memory/builder/keep.md");
    write(&file, "Remove only this Claude native memory.\n");
    write(&sibling, "Keep this sibling Claude native memory.\n");
    let source = claude_code_native_memory_source(&root);
    let sibling_source = claude_code_native_memory_source(&sibling_root);
    assert!(index_native_memory_file(&conn, &source, &file, "agent-native").unwrap());
    assert!(index_native_memory_file(&conn, &sibling_source, &sibling, "agent-native").unwrap());

    let purged =
        purge_native_memory_source_artifacts(&conn, &source, Some("agent-native")).unwrap();
    assert_eq!(purged, 1);
    let remaining: String = conn
        .query_row("SELECT source_path FROM memory_artifacts", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(remaining, sibling.to_str().unwrap());

    let other_agent = root.join("agent-memory/builder/other-agent.md");
    write(
        &other_agent,
        "Remove all agents when purge has no agent scope.\n",
    );
    assert!(index_native_memory_file(&conn, &source, &other_agent, "agent-b").unwrap());
    assert_eq!(
        purge_native_memory_source_artifacts(&conn, &source, None).unwrap(),
        1
    );
    let agent_b_row: Option<String> = conn
        .query_row(
            "SELECT source_path FROM memory_artifacts WHERE agent_id = 'agent-b'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    assert!(agent_b_row.is_none());
    fs::remove_dir_all(dir).ok();
}

#[cfg(unix)]
fn make_symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).expect("create symlink");
}

#[cfg(windows)]
fn make_symlink(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_file(target, link).expect("create symlink");
}
