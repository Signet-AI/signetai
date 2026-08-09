---
title: "Pipeline configuration reference"
description: "Pipeline flags, nested defaults, examples, and multi-agent notes."
---

## Configuration Reference

Most pipeline config lives under `memory.pipelineV2` in `agent.yaml` (see
[Configuration](/configuration/)). The config uses a nested structure with grouped
sub-objects. Legacy flat keys are also supported for backward
compatibility (nested keys take precedence).

Provider selection for extraction and session synthesis can also be bound to
the shared inference control plane through the top-level `inference.workloads`
config. If those workload bindings are present, the pipeline resolves its
inference target through the router. Legacy extraction and synthesis provider
fields are only used to build an implicit compatibility profile when no explicit
`inference:` block is configured.

### Top-level flags

```
enabled                         true
shadowMode                      false
mutationsFrozen                 false
semanticContradictionEnabled        true
semanticContradictionTimeoutMs      120000  # ms, range 5000-300000
telemetryEnabled                    true    # set false to opt out
```

### Nested sub-objects and defaults

Extraction safety note:

- intended usage is Claude Code on Haiku, Codex CLI on gpt-5.4-mini with a
  Pro/Max subscription, or local Ollama with at least `qwen3:4b`
- set `provider: none` on a VPS if you do not want background
  extraction
- remote API extraction can accumulate extreme fees quickly
  (`anthropic`, `openrouter`, `openai-compatible`, or remote OpenCode routes)

```yaml
extraction:
  provider: llama-cpp            # legacy routing seed; canonical inference.workloads.memoryExtraction takes precedence
  model: qwen3:4b
  timeout: 90000                 # ms, range 5000–300000
  minConfidence: 0.7             # fraction 0.0–1.0
  structuredOutput: true         # send JSON schema in format field; set false for providers that reject it (e.g. GitHub Copilot)

synthesis:
  enabled: true
  provider: ollama               # "none" | "llama-cpp" | "ollama" | "claude-code" | "codex" | "opencode" | "anthropic" | "openrouter" | "openai-compatible"
  model: qwen3:4b
  timeout: 120000                # ms, range 5000–300000
  # when omitted entirely, synthesis falls back to extraction provider/model
  # explicit top-level inference.workloads bindings override legacy provider selection

claudeCode:
  allowApiKeyEnv: false          # true explicitly inherits ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
  # maxBudgetUsd: 0.25           # optional; maps to claude -p --max-budget-usd
  cooldownMs: 300000             # ms, range 1000–3600000

worker:
  maxRetries: 3                  # range 1–10
  leaseTimeoutMs: 300000         # ms, range 10000–600000
  maxLlmConcurrency: 2           # shared cap for live LLM calls, range 1–16; SIGNET_MAX_LLM_CONCURRENCY overrides YAML when set
  # retired under #946 (standalone extraction worker removed): pollMs, maxLoadPerCpu, overloadBackoffMs, threadedExtraction

graph:
  enabled: true
  boostWeight: 0.15              # fraction 0.0–1.0
  boostTimeoutMs: 500            # ms, range 50–5000

reranker:
  enabled: true
  model: ""
  useExtractionModel: false
  topN: 20                       # range 1–100
  timeoutMs: 2000                # ms, range 100–30000

autonomous:
  enabled: true
  frozen: false
  allowUpdateDelete: true
  maintenanceIntervalMs: 1800000 # 30 min, range 60s–24h
  maintenanceMode: execute       # "observe" | "execute"

repair:
  reembedCooldownMs: 300000      # 5 min, range 10s–1h
  reembedHourlyBudget: 10        # range 1–1000
  requeueCooldownMs: 60000       # 1 min, range 5s–1h
  requeueHourlyBudget: 50        # range 1–1000
  dedupCooldownMs: 600000        # 10 min, range 10s–1h
  dedupHourlyBudget: 3           # range 1–100
  dedupSemanticThreshold: 0.92   # fraction 0.0–1.0
  dedupBatchSize: 100            # range 10–1000

documents:
  workerIntervalMs: 10000        # ms, range 1s–300s
  chunkSize: 2000                # chars, range 200–50000
  chunkOverlap: 200              # chars, range 0–10000
  maxContentBytes: 10485760      # 10 MB, range 1 KB–100 MB

guardrails:
  maxContentChars: 800           # range 50–100000
  chunkTargetChars: 600          # range 50–50000
  recallTruncateChars: 500       # range 50–100000
  contextBudgetChars: 4000

continuity:
  enabled: true
  promptInterval: 10             # range 1–1000
  timeIntervalMs: 900000         # 15 min, range 60s–1h
  maxCheckpointsPerSession: 50   # range 1–500
  retentionDays: 7               # range 1–90
  recoveryBudgetChars: 2000      # range 200–10000

telemetry:
  # anonymous usage telemetry; see docs/TELEMETRY.md for the event catalog,
  # privacy contract, and audit log
  telemetryEnabled: true        # set false to opt out
  posthogHost: "https://us.i.posthog.com"
  posthogApiKey: "phc_mLsvJmbmp6e9UarrX9Cq5QtTjVNiiphM9mvi5Xnddd8Q"  # public ingest key
  flushIntervalMs: 60000         # ms, range 5s–10min
  flushBatchSize: 50             # range 1–500
  retentionDays: 90              # range 1–365

embeddingTracker:
  enabled: true
  pollMs: 5000                   # ms, range 1s–60s
  batchSize: 8                   # range 1–20

hints:
  enabled: false
  max: 5                         # range 1–20
  timeout: 45000                 # ms, range 5000–300000
  poll: 5000                     # ms, range 1000–60000

dampening:
  gravityEnabled: true
  hubEnabled: true
  resolutionEnabled: true
  hubPercentile: 0.9             # fraction 0.0–1.0
  hubPenalty: 0.7                # fraction 0.0–1.0
  gravityPenalty: 0.5            # fraction 0.0–1.0
  resolutionBoost: 1.2           # multiplier
```

### Example configurations

A minimal configuration to enable the pipeline in shadow mode:

```yaml
memory:
  pipelineV2:
    enabled: true
    shadowMode: true
```

To enable controlled writes with graph support:

```yaml
memory:
  pipelineV2:
    enabled: true
    graph:
      enabled: true
    extraction:
      minConfidence: 0.75
```

To enable autonomous maintenance in execute mode:

```yaml
memory:
  pipelineV2:
    enabled: true
    autonomous:
      enabled: true
      maintenanceMode: execute
```

Full production configuration:

```yaml
memory:
  pipelineV2:
    enabled: true
    semanticContradictionEnabled: true
    extraction:
      provider: llama-cpp
      model: qwen3:4b
    graph:
      enabled: true
    autonomous:
      enabled: true
      maintenanceMode: execute
    continuity:
      enabled: true
      promptInterval: 10
    embeddingTracker:
      enabled: true
      pollMs: 5000
```


---

## Multi-Agent Pipeline Notes

When multiple agents share a daemon, the pipeline tags each extracted memory
with the requesting agent's ID. The `agent_id` is resolved from the
session-start hook request: if the caller provides `agentId` in the body it
is used directly; otherwise the daemon parses OpenClaw's session key format
(`agent:{id}:{rest}`) as a fallback.

Extracted memories default to `visibility = 'global'`. Callers that want
private memories must set `visibility = 'private'` explicitly in the
remember request or via `signet remember --private`.

The pipeline worker itself is agent-agnostic: it operates on the `memory_jobs`
queue and reads `agent_id` from each job record. Entity graph operations
(extraction, traversal, aspect updates) all pass `agent_id` through to
ensure knowledge is scoped to the correct agent.
