mod auth;

use anyhow::Result;
use clap::Parser;
use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    style::Stylize,
    terminal,
};
use forge_provider::create_provider;
use forge_signet::config::{
    agent_name_for, build_agent_identity_prompt, build_identity_prompt,
    ensure_agent_workspace_scaffold, load_agent_config, normalize_agent_id, resolve_agent_workspace_path,
    AgentExecutionPolicy,
};
use forge_signet::secrets::{
    apply_local_cli_auth_env, default_model_for_provider, discover_available_providers,
    refresh_daemon_model_registry, resolve_api_key, sync_local_api_keys_from_daemon,
    DiscoveredProvider, KeySource,
};
use forge_signet::SignetClient;
use forge_tui::App;
use std::io::{IsTerminal, Write};
use std::sync::Arc;
use tracing::{info, warn};

#[derive(Parser)]
#[command(name = "forge", version, about = "Signet's native AI terminal")]
struct Cli {
    /// Model to use (e.g., claude-sonnet-4-6, gpt-4o, gemini-2.5-flash)
    #[arg(short, long)]
    model: Option<String>,

    /// Provider (anthropic, openai, gemini, groq, ollama, openrouter, xai)
    #[arg(long)]
    provider: Option<String>,

    /// Signet daemon URL
    #[arg(long, default_value = "http://localhost:3850")]
    daemon_url: String,

    /// Bearer token for Signet daemon auth (team/hybrid modes)
    #[arg(long)]
    signet_token: Option<String>,

    /// Actor name to send to the Signet daemon
    #[arg(long)]
    signet_actor: Option<String>,

    /// Run without connecting to Signet daemon
    #[arg(long)]
    no_daemon: bool,

    /// Resume the last session
    #[arg(long)]
    resume: bool,

    /// Non-interactive mode: send a single prompt and print the response
    #[arg(short = 'p', long = "prompt")]
    prompt: Option<String>,

    /// Output style for non-interactive mode (text, json, jsonl)
    #[arg(long = "output-style", default_value = "text")]
    output_style: String,

    /// Do not execute the prompt; print resolved model/provider/policy plan and exit
    #[arg(long = "dry-run")]
    dry_run: bool,

    /// Launch interactive provider auth setup (browser login + API key paste)
    #[arg(long)]
    auth: bool,

    /// Run auth setup, then exit without starting Forge
    #[arg(long)]
    auth_only: bool,

    /// Auth a specific provider directly (e.g. anthropic, openai, claude-cli)
    #[arg(long)]
    auth_provider: Option<String>,

    /// Color theme (transparency, signet-dark, signet-light, midnight, amber)
    #[arg(long, default_value = "transparency")]
    theme: String,

    /// Agent name (uses per-agent identity files from ~/.agents/agents/<name>/)
    #[arg(long)]
    agent: Option<String>,

    /// Print Forge capability manifest (human-readable) and exit
    #[arg(long)]
    capabilities: bool,

    /// Print Forge capability manifest as JSON and exit
    #[arg(long = "capabilities-json")]
    capabilities_json: bool,

    /// Acknowledge Forge development warning and continue without prompt
    #[arg(short = 'y', long)]
    yes: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    // Initialize logging — file for TUI mode, stderr for -p mode
    let log_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "forge=info".into());

    if cli.prompt.is_some() {
        // Non-interactive: log to stderr (won't corrupt output)
        tracing_subscriber::fmt()
            .with_env_filter(log_filter)
            .with_target(false)
            .with_writer(std::io::stderr)
            .init();
    } else {
        // TUI mode: log to file so it doesn't bleed into the terminal
        let log_dir = dirs::data_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("forge");
        let _ = std::fs::create_dir_all(&log_dir);
        let log_file = std::fs::File::create(log_dir.join("forge.log"))
            .unwrap_or_else(|_| std::fs::File::create("/dev/null").unwrap());
        tracing_subscriber::fmt()
            .with_env_filter(log_filter)
            .with_target(false)
            .with_writer(std::sync::Mutex::new(log_file))
            .with_ansi(false)
            .init();
    }

    // Load Signet agent config and resolve selected agent metadata.
    // All set_var calls happen here before tokio's thread pool starts.
    let agent_config = load_agent_config().unwrap_or_default();
    let selected_agent = cli
        .agent
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let selected_agent_id = selected_agent
        .as_deref()
        .map(normalize_agent_id);
    let selected_profile = selected_agent
        .as_deref()
        .and_then(|name| agent_config.find_agent_profile(name))
        .cloned();
    let selected_policy = selected_profile
        .as_ref()
        .and_then(|p| p.policy.clone())
        .unwrap_or_default();

    // Phase A: create per-agent workspace scaffold and run Forge from that
    // filesystem root for deterministic isolation.
    if let Some(agent_name) = selected_agent.as_deref() {
        let workspace = ensure_agent_workspace_scaffold(agent_name, Some(&agent_config))?;
        std::env::set_current_dir(&workspace).map_err(|e| {
            anyhow::anyhow!(
                "Failed to switch to agent workspace {}: {e}",
                workspace.display()
            )
        })?;
        info!(
            "Agent workspace active: {} -> {}",
            agent_name,
            workspace.display()
        );
    }

    // Phase B policy propagation — set env vars before async runtime starts
    // to avoid UB from set_var in multi-threaded context (Rust 1.81+).
    std::env::set_var(
        "FORGE_WORKSPACE_ONLY",
        if selected_policy.workspace_only.unwrap_or(true) {
            "1"
        } else {
            "0"
        },
    );
    if !selected_policy.allowed_paths.is_empty() {
        std::env::set_var("FORGE_ALLOWED_PATHS", selected_policy.allowed_paths.join(":"));
    }
    if !selected_policy.allowed_commands.is_empty() {
        std::env::set_var("FORGE_ALLOWED_COMMANDS", selected_policy.allowed_commands.join(","));
    }

    if let Some(token) = cli.signet_token.as_deref().filter(|v| !v.trim().is_empty()) {
        std::env::set_var("FORGE_SIGNET_TOKEN", token);
    }
    if let Some(actor) = cli.signet_actor.as_deref().filter(|v| !v.trim().is_empty()) {
        std::env::set_var("FORGE_SIGNET_ACTOR", actor);
    } else if let Some(agent_id) = selected_agent_id.as_deref() {
        std::env::set_var("FORGE_SIGNET_ACTOR", agent_id);
    }
    std::env::set_var("FORGE_SIGNET_ACTOR_TYPE", "agent");

    // Now start the async runtime — all env mutations are done.
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(cli, selected_agent, selected_agent_id, selected_profile, selected_policy, agent_config))
}

async fn run(
    cli: Cli,
    selected_agent: Option<String>,
    selected_agent_id: Option<String>,
    selected_profile: Option<forge_signet::config::AgentWorkspaceConfig>,
    selected_policy: AgentExecutionPolicy,
    agent_config: forge_signet::config::AgentConfig,
) -> Result<()> {
    // Optional: provider auth setup (local Forge credentials + CLI browser login)
    if cli.auth || cli.auth_only || cli.auth_provider.is_some() {
        auth::run_auth_wizard(cli.auth_provider.as_deref()).await?;
        if cli.auth_only {
            return Ok(());
        }
    }

    // Safety warning gate for entering the interactive harness.
    if cli.prompt.is_none() && !confirm_forge_launch_warning(cli.yes)? {
        return Ok(());
    }

    // Signet onboarding — check install, run setup, start daemon
    if !cli.no_daemon {
        ensure_signet(&cli.daemon_url).await;
    }

    // Connect to Signet daemon
    let signet_client = if cli.no_daemon {
        warn!("Running without Signet daemon — memory and identity disabled");
        None
    } else {
        let mut client = SignetClient::new(&cli.daemon_url);
        if let Some(token) = cli.signet_token.as_deref() {
            client = client.with_token(token);
        }
        if let Some(actor) = cli.signet_actor.as_deref() {
            client = client.with_actor(actor);
        } else if let Some(agent_id) = selected_agent_id.as_deref() {
            client = client.with_actor(agent_id);
        } else {
            client = client.with_actor("forge");
        }
        client = client.with_actor_type("agent");
        if let Some(agent_name) = selected_agent.as_deref() {
            let workspace = resolve_agent_workspace_path(agent_name, Some(&agent_config));
            let agent_id = normalize_agent_id(agent_name);
            client = client.with_agent(&agent_id);
            info!(
                "Agent mode: {} (id: {}, workspace: {})",
                agent_name,
                agent_id,
                workspace.display()
            );
        }
        if client.is_available().await {
            info!("Connected to Signet daemon at {}", cli.daemon_url);
            Some(client)
        } else {
            warn!(
                "Signet daemon not available at {} — running in standalone mode",
                cli.daemon_url
            );
            None
        }
    };

    // Pull API keys from Signet secrets into Forge local config automatically.
    if let Some(client) = signet_client.as_ref() {
        match sync_local_api_keys_from_daemon(client).await {
            Ok(imported) if !imported.is_empty() => {
                info!(
                    "Imported Signet secrets into Forge local credentials: {}",
                    imported
                        .iter()
                        .map(|p| p.provider.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                if let Err(e) = refresh_daemon_model_registry(client).await {
                    warn!("Could not refresh Signet model registry after secret sync: {e}");
                }
            }
            Ok(_) => {}
            Err(e) => warn!("Could not sync Signet secrets into Forge credentials: {e}"),
        }
    }

    // Discover available providers — API keys, authenticated CLI tools, local models
    let mut available = discover_available_providers(signet_client.as_ref()).await;

    // If nothing but bare Ollama is available, offer Forge auth setup.
    if cli.prompt.is_none() && !has_non_ollama_provider(&available) {
        eprintln!();
        eprintln!("  {}", "Forge — Provider auth needed".bold());
        eprintln!();
        eprintln!("  No authenticated cloud providers were detected.");
        eprintln!("  You can log in via browser or paste API keys directly into Forge.");
        eprintln!();
        eprint!("  Run Forge auth setup now? [Y/n]: ");
        let _ = std::io::stderr().flush();
        let mut input = String::new();
        if std::io::stdin().read_line(&mut input).is_ok() {
            let choice = input.trim().to_lowercase();
            if choice.is_empty() || choice.starts_with('y') {
                auth::run_auth_wizard(None).await?;
                available = discover_available_providers(signet_client.as_ref()).await;
            }
        }
    }
    let connected_providers: Vec<String> = available.iter().map(|p| p.provider.clone()).collect();

    if cli.capabilities || cli.capabilities_json {
        let capabilities = build_capability_manifest(
            selected_agent.as_deref(),
            selected_agent_id.as_deref(),
            selected_profile.as_ref().and_then(|p| p.model.as_deref()),
            &selected_policy,
            &connected_providers,
        );
        if cli.capabilities_json {
            println!("{}", serde_json::to_string_pretty(&capabilities)?);
        } else {
            print_capability_manifest_human(&capabilities);
        }
        return Ok(());
    }

    // Load persistent settings (model, provider, effort from last session)
    let settings = forge_tui::settings::Settings::load();

    // Extract values before consuming cli in defaults
    let prompt_arg = cli.prompt.clone();
    let resume_arg = cli.resume;
    let agent_arg = selected_agent.clone();

    // Apply saved settings as defaults when CLI args not explicitly provided
    let model_default = if cli.model.is_some() {
        cli.model.clone()
    } else if let Some(profile_model) = selected_profile.as_ref().and_then(|p| p.model.clone()) {
        Some(profile_model)
    } else {
        settings.model.clone()
    };

    let cli_with_defaults = Cli {
        model: model_default,
        provider: cli.provider.clone().or(settings.provider),
        theme: if cli.theme == "transparency" {
            settings.theme.unwrap_or_else(|| cli.theme.clone())
        } else {
            cli.theme.clone()
        },
        ..cli
    };

    // Determine provider and model
    let (provider_name, model) = select_provider(&cli_with_defaults, &available)?;

    info!("Forge starting — provider: {provider_name}, model: {model}");

    // Non-interactive dry-run plan: resolve everything, but skip provider execution.
    if let Some(prompt) = prompt_arg.as_deref() {
        if cli_with_defaults.dry_run {
            print_non_interactive_plan(
                prompt,
                &cli_with_defaults.output_style,
                &provider_name,
                &model,
                selected_agent.as_deref(),
                selected_agent_id.as_deref(),
                &selected_policy,
            )?;
            return Ok(());
        }
    }

    // Create provider — CLI providers use installed binaries, API providers need keys
    let active_cli_path = find_cli_path(&provider_name, &available);
    let provider: Arc<dyn forge_provider::Provider> = if let Some(ref cli_path) =
        active_cli_path
    {
        // CLI provider — no API key needed, the CLI handles auth
        let injected = apply_local_cli_auth_env(&provider_name);
        let kind = match provider_name.as_str() {
            "claude-cli" => forge_provider::cli::CliKind::Claude,
            "codex-cli" => forge_provider::cli::CliKind::Codex,
            "gemini-cli" => forge_provider::cli::CliKind::Gemini,
            _ => unreachable!(),
        };
        info!("Using CLI provider: {cli_path} (injected {injected} auth env vars)");
        Arc::from(forge_provider::create_cli_provider(kind, cli_path, &model))
    } else {
        // API provider — resolve key
        let api_key =
            resolve_api_key(signet_client.as_ref(), &provider_name)
                .await
                .map_err(|_| {
                    let secret_name =
                        forge_signet::secrets::provider_to_secret_name(&provider_name);
                    anyhow::anyhow!(
                        "No API key for {provider_name}.\n\n\
                         To fix this, either:\n  \
                         • Run Forge auth setup: forge --auth --auth-provider {provider_name}\n  \
                         • Set {secret_name} in your environment\n  \
                         • (Optional) Store in Signet: signet secret set {secret_name}\n  \
                         • Use an installed CLI:  forge --provider claude-cli\n  \
                         • Use a local model:    forge --provider ollama --model qwen3:4b"
                    )
                })?;
        Arc::from(create_provider(&provider_name, &model, &api_key)?)
    };

    // Build system prompt from Signet identity files (per-agent if --agent set)
    let identity_prompt = if let Some(ref agent_name) = agent_arg {
        let prompt = build_agent_identity_prompt(agent_name);
        if prompt.is_empty() {
            info!("No per-agent identity files for '{}', falling back to root", agent_name);
            build_identity_prompt()
        } else {
            prompt
        }
    } else {
        build_identity_prompt()
    };
    let system_prompt = if identity_prompt.is_empty() {
        "You are Forge, a helpful AI coding assistant running in a terminal. \
         Help the user with software engineering tasks."
            .to_string()
    } else {
        identity_prompt
    };

    // Non-interactive mode: send prompt, print response, exit
    if let Some(prompt) = prompt_arg {
        return run_non_interactive(
            provider,
            signet_client,
            system_prompt,
            &prompt,
            &cli_with_defaults.output_style,
        )
        .await;
    }

    // Interactive TUI mode
    let mut terminal = ratatui::init();
    let mut app = App::new(
        provider,
        signet_client,
        system_prompt,
        active_cli_path,
        &cli_with_defaults.theme,
        agent_arg,
        agent_name_for(selected_agent.as_deref(), Some(&agent_config)),
        selected_policy.clone(),
        selected_policy.auto_approve_write_tools.clone(),
        connected_providers,
    )
    .await;

    // Apply saved effort from settings
    if let Some(ref effort_str) = settings.effort {
        let effort = forge_provider::ReasoningEffort::parse(effort_str);
        if effort != forge_provider::ReasoningEffort::Medium {
            *app.effort_mut().lock().await = effort;
        }
    }

    if resume_arg {
        app.resume_last_session().await;
    }

    let result = app.run(&mut terminal).await;

    ratatui::restore();

    result
}

fn print_non_interactive_plan(
    prompt: &str,
    output_style: &str,
    provider_name: &str,
    model: &str,
    selected_agent: Option<&str>,
    selected_agent_id: Option<&str>,
    selected_policy: &AgentExecutionPolicy,
) -> Result<()> {
    let output_style_norm = output_style.trim().to_ascii_lowercase();
    let allowed_paths = if selected_policy.allowed_paths.is_empty() {
        Vec::new()
    } else {
        selected_policy.allowed_paths.clone()
    };
    let allowed_commands = if selected_policy.allowed_commands.is_empty() {
        Vec::new()
    } else {
        selected_policy.allowed_commands.clone()
    };
    let current_dir = std::env::current_dir()
        .ok()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "<unknown>".to_string());
    let workspace_only = selected_policy.workspace_only.unwrap_or(true);
    let payload = serde_json::json!({
        "schema": "forge.plan.v1",
        "mode": "non_interactive",
        "dry_run": true,
        "provider": provider_name,
        "model": model,
        "prompt_chars": prompt.chars().count(),
        "cwd": current_dir,
        "policy": {
            "workspace_only": workspace_only,
            "allowed_paths": allowed_paths,
            "allowed_commands": allowed_commands,
            "agent": selected_agent,
            "agent_id": selected_agent_id,
        }
    });

    match output_style_norm.as_str() {
        "jsonl" | "events" => {
            println!(
                "{}",
                serde_json::json!({
                    "schema": "forge.events.v1",
                    "type": "plan",
                    "plan": payload,
                })
            );
        }
        "json" => {
            println!("{}", serde_json::to_string_pretty(&payload)?);
        }
        _ => {
            println!("Forge non-interactive dry run");
            println!("  provider: {provider_name}");
            println!("  model: {model}");
            println!("  cwd: {current_dir}");
            println!("  prompt chars: {}", prompt.chars().count());
            println!("  policy.workspace_only: {workspace_only}");
            if !selected_policy.allowed_paths.is_empty() {
                println!("  policy.allowed_paths:");
                for path in &selected_policy.allowed_paths {
                    println!("    - {path}");
                }
            }
            if !selected_policy.allowed_commands.is_empty() {
                println!("  policy.allowed_commands:");
                for cmd in &selected_policy.allowed_commands {
                    println!("    - {cmd}");
                }
            }
            if let Some(agent) = selected_agent {
                println!("  agent: {agent}");
            }
            if let Some(agent_id) = selected_agent_id {
                println!("  agent_id: {agent_id}");
            }
        }
    }
    Ok(())
}

/// Check if Signet is installed, offer to install + setup if not, start daemon if needed.
async fn ensure_signet(daemon_url: &str) {
    let agents_dir = dirs::home_dir()
        .map(|h| h.join(".agents"))
        .unwrap_or_default();

    // 1. Check if signet CLI is installed
    let signet_path = tokio::process::Command::new("which")
        .arg("signet")
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

    if signet_path.is_none() {
        // Signet not installed — offer to install
        eprintln!();
        eprintln!("  {}", "Forge — First Run".bold());
        eprintln!();
        eprintln!("  Signet provides memory, identity, and extraction for Forge.");
        eprintln!("  It's optional but recommended for the full experience.");
        eprintln!();
        eprintln!("  Install Signet?");
        eprintln!();
        eprintln!("    {}", "1. Auto-install (curl installer)".white());
        eprintln!("    {}", "2. Skip (run without memory)".dark_grey());
        eprintln!();

        // Simple prompt (not raw mode — we need line input)
        eprint!("  Choice [1]: ");
        let _ = std::io::stderr().flush();
        let mut input = String::new();
        if std::io::stdin().read_line(&mut input).is_err() {
            return;
        }

        let choice = input.trim();
        if choice.is_empty() || choice == "1" {
            eprintln!();
            eprintln!("  Installing Signet...");
            eprintln!();

            // Run the official installer — gives control of terminal to subprocess
            let status = tokio::process::Command::new("bash")
                .arg("-c")
                .arg("curl -sL https://signetai.sh/install | bash")
                .stdin(std::process::Stdio::inherit())
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit())
                .status()
                .await;

            match status {
                Ok(s) if s.success() => {
                    eprintln!();
                    eprintln!("  {} Signet installed.", "✓".green());
                }
                _ => {
                    eprintln!();
                    eprintln!("  Installation failed. You can install manually:");
                    eprintln!("    curl -sL https://signetai.sh/install | bash");
                    eprintln!("    — or —");
                    eprintln!("    bun add -g signetai");
                    eprintln!();
                    eprintln!("  Continuing without Signet...");
                    return;
                }
            }
        } else {
            eprintln!("  Skipping. Use --no-daemon to suppress this check.");
            return;
        }
    }

    // 2. Check if setup has been completed (~/.agents exists with agent.yaml)
    let config_exists = agents_dir.join("agent.yaml").exists();

    if !config_exists {
        eprintln!();
        eprintln!("  {}", "Signet needs initial setup.".bold());
        eprintln!("  This creates your agent identity and configures providers.");
        eprintln!();
        eprint!("  Run setup now? [Y/n]: ");
        let _ = std::io::stderr().flush();
        let mut input = String::new();
        if std::io::stdin().read_line(&mut input).is_err() {
            return;
        }

        if input.trim().is_empty() || input.trim().to_lowercase().starts_with('y') {
            eprintln!();

            // Hand off to signet setup — fully interactive
            let status = tokio::process::Command::new("signet")
                .arg("setup")
                .stdin(std::process::Stdio::inherit())
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit())
                .status()
                .await;

            match status {
                Ok(s) if s.success() => {
                    eprintln!();
                    eprintln!("  {} Setup complete.", "✓".green());
                }
                _ => {
                    eprintln!("  Setup incomplete. Run 'signet setup' later to finish.");
                }
            }
        }
    }

    // 3. Check if daemon is running, start it if not
    let daemon_healthy = reqwest::Client::new()
        .get(format!("{daemon_url}/health"))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    if !daemon_healthy {
        eprintln!("  Starting Signet daemon...");

        let _ = tokio::process::Command::new("signet")
            .arg("start")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;

        // Wait for daemon to come up (max 5 seconds)
        for _ in 0..10 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let ok = reqwest::Client::new()
                .get(format!("{daemon_url}/health"))
                .timeout(std::time::Duration::from_secs(1))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            if ok {
                eprintln!("  {} Daemon running at {daemon_url}", "✓".green());
                eprintln!("  Dashboard: {daemon_url}");
                eprintln!();
                return;
            }
        }

        eprintln!("  Daemon didn't start. Try 'signet start' manually.");
        eprintln!("  Continuing without daemon...");
    }

    eprintln!();
}

fn print_forge_warning() {
    eprintln!();
    eprintln!("  {}", "Forge Development Warning".bold());
    eprintln!();
    eprintln!(
        "  Forge is {} and is currently used strictly for {}.",
        "under active development".yellow(),
        "Signet bug testing".yellow()
    );
    eprintln!(
        "  It should {}.",
        "not replace your active harness".yellow()
    );
    eprintln!(
        "  You may run into {} while using it.",
        "bugs or issues".yellow()
    );
    eprintln!();
}

fn confirm_forge_launch_warning(accepted_via_flag: bool) -> Result<bool> {
    if accepted_via_flag {
        return Ok(true);
    }

    print_forge_warning();

    if !std::io::stdin().is_terminal() || !std::io::stderr().is_terminal() {
        anyhow::bail!("Non-interactive launch requires explicit acknowledgement. Re-run with: forge --yes");
    }

    // Interactive left/right selector
    terminal::enable_raw_mode()?;
    let _raw_guard = RawModeGuard;

    let mut select_yes = true;
    loop {
        // Clear line and re-render selector
        execute!(
            std::io::stderr(),
            cursor::MoveToColumn(0),
            terminal::Clear(terminal::ClearType::CurrentLine)
        )?;

        let yes = if select_yes {
            format!("[ {} ]", "YES".bold().green())
        } else {
            format!("[ {} ]", "yes".dark_grey())
        };
        let no = if !select_yes {
            format!("[ {} ]", "NO".bold().yellow())
        } else {
            format!("[ {} ]", "no".dark_grey())
        };

        eprint!("  Continue to launch Forge?  {yes}  {no}  (←/→ + Enter)");
        let _ = std::io::stderr().flush();

        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Press {
                continue;
            }
            match key.code {
                KeyCode::Left | KeyCode::Char('h') => select_yes = true,
                KeyCode::Right | KeyCode::Char('l') => select_yes = false,
                KeyCode::Char('y') => select_yes = true,
                KeyCode::Char('n') => select_yes = false,
                KeyCode::Enter => {
                    eprintln!();
                    if select_yes {
                        return Ok(true);
                    }
                    eprintln!("  Launch cancelled.");
                    return Ok(false);
                }
                KeyCode::Esc => {
                    eprintln!();
                    eprintln!("  Launch cancelled.");
                    return Ok(false);
                }
                _ => {}
            }
        }
    }
}

struct RawModeGuard;

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
    }
}

#[cfg(test)]
fn parse_yes_no_answer(input: &str) -> Option<bool> {
    let normalized = input.trim().to_lowercase();
    if normalized == "yes" || normalized == "y" {
        return Some(true);
    }
    if normalized == "no" || normalized == "n" {
        return Some(false);
    }
    None
}

fn build_capability_manifest(
    selected_agent: Option<&str>,
    selected_agent_id: Option<&str>,
    routed_model: Option<&str>,
    policy: &AgentExecutionPolicy,
    connected_providers: &[String],
) -> serde_json::Value {
    serde_json::json!({
        "harness": "forge",
        "runtime": {
            "first_party": true,
            "reference_runtime": true
        },
        "agent": {
            "name": selected_agent.unwrap_or("default"),
            "id": selected_agent_id.unwrap_or("default"),
            "model_route": routed_model.unwrap_or("auto"),
        },
        "filesystem": {
            "workspace_only": policy.workspace_only.unwrap_or(true),
            "scaffold_files": ["AGENTS.md", "SOUL.md", "IDENTITY.md", "MEMORY.md"]
        },
        "policy": {
            "approval_mode": policy.approval_mode.clone().unwrap_or_else(|| "balanced".to_string()),
            "auto_approve_write_tools": policy.auto_approve_write_tools.clone(),
            "allowed_commands": policy.allowed_commands.clone(),
            "allowed_paths": policy.allowed_paths.clone()
        },
        "providers": {
            "connected": connected_providers
        },
        "tools": {
            "built_in": ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
            "signet": ["memory_search", "memory_store", "knowledge_expand", "secret_exec"]
        }
    })
}

fn print_capability_manifest_human(manifest: &serde_json::Value) {
    println!("Forge Capability Manifest");
    println!("------------------------");
    println!("harness: forge (first-party, reference runtime)");
    println!(
        "agent: {} ({})",
        manifest["agent"]["name"].as_str().unwrap_or("default"),
        manifest["agent"]["id"].as_str().unwrap_or("default")
    );
    println!(
        "model route: {}",
        manifest["agent"]["model_route"].as_str().unwrap_or("auto")
    );
    println!(
        "workspace_only: {}",
        manifest["filesystem"]["workspace_only"].as_bool().unwrap_or(true)
    );
    if let Some(mode) = manifest["policy"]["approval_mode"].as_str() {
        println!("approval mode: {mode}");
    }
    if let Some(arr) = manifest["providers"]["connected"].as_array() {
        let names = arr
            .iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        println!("connected providers: {names}");
    }
}

#[cfg(test)]
mod tests {
    use super::parse_yes_no_answer;

    #[test]
    fn parse_yes_variants() {
        assert_eq!(parse_yes_no_answer("yes"), Some(true));
        assert_eq!(parse_yes_no_answer("Y"), Some(true));
        assert_eq!(parse_yes_no_answer("  YeS  "), Some(true));
    }

    #[test]
    fn parse_no_variants() {
        assert_eq!(parse_yes_no_answer("no"), Some(false));
        assert_eq!(parse_yes_no_answer("N"), Some(false));
        assert_eq!(parse_yes_no_answer("  No  "), Some(false));
    }

    #[test]
    fn parse_unknown_variants() {
        assert_eq!(parse_yes_no_answer(""), None);
        assert_eq!(parse_yes_no_answer("maybe"), None);
        assert_eq!(parse_yes_no_answer("1"), None);
    }
}

/// Determine which provider and model to use based on CLI args and available keys
fn select_provider(cli: &Cli, available: &[DiscoveredProvider]) -> Result<(String, String)> {
    // If user explicitly specified --provider, use it
    if let Some(ref provider) = cli.provider {
        let model = cli
            .model
            .clone()
            .unwrap_or_else(|| default_model_for_provider(provider).to_string());
        return Ok((provider.clone(), model));
    }

    // Phase B routing: if a model is explicitly selected (CLI or agent profile)
    // and provider is omitted, infer provider from model family.
    if let Some(model) = cli.model.clone() {
        let inferred = infer_provider_from_model(&model).to_string();
        let has_inferred = available.iter().any(|p| p.provider == inferred);
        if has_inferred {
            return Ok((inferred, model));
        }
    }

    // Usable providers: API keys (daemon/env), CLI tools, and ollama
    // For auto-selection, prefer API keys and CLIs over bare ollama
    let usable: Vec<&DiscoveredProvider> = available
        .iter()
        .filter(|p| {
            // Include: has API key, is CLI tool, or is ollama
            !p.secret_name.is_empty() || matches!(p.source, KeySource::Cli { .. }) || p.provider == "ollama"
        })
        .collect();

    // Providers with actual keys or CLI tools (not bare ollama)
    let preferred: Vec<&DiscoveredProvider> = usable
        .iter()
        .filter(|p| p.provider != "ollama" || matches!(p.source, KeySource::Cli { .. }))
        .copied()
        .collect();

    if preferred.is_empty() {
        // Only ollama available — check if user specified a model
        if cli.model.is_some() {
            let model = cli.model.clone().unwrap();
            let provider = infer_provider_from_model(&model);
            return Ok((provider.to_string(), model));
        }

        // No API keys or CLI tools — show setup help
        eprintln!();
        eprintln!("{}", "  Forge — No providers found".bold());
        eprintln!();
        eprintln!("  No API keys or CLI tools were detected.");
        eprintln!();
        eprintln!("  To get started:");
        eprintln!("    1. Run auth wizard:      forge --auth");
        eprintln!("    2. Set env var manually: export ANTHROPIC_API_KEY=sk-...");
        eprintln!("    3. Use a CLI provider:   forge --provider claude-cli");
        eprintln!("    4. Use local model:      forge --provider ollama --model qwen3:4b");
        eprintln!();
        std::process::exit(1);
    }

    if preferred.len() == 1 && cli.prompt.is_none() {
        // Single option — use it automatically
        let p = preferred[0];
        let model = cli
            .model
            .clone()
            .unwrap_or_else(|| default_model_for_provider(&p.provider).to_string());
        info!(
            "Auto-selected provider: {} ({} from {})",
            p.provider, p.secret_name, p.source
        );
        return Ok((p.provider.clone(), model));
    }

    if cli.prompt.is_some() {
        // Non-interactive — use first preferred provider
        let p = preferred[0];
        let model = cli
            .model
            .clone()
            .unwrap_or_else(|| default_model_for_provider(&p.provider).to_string());
        return Ok((p.provider.clone(), model));
    }

    // Multiple options — interactive selection (show all usable providers)
    let selected = interactive_provider_select(&usable)?;
    let model = cli
        .model
        .clone()
        .unwrap_or_else(|| default_model_for_provider(&selected.provider).to_string());
    Ok((selected.provider.clone(), model))
}

/// Interactive provider selector — arrow keys to navigate, enter to select
fn interactive_provider_select(providers: &[&DiscoveredProvider]) -> Result<DiscoveredProvider> {
    let mut stdout = std::io::stderr();

    terminal::enable_raw_mode()?;
    execute!(stdout, cursor::Hide)?;

    let mut selected: usize = 0;
    let result = loop {
        // Clear and render
        execute!(stdout, cursor::MoveToColumn(0))?;

        // Header
        write!(stdout, "\r\n")?;
        write!(
            stdout,
            "  {}\r\n",
            "Forge — Select Provider".bold()
        )?;
        write!(stdout, "\r\n")?;

        // Provider list
        for (i, p) in providers.iter().enumerate() {
            let marker = if i == selected { "▸" } else { " " };
            let source_tag = format!("[{}]", p.source);

            if i == selected {
                write!(
                    stdout,
                    "  {} {:<14} {:<24} {}\r\n",
                    marker.bold().cyan(),
                    p.provider.clone().bold().white(),
                    p.secret_name.clone().dark_grey(),
                    source_tag.dark_grey(),
                )?;
            } else {
                write!(
                    stdout,
                    "  {} {:<14} {:<24} {}\r\n",
                    marker,
                    p.provider.clone().grey(),
                    p.secret_name.clone().dark_grey(),
                    source_tag.dark_grey(),
                )?;
            }
        }

        write!(stdout, "\r\n")?;
        write!(
            stdout,
            "  {}\r\n",
            "↑/↓ navigate  Enter select  q quit".dark_grey()
        )?;
        stdout.flush()?;

        // Handle input
        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Press {
                // Move cursor back up to redraw
                let lines = providers.len() + 5;
                execute!(stdout, cursor::MoveUp(lines as u16))?;
                continue;
            }
            match key.code {
                KeyCode::Up | KeyCode::Char('k') => {
                    selected = selected.saturating_sub(1);
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    if selected < providers.len() - 1 {
                        selected += 1;
                    }
                }
                KeyCode::Enter | KeyCode::Char(' ') => {
                    break providers[selected].clone();
                }
                KeyCode::Char('q') | KeyCode::Esc => {
                    execute!(stdout, cursor::Show)?;
                    terminal::disable_raw_mode()?;
                    eprintln!();
                    std::process::exit(0);
                }
                _ => {}
            }

            // Move cursor back up to redraw
            let lines = providers.len() + 5;
            execute!(stdout, cursor::MoveUp(lines as u16))?;
        }
    };

    // Cleanup
    execute!(stdout, cursor::Show)?;
    terminal::disable_raw_mode()?;
    eprintln!();

    Ok(result)
}

/// Infer provider from a model name
fn infer_provider_from_model(model: &str) -> &'static str {
    if model.starts_with("claude") {
        "anthropic"
    } else if model.starts_with("gpt") || model.starts_with("o1") || model.starts_with("o4") {
        "openai"
    } else if model.starts_with("gemini") {
        "gemini"
    } else if model.starts_with("llama") || model.starts_with("mixtral") {
        "groq"
    } else if model.starts_with("grok") {
        "xai"
    } else if model.contains('/') {
        "openrouter"
    } else {
        "ollama"
    }
}

/// Non-interactive mode: single prompt → streamed response → exit
async fn run_non_interactive(
    provider: Arc<dyn forge_provider::Provider>,
    _signet_client: Option<SignetClient>,
    system_prompt: String,
    prompt: &str,
    output_style: &str,
) -> Result<()> {
    use forge_core::{Message, TokenUsage};
    use forge_provider::{CompletionOpts, StreamEvent};
    use forge_tools;
    use futures::StreamExt;

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum OutputStyle {
        Text,
        Json,
        Jsonl,
    }

    impl OutputStyle {
        fn parse(raw: &str) -> Self {
            match raw.trim().to_lowercase().as_str() {
                "jsonl" | "events" => Self::Jsonl,
                "json" => Self::Json,
                _ => Self::Text,
            }
        }
    }

    let style = OutputStyle::parse(output_style);
    const EVENT_SCHEMA: &str = "forge.events.v1";

    let messages = vec![Message::user(prompt)];
    let tools = forge_tools::all_definitions();

    let opts = CompletionOpts {
        system_prompt: Some(system_prompt),
        max_tokens: Some(8192),
        ..Default::default()
    };

    let stream = provider.complete(&messages, &tools, &opts).await?;
    let mut stream = std::pin::pin!(stream);
    let mut usage: Option<TokenUsage> = None;
    let mut json_events: Vec<serde_json::Value> = Vec::new();
    let mut failed = false;

    while let Some(event) = stream.next().await {
        match event {
            StreamEvent::TextDelta(text) => {
                if style == OutputStyle::Text {
                    print!("{text}");
                } else {
                    let payload = serde_json::json!({
                        "schema": EVENT_SCHEMA,
                        "type": "text_delta",
                        "text": text,
                    });
                    if style == OutputStyle::Jsonl {
                        println!("{payload}");
                    } else {
                        json_events.push(payload);
                    }
                }
            }
            StreamEvent::ToolUseStart { id, name } => {
                if style != OutputStyle::Text {
                    let payload = serde_json::json!({
                        "schema": EVENT_SCHEMA,
                        "type": "tool_use_start",
                        "id": id,
                        "name": name,
                    });
                    if style == OutputStyle::Jsonl {
                        println!("{payload}");
                    } else {
                        json_events.push(payload);
                    }
                }
            }
            StreamEvent::ToolUseInput(input) => {
                if style != OutputStyle::Text {
                    let payload = serde_json::json!({
                        "schema": EVENT_SCHEMA,
                        "type": "tool_use_input",
                        "input": input,
                    });
                    if style == OutputStyle::Jsonl {
                        println!("{payload}");
                    } else {
                        json_events.push(payload);
                    }
                }
            }
            StreamEvent::ToolUseEnd => {
                if style != OutputStyle::Text {
                    let payload = serde_json::json!({
                        "schema": EVENT_SCHEMA,
                        "type": "tool_use_end"
                    });
                    if style == OutputStyle::Jsonl {
                        println!("{payload}");
                    } else {
                        json_events.push(payload);
                    }
                }
            }
            StreamEvent::ToolResult {
                name,
                output,
                is_error,
            } => {
                if style != OutputStyle::Text {
                    let payload = serde_json::json!({
                        "schema": EVENT_SCHEMA,
                        "type": "tool_result",
                        "name": name,
                        "is_error": is_error,
                        "output": output,
                    });
                    if style == OutputStyle::Jsonl {
                        println!("{payload}");
                    } else {
                        json_events.push(payload);
                    }
                }
            }
            StreamEvent::Status(status) => {
                if style != OutputStyle::Text {
                    let payload = serde_json::json!({
                        "schema": EVENT_SCHEMA,
                        "type": "status",
                        "status": status,
                    });
                    if style == OutputStyle::Jsonl {
                        println!("{payload}");
                    } else {
                        json_events.push(payload);
                    }
                }
            }
            StreamEvent::Usage(u) => {
                usage = Some(u.clone());
                if style != OutputStyle::Text {
                    let payload = serde_json::json!({
                        "schema": EVENT_SCHEMA,
                        "type": "usage",
                        "input_tokens": u.input_tokens,
                        "output_tokens": u.output_tokens,
                        "total_tokens": u.input_tokens + u.output_tokens,
                        "cache_read_tokens": u.cache_read_tokens,
                        "cache_creation_tokens": u.cache_creation_tokens,
                    });
                    if style == OutputStyle::Jsonl {
                        println!("{payload}");
                    } else {
                        json_events.push(payload);
                    }
                }
            }
            StreamEvent::Error(e) => {
                if style == OutputStyle::Text {
                    eprintln!("\nError: {e}");
                } else {
                    let payload = serde_json::json!({
                        "schema": EVENT_SCHEMA,
                        "type": "error",
                        "error": e,
                    });
                    if style == OutputStyle::Jsonl {
                        println!("{payload}");
                    } else {
                        json_events.push(payload);
                    }
                }
                failed = true;
                break;
            }
            StreamEvent::Done => {
                if style != OutputStyle::Text {
                    let payload = match usage.clone() {
                        Some(u) => serde_json::json!({
                            "schema": EVENT_SCHEMA,
                            "type": "done",
                            "input_tokens": u.input_tokens,
                            "output_tokens": u.output_tokens,
                            "total_tokens": u.input_tokens + u.output_tokens,
                            "cache_read_tokens": u.cache_read_tokens,
                            "cache_creation_tokens": u.cache_creation_tokens,
                        }),
                        None => serde_json::json!({ "schema": EVENT_SCHEMA, "type": "done" }),
                    };
                    if style == OutputStyle::Jsonl {
                        println!("{payload}");
                    } else {
                        json_events.push(payload);
                    }
                }
                break;
            }
        }
    }

    match style {
        OutputStyle::Text => println!(),
        OutputStyle::Json => {
            let payload = serde_json::json!({
                "schema": "forge.output.v1",
                "style": "json",
                "success": !failed,
                "events": json_events,
                "usage": usage.map(|u| serde_json::json!({
                    "input_tokens": u.input_tokens,
                    "output_tokens": u.output_tokens,
                    "total_tokens": u.input_tokens + u.output_tokens,
                    "cache_read_tokens": u.cache_read_tokens,
                    "cache_creation_tokens": u.cache_creation_tokens,
                })),
            });
            println!("{payload}");
        }
        OutputStyle::Jsonl => {}
    }
    if failed {
        std::process::exit(1);
    }
    Ok(())
}

/// Extract CLI binary path if this is a CLI-based provider
fn find_cli_path(provider_name: &str, available: &[DiscoveredProvider]) -> Option<String> {
    if !provider_name.ends_with("-cli") {
        return None;
    }
    available.iter().find_map(|p| {
        if p.provider == provider_name {
            if let KeySource::Cli { path } = &p.source {
                return Some(path.clone());
            }
        }
        None
    })
}

fn has_non_ollama_provider(available: &[DiscoveredProvider]) -> bool {
    available.iter().any(|p| p.provider != "ollama")
}
