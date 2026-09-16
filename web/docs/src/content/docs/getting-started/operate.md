---
title: "Operate your installation"
description: "A short bridge from first setup to routine Signet operations."
---

Use the preferred daemon command group for local lifecycle work:

```bash
signet daemon start
signet daemon status
signet daemon logs -n 100
signet daemon stop
```

`signet daemon restart` applies configuration and installed updates. The top-level `signet start`, `stop`, `restart`, and `logs` commands remain compatibility aliases.

## Common operator tasks

```bash
signet update check
signet update install
signet workspace status
signet workspace set /path/to/workspace
signet doctor
```

Restart after `update install` or `workspace set` so the running daemon uses the selected version or workspace. Verify with `signet daemon status --json` and `/health/ready`.

For protected network access, configure authentication and deployment before exposing the daemon. Use [Authentication](/auth/), [Self-hosting](/self-hosting/), and [Diagnostics](/diagnostics/) for the procedural paths.
