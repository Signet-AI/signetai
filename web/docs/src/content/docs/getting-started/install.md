---
title: "Install"
description: "Install Signet and choose the right distribution path."
---

## Prerequisites

- macOS or Linux
- Embeddings (choose one):
  - Built-in (recommended, no extra setup)
  - Ollama (local)
  - OpenAI API key
- Node.js 18+ or Bun 1.0+ only if you choose the npm or Bun wrapper instead
  of the direct native binary installer

---

## Install

Quickstart is for installing and using Signet. If you want to work on
Signet itself from source, use the contributor workflow in
[Contributing](/contributing/) instead of the install paths below.

```bash
# direct native binary
curl -fsSL https://signetai.sh/install.sh | bash

# npm wrapper for the same compiled Signet binary
npm install -g signetai

# Bun wrapper for the same compiled Signet binary
bun add -g signetai
```

Running `signet setup` launches an interactive wizard that walks you through
the full setup. You don't need to read anything else first.

All three install paths install the same compiled Signet binary. The npm and
Bun paths install the `signetai` wrapper plus a platform native package tarball
from the same GitHub release. Install scripts only link the native binary into
place; if scripts are disabled, the wrapper resolves the native package
directly. They do not install Bun, rebuild Signet, or install daemon
dependencies.

Choose one installation method per machine. `signet update install` uses a
direct native install when it coexists with a package-manager wrapper, and
`signet doctor` warns about the inactive wrapper. If a daemon is still running
from another install, the native CLI rebinds it before starting or updating.
Doctor's cleanup command removes only the duplicate launcher, not the package
that may also provide `signet-mcp`.

Published native binaries currently cover Linux x64, Linux arm64, macOS x64,
macOS arm64, and Windows x64. Windows direct installs should use
`npm install -g signetai`; the old PowerShell `install.ps1` path has been
removed until a native Windows direct installer ships.

For agent-driven onboarding, use non-interactive mode:

```bash
signet setup --non-interactive \
  --name "My Agent" \
  --harness claude-code \
  --deployment-type vps \
  --embedding-provider native
```

`--deployment-type` supports `local`, `vps`, or `server` and adjusts inferred
defaults when provider flags are omitted. Explicit provider flags always
override inferred defaults.

Agents can also run install and setup in one command, but only with explicit
setup choices:

```bash
curl -fsSL https://signetai.sh/install.sh | bash -s -- --help

curl -fsSL https://signetai.sh/install.sh | bash -s -- -- \
  --name "My Agent" \
  --harness claude-code \
  --deployment-type local \
  --embedding-provider native \
  --extraction-provider claude-code
```

If an agent does not have those choices yet, install first and run
`signet setup` after asking the user.

Signet Secrets is a bundled core plugin and is enabled by default for existing
workspaces. New interactive installs include a **Core plugins** step that
explains what it does before asking whether to enable it. For automation, pass
`--disable-signet-secrets` if you want the plugin installed but disabled.

GraphIQ is an optional verified managed plugin for fast local code retrieval.
It is not installed by default. Interactive setup asks whether to install it;
automation can pass `--with-graphiq` to install via script from GitHub releases,
fallback, or `--disable-graphiq` to keep it disabled.

If OpenClaw is configured to use the same workspace path, setup now enforces
backup posture before finishing. In automation, either configure a git
`origin` remote ahead of time, or pass `--create-local-backup` (or
`--allow-unprotected-workspace` if you intentionally accept the risk).
Snapshot-backed protection is considered fresh for 7 days; after that, run
setup with `--create-local-backup` again or configure `origin`.

Extraction safety note:

- intended usage is Claude Code on Haiku, Codex CLI on gpt-5.4-mini with a
  Pro/Max subscription, or local Ollama with at least `qwen3:4b`
- with `--deployment-type vps`, setup prefers non-local extraction defaults
  from selected harnesses when those tools are available locally, then other
  detected tooling, and avoids defaulting to local Ollama extraction
- on a VPS, set extraction to `none` if you do not want background LLM calls
- remote API extraction can rack up extreme fees fast

---
