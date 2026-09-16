---
title: "AI memory for Hermes Agent and OpenClaw"
description: "Use Signet memory with Hermes Agent and OpenClaw."
---

Signet is a local daemon that provides shared, inspectable memory for agent
harnesses. Hermes Agent and OpenClaw can use the same workspace and daemon
without making either runtime the owner of the memory database.

## Install

```bash
signet setup
signet start
signet status
```

Select Hermes Agent and OpenClaw during setup. For individual instructions,
see [Hermes Agent](/harnesses/hermes-agent/) and [OpenClaw](/harnesses/openclaw/).

## Hermes Agent

Signet installs a Hermes `MemoryProvider` plugin. It supplies session context,
recall tools, compaction handling, and session-end extraction through the
Signet daemon.

## OpenClaw

Signet uses the runtime package `@signetai/signet-memory-openclaw`. The setup
connector configures OpenClaw to use the active Signet workspace and
selects the runtime plugin. OpenClaw reads `AGENTS.md` from that workspace
directly. The setup connector leaves the workspace identity files in place for
the runtime to read; it disables the legacy internal `signet-memory` hook to
avoid duplicate memory paths.

## Shared state

The active workspace is represented by `$SIGNET_WORKSPACE`. It contains the
identity and memory files used by the configured harnesses. The daemon stores
its database under the Signet data directory and serves local MCP and HTTP
interfaces.

Verify both integrations by starting a fresh session in each harness, saving a
small test note, and recalling it. If recall fails, check `signet status`, the
harness configuration, and daemon health before changing plugin settings.

For server deployments, see [Self-Hosting](/self-hosting/).
