//! Significance gate: zero-cost continuity filter.
//!
//! Assesses whether a session transcript is worth sending through the LLM
//! summarization pipeline. Sessions below a significance threshold skip
//! extraction entirely, saving LLM inference cost while preserving the raw
//! transcript (lossless retention).
//!
//! Three independent signals are evaluated:
//!   1. Turn count -- substantive back-and-forth exchanges
//!   2. Entity overlap -- references to known high-mention entities
//!   3. Content novelty -- unique tokens vs recent session summaries
//!
//! All three must indicate low significance to gate the session.

use std::collections::HashSet;

use rusqlite::params;
use tracing::debug;

use signet_core::db::DbPool;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Configuration for the significance gate.
#[derive(Debug, Clone)]
pub struct SignificanceConfig {
    pub enabled: bool,
    pub min_turns: usize,
    pub min_entity_overlap: i64,
    pub novelty_threshold: f64,
}

/// Scores from the three significance signals.
#[derive(Debug, Clone)]
pub struct SignificanceScores {
    pub turn_count: usize,
    pub entity_overlap: i64,
    pub novelty: f64,
}

/// Result of the significance assessment.
#[derive(Debug, Clone)]
pub struct SignificanceResult {
    pub significant: bool,
    pub scores: SignificanceScores,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// Turn counting
// ---------------------------------------------------------------------------

/// Count substantive turn pairs in a transcript. A turn is substantive when
/// the user message exceeds 20 chars and the assistant response exceeds 50 chars.
fn count_substantive_turns(transcript: &str) -> usize {
    let mut current_role: Option<&str> = None;
    let mut current_block = String::new();
    let mut user_blocks: Vec<String> = Vec::new();
    let mut assistant_blocks: Vec<String> = Vec::new();

    for line in transcript.lines() {
        let trimmed_lower = line.trim_start().to_lowercase();
        if trimmed_lower.starts_with("human:") || trimmed_lower.starts_with("user:") {
            flush_block(
                current_role,
                &current_block,
                &mut user_blocks,
                &mut assistant_blocks,
            );
            current_role = Some("user");
            current_block = strip_role_prefix(line);
        } else if trimmed_lower.starts_with("assistant:") {
            flush_block(
                current_role,
                &current_block,
                &mut user_blocks,
                &mut assistant_blocks,
            );
            current_role = Some("assistant");
            current_block = strip_role_prefix(line);
        } else {
            current_block.push('\n');
            current_block.push_str(line);
        }
    }
    flush_block(
        current_role,
        &current_block,
        &mut user_blocks,
        &mut assistant_blocks,
    );

    let pair_count = user_blocks.len().min(assistant_blocks.len());
    let mut substantive = 0;
    for i in 0..pair_count {
        let user_len = user_blocks[i].trim().len();
        let assist_len = assistant_blocks[i].trim().len();
        if user_len > 20 && assist_len > 50 {
            substantive += 1;
        }
    }
    substantive
}

fn flush_block(
    role: Option<&str>,
    block: &str,
    user_blocks: &mut Vec<String>,
    assistant_blocks: &mut Vec<String>,
) {
    match role {
        Some("user") => user_blocks.push(block.to_string()),
        Some("assistant") => assistant_blocks.push(block.to_string()),
        _ => {}
    }
}

/// Strip "Human:", "User:", or "Assistant:" prefix from a line.
fn strip_role_prefix(line: &str) -> String {
    let lower = line.trim_start().to_lowercase();
    for prefix in &["human:", "user:", "assistant:"] {
        if lower.starts_with(prefix) {
            return line.trim_start()[prefix.len()..].to_string();
        }
    }
    line.to_string()
}

// ---------------------------------------------------------------------------
// Entity overlap
// ---------------------------------------------------------------------------

/// Count how many known high-mention entities appear in the transcript.
/// Returns -1 if the entities table does not exist (passes the gate).
fn count_entity_overlap(conn: &rusqlite::Connection, transcript: &str, agent_id: &str) -> i64 {
    let sql = "SELECT DISTINCT e.name FROM entities e
               WHERE e.agent_id = ?1 AND e.mentions >= 3";

    let names: Vec<String> = match conn.prepare(sql) {
        Ok(mut stmt) => stmt
            .query_map(params![agent_id], |row| row.get::<_, String>(0))
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => return -1, // Table may not exist yet
    };

    if names.is_empty() {
        return 0;
    }

    let lower_transcript = transcript.to_lowercase();
    let mut matches = 0_i64;
    for name in &names {
        if lower_transcript.contains(&name.to_lowercase()) {
            matches += 1;
        }
    }
    matches
}

// ---------------------------------------------------------------------------
// Content novelty
// ---------------------------------------------------------------------------

/// Split text into lowercase alphanumeric tokens (>= 3 chars).
fn tokenize(text: &str) -> HashSet<String> {
    let lower = text.to_lowercase();
    let mut tokens = HashSet::new();
    for word in lower.split(|c: char| !c.is_ascii_alphanumeric()) {
        if word.len() >= 3 {
            tokens.insert(word.to_string());
        }
    }
    tokens
}

/// Compute novelty: 0-1 score where 1.0 = highly novel, 0.0 = highly redundant.
/// Compares transcript tokens against the last 5 completed session transcripts.
fn compute_novelty(conn: &rusqlite::Connection, transcript: &str, agent_id: &str) -> f64 {
    let sql_scoped = "SELECT transcript FROM summary_jobs
                      WHERE status = 'completed' AND agent_id = ?1
                      ORDER BY completed_at DESC LIMIT 5";

    let sql_fallback = "SELECT transcript FROM summary_jobs
                        WHERE status = 'completed'
                        ORDER BY completed_at DESC LIMIT 5";

    let recent_transcripts: Vec<String> = match conn.prepare(sql_scoped) {
        Ok(mut stmt) => stmt
            .query_map(params![agent_id], |row| row.get::<_, String>(0))
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => {
            // Try without agent scoping
            match conn.prepare(sql_fallback) {
                Ok(mut stmt) => stmt
                    .query_map([], |row| row.get::<_, String>(0))
                    .ok()
                    .map(|rows| rows.filter_map(|r| r.ok()).collect())
                    .unwrap_or_default(),
                Err(_) => return 1.0, // Table missing -- treat as novel
            }
        }
    };

    if recent_transcripts.is_empty() {
        return 1.0;
    }

    let current_tokens = tokenize(transcript);
    if current_tokens.is_empty() {
        return 1.0;
    }

    let mut recent_tokens = HashSet::new();
    for t in &recent_transcripts {
        for tok in tokenize(t) {
            recent_tokens.insert(tok);
        }
    }

    if recent_tokens.is_empty() {
        return 1.0;
    }

    let unique = current_tokens.difference(&recent_tokens).count();
    let ratio = unique as f64 / current_tokens.len() as f64;

    // Interpolate: <10% unique -> 0.0, >30% unique -> 1.0
    if ratio >= 0.3 {
        1.0
    } else if ratio <= 0.1 {
        0.0
    } else {
        (ratio - 0.1) / 0.2
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Assess whether a session transcript is significant enough for extraction.
///
/// A session is insignificant only when ALL three signals (turn count,
/// entity overlap, content novelty) are below their thresholds.
pub async fn assess_significance(
    transcript: &str,
    pool: &DbPool,
    agent_id: &str,
    config: &SignificanceConfig,
) -> SignificanceResult {
    // Turn counting is pure string parsing, no DB needed
    let turn_count = count_substantive_turns(transcript);

    if !config.enabled {
        return SignificanceResult {
            significant: true,
            scores: SignificanceScores {
                turn_count,
                entity_overlap: 0,
                novelty: 1.0,
            },
            reason: "gate_disabled".into(),
        };
    }

    // Entity overlap + novelty need DB
    let transcript_owned = transcript.to_string();
    let agent_id_owned = agent_id.to_string();

    let db_result = pool
        .read(move |conn| {
            let entity_overlap = count_entity_overlap(conn, &transcript_owned, &agent_id_owned);
            let novelty = compute_novelty(conn, &transcript_owned, &agent_id_owned);
            Ok((entity_overlap, novelty))
        })
        .await;

    let (entity_overlap, novelty) = match db_result {
        Ok(r) => r,
        Err(e) => {
            debug!(error = %e, "significance gate DB read failed, passing session");
            (-1_i64, 1.0_f64)
        }
    };

    // Entity overlap of -1 means the table doesn't exist -- let it pass
    let entity_passes = entity_overlap < 0 || entity_overlap >= config.min_entity_overlap;
    let turn_passes = turn_count >= config.min_turns;
    let novelty_passes = novelty >= config.novelty_threshold;

    // Session is insignificant only when ALL three gates fail
    let significant = turn_passes || entity_passes || novelty_passes;

    let mut reasons = Vec::new();
    if !turn_passes {
        reasons.push(format!("turns={turn_count}<{}", config.min_turns));
    }
    if !entity_passes {
        reasons.push(format!(
            "entities={entity_overlap}<{}",
            config.min_entity_overlap
        ));
    }
    if !novelty_passes {
        reasons.push(format!(
            "novelty={:.2}<{}",
            novelty, config.novelty_threshold
        ));
    }

    let reason = if significant {
        "passed".to_string()
    } else {
        format!("below threshold: {}", reasons.join(", "))
    };

    debug!(
        turn_count,
        entity_overlap,
        novelty = format_args!("{novelty:.3}"),
        significant,
        reason = %reason,
        "significance assessment"
    );

    SignificanceResult {
        significant,
        scores: SignificanceScores {
            turn_count,
            entity_overlap: entity_overlap.max(0),
            novelty,
        },
        reason,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- Turn counting ---

    #[test]
    fn substantive_turns_counts_pairs() {
        let transcript = "\
Human: What is the weather like today?\n\
Assistant: The weather is sunny with temperatures around 75 degrees Fahrenheit. It's a beautiful day to be outside.\n\
Human: Should I bring an umbrella?\n\
Assistant: No, there is no rain in the forecast for today. You should be fine without one.\n";
        assert_eq!(count_substantive_turns(transcript), 2);
    }

    #[test]
    fn short_user_turn_not_substantive() {
        let transcript = "\
User: Hi\n\
Assistant: Hello! I'm here to help you with whatever you need. What can I assist you with today?\n";
        // User message is only 2 chars (< 20)
        assert_eq!(count_substantive_turns(transcript), 0);
    }

    #[test]
    fn short_assistant_turn_not_substantive() {
        let transcript = "\
User: Can you tell me a very long story about a dragon and a knight?\n\
Assistant: OK\n";
        // Assistant message is only 2 chars (< 50)
        assert_eq!(count_substantive_turns(transcript), 0);
    }

    #[test]
    fn empty_transcript_zero_turns() {
        assert_eq!(count_substantive_turns(""), 0);
    }

    #[test]
    fn single_turn_no_pair() {
        let transcript = "Human: This is a reasonably long question about something important.\n";
        assert_eq!(count_substantive_turns(transcript), 0);
    }

    // --- Tokenization ---

    #[test]
    fn tokenize_splits_on_non_alnum() {
        let tokens = tokenize("Hello, world! foo-bar baz123");
        assert!(tokens.contains("hello"));
        assert!(tokens.contains("world"));
        assert!(tokens.contains("foo"));
        assert!(tokens.contains("bar"));
        assert!(tokens.contains("baz123"));
    }

    #[test]
    fn tokenize_filters_short() {
        let tokens = tokenize("I am a big cat");
        // "am" and "a" are < 3 chars, "big" and "cat" are >= 3
        assert!(!tokens.contains("i"));
        assert!(!tokens.contains("am"));
        assert!(!tokens.contains("a"));
        assert!(tokens.contains("big"));
        assert!(tokens.contains("cat"));
    }

    // --- Significance config disabled ---

    #[tokio::test]
    async fn disabled_gate_passes() {
        let dir = std::env::temp_dir().join("signet_sig_gate_disabled.db");
        let _ = std::fs::remove_file(&dir);
        let (pool, _) = DbPool::open(&dir).unwrap();

        let config = SignificanceConfig {
            enabled: false,
            min_turns: 2,
            min_entity_overlap: 1,
            novelty_threshold: 0.3,
        };
        let result = assess_significance("Hello world", &pool, "test", &config).await;
        assert!(result.significant);
        assert_eq!(result.reason, "gate_disabled");
    }

    // --- Significance with empty DB (novel content) ---

    #[tokio::test]
    async fn novel_transcript_passes() {
        let dir = std::env::temp_dir().join("signet_sig_gate_novel.db");
        let _ = std::fs::remove_file(&dir);
        let (pool, _) = DbPool::open(&dir).unwrap();

        let config = SignificanceConfig {
            enabled: true,
            min_turns: 2,
            min_entity_overlap: 1,
            novelty_threshold: 0.3,
        };
        let transcript = "\
Human: What is the quantum mechanical explanation for superconductivity?\n\
Assistant: Superconductivity arises when electrons form Cooper pairs due to phonon interactions in the lattice, leading to zero electrical resistance below a critical temperature.\n";
        let result = assess_significance(transcript, &pool, "test", &config).await;
        // Novelty will be 1.0 (no prior sessions), so it passes
        assert!(result.significant);
    }
}
