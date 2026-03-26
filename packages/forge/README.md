# Forge

Forge is Signet’s terminal-native AI client.

This package now lives inside the `signetai` monorepo as Signet's
first-party native harness and reference runtime implementation.

It gives you one place to chat with API providers and CLI-based models, while routing memory, identity, secrets, skills, and MCP through the Signet pipeline instead of through a host editor or plugin.

## What Forge does

- runs as a native terminal app written in Rust
- talks directly to the Signet daemon over localhost HTTP
- supports both API providers and authenticated CLI providers
- loads Signet identity and memory into the agent loop
- auto-discovers connected providers and their models
- exposes Signet skills and MCP tools inside the terminal UI

## Why Forge exists

When Signet runs inside another harness, two systems tend to compete:

- the host’s built-in memory and auth behavior
- Signet’s own memory, identity, and secret pipeline

Forge removes that split. It is the harness, so the Signet pipeline becomes the primary path instead of a sidecar integration.

## Core ideas

- **One memory system**: memory recall and storage go through Signet
- **Connected models only**: the picker shows what is actually usable
- **CLI auth counts as real auth**: existing Claude, Codex, and Gemini logins are detected
- **Signet stays the source of truth**: secrets, skills, and MCP can flow into Forge automatically

## Install

### From source

```bash
git clone https://github.com/Signet-AI/signetai.git
cd signetai/packages/forge
cargo install --path crates/forge-cli --locked
```

### Managed install via Signet

```bash
signet forge install
signet forge update
```

### Update from source

```bash
cd ~/signetai/packages/forge
git pull
cargo install --path crates/forge-cli --locked --force
```

### Binary location

Typical local install path:

```bash
~/.cargo/bin/forge
```

## Quick start

Start Forge:

```bash
forge
```

Open the auth flow:

```bash
forge --auth
```

Pick a provider directly:

```bash
forge --provider claude-cli
forge --provider codex-cli
forge --provider openai
```

Run a one-shot prompt:

```bash
forge -p "summarize this repo"
```

Resume the last session:

```bash
forge --resume
```

## Providers

Forge supports two broad provider types.

### CLI providers

- `claude-cli`
- `codex-cli`
- `gemini-cli`

Forge treats these as connected when they are actually authenticated, including persisted login state already on disk.

### API providers

- `openai`
- `anthropic`
- `google`
- `openrouter`
- `groq`
- `xai`
- `ollama`
- other OpenAI-compatible providers where configured

## Auth and model discovery

Forge discovers connectivity from multiple places:

- environment variables
- Forge local credentials
- authenticated CLI state already on disk
- Signet secrets
- Ollama availability

The model picker is filtered to connected providers. Forge prefers Signet registry models when available, and also carries curated coverage for supported CLI model families.

For the full auth and model behavior, see [docs/AUTH_AND_MODELS.md](docs/AUTH_AND_MODELS.md).

## Slash commands, skills, and MCP

Forge includes built-in slash commands and now also supports dynamic commands sourced from Signet.

### Built-in slash commands

Examples include:

- `/model`
- `/recall`
- `/remember`
- `/mcp`

### Dynamic Signet skill commands

Installed user-invocable Signet skills can appear automatically as:

- `/skill-name`

### Dynamic MCP commands

Installed MCP servers and tools can appear automatically as:

- `/mcp`
- `/mcp-<server-id> <tool> [json args]`
- `/mcp-<server-id>-<tool-name> [json args]`

For details, see [docs/SLASH_COMMANDS.md](docs/SLASH_COMMANDS.md).

## Signet integration

Forge is designed to work as a Signet-native client.

That includes:

- memory recall through the daemon
- transcript submission for extraction
- Signet identity loading
- Signet secret import into Forge credentials
- Signet daemon auth headers for team or hybrid modes
- Signet-backed discovery of skills and MCP tooling

See:

- [docs/MEMORY_ARCHITECTURE.md](docs/MEMORY_ARCHITECTURE.md)
- [docs/AUTH_AND_MODELS.md](docs/AUTH_AND_MODELS.md)
- [docs/SLASH_COMMANDS.md](docs/SLASH_COMMANDS.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Useful commands

```bash
forge
forge --auth
forge --auth --auth-provider openai
forge --auth --auth-provider claude-cli
forge --provider codex-cli
forge --model gpt-5.4
forge --resume
forge --theme midnight
forge --signet-token <token>
forge --signet-actor my-agent
```

## Key bindings

Common defaults:

- `Ctrl+O` model picker
- `Ctrl+K` command palette
- `Ctrl+G` Signet command picker
- `Ctrl+D` dashboard
- `Ctrl+H` session browser
- `Ctrl+B` keybind editor
- `Ctrl+Q` quit

## Docs

- [docs/AUTH_AND_MODELS.md](docs/AUTH_AND_MODELS.md)
- [docs/MEMORY_ARCHITECTURE.md](docs/MEMORY_ARCHITECTURE.md)
- [docs/SLASH_COMMANDS.md](docs/SLASH_COMMANDS.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [changelogs/README.md](changelogs/README.md)

## Status

Forge is under active development. The current direction is:

- stronger Signet-native auth and model discovery
- better CLI-provider support
- dynamic skills and MCP surfaced directly in the terminal
- less duplicated config between Forge and Signet
