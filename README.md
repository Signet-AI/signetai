<div align="center">

<a href="https://signetai.sh/"><img src="public/banner-typography.png" alt="Signet AI"></a>

**Store, sync and share memories, system prompts, transcripts, institutional knowledge, and secrets between all of your favorite harnesses and models.**

<a href="https://github.com/Signet-AI/signetai/releases"><img src="https://img.shields.io/github/v/release/Signet-AI/signetai?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
<a href="https://www.npmjs.com/package/signetai"><img src="https://img.shields.io/npm/v/signetai?style=for-the-badge" alt="npm"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge" alt="Apache-2.0 License"></a>
<a href="https://docs.signetai.sh/benchmarking/#current-longmemeval-score"><img src="https://img.shields.io/badge/LongMemEval-97.6%25-black?style=for-the-badge" alt="LongMemEval 97.6% answer accuracy"></a>

**97.6% average LongMemEval answer accuracy**

[Quick start](https://docs.signetai.sh/quickstart/) · [Why Signet](#why-signet) · [Benchmarks](https://docs.signetai.sh/benchmarking/) · [Docs](https://docs.signetai.sh/quickstart/) · [Discord](https://discord.gg/Psdeg7sQm7)

</div>

---

Signet automatically creates memories from your transcripts, imported files, and other sources. Memories are built and maintained in the background by a process called **dreaming**, which constructs a living semantic ontology—a structured representation of your world—on top of your raw history. This turns an agent's transcripts and data into connected memory with an audit trail back to the source.

The result: the agent gets the right context _before_ the next prompt starts, with a path back to the raw source when deeper context is needed.

This is useful for:

- **Company brains**—Connect Signet to all the tools in your existing stack, and watch your agents spend less time learning your business and more time being useful to it.
- **Developers**—Managing projects across different models and harnesses usually means context gets fragmented across each one. With Signet, ChatGPT, Claude, Hermes, and Pi can all work off the same shared knowledge base. Your agents suddenly know what's going on, and how they fit into the bigger picture.
- **Individuals**—Research, journaling, daily work: run the same agent across all of it without re-explaining yourself every session. History compounds instead of resetting.
- **Autonomous agents**—Scheduled agents that run unattended, like a morning-brief or monitoring agent, keep continuity between runs without a human re-priming them each time.
- **Agent builders**—Ship an agent product without building memory infrastructure from scratch. Signet is the memory layer underneath, with the audit trail doubling as a debugging and trust feature.

Read more: [Why Signet](https://docs.signetai.sh/quickstart/#why-signet) · [Architecture](https://docs.signetai.sh/architecture/) · [Knowledge Graph](https://docs.signetai.sh/knowledge-graph/) · [Pipeline](https://docs.signetai.sh/pipeline/)

## Quick start (about 5 minutes)

### Install Signet

```bash
curl -fsSL https://signetai.sh/install.sh | bash                 # recommended
```

Or: `npm install -g signetai` / `bun add -g signetai`

Don't want to handle setup yourself? Paste this to your AI agent:

```
Install and fully configure Signet AI by following this guide exactly: https://signetai.sh/skill.md
```

Covers Linux x64/arm64, macOS x64/arm64, Docker, and Windows x64 (Windows: use `npm install -g signetai` or Docker).

Durable transcript imports require Linux or macOS filesystem safeguards. The
Windows package remains supported for other Signet features; transcript import
mutations and imported-source deletion return a structured `501` platform error.

### Setup

```bash
signet setup                         # interactive setup wizard
signet status                        # confirm daemon + pipeline health
signet dashboard                     # open memory + retrieval inspector
```

## Harness support

Signet runs underneath the tools you already use. Run `signet setup` to configure plugins and connectors. Currently, Signet supports:

|Harness|Integration path|
|---|---|
|[Claude Code](https://docs.anthropic.com/en/docs/claude-code)|Hooks + MCP|
|[OpenCode](https://github.com/sst/opencode)|Plugin|
|[OpenClaw](https://github.com/openclaw/openclaw)|Plugin|
|[Codex](https://github.com/openai/codex)|Hooks + MCP|
|[Kimi Code](https://github.com/MoonshotAI/kimi-cli)|Hooks + MCP / ACPX|
|[Hermes Agent](https://github.com/NousResearch/hermes-agent)|Memory provider plugin|
|[Pi](https://github.com/mariozechner/pi-coding-agent)|Extension|
|Oh My Pi|Extension|
|[Gemini CLI](https://github.com/google-gemini/gemini-cli)|MCP + GEMINI.md sync|
|[ForgeCode](https://forgecode.dev/)|Hooks + MCP|

> Don't see your favorite harness? File an [issue](https://github.com/Signet-AI/signetai/issues) and request that it be added!

<a href="https://signetai.sh/"><img src="public/sources.png" alt="Sources"></a>

Signet supports a wide variety of sources that can be imported directly into your agent's memory graph — included in dreaming sessions and surfaced as new connections in recall.

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

The benchmark matters because local custody should not mean weak recall. Signet is designed to retrieve the right facts across long-running, multi-session conversations while keeping memory inspectable and repairable.

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
