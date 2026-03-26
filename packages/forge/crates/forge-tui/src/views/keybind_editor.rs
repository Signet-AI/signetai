use crate::keybinds::{KeyBindConfig, KEYBIND_ACTIONS};
use crate::{chrome, theme::Theme};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap},
};

/// Interactive keybind editor overlay
pub struct KeybindEditor {
    pub config: KeyBindConfig,
    pub selected: usize,
    /// When true, the next key press will be captured as the new binding
    pub capturing: bool,
    /// Status message shown at the bottom
    pub status: Option<String>,
}

impl Default for KeybindEditor {
    fn default() -> Self {
        Self::new()
    }
}

impl KeybindEditor {
    pub fn new() -> Self {
        Self {
            config: KeyBindConfig::load(),
            selected: 0,
            capturing: false,
            status: None,
        }
    }

    pub fn move_up(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
        }
    }

    pub fn move_down(&mut self) {
        let max = KEYBIND_ACTIONS.len().saturating_sub(1);
        if self.selected < max {
            self.selected += 1;
        }
    }

    pub fn start_capture(&mut self) {
        self.capturing = true;
        self.status = Some("Press new key combo...".to_string());
    }

    /// Capture a key event as the new binding for the selected action.
    /// Returns true if the key was captured, false if it should be ignored.
    pub fn capture_key(&mut self, key: KeyEvent) -> bool {
        // Escape cancels capture
        if key.code == KeyCode::Esc {
            self.capturing = false;
            self.status = Some("Cancelled.".to_string());
            return true;
        }

        let combo = format_key_event(&key);
        if combo.is_empty() {
            return true; // Ignore modifier-only presses
        }

        let (action_id, _, _) = KEYBIND_ACTIONS[self.selected];
        self.config
            .bindings
            .insert(action_id.to_string(), combo.clone());
        self.capturing = false;

        // Save to disk
        match self.config.save() {
            Ok(()) => {
                self.status = Some(format!("Saved: {} → {combo}", action_id));
            }
            Err(e) => {
                self.status = Some(format!("Save failed: {e}"));
            }
        }
        true
    }

    /// Reset the selected action to its default binding
    pub fn reset_selected(&mut self) {
        let (action_id, _, default_combo) = KEYBIND_ACTIONS[self.selected];
        self.config
            .bindings
            .insert(action_id.to_string(), default_combo.to_string());
        match self.config.save() {
            Ok(()) => {
                self.status = Some(format!("Reset: {} → {default_combo}", action_id));
            }
            Err(e) => {
                self.status = Some(format!("Save failed: {e}"));
            }
        }
    }

    pub fn render_themed(&self, area: Rect, buf: &mut Buffer, theme: &Theme) {
        let width = 54.min(area.width.saturating_sub(4));
        let height = 22.min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(width)) / 2;
        let y = area.y + (area.height.saturating_sub(height)) / 2;
        let popup = Rect::new(x, y, width, height);

        Clear.render(popup, buf);
        chrome::render_overlay_chrome(buf, popup, theme);

        let block = Block::default()
            .title(" Key Bindings ")
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

        // Column headers
        lines.push(Line::from(vec![
            Span::styled("   Action               ", Style::default().fg(theme.muted)),
            Span::styled("Binding", Style::default().fg(theme.muted)),
        ]));
        lines.push(Line::from(""));

        // Keybind rows
        for (i, (id, display, _)) in KEYBIND_ACTIONS.iter().enumerate() {
            let is_selected = i == self.selected;
            let combo = self.config.get(id);

            if is_selected {
                let bg = if self.capturing {
                    theme.warning
                } else {
                    theme.selected_bg
                };
                let marker_style = if self.capturing {
                    Style::default().fg(theme.fg_bright).bg(bg).add_modifier(Modifier::BOLD)
                } else {
                    chrome::selected_marker(theme)
                };
                let primary_style = if self.capturing {
                    Style::default().fg(theme.selected_fg).bg(bg).add_modifier(Modifier::BOLD)
                } else {
                    chrome::selected_primary(theme)
                };
                let secondary_style = if self.capturing {
                    Style::default().fg(theme.selected_fg).bg(bg)
                } else {
                    chrome::selected_secondary(theme)
                };
                lines.push(Line::from(vec![
                    Span::styled(" ▸ ", marker_style),
                    Span::styled(format!("{:<20}", display), primary_style),
                    Span::styled(combo.to_string(), secondary_style),
                ]));
            } else {
                lines.push(Line::from(vec![
                    Span::raw("   "),
                    Span::styled(
                        format!("{:<20}", display),
                        Style::default().fg(theme.fg),
                    ),
                    Span::styled(combo.to_string(), Style::default().fg(theme.accent)),
                ]));
            }
        }

        // Status / help
        lines.push(Line::from(""));
        if let Some(status) = &self.status {
            lines.push(Line::from(Span::styled(
                format!(" {status}"),
                Style::default().fg(theme.success),
            )));
        }
        lines.push(Line::from(Span::styled(
            " ↑/↓ select  Enter rebind  R reset  Esc close",
            Style::default().fg(theme.muted),
        )));

        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        paragraph.render(inner, buf);
    }
}

/// Format a KeyEvent as a human-readable combo string (e.g. "Ctrl+K")
fn format_key_event(key: &KeyEvent) -> String {
    let mut parts = Vec::new();

    if key.modifiers.contains(KeyModifiers::CONTROL) {
        parts.push("Ctrl");
    }
    if key.modifiers.contains(KeyModifiers::SHIFT) {
        parts.push("Shift");
    }

    let key_str = match key.code {
        KeyCode::Char(c) => c.to_uppercase().to_string(),
        KeyCode::Enter => "Enter".to_string(),
        KeyCode::Tab => "Tab".to_string(),
        KeyCode::Backspace => "Backspace".to_string(),
        KeyCode::Delete => "Delete".to_string(),
        KeyCode::Esc => return String::new(), // Don't capture Esc
        KeyCode::Up => "Up".to_string(),
        KeyCode::Down => "Down".to_string(),
        KeyCode::Left => "Left".to_string(),
        KeyCode::Right => "Right".to_string(),
        KeyCode::Home => "Home".to_string(),
        KeyCode::End => "End".to_string(),
        KeyCode::PageUp => "PageUp".to_string(),
        KeyCode::PageDown => "PageDown".to_string(),
        KeyCode::F(n) => format!("F{n}"),
        _ => return String::new(),
    };

    parts.push(&key_str);
    // Need to collect into owned strings for the join
    parts.join("+")
}
