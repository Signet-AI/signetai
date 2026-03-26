use anyhow::Result;
use base64::Engine;
use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    style::Stylize,
    terminal::{self, ClearType},
};
use forge_signet::secrets::{
    apply_local_cli_auth_env, clear_local_api_key, clear_local_cli_auth,
    local_api_key_for_provider, local_cli_auth_vars_for_provider,
    store_local_api_key, store_local_cli_auth_env,
};
use std::io::{IsTerminal, Write};

#[derive(Clone, Copy)]
enum AuthKind {
    ApiKey {
        login_url: &'static str,
    },
    Cli {
        binary: &'static str,
        login_args: &'static [&'static str],
        install_hint: &'static str,
        note: &'static str,
    },
    None,
}

#[derive(Clone, Copy)]
struct AuthProvider {
    id: &'static str,
    label: &'static str,
    kind: AuthKind,
}

const AUTH_PROVIDERS: &[AuthProvider] = &[
    AuthProvider {
        id: "anthropic",
        label: "Anthropic API",
        kind: AuthKind::ApiKey {
            login_url: "https://console.anthropic.com/settings/keys",
        },
    },
    AuthProvider {
        id: "openai",
        label: "OpenAI API",
        kind: AuthKind::ApiKey {
            login_url: "https://platform.openai.com/api-keys",
        },
    },
    AuthProvider {
        id: "gemini",
        label: "Google Gemini API",
        kind: AuthKind::ApiKey {
            login_url: "https://aistudio.google.com/apikey",
        },
    },
    AuthProvider {
        id: "groq",
        label: "Groq API",
        kind: AuthKind::ApiKey {
            login_url: "https://console.groq.com/keys",
        },
    },
    AuthProvider {
        id: "openrouter",
        label: "OpenRouter API",
        kind: AuthKind::ApiKey {
            login_url: "https://openrouter.ai/keys",
        },
    },
    AuthProvider {
        id: "xai",
        label: "xAI API",
        kind: AuthKind::ApiKey {
            login_url: "https://console.x.ai/",
        },
    },
    AuthProvider {
        id: "claude-cli",
        label: "Claude Code CLI",
        kind: AuthKind::Cli {
            binary: "claude",
            login_args: &["auth", "login"],
            install_hint: "brew install claude",
            note: "Uses browser/device auth handled by Claude CLI.",
        },
    },
    AuthProvider {
        id: "codex-cli",
        label: "Codex CLI",
        kind: AuthKind::Cli {
            binary: "codex",
            login_args: &["login"],
            install_hint: "npm i -g @openai/codex",
            note: "Supports browser/device auth and API-key login.",
        },
    },
    AuthProvider {
        id: "gemini-cli",
        label: "Gemini CLI",
        kind: AuthKind::Cli {
            binary: "gemini",
            login_args: &[],
            install_hint: "npm i -g @google/gemini-cli",
            note: "Run `gemini`, then `/auth` inside Gemini CLI.",
        },
    },
    AuthProvider {
        id: "ollama",
        label: "Ollama (local)",
        kind: AuthKind::None,
    },
];

pub async fn run_auth_wizard(target_provider: Option<&str>) -> Result<()> {
    if let Some(target) = target_provider {
        let provider = find_provider(target)?;
        configure_provider(*provider).await?;
        return Ok(());
    }

    // Interactive multi-select when running in a real TTY.
    if std::io::stdin().is_terminal() && std::io::stderr().is_terminal() {
        match interactive_select_providers() {
            Ok(Some(selected)) if selected.is_empty() => {
                println!("No providers selected.");
                return Ok(());
            }
            Ok(Some(selected)) => {
                for provider in selected {
                    configure_provider(provider).await?;
                    println!();
                }
                return Ok(());
            }
            Ok(None) => {
                println!("Auth setup cancelled.");
                return Ok(());
            }
            Err(e) => {
                eprintln!("Interactive selector unavailable ({e}). Falling back to simple prompts.");
            }
        }
    }

    // Fallback for non-interactive pipes.
    run_auth_wizard_fallback().await
}

async fn run_auth_wizard_fallback() -> Result<()> {
    loop {
        print_menu();
        let choice = read_line("Select provider (number, name, or q): ")?;
        let choice = choice.trim();
        if choice.eq_ignore_ascii_case("q") || choice.eq_ignore_ascii_case("quit") {
            println!("Exiting Forge auth setup.");
            break;
        }

        let provider = if let Ok(idx) = choice.parse::<usize>() {
            AUTH_PROVIDERS.get(idx.saturating_sub(1)).copied()
        } else {
            find_provider(choice).ok().copied()
        };

        match provider {
            Some(p) => configure_provider(p).await?,
            None => {
                println!("Unknown selection: {choice}");
                continue;
            }
        }
        println!();
    }

    Ok(())
}

fn interactive_select_providers() -> Result<Option<Vec<AuthProvider>>> {
    let mut stderr = std::io::stderr();

    terminal::enable_raw_mode()?;
    execute!(stderr, cursor::Hide)?;
    let (_, start_row) = cursor::position()?;

    let mut cursor_idx = 0usize;
    let mut selected = vec![false; AUTH_PROVIDERS.len()];

    let result = loop {
        render_selector(&mut stderr, start_row, cursor_idx, &selected)?;

        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Press {
                continue;
            }
            match key.code {
                KeyCode::Up | KeyCode::Char('k') => {
                    cursor_idx = cursor_idx.saturating_sub(1);
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    if cursor_idx + 1 < AUTH_PROVIDERS.len() {
                        cursor_idx += 1;
                    }
                }
                KeyCode::Char(' ') => {
                    selected[cursor_idx] = !selected[cursor_idx];
                }
                KeyCode::Char('a') | KeyCode::Char('A') => {
                    let all_selected = selected.iter().all(|x| *x);
                    selected.fill(!all_selected);
                }
                KeyCode::Enter => {
                    let chosen: Vec<AuthProvider> = AUTH_PROVIDERS
                        .iter()
                        .enumerate()
                        .filter_map(|(i, p)| if selected[i] { Some(*p) } else { None })
                        .collect();
                    break Some(chosen);
                }
                KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('Q') => {
                    break None;
                }
                _ => {}
            }
        }
    };

    execute!(
        stderr,
        cursor::MoveTo(0, start_row),
        terminal::Clear(ClearType::FromCursorDown),
        cursor::Show
    )?;
    terminal::disable_raw_mode()?;
    eprintln!();

    Ok(result)
}

fn render_selector(
    stderr: &mut std::io::Stderr,
    start_row: u16,
    cursor_idx: usize,
    selected: &[bool],
) -> std::io::Result<()> {
    execute!(
        stderr,
        cursor::MoveTo(0, start_row),
        terminal::Clear(ClearType::FromCursorDown)
    )?;

    // In raw mode, emit CRLF explicitly so lines start at column 0.
    write!(stderr, "\r\n")?;
    write!(stderr, "  {}\r\n", "Forge Auth Setup".bold())?;
    write!(
        stderr,
        "  {}\r\n",
        "↑/↓ move  Space toggle  Enter continue  a toggle all  q cancel".dark_grey()
    )?;
    write!(stderr, "\r\n")?;

    for (i, provider) in AUTH_PROVIDERS.iter().enumerate() {
        let marker = if i == cursor_idx { "▸" } else { " " };
        let checkbox = if selected[i] { "[x]" } else { "[ ]" };
        let kind = match provider.kind {
            AuthKind::ApiKey { .. } => "API key",
            AuthKind::Cli { .. } => "CLI login",
            AuthKind::None => "No auth",
        };

        if i == cursor_idx {
            writeln!(
                stderr,
                "  {} {} {:<14} {} ({})\r",
                marker.bold().cyan(),
                checkbox.bold().white(),
                provider.id.bold().white(),
                provider.label.bold().white(),
                kind.dark_grey()
            )?;
        } else {
            writeln!(
                stderr,
                "  {} {} {:<14} {} ({})\r",
                marker,
                checkbox,
                provider.id,
                provider.label,
                kind
            )?;
        }
    }

    write!(stderr, "\r\n")?;
    let count = selected.iter().filter(|x| **x).count();
    write!(
        stderr,
        "  {}\r\n",
        format!("Selected: {count} provider{}", if count == 1 { "" } else { "s" }).dark_grey()
    )?;
    stderr.flush()?;
    Ok(())
}

fn find_provider(name: &str) -> Result<&'static AuthProvider> {
    let normalized = if name.eq_ignore_ascii_case("google") {
        "gemini"
    } else {
        name
    };
    AUTH_PROVIDERS
        .iter()
        .find(|p| p.id.eq_ignore_ascii_case(normalized))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Unknown provider: {name}. Available: {}",
                AUTH_PROVIDERS
                    .iter()
                    .map(|p| p.id)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

fn print_menu() {
    println!();
    println!("Forge Auth Setup");
    println!("----------------");
    for (i, provider) in AUTH_PROVIDERS.iter().enumerate() {
        println!("{:>2}) {:<14} {}", i + 1, provider.id, provider.label);
    }
    println!();
}

async fn configure_provider(provider: AuthProvider) -> Result<()> {
    println!();
    println!("{} ({})", provider.label, provider.id);
    println!("{}", "-".repeat(provider.label.len() + provider.id.len() + 3));

    match provider.kind {
        AuthKind::ApiKey { login_url } => setup_api_provider(provider, login_url),
        AuthKind::Cli {
            binary,
            login_args,
            install_hint,
            note,
        } => setup_cli_provider(provider, binary, login_args, install_hint, note).await,
        AuthKind::None => {
            println!("No auth required. Make sure Ollama is running (default: localhost:11434).");
            Ok(())
        }
    }
}

fn setup_api_provider(provider: AuthProvider, login_url: &str) -> Result<()> {
    println!("Create a key here: {login_url}");
    if ask_yes_no("Open that page in your browser now? [Y/n]: ", true)? {
        if let Err(e) = open_url(login_url) {
            println!("Could not open browser automatically: {e}");
            println!("Open manually: {login_url}");
        }
    }

    if local_api_key_for_provider(provider.id).is_some() {
        let _ = writeln!(
            std::io::stdout(),
            "A local API key already exists for {}.",
            provider.label
        );
        let action = read_line("Enter [p]aste new key, [c]lear key, or [s]kip [p]: ")?;
        let action = action.trim().to_lowercase();
        if action == "c" || action == "clear" {
            clear_local_api_key(provider.id)?;
            let _ = writeln!(std::io::stdout(), "Cleared saved API key for {}.", provider.label);
            return Ok(());
        }
        if action == "s" || action == "skip" {
            println!("Skipped.");
            return Ok(());
        }
    }

    let prompt = format!("Paste API key for {} (leave empty to cancel): ", provider.label);
    let key = read_line(&prompt)?;
    if key.trim().is_empty() {
        println!("No key entered. Cancelled.");
        return Ok(());
    }

    store_local_api_key(provider.id, key.trim())?;
    let _ = writeln!(
        std::io::stdout(),
        "Saved API key for {}.",
        provider.label
    );
    Ok(())
}

async fn setup_cli_provider(
    provider: AuthProvider,
    binary: &str,
    login_args: &[&str],
    install_hint: &str,
    note: &str,
) -> Result<()> {
    println!("{note}");

    let cli_path = which(binary).await;
    if cli_path.is_none() {
        println!("`{binary}` is not installed.");
        println!("Install hint: {install_hint}");
        return Ok(());
    }

    match choose_cli_auth_method()? {
        CliAuthMethod::PasteToken => {
            setup_cli_token(provider)?;
        }
        CliAuthMethod::AuthLogin => {
            let _ = clear_local_cli_auth(provider.id);
            run_cli_login(binary, login_args).await?;
        }
        CliAuthMethod::Skip => {
            println!("Skipped.");
        }
    }

    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliAuthMethod {
    PasteToken,
    AuthLogin,
    Skip,
}

fn choose_cli_auth_method() -> Result<CliAuthMethod> {
    if std::io::stdin().is_terminal() && std::io::stderr().is_terminal() {
        match interactive_choose_cli_auth_method() {
            Ok(Some(method)) => return Ok(method),
            Ok(None) => return Ok(CliAuthMethod::Skip),
            Err(e) => {
                eprintln!("Interactive auth-method selector unavailable ({e}). Falling back to simple prompt.");
            }
        }
    }

    println!();
    println!("Choose auth method:");
    println!("  1) Paste auth/API token");
    println!("  2) Run auth login flow");
    println!("  3) Skip");
    let choice = read_line("Choice [1]: ")?;
    let choice = choice.trim().to_lowercase();
    match choice.as_str() {
        "" | "1" | "paste" | "token" => Ok(CliAuthMethod::PasteToken),
        "2" | "login" => Ok(CliAuthMethod::AuthLogin),
        "3" | "s" | "skip" => Ok(CliAuthMethod::Skip),
        _ => {
            println!("Unknown choice '{choice}', defaulting to token paste.");
            Ok(CliAuthMethod::PasteToken)
        }
    }
}

fn interactive_choose_cli_auth_method() -> Result<Option<CliAuthMethod>> {
    let options = [
        ("Paste auth/API token", "Save a token locally and inject it into the CLI env."),
        ("Run auth login flow", "Launch the provider's browser/device login flow."),
        ("Skip", "Leave this provider unchanged for now."),
    ];

    let mut stderr = std::io::stderr();

    terminal::enable_raw_mode()?;
    execute!(stderr, cursor::Hide)?;
    let (_, start_row) = cursor::position()?;

    let mut cursor_idx = 0usize;

    let result = loop {
        execute!(
            stderr,
            cursor::MoveTo(0, start_row),
            terminal::Clear(ClearType::FromCursorDown)
        )?;

        write!(stderr, "\r\n")?;
        write!(stderr, "  {}\r\n", "Choose auth method".bold())?;
        write!(
            stderr,
            "  {}\r\n",
            "↑/↓ move  Space/Enter select  q cancel".dark_grey()
        )?;
        write!(stderr, "\r\n")?;

        for (i, (label, help)) in options.iter().enumerate() {
            let marker = if i == cursor_idx { "▸" } else { " " };
            if i == cursor_idx {
                writeln!(
                    stderr,
                    "  {} {}\r",
                    marker.bold().cyan(),
                    label.bold().white()
                )?;
                writeln!(stderr, "      {}\r", help.dark_grey())?;
            } else {
                writeln!(stderr, "  {} {}\r", marker, label)?;
                writeln!(stderr, "      {}\r", help.dark_grey())?;
            }
        }

        stderr.flush()?;

        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Press {
                continue;
            }
            match key.code {
                KeyCode::Up | KeyCode::Char('k') => {
                    cursor_idx = cursor_idx.saturating_sub(1);
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    if cursor_idx + 1 < options.len() {
                        cursor_idx += 1;
                    }
                }
                KeyCode::Char(' ') | KeyCode::Enter => {
                    let method = match cursor_idx {
                        0 => CliAuthMethod::PasteToken,
                        1 => CliAuthMethod::AuthLogin,
                        _ => CliAuthMethod::Skip,
                    };
                    break Some(method);
                }
                KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('Q') => {
                    break None;
                }
                _ => {}
            }
        }
    };

    execute!(
        stderr,
        cursor::MoveTo(0, start_row),
        terminal::Clear(ClearType::FromCursorDown),
        cursor::Show
    )?;
    terminal::disable_raw_mode()?;
    eprintln!();

    Ok(result)
}

fn setup_cli_token(provider: AuthProvider) -> Result<()> {
    if local_cli_auth_vars_for_provider(provider.id).is_some() {
        println!("A local CLI token is already saved for {}.", provider.id);
        let action = read_line("Enter [p]aste new token, [c]lear token, or [s]kip [p]: ")?;
        let action = action.trim().to_lowercase();
        if action == "c" || action == "clear" {
            clear_local_cli_auth(provider.id)?;
            println!("Cleared local CLI token for {}", provider.id);
            return Ok(());
        }
        if action == "s" || action == "skip" {
            println!("Skipped.");
            return Ok(());
        }
    }

    let prompt = match provider.id {
        "claude-cli" => {
            "Paste Claude auth token/API key, :clipboard, or @/path/to/file (leave empty to cancel): "
        }
        "codex-cli" => {
            "Paste Codex auth.json contents, access/id token, :clipboard, or @/path/to/file (leave empty to cancel): "
        }
        "gemini-cli" => {
            "Paste Gemini token/API key, :clipboard, or @/path/to/file (leave empty to cancel): "
        }
        _ => "Paste token, :clipboard, or @/path/to/file (leave empty to cancel): ",
    };

    let token = read_secret_input(prompt)?;
    let token = token.trim();
    if token.is_empty() {
        println!("No token entered. Cancelled.");
        return Ok(());
    }

    let env = cli_env_for_token(provider.id, token);
    store_local_cli_auth_env(provider.id, &env)?;
    let injected = apply_local_cli_auth_env(provider.id);

    let mut saved_keys: Vec<&str> = env.keys().map(|k| k.as_str()).collect();
    saved_keys.sort_unstable();
    println!(
        "Saved local auth material for {} ({} variable{} prepared).",
        provider.id,
        saved_keys.len(),
        if saved_keys.len() == 1 { "" } else { "s" }
    );
    if injected > 0 {
        println!("Applied {} env var{} for this Forge session.", injected, if injected == 1 { "" } else { "s" });
    }
    Ok(())
}

fn read_secret_input(prompt: &str) -> Result<String> {
    let input = read_line(prompt)?;
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    if trimmed == ":clipboard" {
        return read_from_clipboard();
    }

    if let Some(path) = trimmed.strip_prefix('@') {
        return read_from_file_path(path);
    }

    Ok(input)
}

fn read_from_clipboard() -> Result<String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("pbpaste").output()?;
        if !output.status.success() {
            return Err(anyhow::anyhow!("pbpaste failed"));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(anyhow::anyhow!(
            ":clipboard is currently only implemented on macOS"
        ))
    }
}

fn read_from_file_path(path: &str) -> Result<String> {
    let expanded = if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join(rest)
    } else {
        std::path::PathBuf::from(path)
    };

    let content = std::fs::read_to_string(&expanded)
        .map_err(|e| anyhow::anyhow!("Failed to read {}: {e}", expanded.display()))?;
    Ok(content.trim().to_string())
}

fn cli_env_for_token(provider_id: &str, token: &str) -> std::collections::HashMap<String, String> {
    let mut env = std::collections::HashMap::new();
    let is_api_key = looks_like_api_key(token);

    match provider_id {
        "claude-cli" => {
            if is_api_key {
                env.insert("ANTHROPIC_API_KEY".to_string(), token.to_string());
            } else {
                env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), token.to_string());
            }
        }
        "codex-cli" => {
            if is_api_key {
                // Keep both for compatibility across Codex versions/configs.
                env.insert("OPENAI_API_KEY".to_string(), token.to_string());
                env.insert("CODEX_API_KEY".to_string(), token.to_string());
            } else if let Some(codex_env) = codex_cli_env_from_token(token) {
                env.extend(codex_env);
            } else {
                // Fallback for older opaque Codex auth token flows.
                env.insert("CODEX_API_KEY".to_string(), token.to_string());
            }
        }
        "gemini-cli" => {
            env.insert("GEMINI_API_KEY".to_string(), token.to_string());
            env.insert("GOOGLE_API_KEY".to_string(), token.to_string());
        }
        _ => {}
    }

    env
}

fn codex_cli_env_from_token(token: &str) -> Option<std::collections::HashMap<String, String>> {
    let raw = token.trim();
    if raw.is_empty() {
        return None;
    }

    if raw.starts_with('{') {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(raw) {
            if let Some(map) = codex_env_from_auth_json(&json) {
                return Some(map);
            }
        }
    }

    if looks_like_jwt(raw) {
        let mut env = std::collections::HashMap::new();
        env.insert("CODEX_AUTH_MODE".to_string(), "chatgpt".to_string());
        if jwt_looks_like_access_token(raw) {
            env.insert("CODEX_ACCESS_TOKEN".to_string(), raw.to_string());
        } else {
            env.insert("CODEX_ID_TOKEN".to_string(), raw.to_string());
        }
        return Some(env);
    }

    None
}

fn codex_env_from_auth_json(
    json: &serde_json::Value,
) -> Option<std::collections::HashMap<String, String>> {
    let auth_mode = json.get("auth_mode").and_then(|v| v.as_str())?;
    let tokens = json.get("tokens")?.as_object()?;

    let mut env = std::collections::HashMap::new();
    env.insert("CODEX_AUTH_MODE".to_string(), auth_mode.to_string());

    for (json_key, env_key) in [
        ("access_token", "CODEX_ACCESS_TOKEN"),
        ("id_token", "CODEX_ID_TOKEN"),
        ("refresh_token", "CODEX_REFRESH_TOKEN"),
        ("account_id", "CODEX_ACCOUNT_ID"),
    ] {
        if let Some(value) = tokens.get(json_key).and_then(|v| v.as_str()) {
            if !value.trim().is_empty() {
                env.insert(env_key.to_string(), value.to_string());
            }
        }
    }

    if env.len() > 1 { Some(env) } else { None }
}

fn looks_like_jwt(token: &str) -> bool {
    token.split('.').count() == 3 && token.starts_with("eyJ")
}

fn jwt_looks_like_access_token(token: &str) -> bool {
    let Some(payload_b64) = token.split('.').nth(1) else {
        return false;
    };
    let mut payload = payload_b64.replace('-', "+").replace('_', "/");
    while payload.len() % 4 != 0 {
        payload.push('=');
    }

    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload) else {
        return false;
    };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };

    json.get("aud")
        .and_then(|v| v.as_array())
        .map(|aud| {
            aud.iter().any(|entry| {
                entry
                    .as_str()
                    .map(|s| s.contains("api.openai.com/v1"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn looks_like_api_key(token: &str) -> bool {
    let t = token.trim().to_lowercase();
    t.starts_with("sk-")
        || t.starts_with("sk_ant")
        || t.starts_with("sk-ant-")
        || t.starts_with("xai-")
        || t.starts_with("gsk_")
        || t.starts_with("gsk-")
}

async fn run_cli_login(binary: &str, login_args: &[&str]) -> Result<()> {
    if login_args.is_empty() {
        println!("Launch `gemini` and run `/auth` inside the CLI.");
        if ask_yes_no("Launch Gemini CLI now? [y/N]: ", false)? {
            let status = tokio::process::Command::new(binary)
                .stdin(std::process::Stdio::inherit())
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit())
                .status()
                .await?;
            if !status.success() {
                println!("`{binary}` exited with status: {status}");
            }
        }
        return Ok(());
    }

    let cmd = format!("{} {}", binary, login_args.join(" "));
    if !ask_yes_no(&format!("Run `{cmd}` now? [Y/n]: "), true)? {
        println!("Skipped. Run manually when ready: {cmd}");
        return Ok(());
    }

    let status = tokio::process::Command::new(binary)
        .args(login_args)
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .status()
        .await?;

    if status.success() {
        println!("CLI login flow completed.");
    } else {
        println!("Login command exited with status: {status}");
    }
    Ok(())
}

async fn which(binary: &str) -> Option<String> {
    let out = tokio::process::Command::new("which")
        .arg(binary)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn read_line(prompt: &str) -> Result<String> {
    let _ = write!(std::io::stdout(), "{prompt}");
    std::io::stdout().flush()?;
    let mut buf = String::new();
    std::io::stdin().read_line(&mut buf)?;
    Ok(buf.trim_end().to_string())
}

fn ask_yes_no(prompt: &str, default_yes: bool) -> Result<bool> {
    let answer = read_line(prompt)?;
    let answer = answer.trim().to_lowercase();
    if answer.is_empty() {
        return Ok(default_yes);
    }
    Ok(matches!(answer.as_str(), "y" | "yes"))
}

fn open_url(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).status()?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(url).status()?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .status()?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(std::io::Error::other("unsupported platform"))
}
