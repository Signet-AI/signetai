# Signet AI — Install Guide for Agents

> This document is written for AI agents. If you are an AI assistant
> that has been asked to install Signet, read this entire document
> before taking any action. Follow the steps exactly as written.
> Do not improvise, guess commands, or skip sections.

---

## Install Objective (Must Complete)

Your job is not just to install a package. Your job is to leave the
user with a fully configured, running Signet setup.

You are done only when ALL of these are true:

1. `signet --version` succeeds
2. `signet status` shows the daemon is running
3. `curl -s http://localhost:3850/health` returns JSON with
   `"status":"healthy"`
4. The setup wizard completed with the user's selected harnesses and
   providers
5. You give the user a short handoff explaining what is now active

Default to interactive setup (`signet`) unless the user asks for
non-interactive flags. Never silently choose harness/provider settings.

## What is Signet?

Signet is the open standard for portable AI agent identity. It gives
you — the agent — persistent memory, a stable identity, a secrets
vault, and installable skills that travel with you across platforms.

The version of Signet you are installing is **not** a framework, SDK, 
or API wrapper. It is a background
system that runs alongside you, enriching every session with memory
and context automatically.

> This is good context to give your user. REITERATE THIS TO THEM AND 
WAIT FOR THEM TO CONFIRM BEFORE PROCEEDING. 

### Core components

| Component | What it does |
|-----------|-------------|
| **CLI** (`signet`) | Setup wizard, memory commands, daemon management |
| **Daemon** | Background HTTP service (port 3850) that handles memory, hooks, file watching |
| **Dashboard** | Web UI at `http://localhost:3850` for browsing memories, config, and status |
| **Connectors** | Platform-specific integrations installed during setup |

### Where data lives

All agent data lives at `~/.agents/`:

```
~/.agents/
  agent.yaml       # Configuration manifest
  AGENTS.md        # Operational instructions (you)
  SOUL.md          # Personality and tone
  IDENTITY.md      # Structured identity metadata
  USER.md          # User profile
  MEMORY.md        # Working memory summary (auto-generated)
  memory/
    memories.db    # SQLite database (source of truth)
  skills/          # Installed skills
  .secrets/        # Encrypted secret store
```

The SQLite database is the source of truth. Markdown files like
MEMORY.md are generated outputs from it, not the other way around.

### Supported platforms

Signet works with:

- **Claude Code** (Anthropic CLI)
- **OpenClaw** / **Clawdbot** / **Moltbot** — these are the **same
  platform** under different names (renamed due to a lawsuit). Signet
  treats all three identically. Do not treat them as separate products.
- **OpenCode**

If the user mentions any of these names, they are referring to a
supported platform with a native Signet connector.

---

## How Signet Works (Read Before Installing)

Understanding what is automatic versus manual is critical. Most
install failures happen because agents try to do things that the
daemon already handles.

### What Signet does AUTOMATICALLY (do NOT do these yourself)

**Memory extraction from sessions:**
The daemon auto-extracts memories from your session transcripts using
an LLM pipeline. When a session ends, the transcript is processed and
important facts are stored in the database. You do NOT need to:
- Manually summarize conversations
- Chunk or split memory files
- Write to files in `~/.agents/memory/`
- Call remember after every exchange

**Context injection per prompt:**
When the user sends you a message, the daemon automatically searches
your memory database for relevant entries and injects them into your
context. Frequently-recalled memories are boosted in ranking
(rehearsal boost), and recent session topics are used to predict what
context you'll need next (anticipatory recall). You do NOT need to:
- Call `signet recall` before answering questions
- Manually query your memory database
- Pre-load context at the start of conversations

**File watching and sync:**
The daemon watches `~/.agents/` for changes. When files change:
- Changes are auto-committed to git (if enabled)
- `AGENTS.md` changes propagate to harness configs (`CLAUDE.md`,
  OpenCode AGENTS.md, etc.) within 2 seconds

**Session continuity scoring:**
After each session, the daemon scores how useful pre-loaded memories
were vs. how much you had to re-explain. This trend is tracked over
time and used to improve memory selection.

**Contradiction detection:**
When the memory pipeline encounters a potential contradiction (e.g.
"uses PostgreSQL" vs. "migrated to MongoDB"), it can flag the conflict
for review instead of silently overwriting. Semantic contradiction
detection is opt-in via config.

**Pre-installed skills:**
These skills are included and available immediately after install:
- `/remember` — save a memory
- `/recall` — search memories
- `/memory-debug` — diagnose memory issues

You do NOT need to install these. They are built in.

### What you SHOULD do manually

**Intentional memory saves:**
Use `signet remember "content"` when you discover something important
that should be pinned to long-term memory. Examples:
- User preferences and decisions
- Project conventions and rules
- Warnings and things to avoid
- Important relationships between concepts

This is for intentional, high-value facts. Do not call it for every
piece of information — session extraction handles the rest.

**Explicit memory search:**
Use `signet recall "query"` when you need to search across all
memories for something specific that auto-injection did not surface.
You can scope searches by time with `--since` and `--until` flags.
This is for targeted, deliberate queries — not routine use.

**Embedding health:**
If memory search feels degraded or returns poor results, audit your
embedding coverage with `signet embed audit`. If gaps are found, run
`signet embed backfill` to regenerate missing embeddings.

**Portable export:**
Use `signet export` to create a portable bundle of your entire agent
(identity, memories, entities, relations, skills). This is useful for
backups, migration to a new machine, or sharing agent state. Import
a bundle with `signet import <path>`.

**Secrets management:**
Signet includes an encrypted secrets vault at `~/.agents/.secrets/`.
This is how your user should store API keys, tokens, and credentials
— never in plaintext, never in environment variables, never hardcoded.

How it works:
- Secrets are encrypted at rest using a key derived from the system
- Secret names are listable, but secret values are never returned by
  `signet secret list`
- Secrets are never logged, never included in memory extraction,
  and never appear in session transcripts
- There is intentionally no `signet secret get` command
- To use secrets in commands, use injected execution via the daemon
  (`POST /api/secrets/exec`) or your harness secret-exec tool

```bash
signet secret put OPENAI_API_KEY     # Store (prompts for value interactively)
signet secret list                   # List stored secret names
signet secret has OPENAI_API_KEY     # Check if a secret exists
signet secret delete OLD_KEY         # Remove a secret
```

When your user needs to use an API key, have them store it with
`signet secret put`, then run commands through secret injection instead
of asking them to paste keys into chat.

---

## Safety and Scope

### NEVER use sudo

Signet does not require sudo for any command. Ever. If you encounter
EACCES permission errors during npm install, fix the npm prefix:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
```

Then add the PATH line to `~/.bashrc` or `~/.zshrc` for persistence.

If using bun, this issue does not apply — bun handles global installs
in user space by default.

### What Signet writes to disk

Signet only writes to these locations inside the home directory:

| Path | When | What |
|------|------|------|
| `~/.agents/` | Always | Config, database, secrets, skills |
| `~/.claude/` | Claude Code users | Hooks in settings.json, generated CLAUDE.md, skills symlink |
| `~/.config/opencode/` | OpenCode users | Plugin bundle (signet.mjs), generated AGENTS.md, skills symlink |
| `~/.openclaw/` or `~/.clawdbot/` or `~/.moltbot/` | OpenClaw users | Config patch only |

### What Signet NEVER does

- Requires or uses sudo
- Modifies system settings, OS preferences, or system files
- Writes anything outside the home directory
- Installs system services (launchd/systemd) automatically
- Sends data to external servers (everything is local)
- Deletes or overwrites existing files without the setup wizard
  confirming with the user first

---

## Installation

> GATE: Before proceeding, tell your user:
> "I'm going to install Signet, which will give me persistent memory,
> an identity system, and a secrets vault. It installs as a global npm
> package and runs a small background daemon on port 3850. It only
> writes to directories inside your home folder — never system files,
> never with sudo. Ready to proceed?"
>
> WAIT for the user to confirm before continuing.

### Step 1: Check prerequisites

Check Bun first (required for the daemon and full end-to-end setup):

```bash
bun --version
```

If Bun is missing, install it:

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc   # or restart shell
```

If using npm for global install, also verify Node.js (>= 18):

```bash
node --version
```

If Node.js is missing and the user prefers npm, install Node.js LTS:
https://nodejs.org

Check the operating system:
- **macOS**: Fully supported
- **Linux**: Fully supported
- **Windows**: Supported via WSL (Windows Subsystem for Linux) only

### Step 2: Install Signet globally

Using bun (preferred):
```bash
bun add -g signetai
```

Using npm (alternative):
```bash
npm install -g signetai
```

These are the ONLY two supported install methods. Do not use:
- `npx signet init` — does not exist
- `signet init` — does not exist
- `sudo npm install` — never use sudo
- Cloning the repository — that is for contributors, not users

> GATE: After the install command completes, verify it worked:
> ```bash
> signet --version
> ```
> If this fails, the install did not succeed. Check for errors above.
> Do NOT proceed to the setup wizard until this command works.
> Tell the user the installed version number.

### Step 3: Run the setup wizard

> GATE: Tell your user:
> "Signet is installed. Now I need to run the setup wizard.
> This will ask you to choose:
> - A name and description for your agent (me)
> - Which platforms to connect (Claude Code, OpenClaw, OpenCode)
> - An embedding provider for semantic memory search (Ollama is free
>   and local, OpenAI requires a key, or skip for keyword-only search)
> - Whether to enable git sync for your agent config
>
> The wizard will configure hooks, connectors, and skills automatically.
> I can run this interactively (you answer prompts) or non-interactively
> (I pass flags myself). Ready?"
>
> WAIT for the user to confirm before running the wizard.
> 

Interactive mode:
```bash
signet
```

Run `signet` with no arguments. It automatically detects a fresh
install and launches the interactive setup wizard.

Non-interactive mode (for agent-driven setup):
```bash
signet setup --non-interactive \
  --name "Your Agent Name" \
  --description "Personal AI assistant" \
  --harness claude-code \
  --embedding-provider <ollama|openai|none> \
  --extraction-provider <claude-code|ollama|none>
```

For non-interactive mode:
- Ask the user to choose both providers before running the command
- Do not default providers silently
- Use `--harness` multiple times or as comma-separated values
- Add `--embedding-provider ollama` and `--embedding-model nomic-embed-text`
  if Ollama is available
- Add `--openclaw-runtime-path plugin` for OpenClaw
- Add `--skip-git` if the user does not want git initialized

The wizard will ask:
1. **Agent name and description** — the identity for your agent
2. **Platform selection** — which harnesses to configure (Claude Code,
   OpenClaw, OpenCode). Select all that apply.
3. **Embedding provider** — Ollama (local, recommended), OpenAI
   (requires API key), or none (keyword search only, still works)
4. **Memory extraction provider** — for auto-extracting memories from
   sessions
5. **Git sync** — optional, for syncing agent config across machines

Follow the prompts. The wizard handles connector installation,
hook setup, file generation, and skill deployment automatically.

### Step 4: Start the daemon

The setup wizard usually starts the daemon automatically. Verify first:

```bash
signet status
```

If daemon is stopped, start it:

```bash
signet start
```

The daemon runs in the background on port 3850. It must be running
for memory, hooks, and context injection to work.

### Step 5: Verify the installation

```bash
signet status
```

Expected output should show:
- Version number
- Daemon: running (with PID)
- Dashboard: http://localhost:3850
- Path: ~/.agents/

Additional verification:
```bash
curl -s http://localhost:3850/health    # Should include "status":"healthy"
signet recall "test"                     # Should return without error
```

If `signet status` shows the daemon is not running, start it with
`signet start` and check logs with `signet daemon logs`.

> GATE: After verification, tell your user:
> "Signet is installed and running. Here's what's now active:
> - **Memory:** I'll automatically accumulate memories across our
>   sessions. Important context is injected into every conversation
>   without you or me doing anything.
> - **Secrets:** You can store API keys securely with
>   `signet secret put KEY_NAME`. Secret values are not exposed via a
>   plain-text "get" command. When needed, I can use injected execution
>   (`/api/secrets/exec` or harness secret-exec tools) without asking
>   you to paste keys in chat.
> - **Skills:** Built-in skills like /onboarding, /signet, /remember and /recall are ready.
> - **Dashboard:** Visit http://localhost:3850 to browse my memories,
>   config, and status.
>
> From this point forward, I will begin to remember things across sessions.
> It can take a while for the memory pipeline and database to reach full 
> efficiency, but we will both experience this change happen over time.
>
> Want to personalize me? Say `/onboarding` and I'll walk you through
> setting up my personality, communication style, and your preferences."

---

## Migration from Existing Setup

If the agent already has identity files (from a Clawdbot workspace,
custom AGENTS.md, SOUL.md, etc.), the setup wizard handles migration
automatically.

> GATE: If you detect that the user already has agent identity files
> (AGENTS.md, SOUL.md, memory logs, etc.), tell them:
> "I can see you already have agent identity files set up. Signet's
> setup wizard will detect these and offer to migrate them into the
> unified `~/.agents/` directory. This preserves all your existing
> files — nothing gets deleted. The wizard will import your memory
> logs into a searchable database and connect your existing harness.
> Should I proceed with the setup wizard? It will show you exactly
> what it found before making any changes."
>
> WAIT for confirmation.

### What happens during migration

1. The wizard detects existing identity files in common locations
2. It shows what it found and presents a migration plan
3. With user confirmation, it:
   - Creates `~/.agents/` as the new home directory
   - Creates `agent.yaml` manifest pointing to existing files
   - Imports memory logs to SQLite for searchable memory
   - Syncs built-in skills and unifies skill sources
   - Installs connectors for detected platforms
   - Keeps all existing files unchanged

### Important migration notes

- **Do NOT manually copy files** to `~/.agents/` before running setup.
  The wizard handles this and knows how to preserve existing content.
- **Do NOT manually edit harness configs** (settings.json,
  openclaw.json, etc.) to point to `~/.agents/`. The connectors
  handle this.
- After migration, the harness workspace should be reconfigured to
  use `~/.agents/` as the workspace directory. The setup wizard does
  this automatically for supported platforms.
- If migration fails or you want to start fresh, you can re-run
  `signet setup` and choose "Start fresh" instead.

---

## Platform-Specific Details

### Claude Code

The Claude Code connector installs:
- **Session hooks** in `~/.claude/settings.json`:
  - `SessionStart` — loads identity, instructions, and relevant memories
  - `UserPromptSubmit` — injects matching memories per prompt
  - `SessionEnd` — queues transcript for memory extraction
- **Generated CLAUDE.md** at `~/.claude/CLAUDE.md` from your
  `~/.agents/AGENTS.md`
- **Skills symlink** from `~/.agents/skills/` to `~/.claude/skills/`

### OpenClaw / Clawdbot / Moltbot

These are the SAME platform. The connector:
- **Patches config** in `~/.openclaw/`, `~/.clawdbot/`, or
  `~/.moltbot/` (whichever exists) to set workspace to `~/.agents/`
- **Installs hooks** for memory integration
- **Native adapter plugin** (`@signetai/adapter-openclaw`) available
  for direct plugin integration — this is plug and play
- Supports both legacy hook path and native plugin path

### OpenCode

The OpenCode connector:
- **Writes plugin bundle** to `~/.config/opencode/plugins/signet.mjs`
  (OpenCode auto-discovers plugins from this directory)
- **Generates AGENTS.md** at `~/.config/opencode/AGENTS.md`
- **Skills symlink** from `~/.agents/skills/` to
  `~/.config/opencode/skills/`
- Automatically migrates from legacy `memory.mjs` format if present

---

## Common Mistakes

STOP. Read this section carefully. These are real errors that agents
make during installation. Do not repeat them.

| Mistake | Why it's wrong |
|---------|---------------|
| Running `sudo npm install -g signetai` | Signet never needs sudo. Fix npm permissions instead. |
| Running `signet init` | This command does not exist. Use `signet` (no args) or `signet setup`. |
| Running `npx signet init` | Not a thing. Install globally first, then run `signet`. |
| Assuming Node.js alone is enough | Bun is required to run the daemon (`signet start`). |
| Manually writing to `~/.agents/memory/` | The daemon manages memory files. Do not write there directly. |
| Running `signet secret get NAME` | This command does not exist. Use `put/list/has/delete`, and use secret-exec to run commands with injected values. |
| Calling `signet recall` before every response | Context injection is automatic. Only use recall for explicit searches. |
| Defaulting embedding/extraction providers without asking | In non-interactive setup, ask the user which providers they want and pass both flags explicitly. |
| Building a custom HTTP integration | Use the setup wizard's connector selection. It handles everything. |
| Treating Clawdbot/Moltbot as separate from OpenClaw | They are the same platform. One connector handles all three. |
| Skipping setup or manually writing files | Setup configures connectors, hooks, skills, and identity. Use interactive or `--non-interactive`, but do not hand-roll files. |
| Manually editing `~/.claude/settings.json` hooks | The Claude Code connector manages these. Run setup to install them. |
| Cloning the git repository to install | Signet is installed via npm/bun as a global package, not by cloning. |

---

## Troubleshooting

**Daemon won't start:**
```bash
signet daemon logs           # Check for errors
lsof -i :3850               # Check if port is in use
signet stop && signet start  # Restart
```

**No memories appearing:**
```bash
signet status                # Verify daemon is running
signet recall "anything"     # Test search
signet embed audit           # Check embedding coverage
```
If the daemon is running but recall returns nothing, memories may not
have been extracted yet. The extraction pipeline runs asynchronously
after sessions end. If `embed audit` shows low coverage, run
`signet embed backfill` to regenerate missing embeddings.

**Skills not found:**
```bash
signet sync                  # Reinstall built-in templates and skills
```

**Embeddings not working:**
First, check embedding health:
```bash
signet embed audit           # Shows coverage stats
signet embed backfill        # Regenerate missing embeddings
```

Ollama is optional. Without it, Signet falls back to keyword search
(FTS5), which still works well. If you want vector search:
```bash
# Install Ollama (optional)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull nomic-embed-text
```

**Permission errors:**
Never use sudo. Fix npm prefix (see Safety section above) or use bun.

**Setup wizard not launching:**
If `signet` with no arguments doesn't launch the wizard, try:
```bash
signet setup
```

---

## Quick Reference

```bash
# Prereqs
bun --version                  # Required runtime for daemon
node --version                 # Optional, only needed for npm install

# Install
bun add -g signetai          # or: npm install -g signetai

# Setup
signet                       # First run launches setup wizard
signet setup                 # Explicit setup command
signet setup --non-interactive --name "Agent" --harness claude-code --embedding-provider ollama --extraction-provider claude-code

# Daemon
signet start                 # Start daemon
signet stop                  # Stop daemon
signet status                # Check status
signet daemon logs           # View logs

# Memory
signet remember "content"    # Save an important memory
signet recall "query"        # Search all memories
signet recall "q" --since 2026-01-01  # Time-scoped search
signet recall "q" --until 2026-02-01  # Upper bound

# Embeddings
signet embed audit           # Check embedding coverage
signet embed backfill        # Fix missing embeddings

# Export / Import
signet export                # Export agent to portable bundle
signet export --output ./backup
signet export --json --output ./backup.json
signet import ./backup       # Import agent bundle

# Secrets
signet secret put NAME       # Store a secret
signet secret list           # List secret names
signet secret has NAME       # Check if a secret exists
signet secret delete NAME    # Remove a secret

# Maintenance
signet sync                  # Sync built-in templates/skills
signet dashboard             # Open web UI
```

## Scheduled Tasks

Signet supports scheduled agent prompts via the daemon. Tasks are
defined with cron expressions and executed by spawning Claude Code
or OpenCode CLI processes.

- Create tasks via the dashboard Tasks tab or `POST /api/tasks`
- Cron presets: every 15 min, hourly, daily 9am, weekly Mon 9am
- Run history with stdout/stderr capture available per task
- Maximum 3 concurrent task processes, 10-minute default timeout

---

*Signet AI — https://signetai.sh — Your agent is yours.*
