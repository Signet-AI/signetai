use crate::{chrome, theme::Theme};
use chrono::Datelike;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap},
};

/// Usage statistics for a single provider
#[derive(Debug, Clone, Default)]
struct ProviderUsage {
    name: String,
    model: String,
    total_sessions: usize,
    total_tokens: u64,
    total_messages: usize,
    today_sessions: usize,
    today_tokens: u64,
    week_sessions: usize,
    week_tokens: u64,
    /// For Claude: when stats were last computed
    last_updated: Option<String>,
}

/// Usage overlay state
pub struct ForgeUsage {
    codex: Option<ProviderUsage>,
    claude: Option<ProviderUsage>,
    scroll: usize,
    max_scroll: usize,
}

impl Default for ForgeUsage {
    fn default() -> Self {
        Self::new()
    }
}

impl ForgeUsage {
    /// Collect usage data from local sources and create the overlay
    pub fn new() -> Self {
        Self {
            codex: collect_codex_usage(),
            claude: collect_claude_usage(),
            scroll: 0,
            max_scroll: 0,
        }
    }

    pub fn scroll_up(&mut self) {
        self.scroll = self.scroll.saturating_sub(1);
    }

    pub fn scroll_down(&mut self) {
        if self.scroll < self.max_scroll {
            self.scroll += 1;
        }
    }

    pub fn render_themed(&self, area: Rect, buf: &mut Buffer, theme: &Theme) {
        let width = 52u16.min(area.width.saturating_sub(4));
        let height = 28u16.min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(width)) / 2;
        let y = area.y + (area.height.saturating_sub(height)) / 2;
        let popup = Rect::new(x, y, width, height);

        Clear.render(popup, buf);
        chrome::render_overlay_chrome(buf, popup, theme);

        let block = Block::default()
            .title(" Forge Usage ")
            .title_style(
                Style::default()
                    .fg(theme.accent)
                    .add_modifier(Modifier::BOLD),
            )
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.accent));

        let inner = block.inner(popup);
        block.render(popup, buf);

        let mut lines = Vec::new();

        // --- Codex section ---
        if let Some(codex) = &self.codex {
            lines.push(provider_header(&codex.name, &codex.model, theme));
            lines.push(separator(inner.width, theme));
            lines.push(stat_line("All Time", codex.total_sessions, codex.total_tokens, theme));
            lines.push(stat_line("Today", codex.today_sessions, codex.today_tokens, theme));
            lines.push(stat_line("This Week", codex.week_sessions, codex.week_tokens, theme));
            lines.push(Line::from(""));
        } else {
            lines.push(Line::from(Span::styled(
                "  Codex: not found (~/.codex/)",
                Style::default().fg(theme.muted),
            )));
            lines.push(Line::from(""));
        }

        // --- Claude section ---
        if let Some(claude) = &self.claude {
            lines.push(provider_header(&claude.name, &claude.model, theme));
            lines.push(separator(inner.width, theme));
            lines.push(stat_line("All Time", claude.total_sessions, claude.total_tokens, theme));
            if claude.total_messages > 0 {
                lines.push(Line::from(vec![
                    Span::styled("    Messages    ", Style::default().fg(theme.muted)),
                    Span::styled(
                        format_number(claude.total_messages as u64),
                        Style::default().fg(theme.fg),
                    ),
                ]));
            }
            lines.push(stat_line("Today", claude.today_sessions, claude.today_tokens, theme));
            if let Some(ref updated) = claude.last_updated {
                lines.push(Line::from(Span::styled(
                    format!("    Stats as of {updated}"),
                    Style::default().fg(theme.muted),
                )));
            }
            lines.push(Line::from(""));
        } else {
            lines.push(Line::from(Span::styled(
                "  Claude Code: not found (~/.claude/)",
                Style::default().fg(theme.muted),
            )));
            lines.push(Line::from(""));
        }

        // --- Combined totals ---
        let combined_sessions = self.codex.as_ref().map_or(0, |c| c.total_sessions)
            + self.claude.as_ref().map_or(0, |c| c.total_sessions);
        let combined_tokens = self.codex.as_ref().map_or(0, |c| c.total_tokens)
            + self.claude.as_ref().map_or(0, |c| c.total_tokens);

        if self.codex.is_some() && self.claude.is_some() {
            lines.push(Line::from(Span::styled(
                "  ◆ Combined",
                Style::default()
                    .fg(theme.fg_bright)
                    .add_modifier(Modifier::BOLD),
            )));
            lines.push(separator(inner.width, theme));
            lines.push(Line::from(vec![
                Span::styled("    Sessions    ", Style::default().fg(theme.muted)),
                Span::styled(
                    format_number(combined_sessions as u64),
                    Style::default().fg(theme.fg),
                ),
            ]));
            lines.push(Line::from(vec![
                Span::styled("    Tokens      ", Style::default().fg(theme.muted)),
                Span::styled(
                    format_tokens(combined_tokens),
                    Style::default().fg(theme.fg),
                ),
            ]));
            lines.push(Line::from(""));
        }

        // Footer
        lines.push(Line::from(Span::styled(
            " R refresh  ↑↓ scroll  Esc close",
            Style::default().fg(theme.muted),
        )));

        // Apply scroll
        let visible_height = inner.height as usize;
        let total_lines = lines.len();
        // Update max_scroll (cast away & to allow mutation via interior pattern)
        let max_scroll = total_lines.saturating_sub(visible_height);
        let scroll = self.scroll.min(max_scroll);

        let visible: Vec<Line> = lines.into_iter().skip(scroll).take(visible_height).collect();
        let paragraph = Paragraph::new(visible).wrap(Wrap { trim: false });
        paragraph.render(inner, buf);
    }

    /// Update max_scroll after a render pass (called from app)
    pub fn update_max_scroll(&mut self, visible_height: usize) {
        let line_count = self.estimated_line_count();
        self.max_scroll = line_count.saturating_sub(visible_height);
    }

    fn estimated_line_count(&self) -> usize {
        let mut count = 0;
        if self.codex.is_some() {
            count += 6; // header + separator + 3 stats + blank
        } else {
            count += 2;
        }
        if let Some(ref claude) = self.claude {
            count += 5; // header + separator + 2 stats + today
            if claude.total_messages > 0 {
                count += 1;
            }
            if claude.last_updated.is_some() {
                count += 1;
            }
            count += 1; // blank
        } else {
            count += 2;
        }
        if self.codex.is_some() && self.claude.is_some() {
            count += 5; // combined section
        }
        count += 1; // footer
        count
    }
}

// --- Data collection ---

fn collect_codex_usage() -> Option<ProviderUsage> {
    let home = dirs::home_dir()?;
    let db_path = home.join(".codex").join("state_5.sqlite");
    if !db_path.exists() {
        return None;
    }

    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;

    // Total stats
    let (total_sessions, total_tokens): (usize, u64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(tokens_used), 0) FROM threads",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;

    // Detect timestamp scale (seconds vs milliseconds)
    let latest_ts: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(created_at), 0) FROM threads",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let ts_millis = latest_ts > 1_000_000_000_000;

    // Today boundary
    let now = chrono::Local::now();
    let today_start = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|dt| dt.and_local_timezone(chrono::Local).single())
        .map(|dt| {
            if ts_millis {
                dt.timestamp() * 1000
            } else {
                dt.timestamp()
            }
        })
        .unwrap_or(0);

    let (today_sessions, today_tokens): (usize, u64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(tokens_used), 0) FROM threads WHERE created_at >= ?1",
            [today_start],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or((0, 0));

    // This week boundary (Monday start)
    let today = now.date_naive();
    let days_since_monday = today.weekday().num_days_from_monday() as i64;
    let week_start = (today - chrono::Duration::days(days_since_monday))
        .and_hms_opt(0, 0, 0)
        .and_then(|dt| dt.and_local_timezone(chrono::Local).single())
        .map(|dt| {
            if ts_millis {
                dt.timestamp() * 1000
            } else {
                dt.timestamp()
            }
        })
        .unwrap_or(0);

    let (week_sessions, week_tokens): (usize, u64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(tokens_used), 0) FROM threads WHERE created_at >= ?1",
            [week_start],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or((0, 0));

    // Model from config.toml
    let model = {
        let config_path = home.join(".codex").join("config.toml");
        std::fs::read_to_string(config_path)
            .ok()
            .and_then(|content| {
                content.lines().find_map(|line| {
                    let trimmed = line.trim();
                    if trimmed.starts_with("model")
                        && !trimmed.starts_with("model_")
                        && trimmed.contains('=')
                    {
                        trimmed.split('=').nth(1).map(|v| {
                            v.trim()
                                .trim_matches('"')
                                .trim_matches('\'')
                                .trim()
                                .to_string()
                        })
                    } else {
                        None
                    }
                })
            })
            .unwrap_or_else(|| "unknown".to_string())
    };

    Some(ProviderUsage {
        name: "Codex (OpenAI)".to_string(),
        model,
        total_sessions,
        total_tokens,
        total_messages: 0,
        today_sessions,
        today_tokens,
        week_sessions,
        week_tokens,
        last_updated: None,
    })
}

fn collect_claude_usage() -> Option<ProviderUsage> {
    let home = dirs::home_dir()?;
    let stats_path = home.join(".claude").join("stats-cache.json");
    if !stats_path.exists() {
        return None;
    }

    let content = std::fs::read_to_string(&stats_path).ok()?;
    let stats: serde_json::Value = serde_json::from_str(&content).ok()?;

    let total_sessions = stats
        .get("totalSessions")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let total_messages = stats
        .get("totalMessages")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let last_computed = stats
        .get("lastComputedDate")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Sum tokens across all models
    let mut total_tokens: u64 = 0;
    let mut primary_model = String::new();
    let mut max_model_tokens: u64 = 0;

    if let Some(model_usage) = stats.get("modelUsage").and_then(|v| v.as_object()) {
        for (model, usage) in model_usage {
            let input = usage
                .get("inputTokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let output = usage
                .get("outputTokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cache_read = usage
                .get("cacheReadInputTokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let cache_create = usage
                .get("cacheCreationInputTokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let model_total = input + output + cache_read + cache_create;
            total_tokens += model_total;

            if model_total > max_model_tokens {
                max_model_tokens = model_total;
                primary_model = model.clone();
            }
        }
    }

    // Today stats from dailyActivity
    let today_str = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut today_sessions = 0usize;

    if let Some(daily) = stats.get("dailyActivity").and_then(|v| v.as_array()) {
        for entry in daily {
            if entry.get("date").and_then(|v| v.as_str()) == Some(today_str.as_str()) {
                today_sessions = entry
                    .get("sessionCount")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                break;
            }
        }
    }

    // Today tokens from dailyModelTokens
    let mut today_tokens: u64 = 0;
    if let Some(daily_tokens) = stats.get("dailyModelTokens").and_then(|v| v.as_array()) {
        for entry in daily_tokens {
            if entry.get("date").and_then(|v| v.as_str()) == Some(today_str.as_str()) {
                if let Some(by_model) = entry.get("tokensByModel").and_then(|v| v.as_object()) {
                    for (_, count) in by_model {
                        today_tokens += count.as_u64().unwrap_or(0);
                    }
                }
                break;
            }
        }
    }

    // Week stats — sum last 7 days of dailyActivity
    let now = chrono::Local::now().date_naive();
    let days_since_monday = now.weekday().num_days_from_monday() as i64;
    let week_start = now - chrono::Duration::days(days_since_monday);
    let mut week_sessions = 0usize;
    let mut week_tokens: u64 = 0;

    if let Some(daily) = stats.get("dailyActivity").and_then(|v| v.as_array()) {
        for entry in daily {
            if let Some(date_str) = entry.get("date").and_then(|v| v.as_str()) {
                if let Ok(date) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                    if date >= week_start && date <= now {
                        week_sessions += entry
                            .get("sessionCount")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as usize;
                    }
                }
            }
        }
    }
    if let Some(daily_tokens) = stats.get("dailyModelTokens").and_then(|v| v.as_array()) {
        for entry in daily_tokens {
            if let Some(date_str) = entry.get("date").and_then(|v| v.as_str()) {
                if let Ok(date) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                    if date >= week_start && date <= now {
                        if let Some(by_model) =
                            entry.get("tokensByModel").and_then(|v| v.as_object())
                        {
                            for (_, count) in by_model {
                                week_tokens += count.as_u64().unwrap_or(0);
                            }
                        }
                    }
                }
            }
        }
    }

    // Shorten model name for display
    let display_model = shorten_model(&primary_model);

    Some(ProviderUsage {
        name: "Claude Code".to_string(),
        model: display_model,
        total_sessions,
        total_tokens,
        total_messages,
        today_sessions,
        today_tokens,
        week_sessions,
        week_tokens,
        last_updated: last_computed,
    })
}

// --- Rendering helpers ---

fn provider_header<'a>(name: &str, model: &str, theme: &Theme) -> Line<'a> {
    let pad = 44usize.saturating_sub(name.len() + 4 + model.len());
    Line::from(vec![
        Span::styled(
            format!("  ◆ {name}"),
            Style::default()
                .fg(theme.fg_bright)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("{:>width$}", model, width = pad + model.len()),
            Style::default().fg(theme.muted),
        ),
    ])
}

fn separator<'a>(width: u16, theme: &Theme) -> Line<'a> {
    let w = (width as usize).saturating_sub(4);
    Line::from(Span::styled(
        format!("  {}", "─".repeat(w)),
        Style::default().fg(theme.border),
    ))
}

fn stat_line<'a>(label: &str, sessions: usize, tokens: u64, theme: &Theme) -> Line<'a> {
    Line::from(vec![
        Span::styled(
            format!("    {:<12}", label),
            Style::default().fg(theme.muted),
        ),
        Span::styled(
            format!("{:>5} sessions", format_number(sessions as u64)),
            Style::default().fg(theme.fg),
        ),
        Span::styled("  ", Style::default()),
        Span::styled(
            format!("{:>8} tok", format_tokens(tokens)),
            Style::default().fg(theme.fg),
        ),
    ])
}

fn format_tokens(tokens: u64) -> String {
    if tokens >= 1_000_000_000 {
        format!("{:.1}B", tokens as f64 / 1_000_000_000.0)
    } else if tokens >= 1_000_000 {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("{:.1}K", tokens as f64 / 1_000.0)
    } else {
        tokens.to_string()
    }
}

fn format_number(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 10_000 {
        format!("{:.1}K", n as f64 / 1_000.0)
    } else {
        // Add comma separators
        let s = n.to_string();
        let mut result = String::new();
        for (i, c) in s.chars().rev().enumerate() {
            if i > 0 && i % 3 == 0 {
                result.push(',');
            }
            result.push(c);
        }
        result.chars().rev().collect()
    }
}

fn shorten_model(model: &str) -> String {
    // Turn "claude-opus-4-5-20251101" into "opus-4-5"
    if let Some(without_prefix) = model.strip_prefix("claude-") {
        // Strip trailing date suffix like -20251101
        if let Some(pos) = without_prefix.rfind('-') {
            let suffix = &without_prefix[pos + 1..];
            if suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
                return without_prefix[..pos].to_string();
            }
        }
        return without_prefix.to_string();
    }
    model.to_string()
}
