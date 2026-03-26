use crate::{chrome, theme::Theme};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap},
};

#[derive(Debug, Clone)]
pub struct McpServerCommand {
    pub server_id: String,
    pub server_name: String,
    pub description: String,
}

#[derive(Debug, Clone)]
pub struct McpToolCommand {
    pub server_id: String,
    pub server_name: String,
    pub tool_name: String,
    pub description: String,
}

/// A Signet diagnostic/management command
#[derive(Debug, Clone)]
pub struct SignetCommand {
    pub key: String,
    pub label: String,
    pub description: String,
    pub kind: CommandKind,
}

#[derive(Debug, Clone)]
pub enum CommandKind {
    Cli(Vec<String>),
    ApiGet(String),
    ApiPost(String),
    Internal(String),
    Skill {
        name: String,
        content: String,
    },
    McpServer {
        server_id: String,
        server_name: String,
    },
    McpTool {
        server_id: String,
        server_name: String,
        tool_name: String,
    },
}

fn cmd(key: &str, label: &str, description: &str, kind: CommandKind) -> SignetCommand {
    SignetCommand {
        key: key.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        kind,
    }
}

pub fn built_in_commands() -> Vec<SignetCommand> {
    vec![
        cmd("help", "/help", "Show all available commands", CommandKind::Internal("help".into())),
        cmd("signet-help", "/signet-help", "Show all Signet commands", CommandKind::Internal("help".into())),
        cmd("clear", "/clear", "Clear the chat history", CommandKind::Internal("clear".into())),
        cmd("model", "/model", "Open model picker (same as Ctrl+O)", CommandKind::Internal("model".into())),
        cmd("compact", "/compact", "Force context compaction", CommandKind::Internal("compact".into())),
        cmd("resume", "/resume", "Resume the last saved session", CommandKind::Internal("resume".into())),
        cmd(
            "import-claude",
            "/import-claude",
            "Import conversation history from Claude Code",
            CommandKind::Internal("import-claude".into()),
        ),
        cmd("dashboard", "/dashboard", "Open Signet dashboard in browser", CommandKind::Internal("dashboard".into())),
        cmd("theme", "/theme <name>", "Switch theme (signet-dark, signet-light, midnight, amber)", CommandKind::Internal("theme".into())),
        cmd("auth", "/auth", "Show provider auth setup instructions", CommandKind::Internal("auth".into())),
        cmd("effort", "/effort <level>", "Set reasoning effort (low, medium, high)", CommandKind::Internal("effort".into())),
        cmd("forge-bypass", "/forge-bypass", "Toggle CLI permission bypass (skip all approval prompts)", CommandKind::Internal("forge-bypass".into())),
        cmd("keybinds", "/keybinds", "Show current key bindings (edit ~/.config/forge/keybinds.json)", CommandKind::Internal("keybinds".into())),
        cmd("extraction-model", "/extraction-model <model>", "View or change the Signet extraction pipeline model", CommandKind::Internal("extraction-model".into())),
        cmd("agent", "/agent", "Show current agent identity and ID", CommandKind::Internal("agent".into())),
        cmd("signet-save-agent", "/signet-save-agent <path>", "Export your entire Signet agent to a zip file", CommandKind::Internal("signet-save-agent".into())),
        cmd("forge-usage", "/forge-usage", "Show token usage across Codex and Claude Code", CommandKind::Internal("forge-usage".into())),
        cmd("status", "/status", "Show agent and daemon status", CommandKind::Cli(vec!["status".into()])),
        cmd("doctor", "/doctor", "Run health checks and suggest fixes", CommandKind::Cli(vec!["doctor".into()])),
        cmd("logs", "/logs", "View last 50 daemon log lines", CommandKind::Cli(vec!["daemon".into(), "logs".into(), "--lines".into(), "50".into()])),
        cmd("health", "/health", "Full daemon health report", CommandKind::ApiGet("/health".into())),
        cmd("diagnostics", "/diagnostics", "Composite health score across all domains", CommandKind::ApiGet("/api/diagnostics".into())),
        cmd("recall", "/recall <query>", "Search memories by query", CommandKind::Cli(vec!["recall".into()])),
        cmd("remember", "/remember <text>", "Store a new memory", CommandKind::Cli(vec!["remember".into()])),
        cmd("recall-test", "/recall-test", "Test memory search with a sample query", CommandKind::Cli(vec!["recall".into(), "test".into(), "query".into()])),
        cmd("embed-audit", "/embed-audit", "Audit embedding coverage and health", CommandKind::Cli(vec!["embed".into(), "audit".into()])),
        cmd("embed-backfill", "/embed-backfill", "Backfill missing embeddings", CommandKind::Cli(vec!["embed".into(), "backfill".into()])),
        cmd("skill-list", "/skill-list", "List installed skills", CommandKind::Cli(vec!["skill".into(), "list".into()])),
        cmd("secret-list", "/secret-list", "List configured secrets", CommandKind::Cli(vec!["secret".into(), "list".into()])),
        cmd("sync", "/sync", "Sync built-in templates and skills", CommandKind::Cli(vec!["sync".into()])),
        cmd("daemon-restart", "/daemon-restart", "Restart the Signet daemon", CommandKind::Cli(vec!["daemon".into(), "restart".into()])),
        cmd("daemon-stop", "/daemon-stop", "Stop the Signet daemon", CommandKind::Cli(vec!["daemon".into(), "stop".into()])),
        cmd("repair-requeue", "/repair-requeue", "Requeue dead extraction jobs", CommandKind::ApiPost("/api/repair/requeue-dead".into())),
        cmd("repair-leases", "/repair-leases", "Release stale job leases", CommandKind::ApiPost("/api/repair/release-leases".into())),
        cmd("repair-fts", "/repair-fts", "Check and repair FTS search index", CommandKind::ApiPost("/api/repair/check-fts".into())),
        cmd("pipeline", "/pipeline", "Show extraction pipeline status", CommandKind::ApiGet("/api/pipeline/status".into())),
    ]
}

pub fn commands_with_dynamic(
    skills: &[forge_signet::Skill],
    mcp_servers: &[McpServerCommand],
    mcp_tools: &[McpToolCommand],
) -> Vec<SignetCommand> {
    let mut commands = built_in_commands();

    for skill in skills.iter().filter(|s| s.user_invocable) {
        let label = if let Some(hint) = &skill.arg_hint {
            format!("/{} {}", skill.name, hint)
        } else {
            format!("/{}", skill.name)
        };
        commands.push(SignetCommand {
            key: skill.name.clone(),
            label,
            description: if skill.description.is_empty() {
                "Run installed skill".to_string()
            } else {
                skill.description.clone()
            },
            kind: CommandKind::Skill {
                name: skill.name.clone(),
                content: skill.content.clone(),
            },
        });
    }

    commands.push(cmd(
        "mcp",
        "/mcp",
        "List installed MCP slash commands and usage",
        CommandKind::Internal("mcp-help".into()),
    ));

    for server in mcp_servers {
        let key = format!("mcp-{}", server.server_id);
        let label = format!("/{} <tool> [json args]", key);
        commands.push(SignetCommand {
            key,
            label,
            description: if server.description.is_empty() {
                format!("Run tools from MCP server {}", server.server_name)
            } else {
                format!("{} [{}]", server.description, server.server_name)
            },
            kind: CommandKind::McpServer {
                server_id: server.server_id.clone(),
                server_name: server.server_name.clone(),
            },
        });
    }

    for tool in mcp_tools {
        let key = format!("mcp-{}-{}", tool.server_id, tool.tool_name.replace(['/', ' '], "-"));
        let label = format!("/{} [json args]", key);
        commands.push(SignetCommand {
            key,
            label,
            description: if tool.description.is_empty() {
                format!("Run {} on {}", tool.tool_name, tool.server_name)
            } else {
                format!("{} [{}]", tool.description, tool.server_name)
            },
            kind: CommandKind::McpTool {
                server_id: tool.server_id.clone(),
                server_name: tool.server_name.clone(),
                tool_name: tool.tool_name.clone(),
            },
        });
    }

    commands
}

/// Interactive command picker state
pub struct CommandPicker {
    pub commands: Vec<SignetCommand>,
    pub selected: usize,
    pub filter: String,
}

impl CommandPicker {
    pub fn new(commands: Vec<SignetCommand>) -> Self {
        Self {
            commands,
            selected: 0,
            filter: String::new(),
        }
    }

    pub fn filtered(&self) -> Vec<&SignetCommand> {
        if self.filter.is_empty() {
            self.commands.iter().collect()
        } else {
            let query = self.filter.to_lowercase();
            self.commands
                .iter()
                .filter(|c| {
                    c.key.to_lowercase().contains(&query)
                        || c.label.to_lowercase().contains(&query)
                        || c.description.to_lowercase().contains(&query)
                })
                .collect()
        }
    }

    pub fn move_up(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
        }
    }

    pub fn move_down(&mut self) {
        let max = self.filtered().len().saturating_sub(1);
        if self.selected < max {
            self.selected += 1;
        }
    }

    pub fn selected_command(&self) -> Option<SignetCommand> {
        self.filtered().get(self.selected).map(|c| (*c).clone())
    }

    pub fn push_char(&mut self, c: char) {
        self.filter.push(c);
        self.selected = 0;
    }

    pub fn pop_char(&mut self) {
        self.filter.pop();
        self.selected = 0;
    }

    pub fn render_themed(&self, area: Rect, buf: &mut Buffer, theme: &Theme) {
        let width = 60.min(area.width.saturating_sub(4));
        let height = 22.min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(width)) / 2;
        let y = area.y + (area.height.saturating_sub(height)) / 2;
        let popup = Rect::new(x, y, width, height);

        Clear.render(popup, buf);
        chrome::render_overlay_chrome(buf, popup, theme);

        let block = Block::default()
            .title(" Signet Commands (Ctrl+G) ")
            .title_style(Style::default().fg(theme.accent).add_modifier(Modifier::BOLD))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.accent));

        let inner = block.inner(popup);
        block.render(popup, buf);

        let mut lines = Vec::new();
        let filter_display = if self.filter.is_empty() {
            "  Type to filter...".to_string()
        } else {
            format!("  Filter: {}_", self.filter)
        };
        lines.push(Line::from(Span::styled(
            filter_display,
            Style::default().fg(theme.muted),
        )));
        lines.push(Line::from(""));

        let filtered = self.filtered();
        let list_capacity = popup.height.saturating_sub(6) as usize;
        let (start, end) = chrome::visible_window(filtered.len(), self.selected, list_capacity);
        if start > 0 {
            lines.push(Line::from(Span::styled(
                format!("  ↑ {} more", start),
                Style::default().fg(theme.muted),
            )));
        }
        for (i, cmd) in filtered.iter().enumerate().skip(start).take(end.saturating_sub(start)) {
            let is_selected = i == self.selected;
            let marker = if is_selected { "▸" } else { " " };

            if is_selected {
                lines.push(Line::from(vec![
                    Span::styled(
                        format!(" {marker} "),
                        chrome::selected_marker(theme),
                    ),
                    Span::styled(
                        format!("{:<24}", cmd.label),
                        chrome::selected_primary(theme),
                    ),
                    Span::styled(
                        cmd.description.clone(),
                        chrome::selected_secondary(theme),
                    ),
                ]));
            } else {
                lines.push(Line::from(vec![
                    Span::raw(format!(" {marker} ")),
                    Span::styled(format!("{:<24}", cmd.label), Style::default().fg(theme.fg)),
                    Span::styled(cmd.description.clone(), Style::default().fg(theme.muted)),
                ]));
            }
        }

        if filtered.is_empty() {
            lines.push(Line::from(Span::styled(
                "  No matching commands",
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
            format!(" ↑/↓ navigate  Enter run  Esc close   {}/{}", self.selected.saturating_add(1).min(filtered.len()), filtered.len()),
            Style::default().fg(theme.muted),
        )));

        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        paragraph.render(inner, buf);
    }
}

pub fn help_text(commands: &[SignetCommand]) -> String {
    let mut text = String::new();
    text.push_str("◆ Signet Commands\n\n");

    let sections = [
        ("Core", vec!["help", "signet-help", "clear", "model", "compact", "resume", "dashboard", "theme", "auth", "effort"]),
        ("Status & Diagnostics", vec!["status", "doctor", "logs", "health", "diagnostics"]),
        ("Memory", vec!["recall", "remember", "recall-test"]),
        ("Embeddings", vec!["embed-audit", "embed-backfill"]),
        ("Management", vec!["skill-list", "secret-list", "sync", "pipeline", "agent", "signet-save-agent", "forge-usage"]),
        ("Daemon", vec!["daemon-restart", "daemon-stop"]),
        ("Repair", vec!["repair-requeue", "repair-leases", "repair-fts"]),
    ];

    for (title, keys) in sections {
        text.push_str(&format!("  {title}:\n"));
        for cmd in commands.iter().filter(|c| keys.iter().any(|k| *k == c.key)) {
            text.push_str(&format!("    {:<28} {}\n", cmd.label, cmd.description));
        }
        text.push('\n');
    }

    let dynamic_skills: Vec<&SignetCommand> = commands
        .iter()
        .filter(|c| matches!(c.kind, CommandKind::Skill { .. }))
        .collect();
    if !dynamic_skills.is_empty() {
        text.push_str("  Installed Skills:\n");
        for cmd in dynamic_skills {
            text.push_str(&format!("    {:<28} {}\n", cmd.label, cmd.description));
        }
        text.push('\n');
    }

    let dynamic_mcp: Vec<&SignetCommand> = commands
        .iter()
        .filter(|c| matches!(c.kind, CommandKind::McpServer { .. } | CommandKind::McpTool { .. }))
        .collect();
    if !dynamic_mcp.is_empty() {
        text.push_str("  MCP Commands:\n");
        for cmd in dynamic_mcp {
            text.push_str(&format!("    {:<28} {}\n", cmd.label, cmd.description));
        }
        text.push('\n');
    }

    text.push_str("  Press Ctrl+G to open the interactive command picker.\n");
    text
}

struct ArgSuggestion {
    value: &'static str,
    description: &'static str,
}

const EFFORT_ARGS: &[ArgSuggestion] = &[
    ArgSuggestion { value: "low", description: "Minimal reasoning, fast responses" },
    ArgSuggestion { value: "medium", description: "Balanced reasoning (default)" },
    ArgSuggestion { value: "high", description: "Deep reasoning, slower responses" },
];

const THEME_ARGS: &[ArgSuggestion] = &[
    ArgSuggestion { value: "signet-dark", description: "Industrial monochrome (default)" },
    ArgSuggestion { value: "signet-light", description: "Warm beige, never pure white" },
    ArgSuggestion { value: "midnight", description: "Deep blue-black, cool accents" },
    ArgSuggestion { value: "amber", description: "Warm retro terminal" },
];

pub fn render_autocomplete(
    input: &str,
    commands: &[SignetCommand],
    area: Rect,
    buf: &mut Buffer,
    theme: &Theme,
) {
    let query = input.trim_start_matches('/');
    if query.is_empty() {
        render_suggestions(commands, area, buf, theme);
        return;
    }

    if let Some((cmd, arg_prefix)) = query.split_once(' ') {
        let arg_lower = arg_prefix.to_lowercase();
        match cmd {
            "effort" => {
                let filtered: Vec<&ArgSuggestion> = EFFORT_ARGS.iter()
                    .filter(|a| arg_lower.is_empty() || a.value.starts_with(&arg_lower))
                    .collect();
                if !filtered.is_empty() {
                    render_arg_suggestions(&filtered, area, buf, theme);
                }
                return;
            }
            "theme" => {
                let filtered: Vec<&ArgSuggestion> = THEME_ARGS.iter()
                    .filter(|a| arg_lower.is_empty() || a.value.starts_with(&arg_lower))
                    .collect();
                if !filtered.is_empty() {
                    render_arg_suggestions(&filtered, area, buf, theme);
                }
                return;
            }
            "model" => {
                render_model_suggestions(&arg_lower, area, buf, theme);
                return;
            }
            _ => {}
        }
    }

    let query_lower = query.to_lowercase();
    let matches: Vec<SignetCommand> = commands
        .iter()
        .filter(|c| c.key.starts_with(&query_lower) || c.label.to_lowercase().contains(&query_lower))
        .cloned()
        .collect();

    if !matches.is_empty() {
        render_suggestions(&matches, area, buf, theme);
    }
}

fn render_suggestions(commands: &[SignetCommand], area: Rect, buf: &mut Buffer, theme: &Theme) {
    let max_show = 8.min(commands.len());
    let height = (max_show + 1) as u16;
    let width = 64u16.min(area.width.saturating_sub(4));
    let y = area.y.saturating_sub(height + 1);
    let x = area.x + 2;
    let popup = Rect::new(x, y, width, height);

    for row in popup.y..popup.y + popup.height {
        for col in popup.x..popup.x + popup.width {
            if col < buf.area().width && row < buf.area().height {
                buf[(col, row)].set_char(' ').set_bg(theme.surface);
            }
        }
    }

    for (i, cmd) in commands.iter().take(max_show).enumerate() {
        let row = popup.y + i as u16;
        if row >= buf.area().height {
            break;
        }

        let line = Line::from(vec![
            Span::styled(format!(" {:<24}", cmd.label), Style::default().fg(theme.muted)),
            Span::styled(cmd.description.clone(), Style::default().fg(theme.border)),
        ]);
        buf.set_line(popup.x, row, &line, popup.width);
    }

    if commands.len() > max_show {
        let more_row = popup.y + max_show as u16;
        if more_row < buf.area().height {
            let more = Span::styled(
                format!(" ... {} more", commands.len() - max_show),
                Style::default().fg(theme.muted),
            );
            buf.set_line(popup.x, more_row, &Line::from(more), popup.width);
        }
    }
}

fn render_arg_suggestions(args: &[&ArgSuggestion], area: Rect, buf: &mut Buffer, theme: &Theme) {
    let max_show = args.len();
    let height = (max_show + 1) as u16;
    let width = 50u16.min(area.width.saturating_sub(4));
    let y = area.y.saturating_sub(height + 1);
    let x = area.x + 2;
    let popup = Rect::new(x, y, width, height);

    for row in popup.y..popup.y + popup.height {
        for col in popup.x..popup.x + popup.width {
            if col < buf.area().width && row < buf.area().height {
                buf[(col, row)].set_char(' ').set_bg(theme.surface);
            }
        }
    }

    for (i, arg) in args.iter().enumerate() {
        let row = popup.y + i as u16;
        if row >= buf.area().height {
            break;
        }
        let line = Line::from(vec![
            Span::styled(format!(" {:<14}", arg.value), Style::default().fg(theme.fg)),
            Span::styled(arg.description, Style::default().fg(theme.muted)),
        ]);
        buf.set_line(popup.x, row, &line, popup.width);
    }
}

fn render_model_suggestions(prefix: &str, area: Rect, buf: &mut Buffer, theme: &Theme) {
    use crate::views::model_picker::ModelEntry;
    let models = super::model_picker::default_models();
    let filtered: Vec<&ModelEntry> = models
        .iter()
        .filter(|m| {
            prefix.is_empty()
                || m.display_name.to_lowercase().contains(prefix)
                || m.model.to_lowercase().contains(prefix)
                || m.provider.to_lowercase().contains(prefix)
        })
        .collect();

    if filtered.is_empty() {
        return;
    }

    let max_show = 8.min(filtered.len());
    let height = (max_show + 1) as u16;
    let width = 55u16.min(area.width.saturating_sub(4));
    let y = area.y.saturating_sub(height + 1);
    let x = area.x + 2;
    let popup = Rect::new(x, y, width, height);

    for row in popup.y..popup.y + popup.height {
        for col in popup.x..popup.x + popup.width {
            if col < buf.area().width && row < buf.area().height {
                buf[(col, row)].set_char(' ').set_bg(theme.surface);
            }
        }
    }

    for (i, model) in filtered.iter().take(max_show).enumerate() {
        let row = popup.y + i as u16;
        if row >= buf.area().height {
            break;
        }
        let line = Line::from(vec![
            Span::styled(format!(" {:<24}", model.display_name), Style::default().fg(theme.fg)),
            Span::styled(format!("({})", model.provider), Style::default().fg(theme.muted)),
        ]);
        buf.set_line(popup.x, row, &line, popup.width);
    }
}

pub fn tab_complete(input: &str, commands: &[SignetCommand]) -> Option<String> {
    let query = input.trim_start_matches('/');
    if query.is_empty() {
        return None;
    }

    if let Some((cmd, arg_prefix)) = query.split_once(' ') {
        let arg_lower = arg_prefix.to_lowercase();
        let suggestions: &[ArgSuggestion] = match cmd {
            "effort" => EFFORT_ARGS,
            "theme" => THEME_ARGS,
            _ => return None,
        };
        let matched: Vec<&ArgSuggestion> = suggestions
            .iter()
            .filter(|a| !arg_lower.is_empty() && a.value.starts_with(arg_lower.as_str()))
            .collect();
        if matched.len() == 1 {
            return Some(format!("/{cmd} {}", matched[0].value));
        }
        return None;
    }

    let query_lower = query.to_lowercase();
    let matches: Vec<SignetCommand> = commands
        .iter()
        .filter(|c| c.key.starts_with(&query_lower))
        .cloned()
        .collect();

    if matches.len() == 1 {
        Some(format!("/{}", matches[0].key))
    } else if matches.len() > 1 {
        let first = matches[0].key.clone();
        let prefix_len = first
            .char_indices()
            .take_while(|(i, c)| {
                matches.iter().all(|m| {
                    m.key.get(*i..*i + c.len_utf8()) == Some(&first[*i..*i + c.len_utf8()])
                })
            })
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        let common = &first[..prefix_len];
        if common.len() > query_lower.len() {
            Some(format!("/{common}"))
        } else {
            None
        }
    } else {
        None
    }
}
