//! Native skill filesystem reconciler parity.
//!
//! Ports the durable parts of `platform/daemon/src/pipeline/skill-reconciler.ts`:
//! scan `skills/*/SKILL.md`, parse frontmatter, install missing skill nodes,
//! update idempotently when the raw frontmatter fingerprint changes, clear
//! `uninstalled_at` during upsert, and hard-remove orphaned skill nodes.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use signet_core::config::PipelineV2Config;
use signet_core::queries::embedding::vector_to_blob;
use tracing::warn;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillFrontmatter {
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub author: Option<String>,
    pub license: Option<String>,
    pub triggers: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub permissions: Option<Vec<String>>,
    pub role: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSkillFile {
    pub frontmatter: SkillFrontmatter,
    pub body: String,
    pub raw_frontmatter: String,
}

#[derive(Debug, Clone)]
pub struct SkillInstallInput {
    pub frontmatter: SkillFrontmatter,
    pub body: String,
    pub source: String,
    pub fs_path: PathBuf,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillInstallResult {
    pub entity_id: String,
    pub enriched: bool,
    pub embedding_created: bool,
    pub entities_extracted: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillUninstallResult {
    pub removed: bool,
    pub entity_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkillReconcilerConfig {
    pub agent_id: String,
    pub importance_on_install: f64,
    pub decay_rate: f64,
}

impl Default for SkillReconcilerConfig {
    fn default() -> Self {
        Self {
            agent_id: "default".to_string(),
            importance_on_install: 0.7,
            decay_rate: 0.99,
        }
    }
}

impl From<&PipelineV2Config> for SkillReconcilerConfig {
    fn from(config: &PipelineV2Config) -> Self {
        Self {
            agent_id: "default".to_string(),
            importance_on_install: config.procedural.importance_on_install,
            decay_rate: config.procedural.decay_rate,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReconcileResult {
    pub installed: usize,
    pub updated: usize,
    pub removed: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum SkillReconcilerError {
    #[error("filesystem error: {0}")]
    Fs(#[from] std::io::Error),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, SkillReconcilerError>;

pub fn skills_dir(agents_dir: &Path) -> PathBuf {
    agents_dir.join("skills")
}

pub fn parse_skill_file(content: &str) -> Option<ParsedSkillFile> {
    let after_open = content.strip_prefix("---\n")?;
    let close = after_open
        .find("\n---\n")
        .or_else(|| after_open.find("\n---"))?;
    let raw_frontmatter = &after_open[..close];
    let body_start = close + "\n---".len();
    let body = after_open[body_start..]
        .strip_prefix('\n')
        .unwrap_or(&after_open[body_start..]);

    let data = serde_yml::from_str::<serde_yml::Value>(raw_frontmatter).ok()?;
    let frontmatter = SkillFrontmatter {
        name: string_field(&data, "name")
            .or_else(|| string_field(&data, "title"))
            .unwrap_or_default(),
        description: string_field(&data, "description").unwrap_or_default(),
        version: non_empty_string_field(&data, "version"),
        author: non_empty_string_field(&data, "author"),
        license: non_empty_string_field(&data, "license"),
        triggers: non_empty_string_array_field(&data, "triggers"),
        tags: non_empty_string_array_field(&data, "tags"),
        permissions: non_empty_string_array_field(&data, "permissions"),
        role: non_empty_string_field(&data, "role"),
    };

    Some(ParsedSkillFile {
        frontmatter,
        body: body.to_string(),
        raw_frontmatter: raw_frontmatter.to_string(),
    })
}

pub fn skill_entity_id(agent_id: &str, name: &str) -> String {
    format!("skill:{agent_id}:{name}")
}

pub fn skill_fingerprint(fm: &SkillFrontmatter) -> String {
    fn json_str(value: &str) -> String {
        serde_json::to_string(value).expect("string serialization cannot fail")
    }
    fn json_opt(value: Option<&String>) -> String {
        value.map_or_else(|| "null".to_string(), |s| json_str(s))
    }
    fn json_list(value: Option<&Vec<String>>) -> String {
        serde_json::to_string(value.map(Vec::as_slice).unwrap_or(&[]))
            .expect("list serialization cannot fail")
    }

    format!(
        "{{\"name\":{},\"description\":{},\"version\":{},\"author\":{},\"license\":{},\"triggers\":{},\"tags\":{},\"permissions\":{},\"role\":{}}}",
        json_str(&fm.name),
        json_str(&fm.description),
        json_opt(fm.version.as_ref()),
        json_opt(fm.author.as_ref()),
        json_opt(fm.license.as_ref()),
        json_list(fm.triggers.as_ref()),
        json_list(fm.tags.as_ref()),
        json_list(fm.permissions.as_ref()),
        json_opt(fm.role.as_ref()),
    )
}

pub fn skill_fingerprint_hash(fm: &SkillFrontmatter) -> String {
    content_hash(&skill_fingerprint(fm))
}

pub fn skill_embedding_hash(entity_id: &str, fm: &SkillFrontmatter) -> String {
    content_hash(&format!("{entity_id}\n{}", skill_fingerprint(fm)))
}

pub fn install_skill_node<F>(
    conn: &Connection,
    input: SkillInstallInput,
    config: &SkillReconcilerConfig,
    mut fetch_embedding: F,
) -> Result<SkillInstallResult>
where
    F: FnMut(&str) -> Option<Vec<f32>>,
{
    let agent_id = input.agent_id.as_deref().unwrap_or(&config.agent_id);
    let mut entity_id = skill_entity_id(agent_id, &input.frontmatter.name);
    let now = now_iso();
    let canonical_name = input.frontmatter.name.to_lowercase();
    let fs_path = input.fs_path.to_string_lossy().to_string();

    let existing = find_existing_entity(conn, &entity_id, &input.frontmatter.name, agent_id)?;
    if let Some(existing_id) = existing {
        entity_id = existing_id;
        conn.execute(
            "UPDATE entities SET entity_type = 'skill', description = ?1, updated_at = ?2 WHERE id = ?3",
            params![input.frontmatter.description, now, entity_id],
        )?;
    } else {
        let inserted = conn.execute(
            "INSERT INTO entities
             (id, name, canonical_name, entity_type, agent_id, description, mentions, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'skill', ?4, ?5, 0, ?6, ?6)",
            params![
                entity_id,
                input.frontmatter.name,
                canonical_name,
                agent_id,
                input.frontmatter.description,
                now
            ],
        );

        if let Err(err) = inserted {
            if !is_unique_constraint(&err) {
                return Err(err.into());
            }
            if let Some(collision_id) =
                find_entity_by_name(conn, &input.frontmatter.name, agent_id)?
            {
                entity_id = collision_id;
                conn.execute(
                    "UPDATE entities SET entity_type = 'skill', description = ?1, updated_at = ?2 WHERE id = ?3",
                    params![input.frontmatter.description, now, entity_id],
                )?;
            } else {
                return Err(err.into());
            }
        }
    }

    upsert_skill_meta(conn, &entity_id, agent_id, &input, config, &now, &fs_path)?;

    let mut embedding_created = false;
    let embedding_text = build_embedding_text(&input.frontmatter);
    if let Some(vector) = fetch_embedding(&embedding_text).filter(|vector| !vector.is_empty()) {
        upsert_skill_embedding(
            conn,
            &entity_id,
            agent_id,
            &input.frontmatter,
            &embedding_text,
            &vector,
            &now,
        )?;
        embedding_created = true;
    }

    Ok(SkillInstallResult {
        entity_id,
        enriched: false,
        embedding_created,
        entities_extracted: 0,
    })
}

pub fn uninstall_skill_node(
    conn: &Connection,
    skill_name: &str,
    agent_id: &str,
) -> Result<SkillUninstallResult> {
    let entity_id = skill_entity_id(agent_id, skill_name);
    let exists: Option<String> = conn
        .query_row(
            "SELECT id FROM entities WHERE id = ?1",
            params![entity_id],
            |row| row.get(0),
        )
        .optional()?;

    if exists.is_none() {
        return Ok(SkillUninstallResult {
            removed: false,
            entity_id: None,
        });
    }

    conn.execute(
        "DELETE FROM relations WHERE source_entity_id = ?1 OR target_entity_id = ?1",
        params![entity_id],
    )?;
    conn.execute(
        "DELETE FROM memory_entity_mentions WHERE entity_id = ?1",
        params![entity_id],
    )?;
    conn.execute(
        "DELETE FROM embeddings WHERE source_type = 'skill' AND source_id = ?1",
        params![entity_id],
    )?;
    conn.execute(
        "DELETE FROM skill_meta WHERE entity_id = ?1",
        params![entity_id],
    )?;
    conn.execute("DELETE FROM entities WHERE id = ?1", params![entity_id])?;

    Ok(SkillUninstallResult {
        removed: true,
        entity_id: Some(skill_entity_id(agent_id, skill_name)),
    })
}

pub fn reconcile_once<F>(
    conn: &Connection,
    agents_dir: &Path,
    config: &SkillReconcilerConfig,
    mut fetch_embedding: F,
) -> Result<ReconcileResult>
where
    F: FnMut(&str) -> Option<Vec<f32>>,
{
    let dir = skills_dir(agents_dir);
    let mut result = ReconcileResult {
        installed: 0,
        updated: 0,
        removed: 0,
    };

    if !dir.exists() {
        return Ok(result);
    }

    let mut disk_skills = HashMap::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let md_path = entry.path().join("SKILL.md");
        if md_path.exists() {
            disk_skills.insert(name, md_path);
        }
    }

    for (name, md_path) in &disk_skills {
        if let Err(err) = reconcile_disk_skill(
            conn,
            name,
            md_path,
            config,
            &mut fetch_embedding,
            &mut result,
        ) {
            warn!(skill = %name, error = %err, "failed to reconcile skill");
        }
    }

    let graph_skills = active_skill_meta(conn, &config.agent_id)?;
    for (entity_id, fs_path) in graph_skills {
        if !Path::new(&fs_path).exists() {
            let skill_name = entity_id.split(':').skip(2).collect::<Vec<_>>().join(":");
            if !skill_name.is_empty()
                && uninstall_skill_node(conn, &skill_name, &config.agent_id)?.removed
            {
                result.removed += 1;
            }
        }
    }

    Ok(result)
}

pub fn reconcile_skill<F>(
    conn: &Connection,
    skill_name: &str,
    md_path: &Path,
    config: &SkillReconcilerConfig,
    fetch_embedding: F,
) -> Result<bool>
where
    F: FnMut(&str) -> Option<Vec<f32>>,
{
    if !md_path.exists() {
        return Ok(uninstall_skill_node(conn, skill_name, &config.agent_id)?.removed);
    }

    let content = fs::read_to_string(md_path)?;
    let Some(parsed) = parse_skill_file(&content) else {
        return Ok(false);
    };

    let entity_id = skill_entity_id(&config.agent_id, skill_name);
    let lookup_id = find_existing_entity(conn, &entity_id, skill_name, &config.agent_id)?
        .unwrap_or_else(|| entity_id.clone());
    let raw_hash = skill_embedding_hash(&lookup_id, &parsed.frontmatter);
    let stored_hash = stored_skill_embedding_hash(conn, &lookup_id)?;
    if stored_hash.as_deref() == Some(raw_hash.as_str()) {
        return Ok(false);
    }

    install_skill_node(
        conn,
        SkillInstallInput {
            frontmatter: parsed.frontmatter,
            body: parsed.body,
            source: "reconciler".to_string(),
            fs_path: md_path.to_path_buf(),
            agent_id: Some(config.agent_id.clone()),
        },
        config,
        fetch_embedding,
    )?;
    Ok(true)
}

fn reconcile_disk_skill<F>(
    conn: &Connection,
    name: &str,
    md_path: &Path,
    config: &SkillReconcilerConfig,
    fetch_embedding: &mut F,
    result: &mut ReconcileResult,
) -> Result<()>
where
    F: FnMut(&str) -> Option<Vec<f32>>,
{
    let content = fs::read_to_string(md_path)?;
    let Some(parsed) = parse_skill_file(&content) else {
        return Ok(());
    };

    let entity_id = skill_entity_id(&config.agent_id, name);
    let existing = find_existing_entity(conn, &entity_id, name, &config.agent_id)?;
    if let Some(actual_id) = existing {
        let stored_hash = stored_skill_embedding_hash(conn, &actual_id)?;
        let raw_hash = skill_embedding_hash(&actual_id, &parsed.frontmatter);
        // TS parity (`skill-reconciler.ts:130-139`): only reinstall existing
        // skills when a stored skill embedding exists and its raw frontmatter
        // hash differs. This avoids loops after enrichment changed chunk_text.
        if stored_hash.as_deref().is_some_and(|hash| hash != raw_hash) {
            install_skill_node(
                conn,
                SkillInstallInput {
                    frontmatter: parsed.frontmatter,
                    body: parsed.body,
                    source: "reconciler".to_string(),
                    fs_path: md_path.to_path_buf(),
                    agent_id: Some(config.agent_id.clone()),
                },
                config,
                fetch_embedding,
            )?;
            result.updated += 1;
        }
    } else {
        install_skill_node(
            conn,
            SkillInstallInput {
                frontmatter: parsed.frontmatter,
                body: parsed.body,
                source: "reconciler".to_string(),
                fs_path: md_path.to_path_buf(),
                agent_id: Some(config.agent_id.clone()),
            },
            config,
            fetch_embedding,
        )?;
        result.installed += 1;
    }

    Ok(())
}

fn string_field(data: &serde_yml::Value, key: &str) -> Option<String> {
    let serde_yml::Value::Mapping(map) = data else {
        return None;
    };
    let key = serde_yml::Value::String(key.to_string());
    match map.get(&key) {
        Some(serde_yml::Value::String(value)) => Some(value.clone()),
        _ => None,
    }
}

fn non_empty_string_field(data: &serde_yml::Value, key: &str) -> Option<String> {
    string_field(data, key).filter(|value| !value.is_empty())
}

fn non_empty_string_array_field(data: &serde_yml::Value, key: &str) -> Option<Vec<String>> {
    let serde_yml::Value::Mapping(map) = data else {
        return None;
    };
    let key = serde_yml::Value::String(key.to_string());
    let values = match map.get(&key) {
        Some(serde_yml::Value::Sequence(items)) => items
            .iter()
            .filter_map(|item| match item {
                serde_yml::Value::String(value) => Some(value.clone()),
                _ => None,
            })
            .collect::<Vec<_>>(),
        Some(serde_yml::Value::String(value)) => value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn find_existing_entity(
    conn: &Connection,
    entity_id: &str,
    name: &str,
    agent_id: &str,
) -> Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM entities WHERE id = ?1 OR (name = ?2 AND agent_id = ?3)",
        params![entity_id, name, agent_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

fn find_entity_by_name(conn: &Connection, name: &str, agent_id: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM entities WHERE name = ?1 AND agent_id = ?2 LIMIT 1",
        params![name, agent_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

fn upsert_skill_meta(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
    input: &SkillInstallInput,
    config: &SkillReconcilerConfig,
    now: &str,
    fs_path: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO skill_meta
         (entity_id, agent_id, version, author, license, source,
          role, triggers, tags, permissions, enriched,
          installed_at, importance, decay_rate, fs_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?12, ?13, ?14)
         ON CONFLICT(entity_id) DO UPDATE SET
            version = excluded.version,
            author = excluded.author,
            license = excluded.license,
            source = excluded.source,
            role = excluded.role,
            triggers = excluded.triggers,
            tags = excluded.tags,
            permissions = excluded.permissions,
            enriched = excluded.enriched,
            fs_path = excluded.fs_path,
            uninstalled_at = NULL,
            updated_at = ?15",
        params![
            entity_id,
            agent_id,
            input.frontmatter.version.as_deref(),
            input.frontmatter.author.as_deref(),
            input.frontmatter.license.as_deref(),
            input.source,
            input.frontmatter.role.as_deref().unwrap_or("utility"),
            json_opt_vec(input.frontmatter.triggers.as_ref())?,
            json_opt_vec(input.frontmatter.tags.as_ref())?,
            json_opt_vec(input.frontmatter.permissions.as_ref())?,
            now,
            config.importance_on_install,
            config.decay_rate,
            fs_path,
            now,
        ],
    )?;
    Ok(())
}

fn upsert_skill_embedding(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
    frontmatter: &SkillFrontmatter,
    embedding_text: &str,
    vector: &[f32],
    now: &str,
) -> Result<()> {
    let old_ids = old_skill_embedding_ids(conn, entity_id)?;
    for id in &old_ids {
        delete_vec_row_if_present(conn, id)?;
    }
    conn.execute(
        "DELETE FROM embeddings WHERE source_type = 'skill' AND source_id = ?1",
        params![entity_id],
    )?;

    let emb_id = Uuid::new_v4().to_string();
    let emb_hash = skill_embedding_hash(entity_id, frontmatter);
    let blob = vector_to_blob(vector);
    conn.execute(
        "INSERT INTO embeddings
         (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
         VALUES (?1, ?2, ?3, ?4, 'skill', ?5, ?6, ?7, ?8)
         ON CONFLICT(content_hash) DO UPDATE SET
            vector = excluded.vector,
            dimensions = excluded.dimensions,
            source_id = excluded.source_id,
            chunk_text = excluded.chunk_text,
            agent_id = excluded.agent_id",
        params![
            emb_id,
            emb_hash,
            blob,
            vector.len() as i64,
            entity_id,
            embedding_text,
            now,
            agent_id,
        ],
    )?;
    Ok(())
}

fn stored_skill_embedding_hash(conn: &Connection, entity_id: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT content_hash FROM embeddings WHERE source_type = 'skill' AND source_id = ?1",
        params![entity_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

fn active_skill_meta(conn: &Connection, agent_id: &str) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT entity_id, fs_path FROM skill_meta WHERE agent_id = ?1 AND uninstalled_at IS NULL",
    )?;
    let rows = stmt.query_map(params![agent_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn old_skill_embedding_ids(conn: &Connection, entity_id: &str) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM embeddings WHERE source_type = 'skill' AND source_id = ?1")?;
    let rows = stmt.query_map(params![entity_id], |row| row.get(0))?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row?);
    }
    Ok(ids)
}

fn delete_vec_row_if_present(conn: &Connection, id: &str) -> Result<()> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = 'vec_embeddings'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_some() {
        conn.execute("DELETE FROM vec_embeddings WHERE id = ?1", params![id])?;
    }
    Ok(())
}

fn json_opt_vec(value: Option<&Vec<String>>) -> Result<Option<String>> {
    value
        .map(|items| serde_json::to_string(items).map_err(Into::into))
        .transpose()
}

fn build_embedding_text(fm: &SkillFrontmatter) -> String {
    let mut parts = vec![fm.name.clone()];
    if !fm.description.is_empty() {
        parts.push(fm.description.clone());
    }
    if let Some(triggers) = &fm.triggers {
        if !triggers.is_empty() {
            parts.push(triggers.join(", "));
        }
    }
    parts.join(" — ")
}

fn content_hash(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    hex[..16].to_string()
}

fn is_unique_constraint(err: &rusqlite::Error) -> bool {
    match err {
        rusqlite::Error::SqliteFailure(_, Some(message)) => message.contains("UNIQUE constraint"),
        _ => false,
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
