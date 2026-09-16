---
title: "Runtime operations"
description: "Control the daemon, updates, and inference routing."
---

## Daemon

```bash
signet daemon start
signet daemon stop
signet daemon restart
signet daemon pause
signet daemon resume
signet daemon status
signet daemon logs
```

## Updates

```bash
signet update check
signet update install
signet update status
signet update channel
signet update channel <channel>
signet update enable
signet update disable
```

`channel` reads or sets the update channel. Use `status` before automation.

## Routing and inference

`route` is also registered as `inference`:

```bash
signet route list
signet route status
signet route doctor
signet route explain <prompt>
signet route test <prompt>
signet route pin <targetRef>
signet route unpin
```

Use `signet route <command> --help` for the current flag set rather than relying on stale target or policy prose. Other runtime groups are `mcp`, `desktop`, and `browse` (`navigate`, `extract`, `watch`).