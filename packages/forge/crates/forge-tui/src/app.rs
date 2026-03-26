use crate::input::Action;
use crate::keybinds::KeyBindConfig;
use crate::views::chat::{ChatEntry, ChatView, ToolStatus};
use crate::views::command_palette::{CommandKind as PaletteCommandKind, CommandPalette};
use crate::views::dashboard_nav::DashboardNav;
use crate::views::forge_usage::ForgeUsage;
use crate::views::keybind_editor::KeybindEditor;
use crate::views::dashboard_panel::DashboardPanel;
use crate::views::model_picker::ModelPicker;
use crate::views::session_browser::SessionBrowser;
use crate::views::signet_commands::{self, CommandKind as SlashCommandKind, CommandPicker};
use crate::voice;
use crate::widgets::status_bar::StatusBar;
use crossterm::event::{self, Event, KeyEventKind};
use forge_agent::{
    AgentEvent, AgentLoop, PermissionManager, PermissionRequest, PermissionResponse, Session,
    SessionStore, SharedSession,
};
use forge_provider::{self, Provider};
use forge_signet::hooks::SessionHooks;
use forge_signet::secrets::{
    apply_local_cli_auth_env, discover_available_providers, refresh_daemon_model_registry,
    resolve_api_key,
};
use forge_signet::{ConfigEvent, ConfigWatcher, SignetClient};
use ratatui::{
    layout::{Constraint, Layout},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap},
    DefaultTerminal, Frame,
};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, info};

/// Permission dialog state
struct PermissionDialog {
    tool_name: String,
    tool_input: serde_json::Value,
    response_tx: tokio::sync::oneshot::Sender<PermissionResponse>,
    selected: usize, // 0=Allow, 1=Always Allow, 2=Deny
}

/// What the agent is currently doing (for animated indicators)
#[derive(Debug, Clone, PartialEq)]
enum ProcessingPhase {
    Idle,
    RecallingMemories,
    Thinking,
    Planning,
    Writing,
    Streaming,
    ExecutingTool(String),
}

impl ProcessingPhase {
    /// Spinner frames — subtle technical sweep instead of chunky hops
    const FRAMES: &[&str] = &["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"];

    /// Contextual verbs that cycle based on tick for each phase.
    /// tick/80 ≈ 4 seconds per verb at 50ms frame rate.
    fn label(&self, tick: usize) -> &'static str {
        match self {
            Self::Idle => "",
            Self::Streaming => "Responding",
            Self::RecallingMemories => {
                const VERBS: &[&str] = &[
                    "Remembering", "Recalling", "Tracing",
                    "Searching", "Linking", "Surfacing",
                ];
                VERBS[(tick / 80) % VERBS.len()]
            }
            Self::Thinking => {
                const VERBS: &[&str] = &[
                    "Thinking", "Deliberating", "Reasoning",
                    "Synthesizing", "Constructing", "Shaping",
                ];
                VERBS[(tick / 80) % VERBS.len()]
            }
            Self::Planning => {
                const VERBS: &[&str] = &[
                    "Planning", "Structuring", "Mapping",
                    "Sequencing", "Investigating", "Constructing",
                ];
                VERBS[(tick / 80) % VERBS.len()]
            }
            Self::Writing => {
                const VERBS: &[&str] = &[
                    "Writing", "Composing", "Drafting",
                    "Refining", "Building", "Editing",
                ];
                VERBS[(tick / 80) % VERBS.len()]
            }
            Self::ExecutingTool(_) => "Running",
        }
    }

    fn render(&self, tick: usize) -> String {
        let frame = Self::FRAMES[tick % Self::FRAMES.len()];
        let trail = match (tick / 2) % 6 {
            0 => "·    ",
            1 => "··   ",
            2 => "···  ",
            3 => " ··· ",
            4 => "  ···",
            _ => "   ··",
        };
        match self {
            Self::Idle => String::new(),
            Self::ExecutingTool(name) => {
                format!("  {frame} {} {name}  {trail}", self.label(tick))
            }
            _ => {
                format!("  {frame} {}  {trail}", self.label(tick))
            }
        }
    }
}

/// Application state
pub struct App {
    /// Current input text
    input: String,
    /// Cursor position in input
    cursor: usize,
    /// Chat history entries
    entries: Vec<ChatEntry>,
    /// Currently streaming text (visible on screen)
    streaming_text: String,
    /// Pending text buffer — text arrives in bursts from CLI, dripped out
    /// gradually to give a live-streaming feel (chars per frame)
    pending_text: String,
    /// Set when TurnComplete arrives but pending_text still dripping
    turn_complete_pending: bool,
    /// Chat scroll offset
    scroll_offset: u16,
    /// Shared session
    session: SharedSession,
    /// Provider info
    model: String,
    provider_name: String,
    context_window: usize,
    /// Active color theme
    theme: crate::theme::Theme,
    /// Keybinding configuration (loaded from ~/.config/forge/keybinds.json)
    keybinds: KeyBindConfig,
    /// Attached image paths (from drag-and-drop or paste)
    attached_images: Vec<String>,
    /// CLI binary path (if using a CLI provider)
    cli_path: Option<String>,
    /// All detected CLI tools (for model picker)
    detected_clis: Vec<(forge_provider::cli::CliKind, String)>,
    /// Models from daemon registry (fetched at startup)
    registry_models: Vec<crate::views::model_picker::ModelEntry>,
    /// Providers actually connected/authenticated at startup
    connected_providers: Vec<String>,
    /// Current reasoning effort level (shared with agent loop)
    effort: Arc<Mutex<forge_provider::ReasoningEffort>>,
    /// CLI permission bypass — skips all approval prompts on next spawn
    bypass: Arc<Mutex<bool>>,
    /// Memories recalled for current prompt
    memories_injected: usize,
    /// Total memories in database
    total_memories: usize,
    /// Total secrets available in Signet
    total_secrets: usize,
    /// Secrets used this session (incremented when secret_exec tool runs)
    secrets_used: usize,
    /// Daemon health status
    daemon_healthy: bool,
    /// Is the agent currently processing?
    processing: bool,
    /// Current processing phase (for animated status)
    processing_phase: ProcessingPhase,
    /// Animation tick counter (increments every frame)
    tick: usize,
    /// Handle to the current agent task (for cancellation)
    agent_task: Option<tokio::task::JoinHandle<()>>,
    /// Should quit?
    should_quit: bool,
    /// Agent event receiver
    event_rx: mpsc::Receiver<AgentEvent>,
    /// Permission request receiver
    permission_rx: mpsc::Receiver<PermissionRequest>,
    /// Active permission dialog
    permission_dialog: Option<PermissionDialog>,
    /// Model picker overlay
    model_picker: Option<ModelPicker>,
    /// Command palette overlay
    command_palette: Option<CommandPalette>,
    /// Signet command picker (Ctrl+G)
    command_picker: Option<CommandPicker>,
    /// Dashboard navigator (Ctrl+Tab)
    dashboard_nav: Option<DashboardNav>,
    /// Keybind editor overlay
    keybind_editor: Option<KeybindEditor>,
    /// Session browser overlay (Ctrl+H)
    session_browser: Option<SessionBrowser>,
    /// Dashboard panel overlay (F2)
    dashboard_panel: Option<DashboardPanel>,
    /// Usage overlay (/forge-usage)
    forge_usage: Option<ForgeUsage>,
    /// Loaded skills
    skills: Vec<forge_signet::Skill>,
    /// Dynamic slash command registry
    signet_commands: Vec<signet_commands::SignetCommand>,
    /// Installed Signet MCP servers exposed as slash namespaces
    mcp_servers: Vec<signet_commands::McpServerCommand>,
    /// Installed Signet MCP tools exposed as slash commands
    mcp_tools: Vec<signet_commands::McpToolCommand>,
    /// Active one-shot skill for next prompt
    pending_skill: Option<(String, String)>,
    /// Signet client for API key resolution on model switch
    signet_client: Option<SignetClient>,
    /// Shared permissions manager
    permissions: Arc<Mutex<PermissionManager>>,
    /// System prompt
    system_prompt: String,
    /// The agent loop
    agent: Arc<AgentLoop>,
    /// Config watcher event receiver
    config_rx: Option<mpsc::Receiver<ConfigEvent>>,
    /// Session persistence store
    session_store: Option<SessionStore>,
    /// Speculative recall — fires while user is typing to pre-warm the cache
    speculative_query: String,
    speculative_handle: Option<tokio::task::JoinHandle<()>>,
    last_keystroke: std::time::Instant,
    recall_cache: forge_signet::recall_cache::RecallCache,
    /// Pipeline summary (extraction + embedding models)
    pipeline_info: String,
    /// Agent display name from IDENTITY.md
    agent_name: String,
    /// Explicit --agent CLI flag value (None = default agent)
    active_agent: Option<String>,
    /// Live daemon log lines (ring buffer, max 100)
    daemon_logs: Vec<String>,
    /// Voice input: microphone recorder (present while recording)
    voice_recorder: Option<voice::Recorder>,
    /// Whether voice recording is active
    voice_recording: bool,
    /// Path to the downloaded whisper model
    voice_model_path: Option<PathBuf>,
    /// Interim transcription text (preview while recording)
    voice_interim_text: String,
    /// Whether voice model is currently being downloaded
    voice_downloading: bool,
    /// Last time an interim transcription was triggered
    voice_last_interim: std::time::Instant,
    /// Handle for background interim transcription task
    voice_interim_handle: Option<tokio::task::JoinHandle<()>>,
    /// Channel to receive interim/final transcription results
    voice_result_rx: Option<mpsc::Receiver<VoiceResult>>,
    /// Sender for voice transcription results (cloned into tasks)
    voice_result_tx: mpsc::Sender<VoiceResult>,
}

/// Result from a voice transcription task
enum VoiceResult {
    /// Interim preview text (shown while recording)
    Interim(String),
    /// Final transcription (committed to input)
    Final(String),
    /// Model downloaded successfully
    ModelReady(PathBuf),
    /// Error during voice operation
    Error(String),
}

impl App {
    /// Convert char-based cursor position to byte index in self.input.
    /// Cursor is stored as a char offset (not byte offset) so it never
    /// lands between bytes of a multi-byte character.
    fn cursor_byte_pos(&self) -> usize {
        self.input
            .char_indices()
            .nth(self.cursor)
            .map(|(i, _)| i)
            .unwrap_or(self.input.len())
    }

    /// Character count of the input (not byte length).
    fn input_char_len(&self) -> usize {
        self.input.chars().count()
    }

    async fn refresh_connected_models(&mut self) {
        self.detected_clis = forge_provider::cli::detect_cli_tools().await;
        self.skills = forge_signet::skills::load_skills();

        if let Some(client) = &self.signet_client {
            let _ = refresh_daemon_model_registry(client).await;
            if let Ok(resp) = client.get("/api/pipeline/models").await {
                if let Some(models) = resp.get("models").and_then(|v| v.as_array()) {
                    self.registry_models = models
                        .iter()
                        .filter_map(|m| {
                            let id = m.get("id")?.as_str()?;
                            let provider = m.get("provider")?.as_str()?;
                            let label = m.get("label")?.as_str()?;
                            let deprecated =
                                m.get("deprecated").and_then(|v| v.as_bool()).unwrap_or(false);
                            if deprecated {
                                return None;
                            }
                            Some(crate::views::model_picker::ModelEntry {
                                provider: provider.to_string(),
                                model: id.to_string(),
                                display_name: label.to_string(),
                                context_window: 200_000,
                                cli_path: None,
                            })
                        })
                        .collect();
                }
            }

            self.connected_providers = discover_available_providers(Some(client))
                .await
                .into_iter()
                .map(|p| p.provider)
                .collect();

            self.mcp_servers = client
                .get("/api/marketplace/mcp")
                .await
                .ok()
                .and_then(|resp| resp.get("servers").and_then(|v| v.as_array()).cloned())
                .map(|servers| {
                    servers
                        .iter()
                        .filter_map(|server| {
                            let enabled = server
                                .get("enabled")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true);
                            if !enabled {
                                return None;
                            }
                            Some(signet_commands::McpServerCommand {
                                server_id: server.get("id")?.as_str()?.to_string(),
                                server_name: server
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("MCP Server")
                                    .to_string(),
                                description: server
                                    .get("description")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();

            self.mcp_tools = client
                .get("/api/marketplace/mcp/tools?refresh=1")
                .await
                .ok()
                .and_then(|resp| resp.get("tools").and_then(|v| v.as_array()).cloned())
                .map(|tools| {
                    tools
                        .iter()
                        .filter_map(|tool| {
                            Some(signet_commands::McpToolCommand {
                                server_id: tool.get("serverId")?.as_str()?.to_string(),
                                server_name: tool
                                    .get("serverName")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("MCP Server")
                                    .to_string(),
                                tool_name: tool.get("toolName")?.as_str()?.to_string(),
                                description: tool
                                    .get("description")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
        }

        self.signet_commands = signet_commands::commands_with_dynamic(
            &self.skills,
            &self.mcp_servers,
            &self.mcp_tools,
        );
    }

    fn open_model_picker(&mut self) {
        self.model_picker = Some(ModelPicker::with_all(
            &self.detected_clis,
            &self.registry_models,
            &self.connected_providers,
        ));
    }

    pub async fn new(
        provider: Arc<dyn Provider>,
        signet_client: Option<SignetClient>,
        system_prompt: String,
        cli_path: Option<String>,
        theme_name: &str,
        active_agent: Option<String>,
        connected_providers: Vec<String>,
    ) -> Self {
        let model = provider.model().to_string();
        let provider_name = provider.name().to_string();
        let context_window = provider.context_window();

        let cwd = std::env::current_dir()
            .ok()
            .map(|p| p.display().to_string());

        let session = Session::shared(&model, &provider_name, cwd.clone());
        let session_id = session.lock().await.id.clone();

        let (event_tx, event_rx) = mpsc::channel::<AgentEvent>(256);
        let (permission_tx, permission_rx) = mpsc::channel::<PermissionRequest>(8);

        // Shared recall cache — used by both agent hooks and TUI speculative recall
        let recall_cache = forge_signet::recall_cache::RecallCache::new();

        // Set up session hooks if daemon is available
        let hooks = signet_client.as_ref().map(|client| {
            SessionHooks::with_cache(
                client.clone(),
                session_id,
                cwd.clone(),
                recall_cache.clone(),
            )
        });

        let daemon_healthy = if let Some(client) = &signet_client {
            client.is_available().await
        } else {
            false
        };

        // Call session-start hook to get initial context
        let mut memories_injected = 0;
        if let Some(hooks) = &hooks {
            match hooks.session_start().await {
                Ok((context, count)) if !context.is_empty() => {
                    debug!("Session start: {} bytes, {} memories", context.len(), count);
                    memories_injected = count;
                }
                Ok(_) => {
                    debug!("Session start hook returned empty context");
                }
                Err(e) => {
                    debug!("Session start hook failed (non-fatal): {e}");
                }
            }
        }

        let permissions = Arc::new(Mutex::new(PermissionManager::new(vec![
            "Read".to_string(),
            "Glob".to_string(),
            "Grep".to_string(),
        ])));

        let effort = Arc::new(Mutex::new(forge_provider::ReasoningEffort::default()));
        let bypass = Arc::new(Mutex::new(false));

        let daemon_url = signet_client.as_ref().map(|c| c.base_url().to_string());
        let agent = Arc::new(AgentLoop::new(
            provider,
            hooks,
            event_tx,
            permission_tx,
            Arc::clone(&permissions),
            system_prompt.clone(),
            Arc::clone(&effort),
            Arc::clone(&bypass),
            daemon_url,
            Vec::new(),
        ));

        // Start config watcher
        let config_rx = match ConfigWatcher::start() {
            Ok((_watcher, rx)) => {
                // Keep watcher alive by leaking it (it runs in a background thread)
                // The watcher is dropped when the app exits
                std::mem::forget(_watcher);
                Some(rx)
            }
            Err(e) => {
                info!("Config watcher unavailable: {e}");
                None
            }
        };

        // Open session store
        let session_store = match SessionStore::open() {
            Ok(store) => Some(store),
            Err(e) => {
                info!("Session persistence unavailable: {e}");
                None
            }
        };

        // Load pipeline info from agent config
        let pipeline_info = forge_signet::config::load_agent_config()
            .map(|c| c.pipeline_summary())
            .unwrap_or_else(|_| "unknown".to_string());

        // Load skills from ~/.agents/skills/
        let skills = forge_signet::skills::load_skills();
        debug!("Loaded {} skills", skills.len());

        // Fetch total memory and secrets count from daemon
        let (total_memories, total_secrets) = if let Some(client) = &signet_client {
            let mem = client.memory_count().await;
            let sec = client.get("/api/secrets").await
                .ok()
                .and_then(|v| v.get("secrets").and_then(|s| s.as_array()).map(|a| a.len()))
                .unwrap_or(0);
            (mem, sec)
        } else {
            (0, 0)
        };

        let (voice_result_tx, voice_result_rx) = mpsc::channel::<VoiceResult>(16);

        Self {
            input: String::new(),
            cursor: 0,
            entries: Vec::new(),
            streaming_text: String::new(),
            pending_text: String::new(),
            turn_complete_pending: false,
            scroll_offset: 0,
            session,
            model,
            provider_name,
            context_window,
            theme: crate::theme::Theme::by_name(theme_name),
            keybinds: KeyBindConfig::load(),
            attached_images: Vec::new(),
            cli_path,
            detected_clis: Vec::new(),
            registry_models: Vec::new(),
            connected_providers,
            effort,
            bypass,
            memories_injected,
            total_memories,
            total_secrets,
            secrets_used: 0,
            daemon_healthy,
            processing: false,
            processing_phase: ProcessingPhase::Idle,
            tick: 0,
            agent_task: None,
            should_quit: false,
            event_rx,
            permission_rx,
            permission_dialog: None,
            model_picker: None,
            command_palette: None,
            command_picker: None,
            dashboard_nav: None,
            keybind_editor: None,
            session_browser: None,
            dashboard_panel: None,
            forge_usage: None,
            skills,
            signet_commands: Vec::new(),
            mcp_servers: Vec::new(),
            mcp_tools: Vec::new(),
            pending_skill: None,
            signet_client,
            permissions,
            system_prompt,
            agent,
            config_rx,
            session_store,
            pipeline_info,
            agent_name: forge_signet::config::agent_name(),
            active_agent,
            daemon_logs: Vec::new(),
            speculative_query: String::new(),
            speculative_handle: None,
            last_keystroke: std::time::Instant::now(),
            recall_cache,
            voice_recorder: None,
            voice_recording: false,
            voice_model_path: None,
            voice_interim_text: String::new(),
            voice_downloading: false,
            voice_last_interim: std::time::Instant::now(),
            voice_interim_handle: None,
            voice_result_rx: Some(voice_result_rx),
            voice_result_tx,
        }
    }

    /// Run the TUI event loop
    pub async fn run(&mut self, terminal: &mut DefaultTerminal) -> anyhow::Result<()> {
        info!(
            "Forge TUI starting — model: {}, provider: {}",
            self.model, self.provider_name
        );

        // Enable bracketed paste so we can detect drag-and-drop file paths
        let _ = crossterm::execute!(std::io::stdout(), crossterm::event::EnableBracketedPaste);

        self.refresh_connected_models().await;

        // Start SSE log stream from daemon (background task)
        let (log_tx, mut log_rx) = tokio::sync::mpsc::channel::<String>(64);
        if let Some(client) = &self.signet_client {
            let url = format!("{}/api/logs/stream", client.base_url());
            tokio::spawn(async move {
                use futures::StreamExt;
                use reqwest_eventsource::{Event as SseEvent, EventSource};
                let mut es = EventSource::get(&url);
                while let Some(event) = es.next().await {
                    match event {
                        Ok(SseEvent::Message(msg)) => {
                            let _ = log_tx.try_send(msg.data);
                        }
                        Err(_) => {
                            // Connection lost — wait and retry
                            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        }
                        _ => {}
                    }
                }
            });
        }

        loop {
            // Drain SSE log messages
            while let Ok(log) = log_rx.try_recv() {
                self.daemon_logs.push(log);
                if self.daemon_logs.len() > 100 {
                    self.daemon_logs.remove(0);
                }
            }

            // Increment animation tick
            self.tick = self.tick.wrapping_add(1);

            // Draw
            terminal.draw(|frame| self.draw(frame))?;

            // Handle events with a short timeout so we can process agent events
            if event::poll(std::time::Duration::from_millis(50))? {
                match event::read()? {
                    Event::Key(key) if key.kind == KeyEventKind::Press => {
                        self.handle_key(key).await;
                    }
                    Event::Paste(text) => {
                        // Bracketed paste — handle file drops and multi-line paste
                        self.handle_paste(&text);
                    }
                    Event::Resize(_, _) => {
                        // Terminal resized — reset scroll to bottom so content reflows
                        self.scroll_offset = 0;
                    }
                    _ => {}
                }
            }

            // Drain agent events
            while let Ok(event) = self.event_rx.try_recv() {
                self.handle_agent_event(event);
            }

            // Drip streaming — release pending text word-by-word for live feel.
            // Find the next word boundary (space/newline) after a minimum offset,
            // so text never cuts mid-word.
            if !self.pending_text.is_empty() {
                // Min 4 chars, then extend to next word boundary
                let min_chars = 4;
                let min_byte = self
                    .pending_text
                    .char_indices()
                    .nth(min_chars)
                    .map(|(i, _)| i)
                    .unwrap_or(self.pending_text.len());
                // Find next space or newline after min_byte
                let boundary = self.pending_text[min_byte..]
                    .find([' ', '\n'])
                    .map(|pos| min_byte + pos + 1) // include the space
                    .unwrap_or(self.pending_text.len().min(min_byte + 20)); // cap at ~20 extra chars
                let boundary = boundary.min(self.pending_text.len());
                let chunk: String = self.pending_text.drain(..boundary).collect();
                self.streaming_text.push_str(&chunk);
                // Safety: prevent unbounded growth
                if self.streaming_text.len() > 512 * 1024 {
                    self.entries
                        .push(ChatEntry::AssistantText(self.streaming_text.clone()));
                    self.streaming_text.clear();
                }
            }

            // Deferred turn completion — commit text after drip buffer empties
            if self.turn_complete_pending && self.pending_text.is_empty() {
                if !self.streaming_text.is_empty() {
                    self.entries
                        .push(ChatEntry::AssistantText(self.streaming_text.clone()));
                    self.streaming_text.clear();
                }
                self.processing = false;
                self.processing_phase = ProcessingPhase::Idle;
                self.turn_complete_pending = false;
            }

            // Safety: if agent task finished but processing is still true,
            // the TurnComplete event was lost — force-reset to unblock input
            if self.processing {
                if let Some(handle) = &self.agent_task {
                    if handle.is_finished() {
                        // Drain any remaining events one more time
                        while let Ok(event) = self.event_rx.try_recv() {
                            self.handle_agent_event(event);
                        }
                        // Still stuck? Force reset
                        if self.processing {
                            self.streaming_text.push_str(&self.pending_text);
                            self.pending_text.clear();
                            self.turn_complete_pending = false;
                            if !self.streaming_text.is_empty() {
                                self.entries
                                    .push(ChatEntry::AssistantText(self.streaming_text.clone()));
                                self.streaming_text.clear();
                            }
                            self.processing = false;
                            self.processing_phase = ProcessingPhase::Idle;
                            self.agent_task = None;
                        }
                    }
                }
            }

            // Check for permission requests
            while let Ok(request) = self.permission_rx.try_recv() {
                self.permission_dialog = Some(PermissionDialog {
                    tool_name: request.tool_name,
                    tool_input: request.tool_input,
                    response_tx: request.response_tx,
                    selected: 0,
                });
            }

            // Drain config change events silently — just update internal state
            if let Some(rx) = &mut self.config_rx {
                while let Ok(event) = rx.try_recv() {
                    match event {
                        ConfigEvent::Reloaded(config) => {
                            self.pipeline_info = config.pipeline_summary();
                            // Silent update — no chat spam
                        }
                        ConfigEvent::Error(_) => {
                            // Ignore config errors silently
                        }
                    }
                }
            }

            // Drain voice transcription results — collect first to avoid borrow conflict
            {
                let mut voice_events: Vec<VoiceResult> = Vec::new();
                if let Some(rx) = &mut self.voice_result_rx {
                    while let Ok(result) = rx.try_recv() {
                        voice_events.push(result);
                    }
                }
                for result in voice_events {
                    match result {
                        VoiceResult::Interim(text) => {
                            self.voice_interim_text = text;
                        }
                        VoiceResult::Final(text) => {
                            self.voice_recording = false;
                            self.voice_recorder = None;
                            self.voice_interim_text.clear();
                            if !text.is_empty() {
                                let byte_pos = self.cursor_byte_pos();
                                self.input.insert_str(byte_pos, &text);
                                self.cursor += text.chars().count();
                            }
                        }
                        VoiceResult::ModelReady(path) => {
                            self.voice_model_path = Some(path);
                            self.voice_downloading = false;
                            self.entries.push(ChatEntry::Status(
                                "Voice model ready.".to_string(),
                            ));
                            self.start_voice_recording();
                        }
                        VoiceResult::Error(msg) => {
                            self.voice_downloading = false;
                            self.voice_recording = false;
                            self.voice_recorder = None;
                            self.voice_interim_text.clear();
                            self.entries
                                .push(ChatEntry::Error(format!("Voice: {msg}")));
                        }
                    }
                }
            }

            // Trigger interim transcription every ~2 seconds while recording
            if self.voice_recording
                && self.voice_last_interim.elapsed() > std::time::Duration::from_secs(2)
            {
                self.voice_last_interim = std::time::Instant::now();
                self.trigger_interim_transcription();
            }

            // Speculative pre-recall — fire after 500ms of no typing
            if !self.processing
                && !self.input.is_empty()
                && !self.input.starts_with('/')
                && self.input != self.speculative_query
                && self.last_keystroke.elapsed() > std::time::Duration::from_millis(500)
            {
                if let Some(signet) = &self.signet_client {
                let query = self.input.clone();
                self.speculative_query = query.clone();

                // Cancel any in-flight speculative task
                if let Some(handle) = self.speculative_handle.take() {
                    handle.abort();
                }

                let client = signet.clone();
                let cache = self.recall_cache.clone();
                self.speculative_handle = Some(tokio::spawn(async move {
                    // Call daemon recall and store result in shared cache
                    let body = serde_json::json!({
                        "harness": "forge",
                        "sessionId": "speculative",
                        "userMessage": query,
                        "runtimePath": "plugin",
                    });
                    if let Ok(result) = client
                        .post("/api/hooks/user-prompt-submit", &body)
                        .await
                    {
                        let injection = result
                            .get("inject")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let count = result
                            .get("memoryCount")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as usize;
                        if !injection.is_empty() {
                            cache.put(query, injection, count).await;
                        }
                    }
                }));
            }
            }

            if self.should_quit {
                // Auto-save session before quitting
                self.save_session().await;
                break;
            }
        }

        // Disable bracketed paste
        let _ = crossterm::execute!(std::io::stdout(), crossterm::event::DisableBracketedPaste);

        // Submit transcript for extraction
        self.submit_transcript().await;

        Ok(())
    }

    fn draw(&self, frame: &mut Frame) {
        let area = frame.area();

        // Fill the entire terminal with the theme background
        let bg_block = Block::default().style(Style::default().bg(self.theme.bg));
        frame.render_widget(bg_block, area);

        // Layout: [status_bar(2)] [chat(flex)] [input(dynamic)]
        // Input expands based on content lines, capped at 1/3 of terminal height
        let input_width = area.width.saturating_sub(5) as usize; // account for " > " prefix + border
        let input_lines = if input_width == 0 || self.input.is_empty() {
            1
        } else {
            use unicode_width::UnicodeWidthStr;
            let display_width: usize = self.input.width();
            1u16.max(display_width.div_ceil(input_width) as u16)
        };
        let max_input = (area.height / 3).max(3);
        let input_height = (input_lines + 2).min(max_input); // +2 for border + padding
        let chunks = Layout::vertical([
            Constraint::Length(2),            // status bar
            Constraint::Min(5),              // chat area
            Constraint::Length(input_height), // input area
        ])
        .split(area);

        // Read session state for display
        let (input_tokens, output_tokens) = if let Ok(s) = self.session.try_lock() {
            (s.total_input_tokens, s.total_output_tokens)
        } else {
            (0, 0)
        };

        // Status bar
        let effort_str = self
            .effort
            .try_lock()
            .map(|e| e.as_str().to_string())
            .unwrap_or_else(|_| "medium".to_string());

        let status = StatusBar {
            model: &self.model,
            provider: &self.provider_name,
            input_tokens,
            output_tokens,
            context_window: self.context_window,
            memories_injected: self.memories_injected,
            total_memories: self.total_memories,
            total_secrets: self.total_secrets,
            secrets_used: self.secrets_used,
            effort: &effort_str,
            daemon_healthy: self.daemon_healthy,
            active_agent: self.active_agent.as_deref(),
            agent_name: &self.agent_name,
            keybinds: &self.keybinds,
            status_bg: self.theme.status_bg,
            status_fg: self.theme.status_fg,
            accent: self.theme.accent,
            muted: self.theme.muted,
            success: self.theme.success,
            error: self.theme.error,
            warning: self.theme.warning,
            spinner: self.theme.spinner,
        };
        status.render(chunks[0], frame.buffer_mut());

        // Chat area — render animated activity line when processing or recording
        let activity_line = if self.voice_downloading {
            Some("  ◈ Downloading voice model (142MB)...".to_string())
        } else if self.voice_recording {
            let dots = ".".repeat((self.tick / 4) % 4);
            Some(format!("  ● Recording{dots} (Ctrl+R to stop)"))
        } else if self.processing {
            let rendered = self.processing_phase.render(self.tick);
            if rendered.is_empty() { None } else { Some(rendered) }
        } else {
            None
        };

        let chat = ChatView {
            entries: &self.entries,
            streaming_text: &self.streaming_text,
            scroll_offset: self.scroll_offset,
            activity_line,
            agent_name: &self.agent_name,
            total_memories: self.total_memories,
            tick: self.tick,
            theme: &self.theme,
        };
        chat.render(chunks[1], frame.buffer_mut());

        // Input area — always active so users can type ahead
        let input_style = Style::default().fg(self.theme.fg);

        let input_block = Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(self.theme.accent));

        let input_text = if self.input.is_empty() && self.voice_interim_text.is_empty() {
            let placeholder = if self.voice_recording {
                " Listening..."
            } else {
                " Type a message or Ctrl+R to speak..."
            };
            Paragraph::new(Span::styled(
                placeholder,
                Style::default().fg(self.theme.muted),
            ))
            .wrap(Wrap { trim: false })
        } else if !self.voice_interim_text.is_empty() {
            // Show committed input + grayed interim preview
            let mut spans = vec![];
            if !self.input.is_empty() {
                spans.push(Span::styled(format!(" > {}", &self.input), input_style));
            } else {
                spans.push(Span::styled(" > ", input_style));
            }
            spans.push(Span::styled(
                &self.voice_interim_text,
                Style::default().fg(self.theme.muted),
            ));
            Paragraph::new(Line::from(spans)).wrap(Wrap { trim: false })
        } else {
            Paragraph::new(Span::styled(format!(" > {}", &self.input), input_style))
                .wrap(Wrap { trim: false })
        };

        // Scroll input to keep cursor visible when text exceeds max height
        let visible_content = input_height.saturating_sub(2); // minus border + padding
        let cursor_offset = self.cursor as u16 + 3; // " > " prefix
        let iw = chunks[2].width.saturating_sub(1).max(1);
        let cursor_line = cursor_offset / iw;
        let input_scroll = cursor_line.saturating_sub(visible_content.saturating_sub(1));

        let input_widget = input_text.scroll((input_scroll, 0)).block(input_block);
        frame.render_widget(input_widget, chunks[2]);

        // Slash command autocomplete dropdown
        if self.input.starts_with('/') && self.input.len() < 30 {
            signet_commands::render_autocomplete(
                &self.input,
                &self.signet_commands,
                chunks[2],
                frame.buffer_mut(),
                &self.theme,
            );
        }

        // Position cursor — always visible, accounts for input scroll
        if self.permission_dialog.is_none() {
            let cx = chunks[2].x + (cursor_offset % iw);
            let cy = chunks[2].y + 1 + cursor_line - input_scroll;
            frame.set_cursor_position((cx, cy));
        }

        // Permission dialog overlay
        if let Some(dialog) = &self.permission_dialog {
            self.draw_permission_dialog(frame, dialog);
        }

        // Model picker overlay
        if let Some(picker) = &self.model_picker {
            picker.draw(frame, &self.theme);
        }

        // Command palette overlay
        if let Some(palette) = &self.command_palette {
            palette.draw(frame, &self.theme);
        }

        // Signet command picker overlay (Ctrl+G)
        if let Some(picker) = &self.command_picker {
            let area = frame.area();
            picker.render_themed(area, frame.buffer_mut(), &self.theme);
        }

        // Dashboard navigator overlay (Ctrl+Tab)
        if let Some(nav) = &self.dashboard_nav {
            let area = frame.area();
            nav.render_themed(area, frame.buffer_mut(), &self.theme);
        }

        // Keybind editor overlay
        if let Some(editor) = &self.keybind_editor {
            let area = frame.area();
            editor.render_themed(area, frame.buffer_mut(), &self.theme);
        }

        // Session browser overlay
        if let Some(browser) = &self.session_browser {
            let area = frame.area();
            browser.render_themed(area, frame.buffer_mut(), &self.theme);
        }

        // Dashboard panel overlay
        if let Some(panel) = &self.dashboard_panel {
            let area = frame.area();
            panel.render_themed(area, frame.buffer_mut(), &self.theme);
        }

        // Usage overlay
        if let Some(usage) = &self.forge_usage {
            let area = frame.area();
            usage.render_themed(area, frame.buffer_mut(), &self.theme);
        }
    }

    fn draw_permission_dialog(&self, frame: &mut Frame, dialog: &PermissionDialog) {
        let area = frame.area();

        // Center the dialog
        let dialog_width = 60u16.min(area.width.saturating_sub(4));
        let dialog_height = 10u16.min(area.height.saturating_sub(4));
        let x = (area.width.saturating_sub(dialog_width)) / 2;
        let y = (area.height.saturating_sub(dialog_height)) / 2;
        let dialog_area = ratatui::layout::Rect::new(x, y, dialog_width, dialog_height);

        // Clear the area behind the dialog and fill with themed bg
        frame.render_widget(Clear, dialog_area);
        let bg_block = Block::default().style(Style::default().bg(self.theme.dialog_bg));
        frame.render_widget(bg_block, dialog_area);

        // Build dialog content
        let input_preview = serde_json::to_string_pretty(&dialog.tool_input)
            .unwrap_or_else(|_| format!("{:?}", dialog.tool_input));
        let preview_lines: Vec<&str> = input_preview.lines().take(3).collect();

        let options = ["[Y] Allow", "[A] Always Allow", "[N] Deny"];

        let t = &self.theme;

        let mut lines = vec![
            Line::from(""),
            Line::from(vec![
                Span::styled("  Tool: ", Style::default().fg(t.warning)),
                Span::styled(
                    &dialog.tool_name,
                    Style::default()
                        .fg(t.fg_bright)
                        .add_modifier(Modifier::BOLD),
                ),
            ]),
            Line::from(""),
        ];

        for pl in &preview_lines {
            lines.push(Line::from(Span::styled(
                format!("  {pl}"),
                Style::default().fg(t.muted),
            )));
        }

        lines.push(Line::from(""));

        let mut option_spans = vec![Span::styled("  ", Style::default().fg(t.fg))];
        for (i, opt) in options.iter().enumerate() {
            let style = if i == dialog.selected {
                Style::default()
                    .fg(t.selected_fg)
                    .bg(t.selected_bg)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(t.fg)
            };
            option_spans.push(Span::styled(*opt, style));
            if i < options.len() - 1 {
                option_spans.push(Span::styled("  ", Style::default().fg(t.fg)));
            }
        }
        lines.push(Line::from(option_spans));

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(t.warning))
            .title(" Allow tool execution? ")
            .title_style(Style::default().fg(t.warning).add_modifier(Modifier::BOLD));

        let paragraph = Paragraph::new(lines).block(block);
        frame.render_widget(paragraph, dialog_area);
    }

    async fn handle_key(&mut self, key: crossterm::event::KeyEvent) {
        // If usage overlay is open, handle its keys
        if self.forge_usage.is_some() {
            self.handle_forge_usage_key(key);
            return;
        }

        // If dashboard panel is open, handle its keys
        if self.dashboard_panel.is_some() {
            self.handle_dashboard_panel_key(key).await;
            return;
        }

        // If session browser is open, handle its keys
        if self.session_browser.is_some() {
            self.handle_session_browser_key(key).await;
            return;
        }

        // If keybind editor is open, handle its keys (including capture mode)
        if self.keybind_editor.is_some() {
            self.handle_keybind_editor_key(key);
            return;
        }

        // If dashboard navigator is open, handle nav keys
        if self.dashboard_nav.is_some() {
            self.handle_dashboard_nav_key(key).await;
            return;
        }

        // If Signet command picker is open, handle picker keys
        if self.command_picker.is_some() {
            self.handle_command_picker_key(key).await;
            return;
        }

        // If command palette is open, handle palette keys
        if self.command_palette.is_some() {
            self.handle_command_palette_key(key).await;
            return;
        }

        // If model picker is open, handle picker keys
        if self.model_picker.is_some() {
            self.handle_model_picker_key(key).await;
            return;
        }

        // If permission dialog is open, handle dialog keys
        if self.permission_dialog.is_some() {
            self.handle_permission_key(key).await;
            return;
        }

        // Resolve key event through configurable keybinds first, fall back to input.rs
        let action = if let Some(action_id) = self.keybinds.resolve(&key) {
            match action_id {
                "submit" => Action::Submit,
                "cancel" => Action::Cancel,
                "quit" => Action::Quit,
                "model_picker" => Action::ModelPicker,
                "command_palette" => Action::CommandPalette,
                "signet_commands" => Action::SignetCommands,
                "dashboard" => Action::Dashboard,
                "dashboard_nav" => Action::DashboardNav,
                "keybinds" => Action::Keybinds,
                "session_browser" => Action::SessionBrowser,
                "voice_input" => Action::VoiceInput,
                "clear_screen" => Action::ClearScreen,
                "scroll_up" => Action::ScrollUp,
                "scroll_down" => Action::ScrollDown,
                "newline" => Action::NewLine,
                "paste" => Action::Paste,
                _ => Action::None,
            }
        } else {
            // Fall back to hardcoded input handling for basic editing keys
            crate::input::key_to_action(key)
        };

        match action {
            Action::Submit if !self.processing && !self.input.is_empty() => {
                // Stop voice recording if active (auto-stop on send)
                if self.voice_recording {
                    self.stop_voice_recording();
                }

                let input = self.input.clone();
                self.input.clear();
                self.cursor = 0;

                // Always reset scroll to bottom when user submits
                self.scroll_offset = 0;

                // Check for slash commands — must start with / followed by a letter,
                // and the first word must not contain another / (which would be a file path)
                let is_command = input.starts_with('/')
                    && input.chars().nth(1).is_some_and(|c| c.is_ascii_lowercase())
                    && !input[1..].split_whitespace().next().unwrap_or("").contains('/');
                if is_command {
                    self.handle_slash_command(&input).await;
                } else {
                    self.processing = true;
                    self.processing_phase = ProcessingPhase::RecallingMemories;
                    let final_input = if let Some((skill_name, skill_content)) = self.pending_skill.take() {
                        self.entries.push(ChatEntry::Status(format!(
                            "Applying skill /{} to this prompt.",
                            skill_name
                        )));
                        format!("<skill name=\"{skill_name}\">\n{skill_content}\n</skill>\n\n{input}")
                    } else {
                        input.clone()
                    };
                    self.entries.push(ChatEntry::UserMessage(input.clone()));

                    let agent = Arc::clone(&self.agent);
                    let session = Arc::clone(&self.session);
                    self.agent_task = Some(tokio::spawn(async move {
                        agent.process_message(&session, &final_input).await;
                    }));
                }
            }
            Action::InsertChar(c) => {
                // Clear ephemeral command output when user starts typing
                if self.input.is_empty() {
                    self.entries.retain(|e| !matches!(e, ChatEntry::Ephemeral(_)));
                }
                let byte_pos = self.cursor_byte_pos();
                self.input.insert(byte_pos, c);
                self.cursor += 1;
                self.last_keystroke = std::time::Instant::now();
            }
            Action::Backspace if self.cursor > 0 => {
                self.last_keystroke = std::time::Instant::now();
                self.cursor -= 1;
                let byte_pos = self.cursor_byte_pos();
                self.input.remove(byte_pos);
            }
            Action::Delete if self.cursor < self.input_char_len() => {
                let byte_pos = self.cursor_byte_pos();
                self.input.remove(byte_pos);
            }
            Action::CursorLeft if self.cursor > 0 => {
                self.cursor -= 1;
            }
            Action::CursorRight if self.cursor < self.input_char_len() => {
                self.cursor += 1;
            }
            Action::TabComplete => {
                if self.input.starts_with('/') {
                    if let Some(completed) =
                        signet_commands::tab_complete(&self.input, &self.signet_commands)
                    {
                        self.input = completed;
                        self.cursor = self.input_char_len();
                    }
                }
            }
            Action::Home => {
                self.cursor = 0;
            }
            Action::End => {
                self.cursor = self.input_char_len();
            }
            Action::ScrollUp => {
                self.scroll_offset = self.scroll_offset.saturating_add(3);
            }
            Action::ScrollDown => {
                self.scroll_offset = self.scroll_offset.saturating_sub(3);
            }
            Action::Cancel => {
                // Always clear voice state on cancel
                if self.voice_recording {
                    self.voice_recording = false;
                    self.voice_recorder = None;
                    self.voice_interim_text.clear();
                }
                if self.processing {
                    // Abort the running agent task (kills CLI subprocess too)
                    if let Some(handle) = self.agent_task.take() {
                        handle.abort();
                    }
                    // Flush any partial streaming text
                    if !self.streaming_text.is_empty() {
                        self.entries
                            .push(ChatEntry::AssistantText(self.streaming_text.clone()));
                        self.streaming_text.clear();
                    }
                    self.processing = false;
                    self.processing_phase = ProcessingPhase::Idle;
                    self.entries.push(ChatEntry::Status("Cancelled.".to_string()));
                }
            }
            Action::Quit => {
                self.should_quit = true;
            }
            Action::ModelPicker if !self.processing => {
                self.refresh_connected_models().await;
                self.open_model_picker();
            }
            Action::CommandPalette if !self.processing => {
                self.command_palette = Some(CommandPalette::new(&self.skills));
            }
            Action::Paste => {
                self.clipboard_paste();
            }
            Action::ClearScreen => {
                self.entries.clear();
                self.streaming_text.clear();
                self.scroll_offset = 0;
            }
            Action::SignetCommands if !self.processing => {
                self.command_picker = Some(CommandPicker::new(self.signet_commands.clone()));
            }
            Action::DashboardNav if !self.processing => {
                self.dashboard_nav = Some(DashboardNav::new());
            }
            Action::Keybinds if !self.processing => {
                self.keybind_editor = Some(KeybindEditor::new());
            }
            Action::SessionBrowser if !self.processing => {
                self.session_browser = Some(SessionBrowser::new());
            }
            Action::DashboardPanel => {
                self.open_dashboard_panel().await;
            }
            Action::Dashboard if !self.processing => {
                self.dashboard_nav = Some(DashboardNav::new());
            }
            Action::VoiceInput => {
                self.handle_voice_toggle().await;
            }
            _ => {}
        }
    }

    async fn open_dashboard_panel(&mut self) {
        let mut panel = DashboardPanel::new();
        panel.logs = self.daemon_logs.clone();
        if let Some(client) = &self.signet_client {
            let (mem, pipe, emb, diag) = tokio::join!(
                client.get("/api/memories?limit=0"),
                client.get("/api/pipeline/status"),
                client.get("/api/embeddings/health"),
                client.get("/api/diagnostics"),
            );
            panel.data = crate::views::dashboard_panel::parse_dashboard(
                mem.ok().as_ref(),
                pipe.ok().as_ref(),
                emb.ok().as_ref(),
                diag.ok().as_ref(),
            );
            panel.loading = false;
        } else {
            panel.loading = false;
        }
        self.dashboard_panel = Some(panel);
    }

    async fn handle_dashboard_panel_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;
        match key.code {
            KeyCode::Esc => {
                self.dashboard_panel = None;
            }
            KeyCode::Left => {
                if let Some(panel) = &mut self.dashboard_panel {
                    panel.prev_tab();
                }
            }
            KeyCode::Right | KeyCode::Tab => {
                if let Some(panel) = &mut self.dashboard_panel {
                    panel.next_tab();
                }
            }
            KeyCode::Char('r') | KeyCode::Char('R') => {
                // Refresh
                self.open_dashboard_panel().await;
            }
            _ => {}
        }
    }

    fn handle_forge_usage_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;
        match key.code {
            KeyCode::Esc => {
                self.forge_usage = None;
            }
            KeyCode::Up => {
                if let Some(usage) = &mut self.forge_usage {
                    usage.scroll_up();
                }
            }
            KeyCode::Down => {
                if let Some(usage) = &mut self.forge_usage {
                    usage.scroll_down();
                }
            }
            KeyCode::Char('r') | KeyCode::Char('R') => {
                self.forge_usage = Some(ForgeUsage::new());
            }
            _ => {}
        }
    }

    async fn handle_session_browser_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;
        match key.code {
            KeyCode::Esc => {
                self.session_browser = None;
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if let Some(browser) = &mut self.session_browser {
                    browser.move_up();
                }
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if let Some(browser) = &mut self.session_browser {
                    browser.move_down();
                }
            }
            KeyCode::PageUp => {
                if let Some(browser) = &mut self.session_browser {
                    browser.page_up(8);
                }
            }
            KeyCode::PageDown => {
                if let Some(browser) = &mut self.session_browser {
                    browser.page_down(8);
                }
            }
            KeyCode::Home => {
                if let Some(browser) = &mut self.session_browser {
                    browser.home();
                }
            }
            KeyCode::End => {
                if let Some(browser) = &mut self.session_browser {
                    browser.end();
                }
            }
            KeyCode::Enter => {
                let session_id = self
                    .session_browser
                    .as_ref()
                    .and_then(|b| b.selected_session())
                    .map(|s| s.id.clone());
                self.session_browser = None;

                if let Some(id) = session_id {
                    self.resume_session(&id).await;
                }
            }
            _ => {}
        }
    }

    fn handle_keybind_editor_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;

        // If capturing, forward the key to the editor
        if let Some(editor) = &mut self.keybind_editor {
            if editor.capturing {
                editor.capture_key(key);
                // Reload keybinds into the app after save
                if !editor.capturing {
                    self.keybinds = editor.config.clone();
                }
                return;
            }
        }

        match key.code {
            KeyCode::Esc => {
                self.keybind_editor = None;
            }
            KeyCode::Up => {
                if let Some(editor) = &mut self.keybind_editor {
                    editor.move_up();
                }
            }
            KeyCode::Down => {
                if let Some(editor) = &mut self.keybind_editor {
                    editor.move_down();
                }
            }
            KeyCode::Enter => {
                if let Some(editor) = &mut self.keybind_editor {
                    editor.start_capture();
                }
            }
            KeyCode::Char('r') | KeyCode::Char('R') => {
                if let Some(editor) = &mut self.keybind_editor {
                    editor.reset_selected();
                    self.keybinds = editor.config.clone();
                }
            }
            _ => {}
        }
    }

    async fn handle_dashboard_nav_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;

        match key.code {
            KeyCode::Esc => {
                self.dashboard_nav = None;
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if let Some(nav) = &mut self.dashboard_nav {
                    nav.move_up();
                }
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if let Some(nav) = &mut self.dashboard_nav {
                    nav.move_down();
                }
            }
            KeyCode::PageUp => {
                if let Some(nav) = &mut self.dashboard_nav {
                    nav.page_up(8);
                }
            }
            KeyCode::PageDown => {
                if let Some(nav) = &mut self.dashboard_nav {
                    nav.page_down(8);
                }
            }
            KeyCode::Home => {
                if let Some(nav) = &mut self.dashboard_nav {
                    nav.home();
                }
            }
            KeyCode::End => {
                if let Some(nav) = &mut self.dashboard_nav {
                    nav.end();
                }
            }
            KeyCode::Enter => {
                let url = self.dashboard_nav.as_ref().and_then(|nav| {
                    let base = self
                        .signet_client
                        .as_ref()
                        .map(|c| c.base_url().to_string())
                        .unwrap_or_else(|| "http://localhost:3850".to_string());
                    nav.selected_url(&base)
                });

                self.dashboard_nav = None;

                if let Some(url) = url {
                    let result = std::process::Command::new("open")
                        .arg(&url)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();

                    match result {
                        Ok(s) if s.success() => {
                            self.entries.push(ChatEntry::Status(format!(
                                "Dashboard opened: {url}"
                            )));
                        }
                        _ => {
                            self.entries.push(ChatEntry::Error(format!(
                                "Failed to open dashboard. Visit: {url}"
                            )));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    async fn handle_command_picker_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;

        match key.code {
            KeyCode::Esc => {
                self.command_picker = None;
            }
            KeyCode::Up => {
                if let Some(picker) = &mut self.command_picker {
                    picker.move_up();
                }
            }
            KeyCode::Down => {
                if let Some(picker) = &mut self.command_picker {
                    picker.move_down();
                }
            }
            KeyCode::Enter => {
                if let Some(picker) = &self.command_picker {
                    if let Some(cmd) = picker.selected_command() {
                        self.command_picker = None;
                        // Route through slash command handler so Internal commands work
                        self.handle_slash_command(&format!("/{}", cmd.key)).await;
                    }
                }
            }
            KeyCode::Backspace => {
                if let Some(picker) = &mut self.command_picker {
                    picker.pop_char();
                }
            }
            KeyCode::Char(c) => {
                if let Some(picker) = &mut self.command_picker {
                    picker.push_char(c);
                }
            }
            _ => {}
        }
    }

    /// Handle /slash commands typed in the input
    /// Handle pasted text — detect image file paths or insert as text
    fn handle_paste(&mut self, text: &str) {
        let trimmed = text.trim();

        // Check if it's an image file path (dragged into terminal)
        if is_image_path(trimmed) {
            let path = trimmed
                .trim_matches('\'')
                .trim_matches('"')
                .to_string();

            if std::path::Path::new(&path).exists() {
                self.attached_images.push(path.clone());
                self.entries.push(ChatEntry::Status(format!(
                    "◇ Image attached: {} ({} total)",
                    std::path::Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| path.clone()),
                    self.attached_images.len()
                )));
                return;
            }
        }

        // Regular text paste — insert at cursor (char-safe)
        for c in trimmed.chars() {
            if c == '\n' {
                self.input.push('\n');
            } else {
                let byte_pos = self.cursor_byte_pos();
                self.input.insert(byte_pos, c);
                self.cursor += 1;
            }
        }
        self.last_keystroke = std::time::Instant::now();
    }

    /// Paste from system clipboard
    fn clipboard_paste(&mut self) {
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            // Try image first
            if let Ok(img) = clipboard.get_image() {
                // Save to temp file and attach
                let temp_path = std::env::temp_dir().join(format!(
                    "forge-paste-{}.png",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis()
                ));
                // Convert arboard image to PNG
                if let Ok(()) = save_clipboard_image(&img, &temp_path) {
                    self.attached_images.push(temp_path.display().to_string());
                    self.entries.push(ChatEntry::Status(format!(
                        "◇ Image pasted from clipboard ({} total)",
                        self.attached_images.len()
                    )));
                    return;
                }
            }

            // Fall back to text
            if let Ok(text) = clipboard.get_text() {
                if !text.is_empty() {
                    self.handle_paste(&text);
                }
            }
        }
    }

    async fn handle_slash_command(&mut self, input: &str) {
        let trimmed = input.trim_start_matches('/');
        let (cmd_name, args) = match trimmed.split_once(' ') {
            Some((name, rest)) => (name, rest.trim()),
            None => (trimmed, ""),
        };

        // Commands with arguments
        match cmd_name {
            "recall" if !args.is_empty() => {
                self.entries
                    .push(ChatEntry::Status(format!("◇ Recalling: {args}")));
                self.run_signet_cli(&["recall", args]).await;
                return;
            }
            "remember" if !args.is_empty() => {
                self.entries
                    .push(ChatEntry::Status("◇ Storing memory...".to_string()));
                self.run_signet_cli(&["remember", args]).await;
                return;
            }
            _ => {}
        }

        // Match against registered commands
        let commands = self.signet_commands.clone();
        if let Some(cmd) = commands.iter().find(|c| c.key == cmd_name) {
            match &cmd.kind {
                SlashCommandKind::Internal(action) => {
                    match action.as_str() {
                        "help" => {
                            let help = signet_commands::help_text(&self.signet_commands);
                            self.entries.push(ChatEntry::Ephemeral(help));
                        }
                        "clear" => {
                            self.entries.clear();
                            self.streaming_text.clear();
                            self.scroll_offset = 0;
                        }
                        "model" => {
                            self.refresh_connected_models().await;
                            self.open_model_picker();
                        }
                        "dashboard" => {
                            self.dashboard_nav = Some(DashboardNav::new());
                        }
                        "resume" => {
                            self.resume_last_session().await;
                        }
                        "compact" => {
                            self.entries
                                .push(ChatEntry::Status("Context compaction is automatic at 90% capacity.".to_string()));
                        }
                        "theme" => {
                            if args.is_empty() {
                                self.entries.push(ChatEntry::Status(format!(
                                    "Current theme: {}. Available: {}",
                                    self.theme.name,
                                    crate::theme::Theme::all_names().join(", ")
                                )));
                            } else {
                                self.theme = crate::theme::Theme::by_name(args);
                                self.entries.push(ChatEntry::Status(format!(
                                    "Theme set to: {}", self.theme.name
                                )));
                            }
                        }
                        "auth" => {
                            self.entries.push(ChatEntry::Status(
                                "Run `forge --auth` in your shell to open browser logins or paste API keys for providers.".to_string(),
                            ));
                        }
                        "keybinds" => {
                            self.keybind_editor = Some(KeybindEditor::new());
                        }
                        "extraction-model" => {
                            if let Some(client) = &self.signet_client {
                                if args.is_empty() {
                                    // Show current extraction model
                                    match client.get("/api/config").await {
                                        Ok(cfg) => {
                                            let model = cfg
                                                .pointer("/pipelineV2/extraction/model")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("unknown");
                                            self.entries.push(ChatEntry::Status(format!(
                                                "Extraction model: {model}. Usage: /extraction-model <model>"
                                            )));
                                        }
                                        Err(e) => {
                                            self.entries.push(ChatEntry::Error(format!("Failed to read config: {e}")));
                                        }
                                    }
                                } else {
                                    // Update extraction model via daemon
                                    let body = serde_json::json!({
                                        "path": "pipelineV2.extraction.model",
                                        "value": args
                                    });
                                    match client.post("/api/config", &body).await {
                                        Ok(_) => {
                                            self.entries.push(ChatEntry::Status(format!(
                                                "Extraction model set to: {args}"
                                            )));
                                        }
                                        Err(e) => {
                                            self.entries.push(ChatEntry::Error(format!("Failed to update: {e}")));
                                        }
                                    }
                                }
                            } else {
                                self.entries.push(ChatEntry::Error("No daemon connection".to_string()));
                            }
                        }
                        "effort" => {
                            if args.is_empty() {
                                let current = self.effort.lock().await;
                                self.entries.push(ChatEntry::Status(format!(
                                    "Current effort: {}. Usage: /effort low|medium|high",
                                    current.as_str()
                                )));
                            } else {
                                let new_effort = forge_provider::ReasoningEffort::parse(args);
                                *self.effort.lock().await = new_effort;
                                self.entries.push(ChatEntry::Status(format!(
                                    "Effort set to: {}", new_effort.as_str()
                                )));
                                self.save_settings();
                            }
                        }
                        "agent" => {
                            let agent_display = self.active_agent.as_deref().unwrap_or("default");
                            let agent_id = forge_signet::config::agent_id();
                            self.entries.push(ChatEntry::Status(format!(
                                "Agent: {} (id: {}, name: {})",
                                agent_display, agent_id, self.agent_name
                            )));
                        }
                        "signet-save-agent" => {
                            let dest = if args.is_empty() {
                                dirs::home_dir()
                                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                                    .join("signet-agent-export.zip")
                            } else {
                                std::path::PathBuf::from(args)
                            };
                            self.entries.push(ChatEntry::Status(format!(
                                "Exporting agent to {}...", dest.display()
                            )));
                            match export_agent_zip(&dest) {
                                Ok(count) => {
                                    self.entries.push(ChatEntry::Status(format!(
                                        "Agent exported: {} files → {}", count, dest.display()
                                    )));
                                }
                                Err(e) => {
                                    self.entries.push(ChatEntry::Error(format!("Export failed: {e}")));
                                }
                            }
                        }
                        "forge-bypass" => {
                            let mut b = self.bypass.lock().await;
                            *b = !*b;
                            let state = if *b { "ON" } else { "OFF" };
                            let detail = if *b {
                                match self.provider_name.as_str() {
                                    n if n.contains("claude") => " (--dangerously-skip-permissions)",
                                    n if n.contains("codex") => " (--dangerously-bypass-approvals-and-sandbox)",
                                    _ => "",
                                }
                            } else {
                                ""
                            };
                            self.entries.push(ChatEntry::Status(format!(
                                "Permission bypass: {state}{detail}"
                            )));
                            self.save_settings();
                        }
                        "forge-usage" => {
                            self.forge_usage = Some(ForgeUsage::new());
                        }
                        "mcp-help" => {
                            let mut help = String::from("◆ MCP Commands\n\n");
                            if self.mcp_servers.is_empty() {
                                help.push_str("  No installed MCP servers detected.\n");
                            } else {
                                help.push_str("  Server namespaces:\n");
                                for server in &self.mcp_servers {
                                    help.push_str(&format!(
                                        "    /mcp-{} <tool> [json args]  {}\n",
                                        server.server_id, server.server_name
                                    ));
                                }
                                help.push_str("\n  Direct tool commands:\n");
                                for tool in &self.mcp_tools {
                                    help.push_str(&format!(
                                        "    /mcp-{}-{} [json args]\n",
                                        tool.server_id,
                                        tool.tool_name.replace(['/', ' '], "-")
                                    ));
                                }
                            }
                            self.entries.push(ChatEntry::Ephemeral(help));
                        }
                        "import-claude" => {
                            self.entries.push(ChatEntry::Status(
                                "Importing sessions from Claude Code...".to_string(),
                            ));
                            match &self.session_store {
                                Some(store) => match store.import_claude_sessions() {
                                    Ok((imported, skipped)) => {
                                        if imported == 0 && skipped == 0 {
                                            self.entries.push(ChatEntry::Status(
                                                "No Claude Code sessions found to import.".to_string(),
                                            ));
                                        } else {
                                            self.entries.push(ChatEntry::Status(format!(
                                                "Imported {imported} session{} from Claude Code ({skipped} already existed).",
                                                if imported == 1 { "" } else { "s" }
                                            )));
                                        }
                                    }
                                    Err(e) => {
                                        self.entries.push(ChatEntry::Error(format!(
                                            "Import failed: {e}"
                                        )));
                                    }
                                },
                                None => {
                                    self.entries.push(ChatEntry::Error(
                                        "Session store not available.".to_string(),
                                    ));
                                }
                            }
                        }
                        _ => {}
                    }
                }
                SlashCommandKind::Skill { name, content } => {
                    if args.is_empty() {
                        self.pending_skill = Some((name.clone(), content.clone()));
                        self.entries.push(ChatEntry::Status(format!(
                            "Skill /{} activated — your next prompt will run with this skill.",
                            name
                        )));
                    } else {
                        self.processing = true;
                        self.processing_phase = ProcessingPhase::RecallingMemories;
                        self.entries.push(ChatEntry::UserMessage(args.to_string()));
                        let final_input =
                            format!("<skill name=\"{name}\">\n{content}\n</skill>\n\n{args}");
                        let agent = Arc::clone(&self.agent);
                        let session = Arc::clone(&self.session);
                        self.agent_task = Some(tokio::spawn(async move {
                            agent.process_message(&session, &final_input).await;
                        }));
                    }
                }
                SlashCommandKind::McpServer {
                    server_id,
                    server_name,
                } => {
                    if args.is_empty() {
                        let available: Vec<String> = self
                            .mcp_tools
                            .iter()
                            .filter(|t| t.server_id == *server_id)
                            .map(|t| t.tool_name.clone())
                            .collect();
                        let usage = if available.is_empty() {
                            format!(
                                "No tools found for MCP server {}. Try refreshing or check Signet MCP install state.",
                                server_name
                            )
                        } else {
                            format!(
                                "MCP server {} tools:\n{}",
                                server_name,
                                available
                                    .iter()
                                    .map(|t| format!("  - {t}"))
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            )
                        };
                        self.entries.push(ChatEntry::Ephemeral(usage));
                    } else {
                        let (tool_name, raw_args) = match args.split_once(' ') {
                            Some((tool, rest)) => (tool.trim(), rest.trim()),
                            None => (args.trim(), ""),
                        };
                        self.run_mcp_tool(server_id, tool_name, raw_args).await;
                    }
                }
                SlashCommandKind::McpTool {
                    server_id,
                    tool_name,
                    ..
                } => {
                    self.run_mcp_tool(server_id, tool_name, args).await;
                }
                _ => {
                    self.execute_signet_command(cmd).await;
                }
            }
        } else {
            self.entries.push(ChatEntry::Error(format!(
                "Unknown command: /{cmd_name}. Type /help for available commands."
            )));
        }
    }

    /// Execute a Signet command (CLI or API)
    async fn execute_signet_command(&mut self, cmd: &signet_commands::SignetCommand) {
        self.entries
            .push(ChatEntry::Status(format!("◇ Running {}...", cmd.label)));

        match &cmd.kind {
            SlashCommandKind::Cli(args) => {
                let argv: Vec<&str> = args.iter().map(String::as_str).collect();
                self.run_signet_cli(&argv).await;
            }
            SlashCommandKind::ApiGet(path) => {
                if let Some(client) = &self.signet_client {
                    match client.get(path).await {
                        Ok(resp) => {
                            let formatted =
                                serde_json::to_string_pretty(&resp).unwrap_or_default();
                            self.entries
                                .push(ChatEntry::Ephemeral(format!("```json\n{formatted}\n```")));
                        }
                        Err(e) => {
                            self.entries
                                .push(ChatEntry::Error(format!("API error: {e}")));
                        }
                    }
                } else {
                    self.entries.push(ChatEntry::Error(
                        "Signet daemon not connected".to_string(),
                    ));
                }
            }
            SlashCommandKind::ApiPost(path) => {
                if let Some(client) = &self.signet_client {
                    match client
                        .post(path, &serde_json::json!({}))
                        .await
                    {
                        Ok(resp) => {
                            let formatted =
                                serde_json::to_string_pretty(&resp).unwrap_or_default();
                            self.entries.push(ChatEntry::Ephemeral(format!(
                                "```json\n{formatted}\n```"
                            )));
                        }
                        Err(e) => {
                            self.entries
                                .push(ChatEntry::Error(format!("API error: {e}")));
                        }
                    }
                } else {
                    self.entries.push(ChatEntry::Error(
                        "Signet daemon not connected".to_string(),
                    ));
                }
            }
            SlashCommandKind::Internal(_)
            | SlashCommandKind::Skill { .. }
            | SlashCommandKind::McpServer { .. }
            | SlashCommandKind::McpTool { .. } => {}
        }
    }

    async fn run_mcp_tool(&mut self, server_id: &str, tool_name: &str, raw_args: &str) {
        let args = if raw_args.trim().is_empty() {
            serde_json::json!({})
        } else {
            match serde_json::from_str::<serde_json::Value>(raw_args.trim()) {
                Ok(value) => value,
                Err(e) => {
                    self.entries.push(ChatEntry::Error(format!(
                        "Invalid JSON args for MCP tool {}: {}",
                        tool_name, e
                    )));
                    return;
                }
            }
        };

        let Some(client) = &self.signet_client else {
            self.entries
                .push(ChatEntry::Error("Signet daemon not connected".to_string()));
            return;
        };

        self.entries.push(ChatEntry::Status(format!(
            "◇ Running MCP tool {} on {}...",
            tool_name, server_id
        )));

        let body = serde_json::json!({
            "serverId": server_id,
            "toolName": tool_name,
            "args": args,
        });

        match client.post("/api/marketplace/mcp/call", &body).await {
            Ok(resp) => {
                let formatted = serde_json::to_string_pretty(&resp).unwrap_or_default();
                self.entries
                    .push(ChatEntry::Ephemeral(format!("```json\n{formatted}\n```")));
            }
            Err(e) => {
                self.entries
                    .push(ChatEntry::Error(format!("MCP tool call failed: {e}")));
            }
        }
    }

    /// Run a signet CLI command and display output
    async fn run_signet_cli(&mut self, args: &[&str]) {
        match tokio::process::Command::new("signet")
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
        {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);

                if !stdout.trim().is_empty() {
                    self.entries
                        .push(ChatEntry::Ephemeral(stdout.trim().to_string()));
                }
                if !stderr.trim().is_empty() {
                    self.entries.push(ChatEntry::Error(stderr.trim().to_string()));
                }
                if stdout.trim().is_empty() && stderr.trim().is_empty() {
                    self.entries
                        .push(ChatEntry::Status("Command completed.".to_string()));
                }
            }
            Err(e) => {
                self.entries.push(ChatEntry::Error(format!(
                    "Failed to run signet: {e}"
                )));
            }
        }
    }

    async fn handle_command_palette_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;

        match key.code {
            KeyCode::Esc => {
                self.command_palette = None;
            }
            KeyCode::Up => {
                if let Some(palette) = &mut self.command_palette {
                    palette.move_up();
                }
            }
            KeyCode::Down => {
                if let Some(palette) = &mut self.command_palette {
                    palette.move_down();
                }
            }
            KeyCode::Backspace => {
                if let Some(palette) = &mut self.command_palette {
                    palette.backspace();
                }
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .contains(crossterm::event::KeyModifiers::CONTROL) =>
            {
                if let Some(palette) = &mut self.command_palette {
                    palette.type_char(c);
                }
            }
            KeyCode::Enter => {
                let selection = self
                    .command_palette
                    .as_ref()
                    .and_then(|p| p.selected_command().cloned());
                self.command_palette = None;

                if let Some(cmd) = selection {
                    self.execute_command(&cmd).await;
                }
            }
            _ => {}
        }
    }

    async fn execute_command(&mut self, cmd: &crate::views::command_palette::CommandEntry) {
        match &cmd.kind {
            PaletteCommandKind::BuiltIn(action) => match action.as_str() {
                "model_picker" => {
                    self.refresh_connected_models().await;
                    self.open_model_picker();
                }
                "clear" => {
                    self.entries.clear();
                    self.streaming_text.clear();
                    self.scroll_offset = 0;
                }
                "quit" => {
                    self.should_quit = true;
                }
                "remember" => {
                    self.entries.push(ChatEntry::Status(
                        "Type /remember <content> in the input to save a memory.".to_string(),
                    ));
                }
                "recall" => {
                    self.entries.push(ChatEntry::Status(
                        "Type /recall <query> in the input to search memories.".to_string(),
                    ));
                }
                "auth" => {
                    self.entries.push(ChatEntry::Status(
                        "Run `forge --auth` in your shell to configure provider logins and API keys.".to_string(),
                    ));
                }
                _ => {}
            },
            PaletteCommandKind::Skill(content) => {
                self.entries.push(ChatEntry::Status(format!(
                    "Skill /{} activated — your next prompt will run with this skill.",
                    cmd.name
                )));
                self.pending_skill = Some((cmd.name.clone(), content.clone()));
            }
        }
    }

    async fn handle_model_picker_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;

        match key.code {
            KeyCode::Esc => {
                self.model_picker = None;
            }
            KeyCode::Up => {
                if let Some(picker) = &mut self.model_picker {
                    picker.move_up();
                }
            }
            KeyCode::Down => {
                if let Some(picker) = &mut self.model_picker {
                    picker.move_down();
                }
            }
            KeyCode::Backspace => {
                if let Some(picker) = &mut self.model_picker {
                    picker.backspace();
                }
            }
            KeyCode::Char(c) if !key.modifiers.contains(crossterm::event::KeyModifiers::CONTROL) => {
                if let Some(picker) = &mut self.model_picker {
                    picker.type_char(c);
                }
            }
            KeyCode::Enter => {
                let selection = self
                    .model_picker
                    .as_ref()
                    .and_then(|p| p.selected_model().cloned());
                self.model_picker = None;

                if let Some(entry) = selection {
                    self.switch_model_entry(&entry).await;
                }
            }
            _ => {}
        }
    }

    async fn switch_model_entry(&mut self, entry: &crate::views::model_picker::ModelEntry) {
        self.switch_model(&entry.provider, &entry.model, entry.context_window, entry.cli_path.clone()).await;
    }

    async fn switch_model(&mut self, provider_name: &str, model: &str, context_window: usize, new_cli_path: Option<String>) {
        // Create new provider — CLI or API based
        let new_provider: Arc<dyn Provider> = if let Some(cli_path) = &new_cli_path {
            // CLI provider — no API key needed
            let _ = apply_local_cli_auth_env(provider_name);
            let kind = match provider_name {
                "claude-cli" => forge_provider::cli::CliKind::Claude,
                "codex-cli" => forge_provider::cli::CliKind::Codex,
                "gemini-cli" => forge_provider::cli::CliKind::Gemini,
                _ => {
                    self.entries.push(ChatEntry::Error(format!(
                        "Unknown CLI provider: {provider_name}"
                    )));
                    return;
                }
            };
            Arc::from(forge_provider::create_cli_provider(kind, cli_path, model))
        } else if provider_name == "ollama" {
            match forge_provider::create_provider(provider_name, model, "") {
                Ok(p) => Arc::from(p),
                Err(e) => {
                    self.entries
                        .push(ChatEntry::Error(format!("Failed to create provider: {e}")));
                    return;
                }
            }
        } else {
            // API provider — resolve key
            let api_key = match resolve_api_key(self.signet_client.as_ref(), provider_name).await {
                Ok(key) => key,
                Err(e) => {
                    self.entries.push(ChatEntry::Error(format!(
                        "No API key for {provider_name}: {e}\nRun `forge --auth --auth-provider {provider_name}` in your shell, then switch again."
                    )));
                    return;
                }
            };
            match forge_provider::create_provider(provider_name, model, &api_key) {
                Ok(p) => Arc::from(p),
                Err(e) => {
                    self.entries
                        .push(ChatEntry::Error(format!("Failed to create provider: {e}")));
                    return;
                }
            }
        };

        // Rebuild agent with new provider
        let cwd = std::env::current_dir()
            .ok()
            .map(|p| p.display().to_string());
        let session_id = self.session.lock().await.id.clone();

        let hooks = self.signet_client.as_ref().map(|client| {
            SessionHooks::new(client.clone(), session_id, cwd)
        });

        let (event_tx, event_rx) = mpsc::channel::<AgentEvent>(256);
        let (permission_tx, permission_rx) = mpsc::channel::<PermissionRequest>(8);

        let daemon_url = self.signet_client.as_ref().map(|c| c.base_url().to_string());
        self.agent = Arc::new(AgentLoop::new(
            new_provider,
            hooks,
            event_tx,
            permission_tx,
            Arc::clone(&self.permissions),
            self.system_prompt.clone(),
            Arc::clone(&self.effort),
            Arc::clone(&self.bypass),
            daemon_url,
            Vec::new(),
        ));

        self.event_rx = event_rx;
        self.permission_rx = permission_rx;
        self.model = model.to_string();
        self.provider_name = provider_name.to_string();
        self.context_window = context_window;
        self.cli_path = new_cli_path;

        self.entries.push(ChatEntry::Status(format!(
            "Switched to {} ({})",
            model, provider_name
        )));

        // Persist model choice
        self.save_settings();
        info!("Model switched to {model} ({provider_name})");
    }

    fn save_settings(&self) {
        let effort = self.effort.try_lock().map(|e| e.as_str().to_string()).ok();
        let bypass = self.bypass.try_lock().map(|b| *b).unwrap_or(false);
        let settings = crate::settings::Settings {
            model: Some(self.model.clone()),
            provider: Some(self.provider_name.clone()),
            cli_path: self.cli_path.clone(),
            effort,
            theme: Some(self.theme.name.to_string()),
            bypass,
        };
        settings.save();
    }

    async fn handle_permission_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;

        let response = match key.code {
            // Y or Enter on Allow
            KeyCode::Char('y') | KeyCode::Char('Y') => Some(PermissionResponse::Allow),
            // A for Always Allow
            KeyCode::Char('a') | KeyCode::Char('A') => Some(PermissionResponse::AlwaysAllow),
            // N or Escape for Deny
            KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                Some(PermissionResponse::Deny)
            }
            // Enter confirms current selection
            KeyCode::Enter => {
                self.permission_dialog.as_ref().map(|dialog| match dialog.selected {
                        0 => PermissionResponse::Allow,
                        1 => PermissionResponse::AlwaysAllow,
                        _ => PermissionResponse::Deny,
                    })
            }
            // Arrow keys to navigate options
            KeyCode::Left | KeyCode::Right | KeyCode::Tab => {
                if let Some(dialog) = &mut self.permission_dialog {
                    match key.code {
                        KeyCode::Left => {
                            dialog.selected = dialog.selected.saturating_sub(1);
                        }
                        KeyCode::Right | KeyCode::Tab => {
                            dialog.selected = (dialog.selected + 1).min(2);
                        }
                        _ => {}
                    }
                }
                None
            }
            _ => None,
        };

        if let Some(response) = response {
            if let Some(dialog) = self.permission_dialog.take() {
                let _ = dialog.response_tx.send(response);
            }
        }
    }

    fn handle_agent_event(&mut self, event: AgentEvent) {
        match event {
            AgentEvent::TextDelta(text) => {
                if self.processing_phase != ProcessingPhase::Streaming {
                    self.processing_phase = ProcessingPhase::Streaming;
                }
                // Buffer text for gradual release (drip streaming)
                self.pending_text.push_str(&text);
                self.scroll_offset = 0;
            }
            AgentEvent::ToolStart { name, .. } => {
                // Map tool names to contextual phases
                let lower = name.to_lowercase();
                self.processing_phase = if lower.contains("write") || lower.contains("edit") || lower.contains("create") {
                    ProcessingPhase::Writing
                } else if lower.contains("read") || lower.contains("search") || lower.contains("grep") || lower.contains("glob") {
                    ProcessingPhase::Planning
                } else {
                    ProcessingPhase::ExecutingTool(name.clone())
                };
                // Flush all pending + streaming text before tool call
                self.streaming_text.push_str(&self.pending_text);
                self.pending_text.clear();
                if !self.streaming_text.is_empty() {
                    self.entries
                        .push(ChatEntry::AssistantText(self.streaming_text.clone()));
                    self.streaming_text.clear();
                }
                self.entries.push(ChatEntry::ToolCall {
                    name,
                    status: ToolStatus::Running,
                    detail: None,
                });
            }
            AgentEvent::ToolDetail { name, detail, .. } => {
                // Retroactively enrich the most recent matching ToolCall
                if let Some(ChatEntry::ToolCall { detail: d, .. }) =
                    self.entries.iter_mut().rev().find(|e| {
                        matches!(e, ChatEntry::ToolCall { name: n, .. } if *n == name)
                    })
                {
                    *d = Some(detail);
                }
            }
            AgentEvent::ToolResult {
                name,
                output,
                is_error,
                ..
            } => {
                // Track secret usage
                if name == "secret_exec" && !is_error {
                    self.secrets_used += 1;
                }
                // Update tool call status — preserve existing detail
                if let Some(entry) = self.entries.iter_mut().rev().find(|e| {
                    matches!(e, ChatEntry::ToolCall { name: n, status: ToolStatus::Running, .. } if *n == name)
                }) {
                    let existing_detail = if let ChatEntry::ToolCall { detail, .. } = entry {
                        detail.clone()
                    } else {
                        None
                    };
                    *entry = ChatEntry::ToolCall {
                        name: name.clone(),
                        status: if is_error {
                            ToolStatus::Error
                        } else {
                            ToolStatus::Complete
                        },
                        detail: existing_detail,
                    };
                }
                self.entries.push(ChatEntry::ToolOutput {
                    name,
                    output,
                    is_error,
                });
            }
            AgentEvent::Usage(_) => {
                // Token counts are updated in the shared session directly
            }
            AgentEvent::TurnComplete => {
                if self.pending_text.is_empty() {
                    // No pending text — commit immediately
                    if !self.streaming_text.is_empty() {
                        self.entries
                            .push(ChatEntry::AssistantText(self.streaming_text.clone()));
                        self.streaming_text.clear();
                    }
                    self.processing = false;
                    self.processing_phase = ProcessingPhase::Idle;
                } else {
                    // Pending text still dripping — defer completion
                    self.turn_complete_pending = true;
                }
            }
            AgentEvent::Error(msg) => {
                self.streaming_text.clear();
                self.pending_text.clear();
                self.turn_complete_pending = false;
                self.entries.push(ChatEntry::Error(msg));
                self.processing = false;
                self.processing_phase = ProcessingPhase::Idle;
            }
            AgentEvent::Status(msg) => {
                // Update processing phase based on status message
                let lower = msg.to_lowercase();
                if lower.contains("recalling") || lower.contains("searching") || lower.contains("memory") {
                    self.processing_phase = ProcessingPhase::RecallingMemories;
                } else if lower.contains("thinking") || lower.contains("reasoning") {
                    self.processing_phase = ProcessingPhase::Thinking;
                } else if lower.contains("planning") || lower.contains("analyzing") {
                    self.processing_phase = ProcessingPhase::Planning;
                } else if lower.contains("writing") || lower.contains("editing") || lower.contains("generating") {
                    self.processing_phase = ProcessingPhase::Writing;
                } else if lower.contains("compacting") {
                    self.processing_phase = ProcessingPhase::ExecutingTool("compaction".to_string());
                }
            }
            AgentEvent::ToolApproval(_, name, _) => {
                self.entries.push(ChatEntry::Status(format!(
                    "Waiting for approval: {name}..."
                )));
            }
            AgentEvent::MemoryCount(count) => {
                self.memories_injected = count;
            }
        }
    }

    /// Save current session to SQLite for later resume
    async fn save_session(&self) {
        let store = match &self.session_store {
            Some(s) => s,
            None => return,
        };

        let s = self.session.lock().await;
        if s.messages.is_empty() {
            return;
        }

        if let Err(e) = store.save_session(
            &s.id,
            &s.model,
            &s.provider,
            s.project.as_deref(),
            &s.started_at.to_rfc3339(),
            &s.messages,
            s.total_input_tokens,
            s.total_output_tokens,
        ) {
            info!("Failed to save session: {e}");
        } else {
            info!("Session {} saved ({} messages)", s.id, s.messages.len());
        }
    }

    /// Submit transcript to Signet daemon for extraction on quit
    async fn submit_transcript(&self) {
        let s = self.session.lock().await;
        if s.messages.is_empty() {
            return;
        }

        let transcript = s.transcript();
        let session_id = s.id.clone();
        let project = s.project.clone();
        drop(s); // Release lock before async call

        if let Some(client) = &self.signet_client {
            let hooks = SessionHooks::new(client.clone(), session_id, project);
            if let Err(e) = hooks.session_end(&transcript).await {
                info!("Session-end hook failed (non-fatal): {e}");
            }
        }
    }

    /// Expose effort Arc for external initialization (e.g., from saved settings)
    pub fn effort_mut(&self) -> &Arc<Mutex<forge_provider::ReasoningEffort>> {
        &self.effort
    }

    /// Load a previous session from SQLite (for --resume)
    /// Resume a specific session by ID
    async fn resume_session(&mut self, session_id: &str) {
        let store = match &self.session_store {
            Some(s) => s,
            None => {
                self.entries.push(ChatEntry::Error("No session store".to_string()));
                return;
            }
        };
        match store.load_messages(session_id) {
            Ok(messages) if !messages.is_empty() => {
                let count = messages.len();
                let mut s = self.session.lock().await;
                s.messages = messages;
                drop(s);
                self.entries.push(ChatEntry::Status(format!(
                    "Resumed session {session_id} ({count} messages)"
                )));
            }
            Ok(_) => {
                self.entries.push(ChatEntry::Status("Session has no messages.".to_string()));
            }
            Err(e) => {
                self.entries.push(ChatEntry::Error(format!("Failed to load session: {e}")));
            }
        }
    }

    pub async fn resume_last_session(&mut self) -> bool {
        let store = match &self.session_store {
            Some(s) => s,
            None => return false,
        };

        let session_id = match store.last_session_id() {
            Some(id) => id,
            None => {
                self.entries
                    .push(ChatEntry::Status("No previous session found.".to_string()));
                return false;
            }
        };

        match store.load_messages(&session_id) {
            Ok(messages) if !messages.is_empty() => {
                let mut s = self.session.lock().await;
                s.messages = messages;
                let count = s.messages.len();
                drop(s);

                // Replay messages into chat entries
                self.entries
                    .push(ChatEntry::Status(format!("Resumed session {session_id} ({count} messages)")));

                true
            }
            Ok(_) => {
                self.entries
                    .push(ChatEntry::Status("Previous session was empty.".to_string()));
                false
            }
            Err(e) => {
                self.entries
                    .push(ChatEntry::Error(format!("Failed to resume: {e}")));
                false
            }
        }
    }

    // ── Voice input ───────────────────────────────────────────────────

    /// Handle Ctrl+R: toggle voice recording on/off
    async fn handle_voice_toggle(&mut self) {
        if self.voice_downloading {
            // Model download in progress — ignore
            return;
        }

        if self.voice_recording {
            // Stop recording and do final transcription
            tracing::info!("Voice toggle: stopping recording");
            self.stop_voice_recording();
            // Belt-and-suspenders — force clear in case stop didn't fully work
            self.voice_recording = false;
            self.voice_recorder = None;
        } else {
            // Start recording — ensure model is available first
            if self.voice_model_path.is_none() {
                // Check if model file already exists on disk
                let model_path = dirs::config_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("forge")
                    .join("models")
                    .join("ggml-base.en.bin");

                if model_path.exists() {
                    self.voice_model_path = Some(model_path);
                } else {
                    // Need to download — kick off background task
                    self.voice_downloading = true;
                    self.entries.push(ChatEntry::Status(
                        "Downloading voice model (142MB)...".to_string(),
                    ));
                    let tx = self.voice_result_tx.clone();
                    tokio::spawn(async move {
                        match voice::ensure_model().await {
                            Ok(path) => {
                                let _ = tx.send(VoiceResult::ModelReady(path)).await;
                            }
                            Err(e) => {
                                let _ = tx.send(VoiceResult::Error(e)).await;
                            }
                        }
                    });
                    return;
                }
            }

            self.start_voice_recording();
        }
    }

    /// Start microphone recording
    fn start_voice_recording(&mut self) {
        match voice::Recorder::new() {
            Ok(mut recorder) => match recorder.start() {
                Ok(()) => {
                    self.voice_recorder = Some(recorder);
                    self.voice_recording = true;
                    self.voice_interim_text.clear();
                    self.voice_last_interim = std::time::Instant::now();
                }
                Err(e) => {
                    self.entries
                        .push(ChatEntry::Error(format!("Microphone: {e}")));
                }
            },
            Err(e) => {
                self.entries
                    .push(ChatEntry::Error(format!("Audio device: {e}")));
            }
        }
    }

    /// Stop recording and trigger final transcription
    fn stop_voice_recording(&mut self) {
        self.voice_recording = false;
        self.voice_downloading = false;
        self.voice_interim_text.clear();

        // Abort any in-flight interim transcription
        if let Some(handle) = self.voice_interim_handle.take() {
            handle.abort();
        }

        if let Some(mut recorder) = self.voice_recorder.take() {
            let samples = recorder.stop();
            let sample_rate = recorder.sample_rate();
            let channels = recorder.channels();

            if samples.is_empty() {
                self.voice_interim_text.clear();
                return;
            }

            if let Some(model_path) = self.voice_model_path.clone() {
                let tx = self.voice_result_tx.clone();
                tokio::task::spawn_blocking(move || {
                    match voice::transcribe(&model_path, &samples, sample_rate, channels) {
                        Ok(text) => {
                            let _ = tx.blocking_send(VoiceResult::Final(text));
                        }
                        Err(e) => {
                            let _ = tx.blocking_send(VoiceResult::Error(e));
                        }
                    }
                });
            }
        } else {
            self.voice_interim_text.clear();
        }
    }

    /// Fire an interim transcription on a blocking thread
    fn trigger_interim_transcription(&mut self) {
        // Don't stack up multiple interim tasks
        if let Some(handle) = &self.voice_interim_handle {
            if !handle.is_finished() {
                return;
            }
        }

        let Some(recorder) = &self.voice_recorder else {
            return;
        };
        let Some(model_path) = self.voice_model_path.clone() else {
            return;
        };

        let samples = recorder.current_samples();
        if samples.is_empty() {
            return;
        }

        let sample_rate = recorder.sample_rate();
        let channels = recorder.channels();
        let tx = self.voice_result_tx.clone();

        self.voice_interim_handle = Some(tokio::task::spawn_blocking(move || {
            match voice::transcribe(&model_path, &samples, sample_rate, channels) {
                Ok(text) => {
                    let _ = tx.blocking_send(VoiceResult::Interim(text));
                }
                Err(_) => {
                    // Silently ignore interim errors
                }
            }
        }));
    }
}

/// Check if a path looks like an image file
fn is_image_path(text: &str) -> bool {
    let path = text
        .trim()
        .trim_matches('\'')
        .trim_matches('"');
    let lower = path.to_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
        || lower.ends_with(".bmp")
        || lower.ends_with(".svg")
}

/// Save an arboard clipboard image to a PNG file
fn save_clipboard_image(
    img: &arboard::ImageData,
    path: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    // arboard gives us RGBA bytes
    let width = img.width as u32;
    let height = img.height as u32;

    let file = std::fs::File::create(path)?;
    let writer = std::io::BufWriter::new(file);

    let mut encoder = png::Encoder::new(writer, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);

    let mut writer = encoder.write_header()?;
    writer.write_image_data(&img.bytes)?;

    Ok(())
}

/// Export the entire Signet agent workspace (~/.agents/) to a zip file.
/// Includes identity files, config, skills, memory DB, and per-agent dirs.
fn export_agent_zip(dest: &std::path::Path) -> Result<usize, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let agents_dir = forge_signet::config::agents_dir();
    if !agents_dir.exists() {
        return Err(format!("Agents directory not found: {}", agents_dir.display()));
    }

    let file = std::fs::File::create(dest)
        .map_err(|e| format!("Create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut count = 0;

    // Walk the agents directory recursively
    fn add_dir(
        zip: &mut zip::ZipWriter<std::fs::File>,
        base: &std::path::Path,
        dir: &std::path::Path,
        options: SimpleFileOptions,
        count: &mut usize,
    ) -> Result<(), String> {
        let entries = std::fs::read_dir(dir)
            .map_err(|e| format!("Read dir {}: {e}", dir.display()))?;

        for entry in entries.flatten() {
            let path = entry.path();
            let relative = path.strip_prefix(base).unwrap_or(&path);
            let name = relative.to_string_lossy().to_string();

            // Skip hidden dirs except .secrets and .daemon
            if let Some(fname) = path.file_name().and_then(|n| n.to_str()) {
                if fname.starts_with('.') && fname != ".secrets" && fname != ".daemon" {
                    continue;
                }
            }

            // Skip large/binary files that aren't useful for export
            if name.contains("node_modules") || name.ends_with(".log") {
                continue;
            }

            if path.is_dir() {
                zip.add_directory(format!("{name}/"), options)
                    .map_err(|e| format!("Add dir {name}: {e}"))?;
                add_dir(zip, base, &path, options, count)?;
            } else {
                // Skip files > 50MB
                let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                if size > 50 * 1024 * 1024 {
                    continue;
                }
                zip.start_file(&name, options)
                    .map_err(|e| format!("Start file {name}: {e}"))?;
                let data = std::fs::read(&path)
                    .map_err(|e| format!("Read {name}: {e}"))?;
                zip.write_all(&data)
                    .map_err(|e| format!("Write {name}: {e}"))?;
                *count += 1;
            }
        }
        Ok(())
    }

    add_dir(&mut zip, &agents_dir, &agents_dir, options, &mut count)?;

    zip.finish().map_err(|e| format!("Finish zip: {e}"))?;
    Ok(count)
}
