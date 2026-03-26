use crate::theme::Theme;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};
use syntect::easy::HighlightLines;
use syntect::highlighting::{FontStyle, ThemeSet};
use syntect::parsing::SyntaxSet;
use std::sync::LazyLock;

static SYNTAX_SET: LazyLock<SyntaxSet> = LazyLock::new(SyntaxSet::load_defaults_newlines);
static THEME_SET: LazyLock<ThemeSet> = LazyLock::new(ThemeSet::load_defaults);

/// Highlight code using syntect. Falls back to plain theme.code color if lang unknown.
fn highlight_code(code: &str, lang: &str, theme: &Theme) -> Vec<Vec<Span<'static>>> {
    let syntax = SYNTAX_SET
        .find_syntax_by_token(lang)
        .unwrap_or_else(|| SYNTAX_SET.find_syntax_plain_text());

    // Use a dark theme for dark terminals, light for light
    let theme_name = if matches!(theme.name, "signet-light") {
        "InspiredGitHub"
    } else {
        "base16-ocean.dark"
    };
    let syn_theme = THEME_SET
        .themes
        .get(theme_name)
        .unwrap_or_else(|| &THEME_SET.themes["base16-ocean.dark"]);

    let mut h = HighlightLines::new(syntax, syn_theme);
    let mut result = Vec::new();

    for line in code.lines() {
        match h.highlight_line(line, &SYNTAX_SET) {
            Ok(ranges) => {
                let spans: Vec<Span<'static>> = ranges
                    .into_iter()
                    .map(|(style, text)| {
                        let mut span_style = Style::default().fg(theme.code);
                        if style.font_style.contains(FontStyle::BOLD) {
                            span_style = span_style.add_modifier(Modifier::BOLD);
                        }
                        if style.font_style.contains(FontStyle::ITALIC) {
                            span_style = span_style.add_modifier(Modifier::ITALIC);
                        }
                        Span::styled(text.to_string(), span_style)
                    })
                    .collect();
                result.push(spans);
            }
            Err(_) => {
                // Fallback: plain code color
                result.push(vec![Span::styled(
                    line.to_string(),
                    Style::default().fg(theme.code),
                )]);
            }
        }
    }
    result
}

/// Convert markdown text to styled ratatui Lines, using theme colors
pub fn render_markdown(text: &str, theme: &Theme) -> Vec<Line<'static>> {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);

    let parser = Parser::new_ext(text, options);
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut current_spans: Vec<Span<'static>> = Vec::new();
    let mut style_stack: Vec<Style> = vec![Style::default().fg(theme.fg)];
    let mut in_code_block = false;
    let mut code_lang = String::new();
    let mut code_content = String::new();
    let mut list_depth: usize = 0;
    let mut ordered_index: Option<u64> = None;

    for event in parser {
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    flush_line(&mut current_spans, &mut lines);
                    lines.push(Line::from(""));
                    let color = match level {
                        pulldown_cmark::HeadingLevel::H1 => theme.accent,
                        pulldown_cmark::HeadingLevel::H2 => theme.success,
                        _ => theme.warning,
                    };
                    style_stack.push(
                        Style::default()
                            .fg(color)
                            .add_modifier(Modifier::BOLD),
                    );
                }
                Tag::Paragraph => {
                    flush_line(&mut current_spans, &mut lines);
                }
                Tag::Strong => {
                    let base = current_style(&style_stack);
                    style_stack.push(base.add_modifier(Modifier::BOLD));
                }
                Tag::Emphasis => {
                    let base = current_style(&style_stack);
                    style_stack.push(base.add_modifier(Modifier::ITALIC));
                }
                Tag::Strikethrough => {
                    let base = current_style(&style_stack);
                    style_stack.push(base.add_modifier(Modifier::CROSSED_OUT));
                }
                Tag::CodeBlock(kind) => {
                    flush_line(&mut current_spans, &mut lines);
                    in_code_block = true;
                    code_content.clear();
                    code_lang = match kind {
                        pulldown_cmark::CodeBlockKind::Fenced(lang) => lang.to_string(),
                        _ => String::new(),
                    };
                }
                Tag::List(start) => {
                    flush_line(&mut current_spans, &mut lines);
                    ordered_index = start;
                    list_depth += 1;
                }
                Tag::Item => {
                    flush_line(&mut current_spans, &mut lines);
                    let indent = "  ".repeat(list_depth);
                    let bullet = if let Some(ref mut idx) = ordered_index {
                        let s = format!("{indent}{idx}. ");
                        *idx += 1;
                        s
                    } else {
                        format!("{indent}• ")
                    };
                    current_spans.push(Span::styled(
                        bullet,
                        Style::default().fg(theme.accent),
                    ));
                }
                Tag::BlockQuote(_) => {
                    flush_line(&mut current_spans, &mut lines);
                    let base = current_style(&style_stack);
                    style_stack.push(base.fg(theme.muted));
                    current_spans.push(Span::styled(
                        "│ ",
                        Style::default().fg(theme.muted),
                    ));
                }
                Tag::Link { dest_url, .. } => {
                    let base = current_style(&style_stack);
                    style_stack.push(base.fg(theme.accent).add_modifier(Modifier::UNDERLINED));
                    let _ = dest_url;
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Heading(_) => {
                    style_stack.pop();
                    flush_line(&mut current_spans, &mut lines);
                }
                TagEnd::Paragraph => {
                    flush_line(&mut current_spans, &mut lines);
                    lines.push(Line::from(""));
                }
                TagEnd::Strong | TagEnd::Emphasis | TagEnd::Strikethrough | TagEnd::Link => {
                    style_stack.pop();
                }
                TagEnd::CodeBlock => {
                    in_code_block = false;
                    let lang_display = if code_lang.is_empty() {
                        String::new()
                    } else {
                        format!(" {}", code_lang)
                    };
                    lines.push(Line::from(Span::styled(
                        format!("  ┌─{lang_display}─"),
                        Style::default().fg(theme.border),
                    )));
                    // Syntax-highlighted code block
                    let highlighted = highlight_code(&code_content, &code_lang, theme);
                    for spans in highlighted {
                        let mut row = vec![Span::styled("  │ ", Style::default().fg(theme.border))];
                        row.extend(spans);
                        lines.push(Line::from(row));
                    }
                    lines.push(Line::from(Span::styled(
                        "  └───",
                        Style::default().fg(theme.border),
                    )));
                    code_content.clear();
                }
                TagEnd::List(_) => {
                    list_depth = list_depth.saturating_sub(1);
                    if list_depth == 0 {
                        ordered_index = None;
                    }
                    lines.push(Line::from(""));
                }
                TagEnd::Item => {
                    flush_line(&mut current_spans, &mut lines);
                }
                TagEnd::BlockQuote(_) => {
                    style_stack.pop();
                    flush_line(&mut current_spans, &mut lines);
                }
                _ => {}
            },
            Event::Text(text) => {
                if in_code_block {
                    code_content.push_str(&text);
                } else {
                    let style = current_style(&style_stack);
                    current_spans.push(Span::styled(text.to_string(), style));
                }
            }
            Event::Code(code) => {
                current_spans.push(Span::styled(
                    format!("`{code}`"),
                    Style::default()
                        .fg(theme.code)
                        .add_modifier(Modifier::BOLD),
                ));
            }
            Event::SoftBreak => {
                flush_line(&mut current_spans, &mut lines);
            }
            Event::HardBreak => {
                flush_line(&mut current_spans, &mut lines);
                lines.push(Line::from(""));
            }
            Event::Rule => {
                flush_line(&mut current_spans, &mut lines);
                lines.push(Line::from(Span::styled(
                    "  ───────────────────",
                    Style::default().fg(theme.muted),
                )));
            }
            _ => {}
        }
    }

    flush_line(&mut current_spans, &mut lines);
    lines
}

fn current_style(stack: &[Style]) -> Style {
    stack.last().copied().unwrap_or_default()
}

fn flush_line(spans: &mut Vec<Span<'static>>, lines: &mut Vec<Line<'static>>) {
    if !spans.is_empty() {
        lines.push(Line::from(std::mem::take(spans)));
    }
}
