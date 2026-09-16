---
title: "Files and integrations"
description: "Define workspace file ownership and connector boundaries."
---

## Managed paths

| Path | Owner |
|---|---|
| `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md` | Authored operating and identity context |
| `MEMORY.md` | Generated working-memory summary |
| `agent.yaml` | Operator configuration |
| `memory/memories.db` | Daemon-owned database |
| `.daemon/` | Runtime state, logs, and telemetry audit data |
| `.secrets/` | Encrypted secret storage |

Keep `.daemon/`, `.secrets/`, logs, and database copies out of source control. See [Secrets](/secrets/) for credential storage.

## Integrations

Use `signet setup` and the connector installers to manage harness integration. Do not copy legacy hook snippets or generated plugin files between machines. A remote harness needs a scoped API key and a fresh session after installation; see [Remote Harness Connectors](/remote-connectors/).

## Backup and inspection

Back up authored files and private runtime state with an encrypted system that preserves permissions. Before changing database or generated files, inspect the daemon evidence:

```bash
curl -fsS http://127.0.0.1:3850/health/ready
curl -fsS http://127.0.0.1:3850/api/diagnostics
```

The daemon owns database transitions. Do not edit tables, delete runtime markers, or copy generated integration files as a first response.
