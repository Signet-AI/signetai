---
title: "Pipeline configuration"
description: "Operator controls for the daemon's memory, document, maintenance, continuity, and telemetry work."
---

Pipeline settings live under `memory.pipelineV2` in `agent.yaml`. Inference target choice belongs in [Inference and routing](/configuration/inference-routing/). Do not add the retired `memory.synthesis` block: the current loader rejects it.

Restart the daemon after a pipeline configuration change. Long-running workers are started with a configuration snapshot, so editing YAML alone is not a reliable apply operation.

```bash
signet daemon restart
signet daemon status --json
```

## Safe operational baseline

```yaml
memory:
  pipelineV2:
    telemetryEnabled: true
    autonomous:
      enabled: true
      frozen: false
      maintenanceIntervalMs: 1800000
      maintenanceMode: execute
    documents:
      workerIntervalMs: 10000
      chunkSize: 2000
      chunkOverlap: 200
      maxContentBytes: 10485760
    continuity:
      enabled: true
      promptInterval: 10
      timeIntervalMs: 900000
      retentionDays: 7
```

Omit settings you do not need. The daemon supplies bounded defaults and clamps accepted numeric values while loading configuration.

## Controls

`telemetryEnabled` defaults to `true`. Set it to `false` to opt out persistently; `SIGNET_TELEMETRY_OPTOUT=1` disables telemetry for the process without changing YAML. See [Analytics](/analytics/) for the local audit path and privacy boundary.

`autonomous.enabled` controls autonomous maintenance. `autonomous.frozen` pauses autonomous writes without deleting configuration. `autonomous.maintenanceMode` is `observe` or `execute`. Use `observe` while evaluating a new deployment; use the repair endpoints only with an authenticated operator or admin principal where applicable.

The `repair` object bounds maintenance work with cooldowns and hourly budgets. Its current keys include re-embed, requeue, and deduplication cooldown and budget settings. These limits apply equally to operator, agent, and autonomous daemon callers; operator permission does not bypass runtime admission. The daemon stores action-and-scope leases and recent completions in SQLite, so a restart cannot immediately replay an in-flight or recently completed repair. Keep the limits conservative when a remote provider is involved. There is no implicit force override; an explicit denied admission returns `429`.

## Documents and continuity

`documents` controls the daemon document worker: poll interval, chunk target, overlap, and maximum accepted content bytes. These are processing limits, not a replacement for upload policy. See [Sources](/sources/) for ingest behavior.

`continuity` controls checkpoint cadence, retention, and recovery-budget limits. It is independent of ordinary recall. Tune it only when you have a concrete recovery or storage requirement.

`embeddingTracker` controls the bounded background pass that detects missing or stale embeddings. `guardrails` bounds stored and injected text. `subagents` controls parent-context inheritance for supported harness flows. Leave defaults in place unless a measured issue requires a change.

## Concurrency and provider behavior

`worker.maxLlmConcurrency` sets a shared cap for active LLM work. `SIGNET_MAX_LLM_CONCURRENCY` overrides it for the process when it is a positive integer. Do not set this from a guess: provider quota, local GPU memory, and latency are deployment-specific.

For canonical model selection, create or edit a routing target and bind the workload. See [Inference and routing](/configuration/inference-routing/). A legacy provider/model field in an old workspace is not a safe substitute for a workload binding.

## Verify

```bash
signet daemon status --json
curl -fsS http://127.0.0.1:3850/api/pipeline/status
curl -fsS http://127.0.0.1:3850/health/ready
```

Use [Diagnostics](/diagnostics/) when a queue, embedding, or maintenance problem persists. Do not infer worker health from a successful configuration write.
