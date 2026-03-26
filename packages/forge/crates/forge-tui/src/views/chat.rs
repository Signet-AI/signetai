use crate::theme::Theme;
use crate::widgets::markdown::render_markdown;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Widget, Wrap},
};

/// A single entry in the chat view
#[derive(Debug, Clone)]
pub enum ChatEntry {
    UserMessage(String),
    AssistantText(String),
    ToolCall {
        name: String,
        status: ToolStatus,
        detail: Option<String>,
    },
    ToolOutput {
        name: String,
        output: String,
        is_error: bool,
    },
    Error(String),
    Status(String),
    /// Command output that clears when user starts typing
    Ephemeral(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ToolStatus {
    Running,
    Complete,
    Error,
}

/// The main chat view widget
pub struct ChatView<'a> {
    pub entries: &'a [ChatEntry],
    pub streaming_text: &'a str,
    pub scroll_offset: u16,
    /// Animated status line (rendered below streaming text when processing)
    pub activity_line: Option<String>,
    /// Agent display name from IDENTITY.md
    pub agent_name: &'a str,
    /// Total memories in Signet (for welcome screen readout)
    pub total_memories: usize,
    /// Animation tick counter (for blinking cursor)
    pub tick: usize,
    /// Active color theme
    pub theme: &'a Theme,
}

impl<'a> Widget for ChatView<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let t = self.theme;
        let mut lines: Vec<Line> = Vec::new();

        // Top padding — gap between status bar and chat content
        lines.push(Line::from(""));
        lines.push(Line::from(""));

        // Welcome screen — your agent is here, waiting
        if self.entries.is_empty() && self.streaming_text.is_empty() {
            let w = area.width as usize;
            let center = |s: &str| -> String {
                use unicode_width::UnicodeWidthStr;
                let display_w = s.width();
                let pad = w.saturating_sub(display_w) / 2;
                format!("{}{s}", " ".repeat(pad))
            };

            // Vertical centering
            let content_height = 15;
            let pad = (area.height as usize).saturating_sub(content_height) / 3;
            for _ in 0..pad {
                lines.push(Line::from(""));
            }

            // The embers — Forge's geometric heartbeat
            lines.push(Line::from(Span::styled(
                center("◇  ◈  ◆  ◈  ◇"),
                Style::default().fg(t.spinner),
            )));
            lines.push(Line::from(""));

            // FORGE — spaced, heavy
            lines.push(Line::from(Span::styled(
                center("F O R G E"),
                Style::default().fg(t.fg_bright).add_modifier(Modifier::BOLD),
            )));

            // Your agent — the soul of this session
            let name = self.agent_name;
            lines.push(Line::from(Span::styled(
                center(name),
                Style::default().fg(t.accent),
            )));

            lines.push(Line::from(""));

            // Separator — visible
            let rule_width = 32.min(w.saturating_sub(4));
            let rule = "─".repeat(rule_width);
            lines.push(Line::from(Span::styled(
                center(&rule),
                Style::default().fg(t.muted),
            )));
            lines.push(Line::from(""));

            // The readout — what's loaded, what's alive
            let mem_line = if self.total_memories > 0 {
                format!("▸ {} memories loaded", self.total_memories)
            } else {
                "▸ memory standing by".to_string()
            };
            lines.push(Line::from(Span::styled(
                center(&mem_line),
                Style::default().fg(t.fg),
            )));
            lines.push(Line::from(Span::styled(
                center("▸ identity forged · soul intact"),
                Style::default().fg(t.fg),
            )));

            lines.push(Line::from(""));

            lines.push(Line::from(Span::styled(
                center(&rule),
                Style::default().fg(t.muted),
            )));
            lines.push(Line::from(""));

            // The invitation — Signet-themed, rotates per session
            let messages: &[&str] = &[
                "the fire's lit.",
                "memory is presence.",
                "identity runs deep.",
                "forged, not configured.",
                "your agent remembers.",
                "built different.",
                "soul loaded.",
                "every session leaves a mark.",
            ];
            // Pick one based on memory count so it varies per user state
            let idx = self.total_memories % messages.len();
            let greeting = messages[idx];
            lines.push(Line::from(Span::styled(
                center(greeting),
                Style::default().fg(t.spinner),
            )));
        }

        for entry in self.entries {
            match entry {
                ChatEntry::UserMessage(text) => {
                    lines.push(Line::from(""));
                    let mut first = true;
                    for line in text.lines() {
                        if first {
                            lines.push(Line::from(vec![
                                Span::styled(
                                    "  ❯ ",
                                    Style::default()
                                        .fg(t.accent)
                                        .add_modifier(Modifier::BOLD),
                                ),
                                Span::styled(
                                    line,
                                    Style::default()
                                        .fg(t.fg_bright)
                                        .add_modifier(Modifier::BOLD),
                                ),
                            ]));
                            first = false;
                        } else {
                            lines.push(Line::from(Span::styled(
                                format!("    {line}"),
                                Style::default().fg(t.fg_bright),
                            )));
                        }
                    }
                }
                ChatEntry::AssistantText(text) => {
                    lines.push(Line::from(""));
                    lines.push(Line::from(vec![
                        Span::styled(
                            "  ◆ ",
                            Style::default().fg(t.accent),
                        ),
                        Span::styled(
                            self.agent_name,
                            Style::default()
                                .fg(t.accent)
                                .add_modifier(Modifier::BOLD),
                        ),
                    ]));
                    let md_lines = render_markdown(text, t);
                    for md_line in md_lines {
                        let mut indented_spans = vec![Span::raw("    ")];
                        indented_spans.extend(md_line.spans);
                        lines.push(Line::from(indented_spans));
                    }
                }
                ChatEntry::Ephemeral(text) => {
                    lines.push(Line::from(""));
                    let md_lines = render_markdown(text, t);
                    for md_line in md_lines {
                        let mut indented_spans = vec![Span::raw("    ")];
                        indented_spans.extend(md_line.spans);
                        lines.push(Line::from(indented_spans));
                    }
                }
                ChatEntry::ToolCall { name, status, detail } => {
                    let (indicator, color) = match status {
                        ToolStatus::Running => ("⟳", t.warning),
                        ToolStatus::Complete => ("✓", t.success),
                        ToolStatus::Error => ("✗", t.error),
                    };
                    let mut spans = vec![
                        Span::styled("    ", Style::default()),
                        Span::styled(indicator, Style::default().fg(color)),
                        Span::styled(" ", Style::default()),
                        Span::styled(
                            name,
                            Style::default()
                                .fg(t.tool)
                                .add_modifier(Modifier::BOLD),
                        ),
                    ];
                    if let Some(d) = detail {
                        spans.push(Span::styled(
                            format!(" {d}"),
                            Style::default().fg(t.muted),
                        ));
                    }
                    lines.push(Line::from(spans));
                }
                ChatEntry::ToolOutput {
                    name, output, is_error,
                } => {
                    let style = if *is_error {
                        Style::default().fg(t.error)
                    } else {
                        Style::default().fg(t.muted)
                    };
                    let is_grep = name.to_lowercase() == "grep";
                    let max_lines = 15;
                    for line in output.lines().take(max_lines) {
                        let display = if line.len() > 120 {
                            let boundary = line
                                .char_indices()
                                .take_while(|(i, _)| *i <= 117)
                                .last()
                                .map(|(i, c)| i + c.len_utf8())
                                .unwrap_or(117.min(line.len()));
                            format!("{}...", &line[..boundary])
                        } else {
                            line.to_string()
                        };
                        // Grep output: highlight file:line prefix
                        if is_grep && !*is_error {
                            if let Some(colon) = display.find(':') {
                                let file_part = display[..colon].to_string();
                                let rest = display[colon..].to_string();
                                lines.push(Line::from(vec![
                                    Span::styled("      │ ", Style::default().fg(t.border)),
                                    Span::styled(file_part, Style::default().fg(t.fg_bright)),
                                    Span::styled(rest, style),
                                ]));
                                continue;
                            }
                        }
                        lines.push(Line::from(vec![
                            Span::styled("      │ ", Style::default().fg(t.border)),
                            Span::styled(display, style),
                        ]));
                    }
                    let total_lines = output.lines().count();
                    if total_lines > max_lines {
                        lines.push(Line::from(vec![
                            Span::styled("      └ ", Style::default().fg(t.border)),
                            Span::styled(
                                format!("{} more lines", total_lines - max_lines),
                                Style::default().fg(t.muted),
                            ),
                        ]));
                    }
                }
                ChatEntry::Error(msg) => {
                    lines.push(Line::from(""));
                    lines.push(Line::from(vec![
                        Span::styled("  ✗ ", Style::default().fg(t.error)),
                        Span::styled(
                            msg,
                            Style::default().fg(t.error).add_modifier(Modifier::BOLD),
                        ),
                    ]));
                }
                ChatEntry::Status(msg) => {
                    lines.push(Line::from(Span::styled(
                        format!("    {msg}"),
                        Style::default().fg(t.muted),
                    )));
                }
            }
        }

        // Streaming text (currently being generated)
        if !self.streaming_text.is_empty() {
            lines.push(Line::from(""));
            lines.push(Line::from(vec![
                Span::styled(
                    "  ◆ ",
                    Style::default().fg(t.accent),
                ),
                Span::styled(
                    self.agent_name,
                    Style::default()
                        .fg(t.accent)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            let md_lines = render_markdown(self.streaming_text, t);
            for md_line in md_lines {
                let mut indented_spans = vec![Span::raw("    ")];
                indented_spans.extend(md_line.spans);
                lines.push(Line::from(indented_spans));
            }
            // Streaming cursor — tighter and less jumpy than a full blink dot
            let cursor = match self.tick % 6 {
                0 | 1 => "▏",
                2 | 3 => "▎",
                _ => "▍",
            };
            lines.push(Line::from(Span::styled(
                format!("    {cursor}"),
                Style::default().fg(t.spinner),
            )));
        }

        // Activity indicator (animated spinner during processing)
        if let Some(activity) = &self.activity_line {
            if !activity.is_empty() {
                lines.push(Line::from(""));
                lines.push(Line::from(Span::styled(
                    activity.clone(),
                    Style::default().fg(t.spinner),
                )));
            }
        }

        // Bottom padding — breathing room between content and input box
        lines.push(Line::from(""));
        lines.push(Line::from(""));

        // Measure actual wrapped height by rendering to a hidden buffer.
        // This gives the exact line count ratatui produces — no estimation.
        // Cap at 2000 rows to avoid excessive memory per frame.
        use unicode_width::UnicodeWidthStr;
        let est: u16 = lines.iter().map(|line| {
            let w: usize = line.spans.iter().map(|s| s.content.width()).sum();
            let width = area.width as usize;
            if width == 0 { 1u16 } else { 1u16.max((w / width + 2) as u16) }
        }).sum();
        let max_h = est.min(2000).max(area.height);
        let measure = Paragraph::new(lines.clone()).wrap(Wrap { trim: false });
        let tall = Rect::new(0, 0, area.width, max_h);
        let mut hidden = Buffer::empty(tall);
        measure.render(tall, &mut hidden);
        // Find the last non-empty row
        let total = (0..max_h)
            .rev()
            .find(|&row| {
                (0..area.width.min(5)).any(|col| {
                    let cell = &hidden[(col, row)];
                    cell.symbol() != " "
                })
            })
            .map(|row| row + 1)
            .unwrap_or(0);

        let scroll = if self.scroll_offset == 0 {
            total.saturating_sub(area.height)
        } else {
            total
                .saturating_sub(area.height)
                .saturating_sub(self.scroll_offset)
        };

        let paragraph = Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0));

        paragraph.render(area, buf);
    }
}
