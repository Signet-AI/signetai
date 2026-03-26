//! Inline image rendering for the TUI using half-block ANSI art.
//!
//! Converts an image file into colored `Line`s using the Unicode half-block
//! character `▄` where foreground = bottom pixel row, background = top pixel row.
//! This works in ALL terminals — no sixel/kitty/iTerm2 protocol needed.

use ratatui::{
    style::{Color, Style},
    text::{Line, Span},
};
use std::path::Path;

/// Load an image from `path` and render it as colored half-block lines.
///
/// Each terminal row represents 2 pixel rows using `▄` with fg=bottom, bg=top.
/// The image is scaled to fit within `max_width` x `max_height` terminal cells.
///
/// Returns an empty vec if the image cannot be loaded.
pub fn render_image_to_lines(path: &str, max_width: u16, max_height: u16) -> Vec<Line<'static>> {
    let img_path = Path::new(path);
    if !img_path.exists() {
        return vec![Line::from(Span::styled(
            format!("  [image not found: {path}]"),
            Style::default().fg(Color::Red),
        ))];
    }

    // Read the raw bytes and decode via the png crate
    let pixels = match load_png_pixels(img_path) {
        Some(p) => p,
        None => {
            return vec![Line::from(Span::styled(
                format!("  [unsupported image: {path}]"),
                Style::default().fg(Color::Yellow),
            ))];
        }
    };

    let src_w = pixels.width;
    let src_h = pixels.height;
    if src_w == 0 || src_h == 0 {
        return vec![Line::from(Span::styled(
            "  [empty image]",
            Style::default().fg(Color::Yellow),
        ))];
    }

    // Each terminal row = 2 pixel rows, so effective pixel height = max_height * 2
    let max_pixel_h = (max_height as u32) * 2;
    let max_pixel_w = max_width as u32;

    // Compute scale factor to fit within bounds
    let scale_x = max_pixel_w as f64 / src_w as f64;
    let scale_y = max_pixel_h as f64 / src_h as f64;
    let scale = scale_x.min(scale_y).min(1.0); // never upscale

    let dst_w = ((src_w as f64 * scale) as u32).max(1);
    let dst_h = ((src_h as f64 * scale) as u32).max(2);
    // Make dst_h even so we get clean pairs
    let dst_h = if !dst_h.is_multiple_of(2) { dst_h + 1 } else { dst_h };

    // Nearest-neighbor downsample
    let scaled = downsample(&pixels, dst_w, dst_h);

    // Convert pixel pairs to half-block lines
    let mut lines = Vec::new();

    // Header line with filename
    let filename = img_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    lines.push(Line::from(Span::styled(
        format!("  [{filename}]"),
        Style::default().fg(Color::DarkGray),
    )));

    let row_pairs = dst_h / 2;
    for row in 0..row_pairs {
        let top_y = row * 2;
        let bot_y = top_y + 1;

        let mut spans = Vec::with_capacity(dst_w as usize + 1);
        spans.push(Span::raw("  ")); // left indent

        for x in 0..dst_w {
            let top = scaled.pixel(x, top_y);
            let bot = scaled.pixel(x, bot_y);

            // ▄ draws bottom half with fg, top half with bg
            spans.push(Span::styled(
                "\u{2584}".to_string(), // ▄
                Style::default()
                    .fg(Color::Rgb(bot.0, bot.1, bot.2))
                    .bg(Color::Rgb(top.0, top.1, top.2)),
            ));
        }

        lines.push(Line::from(spans));
    }

    lines
}

/// Simple RGBA pixel buffer
struct PixelBuffer {
    width: u32,
    height: u32,
    /// RGBA pixels, row-major, 4 bytes per pixel
    data: Vec<u8>,
}

impl PixelBuffer {
    fn pixel(&self, x: u32, y: u32) -> (u8, u8, u8) {
        let idx = ((y * self.width + x) * 4) as usize;
        if idx + 2 < self.data.len() {
            (self.data[idx], self.data[idx + 1], self.data[idx + 2])
        } else {
            (0, 0, 0)
        }
    }
}

/// Load a PNG file into a PixelBuffer. Returns None for non-PNG or decode errors.
fn load_png_pixels(path: &Path) -> Option<PixelBuffer> {
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let decoder = png::Decoder::new(reader);
    let mut reader = decoder.read_info().ok()?;

    let info = reader.info();
    let width = info.width;
    let height = info.height;
    let color_type = info.color_type;
    let bit_depth = info.bit_depth;

    // Only handle 8-bit for simplicity
    if bit_depth != png::BitDepth::Eight {
        return None;
    }

    let mut buf = vec![0u8; reader.output_buffer_size()];
    let output_info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(output_info.buffer_size());

    // Convert to RGBA
    let rgba = match color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => {
            let mut rgba = Vec::with_capacity((width * height * 4) as usize);
            for chunk in buf.chunks(3) {
                rgba.extend_from_slice(chunk);
                rgba.push(255);
            }
            rgba
        }
        png::ColorType::Grayscale => {
            let mut rgba = Vec::with_capacity((width * height * 4) as usize);
            for &g in &buf {
                rgba.extend_from_slice(&[g, g, g, 255]);
            }
            rgba
        }
        png::ColorType::GrayscaleAlpha => {
            let mut rgba = Vec::with_capacity((width * height * 4) as usize);
            for chunk in buf.chunks(2) {
                let g = chunk[0];
                let a = chunk.get(1).copied().unwrap_or(255);
                rgba.extend_from_slice(&[g, g, g, a]);
            }
            rgba
        }
        _ => return None, // Indexed color — skip for simplicity
    };

    Some(PixelBuffer {
        width,
        height,
        data: rgba,
    })
}

/// Nearest-neighbor downsample
fn downsample(src: &PixelBuffer, dst_w: u32, dst_h: u32) -> PixelBuffer {
    let mut data = vec![0u8; (dst_w * dst_h * 4) as usize];

    for y in 0..dst_h {
        let src_y = ((y as f64 / dst_h as f64) * src.height as f64) as u32;
        let src_y = src_y.min(src.height.saturating_sub(1));
        for x in 0..dst_w {
            let src_x = ((x as f64 / dst_w as f64) * src.width as f64) as u32;
            let src_x = src_x.min(src.width.saturating_sub(1));

            let src_idx = ((src_y * src.width + src_x) * 4) as usize;
            let dst_idx = ((y * dst_w + x) * 4) as usize;

            if src_idx + 3 < src.data.len() && dst_idx + 3 < data.len() {
                data[dst_idx] = src.data[src_idx];
                data[dst_idx + 1] = src.data[src_idx + 1];
                data[dst_idx + 2] = src.data[src_idx + 2];
                data[dst_idx + 3] = src.data[src_idx + 3];
            }
        }
    }

    PixelBuffer {
        width: dst_w,
        height: dst_h,
        data,
    }
}
