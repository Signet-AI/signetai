//! Temporal summary expansion parity for the TS daemon.
//!
//! Port of `platform/daemon/src/temporal-expand.ts`: the Rust API reads one
//! temporal/session summary node, its DAG parents/children, linked memories,
//! and optional transcript context using the same agent/project gates.

use rusqlite::{Connection, OptionalExtension, params};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemporalExpandOptions<'a> {
    pub include_transcript: bool,
    pub project: Option<&'a str>,
    pub transcript_char_limit: Option<usize>,
}

impl<'a> Default for TemporalExpandOptions<'a> {
    fn default() -> Self {
        Self {
            include_transcript: true,
            project: None,
            transcript_char_limit: None,
        }
    }
}

pub type TemporalExpansionConfig<'a> = TemporalExpandOptions<'a>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemporalExpandNode {
    pub id: String,
    pub project: Option<String>,
    pub depth: i64,
    pub kind: String,
    pub content: String,
    pub token_count: Option<i64>,
    pub earliest_at: String,
    pub latest_at: String,
    pub session_key: Option<String>,
    pub harness: Option<String>,
    pub agent_id: String,
    pub source_type: Option<String>,
    pub source_ref: Option<String>,
    pub meta_json: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemporalExpandMemory {
    pub id: String,
    pub content: String,
    pub memory_type: String,
    pub created_at: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemporalExpandTranscript {
    pub session_key: String,
    pub harness: Option<String>,
    pub project: Option<String>,
    pub updated_at: String,
    pub excerpt: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemporalExpandResult {
    pub node: TemporalExpandNode,
    pub parents: Vec<TemporalExpandNode>,
    pub children: Vec<TemporalExpandNode>,
    pub linked_memories: Vec<TemporalExpandMemory>,
    pub transcript: Option<TemporalExpandTranscript>,
}

pub fn expand_temporal_node(
    conn: &Connection,
    id: &str,
    agent_id: &str,
    opts: TemporalExpandOptions<'_>,
) -> rusqlite::Result<Option<TemporalExpandResult>> {
    if !table_exists(conn, "session_summaries")? {
        return Ok(None);
    }

    let project = opts.project.filter(|value| !value.is_empty());
    let node = query_node(
        conn,
        "SELECT id, project, depth, kind, content, token_count,
                earliest_at, latest_at, session_key, harness, agent_id,
                source_type, source_ref, meta_json, created_at
         FROM session_summaries
         WHERE id = ?1 AND agent_id = ?2",
        "SELECT id, project, depth, kind, content, token_count,
                earliest_at, latest_at, session_key, harness, agent_id,
                source_type, source_ref, meta_json, created_at
         FROM session_summaries
         WHERE id = ?1 AND agent_id = ?2 AND project = ?3",
        id,
        agent_id,
        project,
    )?;
    let Some(node) = node else {
        return Ok(None);
    };

    let parents = query_nodes(
        conn,
        "SELECT ss.id, ss.project, ss.depth, ss.kind, ss.content, ss.token_count,
                ss.earliest_at, ss.latest_at, ss.session_key, ss.harness, ss.agent_id,
                ss.source_type, ss.source_ref, ss.meta_json, ss.created_at
         FROM session_summary_children rel
         JOIN session_summaries ss ON ss.id = rel.parent_id
         WHERE rel.child_id = ?1 AND ss.agent_id = ?2
         ORDER BY rel.ordinal ASC, ss.latest_at DESC",
        "SELECT ss.id, ss.project, ss.depth, ss.kind, ss.content, ss.token_count,
                ss.earliest_at, ss.latest_at, ss.session_key, ss.harness, ss.agent_id,
                ss.source_type, ss.source_ref, ss.meta_json, ss.created_at
         FROM session_summary_children rel
         JOIN session_summaries ss ON ss.id = rel.parent_id
         WHERE rel.child_id = ?1 AND ss.agent_id = ?2 AND ss.project = ?3
         ORDER BY rel.ordinal ASC, ss.latest_at DESC",
        id,
        agent_id,
        project,
    )?;
    let children = query_nodes(
        conn,
        "SELECT ss.id, ss.project, ss.depth, ss.kind, ss.content, ss.token_count,
                ss.earliest_at, ss.latest_at, ss.session_key, ss.harness, ss.agent_id,
                ss.source_type, ss.source_ref, ss.meta_json, ss.created_at
         FROM session_summary_children rel
         JOIN session_summaries ss ON ss.id = rel.child_id
         WHERE rel.parent_id = ?1 AND ss.agent_id = ?2
         ORDER BY rel.ordinal ASC, ss.latest_at DESC",
        "SELECT ss.id, ss.project, ss.depth, ss.kind, ss.content, ss.token_count,
                ss.earliest_at, ss.latest_at, ss.session_key, ss.harness, ss.agent_id,
                ss.source_type, ss.source_ref, ss.meta_json, ss.created_at
         FROM session_summary_children rel
         JOIN session_summaries ss ON ss.id = rel.child_id
         WHERE rel.parent_id = ?1 AND ss.agent_id = ?2 AND ss.project = ?3
         ORDER BY rel.ordinal ASC, ss.latest_at DESC",
        id,
        agent_id,
        project,
    )?;
    let linked_memories = query_linked_memories(conn, id, agent_id, project)?;
    let transcript_key = resolve_transcript_key(&node);
    let transcript = if opts.include_transcript {
        match transcript_key {
            Some(key) => query_transcript(
                conn,
                &key,
                agent_id,
                project,
                opts.transcript_char_limit,
                &node,
            )?,
            None => None,
        }
    } else {
        None
    };

    Ok(Some(TemporalExpandResult {
        node,
        parents,
        children,
        linked_memories,
        transcript,
    }))
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        params![name],
        |row| row.get::<_, bool>(0),
    )
}

fn query_node(
    conn: &Connection,
    sql: &str,
    project_sql: &str,
    id: &str,
    agent_id: &str,
    project: Option<&str>,
) -> rusqlite::Result<Option<TemporalExpandNode>> {
    if let Some(project) = project {
        conn.query_row(project_sql, params![id, agent_id, project], map_node)
            .optional()
    } else {
        conn.query_row(sql, params![id, agent_id], map_node)
            .optional()
    }
}

fn query_nodes(
    conn: &Connection,
    sql: &str,
    project_sql: &str,
    id: &str,
    agent_id: &str,
    project: Option<&str>,
) -> rusqlite::Result<Vec<TemporalExpandNode>> {
    let mut stmt = conn.prepare(if project.is_some() { project_sql } else { sql })?;
    let rows = if let Some(project) = project {
        stmt.query_map(params![id, agent_id, project], map_node)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map(params![id, agent_id], map_node)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows)
}

fn map_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<TemporalExpandNode> {
    Ok(TemporalExpandNode {
        id: row.get(0)?,
        project: row.get(1)?,
        depth: row.get(2)?,
        kind: row.get(3)?,
        content: row.get(4)?,
        token_count: row.get(5)?,
        earliest_at: row.get(6)?,
        latest_at: row.get(7)?,
        session_key: row.get(8)?,
        harness: row.get(9)?,
        agent_id: row.get(10)?,
        source_type: row.get(11)?,
        source_ref: row.get(12)?,
        meta_json: row.get(13)?,
        created_at: row.get(14)?,
    })
}

fn query_linked_memories(
    conn: &Connection,
    id: &str,
    agent_id: &str,
    project: Option<&str>,
) -> rusqlite::Result<Vec<TemporalExpandMemory>> {
    let sql = "SELECT ssm.memory_id AS id,
                      COALESCE(m.content, '[deleted memory]') AS content,
                      COALESCE(m.type, 'unknown') AS type,
                      COALESCE(m.created_at, ss.created_at) AS created_at,
                      CASE WHEN m.id IS NULL OR COALESCE(m.is_deleted, 0) = 1 THEN 1 ELSE 0 END AS is_deleted
               FROM session_summary_memories ssm
               JOIN session_summaries ss ON ss.id = ssm.summary_id
               LEFT JOIN memories m ON m.id = ssm.memory_id
               WHERE ssm.summary_id = ?1 AND ss.agent_id = ?2
               ORDER BY created_at DESC
               LIMIT 25";
    let project_sql = "SELECT ssm.memory_id AS id,
                              COALESCE(m.content, '[deleted memory]') AS content,
                              COALESCE(m.type, 'unknown') AS type,
                              COALESCE(m.created_at, ss.created_at) AS created_at,
                              CASE WHEN m.id IS NULL OR COALESCE(m.is_deleted, 0) = 1 THEN 1 ELSE 0 END AS is_deleted
                       FROM session_summary_memories ssm
                       JOIN session_summaries ss ON ss.id = ssm.summary_id
                       LEFT JOIN memories m ON m.id = ssm.memory_id
                       WHERE ssm.summary_id = ?1 AND ss.agent_id = ?2
                         AND ss.project = ?3 AND (m.id IS NULL OR COALESCE(m.project, ss.project) = ?4)
                       ORDER BY created_at DESC
                       LIMIT 25";
    let mut stmt = conn.prepare(if project.is_some() { project_sql } else { sql })?;
    let map_memory = |row: &rusqlite::Row<'_>| -> rusqlite::Result<TemporalExpandMemory> {
        let deleted: i64 = row.get(4)?;
        Ok(TemporalExpandMemory {
            id: row.get(0)?,
            content: row.get(1)?,
            memory_type: row.get(2)?,
            created_at: row.get(3)?,
            deleted: deleted == 1,
        })
    };
    let rows = if let Some(project) = project {
        stmt.query_map(params![id, agent_id, project, project], map_memory)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map(params![id, agent_id], map_memory)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows)
}

fn query_transcript(
    conn: &Connection,
    transcript_key: &str,
    agent_id: &str,
    project: Option<&str>,
    transcript_char_limit: Option<usize>,
    node: &TemporalExpandNode,
) -> rusqlite::Result<Option<TemporalExpandTranscript>> {
    let has_updated = table_columns(conn, "session_transcripts")?
        .iter()
        .any(|name| name == "updated_at");
    let seen_expr = if has_updated {
        "COALESCE(updated_at, created_at)"
    } else {
        "created_at"
    };
    let sql = format!(
        "SELECT session_key, harness, project, content, {seen_expr} AS seen_at
         FROM session_transcripts
         WHERE session_key = ?1 AND agent_id = ?2"
    );
    let project_sql = format!(
        "SELECT session_key, harness, project, content, {seen_expr} AS seen_at
         FROM session_transcripts
         WHERE session_key = ?1 AND agent_id = ?2 AND project = ?3"
    );
    let mut stmt = conn.prepare(if project.is_some() {
        &project_sql
    } else {
        &sql
    })?;
    let mut rows = if let Some(project) = project {
        stmt.query(params![transcript_key, agent_id, project])?
    } else {
        stmt.query(params![transcript_key, agent_id])?
    };
    let Some(row) = rows.next()? else {
        return Ok(None);
    };

    let content: String = row.get(3)?;
    let raw = clean(&content);
    let limit = transcript_char_limit.unwrap_or(2000).clamp(400, 12_000);
    let truncated = if raw.len() <= limit {
        raw.clone()
    } else {
        format!(
            "{}...",
            truncate_to_boundary(&raw, limit.saturating_sub(3).max(1)).trim()
        )
    };
    Ok(Some(TemporalExpandTranscript {
        session_key: row.get(0)?,
        harness: row.get(1)?,
        project: row.get(2)?,
        updated_at: row.get(4)?,
        excerpt: excerpt(&raw, Some(&node.content), 420),
        content: truncated,
    }))
}

fn table_columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    stmt.query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()
}

fn resolve_transcript_key(node: &TemporalExpandNode) -> Option<String> {
    if let Some(session_key) = trimmed_non_empty(node.session_key.as_deref()) {
        return Some(session_key.to_string());
    }
    match node.source_type.as_deref() {
        Some("chunk" | "compaction" | "summary") => {
            trimmed_non_empty(node.source_ref.as_deref()).map(str::to_string)
        }
        _ => None,
    }
}

fn trimmed_non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn clean(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn excerpt(text: &str, anchor: Option<&str>, limit: usize) -> String {
    let base = clean(text);
    if base.len() <= limit {
        return base;
    }
    let query = clean(anchor.unwrap_or("")).to_lowercase();
    if !query.is_empty() {
        let terms = query
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .filter(|term| term.len() >= 4)
            .take(6);
        let lower = base.to_lowercase();
        for term in terms {
            if let Some(idx) = lower.find(term) {
                let start = previous_char_boundary(&base, idx.saturating_sub(160));
                let end = next_char_boundary(&base, (idx + 220).min(base.len()));
                return format!(
                    "{}{}{}",
                    if start > 0 { "..." } else { "" },
                    base[start..end].trim(),
                    if end < base.len() { "..." } else { "" }
                );
            }
        }
    }
    format!(
        "{}...",
        truncate_to_boundary(&base, limit.saturating_sub(3).max(1)).trim()
    )
}

fn truncate_to_boundary(value: &str, max: usize) -> &str {
    let end = previous_char_boundary(value, max.min(value.len()));
    &value[..end]
}

fn previous_char_boundary(value: &str, mut idx: usize) -> usize {
    while idx > 0 && !value.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn next_char_boundary(value: &str, mut idx: usize) -> usize {
    while idx < value.len() && !value.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}
