<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/Signet-Logo-White.png">
  <source media="(prefers-color-scheme: light)" srcset="public/Signet-Logo-Black.png">
  <img src="public/Signet-Logo-Black.png" alt="Signet" width="120">
</picture>

# Signet AI

**Own your agent's context.**

<a href="https://github.com/Signet-AI/signetai/releases"><img src="https://img.shields.io/github/v/release/Signet-AI/signetai?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
<a href="https://www.npmjs.com/package/signetai"><img src="https://img.shields.io/npm/v/signetai?style=for-the-badge" alt="npm"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge" alt="Apache-2.0 License"></a>
<a href="./docs/BENCHMARKING.md#current-longmemeval-score"><img src="https://img.shields.io/badge/LongMemEval-97.6%25-black?style=for-the-badge" alt="LongMemEval 97.6% answer accuracy"></a>

**97.6% average LongMemEval answer accuracy**<br />
Local-first context · source-backed recall · repairable memory · portable across agents

[Quick start](#quick-start-about-5-minutes) · [Why Signet](#why-signet) · [Benchmarks](./docs/BENCHMARKING.md) · [Docs](https://signetai.sh/docs) · [Discord](https://discord.gg/Psdeg7sQm7)

</div>

---

Models change. Providers change. Agent shells change. Your context should not.

Your agents are starting to remember projects, users, decisions, documents,
conversations, preferences, mistakes, routines, and private working context.

That memory is no longer a feature. It is infrastructure — and custody matters.

Signet is a local-first context layer for AI agents: memory, identity,
transcripts, source records, provenance, agent instructions, secrets, and
repair tools in infrastructure you control.

Hosted memory APIs are fastest until memory becomes part of your product
contract: deletion, provenance, repair, portability, and custody of private
context. Signet is for that moment.

Not a hosted memory API. Not a harness-specific plugin. Signet is
the durable layer underneath your agents.

## Why Signet

| Claim | Why it matters |
|---|---|
| Local-first custody | SQLite, readable workspace files, transcripts, source records, memories, and identity files live where you control them |
| Source-backed recall | Every useful memory can point back to where it came from |
| Repairable memory | Inspect, edit, supersede, delete, reclassify, and scope bad context |
| Portable across agents | One layer works across Claude Code, Codex, OpenCode, OpenClaw, Gemini CLI, Hermes Agent, MCP, SDKs, and apps |
| Team deployment primitives | Signet includes scoped agents, visibility, auth policy, retention controls, secrets storage, and audit-friendly APIs |
| Proven recall | LongMemEval-tracked recall without giving up governance |

You know you need Signet when agent memory is no longer just recall quality.
You need to know where context lives, where it came from, who can see it, how
it can be corrected, what gets deleted, and whether it can move when your
tools change.

## Quick start (about 5 minutes)

```bash
curl -fsSL https://signetai.sh/install.sh | bash
signet setup               # interactive setup wizard
signet status              # confirm daemon + pipeline health
signet dashboard           # open memory + retrieval inspector
```

If you already use Claude Code, OpenCode, OpenClaw, Codex, Gemini CLI,
Pi, Oh My Pi, or Hermes Agent, keep your existing harness. Signet installs
under it.

## Proof in one repair loop

Run this once:

```bash
signet remember "Project Atlas deploys only after QA signs off" \
  --tags project-atlas --who user
signet recall "Project Atlas deploy policy" --tags project-atlas --json
```

Then open the dashboard:

```bash
signet dashboard
```

This is the smallest proof, but it shows the product shape: the memory is
local, queryable, tagged, visible in the dashboard, and repairable instead of
being trapped behind a hosted recall response.

If recall returns a stale deployment policy, you can edit or delete the memory,
run the same recall again, and verify the agent is seeing corrected context
before it acts.

In the dashboard, the record is not a black-box snippet:

```text
Memory: Project Atlas deploys only after QA signs off
Tags: project-atlas
Dashboard actions: edit · delete · mark pinned · similar
Daemon lifecycle: modify · forget · recover
```

## How Signet is different

| Alternative | Good for | Where Signet is different |
|---|---|---|
| Hosted memory APIs | Fast prototypes and managed memory | Signet keeps storage, provenance, ranking policy, repair, deletion, and self-hosting under your control |
| Harness-specific plugins | Improving memory inside one agent shell | Signet runs underneath many harnesses, so context survives tool churn |
| Vector/RAG memory | Searching notes and documents | Signet keeps transcripts, identity, source records, repair history, and scoped recall |
| Lightweight local stores | Simple private persistence | Signet adds provenance, dashboard inspection, team policy, connectors, MCP, SDKs, and daemon APIs |

| Stay hosted if... | Switch to Signet when... |
|---|---|
| You need the fastest managed API path | Memory has to live in infrastructure you control |
| Recall quality is the only contract | Deletion, repair, provenance, and auditability are also part of the contract |
| One app owns the memory surface | Multiple agents, harnesses, SDKs, MCP clients, or internal apps need the same context |
| Vendor-managed ranking is acceptable | You need to inspect and tune recall policy around your own sources |
| You cannot run a daemon or own backups yet | You need an exportable workspace you can inspect, back up, and move |

## Operating tradeoff

Signet is infrastructure, not a hosted shortcut. You run a local or self-hosted
daemon, choose an embedding provider, back up `$SIGNET_WORKSPACE/`, and connect
your harnesses through hooks, MCP, connectors, or SDKs.

The trade is deliberate: you operate the memory layer, and in return you can
inspect, repair, scope, self-host, back up, and move the context your agents
depend on.

For a single-developer install, day two is usually `signet status`, a workspace
backup, and rerunning setup when you add or replace an agent harness.

## Is Signet right for you?

Use Signet if you want:
- agents that remember across sessions without prompt bootstrapping
- memory your team can inspect, repair, scope, and self-host
- source-backed recall across private docs, repos, conversations, and artifacts
- one memory layer across agent harnesses, MCP clients, SDKs, and custom apps

Signet may be overkill if you only need short-lived chat memory inside a
single hosted assistant or a simple vector search endpoint.

## Harness support

Signet is not trying to win by being another agent shell. It runs underneath
the tools people already use and gives them one owned memory layer.

| Harness | Integration path | Notes |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Hooks + MCP | Direct `/remember` and `/recall` skills |
| [OpenCode](https://github.com/sst/opencode) | Plugin + hooks | Runtime plugin with lifecycle support |
| [OpenClaw](https://github.com/openclaw/openclaw) | Runtime plugin | Flagship path; hooks available for legacy setups |
| [Codex](https://github.com/openai/codex) | MCP + compatibility hooks | MCP-first integration; plugin bundle when available |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Memory provider plugin | `memory_*`, `recall`, and `remember` tools |
| [Pi](https://github.com/mariozechner/pi-coding-agent) | Extension + hooks | Memory commands and agent-callable tools |
| Oh My Pi | Managed extension | Lifecycle recall injection through the managed extension |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | MCP + GEMINI.md sync | On-demand tools plus identity sync |


> Don't see your favorite harness? file an [issue](https://github.com/Signet-AI/signetai/issues) and request that it be added!

## Memory that holds up

Signet's latest tracked MemoryBench run averages **97.6% LongMemEval answer
accuracy** under the `rules` profile.

The benchmark matters because local custody should not mean weak recall.
Signet is designed to retrieve the right facts across long-running,
multi-session conversations while keeping memory inspectable and repairable.

That profile keeps the benchmark contract strict: memories are ingested through
`/api/memory/remember`, recalled through `/api/memory/recall`, and answered
from bounded daemon recall results. Search does not call an LLM.

See [Benchmarks](./docs/BENCHMARKING.md#current-longmemeval-score) for the
methodology, scoring note, and run workflow.

## Install (detailed)

```bash
curl -fsSL https://signetai.sh/install.sh | bash
npm install -g signetai
bun add -g signetai
signet setup               # interactive setup wizard
```

curl, npm, and Bun all install the same compiled Signet binary. The npm and
Bun package-manager paths install the `signetai` wrapper plus a platform
native package tarball from the same GitHub release. Install scripts only link
the native binary into place; if scripts are disabled, the wrapper resolves the
native package directly. They do not install Bun, rebuild Signet, or install
daemon dependencies.
Published native binaries currently cover Linux x64, Linux arm64, macOS x64,
macOS arm64, and Windows x64. Windows direct installs should use
`npm install -g signetai`; the old PowerShell `install.ps1` path has been
removed until a native Windows direct installer ships.

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
signet remember "deploy window is Fridays" --agent alice --private
signet recall "deploy window" --agent alice  # scoped to alice's visible memories
signet agent info alice                    # identity files, policy, memory count
```

Use the secrets subsystem for credentials. Do not store tokens or keys as
recallable memories.

OpenClaw users get zero-config routing — session keys like
`agent:alice:discord:direct:u123` are parsed automatically; no
`agentId` header needed.

In harnesses with command-style integrations, skills work directly:

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
  claude-code, opencode, openclaw, codex, gemini, oh-my-pi, pi,
  hermes-agent
```

## Repository map

See [Repository Map](./docs/REPO_MAP.md) for package layout, internal
surfaces, and ownership boundaries.

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
| [Lossless Context Management](https://papers.voltropy.com/LCM) (Voltropy, 2026) | Hierarchical summarization, guaranteed convergence. Related runtime notes live in [lossless-working-memory-runtime.md](./docs/specs/approved/lossless-working-memory-runtime.md). |
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
cd platform/daemon && bun run dev     # Daemon dev (watch mode)
cd surfaces/dashboard && bun run dev  # Dashboard dev
```

Requirements:

- Bun for normal repo development
- Node.js 18+ for Node-targeted package surfaces
- macOS or Linux
- Optional for harness integrations: Claude Code, Codex, OpenCode, OpenClaw,
  Gemini CLI, Pi, Oh My Pi, or Hermes Agent

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

Made with love by...

<a href="https://github.com/NicholaiVogel"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/217880623?v=4&s=48" width="48" height="48" alt="NicholaiVogel" title="NicholaiVogel" /></a> <a href="https://github.com/BusyBee3333"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/241850310?v=4&s=48" width="48" height="48" alt="BusyBee3333" title="BusyBee3333" /></a> <a href="https://github.com/stephenwoska2-cpu"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/258141506?v=4&s=48" width="48" height="48" alt="stephenwoska2-cpu" title="stephenwoska2-cpu" /></a> <a href="https://github.com/PatchyToes"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/256889430?v=4&s=48" width="48" height="48" alt="PatchyToes" title="PatchyToes" /></a> <a href="https://github.com/aaf2tbz"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/260091788?v=4&s=48" width="48" height="48" alt="aaf2tbz" title="aaf2tbz" /></a> <a href="https://github.com/ddasgupta4"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/ddasgupta4?v=4&s=48" width="48" height="48" alt="ddasgupta4" title="ddasgupta4" /></a> <a href="https://github.com/alcar2364"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/alcar2364?v=4&s=48" width="48" height="48" alt="alcar2364" title="alcar2364" /></a> <a href="https://github.com/maximhar"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/maximhar?v=4&s=48" width="48" height="48" alt="maximhar" title="maximhar" /></a> <a href="https://github.com/lost-orchard"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/lost-orchard?v=4&s=48" width="48" height="48" alt="lost-orchard" title="lost-orchard" /></a> <a href="https://github.com/Ostico"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/8008416?v=4&s=48" width="48" height="48" alt="Ostico" title="Ostico" /></a> <a href="https://github.com/gpzack"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/271398594?v=4&s=48" width="48" height="48" alt="gpzack" title="gpzack" /></a> <a href="https://github.com/LeuciRemi"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/44776125?v=4&s=48" width="48" height="48" alt="LeuciRemi" title="LeuciRemi" /></a> <a href="https://github.com/nyashkn"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/1158551?v=4&s=48" width="48" height="48" alt="nyashkn" title="nyashkn" /></a> <a href="https://github.com/dragontvstaff"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/279829920?v=4&s=48" width="48" height="48" alt="dragontvstaff" title="dragontvstaff" /></a> <a href="https://github.com/Alexi5000"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/135995822?v=4&s=48" width="48" height="48" alt="Alexi5000" title="Alexi5000" /></a> <a href="https://github.com/Jarvis-ORC-HPS"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/273477147?v=4&s=48" width="48" height="48" alt="Jarvis-ORC-HPS" title="Jarvis-ORC-HPS" /></a> <a href="https://github.com/nanookclaw"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/258741235?v=4&s=48" width="48" height="48" alt="nanookclaw" title="nanookclaw" /></a>
<br clear="left" />

## License

Apache-2.0.

---

[signetai.sh](https://signetai.sh) ·
[docs](https://signetai.sh/docs) ·
[spec](https://signetai.sh/spec) ·
[discussions](https://github.com/Signet-AI/signetai/discussions) ·
[issues](https://github.com/Signet-AI/signetai/issues)
