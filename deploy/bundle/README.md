# Signet Native Bundle

Self-contained Signet installer with zero prerequisites.

## Quick Install

```bash
curl -fsSL https://signetai.sh/install.sh | bash
```

## What This Does

1. Detects your platform (macOS ARM64/x64, Linux ARM64/x64)
2. Downloads pre-built components (Node.js, CLI, daemon, dashboard, skills)
3. Installs to `~/.signet/`
4. Adds `signet` to your PATH
5. Launches the interactive setup wizard when a terminal is available
6. Starts the daemon after setup creates `agent.yaml`

No need to install Node.js or anything else manually.

## Install Options

```bash
# Skip daemon start
curl -fsSL https://signetai.sh/install.sh | SIGNET_NO_START=1 bash

# Show installer and agent setup options
curl -fsSL https://signetai.sh/install.sh | bash -s -- --help

# Install only; run setup later
curl -fsSL https://signetai.sh/install.sh | SIGNET_SETUP_MODE=skip bash

# Agent-driven setup with explicit choices
curl -fsSL https://signetai.sh/install.sh | bash -s -- -- \
  --name Agent \
  --harness codex \
  --deployment-type local \
  --embedding-provider native \
  --extraction-provider codex

# Custom install location
curl -fsSL https://signetai.sh/install.sh | SIGNET_INSTALL_DIR=/opt/signet bash

# Skip PATH modification
curl -fsSL https://signetai.sh/install.sh | SIGNET_NO_PATH=1 bash
```

## Uninstall

```bash
~/.signet/bin/signet-uninstall
```

Add `--purge` to also remove user data at `~/.agents/`.

## Update

```bash
~/.signet/bin/signet-update
```

Downloads only the components that changed since your last install.

## Architecture

Each component is built as an independent `tar.gz` by CI. The manifest
tracks versions and checksums per-component so the updater only downloads
what changed since the last install.

### Components

| Component | Description | Platform-Specific |
|-----------|-------------|-------------------|
| `node` | Node.js runtime | Yes |
| `cli` | CLI command bundle | No |
| `daemon-js` | Daemon JS bundle with Node runtime dependencies, ONNX Runtime, and sqlite-vec | Yes |
| `daemon-rs` | Rust daemon binary | Yes |
| `dashboard` | Web UI static files | No |
| `connectors` | Harness integration bundles | No |
| `plugin-opencode` | OpenCode plugin | No |
| `plugin-oh-my-pi` | Oh My Pi extension | No |
| `plugin-pi` | Pi extension | No |
| `native` | NAPI native module | Yes |
| `skills` | Built-in skills | No |
| `templates` | Config templates | No |

### Installed Layout

```
~/.signet/
├── bin/
│   ├── signet           # Main CLI wrapper
│   ├── signet-daemon    # Daemon wrapper
│   ├── signet-mcp       # MCP wrapper
│   ├── signet-uninstall # Uninstaller
│   └── signet-update    # Incremental updater
├── runtime/
│   ├── node/bin/node
│   ├── cli/cli.js
│   ├── daemon-js/
│   ├── daemon-rs/
│   ├── dashboard/
│   ├── connectors/
│   ├── plugins/
│   ├── native/
│   ├── skills/
│   └── templates/
├── manifest.json
└── VERSION
```
