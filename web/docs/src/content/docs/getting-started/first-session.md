---
title: "Your first session"
description: "Use memory, secrets, skills, and the dashboard in a first Signet session."
---

## What Signet Does

Once running, Signet gives you a persistent agent identity that works
across all your AI tools. The core features:

- **[Memory pipeline](/pipeline/)** — conversations are processed automatically by
  Pipeline V2, which extracts meaningful facts and decisions using a
  configured extraction backend. The safe intended setups are Claude
  Code on Haiku, Codex on gpt-5.4-mini, or local Ollama with at least
  `qwen3:4b`. Set the extraction provider to `none` if you want Signet
  without background extraction. Memories accumulate over time and are
  recalled in future sessions.
- **Hybrid search** — recall combines semantic and keyword search so
  you find relevant memories even when phrasing varies.
- **Connectors** — platform adapters for Claude Code, OpenCode, and
  OpenClaw keep your agent config in sync across tools.
- **Analytics** — the dashboard tracks memory growth, session activity,
  and pipeline health over time.
- **Document ingest** — feed local files or URLs into the memory pipeline
  to give your agent persistent knowledge about a codebase, spec, or doc.
- **Diagnostics** — built-in health checks and pipeline status endpoints
  help you spot issues fast.
- **SDK** — embed Signet into your own apps via `@signet/sdk`.
- **Secrets** — API keys stored encrypted at rest, never exposed to agents
  directly.
- **Skills** — installable instruction packages that extend agent behavior.
- **Auth** — token-based access control for local, team, and hybrid
  deployments. See [Auth](/auth/) for details.

---

## Basic Usage

### Check status

```bash
signet status
```

Shows daemon state, file health, and memory count.

### Open the dashboard

```bash
signet dashboard
```

Opens `http://localhost:3850` in your browser. From here you can edit
your agent config, browse memories, view analytics, and manage skills.
You can also reach it directly in your browser any time the daemon is
running.

### Save a memory

Use the CLI or `/remember` command in any connected harness:

```bash
# CLI
signet remember "nicholai prefers bun over npm"
signet remember "critical memory" --critical
signet remember "tagged memory" -t project,signet

# In harness
/remember nicholai prefers bun over npm
/remember critical: never commit secrets to git
/remember [project,signet]: daemon runs on port 3850
```

The `critical:` prefix or `--critical` flag pins a memory so it never
decays. The `[tag1,tag2]:` prefix or `-t` flag adds searchable tags.

You can also let the pipeline do this automatically — at the end of a
session, Pipeline V2 reads the conversation and extracts memories on its
own. Manual `/remember` is for things you want to ensure are captured.

### Search memories

```bash
# CLI
signet recall "coding preferences"
signet recall "signet" --type decision -l 5

# In harness
/recall coding preferences
/recall signet architecture
/recall what did we decide about authentication
```

### View daemon logs

```bash
signet daemon logs
signet daemon logs -n 100
```

### Stop/start the daemon

```bash
signet daemon stop
signet daemon start
signet daemon restart
```

---

## Managing Secrets

Store API keys and other sensitive values encrypted at rest:

```bash
# Add a secret (value is never echoed)
signet secret put OPENAI_API_KEY

# List stored secrets (names only)
signet secret list

# Remove a secret
signet secret delete GITHUB_TOKEN
```

Secrets are encrypted with libsodium using a machine-bound key. Agents
never see secret values directly.

---

## Managing Skills

Skills are packaged instructions in `$SIGNET_WORKSPACE/skills/`. They extend
what your agent can do.

```bash
# See what's installed
signet skill list

# Search the skills.sh registry
signet skill search browser

# Install a skill
signet skill install browser-use

# Remove a skill
signet skill remove weather
```

---
