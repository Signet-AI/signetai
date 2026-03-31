use ratatui::style::Color;

/// A color theme for the TUI
#[derive(Debug, Clone)]
pub struct Theme {
    pub name: &'static str,
    /// Status bar background
    pub status_bg: Color,
    /// Status bar text
    pub status_fg: Color,
    /// Main background
    pub bg: Color,
    /// Primary text
    pub fg: Color,
    /// Bright text (headings, emphasis)
    pub fg_bright: Color,
    /// User message label
    pub user: Color,
    /// Assistant streaming cursor
    pub assistant: Color,
    /// Tool name in brackets
    pub tool: Color,
    /// Success/complete indicators
    pub success: Color,
    /// Error text
    pub error: Color,
    /// Warning/pending indicators
    pub warning: Color,
    /// Muted/secondary text
    pub muted: Color,
    /// Accent color (headers, highlights)
    pub accent: Color,
    /// Code block text
    pub code: Color,
    /// Border color
    pub border: Color,
    /// Dialog overlay background
    pub dialog_bg: Color,
    /// Surface (raised panels, cards)
    pub surface: Color,
    /// Selected item background
    pub selected_bg: Color,
    /// Selected item foreground
    pub selected_fg: Color,
    /// Spinner/loading animation color
    pub spinner: Color,
}

impl Theme {
    fn with_opacity(mut self, opacity_pct: u8) -> Self {
        let bg = self.bg;
        self.status_bg = apply_opacity(self.status_bg, bg, opacity_pct);
        self.status_fg = apply_opacity(self.status_fg, bg, opacity_pct);
        self.fg = apply_opacity(self.fg, bg, opacity_pct);
        self.fg_bright = apply_opacity(self.fg_bright, bg, opacity_pct);
        self.user = apply_opacity(self.user, bg, opacity_pct);
        self.assistant = apply_opacity(self.assistant, bg, opacity_pct);
        self.tool = apply_opacity(self.tool, bg, opacity_pct);
        self.success = apply_opacity(self.success, bg, opacity_pct);
        self.error = apply_opacity(self.error, bg, opacity_pct);
        self.warning = apply_opacity(self.warning, bg, opacity_pct);
        self.muted = apply_opacity(self.muted, bg, opacity_pct);
        self.accent = apply_opacity(self.accent, bg, opacity_pct);
        self.code = apply_opacity(self.code, bg, opacity_pct);
        self.border = apply_opacity(self.border, bg, opacity_pct);
        self.dialog_bg = apply_opacity(self.dialog_bg, bg, opacity_pct);
        self.surface = apply_opacity(self.surface, bg, opacity_pct);
        self.selected_bg = apply_opacity(self.selected_bg, bg, opacity_pct);
        self.selected_fg = apply_opacity(self.selected_fg, bg, opacity_pct);
        self.spinner = apply_opacity(self.spinner, bg, opacity_pct);
        self
    }

    /// Signet Dark — industrial monochrome. Near-black with desaturated accents.
    /// Tokens from globals.css: --color-bg: #08080a, --color-surface: #0e0e12
    pub fn signet_dark() -> Self {
        Self {
            name: "signet-dark",
            // --color-bg: #08080a → RGB(8, 8, 10)
            bg: Color::Rgb(8, 8, 10),
            // --color-surface: #0e0e12
            surface: Color::Rgb(14, 14, 18),
            // --color-surface-raised: #151519
            status_bg: Color::Rgb(21, 21, 25),
            // --color-text: #d4d4d8
            fg: Color::Rgb(212, 212, 216),
            status_fg: Color::Rgb(212, 212, 216),
            // --color-text-bright: #f0f0f2
            fg_bright: Color::Rgb(240, 240, 242),
            // --color-text-muted: #3e3e46
            muted: Color::Rgb(62, 62, 70),
            // Signet green highlight token
            accent: Color::Rgb(118, 176, 132),
            // User messages — slightly brighter than accent
            user: Color::Rgb(192, 192, 200),
            // Assistant streaming cursor — accent-hover: #c0c0c8
            assistant: Color::Rgb(192, 192, 200),
            // Tool brackets — restrained green accent
            tool: Color::Rgb(96, 146, 112),
            // --color-success: #4a7a5e
            success: Color::Rgb(118, 176, 132),
            // --color-danger: #8a4a48
            error: Color::Rgb(210, 106, 102),
            // Warning — amber for semantic warning contrast
            warning: Color::Rgb(230, 188, 92),
            // Code blocks — bright text
            code: Color::Rgb(240, 240, 242),
            // Dim Signet-green border for thinner-feeling chrome
            border: Color::Rgb(52, 84, 62),
            // Dialog background — surface
            dialog_bg: Color::Rgb(14, 14, 18),
            // Selected rows use the Signet highlight token
            selected_bg: Color::Rgb(118, 176, 132),
            selected_fg: Color::Rgb(8, 8, 10),
            // Signet glow token for motion/loading
            spinner: Color::Rgb(156, 218, 172),
        }
        .with_opacity(95)
    }

    /// Signet Light — warm beige. Never pure white.
    /// Tokens from globals.css: --color-bg: #e4dfd8, --color-surface: #dbd5cd
    pub fn signet_light() -> Self {
        Self {
            name: "signet-light",
            // --color-bg: #e4dfd8 → RGB(228, 223, 216)
            bg: Color::Rgb(228, 223, 216),
            // --color-surface: #dbd5cd
            surface: Color::Rgb(219, 213, 205),
            // --color-surface-raised: #d1cbc2
            status_bg: Color::Rgb(209, 203, 194),
            // --color-text: #2a2a2e
            fg: Color::Rgb(42, 42, 46),
            status_fg: Color::Rgb(42, 42, 46),
            // --color-text-bright: #0a0a0c
            fg_bright: Color::Rgb(10, 10, 12),
            // --color-text-muted: #7a756e
            muted: Color::Rgb(122, 117, 110),
            // Signet yellow highlight token adapted for light theme
            accent: Color::Rgb(145, 117, 32),
            // User messages — near-black for readability
            user: Color::Rgb(42, 42, 46),
            // Assistant — accent-hover: #3a3832
            assistant: Color::Rgb(58, 56, 50),
            // Tool brackets — restrained chrome accent
            tool: Color::Rgb(132, 112, 56),
            // Polished success tone for light theme
            success: Color::Rgb(58, 112, 72),
            // Polished error tone for light theme
            error: Color::Rgb(154, 66, 64),
            // Polished warning tone for light theme
            warning: Color::Rgb(168, 118, 28),
            // Code — bright text (near-black)
            code: Color::Rgb(10, 10, 12),
            // Dim Signet-yellow border for light theme surfaces
            border: Color::Rgb(186, 168, 118),
            // Dialog — surface
            dialog_bg: Color::Rgb(219, 213, 205),
            // Selected rows use the Signet highlight token
            selected_bg: Color::Rgb(145, 117, 32),
            selected_fg: Color::Rgb(228, 223, 216),
            // Signet glow token toned for light bg
            spinner: Color::Rgb(166, 132, 38),
        }
        .with_opacity(95)
    }

    /// Midnight — deep blue-black with cool accents.
    pub fn midnight() -> Self {
        Self {
            name: "midnight",
            bg: Color::Rgb(10, 12, 22),
            surface: Color::Rgb(18, 22, 38),
            status_bg: Color::Rgb(15, 20, 35),
            fg: Color::Rgb(200, 210, 230),
            status_fg: Color::Rgb(180, 190, 220),
            fg_bright: Color::Rgb(230, 235, 250),
            muted: Color::Rgb(80, 90, 110),
            accent: Color::Rgb(214, 189, 96),
            user: Color::Rgb(100, 150, 255),
            assistant: Color::Rgb(80, 200, 120),
            tool: Color::Rgb(184, 168, 112),
            success: Color::Rgb(80, 200, 120),
            error: Color::Rgb(255, 100, 100),
            warning: Color::Rgb(255, 200, 80),
            code: Color::Rgb(80, 200, 120),
            border: Color::Rgb(88, 74, 36),
            dialog_bg: Color::Rgb(20, 25, 45),
            selected_bg: Color::Rgb(214, 189, 96),
            selected_fg: Color::Rgb(10, 12, 22),
            spinner: Color::Rgb(244, 225, 129),
        }
        .with_opacity(95)
    }

    /// Amber — warm retro terminal.
    pub fn amber() -> Self {
        Self {
            name: "amber",
            bg: Color::Rgb(15, 12, 5),
            surface: Color::Rgb(25, 20, 10),
            status_bg: Color::Rgb(30, 25, 15),
            fg: Color::Rgb(255, 200, 100),
            status_fg: Color::Rgb(255, 180, 50),
            fg_bright: Color::Rgb(255, 230, 160),
            muted: Color::Rgb(120, 100, 60),
            accent: Color::Rgb(214, 189, 96),
            user: Color::Rgb(255, 180, 50),
            assistant: Color::Rgb(255, 220, 130),
            tool: Color::Rgb(198, 176, 106),
            success: Color::Rgb(200, 255, 100),
            error: Color::Rgb(255, 80, 50),
            warning: Color::Rgb(255, 200, 50),
            code: Color::Rgb(255, 220, 130),
            border: Color::Rgb(110, 86, 34),
            dialog_bg: Color::Rgb(25, 20, 10),
            selected_bg: Color::Rgb(214, 189, 96),
            selected_fg: Color::Rgb(15, 12, 5),
            spinner: Color::Rgb(244, 225, 129),
        }
        .with_opacity(95)
    }

    pub fn by_name(name: &str) -> Self {
        match name {
            "signet-light" | "light" => Self::signet_light(),
            "midnight" => Self::midnight(),
            "amber" => Self::amber(),
            _ => Self::signet_dark(),
        }
    }

    pub fn all_names() -> &'static [&'static str] {
        &["signet-dark", "signet-light", "midnight", "amber"]
    }
}

impl Default for Theme {
    fn default() -> Self {
        Self::signet_dark()
    }
}

fn apply_opacity(color: Color, bg: Color, opacity_pct: u8) -> Color {
    let alpha = opacity_pct.min(100) as u16;
    let inv = 100u16.saturating_sub(alpha);
    match (color, bg) {
        (Color::Rgb(r, g, b), Color::Rgb(br, bgc, bb)) => {
            let blend = |fg: u8, bgv: u8| -> u8 {
                (((fg as u16 * alpha) + (bgv as u16 * inv)) / 100) as u8
            };
            Color::Rgb(blend(r, br), blend(g, bgc), blend(b, bb))
        }
        _ => color,
    }
}
