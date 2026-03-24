<div align="center">

<img src="public/Signet-Logo-White.png" alt="Signet" width="120" />

# S I G N E T   A I

**Stateful Runtime & Cognition for AI Agents**

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

**87.5% LoCoMo accuracy. 100% retrieval. Zero LLM calls at search time. [See how.](#locomo-benchmark)**

Signet is a persistent cognition and local-first stateful runtime layer
for AI agents. It gives your agent memory that works the way memory
actually works: ambient, automatic, and not dependent on the agent
deciding to remember.

Your agent shouldn't have to call a "save memory" tool. It shouldn't
search a database when it needs context. Signet extracts knowledge after
sessions, builds a knowledge graph, and injects the right context before
every prompt. The agent just has its memory. Like you have yours.

Everything runs locally. You own the data. The agent is yours.

<table>
<tr>
<td><img src="public/signetposter-01.jpg" alt="Signet — your AI has a memory, you don't own it" height="280" /></td>
<td><img src="public/memory-loop-v2.jpg" alt="Signet memory loop — extraction, decision, and retention flow" height="280" /></td>
</tr>
</table>

| Feature | What it does |
|---|---|
| 🖥️ CLI + Dashboard | Manage everything from the terminal or the built-in web UI |
| 🧠 Ambient memory extraction | Sessions distilled automatically — no tool calls, no agent involvement |
| 🕸️ Knowledge graph | Entities and relationships built at write time, traversed at recall |
| 🔬 Post-fusion dampening | Gravity, hub, and resolution filters separate signal from noise at recall |
| 📜 Lossless transcripts | Raw conversations preserved alongside extracted facts, nothing is lost |
| 🎯 Predictive scorer | A model trained on your patterns decides what context to inject |
| 🏠 Local-first | Extraction, embeddings, and storage run entirely on your machine |
| 🔐 Secrets vault | API keys and tokens stored encrypted — the agent never sees them |
| 🛠️ Skills | Installable, version-controlled capabilities your agent carries everywhere |
| 🪪 Identity persistence | Same agent across sessions, platforms, and parallel runs |
| 💾 Session continuity | Checkpoint-based recovery — the agent wakes up knowing what happened |
| 👯 Multi-agent | Multiple named agents sharing one install — isolated, shared, or group memory policies |
| 📄 Document ingestion | Feed PDFs, markdown, and URLs directly into the memory pipeline |
| 🔄 Git sync | Identity and memory auto-committed to your own repo — no vendor lock-in |
| 🗄️ Open storage | All memory lives in SQLite and plain markdown — inspect, migrate, or script it yourself |
| ⚖️ Apache 2.0 | Fully open source — use it, fork it, build on it |
| 📦 SDK | Typed client, React hooks, and Vercel AI SDK middleware for building on top of Signet |
| 🤝 Works with any harness | Claude Code, OpenClaw, OpenCode, Codex — bring what you use, Signet runs underneath |
| 🔌 MCP server aggregation | Configure your MCP servers once — every connected harness gets them automatically |
| 🏪 Marketplace | Browse and install community skills and MCP servers from [skills.sh](https://skills.sh) and [ClawHub](https://clawhub.ai) |
| 👥 Team auth | RBAC, token-based access, and rate limiting for shared deployments |

## Harness support

Signet is not a harness. It doesn't replace Claude Code, OpenClaw, or
OpenCode — it runs alongside them as an enhancement. Bring the harness
you already use. Signet handles the memory layer underneath it.

| Harness | Status | Integration |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | **Supported** | Hooks |
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

**87.5% accuracy on an 8-question full-stack sample. 100% retrieval. Zero inference at search time.**

100% Hit@10 means Signet found relevant context for every single question.
Not one miss. The retrieval layer never came up empty. Every query walked
the graph or searched and came back with something useful.

The 13% gap between "found the right memories" and "answered correctly" is
prompt engineering and judge semantics, not retrieval failure. The single
incorrect answer had the right memory at rank 3.

MRR of 0.615 means the correct memory lands in the top 2 results on
average. That's graph traversal doing its job, putting structurally
relevant context at the top instead of hoping embeddings sort it out.

This is a local-first, single-query system running on SQLite. No fleet of
reader agents, no million-token context windows, no cloud dependency. Every
system above Signet on this table requires cloud infrastructure, LLM calls
at search time, or both.

See [Benchmarks](./docs/BENCHMARKS.md) for methodology, progression, and
how to run your own evaluation.

## Install

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

### Use it

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
  → distillation engine extracts entities, facts, and relationships
  → knowledge graph links them to existing memory
  → decisions auto-detected and promoted to always-surface constraints
  → raw transcript preserved alongside extracted facts (lossless retention)
  → predictive scorer ranks candidates against your interaction patterns
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
  |-- HTTP API (90+ endpoints across 18 domains)
  |-- Distillation Layer
  |     extraction -> decision -> graph -> retention
  |-- Retrieval
  |     traversal-primary -> cosine re-scoring -> dampening -> hybrid fallback
  |-- Lossless Transcripts
  |     raw session storage -> expand-on-recall join
  |-- Hints Worker
  |     prospective indexing -> FTS5 index
  |-- Inline Entity Linker
  |     write-time entity extraction (no LLM), decision auto-protection
  |-- Predictive Scorer
  |     entity-weight traversal, per-user trained model
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
  claude-code, opencode, openclaw, codex
```

## Packages

| Package | Role |
|---|---|
| [`@signet/core`](./packages/core) | Types, identity, SQLite, hybrid + graph search |
| [`@signet/cli`](./packages/cli) | CLI, setup wizard, dashboard |
| [`@signet/daemon`](./packages/daemon) | API server, distillation layer, auth, analytics, diagnostics |
| [`@signet/sdk`](./packages/sdk) | Typed client, React hooks, Vercel AI SDK middleware |
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

See [`CONTRIBUTING.md`](./docs/CONTRIBUTING.md). Build on existing patterns.
Open an issue before contributing significant features. Read the
[AI Policy](./AI_POLICY.md) before submitting AI-assisted work.

## Contributors

<p align="left">
  <a href="https://github.com/NicholaiVogel"><img src="https://avatars.githubusercontent.com/u/217880623?v=4&s=48" width="48" height="48" alt="NicholaiVogel" title="NicholaiVogel"/></a> <a href="https://github.com/BusyBee3333"><img src="https://avatars.githubusercontent.com/u/241850310?v=4&s=48" width="48" height="48" alt="BusyBee3333" title="BusyBee3333"/></a> <a href="https://github.com/stephenwoska2-cpu"><img src="https://avatars.githubusercontent.com/u/258141506?v=4&s=48" width="48" height="48" alt="stephenwoska2-cpu" title="stephenwoska2-cpu"/></a> <a href="https://github.com/PatchyToes"><img src="https://avatars.githubusercontent.com/u/256889430?v=4&s=48" width="48" height="48" alt="PatchyToes" title="PatchyToes"/></a> <a href="https://github.com/aaf2tbz"><img src="https://avatars.githubusercontent.com/u/260091788?v=4&s=48" width="48" height="48" alt="aaf2tbz" title="aaf2tbz"/></a>
</p>

## License

Apache-2.0.

---

[signetai.sh](https://signetai.sh) ·
[docs](https://signetai.sh/docs) ·
[spec](https://signetai.sh/spec) ·
[discussions](https://github.com/Signet-AI/signetai/discussions) ·
[issues](https://github.com/Signet-AI/signetai/issues)
