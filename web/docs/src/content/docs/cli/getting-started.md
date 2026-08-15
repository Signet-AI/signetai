---
title: "Install and configure"
description: "Install Signet, run setup, choose a workspace, and configure optional code retrieval."
---

For a first local installation, use [Quickstart](/quickstart/). This page is the command reference for installation and setup automation.

## Installation

```bash
curl -fsSL https://signetai.sh/install.sh | bash
# or
npm install -g signetai
# or
bun add -g signetai

signet --help
```

Use one installation route per machine. See [Install](/getting-started/install/) for platform notes. All three installation paths provide the same compiled Signet binary through the matching native package.

## Common commands

### macOS Gatekeeper and unsigned CLI binaries

The macOS CLI binaries (`signet-darwin-x64` and `signet-darwin-arm64`) are
unsigned by design until Apple Developer signing is available. A binary
downloaded through a browser may be blocked by macOS Gatekeeper because it has
the quarantine attribute.

To open a trusted binary, right-click it in Finder and choose **Open**, or go to
**System Settings > Privacy & Security** and choose **Open Anyway** for the
blocked binary. You can also remove the quarantine attribute in Terminal:

```bash
xattr -d com.apple.quarantine <path>
```

Only bypass Gatekeeper for binaries downloaded from the official Signet source
that you trust. Verify the release and checksum first. For non-server
deployments, use the Signet desktop app instead of the CLI binary.

---

| Command | Purpose |
|---|---|
| `signet setup` | Create or reconfigure a workspace. |
| `signet workspace status` | Show the active workspace and where it was resolved from. |
| `signet workspace set <path>` | Persist and optionally migrate to a new workspace. |
| `signet configure` | Open the interactive configuration editor (`signet config` is an alias). |
| `signet status` | Show agent and daemon status. |
| `signet doctor` | Run local health checks. |
| `signet dashboard` | Open the dashboard. |
| `signet daemon start` | Start the local daemon. |
| `signet index <path>` | Index a project with optional GraphIQ retrieval. |

## `signet setup`

```bash
signet setup
signet setup --path /custom/workspace
signet setup --schema
signet setup --file ./setup-plan.json --dry-run
```

Interactive setup requires a TTY. For headless setup, choose one of these modes:

- `--non-interactive` with flags for a scripted setup or reconfiguration.
- `--file <path>` to apply a JSON setup plan.
- `--json <plan>` to apply an inline JSON setup plan.
- `--schema` to print the JSON Schema accepted by `--file` and `--json`.
- `--dry-run` to resolve and print a plan without applying it.

A `--file` or `--json` plan is for fresh setup. It does not carry credentials for an interactive provider connection. Reconfigure an existing installation with the wizard or `--non-interactive` flags.

### Identity, location, and harness flags

| Flag | Meaning |
|---|---|
| `-p, --path <path>` | Base path for agent files. |
| `--name <name>` / `--description <description>` | Agent metadata for non-interactive setup. |
| `--identity-mode managed|off` | Enable Signet-managed identity files or leave identity to the harness. |
| `--identity-preset minimal|hermes|openclaw|custom` | Startup and special-session identity-file preset. |
| `--harness <name>` | Repeatable or comma-separated harness selection. |
| `--network-mode localhost|tailscale` | Local daemon network mode in non-interactive setup. |
| `--remote-url <url>` | Use a bare remote daemon origin instead of starting a local daemon. |
| `--deployment-type local|vps|server` | Adjust non-interactive inferred defaults only. |

Current setup accepts `claude-code`, `codex`, `kimi`, `opencode`, `forge`, `openclaw`, `oh-my-pi`, `pi`, `hermes-agent`, and `gemini` harness names. Kimi uses the ACPX agent name `kimi`. For OpenClaw, `--openclaw-runtime-path plugin|legacy` selects its integration path and `--configure-openclaw-workspace` opts into patching discovered configurations.

### Inference and search flags

| Flag | Meaning |
|---|---|
| `--embedding-provider <provider>` / `--embedding-model <model>` | Configure embeddings. Validated providers are `native`, `ollama`, `openai`, and `none`. |
| `--extraction-provider <provider>` / `--extraction-model <model>` | Configure background inference. |
| `--extraction-endpoint <url>` | Endpoint for `openai-compatible` extraction. |
| `--aggregate-recall-provider`, `--aggregate-recall-model`, `--aggregate-recall-endpoint` | Configure a distinct provider for aggregate recall. |
| `--search-balance <alpha>` | Semantic/keyword balance from `0` through `1`. |
| `--enable-dreaming` | Enable background memory consolidation. |

Validated extraction providers are `acpx`, `claude-code`, `codex`, `llama-cpp`, `ollama`, `opencode`, `openrouter`, `openai-compatible`, and `none`. Explicit provider flags override defaults inferred from `--deployment-type`.

Current `signet setup --help` lists `llama-cpp` as an embedding provider, but setup validation rejects it. Use the validated embedding values above until that discrepancy is fixed.

### Automation, safety, and data flags

| Flag | Meaning |
|---|---|
| `--open-dashboard` | Open the dashboard after non-interactive setup. |
| `--skip-git` | Skip Git initialization and setup commits. |
| `--disable-signet-secrets` | Keep bundled Signet Secrets installed but disabled. |
| `--with-graphiq` / `--disable-graphiq` | Enable or leave disabled the optional GraphIQ plugin. |
| `--create-local-backup` | Create a snapshot when an OpenClaw-linked workspace lacks an origin remote. |
| `--allow-unprotected-workspace` | Explicitly bypass that OpenClaw workspace protection. |
| `--obsidian-source <path[::name]>` | Repeatably add an Obsidian vault source. |
| `--agent <name:policy[:group]>` | Repeatably add a named agent with `isolated`, `shared`, or `group` memory policy. |

## `signet workspace`

```bash
signet workspace status
signet workspace set /path/to/workspace
signet workspace set /path/to/workspace --force
signet workspace set /path/to/workspace --no-patch-openclaw
```

`workspace set` can migrate files to the target and records the persisted selection. Restart a running daemon afterward. The daemon has a different workspace resolver from the CLI today; see [CLI environment and exit codes](/cli/environment/#workspace-resolution).

## `signet configure`

```bash
signet configure
signet config
```

This opens the interactive configuration editor for the selected workspace. Use `signet setup` when you need to change onboarding, identity, daemon location, plugins, or harness selection.

## `signet index` and `signet graphiq`

```bash
signet index .
signet index . --no-install
signet graphiq status
signet graphiq doctor
```

`signet index <path>` uses GraphIQ when installed, stores the code index at `<path>/.graphiq/`, and records the active project pointer under the Signet workspace. GraphIQ is optional and does not put its complete project index into Signet memory.
