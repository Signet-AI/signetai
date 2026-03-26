use crate::{chrome, theme::Theme};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap},
};

/// A dashboard page entry
#[derive(Debug, Clone)]
pub struct DashboardPage {
    pub label: &'static str,
    pub hash: &'static str,
    pub description: &'static str,
    pub group: &'static str,
}

/// All navigable dashboard pages
pub fn all_pages() -> Vec<DashboardPage> {
    vec![
        DashboardPage {
            label: "Open Dashboard",
            hash: "",
            description: "Open main dashboard in browser",
            group: "",
        },
        // Core
        DashboardPage {
            label: "Home",
            hash: "home",
            description: "Overview and status",
            group: "Core",
        },
        DashboardPage {
            label: "Settings",
            hash: "settings",
            description: "Agent configuration",
            group: "Core",
        },
        DashboardPage {
            label: "Connectors",
            hash: "connectors",
            description: "Harness connections",
            group: "Core",
        },
        // Memory
        DashboardPage {
            label: "Memory",
            hash: "memory",
            description: "Browse and search memories",
            group: "Memory",
        },
        DashboardPage {
            label: "Timeline",
            hash: "timeline",
            description: "Memory timeline view",
            group: "Memory",
        },
        DashboardPage {
            label: "Knowledge",
            hash: "knowledge",
            description: "Knowledge graph",
            group: "Memory",
        },
        DashboardPage {
            label: "Embeddings",
            hash: "embeddings",
            description: "Embedding coverage and health",
            group: "Memory",
        },
        // Engine
        DashboardPage {
            label: "Pipeline",
            hash: "pipeline",
            description: "Extraction pipeline status",
            group: "Engine",
        },
        DashboardPage {
            label: "Tasks",
            hash: "tasks",
            description: "Background task queue",
            group: "Engine",
        },
        DashboardPage {
            label: "Predictor",
            hash: "predictor",
            description: "Predictive memory scorer",
            group: "Engine",
        },
        DashboardPage {
            label: "Logs",
            hash: "logs",
            description: "Daemon log viewer",
            group: "Engine",
        },
        // Cortex
        DashboardPage {
            label: "Cortex Memory",
            hash: "cortex-memory",
            description: "Memory constellation",
            group: "Cortex",
        },
        DashboardPage {
            label: "Cortex Apps",
            hash: "cortex-apps",
            description: "Connected applications",
            group: "Cortex",
        },
        DashboardPage {
            label: "Cortex Tasks",
            hash: "cortex-tasks",
            description: "Cortex task view",
            group: "Cortex",
        },
        // Management
        DashboardPage {
            label: "Skills",
            hash: "skills",
            description: "Installed skills",
            group: "Management",
        },
        DashboardPage {
            label: "Secrets",
            hash: "secrets",
            description: "API keys and tokens",
            group: "Management",
        },
        DashboardPage {
            label: "Changelog",
            hash: "changelog",
            description: "Version history",
            group: "Management",
        },
    ]
}

/// Dashboard navigator overlay state
pub struct DashboardNav {
    pub pages: Vec<DashboardPage>,
    pub selected: usize,
}

impl Default for DashboardNav {
    fn default() -> Self {
        Self::new()
    }
}

impl DashboardNav {
    pub fn new() -> Self {
        Self {
            pages: all_pages(),
            selected: 0,
        }
    }

    pub fn move_up(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
        }
    }

    pub fn move_down(&mut self) {
        let max = self.pages.len().saturating_sub(1);
        if self.selected < max {
            self.selected += 1;
        }
    }

    pub fn page_up(&mut self, amount: usize) {
        self.selected = self.selected.saturating_sub(amount.max(1));
    }

    pub fn page_down(&mut self, amount: usize) {
        let max = self.pages.len().saturating_sub(1);
        self.selected = (self.selected + amount.max(1)).min(max);
    }

    pub fn home(&mut self) {
        self.selected = 0;
    }

    pub fn end(&mut self) {
        self.selected = self.pages.len().saturating_sub(1);
    }

    pub fn selected_page(&self) -> Option<&DashboardPage> {
        self.pages.get(self.selected)
    }

    /// Build the URL for the selected page
    pub fn selected_url(&self, base: &str) -> Option<String> {
        self.selected_page().map(|page| {
            if page.hash.is_empty() {
                base.to_string()
            } else {
                format!("{}#{}", base, page.hash)
            }
        })
    }

    pub fn render_themed(&self, area: Rect, buf: &mut Buffer, theme: &Theme) {
        let width = 56.min(area.width.saturating_sub(4));
        let height = 24.min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(width)) / 2;
        let y = area.y + 2.min(area.height.saturating_sub(height));
        let popup = Rect::new(x, y, width, height);

        Clear.render(popup, buf);
        chrome::render_overlay_chrome(buf, popup, theme);

        let block = Block::default()
            .title(" Dashboard (Ctrl+D) ")
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
        let mut last_group = "";

        let list_capacity = inner.height.saturating_sub(4) as usize;
        let (start, end) = chrome::visible_window(self.pages.len(), self.selected, list_capacity.max(1));
        if start > 0 {
            lines.push(Line::from(Span::styled(
                format!("  ↑ {} more", start),
                Style::default().fg(theme.muted),
            )));
        }

        for (i, page) in self.pages.iter().enumerate().skip(start).take(end.saturating_sub(start)) {
            let is_selected = i == self.selected;

            // Group header (skip for the first "Open Dashboard" entry)
            if !page.group.is_empty() && page.group != last_group {
                if !last_group.is_empty() || i > 1 {
                    lines.push(Line::from(""));
                }
                lines.push(Line::from(Span::styled(
                    format!("  {}", page.group),
                    Style::default()
                        .fg(theme.accent)
                        .add_modifier(Modifier::BOLD),
                )));
                last_group = page.group;
            }

            // Separator after "Open Dashboard"
            if i == 1 && last_group.is_empty() {
                lines.push(Line::from(""));
            }

            let marker = if is_selected { "▸" } else { " " };

            if is_selected {
                lines.push(Line::from(vec![
                    Span::styled(
                        format!(" {marker} "),
                        chrome::selected_marker(theme),
                    ),
                    Span::styled(
                        format!("{:<18}", page.label),
                        chrome::selected_marker(theme),
                    ),
                    Span::styled(
                        page.description,
                        chrome::selected_secondary(theme),
                    ),
                ]));
            } else {
                // First entry (Open Dashboard) gets accent treatment
                let label_style = if i == 0 {
                    Style::default()
                        .fg(theme.fg_bright)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(theme.fg)
                };

                lines.push(Line::from(vec![
                    Span::raw(format!(" {marker} ")),
                    Span::styled(format!("{:<18}", page.label), label_style),
                    Span::styled(page.description, Style::default().fg(theme.muted)),
                ]));
            }
        }

        if end < self.pages.len() {
            lines.push(Line::from(Span::styled(
                format!("  ↓ {} more", self.pages.len() - end),
                Style::default().fg(theme.muted),
            )));
        }

        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!(" ↑/↓ move  PgUp/PgDn jump  Home/End ends  Enter open   {}/{}", self.selected.saturating_add(1).min(self.pages.len()), self.pages.len()),
            Style::default().fg(theme.muted),
        )));

        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        paragraph.render(inner, buf);
    }
}
