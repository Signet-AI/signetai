# Signet

**Own your agent. Bring it anywhere.**

Signet is an open standard for portable AI agent identity. Your agent's personality, memory, and preferences—portable across Claude Code, OpenClaw, Codex, and beyond.

🌐 **https://signetai.sh**

## The Problem

Every AI platform has memory now. ChatGPT remembers you. Claude.ai learns your preferences. Gemini knows your style.

**But you can't take it with you.**

They're not storing memories *for* you—they're locking you *in*.

## The Solution

Signet puts your agent's identity in plain text files you own:

```
~/.signet/
├── agent.yaml      # Your agent's manifest
├── soul.md         # Personality & behavior
├── memory.md       # Core knowledge
└── agent.db        # Structured memory (SQLite)
```

One agent. Every platform. Zero lock-in.

## Quick Start

```bash
curl -sL https://signetai.sh/install | bash
```

Or with npm/bun:

```bash
npx signet init
```

## Packages

| Package | Description |
|---------|-------------|
| [`@signet/cli`](./packages/cli) | Command-line interface |
| [`@signet/core`](./packages/core) | Core library & database |
| [`@signet/sdk`](./packages/sdk) | Integration SDK for apps |
| [`@signet/daemon`](./packages/daemon) | Background sync service |

## Compatibility

Works with:
- Claude Code
- OpenClaw
- Codex
- OpenCode
- Any tool that reads CLAUDE.md / AGENTS.md

## Documentation

- [Specification](https://signetai.sh/spec)
- [Architecture](https://signetai.sh/architecture)
- [SDK Guide](https://signetai.sh/docs/sdk)
- [Migration Guide](https://signetai.sh/docs/migrate)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md)

## License

MIT
