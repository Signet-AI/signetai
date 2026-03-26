use crate::theme::Theme;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
};

pub fn render_overlay_chrome(buf: &mut Buffer, popup: Rect, theme: &Theme) {
    // Main surface fill
    for row in popup.y..popup.y + popup.height {
        for col in popup.x..popup.x + popup.width {
            if col < buf.area().width && row < buf.area().height {
                buf[(col, row)].set_bg(theme.dialog_bg);
            }
        }
    }

    // Subtle right/bottom glow-shadow to give panels more lift without heavy blocks.
    let shadow = theme.border;
    let glow = theme.accent;

    let right_x = popup.x.saturating_add(popup.width);
    if right_x < buf.area().width {
        for row in popup.y.saturating_add(1)..popup.y + popup.height {
            if row < buf.area().height {
                buf[(right_x, row)].set_bg(shadow).set_char(' ');
            }
        }
    }

    let bottom_y = popup.y.saturating_add(popup.height);
    if bottom_y < buf.area().height {
        for col in popup.x.saturating_add(1)..popup.x + popup.width {
            if col < buf.area().width {
                buf[(col, bottom_y)].set_bg(shadow).set_char(' ');
            }
        }
    }

    // Accent corner ticks for Signet chrome.
    let corners = [
        (popup.x, popup.y),
        (popup.x + popup.width.saturating_sub(1), popup.y),
        (popup.x, popup.y + popup.height.saturating_sub(1)),
        (
            popup.x + popup.width.saturating_sub(1),
            popup.y + popup.height.saturating_sub(1),
        ),
    ];
    for (x, y) in corners {
        if x < buf.area().width && y < buf.area().height {
            buf[(x, y)]
                .set_fg(glow)
                .set_bg(theme.dialog_bg)
                .set_char('·');
        }
    }
}

pub fn selected_primary(theme: &Theme) -> Style {
    Style::default()
        .fg(theme.selected_fg)
        .bg(theme.selected_bg)
        .add_modifier(Modifier::BOLD)
}

pub fn selected_secondary(theme: &Theme) -> Style {
    Style::default()
        .fg(theme.selected_fg)
        .bg(theme.selected_bg)
}

pub fn selected_marker(theme: &Theme) -> Style {
    Style::default()
        .fg(theme.fg_bright)
        .bg(theme.selected_bg)
        .add_modifier(Modifier::BOLD)
}


pub fn visible_window(total: usize, selected: usize, capacity: usize) -> (usize, usize) {
    if capacity == 0 || total == 0 {
        return (0, 0);
    }
    if total <= capacity {
        return (0, total);
    }
    let half = capacity / 2;
    let mut start = selected.saturating_sub(half);
    if start + capacity > total {
        start = total.saturating_sub(capacity);
    }
    let end = (start + capacity).min(total);
    (start, end)
}
