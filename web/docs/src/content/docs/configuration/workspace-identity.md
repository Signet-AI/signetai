---
title: "Workspace and identity"
description: "Workspace resolution, managed identity files, and the safe agent.yaml baseline."
---

## Workspace selection

A Signet workspace owns its configuration, identity files, database, daemon state, and generated artifacts.

Resolution is, in order:

1. An explicit CLI `--path` value.
2. `SIGNET_PATH` for the current process.
3. The persisted workspace selection.
4. `~/.agents/`.

Inspect or change the persisted selection with:

```bash
signet workspace status
signet workspace set /path/to/workspace
```

Use `SIGNET_PATH` for a one-off daemon, test, or service invocation. Do not point two writable daemons at the same workspace.

## Workspace files

| File or directory                                | Ownership                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `agent.yaml`                                     | Operator configuration.                                                      |
| `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md` | Agent and user context. Preserve these as source material.                   |
| `MEMORY.md`                                      | Generated working-memory projection. Do not hand-edit it.                    |
| `DREAMING.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`    | Prompts for their named special flows, not ordinary startup context.         |
| `data/signet.db`                                 | Daemon-owned SQLite state. Do not edit with SQL while the daemon is running. |
| `runtime/`                                       | Runtime state, logs, auth material, and telemetry audit data.                |
| `.secrets/`                                      | Encrypted secret storage. Keep it out of source control.                     |

The configuration loader accepts the first present of `agent.yaml`, `AGENT.yaml`, or `config.yaml`, in that order. Prefer `agent.yaml` for new workspaces.

## Minimal baseline

`signet setup` produces the right starting point for the installed release. A small hand-maintained configuration can look like this:

```yaml
agent:
  name: "My Agent"
  description: "Personal assistant"

embedding:
  provider: ollama
  model: nomic-embed-text
  base_url: http://127.0.0.1:11434

search:
  alpha: 0.7
  top_k: 20
  min_score: 0.3

memory:
  pipelineV2:
    telemetryEnabled: true
    autonomous:
      enabled: true
      frozen: false
      maintenanceMode: execute

auth:
  mode: local

network:
  mode: localhost
```

This is a baseline, not a schema dump. Add only the options you operate. Configure model targets and workload bindings in [Inference and routing](/configuration/inference-routing/), not by reviving legacy `memory.synthesis` fields.

## Embeddings and search

The embedding provider, model, dimensions, endpoint, and optional `api_key` belong under `embedding`. Supported embedding providers include native, llama.cpp, Ollama, and OpenAI-compatible remote providers. Store remote credentials through [Secrets](/secrets/) and reference them with `$secret:NAME` rather than writing a key into YAML.

Changing an embedding profile initiates an index migration. Confirm its progress from the daemon status and embedding status endpoints before retiring the old provider or model.

`search.alpha` controls hybrid retrieval weighting. `top_k` and `min_score` bound candidate collection and returned results. Change search tuning deliberately and verify representative recall queries after restart.

## Applying a change

Most long-running workers receive configuration at pipeline start. Restart after changing embedding, inference, pipeline, auth, or network settings:

```bash
signet daemon restart
signet daemon status --json
curl -fsS http://127.0.0.1:3850/health/ready
```

If a configuration error prevents startup, use the exact daemon error as the migration guide. Do not delete legacy keys blindly; preserve a backup of `agent.yaml`, make the smallest correction, then restart.

Related: [Daemon](/daemon/), [Pipeline configuration](/configuration/pipeline/), [Authentication](/auth/), [Upgrading](/upgrading/).
