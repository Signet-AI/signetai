---
title: "Quickstart"
description: "Install Signet, connect a harness, and give your agent persistent memory."
---

Install Signet, connect a harness, and give your agent memory that survives the session.

By the end of this guide, Signet will have a workspace, a daemon, an embedding provider, and a memory you can write and recall from the CLI.

## Before you start

You need:

- A macOS or Linux machine for the direct native installer, or Node.js with npm or Bun on Windows.
- One harness to connect. Signet currently supports Claude Code, Codex, OpenCode, ForgeCode, OpenClaw, Oh My Pi, Pi, Hermes Agent, and Gemini CLI.
- A decision about where embeddings and background inference should run.

Signet uses two different kinds of providers:

- Embeddings turn text into vectors for semantic search. The built-in native provider is the default, uses `nomic-embed-text-v1.5` at 768 dimensions, and runs locally without another service. Ollama and OpenAI are alternatives.
- Extraction and background inference turn evidence into summaries or other derived state. They use a harness, an API provider, or no provider, depending on your setup. Remote providers can cost money and send data outside the machine.

Keep raw credentials out of memories, source files, and prompts. The setup wizard uses Signet's secret handling for provider credentials.

If you are configuring OpenClaw, back up its workspace before applying changes. Signet can patch a detected OpenClaw workspace, and you should be able to restore it if the integration is not what you want.

## Install Signet

On macOS or Linux, the direct installer is the simplest path:

```bash
curl -fsSL https://signetai.sh/install.sh | bash
```

The same compiled CLI is also available through npm and Bun:

```bash
npm install -g signetai
# or
bun add -g signetai
```

On Windows, use the npm or Bun installation. The direct shell installer is for Unix-like systems.

Verify the binary before configuring anything:

```bash
signet --version
```

Signet stores its workspace at `~/.agents` by default. Set `SIGNET_PATH` or `SIGNET_WORKSPACE` when you need another location. A custom workspace is useful when you want the memory database, identity files, and configuration on a separate disk or under a project-specific backup policy.

## Create the workspace

Start the interactive setup wizard:

```bash
signet setup
```

Choose `Create new workspace` when this is a new installation. The wizard reviews the plan before it writes anything. It initializes the workspace, configures the selected harnesses, creates the memory database, starts the daemon, and can open the Dashboard when setup finishes.

### What the wizard asks

The exact prompts depend on your harness choices and whether the workspace already exists. A fresh workspace normally moves through these decisions:

1. Choose a new workspace or import from GitHub.
2. Decide whether Signet should manage identity and instruction files. If it should, choose an identity preset and give the agent a name.
3. Select one or more harnesses. OpenClaw has an additional workspace-patch and integration-mode decision.
4. Add an optional agent description.
5. Choose whether to install the Signet Secrets core plugin and whether to install GraphIQ for code retrieval.
6. Choose how the daemon is reachable: localhost only, local network or Tailscale, or a remote origin.
7. Choose an embedding provider. The built-in native provider is recommended for a local-first setup. Ollama asks for a model and checks the local service. OpenAI asks for API configuration. You can also skip embeddings.
8. Choose the search balance between semantic and keyword results. Balanced is the default recommendation.
9. Configure background inference, or disable it. The wizard supports harness login, API keys, ACPX, and OpenAI-compatible endpoints.
10. Optionally configure a separate aggregate-recall provider and advanced recall limits.
11. Optionally enable Dreaming.
12. Choose whether to initialize Git, add named agents, and import Obsidian vaults as sources.
13. Review the plan, apply it, and choose whether to open the Dashboard.

The setup wizard also explains telemetry before it records anything. Telemetry is limited to anonymous usage data such as versions and command names. It does not include memory content, code, arguments, paths, or personal data. You can disable it with `telemetryEnabled: false` in the managed configuration.

The interactive wizard does not ask for a separate deployment-context answer. `--deployment-type` is a command-line setting used for non-interactive setup and reconfiguration. It accepts `local`, `vps`, or `server` and helps infer defaults such as the extraction provider. Explicit provider flags take precedence.

For a scripted setup, use the same current command surface and choose providers explicitly:

```bash
signet setup --non-interactive \
  --name "My Agent" \
  --harness claude-code \
  --deployment-type local \
  --embedding-provider native \
  --extraction-provider none
```

Use `signet setup --help` before adapting this example for a different harness or deployment. Non-interactive setup is useful for repeatable machines, but the interactive wizard is the better first run because it exposes the choices that affect data movement and provider cost.

### What setup creates

The exact files depend on the identity mode, preset, harnesses, and optional plugins. The workspace normally contains:

```text
$SIGNET_WORKSPACE/
├── agent.yaml
├── memory/memories.db
├── harnesses/
├── skills/
├── signetai/
└── identity files when managed identity is enabled
```

`agent.yaml` is managed by Signet. Do not hand-edit it to work around a setup problem. Rerun setup or use the supported configuration command instead.

If managed identity is enabled, setup prints `/onboarding` as the next step. That command belongs to the connected harness and personalizes the agent's identity files. It is not a replacement for `signet setup`.

## Verify the first run

Check the daemon and workspace state:

```bash
signet status
```

Check the health endpoint directly when diagnosing a daemon problem:

```bash
curl -fsS http://127.0.0.1:3850/health
```

A successful response means the endpoint was reachable and reports the daemon's health state. The CLI status command also checks the configured workspace and provider state.

Open the Dashboard:

```bash
signet dashboard
```

Write a small test memory:

```bash
signet remember "The quickstart memory is ready to recall." --tags quickstart
```

Recall it through the normal hybrid search path:

```bash
signet recall "What did I save during the quickstart?" --limit 5
```

Use `--json` when another tool needs machine-readable recall output. Recall results depend on the memories and providers in your workspace, so this guide does not promise a fixed ranking or response body.

## `signet setup` and `/onboarding` are different

Use `signet setup` for installation and system configuration:

- Create or import the workspace.
- Configure harness connections and hooks.
- Choose embeddings, extraction, inference, and network behavior.
- Initialize the database and daemon.

Use `/onboarding` later from a harness that supports it for the personal interview:

- Describe how you work and what the agent should know about you.
- Refine identity and instruction files.
- Establish behavior and collaboration preferences.

Run setup first. Then run `/onboarding` when managed identity is enabled and you want to personalize the agent.

## If something goes wrong

If the daemon is not running:

```bash
signet status
signet daemon start
signet daemon logs -n 100
```

If it starts and stops again, inspect the logs before changing configuration. The health endpoint is also useful when a Dashboard connection fails:

```bash
curl -fsS http://127.0.0.1:3850/health
```

If embedding setup fails, use the built-in native provider by rerunning setup, or complete the provider's local prerequisites before retrying. For the recommended Ollama model, the expected local commands are:

```bash
ollama serve
ollama pull nomic-embed-text
```

If a provider or harness was selected incorrectly, rerun the wizard or open the supported configuration surface:

```bash
signet setup
signet configure
```

After changing daemon or provider settings, restart the daemon and check status again:

```bash
signet daemon restart
signet status
```

## Continue

- [Install](/getting-started/install/): installation choices, supported platforms, and provider prerequisites.
- [Set up Signet](/getting-started/setup/): the full configuration reference.
- [Your first session](/getting-started/first-session/): memory, secrets, skills, and Dashboard usage.
- [Operate your installation](/getting-started/operate/): logs, updates, security, and troubleshooting.
- [CLI getting started](/cli/getting-started/): command options and scripting details.
- [Claude Code](/harnesses/claude-code/), [Codex](/harnesses/codex/), [OpenCode](/harnesses/opencode/), and [OpenClaw](/harnesses/openclaw/): harness-specific setup and behavior.
