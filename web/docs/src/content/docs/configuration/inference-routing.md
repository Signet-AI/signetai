---
title: "Inference and routing"
description: "Configure accounts, targets, policies, workloads, and agent routes."
---

Inference is configured under the top-level `inference` key in `agent.yaml`. Background work resolves through this control plane; configure `memoryExtraction` explicitly. `session_synthesis` inherits that route.

## Core objects

- `accounts` names API or subscription identities. API accounts use `credentialRef`; subscription accounts use `sessionRef`.
- `targets` describe executable backends and their models. Use an executor returned by `GET /api/inference/catalog` or the documented `acpx` adapter.
- `policies` order, allow, deny, and limit route references.
- `taskClasses` describe reasoning, tools, privacy, latency, and cost requirements.
- `workloads` bind `interactive` and `memoryExtraction` to a policy, task class, or explicit `target/model`.
- `agents` provide per-agent policy, roster, preferred-target, and pinned-target settings.

A minimal explicit route is:

```yaml
inference:
  enabled: true
  defaultPolicy: local
  targets:
    local:
      executor: ollama
      endpoint: http://127.0.0.1:11434
      privacy: local_only
      models:
        default:
          model: gemma4
          reasoning: medium
          streaming: true
  policies:
    local:
      mode: strict
      defaultTargets: [local/default]
  workloads:
    interactive:
      policy: local
    memoryExtraction:
      policy: local
```

The router can synthesize a `default` policy when targets exist without an explicit policy. `signet route list` shows it; use an explicit policy when deterministic routing matters.

## Accounts and credentials

Use `$secret:NAME` references or the account's supported credential reference. Do not assume an environment variable overrides an encrypted secret: resolution is defined by the account/provider implementation. OAuth login uses `/api/inference/oauth/login/:id` and stores the resulting credential in the encrypted secret store.

## Target fields

Common target fields are `executor`, `account`, `endpoint`, `privacy`, `models`, and (for ACPX) `agent`, `cwd`, `session`, `permissions`, `timeoutMs`, and `allowedTools`. Model entries use `model`, `reasoning`, `toolUse`, `streaming`, `multimodal`, and optional context, cost, and latency hints.

Provider-specific executors and old `claude-code`, direct Codex, or legacy provider/model blocks are compatibility details, not canonical examples. Prefer the catalog and current route configuration. The retired `memory.pipelineV2.extraction` and `memory.pipelineV2.synthesis` implicit-provider path is not supported.

## Verify a route

Use the inference catalog and route commands to inspect availability, then apply the configuration using the canonical rule on [Configuration](/configuration/). Confirm workload and daemon readiness before changing a production route.
