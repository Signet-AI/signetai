<div align="center">

<a href="https://signetai.sh/"><img src="public/banner-typography.png" alt="Signet AI"></a>

Signet gives your AI agents a shared memory. Store, sync, and share memories, system prompts, transcripts, institutional knowledge, and secrets across the harnesses and models you use.

<a href="https://github.com/Signet-AI/signetai/releases"><img src="https://img.shields.io/github/v/release/Signet-AI/signetai?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
<a href="https://www.npmjs.com/package/signetai"><img src="https://img.shields.io/npm/v/signetai?style=for-the-badge" alt="npm"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge" alt="Apache-2.0 License"></a>
<a href="https://docs.signetai.sh/benchmarking/#current-longmemeval-score"><img src="https://img.shields.io/badge/LongMemEval-97.6%25-black?style=for-the-badge" alt="LongMemEval 97.6% answer accuracy"></a>

**97.6% average LongMemEval answer accuracy**

[Quick start](https://docs.signetai.sh/quickstart/) · [Why Signet](#why-signet) · [Benchmarks](https://docs.signetai.sh/benchmarking/) · [Docs](https://docs.signetai.sh/quickstart/) · [Discord](https://discord.gg/Psdeg7sQm7)

</div>

---

> Warning: The `nightly` channel is currently unstable. Upgrading to it for production deployments is not advised. Use the stable channel for production.

Signet creates memories automatically from your transcripts, imported files, and other sources. In the background, a process called dreaming builds and maintains a structured map of the people, projects, facts, and relationships in your history. Each connection has an audit trail back to its source.

Your agent gets relevant context before the next prompt begins. When it needs more detail, it can trace that context back to the raw source.

## Why Signet

- Companies: Connect your knowledge sources so agents spend less time learning your business and more time working with what they already know.
- Developers: Keep project context together when you switch models or harnesses. Your agents can work from the same knowledge base instead of starting over in each tool.
- Individuals: Run the same agent across research, journaling, and daily work without re-explaining yourself every session. History compounds instead of resetting.
- Autonomous agents: Scheduled agents, such as a morning brief or a monitoring agent, keep continuity between runs without a human re-priming them each time.
- Agent builders: Add memory to an agent product without building the infrastructure from scratch. The audit trail helps you debug what an agent recalled and where it came from.

Read more: [Why Signet](https://docs.signetai.sh/quickstart/#why-signet) · [Architecture](https://docs.signetai.sh/architecture/) · [Knowledge Graph](https://docs.signetai.sh/knowledge-graph/) · [Pipeline](https://docs.signetai.sh/pipeline/)

## Quick start (about 5 minutes)

### Install Signet

```bash
curl -fsSL https://signetai.sh/install.sh | bash                 # recommended stable install
curl -fsSL https://signetai.sh/install.sh | bash -s -- --nightly # install the latest nightly
```

On Windows x64, run the PowerShell installer:

```powershell
iwr -useb https://signetai.sh/install.ps1 | iex
```

Or: `npm install -g signetai` / `bun add -g signetai`

The npm and Bun wrappers install the same compiled Signet binary through a matching native package.

Don't want to handle setup yourself? Paste this to your AI agent:

```
Install and fully configure Signet AI by following this guide exactly: https://signetai.sh/skill.md
```

Covers Linux x64/arm64, macOS x64/arm64, Windows x64, and Docker.

Durable transcript imports and imported-source deletion support Windows, Linux, and macOS. Uploads resume from durable database checkpoints.

### Setup

```bash
signet setup               # prepare a workspace and open guided dashboard onboarding
signet status                        # confirm daemon + pipeline health
signet dashboard                     # open memory + retrieval inspector
```

## Harness support

Signet runs underneath the tools you already use. Run `signet setup` to prepare a workspace and open guided dashboard onboarding. For scripted configuration, use the noninteractive CLI options. Supported harnesses:

|Harness|Integration path|
|---|---|
|[Claude Code](https://docs.anthropic.com/en/docs/claude-code)|Hooks + MCP|
|[OpenCode](https://github.com/sst/opencode)|Plugin|
|[OpenClaw](https://github.com/openclaw/openclaw)|Plugin|
|[Codex](https://github.com/openai/codex)|Native plugin + hooks/MCP fallback|
|[Kimi Code](https://github.com/MoonshotAI/kimi-cli)|Hooks + MCP / ACPX|
|[Hermes Agent](https://github.com/NousResearch/hermes-agent)|Memory provider plugin|
|[Pi](https://github.com/mariozechner/pi-coding-agent)|Extension|
|Oh My Pi|Extension|
|[Gemini CLI](https://github.com/google-gemini/gemini-cli)|MCP + GEMINI.md sync|
|[ForgeCode](https://forgecode.dev/)|Hooks + MCP|

> Don't see your favorite harness? File an [issue](https://github.com/Signet-AI/signetai/issues) and request that it be added!

<a href="https://signetai.sh/"><img src="public/sources.png" alt="Sources"></a>

Connect knowledge sources or import files into your agent's memory graph. Dreaming uses them to build connections that can surface during recall.

|Source|Notes|
|---|---|
|Obsidian|Real-time file watcher, can be connected to multiple Obsidian vaults, supports the LLM-Wiki format. Useful for connecting your agent's memory directly to shared knowledge bases in a read-only format.|
|Discord|Real-time Discord crawler, contributes to memory and connects to the existing knowledge graph.|
|Github|Real-time ingest of issues, pull requests, and discussions, contributes to memory and connects to the existing knowledge graph.|
|Slack|_coming soon_|
|Email|_coming soon_|
|Telegram|_coming soon_|
|Whatsapp|_coming soon_|
|Webpage imports|_coming soon_|
|Notion|_coming soon_|

Supported formats for one-time import:

|Format|Extensions|
|---|---|
|Word|`.doc`, `.docx`, `.docm`|
|PowerPoint|`.ppt`, `.pps`, `.pot`, `.pptx`, `.pptm`, `.ppsx`, `.ppsm`|
|Excel|`.xls`, `.xlsx`, `.xlsm`, `.xlsb`|
|OpenDocument|`.odt`, `.ods`, `.odp`|
|Rich Text Format|`.rtf`|
|EPUB|`.epub`|
|CSV|`.csv`|
|PDF|`.pdf`|

## Documentation

- [Quickstart](https://docs.signetai.sh/quickstart/)
- [CLI Reference](https://docs.signetai.sh/cli/)
- [Configuration](https://docs.signetai.sh/configuration/)
- Telemetry
- [Hooks](https://docs.signetai.sh/hooks/)
- [Harnesses](https://docs.signetai.sh/harnesses/)
- [Secrets](https://docs.signetai.sh/secrets/)
- [Skills](https://docs.signetai.sh/skills/)
- [Auth](https://docs.signetai.sh/auth/)
- [Dashboard](https://docs.signetai.sh/dashboard/)
- [SDK](https://docs.signetai.sh/sdk/)
- [API Reference](https://docs.signetai.sh/api/)
- [Knowledge Architecture](https://docs.signetai.sh/knowledge-architecture/)
- [Knowledge Graph](https://docs.signetai.sh/knowledge-graph/)
- [Benchmarks](https://docs.signetai.sh/benchmarking/)
- Roadmap
- Repository Map

## Benchmarks

Signet's latest tracked MemoryBench run averages **97.6% LongMemEval answer accuracy**.

Keeping memory local should not mean settling for weak recall. Signet is designed to retrieve relevant facts across long, multi-session conversations while keeping that memory inspectable and repairable.

See [Benchmarks](https://docs.signetai.sh/benchmarking/#current-longmemeval-score) for the methodology, scoring note, and run workflow.

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
- Bun on the process `PATH` for local secrets access from macOS Node runtimes; compiled Signet and the desktop app include their helper runtime
- macOS or Linux
- Optional for harness integrations: Claude Code, Codex, Kimi Code, OpenCode, OpenClaw, Gemini CLI, Pi, Oh My Pi, or Hermes Agent

## Contributing

New to open source? Start with [Your First PR](https://docs.signetai.sh/first-pr/). For code conventions and project structure, see [CONTRIBUTING.md](https://docs.signetai.sh/contributing/). Open an issue before contributing significant features. Read the AI Policy before submitting AI-assisted work.

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

<a href="https://github.com/NicholaiVogel"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/217880623?v=4&s=48" width="48" height="48" alt="NicholaiVogel" title="NicholaiVogel" /></a> <a href="https://github.com/aaf2tbz"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/260091788?v=4&s=48" width="48" height="48" alt="aaf2tbz" title="aaf2tbz" /></a> <a href="https://github.com/Ostico"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/8008416?v=4&s=48" width="48" height="48" alt="Ostico" title="Ostico" /></a> <a href="https://github.com/BusyBee3333"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/241850310?v=4&s=48" width="48" height="48" alt="BusyBee3333" title="BusyBee3333" /></a> <a href="https://github.com/stephenwoska2-cpu"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/258141506?v=4&s=48" width="48" height="48" alt="stephenwoska2-cpu" title="stephenwoska2-cpu" /></a> <a href="https://github.com/PatchyToes"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/256889430?v=4&s=48" width="48" height="48" alt="PatchyToes" title="PatchyToes" /></a> <a href="https://github.com/ddasgupta4"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/ddasgupta4?v=4&s=48" width="48" height="48" alt="ddasgupta4" title="ddasgupta4" /></a> <a href="https://github.com/LeuciRemi"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/44776125?v=4&s=48" width="48" height="48" alt="LeuciRemi" title="LeuciRemi" /></a> <a href="https://github.com/nyashkn"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/1158551?v=4&s=48" width="48" height="48" alt="nyashkn" title="nyashkn" /></a> <a href="https://github.com/Alexi5000"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/135995822?v=4&s=48" width="48" height="48" alt="Alexi5000" title="Alexi5000" /></a> <a href="https://github.com/dragontvstaff"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/279829920?v=4&s=48" width="48" height="48" alt="dragontvstaff" title="dragontvstaff" /></a> <a href="https://github.com/maximhar"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/maximhar?v=4&s=48" width="48" height="48" alt="maximhar" title="maximhar" /></a> <a href="https://github.com/alcar2364"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/alcar2364?v=4&s=48" width="48" height="48" alt="alcar2364" title="alcar2364" /></a> <a href="https://github.com/noamsiegel"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/52804845?v=4&s=48" width="48" height="48" alt="noamsiegel" title="noamsiegel" /></a> <a href="https://github.com/lost-orchard"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/lost-orchard?v=4&s=48" width="48" height="48" alt="lost-orchard" title="lost-orchard" /></a> <a href="https://github.com/gpzack"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/271398594?v=4&s=48" width="48" height="48" alt="gpzack" title="gpzack" /></a> <a href="https://github.com/Jarvis-ORC-HPS"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/273477147?v=4&s=48" width="48" height="48" alt="Jarvis-ORC-HPS" title="Jarvis-ORC-HPS" /></a> <a href="https://github.com/nanookclaw"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/258741235?v=4&s=48" width="48" height="48" alt="nanookclaw" title="nanookclaw" /></a> <a href="https://github.com/quannon"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/5967?v=4&s=48" width="48" height="48" alt="quannon" title="quannon" /></a> <a href="https://github.com/arnavgoel17"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/136158339?v=4&s=48" width="48" height="48" alt="arnavgoel17" title="arnavgoel17" /></a> <a href="https://github.com/glen-tl"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/270518453?v=4&s=48" width="48" height="48" alt="glen-tl" title="glen-tl" /></a> <a href="https://github.com/mikemikimike"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/186855910?v=4&s=48" width="48" height="48" alt="mikemikimike" title="mikemikimike" /></a>
<br clear="left" />

## License

Apache-2.0.

---

[signetai.sh](https://signetai.sh) ·
[docs](https://docs.signetai.sh) ·
[spec](https://signetai.sh/spec) ·
[discussions](https://github.com/Signet-AI/signetai/discussions) ·
[issues](https://github.com/Signet-AI/signetai/issues)
