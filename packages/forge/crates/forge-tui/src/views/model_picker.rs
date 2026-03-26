use crate::{chrome, theme::Theme};
use std::collections::{HashMap, HashSet};
use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

/// Read Codex's configured model from ~/.codex/config.toml
fn codex_configured_model() -> Option<String> {
    let path = dirs::home_dir()?.join(".codex").join("config.toml");
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("model") && !trimmed.starts_with("model_") && trimmed.contains('=') {
            if let Some(val) = trimmed.split('=').nth(1) {
                let m = val.trim().trim_matches('"').trim_matches('\'').trim();
                if !m.is_empty() {
                    return Some(m.to_string());
                }
            }
        }
    }
    None
}

fn codex_curated_models() -> Vec<(&'static str, &'static str, usize)> {
    vec![
        ("gpt-5.4", "GPT 5.4", 200_000),
        ("gpt-5.3-codex", "GPT 5.3 Codex", 200_000),
        ("gpt-5.3-codex-spark", "GPT 5.3 Codex Spark", 200_000),
        ("gpt-5-codex", "GPT 5 Codex", 200_000),
        ("codex-mini-latest", "Codex Mini", 200_000),
    ]
}

/// A model entry in the picker
#[derive(Debug, Clone)]
pub struct ModelEntry {
    pub provider: String,
    pub model: String,
    pub display_name: String,
    pub context_window: usize,
    /// If this is a CLI provider entry, the CLI path
    pub cli_path: Option<String>,
}

/// State for the model picker overlay
pub struct ModelPicker {
    pub models: Vec<ModelEntry>,
    pub selected: usize,
    pub filter: String,
}

impl Default for ModelPicker {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelPicker {
    pub fn new() -> Self {
        Self {
            models: default_models(),
            selected: 0,
            filter: String::new(),
        }
    }

    /// Create a picker that includes CLI provider models for the current CLI
    pub fn with_cli(cli_provider: &str, cli_path: &str) -> Self {
        let mut models = Vec::new();

        match cli_provider {
            "claude-cli" => {
                for (model, name, ctx) in &[
                    ("claude-opus-4-6", "Claude Opus 4.6", 200_000),
                    ("claude-sonnet-4-6", "Claude Sonnet 4.6", 200_000),
                    ("claude-haiku-4-5-20251001", "Claude Haiku 4.5", 200_000),
                ] {
                    models.push(ModelEntry {
                        provider: "claude-cli".into(),
                        model: model.to_string(),
                        display_name: format!("{name} (CLI)"),
                        context_window: *ctx,
                        cli_path: Some(cli_path.to_string()),
                    });
                }
            }
            "codex-cli" => {
                for (model, name, ctx) in codex_curated_models() {
                    models.push(ModelEntry {
                        provider: "codex-cli".into(),
                        model: model.to_string(),
                        display_name: format!("{name} (CLI)"),
                        context_window: ctx,
                        cli_path: Some(cli_path.to_string()),
                    });
                }
            }
            "gemini-cli" => {
                for (model, name, ctx) in &[
                    ("gemini-2.5-flash", "Gemini 2.5 Flash", 1_000_000),
                    ("gemini-2.5-pro", "Gemini 2.5 Pro", 1_000_000),
                ] {
                    models.push(ModelEntry {
                        provider: "gemini-cli".into(),
                        model: model.to_string(),
                        display_name: format!("{name} (CLI)"),
                        context_window: *ctx,
                        cli_path: Some(cli_path.to_string()),
                    });
                }
            }
            _ => {}
        }

        models.extend(default_models());

        Self {
            models,
            selected: 0,
            filter: String::new(),
        }
    }

    /// Create a picker with CLI models + optional daemon registry models
    pub fn with_all(
        clis: &[(forge_provider::cli::CliKind, String)],
        registry: &[ModelEntry],
        connected_providers: &[String],
    ) -> Self {
        let mut models = Vec::new();
        let connected: HashSet<&str> = connected_providers.iter().map(|s| s.as_str()).collect();
        let cli_paths: HashMap<&str, &String> = clis
            .iter()
            .map(|(kind, path)| (cli_kind_provider(kind), path))
            .collect();
        let mut providers_with_registry = HashSet::new();

        // Prefer daemon registry models, filtered down to connected providers only.
        for entry in registry {
            let provider = normalize_registry_provider(&entry.provider);
            if !connected.contains(provider) {
                continue;
            }
            if provider.ends_with("-cli") && !cli_paths.contains_key(provider) {
                continue;
            }

            providers_with_registry.insert(provider.to_string());
            let cli_path = cli_paths.get(provider).map(|p| (*p).clone());
            models.push(ModelEntry {
                provider: provider.to_string(),
                model: entry.model.clone(),
                display_name: if provider.ends_with("-cli") {
                    format!("{} (CLI)", entry.display_name)
                } else {
                    entry.display_name.clone()
                },
                context_window: entry.context_window,
                cli_path,
            });
        }

        // Supplement connected CLI providers with our curated supported-model coverage.
        for provider in connected_providers {
            let provider_name = provider.as_str();
            if provider_name.ends_with("-cli") {
                models.extend(fallback_models_for_provider(
                    provider_name,
                    cli_paths.get(provider_name).cloned(),
                ));
                continue;
            }
            if !providers_with_registry.contains(provider_name) {
                models.extend(fallback_models_for_provider(
                    provider_name,
                    cli_paths.get(provider_name).cloned(),
                ));
            }
        }

        if models.is_empty() {
            models.extend(default_models());
        }

        dedupe_models(&mut models);

        if connected.contains("codex-cli") {
            if let Some(configured) = codex_configured_model() {
                let already_present = models
                    .iter()
                    .any(|m| m.provider == "codex-cli" && m.model == configured);
                if !already_present {
                    models.insert(
                        0,
                        ModelEntry {
                            provider: "codex-cli".into(),
                            model: configured.clone(),
                            display_name: format!("{configured} (configured) (CLI)"),
                            context_window: 200_000,
                            cli_path: cli_paths.get("codex-cli").map(|p| (*p).clone()),
                        },
                    );
                }
            }
        }

        Self {
            models,
            selected: 0,
            filter: String::new(),
        }
    }

    /// Create a picker with CLI models + hardcoded defaults (no daemon)
    pub fn with_detected_clis(clis: &[(forge_provider::cli::CliKind, String)]) -> Self {
        use forge_provider::cli::CliKind;
        let mut models = Vec::new();

        for (kind, path) in clis {
            let entries: Vec<(&str, &str, usize)> = match kind {
                CliKind::Claude => vec![
                    ("claude-opus-4-6", "Claude Opus 4.6", 200_000),
                    ("claude-sonnet-4-6", "Claude Sonnet 4.6", 200_000),
                    ("claude-haiku-4-5-20251001", "Claude Haiku 4.5", 200_000),
                ],
                CliKind::Codex => codex_curated_models(),
                CliKind::Gemini => vec![
                    ("gemini-2.5-flash", "Gemini 2.5 Flash", 1_000_000),
                    ("gemini-2.5-pro", "Gemini 2.5 Pro", 1_000_000),
                ],
            };
            let provider = match kind {
                CliKind::Claude => "claude-cli",
                CliKind::Codex => "codex-cli",
                CliKind::Gemini => "gemini-cli",
            };
            for (model, name, ctx) in entries {
                models.push(ModelEntry {
                    provider: provider.into(),
                    model: model.to_string(),
                    display_name: format!("{name} (CLI)"),
                    context_window: ctx,
                    cli_path: Some(path.clone()),
                });
            }
        }

        models.extend(default_models());

        Self {
            models,
            selected: 0,
            filter: String::new(),
        }
    }

    pub fn filtered_models(&self) -> Vec<&ModelEntry> {
        if self.filter.is_empty() {
            self.models.iter().collect()
        } else {
            let filter_lower = self.filter.to_lowercase();
            self.models
                .iter()
                .filter(|m| {
                    m.display_name.to_lowercase().contains(&filter_lower)
                        || m.provider.to_lowercase().contains(&filter_lower)
                        || m.model.to_lowercase().contains(&filter_lower)
                })
                .collect()
        }
    }

    pub fn selected_model(&self) -> Option<&ModelEntry> {
        let filtered = self.filtered_models();
        filtered.get(self.selected).copied()
    }

    pub fn move_up(&mut self) {
        self.selected = self.selected.saturating_sub(1);
    }

    pub fn move_down(&mut self) {
        let max = self.filtered_models().len().saturating_sub(1);
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
        let height = 20u16.min(area.height.saturating_sub(4));
        let x = (area.width.saturating_sub(width)) / 2;
        let y = (area.height.saturating_sub(height)) / 2;
        let dialog_area = Rect::new(x, y, width, height);

        frame.render_widget(Clear, dialog_area);
        let bg_block = Block::default().style(Style::default().bg(theme.dialog_bg));
        frame.render_widget(bg_block, dialog_area);
        chrome::render_overlay_chrome(frame.buffer_mut(), dialog_area, theme);

        let filtered = self.filtered_models();
        let mut lines = Vec::new();

        // Search filter
        lines.push(Line::from(vec![
            Span::styled("  Search: ", Style::default().fg(theme.muted)),
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

        for (i, model) in filtered.iter().enumerate().skip(start).take(end.saturating_sub(start)) {
            let is_selected = i == self.selected;
            let style = if is_selected {
                chrome::selected_primary(theme)
            } else {
                Style::default().fg(theme.fg)
            };

            let provider_style = if is_selected {
                chrome::selected_secondary(theme)
            } else {
                Style::default().fg(theme.muted)
            };

            let ctx = format_context(model.context_window);

            lines.push(Line::from(vec![
                Span::styled(
                    if is_selected { " ▸ " } else { "   " },
                    if is_selected { chrome::selected_marker(theme) } else { style },
                ),
                Span::styled(&model.display_name, style),
                Span::styled(
                    format!("  ({}, {})", model.provider, ctx),
                    provider_style,
                ),
            ]));
        }

        if filtered.is_empty() {
            lines.push(Line::from(Span::styled(
                "   No matching models",
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
            .title(" Select Model (^O) ")
            .title_style(Style::default().fg(theme.accent).add_modifier(Modifier::BOLD));

        let paragraph = Paragraph::new(lines).block(block);
        frame.render_widget(paragraph, dialog_area);
    }
}

fn cli_kind_provider(kind: &forge_provider::cli::CliKind) -> &'static str {
    match kind {
        forge_provider::cli::CliKind::Claude => "claude-cli",
        forge_provider::cli::CliKind::Codex => "codex-cli",
        forge_provider::cli::CliKind::Gemini => "gemini-cli",
    }
}

fn normalize_registry_provider(provider: &str) -> &str {
    match provider {
        "claude-code" => "claude-cli",
        "codex" => "codex-cli",
        _ => provider,
    }
}

fn dedupe_models(models: &mut Vec<ModelEntry>) {
    let mut seen = HashSet::new();
    models.retain(|m| seen.insert((m.provider.clone(), m.model.clone())));
}

fn fallback_models_for_provider(provider: &str, cli_path: Option<&String>) -> Vec<ModelEntry> {
    let cli_path = cli_path.cloned();
    match provider {
        "claude-cli" => vec![
            ModelEntry {
                provider: "claude-cli".into(),
                model: "claude-opus-4-6".into(),
                display_name: "Claude Opus 4.6 (CLI)".into(),
                context_window: 200_000,
                cli_path: cli_path.clone(),
            },
            ModelEntry {
                provider: "claude-cli".into(),
                model: "claude-sonnet-4-6".into(),
                display_name: "Claude Sonnet 4.6 (CLI)".into(),
                context_window: 200_000,
                cli_path: cli_path.clone(),
            },
            ModelEntry {
                provider: "claude-cli".into(),
                model: "claude-haiku-4-5-20251001".into(),
                display_name: "Claude Haiku 4.5 (CLI)".into(),
                context_window: 200_000,
                cli_path,
            },
        ],
        "codex-cli" => vec![
            ModelEntry {
                provider: "codex-cli".into(),
                model: "gpt-5.4".into(),
                display_name: "GPT 5.4 (CLI)".into(),
                context_window: 200_000,
                cli_path: cli_path.clone(),
            },
            ModelEntry {
                provider: "codex-cli".into(),
                model: "gpt-5.3-codex".into(),
                display_name: "GPT 5.3 Codex (CLI)".into(),
                context_window: 200_000,
                cli_path: cli_path.clone(),
            },
            ModelEntry {
                provider: "codex-cli".into(),
                model: "gpt-5.3-codex-spark".into(),
                display_name: "GPT 5.3 Codex Spark (CLI)".into(),
                context_window: 200_000,
                cli_path: cli_path.clone(),
            },
            ModelEntry {
                provider: "codex-cli".into(),
                model: "gpt-5-codex".into(),
                display_name: "GPT 5 Codex (CLI)".into(),
                context_window: 200_000,
                cli_path: cli_path.clone(),
            },
            ModelEntry {
                provider: "codex-cli".into(),
                model: "codex-mini-latest".into(),
                display_name: "Codex Mini (CLI)".into(),
                context_window: 200_000,
                cli_path,
            },
        ],
        "gemini-cli" => vec![
            ModelEntry {
                provider: "gemini-cli".into(),
                model: "gemini-2.5-flash".into(),
                display_name: "Gemini 2.5 Flash (CLI)".into(),
                context_window: 1_000_000,
                cli_path: cli_path.clone(),
            },
            ModelEntry {
                provider: "gemini-cli".into(),
                model: "gemini-2.5-pro".into(),
                display_name: "Gemini 2.5 Pro (CLI)".into(),
                context_window: 1_000_000,
                cli_path,
            },
        ],
        other => default_models()
            .into_iter()
            .filter(|m| m.provider == other)
            .collect(),
    }
}

fn format_context(tokens: usize) -> String {
    if tokens >= 1_000_000 {
        format!("{}M ctx", tokens / 1_000_000)
    } else if tokens >= 1_000 {
        format!("{}K ctx", tokens / 1_000)
    } else {
        format!("{tokens} ctx")
    }
}

pub fn default_models() -> Vec<ModelEntry> {
    vec![
        ModelEntry { provider: "anthropic".into(), model: "claude-opus-4-6".into(), display_name: "Claude Opus 4.6".into(), context_window: 200_000, cli_path: None },
        ModelEntry { provider: "anthropic".into(), model: "claude-sonnet-4-6".into(), display_name: "Claude Sonnet 4.6".into(), context_window: 200_000, cli_path: None },
        ModelEntry { provider: "anthropic".into(), model: "claude-haiku-4-5-20251001".into(), display_name: "Claude Haiku 4.5".into(), context_window: 200_000, cli_path: None },
        ModelEntry { provider: "openai".into(), model: "gpt-4o".into(), display_name: "GPT-4o".into(), context_window: 128_000, cli_path: None },
        ModelEntry { provider: "openai".into(), model: "gpt-4o-mini".into(), display_name: "GPT-4o Mini".into(), context_window: 128_000, cli_path: None },
        ModelEntry { provider: "openai".into(), model: "o4-mini".into(), display_name: "o4-mini".into(), context_window: 200_000, cli_path: None },
        ModelEntry { provider: "gemini".into(), model: "gemini-2.5-flash".into(), display_name: "Gemini 2.5 Flash".into(), context_window: 1_000_000, cli_path: None },
        ModelEntry { provider: "gemini".into(), model: "gemini-2.5-pro".into(), display_name: "Gemini 2.5 Pro".into(), context_window: 1_000_000, cli_path: None },
        ModelEntry { provider: "groq".into(), model: "llama-3.3-70b-versatile".into(), display_name: "Llama 3.3 70B (Groq)".into(), context_window: 128_000, cli_path: None },
        ModelEntry { provider: "ollama".into(), model: "qwen3:4b".into(), display_name: "Qwen3 4B (Local)".into(), context_window: 32_768, cli_path: None },
        ModelEntry { provider: "openrouter".into(), model: "anthropic/claude-sonnet-4-6".into(), display_name: "Claude Sonnet 4.6 (OpenRouter)".into(), context_window: 200_000, cli_path: None },
    ]
}
