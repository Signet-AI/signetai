use forge_core::{Message, MessageContent, Role, TokenUsage};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use tracing::{debug, error, info, warn};

/// Persistent session storage using SQLite
pub struct SessionStore {
    conn: Connection,
}

/// A saved session summary for the session browser
#[derive(Debug, Clone)]
pub struct SavedSession {
    pub id: String,
    pub model: String,
    pub provider: String,
    pub project: Option<String>,
    pub started_at: String,
    pub message_count: usize,
    pub total_tokens: usize,
}

impl SessionStore {
    pub fn open() -> Result<Self, String> {
        let path = db_path();

        // Create parent directory if needed
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create dir: {e}"))?;
        }

        let conn = Connection::open(&path)
            .map_err(|e| format!("Failed to open session DB: {e}"))?;

        // Create tables
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                model TEXT NOT NULL,
                provider TEXT NOT NULL,
                project TEXT,
                started_at TEXT NOT NULL,
                total_input_tokens INTEGER DEFAULT 0,
                total_output_tokens INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES sessions(id),
                message_json TEXT NOT NULL,
                seq INTEGER NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session
                ON messages(session_id, seq);",
        )
        .map_err(|e| format!("Failed to create tables: {e}"))?;

        info!("Session store opened at {}", path.display());
        Ok(Self { conn })
    }

    /// Save a session to the database
    #[allow(clippy::too_many_arguments)]
    pub fn save_session(
        &self,
        id: &str,
        model: &str,
        provider: &str,
        project: Option<&str>,
        started_at: &str,
        messages: &[Message],
        input_tokens: usize,
        output_tokens: usize,
    ) -> Result<(), String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| format!("Transaction failed: {e}"))?;

        // Upsert session
        tx.execute(
            "INSERT OR REPLACE INTO sessions (id, model, provider, project, started_at, total_input_tokens, total_output_tokens)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, model, provider, project, started_at, input_tokens, output_tokens],
        )
        .map_err(|e| format!("Failed to save session: {e}"))?;

        // Delete old messages for this session
        tx.execute("DELETE FROM messages WHERE session_id = ?1", params![id])
            .map_err(|e| format!("Failed to clear messages: {e}"))?;

        // Insert messages
        for (seq, msg) in messages.iter().enumerate() {
            let json = serde_json::to_string(msg)
                .map_err(|e| format!("Failed to serialize message: {e}"))?;
            tx.execute(
                "INSERT INTO messages (session_id, message_json, seq) VALUES (?1, ?2, ?3)",
                params![id, json, seq],
            )
            .map_err(|e| format!("Failed to save message: {e}"))?;
        }

        tx.commit()
            .map_err(|e| format!("Commit failed: {e}"))?;

        debug!(
            "Saved session {id} with {} messages",
            messages.len()
        );
        Ok(())
    }

    /// Load messages for a session
    pub fn load_messages(&self, session_id: &str) -> Result<Vec<Message>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT message_json FROM messages WHERE session_id = ?1 ORDER BY seq")
            .map_err(|e| format!("Prepare failed: {e}"))?;

        let messages: Vec<Message> = stmt
            .query_map(params![session_id], |row| {
                let json: String = row.get(0)?;
                Ok(json)
            })
            .map_err(|e| format!("Query failed: {e}"))?
            .filter_map(|r| {
                r.ok().and_then(|json| {
                    serde_json::from_str(&json)
                        .map_err(|e| error!("Failed to deserialize message: {e}"))
                        .ok()
                })
            })
            .collect();

        debug!(
            "Loaded {} messages for session {session_id}",
            messages.len()
        );
        Ok(messages)
    }

    /// List recent sessions
    pub fn list_sessions(&self, limit: usize) -> Result<Vec<SavedSession>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT s.id, s.model, s.provider, s.project, s.started_at,
                        s.total_input_tokens, s.total_output_tokens,
                        COUNT(m.id) as msg_count
                 FROM sessions s
                 LEFT JOIN messages m ON m.session_id = s.id
                 GROUP BY s.id
                 ORDER BY s.created_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| format!("Prepare failed: {e}"))?;

        let sessions: Vec<SavedSession> = stmt
            .query_map(params![limit], |row| {
                let input_tokens: usize = row.get(5)?;
                let output_tokens: usize = row.get(6)?;
                Ok(SavedSession {
                    id: row.get(0)?,
                    model: row.get(1)?,
                    provider: row.get(2)?,
                    project: row.get(3)?,
                    started_at: row.get(4)?,
                    message_count: row.get(7)?,
                    total_tokens: input_tokens + output_tokens,
                })
            })
            .map_err(|e| format!("Query failed: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(sessions)
    }

    /// Get the most recent session ID
    pub fn last_session_id(&self) -> Option<String> {
        self.conn
            .query_row(
                "SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .ok()
    }

    /// Import conversation sessions from Claude Code.
    ///
    /// Scans `~/.claude/projects/` for JSONL conversation files and converts
    /// them into Forge sessions. Skips sessions that are already imported
    /// (matched by session ID).
    ///
    /// Returns `(imported_count, skipped_count)`.
    pub fn import_claude_sessions(&self) -> Result<(usize, usize), String> {
        let claude_dir = dirs::home_dir()
            .ok_or_else(|| "Cannot determine home directory".to_string())?
            .join(".claude");

        if !claude_dir.exists() {
            return Err("Claude Code directory (~/.claude) not found".to_string());
        }

        let projects_dir = claude_dir.join("projects");
        if !projects_dir.exists() {
            return Err("No Claude Code projects directory found".to_string());
        }

        // Build an index from history.jsonl so we can resolve project paths
        let history_index = load_claude_history_index(&claude_dir);

        // Find all .jsonl conversation files under projects/
        let jsonl_files = find_jsonl_files(&projects_dir);
        if jsonl_files.is_empty() {
            return Err("No Claude Code conversation files found".to_string());
        }

        let mut imported = 0usize;
        let mut skipped = 0usize;

        for path in &jsonl_files {
            // Skip subagent files
            if path.to_string_lossy().contains("subagents") {
                continue;
            }

            // Extract session ID from filename (UUID.jsonl)
            let session_id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(id) => id.to_string(),
                None => continue,
            };

            // Check if already imported
            let exists: bool = self
                .conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sessions WHERE id = ?1",
                    params![&session_id],
                    |row| row.get(0),
                )
                .unwrap_or(false);

            if exists {
                skipped += 1;
                debug!("Skipping already-imported session {session_id}");
                continue;
            }

            match parse_claude_session(path, &session_id, &history_index) {
                Ok(parsed) if parsed.messages.is_empty() => {
                    debug!("Skipping empty session {session_id}");
                    skipped += 1;
                }
                Ok(parsed) => {
                    if let Err(e) = self.save_session(
                        &session_id,
                        &parsed.model,
                        "anthropic",
                        parsed.project.as_deref(),
                        &parsed.started_at,
                        &parsed.messages,
                        parsed.input_tokens,
                        parsed.output_tokens,
                    ) {
                        warn!("Failed to import session {session_id}: {e}");
                    } else {
                        info!(
                            "Imported Claude Code session {session_id} ({} messages)",
                            parsed.messages.len()
                        );
                        imported += 1;
                    }
                }
                Err(e) => {
                    warn!("Failed to parse Claude Code session {session_id}: {e}");
                }
            }
        }

        Ok((imported, skipped))
    }
}

/// Parsed session data from a Claude Code JSONL file
struct ParsedClaudeSession {
    messages: Vec<Message>,
    model: String,
    project: Option<String>,
    started_at: String,
    input_tokens: usize,
    output_tokens: usize,
}

/// Load the history.jsonl index to map session IDs to project paths
fn load_claude_history_index(claude_dir: &std::path::Path) -> std::collections::HashMap<String, String> {
    let mut index = std::collections::HashMap::new();
    let history_path = claude_dir.join("history.jsonl");
    if let Ok(content) = std::fs::read_to_string(&history_path) {
        for line in content.lines() {
            if let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) {
                if let (Some(sid), Some(proj)) = (
                    obj.get("sessionId").and_then(|v| v.as_str()),
                    obj.get("project").and_then(|v| v.as_str()),
                ) {
                    index.entry(sid.to_string()).or_insert_with(|| proj.to_string());
                }
            }
        }
    }
    index
}

/// Recursively find all .jsonl files under a directory
fn find_jsonl_files(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut results = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                results.extend(find_jsonl_files(&path));
            } else if path.extension().is_some_and(|ext| ext == "jsonl") {
                results.push(path);
            }
        }
    }
    results
}

/// Parse a single Claude Code JSONL conversation file into Forge messages
fn parse_claude_session(
    path: &std::path::Path,
    session_id: &str,
    history_index: &std::collections::HashMap<String, String>,
) -> Result<ParsedClaudeSession, String> {
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;

    let mut messages = Vec::new();
    let mut model = String::from("unknown");
    let mut started_at = String::new();
    let mut total_input = 0usize;
    let mut total_output = 0usize;
    let mut cwd: Option<String> = None;

    for line in content.lines() {
        let obj: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let entry_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // Capture the earliest timestamp as started_at
        if started_at.is_empty() {
            if let Some(ts) = obj.get("timestamp").and_then(|v| v.as_str()) {
                started_at = ts.to_string();
            }
        }

        // Capture cwd from any entry that has it
        if cwd.is_none() {
            if let Some(c) = obj.get("cwd").and_then(|v| v.as_str()) {
                cwd = Some(c.to_string());
            }
        }

        match entry_type {
            "user" => {
                if let Some(msg) = obj.get("message") {
                    if let Some(forge_msg) = convert_claude_message(msg, Role::User) {
                        messages.push(forge_msg);
                    }
                }
            }
            "assistant" => {
                if let Some(msg) = obj.get("message") {
                    // Extract model name from assistant messages
                    if let Some(m) = msg.get("model").and_then(|v| v.as_str()) {
                        if model == "unknown" {
                            model = m.to_string();
                        }
                    }

                    // Accumulate token usage
                    if let Some(usage) = msg.get("usage") {
                        total_input += usage
                            .get("input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as usize;
                        total_input += usage
                            .get("cache_read_input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as usize;
                        total_output += usage
                            .get("output_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as usize;
                    }

                    if let Some(forge_msg) = convert_claude_message(msg, Role::Assistant) {
                        messages.push(forge_msg);
                    }
                }
            }
            // Skip progress, queue-operation, system, file-history-snapshot, etc.
            _ => {}
        }
    }

    // Resolve project from history index or cwd
    let project = history_index
        .get(session_id)
        .cloned()
        .or(cwd);

    Ok(ParsedClaudeSession {
        messages,
        model,
        project,
        started_at,
        input_tokens: total_input,
        output_tokens: total_output,
    })
}

/// Convert a Claude Code API message object to a Forge Message
fn convert_claude_message(msg: &serde_json::Value, expected_role: Role) -> Option<Message> {
    let content = msg.get("content")?;

    let forge_content = match content {
        // String content (common for user messages)
        serde_json::Value::String(text) => {
            // Skip system prompt injections in user messages
            if text.starts_with("<system>") || text.starts_with("<!-- SIGNET") {
                return None;
            }
            vec![MessageContent::Text {
                text: text.clone(),
            }]
        }
        // Array of content blocks (tool_use, tool_result, text, etc.)
        serde_json::Value::Array(blocks) => {
            let mut parts = Vec::new();
            for block in blocks {
                let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match block_type {
                    "text" => {
                        if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                            // Skip empty text blocks
                            if !text.trim().is_empty() {
                                parts.push(MessageContent::Text {
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    "tool_use" => {
                        let id = block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let input = block
                            .get("input")
                            .cloned()
                            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                        parts.push(MessageContent::ToolUse { id, name, input });
                    }
                    "tool_result" => {
                        let tool_use_id = block
                            .get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let is_error = block
                            .get("is_error")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);

                        // tool_result content can be string, array of blocks, or absent
                        let result_text = match block.get("content") {
                            Some(serde_json::Value::String(s)) => s.clone(),
                            Some(serde_json::Value::Array(arr)) => {
                                // Flatten nested content blocks to text
                                arr.iter()
                                    .filter_map(|b| {
                                        b.get("text")
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string())
                                    })
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            }
                            _ => String::new(),
                        };

                        parts.push(MessageContent::ToolResult {
                            tool_use_id,
                            content: result_text,
                            is_error,
                        });
                    }
                    // Skip "thinking", "image", "tool_reference" and other blocks
                    // that don't map to Forge's message model
                    _ => {}
                }
            }
            parts
        }
        _ => return None,
    };

    // Skip messages with no convertible content
    if forge_content.is_empty() {
        return None;
    }

    // Build usage info for assistant messages
    let usage = if expected_role == Role::Assistant {
        let usage_obj = msg.get("usage");
        usage_obj.map(|u| TokenUsage {
            input_tokens: u
                .get("input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize,
            output_tokens: u
                .get("output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize,
            cache_read_tokens: u
                .get("cache_read_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize,
            cache_creation_tokens: u
                .get("cache_creation_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize,
        })
    } else {
        None
    };

    Some(Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: expected_role,
        content: forge_content,
        model: msg
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        usage,
    })
}

fn db_path() -> PathBuf {
    dirs::data_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("forge")
        .join("sessions.db")
}
