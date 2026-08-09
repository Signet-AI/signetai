---
title: "Set up Signet"
description: "Run the setup wizard and understand the workspace it creates."
---

## Setup Wizard

The wizard asks a series of questions:

**1. Agent name**

Pick a name for your agent — this appears in harness prompts and the
dashboard.

**2. Harnesses**

Select which AI platforms you use. Signet will configure integrations
for each:

- Claude Code — hooks + CLAUDE.md sync
- OpenCode — plugin + AGENTS.md sync
- OpenClaw — adapter-openclaw hooks
- Codex — wrapper install + session hooks

**3. Agent description**

Add a short description of your agent. This is used in generated identity
metadata and dashboard summaries.

**4. Core plugins**

Signet Secrets stores reusable credentials outside chat, memory, logs, and
source files. It connects to Signet's encrypted local store and compatible
1Password references, then exposes value-safe CLI, MCP, and SDK helpers plus
command injection with output redaction. This is safer than pasting API keys
into prompts because agents can list secret names and run commands with
injected values without reading the raw secrets.

**5. Optional code retrieval**

GraphIQ can index active projects into each project's local `.graphiq/`
directory and expose generic code retrieval tools through Signet. Use it when
you want fast symbol search, structural context, constants, and blast-radius
analysis alongside Signet memory retrieval.

After setup, index a project with:

```bash
signet index ~/signet/signetai
```

That path becomes the active code project for GraphIQ-backed MCP tools until
another `signet index <path>` command changes it.

**6. Deployment context**

Choose where Signet is running (`local`, `vps`, `server`). Setup uses
this to show guidance before extraction provider selection.

**7. Embedding provider**

Embeddings power semantic (meaning-based) memory search. Choose:

- **Built-in** (recommended) — no extra setup required.
- **Ollama** — runs locally, free, no API key needed.
  Setup checks your binary, service, and model, and guides install/pull
  when needed.
- **OpenAI** — uses the OpenAI embeddings API. Requires `OPENAI_API_KEY`.
- **Skip** — memory still works via keyword search, just no semantic search.

**8. Embedding model**

For Ollama, `nomic-embed-text` is a good default. Setup can pull it for
you (with confirmation), or you can do it manually:

```bash
ollama pull nomic-embed-text
```

**9. Search balance**

The `alpha` setting controls how much weight goes to semantic vs. keyword
search. 0.7 (70% semantic, 30% keyword) works well for most people.

**9. Git & auto-commit**

The wizard can initialize a git repo in `$SIGNET_WORKSPACE/` so every change to
your agent files is automatically versioned.

Setup also clones a managed Signet source checkout into
`$SIGNET_WORKSPACE/signetai/`. Future `signet update` and `signet sync`
operations fetch the latest upstream changes, but they only auto-pull when that
checkout is clean and still sitting on the default branch. If you are hacking on
the internals locally, Signet fetches and leaves your changes alone.

After the wizard completes, the [Daemon](/daemon/) starts automatically and the
[Dashboard](/dashboard/) opens at `http://localhost:3850`.

---

## What Gets Created

```
$SIGNET_WORKSPACE/
├── agent.yaml           # Your config & manifest
├── AGENTS.md            # Agent identity & instructions
├── SOUL.md              # Personality & tone
├── MEMORY.md            # Generated working memory (starts empty)
├── memory/
│   ├── memories.db      # SQLite memory database
│   └── scripts/         # Optional batch tools (memory.py)
├── signetai/            # Managed local Signet source checkout for debugging
├── skills/
│   ├── remember/        # Built-in: /remember command
│   └── recall/          # Built-in: /recall command
└── .daemon/
    ├── plugins/         # Bundled core plugin registry
    └── logs/            # Daemon logs
```

If you selected Claude Code:
- `~/.claude/CLAUDE.md` — auto-synced from AGENTS.md
- `~/.claude/settings.json` — hooks for session start/end

If you selected OpenCode:
- `~/.config/opencode/AGENTS.md` — auto-synced
- `~/.config/opencode/plugins/signet.mjs` — bundled plugin with remember/recall tools

---
