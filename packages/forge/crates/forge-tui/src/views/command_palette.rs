use crate::{chrome, theme::Theme};
use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

/// A command entry in the palette
#[derive(Debug, Clone)]
pub struct CommandEntry {
    pub name: String,
    pub description: String,
    pub kind: CommandKind,
}

#[derive(Debug, Clone)]
pub enum CommandKind {
    /// Built-in command (e.g., clear, quit, model picker)
    BuiltIn(String),
    /// Skill slash command
    Skill(String),
}

/// State for the command palette overlay
pub struct CommandPalette {
    pub commands: Vec<CommandEntry>,
    pub selected: usize,
    pub filter: String,
}

impl CommandPalette {
    pub fn new(skills: &[forge_signet::Skill]) -> Self {
        let mut commands = vec![
            CommandEntry {
                name: "model".into(),
                description: "Switch model/provider (Ctrl+O)".into(),
                kind: CommandKind::BuiltIn("model_picker".into()),
            },
            CommandEntry {
                name: "clear".into(),
                description: "Clear chat history".into(),
                kind: CommandKind::BuiltIn("clear".into()),
            },
            CommandEntry {
                name: "quit".into(),
                description: "Quit Forge".into(),
                kind: CommandKind::BuiltIn("quit".into()),
            },
            CommandEntry {
                name: "remember".into(),
                description: "Save something to Signet memory".into(),
                kind: CommandKind::BuiltIn("remember".into()),
            },
            CommandEntry {
                name: "recall".into(),
                description: "Search Signet memories".into(),
                kind: CommandKind::BuiltIn("recall".into()),
            },
            CommandEntry {
                name: "auth".into(),
                description: "Provider auth setup instructions".into(),
                kind: CommandKind::BuiltIn("auth".into()),
            },
        ];

        // Add skills
        for skill in skills {
            if skill.user_invocable {
                commands.push(CommandEntry {
                    name: skill.name.clone(),
                    description: skill.description.clone(),
                    kind: CommandKind::Skill(skill.content.clone()),
                });
            }
        }

        Self {
            commands,
            selected: 0,
            filter: String::new(),
        }
    }

    pub fn filtered_commands(&self) -> Vec<&CommandEntry> {
        if self.filter.is_empty() {
            self.commands.iter().collect()
        } else {
            let filter_lower = self.filter.to_lowercase();
            self.commands
                .iter()
                .filter(|c| {
                    c.name.to_lowercase().contains(&filter_lower)
                        || c.description.to_lowercase().contains(&filter_lower)
                })
                .collect()
        }
    }

    pub fn selected_command(&self) -> Option<&CommandEntry> {
        let filtered = self.filtered_commands();
        filtered.get(self.selected).copied()
    }

    pub fn move_up(&mut self) {
        self.selected = self.selected.saturating_sub(1);
    }

    pub fn move_down(&mut self) {
        let max = self.filtered_commands().len().saturating_sub(1);
        self.selected = (self.selected + 1).min(max);
    }

    pub fn type_char(&mut self, c: char) {
        self.filter.push(c);
        self.selected = 0;
    }

    pub fn backspace(&mut self) {
        self.filter.pop();
        self.selected = 0;
    }

    pub fn draw(&self, frame: &mut Frame, theme: &Theme) {
        let area = frame.area();
        let width = 56u16.min(area.width.saturating_sub(4));
        let height = 18u16.min(area.height.saturating_sub(4));
        let x = (area.width.saturating_sub(width)) / 2;
        let y = 2u16.min(area.height.saturating_sub(height));
        let dialog_area = Rect::new(x, y, width, height);

        frame.render_widget(Clear, dialog_area);
        // Fill with themed dialog background
        let bg_block = Block::default().style(Style::default().bg(theme.dialog_bg));
        frame.render_widget(bg_block, dialog_area);
        chrome::render_overlay_chrome(frame.buffer_mut(), dialog_area, theme);

        let filtered = self.filtered_commands();
        let mut lines = Vec::new();

        // Search filter
        lines.push(Line::from(vec![
            Span::styled("  > ", Style::default().fg(theme.accent)),
            Span::styled(
                if self.filter.is_empty() {
                    "type to filter...".to_string()
                } else {
                    self.filter.clone()
                },
                if self.filter.is_empty() {
                    Style::default().fg(theme.muted)
                } else {
                    Style::default().fg(theme.fg)
                },
            ),
        ]));
        lines.push(Line::from(""));

        let list_capacity = dialog_area.height.saturating_sub(6) as usize;
        let (start, end) = chrome::visible_window(filtered.len(), self.selected, list_capacity);

        if start > 0 {
            lines.push(Line::from(Span::styled(
                format!("  ↑ {} more", start),
                Style::default().fg(theme.muted),
            )));
        }

        for (i, cmd) in filtered.iter().enumerate().skip(start).take(end.saturating_sub(start)) {
            let is_selected = i == self.selected;
            let style = if is_selected {
                chrome::selected_primary(theme)
            } else {
                Style::default().fg(theme.fg)
            };

            let desc_style = if is_selected {
                chrome::selected_secondary(theme)
            } else {
                Style::default().fg(theme.muted)
            };

            let kind_indicator = match &cmd.kind {
                CommandKind::BuiltIn(_) => "",
                CommandKind::Skill(_) => " [skill]",
            };

            lines.push(Line::from(vec![
                Span::styled(
                    if is_selected { " ▸ " } else { "   " },
                    if is_selected { chrome::selected_marker(theme) } else { style },
                ),
                Span::styled(format!("/{}", cmd.name), style),
                Span::styled(kind_indicator, desc_style),
                Span::styled(format!("  {}", cmd.description), desc_style),
            ]));
        }

        if filtered.is_empty() {
            lines.push(Line::from(Span::styled(
                "   No matching commands",
                Style::default().fg(theme.muted),
            )));
        }

        if end < filtered.len() {
            lines.push(Line::from(Span::styled(
                format!("  ↓ {} more", filtered.len() - end),
                Style::default().fg(theme.muted),
            )));
        }

        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!("  ↑↓ navigate  Enter select  Esc cancel   {}/{}", self.selected.saturating_add(1).min(filtered.len()), filtered.len()),
            Style::default().fg(theme.muted),
        )));

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.accent))
            .title(" Commands (^K) ")
            .title_style(Style::default().fg(theme.accent).add_modifier(Modifier::BOLD));

        let paragraph = Paragraph::new(lines).block(block);
        frame.render_widget(paragraph, dialog_area);
    }
}
