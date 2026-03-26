use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// Actions that can be triggered by key events
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Submit the current input
    Submit,
    /// Insert a character into the input
    InsertChar(char),
    /// Delete character before cursor
    Backspace,
    /// Delete character after cursor
    Delete,
    /// Move cursor left
    CursorLeft,
    /// Move cursor right
    CursorRight,
    /// Move cursor to start of line
    Home,
    /// Move cursor to end of line
    End,
    /// Scroll up in chat
    ScrollUp,
    /// Scroll down in chat
    ScrollDown,
    /// Cancel current operation
    Cancel,
    /// Quit the application
    Quit,
    /// Open model picker
    ModelPicker,
    /// Open command palette
    CommandPalette,
    /// Open dashboard
    Dashboard,
    /// Open dashboard navigator (Ctrl+Tab)
    DashboardNav,
    /// Clear screen
    ClearScreen,
    /// Open Signet command picker
    SignetCommands,
    /// Insert newline in input
    NewLine,
    /// Paste from clipboard
    Paste,
    /// Tab-complete slash command
    TabComplete,
    /// Open keybind editor
    Keybinds,
    /// Open session browser
    SessionBrowser,
    /// Open dashboard panel
    DashboardPanel,
    /// Toggle voice input recording
    VoiceInput,
    /// No action
    None,
}

/// Map a key event to an action
pub fn key_to_action(key: KeyEvent) -> Action {
    match (key.modifiers, key.code) {
        // Cancel / Quit
        (KeyModifiers::CONTROL, KeyCode::Char('c')) => Action::Cancel,
        (KeyModifiers::CONTROL, KeyCode::Char('q')) => Action::Quit,

        // Submit
        (KeyModifiers::NONE, KeyCode::Enter) => Action::Submit,
        (KeyModifiers::SHIFT, KeyCode::Enter) => Action::NewLine,

        // Navigation
        (KeyModifiers::NONE, KeyCode::Left) => Action::CursorLeft,
        (KeyModifiers::NONE, KeyCode::Right) => Action::CursorRight,
        (KeyModifiers::NONE, KeyCode::Home) => Action::Home,
        (KeyModifiers::NONE, KeyCode::End) => Action::End,
        (KeyModifiers::NONE, KeyCode::Backspace) => Action::Backspace,
        (KeyModifiers::NONE, KeyCode::Delete) => Action::Delete,

        // Tab completion
        (KeyModifiers::NONE, KeyCode::Tab) => Action::TabComplete,

        // Scroll
        (KeyModifiers::NONE, KeyCode::PageUp) => Action::ScrollUp,
        (KeyModifiers::NONE, KeyCode::PageDown) => Action::ScrollDown,

        // Overlays
        (KeyModifiers::CONTROL, KeyCode::Char('o')) => Action::ModelPicker,
        (KeyModifiers::CONTROL, KeyCode::Char('k')) => Action::CommandPalette,
        (KeyModifiers::CONTROL, KeyCode::Char('l')) => Action::ClearScreen,
        (KeyModifiers::CONTROL, KeyCode::Char('g')) => Action::SignetCommands,
        (KeyModifiers::CONTROL, KeyCode::Char('d')) => Action::Dashboard,
        (KeyModifiers::CONTROL, KeyCode::Char('b')) => Action::Keybinds,
        (KeyModifiers::CONTROL, KeyCode::Char('h')) => Action::SessionBrowser,
        (KeyModifiers::CONTROL, KeyCode::Char('r')) => Action::VoiceInput,

        // Dashboard panel
        (KeyModifiers::NONE, KeyCode::F(2)) => Action::DashboardPanel,

        // Character input
        (KeyModifiers::NONE | KeyModifiers::SHIFT, KeyCode::Char(c)) => Action::InsertChar(c),

        _ => Action::None,
    }
}
