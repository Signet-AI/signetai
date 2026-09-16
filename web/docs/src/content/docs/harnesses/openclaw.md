---
title: "OpenClaw"
description: "Connect Signet to OpenClaw."
---

## Install

OpenClaw uses the Signet runtime memory plugin and a setup connector. Install
Signet, start the daemon, then run:

```bash
signet setup --harness openclaw
```

The connector discovers OpenClaw-family configuration files and enables the
Signet hook. It does not change your workspace through an undocumented CLI
command. Confirm the configured workspace in OpenClaw's config:

```json
{
  "agents": {
    "defaults": {
      "workspace": "$SIGNET_WORKSPACE"
    }
  }
}
```

OpenClaw reads `AGENTS.md` from that workspace directly. Signet does not
create a generated `CLAUDE.md` or `AGENTS.md` copy for OpenClaw.

## Runtime plugin

The runtime package is:

```text
@signetai/signet-memory-openclaw
```

Install it in an OpenClaw plugin environment when you are not using the
Signet setup flow. The plugin connects to the local daemon at
`http://localhost:3850` by default and supports session start, prompt
context, compaction, session end, `/remember`, and `/recall` operations.

The setup package and runtime package are different:

- `@signet/connector-openclaw` installs configuration and hook files.
- `@signetai/signet-memory-openclaw` runs inside OpenClaw.

## Verify

1. Run `signet status` and confirm the daemon is healthy.
2. Start a new OpenClaw session in the configured workspace.
3. Use `/remember` to save a test preference, then `/recall` to retrieve it.
4. Check the session output or daemon logs if no context appears.

## Troubleshooting

- **The hook does not run:** rerun `signet setup --harness openclaw`, then
  restart OpenClaw.
- **The wrong workspace is used:** inspect OpenClaw's active config and set
  its `agents.defaults.workspace` to the value of `$SIGNET_WORKSPACE`.
- **The plugin cannot reach Signet:** start the daemon and verify
  `http://localhost:3850/health` returns successfully.
- **An older installation is present:** run `signet doctor`; legacy hook-only
  installs are compatibility mode and do not provide full plugin lifecycle
  behavior.

OpenClaw, Clawdbot, and Moltbot use related configuration conventions, but
check the configuration file selected by the runtime you actually launch.
