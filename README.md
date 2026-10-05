<div align="center">

<a href="https://signetai.sh/"><img src="public/banner-typography.png" alt="Signet AI"></a>

Signet gives your AI agents a shared memory. You can use it to store, sync, and share memories, system prompts, transcripts, institutional knowledge, and secrets across all the AI tools and models you use.

<a href="https://github.com/Signet-AI/signetai/releases"><img src="https://img.shields.io/github/v/release/Signet-AI/signetai?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
<a href="https://www.npmjs.com/package/signetai"><img src="https://img.shields.io/npm/v/signetai?style=for-the-badge" alt="npm"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge" alt="Apache-2.0 License"></a>
<a href="https://docs.signetai.sh/benchmarking/#current-longmemeval-score"><img src="https://img.shields.io/badge/LongMemEval-97.6%25-black?style=for-the-badge" alt="LongMemEval 97.6% answer accuracy"></a>

[Quick start](#quick-start) · [How it works](#how-it-works) · [Harnesses](#harnesses) · [Docs](https://docs.signetai.sh/quickstart/) · [Discord](https://discord.gg/Psdeg7sQm7)

[English](README.md) · [Deutsch](README.de.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

</div>

---

Signet creates memories automatically from your transcripts, imported files, and other sources. In the background, a process called "dreaming" builds and maintains a structured map of the people, projects, facts, and relationships in your history. Every connection links back to its source, so you can see where it came from.

If you switch models or agent tools, Signet brings your context with you. Your agent gets what's relevant before the next prompt begins, and it can trace the memory back to the raw source when it needs more details. You can run Signet on your own machine or as a server for your team.

## Quick start

Pick one installation method. They all install the same compiled Signet binary; the npm and Bun packages just fetch it through a matching native package.

```bash
# macOS and Linux
curl -fsSL https://signetai.sh/install.sh | bash

# npm or Bun (Windows, macOS, Linux)
npm install -g signetai
bun add -g signetai
```

On Windows x64, run this in PowerShell, then open a new window to get the updated `PATH`:

```powershell
iwr -useb https://signetai.sh/install.ps1 | iex
```

Then set up a workspace:

```bash
signet setup       # prepare a workspace and open guided onboarding
signet status      # confirm the daemon and Dreaming are healthy
signet dashboard   # browse memory, sources, and settings
```

The guided onboarding walks you through choosing a provider and connecting your sources and agents. If you're on a headless machine, or if you'd rather have an agent set it up, you can also run setup non-interactively by pasting this to your agent:

```
Install and fully configure Signet AI by following this guide exactly: https://signetai.sh/skill.md
```

Supported platforms: Linux x64/arm64, macOS x64/arm64, Windows x64, and Docker. See the [installation guide](https://docs.signetai.sh/getting-started/install/) for details and the [upgrade guide](https://docs.signetai.sh/upgrading/) for existing installs.

> The `stable` channel is what we recommend for everyday use. `nightly` builds (`install.sh | bash -s -- --nightly`) have unreleased work and can break.

## How it works

<a href="https://signetai.sh/"><img src="public/sources.png" alt="Sources"></a>

Your **sources** bring the context you already have into Signet. Connected sources stay in sync as they change, and you can also import files and webpages as one-time imports (see [supported sources and formats](#supported-sources-and-formats)). Agent conversations are imported with who said what, when, and where it came from; interrupted imports resume, re-imports don't duplicate evidence, and you can export conversations back out as structured JSONL.

**Dreaming** maintains what Signet knows as your work evolves. It reads new evidence alongside your existing context, connects the people, projects, facts, and relationships it describes, revisits contradictions, and proposes updates to claims. Changes are validated and recorded with citations, and the original evidence is never rewritten. Time-sensitive claims, like a deadline or someone's current role, can have a review date so they get revisited before they go stale. You can watch Dreaming work in the dashboard through live traces and an operation ledger.

Read more: [Sources](https://docs.signetai.sh/sources/) · [Data portability](https://docs.signetai.sh/cli/data-portability/) · [Dreaming](https://docs.signetai.sh/pipeline/extraction-decisions/) · [Knowledge graph](https://docs.signetai.sh/knowledge-graph/) · [Architecture](https://docs.signetai.sh/architecture/)

### Supported sources and formats

|Source|Notes|
|---|---|
|Obsidian|Real-time file watcher. Connect multiple vaults read-only; supports the LLM-Wiki format.|
|GitHub|Real-time ingest of issues, pull requests, and discussions.|
|Notion|Syncs the pages and database entries shared with a Notion integration; re-syncs fetch only what changed.|
|Discord|Real-time crawler that contributes to memory and links into the existing knowledge graph.|
|Webpages|One-time import of a public URL, extracted to readable Markdown with page metadata.|
|Slack, email, Telegram, WhatsApp|_Coming soon_|

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

## Harnesses

A "harness" is the app or environment your agent runs in. Signet connects through each harness's own hooks, plugins, or extensions to supply memory in the background and capture new context as you work, so if you switch agents you don't have to start over.

|Harness|Integration|
|---|---|
|[Claude Code](https://docs.anthropic.com/en/docs/claude-code)|Hooks + MCP|
|[Codex](https://github.com/openai/codex) and ChatGPT desktop|Native plugin, hooks/MCP fallback|
|[OpenCode](https://github.com/sst/opencode)|Plugin|
|[OpenClaw](https://github.com/openclaw/openclaw)|Plugin|
|[Hermes Agent](https://github.com/NousResearch/hermes-agent)|Memory provider plugin|
|[Kimi Code](https://github.com/MoonshotAI/kimi-cli)|Hooks + MCP, ACPX inference|
|[Pi](https://github.com/mariozechner/pi-coding-agent)|Extension|
|Oh My Pi|Extension|
|[Gemini CLI](https://github.com/google-gemini/gemini-cli)|MCP + GEMINI.md sync|
|[ForgeCode](https://forgecode.dev/)|Hooks + MCP|

Agents can also message each other through Signet. Messages survive restarts and arrive at the start of the recipient's next session or prompt.

Don't see your harness? [Open an issue](https://github.com/Signet-AI/signetai/issues). See the [harness guides](https://docs.signetai.sh/harnesses/) for setup.

## Dashboard and desktop

<img src="public/dashboard-home.webp" alt="Signet dashboard home view showing the daily brief, recently saved memories, activity, and system status">

The dashboard is where you look through your memory, connect sources and agents, change settings, and watch Signet work. It includes a memory graph of the people, projects, and claims Signet knows about, and a chat for asking questions of your memory with any connected model. Answers cite the memories they draw on.

It runs in your browser via `signet dashboard`, or as a desktop app on macOS, Linux, and Windows x64:

```bash
signet desktop install
```

## Inspecting and trusting memory

- **Provenance:** when you recall a memory, Signet shows where it came from, how it's changed, and whether it's been reviewed.
- **Claim traces:** you can ask why Signet believes something and get its history, competing claims, and the exact source passages, from the CLI, API, or MCP.
- **Agent isolation:** each agent only sees the memory it's allowed to read.
- **Secrets:** secrets are stored encrypted, with the master key in your OS keyring. Systems without a keyring fall back to encrypted file storage and show a health warning. Make sure to keep your keychain in your recovery plan; see [Secrets](https://docs.signetai.sh/secrets/).
- **Recovery:** protection status shows whether a backup has been verified as restorable and flags backups that are missing or stale.
- **Hostile content:** content that matches known hostile patterns is kept out of what your agents see.

## Telemetry

Signet sends anonymous usage data: install and version counts, feature usage, token and cost totals per provider, and sanitized crash reports. It never sends memory content, prompts, search queries, or anything that identifies you. Every event is also written to a local log in your workspace so you can read exactly what was sent.

To turn it off, set `telemetryEnabled: false` in your config or `SIGNET_TELEMETRY_OPTOUT=1` in your environment. See [telemetry controls](https://docs.signetai.sh/analytics/).

## Benchmarks

Signet's latest tracked MemoryBench run averages **97.6% LongMemEval answer accuracy**. Keeping your memory local shouldn't mean you have to settle for weak recall. See [Benchmarks](https://docs.signetai.sh/benchmarking/#current-longmemeval-score) for the methodology, scoring note, and run workflow.

## Documentation

[Quickstart](https://docs.signetai.sh/quickstart/) · [CLI](https://docs.signetai.sh/cli/) · [Configuration](https://docs.signetai.sh/configuration/) · [Dashboard](https://docs.signetai.sh/dashboard/) · [Harnesses](https://docs.signetai.sh/harnesses/) · [Hooks](https://docs.signetai.sh/hooks/) · [Skills](https://docs.signetai.sh/skills/) · [Secrets](https://docs.signetai.sh/secrets/) · [Auth](https://docs.signetai.sh/auth/) · [SDK](https://docs.signetai.sh/sdk/) · [API](https://docs.signetai.sh/api/) · [Telemetry](https://docs.signetai.sh/analytics/) · [Workspace v2](https://docs.signetai.sh/workspace-v2/) · [Roadmap](ROADMAP.md) · [Repository map](repo.map.yaml)

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

To develop this repository, you'll need:

- Bun for normal repo development
- Node.js 18+ for Node-targeted package surfaces
- Bun on the process `PATH` for local secrets access from macOS Node runtimes; compiled Signet and the desktop app include their helper runtime
- macOS or Linux
- Optional for harness integrations: any of the harnesses listed above

## Contributing

If you're new to open source, start with [Your First PR](https://docs.signetai.sh/first-pr/). For code conventions and project structure, see [CONTRIBUTING.md](CONTRIBUTING.md). Open an issue before contributing significant features, and read the [AI Policy](AI_POLICY.md) before submitting AI-assisted work.

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
