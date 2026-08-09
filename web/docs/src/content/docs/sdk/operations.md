---
title: "Operations SDK"
description: "Use plugin diagnostics, skills, analytics, repair, pipeline, config, and embedding APIs."
---

## Plugin Diagnostics

Inspect the Plugin SDK V1 registry and active prompt contributions.

**`listPlugins()`**: List registered daemon plugins.

```typescript
const { plugins } = await signet.listPlugins();
const secretsPlugin = plugins.find((plugin) => plugin.id === "signet.secrets");
const graphiqPlugin = plugins.find((plugin) => plugin.id === "signet.graphiq");
```

**`getPlugin(id)`**: Get one plugin registry record.

```typescript
const plugin = await signet.getPlugin("signet.secrets");
console.log(plugin.state);
```

**`getPluginDiagnostics(id)`**: Get manifest, surface, and validation
diagnostics for one plugin.

```typescript
const diagnostics = await signet.getPluginDiagnostics("signet.secrets");
console.log(diagnostics.plugin.activeSurfaces.sdkClients);
console.log(diagnostics.plugin.promptContributionDiagnostics);
```

The optional GraphIQ plugin is registered as `signet.graphiq`. It is disabled
by default, can be enabled during setup, and contributes CLI/MCP/prompt
surfaces for generic code retrieval after `signet index <path>` activates a
project.

**`listPluginPromptContributions()`**: List active plugin prompt
contributions.

```typescript
const { contributions } = await signet.listPluginPromptContributions();
```

**`listPluginAuditEvents(opts?)`**: List durable plugin audit events.
Sensitive fields are redacted by the daemon.

```typescript
const audit = await signet.listPluginAuditEvents({
  pluginId: "signet.secrets",
  event: "plugin.capability_denied",
  limit: 20,
});
console.log(audit.events[0]?.result);
```

## Skills Marketplace

Browse, install, and manage agent skills from skills.sh.

**`listSkills()`** — List installed skills.

```typescript
const skills = await signet.listSkills();
// skills[n].name — skill name
// skills[n].version — installed version
// skills[n].description — skill description
// skills[n].source — installation source (local | registry)
```

**`browseSkills(opts?)`** — Browse available skills from marketplace.

```typescript
const available = await signet.browseSkills({
  category: "development",
  limit: 20,
});
// available[n].name — skill name
// available[n].description — skill description
// available[n].author — skill author
// available[n].downloads — download count
```

**`searchSkills(query)`** — Search for skills by keyword.

```typescript
const results = await signet.searchSkills("git workflow");
// results[n].name — matching skill
// results[n].relevance — search score
```

**`getSkill(name)`** — Get details for a specific skill.

```typescript
const skill = await signet.getSkill("git-workflow");
// skill.name — skill name
// skill.readme — full documentation
// skill.examples — usage examples
// skill.dependencies — required dependencies
```

**`installSkill(opts)`** — Install a skill from marketplace or URL.

```typescript
await signet.installSkill({
  name: "code-review",  // From registry
  // OR
  url: "https://github.com/user/custom-skill",  // From git
});
```

**`uninstallSkill(name)`** — Remove an installed skill.

```typescript
await signet.uninstallSkill("old-workflow");
```

## Analytics & Telemetry

Query usage analytics and performance metrics.

**`getTelemetryEvents(opts?)`** — Query telemetry events.

```typescript
const events = await signet.getTelemetryEvents({
  event: "llm.generate",
  since: "2025-01-01T00:00:00Z",
  limit: 100,
});
// events.enabled — false when telemetry is disabled
// events.events — event list
```

**`getTelemetryStats(opts?)`** — Get aggregated telemetry stats.

```typescript
const stats = await signet.getTelemetryStats({ since: "2025-01-01T00:00:00Z" });
if (stats.enabled) {
  console.log(stats.llm.calls, stats.pipelineErrors);
}
```

**`exportTelemetry(opts?)`** — Export telemetry as NDJSON text.

```typescript
const ndjson = await signet.exportTelemetry({ limit: 1000 });
// ndjson — raw newline-delimited JSON string
```

**`getUsageAnalytics()`** — Get usage counters.

```typescript
const usage = await signet.getUsageAnalytics();
// usage.memories_created — total memories created
// usage.memories_recalled — recall operations performed
// usage.documents_ingested — documents processed
// usage.queries_total — total queries made
```

**`getErrorAnalytics()`** — Get recent error events.

```typescript
const errors = await signet.getErrorAnalytics({
  since: "2025-01-01T00:00:00Z",
  limit: 100,
});
// errors[n].timestamp — when error occurred
// errors[n].operation — which operation failed
// errors[n].error — error message
// errors[n].stack — stack trace (if available)
```

**`getLatencyAnalytics()`** — Get latency histograms.

```typescript
const latency = await signet.getLatencyAnalytics();
// latency.embedding_ms — embedding latency stats
// latency.recall_ms — recall latency stats
// latency.extraction_ms — extraction latency stats
```

**`getLogAnalytics()`** — Get structured log entries.

```typescript
const logs = await signet.getLogAnalytics({
  level: "warn",
  since: "2025-01-01T00:00:00Z",
  limit: 50,
});
// logs[n].timestamp — log timestamp
// logs[n].level — log level
// logs[n].message — log message
// logs[n].metadata — structured metadata
```

**`getMemorySafetyAnalytics()`** — Get mutation diagnostics.

```typescript
const safety = await signet.getMemorySafetyAnalytics();
// safety.mutations_total — total mutation operations
// safety.mutations_blocked — blocked mutations (frozen mode, etc.)
// safety.conflicts_detected — concurrent modification conflicts
```

**`getContinuityAnalytics()`** — Get session continuity scores over time.

```typescript
const continuity = await signet.getContinuityAnalytics({
  since: "2025-01-01T00:00:00Z",
});
// continuity[n].timestamp — measurement time
// continuity[n].project — project path
// continuity[n].score — continuity score (0-1)
// continuity[n].memories_injected — context size
```

**`getLatestContinuity()`** — Get latest continuity score per project.

```typescript
const latest = await signet.getLatestContinuity();
// latest[n].project — project path
// latest[n].score — latest continuity score
// latest[n].timestamp — when measured
```

## Repair & Maintenance

Repair actions for broken state and maintenance operations.

**`requeueDeadJobs()`** — Requeue dead-letter jobs.

```typescript
const result = await signet.requeueDeadJobs();
// result.requeued — number of jobs requeued
// result.failed — jobs that couldn't be requeued
```

**`releaseStaleLeases()`** — Release stale job leases.

```typescript
const result = await signet.releaseStaleLeases();
// result.released — number of leases released
```

**`checkFtsConsistency()`** — Check/repair FTS consistency.

```typescript
const result = await signet.checkFtsConsistency();
// result.inconsistencies — found inconsistencies
// result.repaired — whether repairs were made
```

**`triggerRetentionSweep()`** — Trigger retention policy sweep.

```typescript
await signet.triggerRetentionSweep();
// Removes memories past retention period
```

**`getEmbeddingGaps()`** — Count unembedded memories.

```typescript
const gaps = await signet.getEmbeddingGaps();
// gaps.total — total memories without embeddings
// gaps.by_type — breakdown by memory type
```

**`reembedMissing()`** — Re-embed memories without vectors.

```typescript
const result = await signet.reembedMissing({
  batch_size: 100,
});
// result.processed — memories re-embedded
// result.failed — failures
```

**`resyncVectorIndex()`** — Resync entire vector index.

```typescript
await signet.resyncVectorIndex();
// Rebuilds vector index from scratch
```

**`cleanOrphanedEmbeddings()`** — Remove orphaned embeddings.

```typescript
const result = await signet.cleanOrphanedEmbeddings();
// result.removed — orphaned embeddings deleted
```

**`getDedupStats()`** — Get deduplication statistics.

```typescript
const stats = await signet.getDedupStats();
// stats.duplicates_found — duplicate groups detected
// stats.space_saved — bytes saved by deduplication
```

**`deduplicateMemories()`** — Deduplicate memories.

```typescript
const result = await signet.deduplicateMemories({
  min_similarity: 0.95,
  mode: "execute",  // "preview" | "execute"
});
// result.duplicates_found — duplicates detected
// result.merged — memories merged (execute mode)
```

**`pruneChunkGroups()`** — Prune chunk_group entities.

```typescript
const result = await signet.pruneChunkGroups();
// result.pruned — chunk groups removed
```

**`pruneSingletonEntities()`** — Prune singleton extracted entities.

```typescript
const result = await signet.pruneSingletonEntities();
// result.pruned — singleton entities removed
```

## Pipeline & Diagnostics

Monitor pipeline status and system diagnostics.

**`getPipelineStatus()`** — Get pipeline worker status.

```typescript
const status = await signet.getPipelineStatus();
// status.extraction — extraction worker status
// status.ingestion — document ingestion status
// status.graph — knowledge graph status
// status.retention — retention worker status
// status.jobs_pending — pending job count
```

**`getDiagnostics(domain?)`** — Get health diagnostics.

```typescript
const all = await signet.getDiagnostics();
// all.overall_score — overall health score (0-100)
// all.domains — per-domain breakdown

const embeddings = await signet.getDiagnostics("embeddings");
// embeddings.score — embeddings health score
// embeddings.issues — detected issues
// embeddings.recommendations — repair recommendations
```

## Config & Identity

Read and write daemon configuration and identity files.

**`getConfig()`** — Read daemon configuration.

```typescript
const config = await signet.getConfig();
// config — parsed agent.yaml contents
```

**`setConfig(opts)`** — Write daemon configuration.

```typescript
await signet.setConfig({
  content: yaml.stringify(newConfig),
  reason: "Updated embedding model",
});
```

**`getIdentity()`** — Read identity files.

```typescript
const identity = await signet.getIdentity({
  files: ["AGENTS.md", "USER.md"],
});
// identity.AGENTS.md — file contents
// identity.USER.md — file contents
```

## Embeddings

Monitor embedding status and health.

**`getEmbeddingStatus()`** — Get embedding processing status.

```typescript
const status = await signet.getEmbeddingStatus();
// status.provider — "native" | "ollama" | "openai" | "none"
// status.model — embedding model name
// status.available — provider availability
// status.base_url — provider URL
// status.checkedAt — last check timestamp
```

**`getEmbeddingHealth()`** — Get embedding health metrics.

```typescript
const health = await signet.getEmbeddingHealth();
// health.totalMemories — total memories
// health.embeddedCount — memories with vectors
// health.unembeddedCount — memories missing vectors
// health.coveragePercent — embedding coverage
```

**`getEmbeddingProjection(opts)`** — Get UMAP projection for visualization.

```typescript
const projection = await signet.getEmbeddingProjection({
  dimensions: 2,  // 2D or 3D
});
if (projection.status === "ready") {
  // projection.nodes[n].id — memory ID
  // projection.nodes[n].x, .y, .z — coordinates
  // projection.edges — graph edges
}
// projection.status may also be "computing" or "error"
```
