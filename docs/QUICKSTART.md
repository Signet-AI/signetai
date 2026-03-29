---
title: "Quickstart"
description: "Get Signet running in about five minutes."
order: 1
section: "Getting Started"
---

Quickstart
===

Get Signet running in about five minutes. For the full
[[configuration]] reference, see that doc. For [[cli|CLI commands]], see
[[cli]].

---

Why Signet
---

Your agent starts every session from zero. It doesn't know what you
worked on yesterday. It doesn't know your preferences, your projects,
or the decisions you've already made together. Every session is a
first date.

The industry's answer to this has often been to give agents memory tools
— "remember this," "recall that." That's not memory. That's a filing
cabinet the agent sometimes opens. It puts the LLM in charge of
micromanaging what to store and when to retrieve it.

Signet takes a different approach. The goal is ambient context
selection: turn interactions into durable memory substrate, then learn
what should surface automatically when the next session begins.

### The distillation layer

At the end of every conversation, Signet reviews the session and
distills it. A local LLM breaks the conversation into atomic facts,
checks them against what's already known, and decides whether to add new
facts, skip duplicates, or record proposals for more complex changes.
Your agent won't store "prefers dark mode" fourteen times.

### The knowledge graph

Named entities — people, projects, tools, concepts — are extracted
and linked. When you ask about a project, Signet traverses the graph:
the project's architecture, the people involved, the tools it depends
on, the constraints that apply. This structure improves the quality of
candidate context instead of treating memory as a flat pile of fragments.

### The predictive scorer

A predictive scorer can use that structured candidate pool to learn what
context is actually useful in your sessions. The aim is not just storage
or retrieval, but selecting the most helpful context automatically, with
high precision. The scorer is unique to each user. Your weights never
leave your machine.

Crucially, the system should learn from regret, not just reuse. If
injected context does not help, that should become negative evidence
instead of being silently reinforced forever.

### Retrieval

Retrieval blends graph traversal, keyword search, and semantic
similarity into a bounded candidate set, then reranks and filters it.
The constellation view in the dashboard lets you inspect the agent's
knowledge topology.

### Document ingest

Feed any document into the distillation layer. PDFs, specs, reference
pages, URLs. They're chunked, embedded, and indexed alongside your
agent's insights.

### Safety guarantees

- **Raw-first**: content is persisted before any LLM processing begins
- **Pinned insights are sacred**: the distillation layer cannot modify
  them. Only you can.
- **Everything is recoverable**: deletions are soft, with a recovery
  window and full audit trail

Automatic destructive memory mutations remain conservative and gated in
the current implementation. Explicit user/operator repair flows are the
reliable path today.

The same agent follows you across Claude Code, OpenCode, and OpenClaw.
Same personality, same knowledge, same secrets. Switch tools without
starting over.

For deeper technical details, see [[architecture]]. For the long-term
vision, see [VISION.md](../VISION.md).

---

Prerequisites
---

- Node.js 18+ (or Bun 1.0+)
- Embeddings (choose one):
  - Built-in (recommended, no extra setup)
  - Ollama (local)
  - OpenAI API key
- macOS or Linux (Windows support planned)

---

Install
---

```bash
# bun (recommended)
bun add -g signetai

# npm
npm install -g signetai

# or one-line installer
curl -sL https://signetai.sh/install | bash
```

Running `signet setup` launches an interactive wizard that walks you through
the full setup. You don't need to read anything else first. Signet records
your primary package manager during setup and reuses it for skill installs
and update commands.

For agent-driven onboarding, use non-interactive mode:

```bash
signet setup --non-interactive \
  --name "My Agent" \
  --harness claude-code \
  --deployment-type vps \
  --embedding-provider native
```

`--deployment-type` supports `local`, `vps`, or `server` and adjusts inferred
defaults when provider flags are omitted. Explicit provider flags always
override inferred defaults.

If OpenClaw is configured to use the same workspace path, setup now enforces
backup posture before finishing. In automation, either configure a git
`origin` remote ahead of time, or pass `--create-local-backup` (or
`--allow-unprotected-workspace` if you intentionally accept the risk).
Snapshot-backed protection is considered fresh for 7 days; after that, run
setup with `--create-local-backup` again or configure `origin`.

Extraction safety note:

- intended usage is Claude Code on Haiku, Codex CLI on GPT Mini with a
  Pro/Max subscription, or local Ollama with at least `qwen3:4b`
- with `--deployment-type vps`, setup prefers non-local extraction defaults
  from selected harnesses when those tools are available locally, then other
  detected tooling, and avoids defaulting to local Ollama extraction
- on a VPS, set extraction to `none` if you do not want background LLM calls
- remote API extraction can rack up extreme fees fast

---

Setup Wizard
---

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

**3. Deployment context**

Choose where Signet is running (`local`, `vps`, `server`). Setup uses
this to show guidance before extraction provider selection.

**4. Embedding provider**

Embeddings power semantic (meaning-based) memory search. Choose:

- **Built-in** (recommended) — no extra setup required.
- **Ollama** — runs locally, free, no API key needed.
  Setup checks your binary, service, and model, and guides install/pull
  when needed.
- **OpenAI** — uses the OpenAI embeddings API. Requires `OPENAI_API_KEY`.
- **Skip** — memory still works via keyword search, just no semantic search.

**5. Embedding model**

For Ollama, `nomic-embed-text` is a good default. Setup can pull it for
you (with confirmation), or you can do it manually:

```bash
ollama pull nomic-embed-text
```

**6. Search balance**

The `alpha` setting controls how much weight goes to semantic vs. keyword
search. 0.7 (70% semantic, 30% keyword) works well for most people.

**7. Git & auto-commit**

The wizard can initialize a git repo in `$SIGNET_WORKSPACE/` so every change to
your agent files is automatically versioned.

After the wizard completes, the [[daemon]] starts automatically and the
[[dashboard]] opens at `http://localhost:3850`.

---

What Gets Created
---

```
$SIGNET_WORKSPACE/
├── agent.yaml           # Your config & manifest
├── AGENTS.md            # Agent identity & instructions
├── SOUL.md              # Personality & tone
├── MEMORY.md            # Generated working memory (starts empty)
├── memory/
│   ├── memories.db      # SQLite memory database
│   └── scripts/         # Optional batch tools (memory.py)
├── skills/
│   ├── remember/        # Built-in: /remember command
│   └── recall/          # Built-in: /recall command
└── .daemon/
    └── logs/            # Daemon logs
```

If you selected Claude Code:
- `~/.claude/CLAUDE.md` — auto-synced from AGENTS.md
- `~/.claude/settings.json` — hooks for session start/end

If you selected OpenCode:
- `~/.config/opencode/AGENTS.md` — auto-synced
- `~/.config/opencode/plugins/signet.mjs` — bundled plugin with remember/recall tools

---

What Signet Does
---

Once running, Signet gives you a persistent agent identity that works
across all your AI tools. The core features:

- **[[pipeline|Memory pipeline]]** — conversations are processed automatically by
  Pipeline V2, which extracts meaningful facts and decisions using a
  configured extraction backend. The safe intended setups are Claude
  Code on Haiku, Codex on GPT Mini, or local Ollama with at least
  `qwen3:4b`. Set the extraction provider to `none` if you want Signet
  without background extraction. Memories accumulate over time and are
  recalled in future sessions.
- **Hybrid search** — recall combines semantic and keyword search so
  you find relevant memories even when phrasing varies.
- **Connectors** — platform adapters for Claude Code, OpenCode, and
  OpenClaw keep your agent config in sync across tools.
- **Analytics** — the dashboard tracks memory growth, session activity,
  and pipeline health over time.
- **Document ingest** — feed local files or URLs into the memory pipeline
  to give your agent persistent knowledge about a codebase, spec, or doc.
- **Diagnostics** — built-in health checks and pipeline status endpoints
  help you spot issues fast.
- **SDK** — embed Signet into your own apps via `@signet/sdk`.
- **Secrets** — API keys stored encrypted at rest, never exposed to agents
  directly.
- **Skills** — installable instruction packages that extend agent behavior.
- **Auth** — token-based access control for local, team, and hybrid
  deployments. See [Auth](./AUTH.md) for details.

---

Basic Usage
---

### Check status

```bash
signet status
```

Shows daemon state, file health, and memory count.

### Open the dashboard

```bash
signet dashboard
```

Opens `http://localhost:3850` in your browser. From here you can edit
your agent config, browse memories, view analytics, and manage skills.
You can also reach it directly in your browser any time the daemon is
running.

### Save a memory

Use the CLI or `/remember` command in any connected harness:

```bash
# CLI
signet remember "nicholai prefers bun over npm"
signet remember "critical memory" --critical
signet remember "tagged memory" -t project,signet

# In harness
/remember nicholai prefers bun over npm
/remember critical: never commit secrets to git
/remember [project,signet]: daemon runs on port 3850
```

The `critical:` prefix or `--critical` flag pins a memory so it never
decays. The `[tag1,tag2]:` prefix or `-t` flag adds searchable tags.

You can also let the pipeline do this automatically — at the end of a
session, Pipeline V2 reads the conversation and extracts memories on its
own. Manual `/remember` is for things you want to ensure are captured.

### Search memories

```bash
# CLI
signet recall "coding preferences"
signet recall "signet" --type decision -l 5

# In harness
/recall coding preferences
/recall signet architecture
/recall what did we decide about authentication
```

### View daemon logs

```bash
signet daemon logs
signet daemon logs -n 100
```

### Stop/start the daemon

```bash
signet daemon stop
signet daemon start
signet daemon restart
```

---

Managing Secrets
---

Store API keys and other sensitive values encrypted at rest:

```bash
# Add a secret (value is never echoed)
signet secret put OPENAI_API_KEY

# List stored secrets (names only)
signet secret list

# Remove a secret
signet secret delete GITHUB_TOKEN
```

Secrets are encrypted with libsodium using a machine-bound key. Agents
never see secret values directly.

---

Managing Skills
---

Skills are packaged instructions in `$SIGNET_WORKSPACE/skills/`. They extend
what your agent can do.

```bash
# See what's installed
signet skill list

# Search the skills.sh registry
signet skill search browser

# Install a skill
signet skill install browser-use

# Remove a skill
signet skill remove weather
```

---

Install as a System Service
---

To have Signet start automatically on boot:

```bash
cd packages/daemon
bun run install:service
```

**macOS (launchd):**
```bash
launchctl load ~/Library/LaunchAgents/ai.signet.daemon.plist
```

**Linux (systemd):**
```bash
systemctl --user enable signet.service
systemctl --user start signet.service
```

---

Editing Your Agent
---

Your agent identity lives in four self-managed files:

**`$SIGNET_WORKSPACE/AGENTS.md`** — How the agent operates, including rules,
workflow, and constraints. This is the main file that syncs to harnesses.

**`$SIGNET_WORKSPACE/SOUL.md`** — Personality, voice, values, and temperament.

**`$SIGNET_WORKSPACE/IDENTITY.md`** — Who the agent is.

**`$SIGNET_WORKSPACE/USER.md`** — Who you are to the agent, plus preferences
and relationship context.

These files are meant to be maintained over time as durable context.

**`$SIGNET_WORKSPACE/MEMORY.md`** is different. It is auto-generated by
Signet as episodic and operational memory. Do not edit it manually.

Edit the four identity files directly in your editor or via the dashboard's
config editor. Changes sync to harnesses automatically within 2 seconds.

---

Auth and Team Deployments
---

By default, Signet runs in local mode with no auth required on
requests. In the default local setup, the daemon also binds to
localhost only, which keeps that unauthenticated mode local by default.
For team deployments or self-hosted remote access, Signet supports
token-based auth with roles and scopes. See [Auth](./AUTH.md) and
[Self-Hosting](./SELF-HOSTING.md) for setup details.

---

Troubleshooting
---

**Daemon won't start**

Check if port 3850 is in use:
```bash
lsof -i :3850
```

Remove a stale PID file if needed:
```bash
rm $SIGNET_WORKSPACE/.daemon/pid
signet daemon start
```

**Embeddings not working**

Make sure Ollama is running:
```bash
ollama serve &
ollama pull nomic-embed-text
```

Or check that `OPENAI_API_KEY` is set in your environment (or stored
as a secret and referenced in `agent.yaml`).

**Changes not syncing to Claude Code**

Make sure `~/.claude/` exists and you have the harness configured:
```bash
ls ~/.claude/CLAUDE.md
signet status
```

**Dashboard not loading**

```bash
curl http://localhost:3850/health
signet daemon logs
```

---

Next Steps
---

- [Configuration Reference](./CONFIGURATION.md) — all agent.yaml options
- [Memory System](./MEMORY.md) — how remember/recall works
- [Pipeline](./PIPELINE.md) — how Pipeline V2 extracts and processes memories
- [Connectors](./CONNECTORS.md) — platform connector details
- [Hooks](./HOOKS.md) — lifecycle hooks for harness integration
- [Analytics](./ANALYTICS.md) — session and memory analytics
- [Diagnostics](./DIAGNOSTICS.md) — health checks and pipeline status
- [Documents](./DOCUMENTS.md) — ingest files and URLs into memory
- [SDK](./SDK.md) — embed Signet in your own apps
- [Auth](./AUTH.md) — token-based auth and team deployment modes
- [Harnesses](./HARNESSES.md) — detailed integration docs
- [API Reference](./API.md) — HTTP API for scripting and tooling
