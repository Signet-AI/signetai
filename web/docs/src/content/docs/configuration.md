---
title: "Configuration"
description: "Configure and verify a Signet workspace and daemon."
---

Signet reads the selected workspace configuration from `agent.yaml` (with `AGENT.yaml` and `config.yaml` supported as compatibility names). Use `signet setup` for a new workspace and keep sensitive values in [Secrets](/secrets/).

## Configuration areas

- [Workspace and identity](/configuration/workspace-identity/) — workspace selection, identity files, embeddings, and search.
- [Inference and routing](/configuration/inference-routing/) — accounts, targets, policies, workloads, and agent routes.
- [Pipeline configuration](/configuration/pipeline/) — document processing, maintenance, continuity, and telemetry.
- [Security and lifecycle](/configuration/security-lifecycle/) — authentication, retention, hooks, and lifecycle controls.
- [Files and integrations](/configuration/files-integrations/) — managed files, runtime state, and harness boundaries.

Each page owns its configuration keys. Do not copy retired examples into a current workspace. In particular, `memory.synthesis` is rejected by the current loader; model selection belongs under `inference`.

## Apply and verify

After changing an operational setting, restart the daemon, then verify the running process:

```bash
signet daemon restart
signet daemon status --json
curl -fsS http://127.0.0.1:3850/health/ready
```

Use the relevant status or diagnostics endpoint for the setting you changed. A YAML edit is not proof that a long-running worker adopted the value. Malformed YAML and invalid known settings fail with file and field diagnostics; supported legacy forms are migrated before validation, while retired forms fail explicitly.

Embedding providers currently include `local` (the native alias), `native`, `llama-cpp`, `ollama`, `openai`, and `none`. Authentication modes are `local`, `team`, and `hybrid`. See the owning pages for key-level defaults and constraints.
