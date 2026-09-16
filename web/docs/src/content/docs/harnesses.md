---
title: "Harnesses"
description: "Set up and verify Signet harness integrations."
---

A harness integration connects an agent runtime to the Signet daemon for
identity, memory, and lifecycle events.

## Setup

Start Signet, then choose a harness during interactive setup or name it
explicitly:

```bash
signet start
signet setup --harness <harness>
```

Use the page for your runtime for managed files, prerequisites, verification,
and troubleshooting:

- [Claude Code](/harnesses/claude-code/)
- [Kimi Code](/harnesses/kimi/)
- [Codex](/harnesses/codex/)
- [OpenCode](/harnesses/opencode/)
- [Oh My Pi](/harnesses/oh-my-pi/)
- [Pi](/harnesses/pi/)
- [OpenClaw](/harnesses/openclaw/)
- [Hermes Agent](/harnesses/hermes-agent/)
- **Gemini CLI** — supported through the Gemini CLI connector; a dedicated public guide is not published yet. Run `signet setup --harness gemini`.
- **ForgeCode** — supported through the ForgeCode connector; a dedicated public guide is not published yet. Run `signet setup --harness forge`.

## Verify an installation

1. Run `signet status` and confirm the daemon is running.
2. Start a new session in the harness.
3. Save and recall a small test note.
4. If context is missing, inspect the harness-owned configuration and daemon
   health, then rerun that harness's setup command.

Harnesses may expose different lifecycle events. A runtime that lacks a
compaction hook has reduced compaction continuity; it should not be treated as
full-fidelity.

## Develop a harness

See [Develop a harness integration](/harnesses/develop/) for the HTTP and hook
contracts.
