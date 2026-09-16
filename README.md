# Signet

Signet is a local-first memory and context layer for AI agents. It keeps transcripts, notes, documents, decisions, and secrets under your control, then builds inspectable semantic context with provenance back to the source.

[Use Signet](https://docs.signetai.sh/quickstart/) · [Build with Signet](https://docs.signetai.sh/sdk/) · [Documentation](https://docs.signetai.sh/) · [Discord](https://discord.gg/Psdeg7sQm7)

## Install

Recommended installer:

```bash
curl -fsSL https://signetai.sh/install.sh | bash
```

Windows x64:

```powershell
iwr -useb https://signetai.sh/install.ps1 | iex
```

Or install the package with npm or Bun:

```bash
npm install -g signetai
bun add -g signetai
```

Then run the setup wizard:

```bash
signet setup
signet status
signet dashboard
```

Signet supports Linux x64/arm64, macOS x64/arm64, Windows x64, and Docker. For guided setup, give your agent this guide:

```text
Install and configure Signet by following https://signetai.sh/skill.md exactly.
```

## What Signet provides

- **Durable artifacts:** Preserve raw transcripts, notes, documents, and other sources.
- **Derived memory:** Build semantic context in the background with provenance to those artifacts.
- **Portable context:** Use the same memory across models, machines, and harnesses.
- **Measured secrets access:** Inject credentials at execution time without exposing their raw values to downstream tools.

See [Why Signet](https://docs.signetai.sh/quickstart/#why-signet), [Architecture](https://docs.signetai.sh/architecture/), and [Knowledge Graph](https://docs.signetai.sh/knowledge-graph/) for details.

## Develop Signet

```bash
git clone https://github.com/Signet-AI/signetai.git
cd signetai
bun install
bun run build
bun test
bun run lint
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the developer workflow and [AI_POLICY.md](AI_POLICY.md) for AI-assisted contribution requirements.

## License

Apache-2.0.
