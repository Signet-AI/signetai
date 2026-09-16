---
title: "Pipeline configuration"
description: "Configure document processing, maintenance, continuity, and telemetry."
---

Pipeline settings live under `memory.pipelineV2` in `agent.yaml`. Inference target selection belongs to [Inference and routing](/configuration/inference-routing/). The retired `memory.synthesis` block is rejected.

## Baseline

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

Omit settings you do not need; bounded defaults apply.

## Controls

`telemetryEnabled` defaults to `true`. `SIGNET_TELEMETRY_OPTOUT=1` opts out for one process without changing YAML. `autonomous.enabled` controls maintenance, `frozen` pauses autonomous writes, and `maintenanceMode` is `observe` or `execute`. The `repair` object sets cooldowns and hourly budgets for bounded re-embed, requeue, and deduplication work.

`documents` sets worker timing and content limits. `continuity` sets checkpoint cadence and retention. `embeddingTracker`, `guardrails`, and `subagents` provide additional bounded controls; use their current schema defaults rather than copying legacy blocks.

Apply changes with the canonical restart and readiness check in [Configuration](/configuration/). Inspect the running pipeline with:

```bash
curl -fsS http://127.0.0.1:3850/api/pipeline/status
```
