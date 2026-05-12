# Signet Native Bundle

Self-contained Signet installer with zero prerequisites.

## Quick Install

```bash
curl -fsSL https://signetai.sh/install.sh | bash
```

## What This Does

1. Detects your platform (macOS ARM64/x64, Linux ARM64/x64)
2. Downloads pre-built components (Bun, Node.js, CLI, daemon, dashboard, skills)
3. Installs to `~/.signet/`
4. Adds `signet` to your PATH
5. Runs setup wizard and starts the daemon

No need to install Bun, Node.js, or anything else manually.

## Install Options

```bash
# Skip daemon start
SIGNET_NO_START=1 curl -fsSL https://signetai.sh/install.sh | bash

# Skip setup wizard
SIGNET_NO_SETUP=1 curl -fsSL https://signetai.sh/install.sh | bash

# Custom install location
SIGNET_INSTALL_DIR=/opt/signet curl -fsSL https://signetai.sh/install.sh | bash

# Skip PATH modification
SIGNET_NO_PATH=1 curl -fsSL https://signetai.sh/install.sh | bash
```

## Uninstall

```bash
bash ~/.signet/deploy/bundle/uninstall.sh
```

Add `--purge` to also remove user data at `~/.agents/`.

## Update

```bash
signet update
```

Downloads only the components that changed since your last install.

## Architecture

Each component is built as an independent `tar.gz` by CI. When source files change,
only the affected component is rebuilt. The manifest tracks versions and checksums
per-component for incremental updates.

### Components

| Component | Description | Platform-Specific |
|-----------|-------------|-------------------|
| `bun` | Bun runtime (for daemon) | Yes |
| `node` | Node.js runtime (for CLI) | Yes |
| `cli` | CLI command bundle | No |
| `daemon-js` | Daemon JS bundle | No |
| `daemon-rs` | Rust daemon binary | Yes |
| `predictor` | Predictive memory scorer | Yes |
| `dashboard` | Web UI static files | No |
| `connectors` | Harness integration bundles | No |
| `plugin-opencode` | OpenCode plugin | No |
| `plugin-oh-my-pi` | Oh My Pi extension | No |
| `native` | NAPI native module | Yes |
| `skills` | Built-in skills | No |
| `templates` | Config templates | No |

### Installed Layout

```
~/.signet/
├── bin/
│   ├── signet           # Main CLI wrapper
│   ├── signet-daemon    # Daemon wrapper
│   └── signet-mcp       # MCP wrapper
├── runtime/
│   ├── bun/bun
│   ├── node/bin/node
│   ├── cli/cli.js
│   ├── daemon-js/
│   ├── daemon-rs/
│   ├── predictor/
│   ├── dashboard/
│   ├── connectors/
│   ├── plugins/
│   ├── native/
│   ├── skills/
│   └── templates/
├── manifest.json
└── VERSION
```
