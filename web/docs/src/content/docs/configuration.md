---
title: "Configuration"
description: "Configure and verify a Signet workspace and daemon."
---

Signet reads the selected workspace configuration from `agent.yaml`. `AGENT.yaml` and `config.yaml` remain supported compatibility names. Use `signet setup` to create a workspace and [Secrets](/secrets/) for sensitive values.

## Configuration areas

- [Workspace and identity](/configuration/workspace-identity/) — workspace selection, identity files, embeddings, and search.
- [Inference and routing](/configuration/inference-routing/) — accounts, targets, policies, workloads, and agent routes.
- [Pipeline configuration](/configuration/pipeline/) — document processing, maintenance, continuity, and telemetry.
- [Security and lifecycle](/configuration/security-lifecycle/) — authentication, retention, hooks, and lifecycle controls.
- [Files and integrations](/configuration/files-integrations/) — managed files, runtime state, and harness boundaries.

Each page owns its configuration keys. Model selection belongs under `inference`; `memory.synthesis` is not a current configuration key.

## Apply and verify

After changing an operational setting, restart the daemon and verify readiness plus the status surface for that setting:

```bash
signet daemon restart
curl -fsS http://127.0.0.1:3850/health/ready
signet daemon status --json
```
