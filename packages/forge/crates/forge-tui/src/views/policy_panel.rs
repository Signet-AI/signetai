use crate::{chrome, theme::Theme};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap},
};

/// Policy diagnostics overlay
pub struct PolicyPanel {
    pub workspace_only: bool,
    pub allowed_paths: Vec<String>,
    pub allowed_commands: Vec<String>,
    pub approval_mode: Option<String>,
    pub current_dir: String,
    pub active_agent: Option<String>,
    pub scroll: usize,
}

impl PolicyPanel {
    pub fn new(
        workspace_only: bool,
        allowed_paths: Vec<String>,
        allowed_commands: Vec<String>,
        approval_mode: Option<String>,
        current_dir: String,
        active_agent: Option<String>,
    ) -> Self {
        Self {
            workspace_only,
            allowed_paths,
            allowed_commands,
            approval_mode,
            current_dir,
            active_agent,
            scroll: 0,
        }
    }

    pub fn scroll_up(&mut self) {
        self.scroll = self.scroll.saturating_sub(1);
    }

    pub fn scroll_down(&mut self) {
        self.scroll = self.scroll.saturating_add(1);
    }

    pub fn render_themed(&self, area: Rect, buf: &mut Buffer, theme: &Theme) {
        let width = 76u16.min(area.width.saturating_sub(4));
        let height = 26u16.min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(width)) / 2;
        let y = area.y + (area.height.saturating_sub(height)) / 2;
        let popup = Rect::new(x, y, width, height);

        Clear.render(popup, buf);
        chrome::render_overlay_chrome(buf, popup, theme);

        let block = Block::default()
            .title(" Policy Diagnostics ")
            .title_style(Style::default().fg(theme.accent).add_modifier(Modifier::BOLD))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.accent));
        let inner = block.inner(popup);
        block.render(popup, buf);

        let mut lines: Vec<Line> = Vec::new();
        let label = Style::default().fg(theme.muted);
        let value = Style::default().fg(theme.fg);

        lines.push(Line::from(vec![
            Span::styled("  Workspace lock: ", label),
            Span::styled(
                if self.workspace_only { "enabled" } else { "disabled" },
                if self.workspace_only {
                    Style::default().fg(theme.warning).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(theme.muted)
                },
            ),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Approval mode:  ", label),
            Span::styled(
                self.approval_mode.as_deref().unwrap_or("default"),
                if self.approval_mode.is_some() {
                    Style::default().fg(theme.accent)
                } else {
                    Style::default().fg(theme.muted)
                },
            ),
        ]));
        if let Some(agent) = &self.active_agent {
            lines.push(Line::from(vec![
                Span::styled("  Agent:          ", label),
                Span::styled(format!("@{agent}"), Style::default().fg(theme.accent)),
            ]));
        }
        lines.push(Line::from(vec![
            Span::styled("  CWD:            ", label),
            Span::styled(self.current_dir.clone(), value),
        ]));
        lines.push(Line::from(""));

        lines.push(Line::from(Span::styled(
            format!("  Allowed paths ({})", self.allowed_paths.len()),
            Style::default().fg(theme.fg_bright).add_modifier(Modifier::BOLD),
        )));
        if self.allowed_paths.is_empty() {
            lines.push(Line::from(Span::styled(
                "    (none)",
                Style::default().fg(theme.muted),
            )));
        } else {
            for path in &self.allowed_paths {
                lines.push(Line::from(vec![
                    Span::styled("    - ", Style::default().fg(theme.muted)),
                    Span::styled(path, value),
                ]));
            }
        }
        lines.push(Line::from(""));

        lines.push(Line::from(Span::styled(
            format!("  Allowed commands ({})", self.allowed_commands.len()),
            Style::default().fg(theme.fg_bright).add_modifier(Modifier::BOLD),
        )));
        if self.allowed_commands.is_empty() {
            lines.push(Line::from(Span::styled(
                "    (none)",
                Style::default().fg(theme.muted),
            )));
        } else {
            for cmd in &self.allowed_commands {
                lines.push(Line::from(vec![
                    Span::styled("    - ", Style::default().fg(theme.muted)),
                    Span::styled(cmd, value),
                ]));
            }
        }
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            " ↑↓ scroll  Esc close",
            Style::default().fg(theme.muted),
        )));

        let visible_height = inner.height as usize;
        let total_lines = lines.len();
        let max_scroll = total_lines.saturating_sub(visible_height);
        let scroll = self.scroll.min(max_scroll);
        let visible: Vec<Line> = lines.into_iter().skip(scroll).take(visible_height).collect();
        let paragraph = Paragraph::new(visible).wrap(Wrap { trim: false });
        paragraph.render(inner, buf);
    }
}
