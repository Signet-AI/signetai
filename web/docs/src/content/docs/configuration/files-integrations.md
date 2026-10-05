---
title: "Files and integrations"
description: "Managed workspace files, daemon-owned state, harness integration, and source-control boundaries."
---

## Managed files

Keep the workspace readable and separate authored context from daemon-owned state.

| Path                                | Use                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `AGENTS.md`                         | Operating rules for an agent or project.                                     |
| `SOUL.md`, `IDENTITY.md`, `USER.md` | Identity, tone, and user context where the active identity preset uses them. |
| `MEMORY.md`                         | Generated working-memory summary. Do not hand-edit.                          |
| `agent.yaml`                        | Operator configuration.                                                      |
| `data/signet.db`                    | SQLite database owned by the daemon.                                         |
| `runtime/`                          | PID, logs, auth material, telemetry audit data, and other runtime state.     |
| `.secrets/`                         | Encrypted secrets. Never commit this directory.                              |

Use [Workspace and identity](/configuration/workspace-identity/) for workspace resolution and [Secrets](/secrets/) for credential storage.

## Harness integration

Install or refresh harness integrations with the Signet setup and connector flows. Do not copy legacy Python hook snippets or generated plugin files from old documentation: connector packages and the CLI own their managed harness configuration.

For a remote harness, create a narrowly scoped API key, install the matching connector, and start a fresh harness session. See [Remote Harness Connectors](/remote-connectors/).

For local configuration, run setup first and inspect the resulting harness configuration before changing it:

```bash
signet setup
signet daemon status --json
```

A daemon restart or fresh harness session may be necessary after a connector or identity change.

## Source control and backups

Treat the workspace as a mix of durable authored files and private runtime state. A conservative `.gitignore` includes:

```text
runtime/
data/
cache/
transcripts/
.secrets/
*.log
```

Do not commit a database copy, secret store, auth secret, or generated runtime log to a shared repository. If you need a backup, stop or quiesce the daemon and back up the workspace with its private state using your approved encrypted backup system. See [Self-Hosting](/self-hosting/) for the Docker volume path and upgrade flow.

## Troubleshooting boundary

Do not repair the database by editing tables, deleting a PID file, or copying a generated harness config from another machine as a first response. Check the daemon's current state, diagnostics, and logs first:

```bash
signet daemon status --json
curl -fsS http://127.0.0.1:3850/health/ready
curl -fsS http://127.0.0.1:3850/api/diagnostics
```

Related: [Daemon](/daemon/), [Diagnostics](/diagnostics/), [Remote Harness Connectors](/remote-connectors/).
