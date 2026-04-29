<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/Signet-Logo-White.png">
  <source media="(prefers-color-scheme: light)" srcset="public/Signet-Logo-Black.png">
  <img src="public/Signet-Logo-Black.png" alt="Signet" width="120">
</picture>

# S I G N E T   A I

**Bring your own context to any AI agent**

<a href="https://github.com/Signet-AI/signetai/actions"><img src="https://img.shields.io/github/actions/workflow/status/Signet-AI/signetai/release.yml?branch=main&style=for-the-badge" alt="CI status"></a>
<a href="https://github.com/Signet-AI/signetai/releases"><img src="https://img.shields.io/github/v/release/Signet-AI/signetai?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
<a href="https://www.npmjs.com/package/signetai"><img src="https://img.shields.io/npm/v/signetai?style=for-the-badge" alt="npm"></a>
<a href="https://github.com/Signet-AI/signetai/discussions"><img src="https://img.shields.io/github/discussions/Signet-AI/signetai?style=for-the-badge" alt="Discussions"></a>
<a href="https://discord.gg/pHa5scah9C"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge" alt="Apache-2.0 License"></a>
<a href="https://github.com/openclaw/openclaw"><img src="https://img.shields.io/badge/OpenClaw-Compatible-orange?style=for-the-badge" alt="OpenClaw Compatible"></a>
<a href="./docs/BENCHMARKING.md#current-longmemeval-score"><img src="https://img.shields.io/badge/LongMemEval-97.6%25-black?style=for-the-badge" alt="LongMemEval 97.6% answer accuracy"></a>

**97.6% average LongMemEval answer accuracy**<br />
Readable record · inspectable recall · harnesses are replaceable

[Website](https://signetai.sh) · [Docs](https://signetai.sh/docs) · [Benchmarks](./docs/BENCHMARKING.md) · [Vision](VISION.md) · [Discussions](https://github.com/Signet-AI/signetai/discussions) · [Discord](https://discord.gg/Psdeg7sQm7) · [Contributing](docs/CONTRIBUTING.md) · [AI Policy](AI_POLICY.md)

</div>

---

**Models change. Harnesses change. Providers change. Your context should not.**

Signet is the portable context layer for AI agents. It keeps identity,
memory, provenance, secrets, skills, and working knowledge outside any
single chat app, model provider, or harness. The execution surface can
change. The agent keeps its footing.

The job is simple: bring your own context to the agents you already use,
then keep that context inspectable and under your control. Signet runs
beneath Claude Code, OpenCode, OpenClaw, Codex, Hermes Agent, and other
harnesses so the durable layer survives the tool of the week.

Memory is ambient. Signet captures useful context between sessions,
preserves the raw record, indexes it for recall, and injects relevant
context before the next prompt starts. The agent wakes up with continuity
instead of asking you to rebuild the room by hand.

Why teams adopt it:
- less prompt re-explaining between sessions
- one context layer across agents, models, harnesses, and providers
- local-first storage with inspectable provenance and repair tools
- a path away from harness-locked behavioral context

## Quick start (about 5 minutes)

```bash
bun add -g signetai        # or: npm install -g signetai
signet setup               # interactive setup wizard
signet status              # confirm daemon + pipeline health
signet dashboard           # open memory + retrieval inspector
```

If you already use Claude Code, OpenCode, OpenClaw, Codex, or Hermes
Agent, keep your existing harness. Signet installs under it.

### Docker self-hosting

Run Signet as a containerized daemon with first-party Compose assets:

```bash
cd deploy/docker
cp .env.example .env
docker compose up -d --build
```

See [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) for token bootstrap,
backup, and upgrade runbook details.

## Bring your own context

Portable memory only matters if the agent can see the world you already
work inside. Signet is built around ordinary context, not a special
knowledge-base ritual: project notes, transcripts, markdown files, PDFs,
URLs, identity files, decisions, preferences, and the corrections that
shape how work actually happens.

The durable record stays readable. The semantic layer helps the agent
navigate it. Retrieval is a lens over the record, not a replacement for
it. When a summary is stale, conflict-heavy, or decision-critical, the
agent can climb back down to the source.

## First proof of value (2-session test)

Run this once:

```bash
signet remember "my primary stack is bun + typescript + sqlite"
```

Then in your next session, ask your agent:

```text
what stack am i using for this project?
```

You should see continuity without manually reconstructing context.
If not, inspect recall and provenance in the dashboard or run:

```bash
signet recall "primary stack"
```

Want the deeper architecture view? Jump to [How it works](#how-it-works) or [Architecture](#architecture).

## Core capabilities

These are the product surface areas Signet is optimized around:

| Core | What it does |
|---|---|
| 🧠 Ambient memory | Sessions are captured automatically, no manual memory ceremony required |
| 🗂️ Source-backed context | Raw transcripts and workspace files remain available beneath summaries and recall results |
| 🎯 Inspectable recall | Hybrid search, graph traversal, provenance, scopes, and ranking signals explain why context surfaced |
| 🏠 Local-first substrate | Data lives on your machine in SQLite and markdown, portable by default |
| 🤝 Cross-harness continuity | Claude Code, OpenCode, OpenClaw, Codex, Pi, Hermes Agent, one shared context layer |
| 🧩 SDK-first extensibility | Typed SDKs, middleware, and plugin surfaces let builders shape Signet around their own agents |

## Is Signet right for you?

Use Signet if you want:
- memory continuity across sessions without manual prompt bootstrapping
- local ownership of agent state and history
- one context layer across multiple agent harnesses

Signet may be overkill if you only need short-lived chat memory inside a
single hosted assistant.

## What Signet is not

Signet is not a chat app, not a harness, and not a fake second brain
trying to outsmart the model. It is the durable layer underneath: files,
memory, identity, provenance, retrieval, secrets, and permissions.

The harness should stay replaceable. The provider should provide
intelligence, not custody. Signet keeps the continuity somewhere you can
inspect, repair, move, and rebuild.

## Why you can trust this

- runs local-first by default
- raw records and workspace files stay inspectable
- SQLite powers the query layer; recall keeps provenance and source references
- memory can be repaired (edit, supersede, delete, reclassify)
- easy to build on: SDK, connectors, MCP, and workspace primitives let teams
  shape Signet around their agents, policies, and workflows
- no vendor lock-in, your context stays portable

If you are building agents for an organization, Signet is meant to be shaped,
not merely installed. Use the SDK, plugin SDK, connectors, and MCP surface to
fit your own agents, permission model, workflows, and deployment style.

## What keeps it reliable

These systems improve quality and reliability of the core memory loop:

| Supporting | What it does |
|---|---|
| 📜 Lossless transcripts | Raw session history preserved alongside extracted memories |
| 🕸️ Structured retrieval substrate | Graph traversal + FTS5 + vector search produce bounded candidate context |
| 🎯 Feedback-aware ranking | Recency, provenance, importance, and dampening signals help separate useful context from repeated noise |
| 🔬 Noise filtering | Hub and similarity controls reduce low-signal memory surfacing |
| 📄 Document ingestion | Pull PDFs, markdown, and URLs into the same retrieval pipeline |
| 🖥️ CLI + Dashboard | Operate and inspect the system from terminal or web UI |

## Advanced capabilities (optional)

These extend Signet for larger deployments and custom integrations:

| Advanced | What it does |
|---|---|
| 🔐 Agent-blind secrets | Encrypted secret storage, injected at execution time, not exposed to agent text |
| 👯 Multi-agent policies | Isolated/shared/group memory visibility for multiple named agents |
| 🔄 Git sync | Identity and memory can be versioned in your own remote |
| 📦 SDK + plugin SDK | Typed client, React hooks, Vercel/OpenAI helpers, and plugin surfaces for extending the ecosystem |
| 🔌 MCP aggregation | Register MCP servers once, expose across connected harnesses |
| 👥 Team controls | RBAC, token policy, and rate limits for shared deployments |
| 🏪 Ecosystem installs | Install skills and MCP servers from [skills.sh](https://skills.sh) and [ClawHub](https://clawhub.ai) |
| ⚖️ Apache 2.0 | Fully open source, forkable, and self-hostable |

## When memory is wrong

Memory quality is not just recall quality. It is governance quality.

Signet is built to support:
- provenance inspection (where a memory came from)
- scoped visibility controls (who can see what)
- memory repair (edit, supersede, delete, or reclassify)
- transcript fallback (verify extracted memory against raw source)
- lifecycle controls (retention, decay, and conflict handling)

## Harness support

Signet is not a harness. It doesn't replace Claude Code, OpenClaw,
OpenCode, Pi, or Hermes Agent — it runs alongside them as an enhancement.
Bring the harness you already use. Signet handles the memory layer
underneath it.

| Harness | Status | Integration |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | **Supported** | Hooks |
| Forge | **First-party** | Native runtime / reference harness |
| [OpenCode](https://github.com/sst/opencode) | **Supported** | Plugin + Hooks |
| [OpenClaw](https://github.com/openclaw/openclaw) | **Supported** | Runtime plugin + NemoClaw compatible |
| [Codex](https://github.com/openai/codex) | **Supported** | Hooks + MCP server |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | **Supported** | Memory provider plugin |
| [Pi](https://github.com/mariozechner/pi-coding-agent) | **Supported** | Extension + Hooks |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | **Supported** | MCP server + GEMINI.md sync |


> Don't see your favorite harness? file an [issue](https://github.com/Signet-AI/signetai/issues) and request that it be added!

## LongMemEval Benchmark

[LongMemEval](https://arxiv.org/abs/2410.10813) measures whether a memory
system can recover and use facts across long-running, multi-session
assistant conversations. Signet's latest tracked MemoryBench runs average
**97.6% answer accuracy** under the `rules` profile.

That profile keeps the benchmark contract strict: memories are ingested through
`/api/memory/remember`, recalled through `/api/memory/recall`, and answered
from bounded daemon recall results. Search does not call an LLM.

See [Benchmarks](./docs/BENCHMARKING.md#current-longmemeval-score) for the
methodology, scoring note, and run workflow.

## Install (detailed)

```bash
bun add -g signetai        # or: npm install -g signetai
signet setup               # interactive setup wizard
```

The wizard initializes `$SIGNET_WORKSPACE/`, configures your harnesses, sets up
an embedding provider, creates the database, and starts the daemon.

> Path note: `$SIGNET_WORKSPACE` means your active Signet workspace path.
> Default is `~/.agents`, configurable via `signet workspace set <path>`.

### Tell your agent to install it

Paste this to your AI agent:

```
Install and fully configure Signet AI by following this guide exactly: https://signetai.sh/skill.md
```

### CLI use

```bash
signet status              # check daemon health
signet dashboard           # open the web UI

signet remember "prefers bun over npm"
signet recall "coding preferences"
```

### Multi-agent

Multiple named agents share one daemon and database. Each agent gets its
own identity directory (`~/.agents/agents/<name>/`) and configurable
memory visibility:

```bash
signet agent add alice --memory isolated   # alice sees only her own memories
signet agent add bob --memory shared       # bob sees all global memories
signet agent add ci --memory group --group eng  # ci sees memories from the eng group

signet agent list                          # roster + policies
signet remember "deploy key" --agent alice --private  # alice-only secret
signet recall "deploy" --agent alice       # scoped to alice's visible memories
signet agent info alice                    # identity files, policy, memory count
```

OpenClaw users get zero-config routing — session keys like
`agent:alice:discord:direct:u123` are parsed automatically; no
`agentId` header needed.

In connected harnesses, skills work directly:

```text
/remember critical: never commit secrets to git
/recall release process
```

## How it works

Signet separates memory into three layers:

```text
workspace / transcripts
  truth layer: raw files, identity docs, source records, session history

semantic memory
  navigation layer: summaries, entities, decisions, constraints, relations

query layer
  retrieval lens: FTS, vector search, graph traversal, scopes, provenance
```

The record is preserved first. The daemon indexes it, extracts useful
structure, and keeps recall bounded and inspectable. The agent gets the
right context before the next prompt starts, with a path back to the raw
source when the semantic layer is not enough.

After setup, there is no per-session memory ceremony. The pipeline runs
in the background and the agent wakes up with its memory intact.

Read more: [Why Signet](./docs/QUICKSTART.md#why-signet) · [Architecture](./docs/ARCHITECTURE.md) · [Knowledge Graph](./docs/KNOWLEDGE-GRAPH.md) · [Pipeline](./docs/PIPELINE.md)

## Architecture

```text
Workspace (~/.agents/)
  AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, transcripts, memory files
  readable source records and agent identity files

CLI (signet)
  setup, knowledge, secrets, skills, hooks, git sync, service mgmt

Daemon (@signet/daemon, localhost:3850)
  |-- HTTP API (memory, retrieval, auth, skills, updates, tooling)
  |-- File Watcher
  |     identity sync, per-agent workspace sync, git auto-commit
  |-- Distillation Layer
  |     extraction -> decision -> graph -> retention
  |-- Retrieval
  |     FTS + vectors + graph traversal -> fusion -> dampening
  |-- Lossless Transcripts
  |     raw session storage -> expand-on-recall join
  |-- Document Worker
  |     ingest -> chunk -> embed -> index
  |-- Ranking + Feedback
  |     bounded candidate ordering, provenance, source-aware scoring
  |-- MCP Server
  |     tool registration, aggregation, blast radius endpoint
  |-- Auth Middleware
  |     local / team / hybrid, RBAC, rate limiting
  |-- Multi-Agent
        roster sync, agent_id scoping, read-policy SQL enforcement

Core (@signet/core)
  types, identity, SQLite storage/query, hybrid search, graph traversal

SDK (@signet/sdk)
  typed client, React hooks, Vercel/OpenAI helpers, plugin-facing primitives

Connectors
  claude-code, opencode, openclaw, codex, oh-my-pi, pi, hermes-agent, forge
```

## Packages

| Package | Role |
|---|---|
| [`@signet/core`](./platform/core) | Types, identity, SQLite, hybrid + graph search |
| [`@signet/cli`](./surfaces/cli) | CLI, setup wizard, dashboard |
| [`@signet/daemon`](./platform/daemon) | API server, distillation layer, auth, analytics, diagnostics |
| [`signet-dashboard`](./surfaces/dashboard) | Svelte dashboard built to static assets and served by the daemon |
| [`@signet/sdk`](./libs/sdk) | Typed client, React hooks, Vercel AI SDK middleware |
| [`runtimes/forge`](./runtimes/forge) | Forge native terminal harness and reference runtime implementation |
| [`@signet/connector-base`](./libs/connector-base) | Shared connector primitives and utilities |
| [`@signet/connector-claude-code`](./integrations/claude-code/connector) | Claude Code integration |
| [`@signet/connector-opencode`](./integrations/opencode/connector) | OpenCode integration |
| [`@signet/connector-openclaw`](./integrations/openclaw/connector) | OpenClaw integration |
| [`@signet/connector-codex`](./integrations/codex/connector) | Codex CLI integration |
| [`@signet/connector-forge`](./integrations/forge/connector) | Forge integration |
| [`@signet/connector-gemini`](./integrations/gemini/connector) | Gemini CLI integration |
| [`@signet/connector-oh-my-pi`](./integrations/oh-my-pi/connector) | Oh My Pi integration |
| [`@signet/connector-hermes-agent`](./integrations/hermes-agent/connector) | Hermes Agent integration |
| [`@signet/connector-pi`](./integrations/pi/connector) | Pi coding agent integration |
| [`@signet/oh-my-pi-extension`](./integrations/oh-my-pi/extension) | Oh My Pi extension bridge |
| [`@signet/pi-extension-base`](./integrations/pi/extension-base) | Shared Pi and Oh My Pi extension utilities |
| [`@signet/pi-extension`](./integrations/pi/extension) | Pi extension — memory tools, lifecycle, and session hooks |
| [`@signet/opencode-plugin`](./integrations/opencode/plugin) | OpenCode runtime plugin — memory tools and session hooks |
| [`@signetai/signet-memory-openclaw`](./integrations/openclaw/memory-adapter) | OpenClaw runtime plugin |
| [`@signet/extension`](./surfaces/browser-extension) | Browser extension for Chrome and Firefox |
| [`@signet/desktop`](./surfaces/desktop) | Electron desktop application |
| [`@signet/tray`](./surfaces/tray) | Shared tray/menu bar utilities |
| [`@signet/native`](./platform/native) | Native accelerators |
| [`predictor`](./platform/predictor) | Experimental Rust sidecar for learned relevance ranking |
| [`signetai`](./dist/signetai) | Meta-package (`signet` binary) |
| [`@signet/web`](./web/marketing) | Astro marketing site deployed to Cloudflare Pages |
| [`reviews-worker`](./web/workers/reviews) | Cloudflare Worker for review automation |
| [`signet.secrets`](./plugins/core/secrets) | Core Signet-native secrets plugin |
| [`memorybench`](./memorybench) | Benchmark harness, datasets, providers, reports, and local benchmark UI |

## Documentation

- [Quickstart](./docs/QUICKSTART.md)
- [CLI Reference](./docs/CLI.md)
- [Configuration](./docs/CONFIGURATION.md)
- [Hooks](./docs/HOOKS.md)
- [Harnesses](./docs/HARNESSES.md)
- [Secrets](./docs/SECRETS.md)
- [Skills](./docs/SKILLS.md)
- [Auth](./docs/AUTH.md)
- [Dashboard](./docs/DASHBOARD.md)
- [SDK](./docs/SDK.md)
- [API Reference](./docs/API.md)
- [Knowledge Architecture](./docs/KNOWLEDGE-ARCHITECTURE.md)
- [Knowledge Graph](./docs/KNOWLEDGE-GRAPH.md)
- [Benchmarks](./docs/BENCHMARKING.md)
- [Roadmap](./ROADMAP.md)
- [Repository Map](./docs/REPO_MAP.md)

## Research

| Paper / Project | Relevance |
|---|---|
| [Lossless Context Management](https://papers.voltropy.com/LCM) (Voltropy, 2026) | Hierarchical summarization, guaranteed convergence. Patterns adapted in [LCM-PATTERNS.md](./docs/specs/planning/LCM-PATTERNS.md). |
| [Recursive Language Models](https://arxiv.org/abs/2512.24601) (Zhang et al., 2026) | Active context management. LCM builds on and departs from RLM's approach. |
| [acpx](https://github.com/openclaw/acpx) (OpenClaw) | Agent Client Protocol. Structured agent coordination. |
| [lossless-claw](https://github.com/Martian-Engineering/lossless-claw) (Martian Engineering) | LCM reference implementation as an OpenClaw plugin. |
| [openclaw](https://github.com/openclaw/openclaw) (OpenClaw) | Agent runtime reference. |
| [arscontexta](https://github.com/agenticnotetaking/arscontexta) | Agentic notetaking patterns. |
| [ACAN](https://github.com/HongChuanYang/Training-by-LLM-Enhanced-Memory-Retrieval-for-Generative-Agents-via-ACAN) (Hong et al.) | LLM-enhanced memory retrieval for generative agents. |
| [Kumiho](https://arxiv.org/abs/2603.17244) (Park et al., 2026) | Prospective indexing. Hypothetical query generation at write time. Reports 0.565 F1 on the official split and 97.5% on the adversarial subset. |

## Development

```bash
git clone https://github.com/Signet-AI/signetai.git
cd signetai

bun install
bun run build
bun test
bun run lint
```

```bash
cd platform/daemon && bun run dev        # Daemon dev (watch mode)
cd surfaces/dashboard && bun run dev # Dashboard dev
```

Requirements:

- Node.js 18+ or Bun
- macOS or Linux
- Optional for harness integrations: Claude Code, Codex, OpenCode, or OpenClaw

Embeddings (choose one):

- **Built-in** (recommended) — no extra setup, runs locally via ONNX (`nomic-embed-text-v1.5`)
- **Ollama** — alternative local option, requires `nomic-embed-text` model
- **OpenAI** — cloud option, requires `OPENAI_API_KEY`

## Contributing

New to open source? Start with [Your First PR](./docs/FIRST-PR.md).
For code conventions and project structure, see
[CONTRIBUTING.md](./docs/CONTRIBUTING.md). Open an issue before
contributing significant features. Read the
[AI Policy](./AI_POLICY.md) before submitting AI-assisted work.

## Star History

<a href="https://star-history.com/#Signet-AI/signetai&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Signet-AI/signetai&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Signet-AI/signetai&type=Date" />
    <img alt="Star history chart for Signet-AI/signetai" src="https://api.star-history.com/svg?repos=Signet-AI/signetai&type=Date" />
  </picture>
</a>

## Contributors

<a href="https://github.com/NicholaiVogel"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/217880623?v=4&s=48" width="48" height="48" alt="NicholaiVogel" title="NicholaiVogel" /></a> <a href="https://github.com/BusyBee3333"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/241850310?v=4&s=48" width="48" height="48" alt="BusyBee3333" title="BusyBee3333" /></a> <a href="https://github.com/stephenwoska2-cpu"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/258141506?v=4&s=48" width="48" height="48" alt="stephenwoska2-cpu" title="stephenwoska2-cpu" /></a> <a href="https://github.com/PatchyToes"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/256889430?v=4&s=48" width="48" height="48" alt="PatchyToes" title="PatchyToes" /></a> <a href="https://github.com/aaf2tbz"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/260091788?v=4&s=48" width="48" height="48" alt="aaf2tbz" title="aaf2tbz" /></a> <a href="https://github.com/ddasgupta4"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/ddasgupta4?v=4&s=48" width="48" height="48" alt="ddasgupta4" title="ddasgupta4" /></a> <a href="https://github.com/alcar2364"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/alcar2364?v=4&s=48" width="48" height="48" alt="alcar2364" title="alcar2364" /></a> <a href="https://github.com/maximhar"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/maximhar?v=4&s=48" width="48" height="48" alt="maximhar" title="maximhar" /></a> <a href="https://github.com/lost-orchard"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/lost-orchard?v=4&s=48" width="48" height="48" alt="lost-orchard" title="lost-orchard" /></a> <a href="https://github.com/Ostico"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/8008416?v=4&s=48" width="48" height="48" alt="Ostico" title="Ostico" /></a> <a href="https://github.com/gpzack"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/271398594?v=4&s=48" width="48" height="48" alt="gpzack" title="gpzack" /></a> <a href="https://github.com/LeuciRemi"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/44776125?v=4&s=48" width="48" height="48" alt="LeuciRemi" title="LeuciRemi" /></a>
<br clear="left" />

Made with love by members of Dashore Incubator & friends of Jake Shore and Nicholai Vogel.

## License

Apache-2.0.

---

[signetai.sh](https://signetai.sh) ·
[docs](https://signetai.sh/docs) ·
[spec](https://signetai.sh/spec) ·
[discussions](https://github.com/Signet-AI/signetai/discussions) ·
[issues](https://github.com/Signet-AI/signetai/issues)
