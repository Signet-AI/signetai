# Forge

Forge is Signet’s terminal-native AI client.

This package lives inside the `signetai` monorepo as Signet's first-party native harness and reference runtime implementation.

It gives you a native terminal interface for Signet-backed memory, identity, secrets, skills, MCP, and provider access without relying on editor-specific hooks or plugin patches.

## What Forge does

- runs as a native terminal app written in Rust
- talks directly to the Signet daemon over localhost HTTP
- supports API providers and supported locally authenticated CLI providers
- loads Signet identity and memory into the agent loop
- auto-discovers usable providers and models
- surfaces Signet skills and MCP tools in the terminal UI

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

Managed installs place the binary in `~/.config/signet/bin`. Add that directory to your `PATH` if you want `forge` available in a normal shell.

Managed binary downloads currently support macOS arm64, macOS x64, Linux x64, and Linux arm64. On other platforms, build Forge from source or use a local standalone install.

### Update from source

```bash
cd ~/signetai/packages/forge
git pull
cargo install --path crates/forge-cli --locked --force
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

Forge only treats these as available when the corresponding CLI and supported local auth state are both present.

### API providers

- `openai`
- `anthropic`
- `gemini`
- `openrouter`
- `groq`
- `xai`
- `ollama`
- other OpenAI-compatible providers where configured

## Auth and model discovery

Forge discovers provider availability from multiple sources:

- environment variables
- Forge local credentials
- Signet secrets
- supported local CLI auth state
- Ollama availability

The model picker is filtered to providers that are actually usable. Forge prefers Signet registry models when available and falls back to provider-specific coverage where needed.

For the current auth and model behavior, see [docs/AUTH_AND_MODELS.md](docs/AUTH_AND_MODELS.md).

## Slash commands, skills, and MCP

Forge includes built-in slash commands and supports dynamic commands sourced from Signet.

Examples include:

- `/model`
- `/recall`
- `/remember`
- `/mcp`
- `/skill-name`

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

- [docs/AUTH_AND_MODELS.md](docs/AUTH_AND_MODELS.md)
- [docs/SLASH_COMMANDS.md](docs/SLASH_COMMANDS.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Useful commands

```bash
forge
forge --auth
forge --auth --auth-provider openai
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
- [docs/SLASH_COMMANDS.md](docs/SLASH_COMMANDS.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [changelogs/README.md](changelogs/README.md)

## Status

Forge is under active development. Current priorities include:

- stronger Signet-native auth and model discovery
- better supported CLI-provider coverage
- dynamic skills and MCP surfaced directly in the terminal
- less duplicated config between Forge and Signet
