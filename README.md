<div align="center">

<img src="public/Signet-Logo-White.png" alt="Signet" width="120" />

# S I G N E T   A I

**Local-first persistent memory for AI agents**

<a href="https://github.com/Signet-AI/signetai/actions"><img src="https://img.shields.io/github/actions/workflow/status/Signet-AI/signetai/release.yml?branch=main&style=for-the-badge" alt="CI status"></a>
<a href="https://github.com/Signet-AI/signetai/releases"><img src="https://img.shields.io/github/v/release/Signet-AI/signetai?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
<a href="https://www.npmjs.com/package/signetai"><img src="https://img.shields.io/npm/v/signetai?style=for-the-badge" alt="npm"></a>
<a href="https://github.com/Signet-AI/signetai/discussions"><img src="https://img.shields.io/github/discussions/Signet-AI/signetai?style=for-the-badge" alt="Discussions"></a>
<a href="https://discord.gg/pHa5scah9C"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge" alt="Apache-2.0 License"></a>
<a href="https://github.com/openclaw/openclaw"><img src="https://img.shields.io/badge/OpenClaw-Compatible-orange?style=for-the-badge" alt="OpenClaw Compatible"></a>

[Website](https://signetai.sh) · [Docs](https://signetai.sh/docs) · [Vision](VISION.md) · [Discussions](https://github.com/Signet-AI/signetai/discussions) · [Discord](https://discord.gg/pHa5scah9C) · [Contributing](docs/CONTRIBUTING.md) · [AI Policy](AI_POLICY.md)

</div>

---

**Persistent memory for AI agents, across sessions, tools, and environments.**

**TL;DR**
- Installs under your existing harness, not instead of it
- Captures and injects relevant memory automatically between sessions
- Runs local-first, with inspectable storage and no vendor lock-in

Most agents only remember when explicitly told to.

That is not memory, that's a filing cabinet.

Signet makes memory ambient. It extracts and injects context
automatically, between sessions, before the next prompt starts.
Your agent just has memory.

Structured memory, graph traversal, and hybrid retrieval matter, but
they are not the point. They are substrate for the larger job Signet is
building toward: deciding what should enter the model's context window
right now, with enough precision to help instead of distract.

Why teams adopt it:
- less prompt re-explaining between sessions
- one memory layer across Claude Code, OpenCode, OpenClaw, and Codex
- clear visibility into what was recalled, why, and from which scope

**Benchmark note:** early LoCoMo results show **87.5% answer accuracy**
and **100% Hit@10 retrieval** on an **8-question full-stack sample**.
Larger evaluation runs are in progress. [Details](#locomo-benchmark)

## Quick start (about 5 minutes)

```bash
bun add -g signetai        # or: npm install -g signetai
signet setup               # interactive setup wizard
signet status              # confirm daemon + pipeline health
signet dashboard           # open memory + retrieval inspector
```

If you already use Claude Code, OpenCode, OpenClaw, or Codex, keep your
existing harness. Signet installs under it.

### Docker self-hosting

Run Signet as a containerized daemon with first-party Compose assets:

```bash
cd deploy/docker
cp .env.example .env
docker compose up -d --build
```

See [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) for token bootstrap,
backup, and upgrade runbook details.

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
| 🧠 Ambient memory extraction | Sessions are distilled automatically, no memory tool calls required |
| 🎯 Predictive context selection | Structured memory and session feedback build toward a scorer that learns what context is actually useful |
| 💾 Session continuity | Checkpoint and transcript-backed context carried across sessions |
| 🏠 Local-first storage | Data lives on your machine in SQLite and markdown, portable by default |
| 🤝 Cross-harness runtime | Claude Code, OpenCode, OpenClaw, Codex, one shared memory substrate |

## Is Signet right for you?

Use Signet if you want:
- memory continuity across sessions without manual prompt bootstrapping
- local ownership of agent state and history
- one memory layer across multiple agent harnesses

Signet may be overkill if you only need short-lived chat memory inside a
single hosted assistant.

## Why you can trust this

- runs local-first by default
- memory is stored in SQLite + markdown
- recall is inspectable with provenance and scopes
- memory can be repaired (edit, supersede, delete, reclassify)
- no vendor lock-in, your data stays portable

## What keeps it reliable

These systems improve quality and reliability of the core memory loop:

| Supporting | What it does |
|---|---|
| 📜 Lossless transcripts | Raw session history preserved alongside extracted memories |
| 🕸️ Structured retrieval substrate | Graph traversal + FTS5 + vector search produce bounded candidate context |
| 🎯 Predictive scorer | Wired into the system as a maturing path toward learned reranking from session outcomes, including regret signals |
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
| 📦 SDK + middleware | Typed client, React hooks, and Vercel AI SDK middleware |
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

Signet is not a harness. It doesn't replace Claude Code, OpenClaw, or
OpenCode — it runs alongside them as an enhancement. Bring the harness
you already use. Signet handles the memory layer underneath it.

| Harness | Status | Integration |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | **Supported** | Hooks |
| Forge | **First-party** | Native runtime / reference harness |
| [OpenCode](https://github.com/sst/opencode) | **Supported** | Plugin + Hooks |
| [OpenClaw](https://github.com/openclaw/openclaw) | **Supported** | Runtime plugin + NemoClaw compatible |
| [Codex](https://github.com/openai/codex) | **Supported** | Hooks + MCP server |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Planned | — |


> Don't see your favorite harness? file an [issue](https://github.com/Signet-AI/signetai/issues) and request that it be added!

## LoCoMo Benchmark

[LoCoMo](https://arxiv.org/abs/2402.17753) is the standard benchmark
for conversational memory systems. No standardized leaderboard exists —
each system uses different judge models, question subsets, and evaluation
prompts. These numbers are collected from published papers and repos.

| Rank | System | Score | Metric | Open Source | Local? | LLM at Search? |
|------|--------|-------|--------|-------------|--------|----------------|
| 1 | [Kumiho](https://arxiv.org/abs/2603.17244) | 97.5% adv, 0.565 F1 | Official F1 + adv subset | SDK open | No | Yes |
| 2 | EverMemOS | 93.05% | Judge (self-reported) | No | No | Yes |
| 3 | [MemU](https://memu.pro/benchmark) | 92.09% | Judge | Yes | No | Yes |
| 4 | MemMachine | 91.7% | Judge | No | No | Yes |
| 5 | [Hindsight](https://arxiv.org/abs/2512.12818) | 89.6% | Judge | Yes (MIT) | No | Yes |
| 6 | [SLM V3 Mode C](https://arxiv.org/abs/2603.14588) | 87.7% | Judge | Yes (MIT) | Partial | Yes |
| 7 | **Signet** | **87.5%** | **Judge (GPT-4o)** | **Yes (Apache)** | **Yes** | **No** |
| 8 | [Zep/Graphiti](https://arxiv.org/abs/2501.13956) | ~85% | Judge (third-party est) | Partial | No | Yes |
| 9 | [Letta/MemGPT](https://letta.com) | ~83% | Judge | Yes (Apache) | No | Yes |
| 10 | [Engram](https://arxiv.org/abs/2511.12960) | 80% | Judge | Yes | No | Yes |
| 11 | [SLM V3 Mode A](https://arxiv.org/abs/2603.14588) | 74.8% | Judge | Yes (MIT) | Yes | No |
| 12 | [Mem0+Graph](https://arxiv.org/abs/2504.19413) | 68.4% | J-score (disputed) | Partial | No | Yes |
| 13 | [SLM Zero-LLM](https://arxiv.org/abs/2603.14588) | 60.4% | Judge | Yes (MIT) | Yes | No |
| 14 | [Mem0](https://mem0.ai) (independent) | ~58% | Judge | Partial | No | Yes |

**Current Signet run: 87.5% answer accuracy, 100% Hit@10 retrieval, MRR 0.615 on an 8-question sample.**

We treat this as an encouraging early signal, not a final claim. The sample
size is small and larger-scale runs are in progress.

What this result does show today:
- retrieval hit rate was 100% for this run (no empty recalls)
- the correct supporting memory typically surfaced near the top (MRR 0.615)
- search-time recall operated without extra LLM inference calls

See [Benchmarks](./docs/BENCHMARKS.md) for methodology, progression, and
how to run your own evaluation.

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

```
session ends
  → raw transcript is preserved and distilled into structured memory
  → entities, constraints, and relations are linked into a navigable graph
  → traversal + flat search build a bounded candidate pool
  → predictive scorer reranks candidates against your interaction patterns
  → fail-open guards keep baseline ordering if the model is cold or unavailable
  → post-fusion dampening separates signal from noise
  → right context injected before the next prompt starts
```

No configuration required. No tool calls. The pipeline runs in the
background and the agent wakes up with its memory intact.

Read more: [Why Signet](./docs/QUICKSTART.md#why-signet) · [Architecture](./docs/ARCHITECTURE.md) · [Knowledge Graph](./docs/KNOWLEDGE-GRAPH.md) · [Pipeline](./docs/PIPELINE.md)

## Architecture

```text
CLI (signet)
  setup, knowledge, secrets, skills, hooks, git sync, service mgmt

Daemon (@signet/daemon, localhost:3850)
  |-- HTTP API (modular endpoints for memory, retrieval, auth, and tooling)
  |-- Distillation Layer
  |     extraction -> decision -> graph -> retention
  |-- Retrieval
  |     traversal + flat search -> fusion -> dampening
  |-- Lossless Transcripts
  |     raw session storage -> expand-on-recall join
  |-- Hints Worker
  |     prospective indexing -> FTS5 index
  |-- Inline Entity Linker
  |     write-time entity extraction (no LLM), decision auto-protection
  |-- Predictive Scorer
  |     learned relevance model over structured candidates
  |-- Document Worker
  |     ingest -> chunk -> embed -> index
  |-- MCP Server
  |     tool registration, aggregation, blast radius endpoint
  |-- Auth Middleware
  |     local / team / hybrid, RBAC, rate limiting
  |-- File Watcher
        identity sync, per-agent workspace sync, git auto-commit
  |-- Multi-Agent
        roster sync, agent_id scoping, read-policy SQL enforcement

Core (@signet/core)
  types, identity, SQLite, hybrid search, graph traversal

SDK (@signet/sdk)
  typed client, React hooks, Vercel AI SDK middleware

Connectors
  claude-code, opencode, openclaw, codex, forge
```

## Packages

| Package | Role |
|---|---|
| [`@signet/core`](./packages/core) | Types, identity, SQLite, hybrid + graph search |
| [`@signet/cli`](./packages/cli) | CLI, setup wizard, dashboard |
| [`@signet/daemon`](./packages/daemon) | API server, distillation layer, auth, analytics, diagnostics |
| [`@signet/sdk`](./packages/sdk) | Typed client, React hooks, Vercel AI SDK middleware |
| [`packages/forge`](./packages/forge) | Forge native terminal harness and reference runtime implementation |
| [`@signet/connector-base`](./packages/connector-base) | Shared connector primitives and utilities |
| [`@signet/connector-claude-code`](./packages/connector-claude-code) | Claude Code integration |
| [`@signet/connector-opencode`](./packages/connector-opencode) | OpenCode integration |
| [`@signet/connector-openclaw`](./packages/connector-openclaw) | OpenClaw integration |
| [`@signet/connector-codex`](./packages/connector-codex) | Codex CLI integration |
| [`@signet/opencode-plugin`](./packages/opencode-plugin) | OpenCode runtime plugin — memory tools and session hooks |
| [`@signetai/signet-memory-openclaw`](./packages/adapters/openclaw) | OpenClaw runtime plugin |
| [`@signet/extension`](./packages/extension) | Browser extension for Chrome and Firefox |
| [`@signet/tray`](./packages/tray) | Desktop system tray application |
| [`@signet/native`](./packages/native) | Native accelerators |
| [`predictor`](./packages/predictor) | Predictive memory scorer sidecar (Rust) |
| [`signetai`](./packages/signetai) | Meta-package (`signet` binary) |

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
- [Benchmarks](./docs/BENCHMARKS.md)
- [Roadmap](./ROADMAP.md)

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
cd packages/daemon && bun run dev        # Daemon dev (watch mode)
cd packages/cli/dashboard && bun run dev # Dashboard dev
```

Requirements: Node.js 18+, Bun, Ollama (recommended) or OpenAI API key. macOS or Linux.

## Contributing

New to open source? Start with [Your First PR](./docs/FIRST-PR.md).
For code conventions and project structure, see
[CONTRIBUTING.md](./docs/CONTRIBUTING.md). Open an issue before
contributing significant features. Read the
[AI Policy](./AI_POLICY.md) before submitting AI-assisted work.

## Contributors

<p align="left">
  <a href="https://github.com/NicholaiVogel"><img src="https://avatars.githubusercontent.com/u/217880623?v=4&s=48" width="48" height="48" alt="NicholaiVogel" title="NicholaiVogel"/></a> <a href="https://github.com/BusyBee3333"><img src="https://avatars.githubusercontent.com/u/241850310?v=4&s=48" width="48" height="48" alt="BusyBee3333" title="BusyBee3333"/></a> <a href="https://github.com/stephenwoska2-cpu"><img src="https://avatars.githubusercontent.com/u/258141506?v=4&s=48" width="48" height="48" alt="stephenwoska2-cpu" title="stephenwoska2-cpu"/></a> <a href="https://github.com/PatchyToes"><img src="https://avatars.githubusercontent.com/u/256889430?v=4&s=48" width="48" height="48" alt="PatchyToes" title="PatchyToes"/></a> <a href="https://github.com/aaf2tbz"><img src="https://avatars.githubusercontent.com/u/260091788?v=4&s=48" width="48" height="48" alt="aaf2tbz" title="aaf2tbz"/></a> <a href="https://github.com/ddasgupta4"><img src="https://avatars.githubusercontent.com/ddasgupta4?v=4&s=48" width="48" height="48" alt="ddasgupta4" title="ddasgupta4"/></a> <a href="https://github.com/alcar2364"><img src="https://avatars.githubusercontent.com/alcar2364?v=4&s=48" width="48" height="48" alt="alcar2364" title="alcar2364"/></a>
</p>

## License

Apache-2.0.

---

[signetai.sh](https://signetai.sh) ·
[docs](https://signetai.sh/docs) ·
[spec](https://signetai.sh/spec) ·
[discussions](https://github.com/Signet-AI/signetai/discussions) ·
[issues](https://github.com/Signet-AI/signetai/issues)
