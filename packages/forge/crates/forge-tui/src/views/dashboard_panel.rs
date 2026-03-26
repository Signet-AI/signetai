use crate::{chrome, theme::Theme};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap},
};

/// Dashboard data fetched from the Signet daemon
#[derive(Debug, Clone, Default)]
pub struct DashboardData {
    pub memory: MemoryStats,
    pub pipeline: PipelineStats,
    pub embedding: EmbeddingStats,
    pub diagnostics: DiagnosticsStats,
}

#[derive(Debug, Clone, Default)]
pub struct MemoryStats {
    pub total: usize,
    pub embedded: usize,
    pub critical: usize,
}

#[derive(Debug, Clone, Default)]
pub struct PipelineStats {
    pub mode: String,
    pub pending: usize,
    pub leased: usize,
    pub completed: usize,
    pub failed: usize,
    pub dead: usize,
    pub predictor_ready: bool,
    pub predictor_alpha: f64,
}

#[derive(Debug, Clone, Default)]
pub struct EmbeddingStats {
    pub status: String,
    pub score: f64,
    pub provider: String,
    pub model: String,
    pub dimensions: usize,
    pub coverage: f64,
    pub unembedded: usize,
}

#[derive(Debug, Clone, Default)]
pub struct DiagnosticsStats {
    pub score: f64,
    pub status: String,
}

/// Tabbed dashboard overlay
pub struct DashboardPanel {
    pub data: DashboardData,
    pub tab: usize,
    pub loading: bool,
    /// Live daemon logs (reference to app's ring buffer)
    pub logs: Vec<String>,
}

const TABS: &[&str] = &["Memory", "Pipeline", "Embeddings", "Health", "Logs"];

impl Default for DashboardPanel {
    fn default() -> Self {
        Self::new()
    }
}

impl DashboardPanel {
    pub fn new() -> Self {
        Self {
            data: DashboardData::default(),
            tab: 0,
            loading: true,
            logs: Vec::new(),
        }
    }

    pub fn next_tab(&mut self) {
        self.tab = (self.tab + 1) % TABS.len();
    }

    pub fn prev_tab(&mut self) {
        self.tab = if self.tab == 0 { TABS.len() - 1 } else { self.tab - 1 };
    }

    pub fn render_themed(&self, area: Rect, buf: &mut Buffer, theme: &Theme) {
        let width = 64.min(area.width.saturating_sub(4));
        let height = 22.min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(width)) / 2;
        let y = area.y + (area.height.saturating_sub(height)) / 2;
        let popup = Rect::new(x, y, width, height);

        Clear.render(popup, buf);
        for row in popup.y..popup.y + popup.height {
            for col in popup.x..popup.x + popup.width {
                if col < buf.area().width && row < buf.area().height {
                    buf[(col, row)].set_bg(theme.dialog_bg);
                }
            }
        }

        let block = Block::default()
            .title(" Dashboard (F2) ")
            .title_style(Style::default().fg(theme.accent).add_modifier(Modifier::BOLD))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.accent));

        let inner = block.inner(popup);
        block.render(popup, buf);

        let mut lines = Vec::new();

        // Tab bar
        let mut tab_spans = vec![Span::styled(" ", Style::default())];
        for (i, name) in TABS.iter().enumerate() {
            if i == self.tab {
                tab_spans.push(Span::styled(
                    format!(" {name} "),
                    chrome::selected_primary(theme),
                ));
            } else {
                tab_spans.push(Span::styled(
                    format!(" {name} "),
                    Style::default().fg(theme.muted),
                ));
            }
            tab_spans.push(Span::styled(" ", Style::default()));
        }
        lines.push(Line::from(tab_spans));
        lines.push(Line::from(""));

        if self.loading {
            lines.push(Line::from(Span::styled(
                "  Loading...",
                Style::default().fg(theme.muted),
            )));
        } else {
            match self.tab {
                0 => self.render_memory(&mut lines, theme),
                1 => self.render_pipeline(&mut lines, theme),
                2 => self.render_embedding(&mut lines, theme),
                3 => self.render_diagnostics(&mut lines, theme),
                4 => self.render_logs(&mut lines, theme),
                _ => {}
            }
        }

        // Footer
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            " ←/→ tabs  R refresh  Esc close",
            Style::default().fg(theme.muted),
        )));

        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        paragraph.render(inner, buf);
    }

    fn render_memory(&self, lines: &mut Vec<Line>, theme: &Theme) {
        let d = &self.data.memory;
        let label = Style::default().fg(theme.muted);
        let val = Style::default().fg(theme.fg);
        let accent = Style::default().fg(theme.accent);

        lines.push(Line::from(vec![
            Span::styled("  Total memories:  ", label),
            Span::styled(format!("{}", d.total), val),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  With embeddings: ", label),
            Span::styled(format!("{}", d.embedded), val),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Critical:        ", label),
            Span::styled(format!("{}", d.critical), accent),
        ]));

        let coverage = if d.total > 0 {
            (d.embedded as f64 / d.total as f64) * 100.0
        } else {
            0.0
        };
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::styled("  Coverage:        ", label),
            Span::styled(format!("{:.1}%", coverage), if coverage > 90.0 {
                Style::default().fg(theme.success)
            } else {
                Style::default().fg(theme.warning)
            }),
        ]));
    }

    fn render_pipeline(&self, lines: &mut Vec<Line>, theme: &Theme) {
        let d = &self.data.pipeline;
        let label = Style::default().fg(theme.muted);
        let val = Style::default().fg(theme.fg);

        let mode_style = status_style(theme, d.mode.as_str(), None);

        lines.push(Line::from(vec![
            Span::styled("  Mode:      ", label),
            Span::styled(format!("{} {}", status_glyph(d.mode.as_str()), d.mode), mode_style),
        ]));
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled("  Job Queue", Style::default().fg(theme.accent))));
        lines.push(Line::from(vec![
            Span::styled("  Pending:   ", label),
            Span::styled(format!("{}", d.pending), val),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Leased:    ", label),
            Span::styled(format!("{}", d.leased), val),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Completed: ", label),
            Span::styled(format!("{}", d.completed), Style::default().fg(theme.success)),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Failed:    ", label),
            Span::styled(format!("{}", d.failed), if d.failed > 0 {
                Style::default().fg(theme.warning)
            } else { val }),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Dead:      ", label),
            Span::styled(format!("{}", d.dead), if d.dead > 0 {
                Style::default().fg(theme.error)
            } else { val }),
        ]));
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled("  Predictor", Style::default().fg(theme.accent))));
        lines.push(Line::from(vec![
            Span::styled("  Ready:     ", label),
            Span::styled(
                if d.predictor_ready { "Yes" } else { "No" },
                if d.predictor_ready { Style::default().fg(theme.success) } else { Style::default().fg(theme.muted) },
            ),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Alpha:     ", label),
            Span::styled(format!("{:.2}", d.predictor_alpha), val),
        ]));
    }

    fn render_embedding(&self, lines: &mut Vec<Line>, theme: &Theme) {
        let d = &self.data.embedding;
        let label = Style::default().fg(theme.muted);
        let val = Style::default().fg(theme.fg);

        let status_style_embed = status_style(theme, d.status.as_str(), Some(d.score));

        lines.push(Line::from(vec![
            Span::styled("  Status:     ", label),
            Span::styled(format!("{} {}", status_glyph(d.status.as_str()), d.status), status_style_embed),
            Span::styled(format!("  (score: {:.0}%)", d.score * 100.0), Style::default().fg(theme.muted)),
        ]));
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::styled("  Provider:   ", label),
            Span::styled(d.provider.clone(), val),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Model:      ", label),
            Span::styled(d.model.clone(), val),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Dimensions: ", label),
            Span::styled(format!("{}", d.dimensions), val),
        ]));
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::styled("  Coverage:   ", label),
            Span::styled(
                format!("{:.1}%", d.coverage),
                if d.coverage > 90.0 { status_style(theme, "healthy", None) } else { status_style(theme, "degraded", None) },
            ),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Unembedded: ", label),
            Span::styled(format!("{}", d.unembedded), if d.unembedded > 0 {
                Style::default().fg(theme.warning)
            } else { val }),
        ]));
    }

    fn render_diagnostics(&self, lines: &mut Vec<Line>, theme: &Theme) {
        let d = &self.data.diagnostics;
        let label = Style::default().fg(theme.muted);

        let diag_style = status_style(theme, d.status.as_str(), Some(d.score));

        lines.push(Line::from(vec![
            Span::styled("  System Health", Style::default().fg(theme.accent).add_modifier(Modifier::BOLD)),
        ]));
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::styled("  Status: ", label),
            Span::styled(format!("{} {}", status_glyph(d.status.as_str()), d.status), diag_style),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Score:  ", label),
            Span::styled(format!("{:.0}%", d.score * 100.0), diag_style),
        ]));
    }

    fn render_logs(&self, lines: &mut Vec<Line>, theme: &Theme) {
        if self.logs.is_empty() {
            lines.push(Line::from(Span::styled(
                "  No log entries (SSE stream connecting...)",
                Style::default().fg(theme.muted),
            )));
        } else {
            // Show last entries that fit
            let max = 14;
            let start = self.logs.len().saturating_sub(max);
            for log in &self.logs[start..] {
                // Try to parse JSON for pretty display
                let display = if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(log) {
                    let level = parsed.get("level").and_then(|v| v.as_str()).unwrap_or("");
                    let cat = parsed.get("category").and_then(|v| v.as_str()).unwrap_or("");
                    let msg = parsed.get("message").and_then(|v| v.as_str()).unwrap_or(log);
                    format!("  [{level}] [{cat}] {msg}")
                } else {
                    format!("  {log}")
                };
                let color = if display.contains("[warn]") {
                    theme.warning
                } else if display.contains("[error]") {
                    theme.error
                } else {
                    theme.fg
                };
                lines.push(Line::from(Span::styled(display, Style::default().fg(color))));
            }
        }
    }
}

/// Parse daemon API responses into DashboardData
pub fn parse_dashboard(
    memories: Option<&serde_json::Value>,
    pipeline: Option<&serde_json::Value>,
    embedding: Option<&serde_json::Value>,
    diagnostics: Option<&serde_json::Value>,
) -> DashboardData {
    let mut data = DashboardData::default();

    if let Some(m) = memories {
        if let Some(stats) = m.get("stats") {
            data.memory.total = stats.get("total").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            data.memory.embedded = stats.get("withEmbeddings").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            data.memory.critical = stats.get("critical").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        }
    }

    if let Some(p) = pipeline {
        data.pipeline.mode = p.get("mode").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
        if let Some(q) = p.get("queues").and_then(|v| v.get("memory")) {
            data.pipeline.pending = q.get("pending").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            data.pipeline.leased = q.get("leased").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            data.pipeline.completed = q.get("completed").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            data.pipeline.failed = q.get("failed").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            data.pipeline.dead = q.get("dead").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        }
        if let Some(pred) = p.get("predictor") {
            data.pipeline.predictor_ready = pred.get("modelReady").and_then(|v| v.as_bool()).unwrap_or(false);
            data.pipeline.predictor_alpha = pred.get("alpha").and_then(|v| v.as_f64()).unwrap_or(0.0);
        }
    }

    if let Some(e) = embedding {
        data.embedding.status = e.get("status").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
        data.embedding.score = e.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if let Some(cfg) = e.get("config") {
            data.embedding.provider = cfg.get("provider").and_then(|v| v.as_str()).unwrap_or("").to_string();
            data.embedding.model = cfg.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
            data.embedding.dimensions = cfg.get("dimensions").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        }
        for check in e.get("checks").and_then(|v| v.as_array()).into_iter().flatten() {
            if check.get("name").and_then(|v| v.as_str()) == Some("coverage") {
                if let Some(detail) = check.get("detail") {
                    data.embedding.coverage = detail.get("coverage").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    data.embedding.unembedded = detail.get("unembedded").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                }
            }
        }
    }

    if let Some(d) = diagnostics {
        if let Some(comp) = d.get("composite") {
            data.diagnostics.score = comp.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
            data.diagnostics.status = comp.get("status").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
        }
    }

    data
}


fn status_style(theme: &Theme, status: &str, score: Option<f64>) -> Style {
    let normalized = status.to_ascii_lowercase();
    let color = match normalized.as_str() {
        "healthy" | "ok" | "ready" => theme.success,
        "degraded" | "warning" | "shadow" => theme.warning,
        "error" | "failed" | "dead" | "frozen" | "unhealthy" => theme.error,
        _ => match score {
            Some(s) if s >= 0.9 => theme.success,
            Some(s) if s >= 0.7 => theme.warning,
            Some(_) => theme.error,
            None => theme.muted,
        },
    };
    Style::default().fg(color).add_modifier(Modifier::BOLD)
}

fn status_glyph(status: &str) -> &'static str {
    match status.to_ascii_lowercase().as_str() {
        "healthy" | "ok" | "ready" => "●",
        "degraded" | "warning" | "shadow" => "◐",
        "error" | "failed" | "dead" | "frozen" | "unhealthy" => "◆",
        _ => "•",
    }
}
