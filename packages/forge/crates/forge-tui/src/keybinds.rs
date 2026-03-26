use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// All bindable actions with their default key combos.
/// Format: (action_id, display_name, default_combo)
pub const KEYBIND_ACTIONS: &[(&str, &str, &str)] = &[
    ("submit", "Send Message", "Enter"),
    ("cancel", "Cancel Generation", "Ctrl+C"),
    ("quit", "Quit", "Ctrl+Q"),
    ("model_picker", "Model Picker", "Ctrl+O"),
    ("command_palette", "Command Palette", "Ctrl+K"),
    ("signet_commands", "Signet Commands", "Ctrl+G"),
    ("dashboard", "Dashboard", "Ctrl+D"),
    ("dashboard_nav", "Dashboard Navigator", "Ctrl+Tab"),
    ("clear_screen", "Clear Screen", "Ctrl+L"),
    ("scroll_up", "Scroll Up", "PageUp"),
    ("scroll_down", "Scroll Down", "PageDown"),
    ("newline", "Insert Newline", "Shift+Enter"),
    ("paste", "Paste", "Ctrl+V"),
    ("keybinds", "Keybind Editor", "Ctrl+B"),
    ("session_browser", "Session Browser", "Ctrl+H"),
    ("voice_input", "Voice Input", "Ctrl+R"),
];

/// Stored keybinding configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyBindConfig {
    #[serde(flatten)]
    pub bindings: HashMap<String, String>,
}

impl Default for KeyBindConfig {
    fn default() -> Self {
        let mut bindings = HashMap::new();
        for (id, _, default_combo) in KEYBIND_ACTIONS {
            bindings.insert(id.to_string(), default_combo.to_string());
        }
        Self { bindings }
    }
}

impl KeyBindConfig {
    /// Get the combo string for an action
    pub fn get(&self, action: &str) -> &str {
        self.bindings
            .get(action)
            .map(|s| s.as_str())
            .unwrap_or_else(|| {
                // Fall back to default
                KEYBIND_ACTIONS
                    .iter()
                    .find(|(id, _, _)| *id == action)
                    .map(|(_, _, combo)| *combo)
                    .unwrap_or("")
            })
    }

    /// Check if a key event matches a combo string
    pub fn matches(combo: &str, key: &KeyEvent) -> bool {
        let parts: Vec<&str> = combo.split('+').collect();
        let needs_ctrl = parts
            .iter()
            .any(|p| p.eq_ignore_ascii_case("ctrl") || p.eq_ignore_ascii_case("cmd"));
        let needs_shift = parts.iter().any(|p| p.eq_ignore_ascii_case("shift"));
        let key_part = parts.last().unwrap_or(&"");

        let has_ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let has_shift = key.modifiers.contains(KeyModifiers::SHIFT);

        if needs_ctrl != has_ctrl || needs_shift != has_shift {
            return false;
        }

        // Match the key part
        match key.code {
            KeyCode::Char(c) => {
                let c_upper = c.to_uppercase().to_string();
                key_part.eq_ignore_ascii_case(&c_upper)
                    || key_part.eq_ignore_ascii_case(&c.to_string())
            }
            KeyCode::Enter => key_part.eq_ignore_ascii_case("enter"),
            KeyCode::Tab => key_part.eq_ignore_ascii_case("tab"),
            KeyCode::Backspace => key_part.eq_ignore_ascii_case("backspace"),
            KeyCode::Delete => key_part.eq_ignore_ascii_case("delete"),
            KeyCode::Esc => key_part.eq_ignore_ascii_case("esc"),
            KeyCode::Up => key_part.eq_ignore_ascii_case("up"),
            KeyCode::Down => key_part.eq_ignore_ascii_case("down"),
            KeyCode::Left => key_part.eq_ignore_ascii_case("left"),
            KeyCode::Right => key_part.eq_ignore_ascii_case("right"),
            KeyCode::Home => key_part.eq_ignore_ascii_case("home"),
            KeyCode::End => key_part.eq_ignore_ascii_case("end"),
            KeyCode::PageUp => key_part.eq_ignore_ascii_case("pageup"),
            KeyCode::PageDown => key_part.eq_ignore_ascii_case("pagedown"),
            KeyCode::F(n) => key_part.eq_ignore_ascii_case(&format!("f{n}")),
            _ => false,
        }
    }

    /// Resolve a key event to an action ID (first match wins)
    pub fn resolve(&self, key: &KeyEvent) -> Option<&str> {
        for (id, _, _) in KEYBIND_ACTIONS {
            let combo = self.get(id);
            if !combo.is_empty() && Self::matches(combo, key) {
                return Some(id);
            }
        }
        None
    }

    /// Load from config file, or return defaults
    pub fn load() -> Self {
        let path = config_path();
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(config) = serde_json::from_str::<KeyBindConfig>(&data) {
                return config;
            }
        }
        Self::default()
    }

    /// Save to config file
    pub fn save(&self) -> std::io::Result<()> {
        let path = config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(&self.bindings)?;
        std::fs::write(&path, data)
    }

    /// Format all bindings for display
    pub fn display_text(&self) -> String {
        let mut text = String::from("◆ Key Bindings\n\n");
        for (id, display, _) in KEYBIND_ACTIONS {
            let combo = self.get(id);
            text.push_str(&format!("    {:<22} {}\n", combo, display));
        }
        text.push_str(&format!(
            "\n  Config: {}\n  Edit the file to customize bindings.\n",
            config_path().display()
        ));
        text
    }
}

fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("forge")
        .join("keybinds.json")
}
