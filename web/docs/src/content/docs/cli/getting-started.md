---
title: "Install and configure"
description: "Install Signet and use the setup, configure, desktop, index, and GraphIQ commands."
---

## Installation

```bash
# direct native binary
curl -fsSL https://signetai.sh/install.sh | bash

# npm wrapper for the same compiled Signet binary
npm install -g signetai

# Bun wrapper for the same compiled Signet binary
bun add -g signetai
```

All three install paths install the same compiled Signet binary. The npm and
Bun paths install the `signetai` wrapper plus a platform native package tarball
from the same GitHub release. Install scripts only link the native binary into
place; if scripts are disabled, the wrapper resolves the native package
directly. They do not install Bun, rebuild Signet, or install daemon
dependencies.
Published native binaries currently cover Linux x64, Linux arm64, macOS x64,
macOS arm64, and Windows x64. Windows direct installs should use
`npm install -g signetai`; the old PowerShell `install.ps1` path has been
removed until a native Windows direct installer ships.

---

## Commands Overview

| Command | Description |
|---------|-------------|
| `signet` | Show help, examples, and command map |
| `signet setup` | First-time setup wizard |
| `signet configure` | Interactive config editor (`signet config` alias) |
| `signet status` | Show daemon and agent status |
| `signet doctor` | Run local health checks |
| `signet doctor hermes` | Check Hermes Agent plugin freshness, config activation, and tool routing |
| `signet route` | Inspect and control inference routing |
| `signet dashboard` | Open web UI in browser |
| `signet daemon` | Grouped daemon subcommands |
| `signet desktop` | Build and install the Electron desktop app from source |
| `signet daemon start` | Start the daemon |
| `signet daemon stop` | Stop the daemon |
| `signet daemon restart` | Restart the daemon |
| `signet daemon logs` | View daemon logs |
| `signet remember` | Save a memory |
| `signet recall` | Search memories |
| `signet index` | Index a project with GraphIQ and make it active code context |
| `signet export` | Export a portable bundle (identity, memories, skills) |
| `signet export transcripts` | Export session transcripts as JSONL for training/fine-tuning |
| `signet import` | Import a portable bundle |
| `signet migrate-schema` | Migrate database to unified schema |
| `signet migrate-vectors` | Migrate BLOB vectors to sqlite-vec format |
| `signet sync` | Sync hooks, extensions, built-in templates, and skills |
| `signet secret` | Manage encrypted secrets |
| `signet graphiq` | Manage the optional GraphIQ code retrieval plugin |
| `signet skill` | Manage agent skills from registry |
| `signet git` | Git sync management for $SIGNET_WORKSPACE |
| `signet hook` | Lifecycle hook commands |
| `signet update` | Check, install, and manage auto-updates |
| `signet bypass` | Per-session hook bypass toggle |
| `signet embed` | Manage memory embeddings |

---

## `signet` (No Arguments)

Shows the top-level help output with examples. This keeps the CLI safe
to call from scripts and agents without dropping into an interactive
menu.

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

  Usage: signet [options] [command]

  Examples:
    signet setup
    signet status
    signet doctor
    signet doctor hermes
    signet daemon start
    signet remember "Nicholai prefers command-first CLIs"
```

Use explicit commands for interactive flows:

- `signet setup` — initialize or migrate a workspace
- `signet configure` — edit agent settings interactively
- `signet doctor` — troubleshoot local issues
- `signet doctor hermes` — troubleshoot Hermes Agent integration issues

---

## `signet desktop`

Builds the official Electron desktop app from an existing Signet source
checkout. Without `--repo` or `SIGNET_SOURCE_DIR`, the command first syncs the
managed workspace checkout at `<workspace>/signetai`, ignoring generated desktop
build artifacts such as `surfaces/desktop/release/` so stale local artifacts do
not block fast-forward pulls. Explicit source paths are left under user
control; set `SIGNET_SOURCE_DIR` or pass `--repo <path>`. To build the checkout
you are currently in, run `signet desktop install --repo .`.

```bash
signet desktop build
signet desktop install
signet desktop install --repo .
signet desktop install --repo ~/signet/signetai
signet desktop install --skip-build
```

`signet desktop install` runs `bun install`, then `bun run build:desktop`, then
installs the newest built artifact. Linux/Arch currently installs a user-level
AppImage launcher at `~/.local/bin/signet-desktop` and a desktop entry under
`~/.local/share/applications/signet.desktop`. macOS and Windows builds are
produced by the desktop package, with native installer automation still guarded
until those platform installers are wired.

---

## `signet setup`

Interactive first-time setup wizard (with optional non-interactive mode).
Creates the `$SIGNET_WORKSPACE/` directory and all necessary files.

```bash
signet setup
signet setup --path /custom/path
signet setup --non-interactive \
  --name "My Agent" \
  --harness claude-code \
  --identity-preset minimal \
  --deployment-type vps \
  --embedding-provider native
```

Options:

| Option | Description |
|--------|-------------|
| `-p, --path <path>` | Custom base path (default: `$SIGNET_WORKSPACE`) |
| `--non-interactive` | Run setup without prompts |
| `--name <name>` | Agent name in non-interactive mode |
| `--description <description>` | Agent description in non-interactive mode |
| `--deployment-type <type>` | Deployment context (`local`, `vps`, `server`) used for interactive guidance and non-interactive inferred defaults |
| `--harness <harness>` | Repeatable/comma-separated harness list (`claude-code`, `opencode`, `openclaw`, `hermes-agent`, `oh-my-pi`, `pi`, `codex`, `gemini`) |
| `--identity-preset <preset>` | Identity/context preset (`minimal`, `hermes`, `openclaw`, `custom`); controls startup-loaded files and special prompt files like `DREAMING.md` |
| `--embedding-provider <provider>` | Non-interactive embedding provider (`ollama`, `openai`, `native`, `none`) |
| `--embedding-model <model>` | Non-interactive embedding model |
| `--extraction-provider <provider>` | Non-interactive extraction provider (`claude-code`, `codex`, `ollama`, `opencode`, `openrouter`, `openai-compatible`, `none`) |
| `--extraction-model <model>` | Non-interactive extraction model |
| `--extraction-endpoint <url>` | Non-interactive extraction endpoint for OpenAI-compatible providers |
| `--search-balance <alpha>` | Non-interactive search alpha (`0-1`) |
| `--openclaw-runtime-path <mode>` | Non-interactive OpenClaw mode (`plugin`, `legacy`) |
| `--configure-openclaw-workspace` | Patch discovered OpenClaw configs to `$SIGNET_WORKSPACE` |
| `--open-dashboard` | Open dashboard after non-interactive setup |
| `--skip-git` | Skip git initialization/commits in non-interactive mode |
| `--disable-signet-secrets` | Leave the bundled Signet Secrets core plugin installed but disabled |
| `--with-graphiq` | Install and enable the optional verified GraphIQ code retrieval plugin |
| `--disable-graphiq` | Leave the optional GraphIQ plugin disabled |
| `--create-local-backup` | If OpenClaw points at this workspace and no origin exists, create a local snapshot automatically |
| `--allow-unprotected-workspace` | Explicitly allow setup to finish without origin or snapshot in non-interactive mode |

Non-interactive behavior:

- setup method: create new identity (no GitHub import)
- provider flags are optional; setup infers defaults from `--deployment-type`
- `--identity-preset` defaults to `minimal` for new workspaces
- the Minimal preset creates `AGENTS.md` for startup context and `DREAMING.md`
  for dreaming sessions; `DREAMING.md` is not loaded into normal startup context
- hooks/connectors are configured for requested harnesses
- with `--deployment-type vps`, setup prefers non-local extraction defaults
  from selected harnesses when those tools are available locally, then other
  detected tooling (`claude-code`, `codex`, `opencode`), and falls back to
  `none` when needed
- for existing-identity migration, previously configured extraction providers
  are preserved unless `--extraction-provider` is explicitly passed
- the bundled Signet Secrets core plugin is enabled by default; pass
  `--disable-signet-secrets` to opt out while leaving it installed
- GraphIQ is optional and disabled by default; pass `--with-graphiq` to install
  it via the bundled install script (downloads from GitHub releases)
- explicit provider flags override inferred defaults
- git: enabled unless `--skip-git` is passed
- when OpenClaw points at this workspace and no `origin` remote exists, setup
  requires either backup creation (`--create-local-backup`) or explicit bypass
  (`--allow-unprotected-workspace`)
- snapshot-backed protection is treated as "fresh" for 7 days; after that,
  status/doctor warn again unless a remote origin exists or a new snapshot is made

Extraction safety note:

- intended usage is `claude-code` on Haiku, `codex` on gpt-5.4-mini with a
  Pro/Max subscription, or local `ollama` with at least `qwen3:4b`
- with `--deployment-type vps`, setup avoids defaulting to local `ollama`
  extraction and prefers non-local providers
- set `--extraction-provider none` on a VPS if you do not want
  background extraction
- remote API extraction can create extreme usage fees fast

Wizard steps:

1. **Agent Name** - What to call your agent
2. **Harnesses** - Which AI platforms you use:
   - Claude Code (Anthropic CLI)
   - Codex
   - OpenCode
   - OpenClaw
   - Oh My Pi
   - Pi
   - Hermes Agent
3. **OpenClaw Workspace** - Appears only when an existing OpenClaw config
   is detected; workspace is patched only if you opt in, and setup warns
   that uninstalling OpenClaw can delete this workspace unless backups exist
4. **Description** - Short agent description
5. **Core Plugins** - Signet Secrets explains encrypted local storage,
   value-safe CLI/MCP/SDK access, command injection with output redaction, and
   connections to Signet's local encrypted store and compatible 1Password
   references, then asks whether to enable the bundled `signet.secrets` plugin
6. **Optional Code Retrieval** - GraphIQ explains fast local codebase indexing,
   structural context, constants, and blast-radius tools, then asks whether to
   install the verified managed `signet.graphiq` plugin
7. **Deployment Context** - Where Signet is running (`local`, `vps`, `server`)
   to show environment-aware guidance before extraction provider selection
8. **Embedding Provider**:
   - Built-in (recommended, no setup required)
   - Ollama (local)
   - OpenAI API
   - Skip embeddings
9. **Embedding Model** - Based on provider:
   - Built-in: `nomic-embed-text-v1.5`
   - Ollama: `nomic-embed-text`, `all-minilm`, `mxbai-embed-large`
   - OpenAI: text-embedding-3-small, text-embedding-3-large
   - Ollama selections run preflight checks for binary availability,
     service health, and model presence; if checks fail, setup offers
     retry, switch to built-in embeddings, switch to OpenAI, or
     continue without embeddings
10. **Search Balance** - Semantic vs keyword weighting
11. **Advanced Settings** (optional):
   - `top_k` - Search candidates per source
   - `min_score` - Minimum search score threshold
   - `session_budget` - Context character limit
   - `decay_rate` - Memory importance decay
12. **Import** - Optionally import from another platform
13. **Git** - Initialize version control
14. **Launch Dashboard** - Open web UI

What gets created:

```
$SIGNET_WORKSPACE/
├── agent.yaml           # Configuration
├── AGENTS.md            # Agent identity
├── MEMORY.md            # Working memory
├── memory/
│   ├── memories.db      # SQLite database
│   └── scripts/         # Memory tools
├── harnesses/
├── hooks/               # OpenClaw hooks (if selected)
│   └── agent-memory/
└── .daemon/
    ├── plugins/         # Bundled core plugin registry
    └── logs/
```

If harnesses are selected, their configs are also created:

- **Claude Code**: `~/.claude/settings.json` with hooks, `~/.claude/CLAUDE.md`
- **OpenCode**: `~/.config/opencode/plugins/signet.mjs` plugin, `~/.config/opencode/AGENTS.md`
- **OpenClaw**: `$SIGNET_WORKSPACE/hooks/agent-memory/` hook directory
- **Codex**: wrapper installed at `~/.config/signet/bin/codex` with session hooks

---

## `signet configure`

Interactive configuration editor for modifying `$SIGNET_WORKSPACE/agent.yaml`.

```bash
signet configure
signet config      # Alias
```

Sections:

1. **Agent identity** - Name and description
2. **Harnesses** - AI platform selection
3. **Embedding provider** - Ollama/OpenAI settings
4. **Search settings** - Alpha, top_k, min_score
5. **Memory settings** - Session budget, decay rate
6. **View current config** - Display agent.yaml contents

Changes are saved to `agent.yaml` immediately.

---

## `signet index <path>`

Thin wrapper around `graphiq index <path>`. The command installs GraphIQ if it
is missing, indexes the project into `<path>/.graphiq/`, enables the managed
`signet.graphiq` plugin, and records that path as Signet's active code project.

```bash
signet index ~/signet/signetai
signet index . --no-install
```

The GraphIQ index stays outside Signet memory and the main Signet database.
Signet only stores plugin state and the active project pointer under
`$SIGNET_WORKSPACE/.daemon/graphiq/state.json`.

---

## `signet graphiq`

Manage the optional verified GraphIQ code retrieval plugin.

| Command | Description |
|---------|-------------|
| `signet graphiq install` | Install GraphIQ from GitHub releases via script and enable the plugin |
| `signet graphiq status` | Show GraphIQ status for the active indexed project |
| `signet graphiq doctor` | Diagnose the active GraphIQ index |
| `signet graphiq upgrade-index` | Rebuild stale artifacts for the active project |
| `signet graphiq uninstall` | Disable Signet's GraphIQ integration and keep project indexes |
| `signet graphiq uninstall --purge-indexes` | Disable integration and delete known `.graphiq/` directories |

GraphIQ is maintained as a managed plugin by `aaf2tbz`, but remains optional
and is not installed during setup unless the user opts in.

---
