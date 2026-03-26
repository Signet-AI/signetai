use crate::{chrome, theme::Theme};
use forge_agent::history::{SavedSession, SessionStore};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap},
};

/// Session browser overlay — lists past sessions for resume
pub struct SessionBrowser {
    pub sessions: Vec<SavedSession>,
    pub selected: usize,
}

impl Default for SessionBrowser {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionBrowser {
    pub fn new() -> Self {
        let sessions = SessionStore::open()
            .ok()
            .and_then(|store| store.list_sessions(20).ok())
            .unwrap_or_default();
        Self {
            sessions,
            selected: 0,
        }
    }

    pub fn move_up(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
        }
    }

    pub fn move_down(&mut self) {
        let max = self.sessions.len().saturating_sub(1);
        if self.selected < max {
            self.selected += 1;
        }
    }

    pub fn page_up(&mut self, amount: usize) {
        self.selected = self.selected.saturating_sub(amount.max(1));
    }

    pub fn page_down(&mut self, amount: usize) {
        let max = self.sessions.len().saturating_sub(1);
        self.selected = (self.selected + amount.max(1)).min(max);
    }

    pub fn home(&mut self) {
        self.selected = 0;
    }

    pub fn end(&mut self) {
        self.selected = self.sessions.len().saturating_sub(1);
    }

    pub fn selected_session(&self) -> Option<&SavedSession> {
        self.sessions.get(self.selected)
    }

    pub fn render_themed(&self, area: Rect, buf: &mut Buffer, theme: &Theme) {
        let width = 70.min(area.width.saturating_sub(4));
        let height = 24.min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(width)) / 2;
        let y = area.y + (area.height.saturating_sub(height)) / 2;
        let popup = Rect::new(x, y, width, height);

        Clear.render(popup, buf);
        chrome::render_overlay_chrome(buf, popup, theme);

        let block = Block::default()
            .title(" Sessions (^H) ")
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

        if self.sessions.is_empty() {
            lines.push(Line::from(Span::styled(
                "  No saved sessions",
                Style::default().fg(theme.muted),
            )));
        } else {
            // Header
            lines.push(Line::from(vec![
                Span::styled("   Model                    ", Style::default().fg(theme.muted)),
                Span::styled("Msgs  Tokens  Started", Style::default().fg(theme.muted)),
            ]));
            lines.push(Line::from(""));

            let list_capacity = inner.height.saturating_sub(4) as usize;
            let (start, end) = chrome::visible_window(self.sessions.len(), self.selected, list_capacity);
            if start > 0 {
                lines.push(Line::from(Span::styled(
                    format!("  ↑ {} more", start),
                    Style::default().fg(theme.muted),
                )));
            }

            for (i, s) in self.sessions.iter().enumerate().skip(start).take(end.saturating_sub(start)) {
                let is_selected = i == self.selected;
                let model_display = if s.model.len() > 24 {
                    format!("{}...", &s.model[..21])
                } else {
                    format!("{:<24}", s.model)
                };

                let tokens = if s.total_tokens >= 1000 {
                    format!("{:.1}K", s.total_tokens as f64 / 1000.0)
                } else {
                    format!("{}", s.total_tokens)
                };

                let date = if s.started_at.len() >= 10 {
                    &s.started_at[..10]
                } else {
                    &s.started_at
                };

                let detail = format!("{:>4}  {:>6}  {}", s.message_count, tokens, date);

                if is_selected {
                    lines.push(Line::from(vec![
                        Span::styled(
                            " > ",
                            chrome::selected_marker(theme),
                        ),
                        Span::styled(
                            model_display,
                            chrome::selected_marker(theme),
                        ),
                        Span::styled(
                            detail,
                            chrome::selected_secondary(theme),
                        ),
                    ]));
                } else {
                    lines.push(Line::from(vec![
                        Span::raw("   "),
                        Span::styled(model_display, Style::default().fg(theme.fg)),
                        Span::styled(detail, Style::default().fg(theme.muted)),
                    ]));
                }
            }
        }

        if !self.sessions.is_empty() {
            let list_capacity = inner.height.saturating_sub(4) as usize;
            let (_, end) = chrome::visible_window(self.sessions.len(), self.selected, list_capacity);
            if end < self.sessions.len() {
                lines.push(Line::from(Span::styled(
                    format!("  ↓ {} more", self.sessions.len() - end),
                    Style::default().fg(theme.muted),
                )));
            }
        }

        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!(" ↑/↓ move  PgUp/PgDn jump  Home/End ends  Enter resume   {}/{}", self.selected.saturating_add(1).min(self.sessions.len()), self.sessions.len()),
            Style::default().fg(theme.muted),
        )));

        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        paragraph.render(inner, buf);
    }
}
