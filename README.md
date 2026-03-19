<div align="center">

<img src="public/Signet-Logo-White.png" alt="Signet" width="120" />

# S I G N E T

**Portable Agent Infrastructure**

<a href="https://github.com/Signet-AI/signetai/actions"><img src="https://img.shields.io/github/actions/workflow/status/Signet-AI/signetai/release.yml?branch=main&style=for-the-badge" alt="CI status"></a>
<a href="https://github.com/Signet-AI/signetai/releases"><img src="https://img.shields.io/github/v/release/Signet-AI/signetai?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
<a href="https://www.npmjs.com/package/signetai"><img src="https://img.shields.io/npm/v/signetai?style=for-the-badge" alt="npm"></a>
<a href="https://github.com/Signet-AI/signetai/discussions"><img src="https://img.shields.io/github/discussions/Signet-AI/signetai?style=for-the-badge" alt="Discussions"></a>
<a href="https://discord.gg/pHa5scah9C"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge" alt="Apache-2.0 License"></a>

[Website](https://signetai.sh) · [Docs](https://signetai.sh/docs) · [Vision](VISION.md) · [Discussions](https://github.com/Signet-AI/signetai/discussions) · [Discord](https://discord.gg/pHa5scah9C) · [Contributing](docs/CONTRIBUTING.md) · [AI Policy](AI_POLICY.md)

</div>

---

**Your agent is an investment. Signet is where its value accumulates.**

Signet is a persistent cognition layer for AI agents. It gives your
agent memory that works the way memory actually works — ambient,
automatic, and not dependent on the agent deciding to remember.
Your agent doesn't call a "save memory" tool. It doesn't search a
database when it needs context. Signet extracts knowledge after
sessions, builds a knowledge graph, and injects the right context
before every prompt. The agent just has its memory. Like you have yours.

Everything runs locally. You own the data. The agent is yours.

<table>
<tr>
<td><img src="public/signetposter-01.jpg" alt="Signet — your AI has a memory, you don't own it" height="280" /></td>
<td><img src="public/memory-loop-v2.jpg" alt="Signet memory loop — extraction, decision, and retention flow" height="280" /></td>
</tr>
</table>

## Harness support

| Harness | Status | Integration |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | **Supported** | Hooks + CLAUDE.md sync |
| [OpenCode](https://github.com/sst/opencode) | **Supported** | Plugin + AGENTS.md sync |
| [OpenClaw](https://github.com/openclaw/openclaw) | **Supported** | Runtime plugin + NemoClaw compatible |
| [Codex](https://github.com/openai/codex) | In progress | WIP |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Planned | — |

## Install

```bash
bun add -g signetai        # or: npm install -g signetai
signet setup               # interactive setup wizard
```

The wizard initializes `~/.agents/`, configures your harnesses, sets up
an embedding provider, creates the database, and starts the daemon.

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

In connected harnesses, skills work directly:

```text
/remember critical: never commit secrets to git
/recall release process
```

## How it works

At the end of every conversation, a distillation engine reviews the
session and extracts structured insights — no tool calls, no agent
involvement. A knowledge graph maps how those insights connect. A
predictive scorer, trained on your interaction patterns, injects the
right context before every prompt.

Your agent doesn't manage its memory. It just has it.

Read more: [Why Signet](./docs/QUICKSTART.md#why-signet) · [Architecture](./docs/ARCHITECTURE.md) · [Knowledge Graph](./docs/KNOWLEDGE-GRAPH.md) · [Pipeline](./docs/PIPELINE.md)

## Architecture

```text
CLI (signet)
  setup, knowledge, secrets, skills, hooks, git sync, service mgmt

Daemon (@signet/daemon, localhost:3850)
  |-- HTTP API (90+ endpoints across 18 domains)
  |-- Distillation Layer
  |     extraction -> decision -> graph -> retention
  |-- Predictive Scorer
  |     entity-weight traversal, per-user trained model
  |-- Document Worker
  |     ingest -> chunk -> embed -> index
  |-- Auth Middleware
  |     local / team / hybrid, RBAC, rate limiting
  |-- File Watcher
        identity sync, git auto-commit

Core (@signet/core)
  types, identity, SQLite, hybrid search, graph traversal

SDK (@signet/sdk)
  typed client, React hooks, Vercel AI SDK middleware

Connectors
  claude-code, opencode, openclaw
```

## Packages

| Package | Role |
|---|---|
| [`@signet/core`](./packages/core) | Types, identity, SQLite, hybrid + graph search |
| [`@signet/cli`](./packages/cli) | CLI, setup wizard, dashboard |
| [`@signet/daemon`](./packages/daemon) | API server, distillation layer, auth, analytics, diagnostics |
| [`@signet/sdk`](./packages/sdk) | Typed client, React hooks, Vercel AI SDK middleware |
| [`@signet/connector-claude-code`](./packages/connector-claude-code) | Claude Code integration |
| [`@signet/connector-opencode`](./packages/connector-opencode) | OpenCode integration |
| [`@signet/connector-openclaw`](./packages/connector-openclaw) | OpenClaw integration |
| [`@signetai/adapter-openclaw`](./packages/adapters/openclaw) | OpenClaw runtime plugin |
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
- [Spec Index](./docs/specs/INDEX.md)

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
