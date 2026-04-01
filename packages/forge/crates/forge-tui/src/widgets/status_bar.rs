use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Widget,
};

/// Top header bar — identity + model + status
pub struct StatusBar<'a> {
    pub model: &'a str,
    pub provider: &'a str,
    pub input_tokens: usize,
    pub output_tokens: usize,
    pub context_window: usize,
    pub memories_injected: usize,
    pub total_memories: usize,
    pub total_secrets: usize,
    pub secrets_used: usize,
    pub policy_denied_count: usize,
    pub effort: &'a str,
    pub daemon_healthy: bool,
    pub active_agent: Option<&'a str>,
    pub agent_name: &'a str,
    pub policy_workspace_only: bool,
    pub policy_paths_count: usize,
    pub policy_commands_count: usize,
    pub policy_approval_mode: Option<&'a str>,
    pub keybinds: &'a crate::keybinds::KeyBindConfig,
    pub status_bg: Color,
    pub status_fg: Color,
    pub surface: Color,
    pub accent: Color,
    pub muted: Color,
    pub success: Color,
    pub error: Color,
    pub warning: Color,
    pub spinner: Color,
    pub border: Color,
}

impl<'a> Widget for StatusBar<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let muted_hi = brighten(self.muted, 34);
        let sep = Style::default().fg(muted_hi);
        let value = Style::default().fg(self.status_fg);
        let chrome = Style::default().fg(self.accent);
        let chip_bg = self.surface;
        let border = Style::default().fg(self.border);
        let border_hot = Style::default().fg(self.accent);
        let name = if self.agent_name != "Assistant" {
            self.agent_name
        } else {
            "Forge"
        };
        let health = if self.daemon_healthy { "●" } else { "○" };
        let health_color = if self.daemon_healthy { self.success } else { self.error };
        let model_short = truncate(self.model, 22);
        let provider_short = truncate(self.provider, 12);
        let tokens = format_tokens(self.input_tokens + self.output_tokens);
        let ctx = format_tokens(self.context_window);
        let mem = if self.total_memories > 0 {
            format!("{}/{}", self.memories_injected, self.total_memories)
        } else {
            format!("{}", self.memories_injected)
        };
        let effort_color = match self.effort {
            "high" => self.warning,
            "low" => muted_hi,
            _ => self.accent,
        };

        if area.height >= 1 {
            let mut left = vec![
                Span::styled(" ◈ ", Style::default().fg(self.spinner)),
                Span::styled(name.to_uppercase(), chrome.add_modifier(Modifier::BOLD)),
                Span::styled("  ", sep),
                Span::styled("operator deck", Style::default().fg(muted_hi)),
            ];
            if let Some(agent) = self.active_agent {
                left.push(Span::styled("  ", sep));
                left.push(Span::styled(
                    format!("@{}", truncate(agent, 14)),
                    Style::default().fg(self.accent),
                ));
            }

            let mut right = Vec::new();
            push_section_open(&mut right, "status", border_hot);
            push_chip(
                &mut right,
                format!("daemon {health}"),
                Style::default().fg(health_color).bg(chip_bg).add_modifier(Modifier::BOLD),
            );
            push_section_close(&mut right, border_hot);

            let right_width: usize = right.iter().map(|s| s.content.len()).sum();
            let available = area.width as usize;
            if available > right_width + 1 {
                let max_left = available.saturating_sub(right_width + 1);
                let left_line = fit_spans(left, max_left);
                buf.set_line(area.x, area.y, &left_line, max_left as u16);
                let rx = area.x + area.width - right_width as u16;
                buf.set_line(rx, area.y, &Line::from(right), right_width as u16);
            } else {
                buf.set_line(area.x, area.y, &fit_spans(left, available), area.width);
            }
            for x in area.x..area.x + area.width {
                buf[(x, area.y)].set_bg(self.status_bg);
            }
        }

        if area.height >= 2 {
            let mut left = Vec::new();
            push_section_open(&mut left, "runtime", border);
            push_chip(
                &mut left,
                format!("model {model_short}"),
                Style::default().fg(value.fg.unwrap_or(self.status_fg)).bg(chip_bg),
            );
            left.push(Span::styled("│", border));
            push_chip(&mut left, provider_short, Style::default().fg(muted_hi).bg(chip_bg));
            left.push(Span::styled("│", border));
            push_chip(
                &mut left,
                format!("eff {}", self.effort),
                Style::default().fg(effort_color).bg(chip_bg).add_modifier(Modifier::BOLD),
            );
            let policy_label = if self.policy_workspace_only
                || self.policy_paths_count > 0
                || self.policy_commands_count > 0
            {
                format!(
                    "pol lock:{} p:{} c:{}",
                    if self.policy_workspace_only { "on" } else { "off" },
                    self.policy_paths_count,
                    self.policy_commands_count
                )
            } else {
                "pol open".to_string()
            };
            left.push(Span::styled("│", border));
            push_chip(
                &mut left,
                policy_label,
                Style::default()
                    .fg(if self.policy_workspace_only { self.warning } else { muted_hi })
                    .bg(chip_bg),
            );
            if let Some(mode) = self.policy_approval_mode {
                left.push(Span::styled("│", border));
                push_chip(
                    &mut left,
                    format!("apr {}", truncate(mode, 10)),
                    Style::default().fg(self.accent).bg(chip_bg),
                );
            }
            if let Some(agent) = self.active_agent {
                left.push(Span::styled("│", border));
                push_chip(
                    &mut left,
                    format!("agt {}", truncate(&format!("@{agent}"), 16)),
                    Style::default().fg(self.accent).bg(chip_bg),
                );
            }
            push_section_close(&mut left, border);

            let mut right = Vec::new();
            push_section_open(&mut right, "telemetry", border);
            push_chip(
                &mut right,
                format!("tok {tokens}/{ctx}"),
                Style::default().fg(self.status_fg).bg(chip_bg),
            );
            right.push(Span::styled("│", border));
            push_chip(
                &mut right,
                format!("mem {mem}"),
                Style::default().fg(self.status_fg).bg(chip_bg),
            );
            right.push(Span::styled("│", border));
            push_chip(
                &mut right,
                format!("sec {}/{}", self.secrets_used, self.total_secrets),
                Style::default()
                    .fg(if self.secrets_used > 0 { self.success } else { muted_hi })
                    .bg(chip_bg),
            );
            right.push(Span::styled("│", border));
            push_chip(
                &mut right,
                format!("deny {}", self.policy_denied_count),
                Style::default()
                    .fg(if self.policy_denied_count > 0 {
                        self.warning
                    } else {
                        muted_hi
                    })
                    .bg(chip_bg),
            );
            push_section_close(&mut right, border);

            let right_width: usize = right.iter().map(|s| s.content.len()).sum();
            let available = area.width as usize;
            if available > right_width + 1 {
                let max_left = available.saturating_sub(right_width + 1);
                let left_line = fit_spans(left, max_left);
                buf.set_line(area.x, area.y + 1, &left_line, max_left as u16);
                let rx = area.x + area.width - right_width as u16;
                buf.set_line(rx, area.y + 1, &Line::from(right), right_width as u16);
            } else {
                buf.set_line(area.x, area.y + 1, &fit_spans(left, available), area.width);
            }
            for x in area.x..area.x + area.width {
                buf[(x, area.y + 1)].set_bg(self.status_bg);
            }
        }

        if area.height >= 3 {
            let key = Style::default().fg(self.accent);
            let label = Style::default().fg(muted_hi);

            let hints: &[(&str, &str)] = &[
                ("model_picker", "model"),
                ("command_palette", "cmd"),
                ("dashboard", "dash"),
                ("signet_commands", "signet"),
                ("voice_input", "voice"),
                ("keybinds", "keys"),
                ("session_browser", "sessions"),
                ("quit", "quit"),
            ];

            let mut spans = vec![Span::styled(" ", sep)];
            let mut used = 1u16;
            let mut in_nav_section = false;
            let mut in_ops_section = false;
            for (i, (action, name)) in hints.iter().enumerate() {
                let combo = pretty_combo(&self.keybinds.get(action));
                let width = combo.len() as u16 + name.len() as u16 + 1;
                if used + width + 3 > area.width {
                    break;
                }

                let nav = i <= 3;
                if nav && !in_nav_section {
                    push_section_open(&mut spans, "nav", border);
                    used += 8;
                    in_nav_section = true;
                }
                if !nav && !in_ops_section {
                    if in_nav_section {
                        push_section_close(&mut spans, border);
                        spans.push(Span::styled(" ", sep));
                        used += 3;
                    }
                    push_section_open(&mut spans, "ops", border);
                    used += 8;
                    in_ops_section = true;
                }

                if (nav && i > 0) || (!nav && i > 4) {
                    spans.push(Span::styled("│", border));
                    used += 1;
                }
                spans.push(Span::styled(combo.to_string(), key));
                spans.push(Span::styled(format!(" {}", capitalize(name)), label));
                used += width;
            }

            if in_ops_section {
                push_section_close(&mut spans, border);
            } else if in_nav_section {
                push_section_close(&mut spans, border);
            }

            buf.set_line(area.x, area.y + 2, &Line::from(spans), area.width);
            for x in area.x..area.x + area.width {
                buf[(x, area.y + 2)].set_bg(self.status_bg);
            }
        }

        if area.height >= 4 {
            // Padding row to keep keybind row from feeling cramped against divider
            let y = area.y + 3;
            for x in area.x..area.x + area.width {
                buf[(x, y)].set_bg(self.status_bg).set_char(' ');
            }
        }

        if area.height >= 5 {
            let y = area.y + 4;
            for x in area.x..area.x + area.width {
                buf[(x, y)]
                    .set_bg(self.status_bg)
                    .set_fg(self.border)
                    .set_char('─');
            }
        }
    }
}

fn format_tokens(n: usize) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}K", n as f64 / 1_000.0)
    } else {
        format!("{n}")
    }
}


fn truncate(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        return s.to_string();
    }
    if max_chars <= 1 {
        return "…".to_string();
    }
    let trimmed: String = s.chars().take(max_chars - 1).collect();
    format!("{trimmed}…")
}

fn fit_spans(spans: Vec<Span<'_>>, max_width: usize) -> Line<'_> {
    let mut out = Vec::new();
    let mut used = 0usize;
    for span in spans {
        let content = span.content.as_ref();
        let width = content.chars().count();
        if used + width <= max_width {
            used += width;
            out.push(span);
            continue;
        }
        let remaining = max_width.saturating_sub(used);
        if remaining == 0 {
            break;
        }
        let clipped = truncate(content, remaining);
        out.push(Span::styled(clipped, span.style));
        break;
    }
    Line::from(out)
}

fn push_chip(spans: &mut Vec<Span<'_>>, text: impl AsRef<str>, style: Style) {
    spans.push(Span::styled(" ", style));
    spans.push(Span::styled(text.as_ref().to_string(), style));
    spans.push(Span::styled(" ", style));
}

fn push_section_open(spans: &mut Vec<Span<'_>>, title: &str, style: Style) {
    spans.push(Span::styled("⟦", style));
    spans.push(Span::styled(format!("{title} "), style.add_modifier(Modifier::BOLD)));
}

fn push_section_close(spans: &mut Vec<Span<'_>>, style: Style) {
    spans.push(Span::styled(" ⟧", style));
}

fn pretty_combo(combo: &str) -> String {
    combo
        .replace("Ctrl+", "⌃")
        .replace("Alt+", "⌥")
        .replace("Shift+", "⇧")
        .replace("Cmd+", "⌘")
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

fn brighten(color: Color, amount: u8) -> Color {
    match color {
        Color::Rgb(r, g, b) => Color::Rgb(
            r.saturating_add(amount),
            g.saturating_add(amount),
            b.saturating_add(amount),
        ),
        other => other,
    }
}
