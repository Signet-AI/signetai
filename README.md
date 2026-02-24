# Signet

<p align="center">
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache-2.0" /></a>
  <a href="https://signetai.sh/spec"><img src="https://img.shields.io/badge/spec-v0.2.1--draft-blue.svg" alt="Spec Version" /></a>
  <a href="https://github.com/signetai/signetai/stargazers"><img src="https://img.shields.io/github/stars/signetai/signetai.svg" alt="GitHub Stars" /></a>
</p>

> For Claude Code, OpenCode, and OpenClaw

<table>
<tr>
<td width="240" valign="top">
  <img src="public/signetposter-01.jpg" alt="Signet — your AI has a memory, you don't own it" width="220" />
</td>
<td valign="top">

**Own your agent. Bring it anywhere.**

Signet is a local-first identity, memory, and operations layer for AI
agents. It ships a full memory pipeline with LLM-based extraction and
graph-augmented retrieval, an authenticated HTTP API, analytics, and
an integration SDK — all running on your machine, under your control.

Agent configuration lives in plain files at `~/.agents/`, backed by a
SQLite database, and synced across every harness you use. Signet is
also the first *agent-native secret store*, letting your agent use
secrets without ever reading their values.

</td>
</tr>
</table>

---

<table>
<tr>
<td valign="top">

Why Signet
===

Most AI tools build memory silos. Switch harnesses and you lose your
agent's context, preferences, and accumulated knowledge. Rebuild it
manually, or start from scratch.

Signet gives you one portable substrate you actually own: plain-text
identity files you can inspect and version-control, a daemon that runs
locally and handles everything memory-related, and connector packages
that keep each harness in sync with your canonical config. The same
agent follows you into Claude Code, OpenCode, or OpenClaw — same
personality, same memory, same secrets — without any vendor lock-in.

The memory pipeline is privacy-first: the default LLM is a local Ollama
model. Nothing leaves your machine unless you configure it to.

</td>
<td width="520" valign="top">
  <img src="public/memory-loop-blueprint.jpg" alt="Signet Memory Loop — session hooks, remember/recall pipeline, and persistence cycle" width="500" />
</td>
</tr>
</table>

---

```text
~/.agents/
├── agent.yaml        # Manifest + runtime config
├── AGENTS.md         # Source-of-truth operating instructions
├── SOUL.md           # Voice/personality guidance
├── IDENTITY.md       # Structured identity metadata
├── USER.md           # User preferences/profile
├── MEMORY.md         # Synthesized working memory (generated)
├── memory/           # SQLite DB + embedding artifacts
├── skills/           # Installed skills (SKILL.md per skill)
├── .secrets/         # Encrypted secret store
└── .daemon/          # PID + logs
```

How memory works
===

When you save a memory, Signet persists the raw content immediately —
the database write happens before any LLM processing begins. No matter
what happens after, your data is safe.

In the background, a local LLM reads the new memory and does two things:
it breaks the content into structured facts and entities, then checks
what's already stored. For each fact, it decides whether to file it as
new, update an existing memory, replace something outdated, or skip it
entirely.

This means your agent won't keep duplicating "prefers dark mode" every
session. It sees the existing memory, recognizes it already knows this,
and moves on.

The same pipeline runs at the end of every conversation. The daemon
reviews the session transcript, extracts anything worth remembering,
and feeds it through the same process. So even if you never use
`/remember` manually, your agent builds context over time — without
accumulating duplicates or contradictions.

**Knowledge graph.** The pipeline also maintains an entity graph. Named
entities (people, projects, tools, concepts) are extracted and linked,
and search uses one-hop graph traversal to boost results that are
semantically adjacent to your query. Asking about a project surfaces
memories mentioning the people and tools associated with it.

**Document ingest.** You can feed documents directly into the pipeline.
They're chunked, embedded, and indexed alongside your memories. URL
fetching is built in — point Signet at a doc, a spec, or a reference
page and it becomes part of your agent's searchable knowledge base.

**Modify and forget.** Explicit `/modify` and `/forget` commands let you
correct or remove specific memories. Deletions are soft: content is
tombstoned with a 30-day recovery window and a full audit trail.
Pinned (critical) memories are never modified by the pipeline, only
by you.

**Diagnostics and maintenance.** The daemon runs a maintenance worker
that scores memory health — checking for orphaned embeddings, schema
drift, embedding failures, and other issues — and can repair them
autonomously. Timeline reconstruction lets you trace incidents by
replaying analytics events across a time window.

Three safety guarantees hold throughout:

- **Raw-first**: content is persisted before any LLM processing begins
- **Pinned memories are sacred**: the model cannot delete them, period
- **Everything is recoverable**: deletions are soft, with a 30-day
  recovery window and a full audit trail

What ships now
===

Memory
---

- Pipeline v2 with durable async job queue and structured extraction
- Hybrid retrieval: FTS5 keyword + vector similarity, score-blended
- Knowledge graph: entity extraction, graph-augmented search boost
- Document ingest with automatic chunking, embedding, and URL fetching
- Explicit modify/forget with soft-delete and 30-day recovery
- Retention decay: configurable aging for low-value memories
- Full audit history for every write, update, and deletion

Identity
---

- Portable identity files at `~/.agents/` (AGENTS.md, SOUL.md,
  IDENTITY.md, USER.md, MEMORY.md)
- Daemon-driven harness sync: writes harness-specific config files on
  change (CLAUDE.md, opencode AGENTS.md, OpenClaw bootstrap)
- Skills: install and manage skills from skills.sh
- Git-aware workflow: optional auto-commit and configurable sync

Security
---

- Auth middleware with three modes: `local` (localhost-only, no token),
  `team` (bearer token, all requests), `hybrid` (token required for
  writes, open for reads)
- Role-based permissions with four roles: `admin`, `operator`, `agent`,
  `readonly`
- Scope model: `project`, `agent`, `user`
- Rate limiting on destructive operations
- Secrets: libsodium-encrypted at rest (`XSalsa20-Poly1305`), never
  returned by API, subprocess output redacted
- Privacy-first default: local Ollama LLM, no outbound telemetry

Operations
---

- Analytics: usage counters, error ring buffer, per-endpoint latency
  histograms, token usage tracking
- Diagnostics: health scoring across memory, embeddings, schema,
  config integrity
- Autonomous maintenance: scheduled repair actions with dry-run support
- Timeline: incident reconstruction by replaying events across a window
- Repair actions: targeted fixes for detected issues, audit-logged

Integrations
---

- Connectors: Claude Code, OpenCode, OpenClaw, filesystem (built-in)
- SDK (`@signet/sdk`): typed API client, React hooks, Vercel AI SDK
  middleware, OpenAI helper wrappers
- Dashboard at `http://localhost:3850`: config editor, memory browser,
  embeddings view, skills/secrets/logs

Requirements
===

- Node.js 18+ for CLI and package workflows
- Bun for the daemon runtime (`signet start`)
- Ollama for the local LLM (recommended) or an OpenAI API key
- macOS or Linux

Quickstart
===

Install
---

```bash
# Global install (pick one)
npm install -g signetai
bun add -g signetai
```

Then run the interactive setup wizard:

```bash
signet
```

The wizard initializes `~/.agents/`, configures your selected
harnesses, prompts for an embedding provider (Ollama/OpenAI/skip),
creates the memory database, and starts the daemon.

### Tell your agent to install it

Copy this prompt and paste it to your AI agent (Claude Code, OpenClaw,
Clawdbot, OpenCode, etc.):

```
Install Signet AI, the open agent memory and identity system: https://signetai.sh/skill.md
```

The linked guide walks your agent through prerequisites, installation,
setup, and verification step by step — with gates that ensure it stops
and explains what it's doing before each phase.

Use it
---

```bash
signet status
signet dashboard

signet remember "prefers bun over npm" -w claude-code
signet recall "coding preferences"

# Explicit modify and forget
signet memory modify <id> "updated content"
signet memory forget <id>
signet memory recover <id>
```

In connected harnesses, built-in skills work directly:

```text
/remember critical: never commit secrets to git
/recall release process
```

Harness support
===

| Harness | Status | Integration |
|---|---|---|
| Claude Code | Supported | Connector writes `~/.claude/CLAUDE.md` + hook config |
| OpenCode | Supported | Connector writes `~/.config/opencode/AGENTS.md` + plugin |
| OpenClaw | Supported | Connector bootstrap + `@signetai/adapter-openclaw` runtime |
| Cursor | Planned | File-based identity sync |
| Windsurf | Planned | File/plugin integration |

Architecture
===

```text
CLI (signet)
  setup, memory, secrets, skills, hooks, git sync, updates, service mgmt

Daemon (@signet/daemon, localhost:3850)
  ├── HTTP API (83+ endpoints across 18 domains)
  ├── Memory Pipeline
  │     extraction → decision → graph → retention
  ├── Document Worker
  │     ingest → chunk → embed → index
  ├── Maintenance Worker
  │     diagnostics → health scoring → repair actions
  ├── Auth Middleware
  │     local / team / hybrid modes, RBAC, rate limiting
  ├── Analytics
  │     usage counters, error ring buffer, latency histograms
  └── File Watcher
        identity sync (2s debounce), git auto-commit (5s debounce)

Core (@signet/core)
  types, identity, SQLite, hybrid search, graph search, shared utils

SDK (@signet/sdk)
  typed client, React hooks, Vercel AI SDK middleware, OpenAI helpers

Connectors
  claude-code, opencode, openclaw, filesystem
```

API overview
---

The daemon exposes a REST API organized into these domains:

| Domain | Endpoints |
|---|---|
| Health / status | `/health`, `/api/status` |
| Config | `/api/config` |
| Identity | `/api/identity` |
| Memory | CRUD, search, modify, forget, recover, history |
| Documents | ingest, list, delete |
| Connectors | install, sync, list |
| Auth | token management, role assignment |
| Analytics | usage, errors, latency, tokens |
| Diagnostics | health score, issue list |
| Timeline | event replay, incident reconstruction |
| Repair | available actions, execute, dry-run |
| Skills | list, install, remove |
| Secrets | list, set, delete, exec |
| Harnesses | list, sync |
| Hooks | session-start, prompt-submit, session-end, synthesis |
| Logs | tail, search |
| Embeddings | export |
| Update | check, apply |
| Git | status, commit, sync |

Security model
===

The daemon binds to `localhost` by default — no external exposure
without explicit configuration. Auth is layered on top via middleware
that you configure per-deployment.

Three auth modes: `local` requires no token (localhost trust),
`team` requires a bearer token on every request, `hybrid` requires
tokens for writes but allows open reads. Four roles control what each
token can do: `admin` (full access), `operator` (config + memory +
skills), `agent` (memory operations only), `readonly` (GET only).
Destructive operations (bulk delete, repair, forget) are additionally
rate-limited regardless of role.

Secrets never leave the encrypted store as plaintext. The API returns
only key names. When an agent needs to run a command that uses a secret,
Signet injects it into the subprocess environment and redacts it from
the captured output before returning anything to the caller.

Packages
===

| Package | Role |
|---|---|
| [`@signet/core`](./packages/core) | Types, identity, SQLite, hybrid + graph search, shared utils |
| [`@signet/cli`](./packages/cli) | CLI entrypoint, setup wizard, config workflows, dashboard |
| [`@signet/daemon`](./packages/daemon) | API server, pipeline workers, auth, analytics, diagnostics, watcher |
| [`@signet/sdk`](./packages/sdk) | Typed client, React hooks, Vercel AI SDK middleware, OpenAI helpers |
| [`@signet/connector-base`](./packages/connector-base) | Shared connector primitives |
| [`@signet/connector-claude-code`](./packages/connector-claude-code) | Claude Code integration |
| [`@signet/connector-opencode`](./packages/connector-opencode) | OpenCode integration |
| [`@signet/connector-openclaw`](./packages/connector-openclaw) | OpenClaw bootstrap integration |
| [`@signetai/adapter-openclaw`](./packages/adapters/openclaw) | OpenClaw runtime plugin |
| [`@signet/web`](./web) | Marketing website (Cloudflare Worker) |
| [`signetai`](./packages/signetai) | Meta-package bundling CLI + daemon (`signet` binary) |

Documentation
===

- [Quickstart](./docs/QUICKSTART.md)
- [CLI Reference](./docs/CLI.md)
- [Configuration](./docs/CONFIGURATION.md)
- [Memory](./docs/MEMORY.md)
- [Memory Pipeline](./docs/PIPELINE.md)
- [Documents](./docs/DOCUMENTS.md)
- [Hooks](./docs/HOOKS.md)
- [Harnesses](./docs/HARNESSES.md)
- [Connectors](./docs/CONNECTORS.md)
- [Secrets](./docs/SECRETS.md)
- [Skills](./docs/SKILLS.md)
- [Auth](./docs/AUTH.md)
- [Analytics](./docs/ANALYTICS.md)
- [Diagnostics](./docs/DIAGNOSTICS.md)
- [Dashboard](./docs/DASHBOARD.md)
- [SDK](./docs/SDK.md)
- [API Reference](./docs/API.md)
- [Self-Hosting](./docs/SELF-HOSTING.md)
- [Architecture](./docs/ARCHITECTURE.md)

Development
===

```bash
git clone https://github.com/signetai/signetai.git
cd signetai

bun install
bun run build
bun test
bun run lint
```

Useful package-level flows:

```bash
# CLI dev
cd packages/cli && bun run dev

# Dashboard dev
cd packages/cli/dashboard && bun run dev

# Daemon dev (watch mode)
cd packages/daemon && bun run dev
```

Contributing
===

Contributions are welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

If you are adding a harness integration, build on the existing connector
pattern (`@signet/connector-base`) and keep runtime memory semantics in
the daemon API. Before contributing a significant feature, check how
similar things are structured and consider opening an issue first if
the architecture fit is unclear.

License
===

Apache-2.0.

Links
===

- Website: [signetai.sh](https://signetai.sh)
- Docs: [signetai.sh/docs](https://signetai.sh/docs)
- Spec: [signetai.sh/spec](https://signetai.sh/spec)
- Issues: [github.com/signetai/signetai/issues](https://github.com/signetai/signetai/issues)
