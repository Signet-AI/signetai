---
title: "Operations SDK"
description: "Privileged operator, repair, analytics, configuration, and extension calls."
---

Keep these methods behind an operator-only boundary.

- Analytics: `getTelemetryEvents`, `getTelemetryStats`, `exportTelemetry`, `getMemorySearchTelemetry`, `exportMemorySearchTelemetry`, `getUsageCounters`, `getErrors`, `getLatency`, `getAnalyticsLogs`, `getMemorySafety`, `getContinuity`.
- Repair: `requeueDeadJobs`, `releaseStaleLeases`, `checkFts`, `triggerRetentionSweep`, `getEmbeddingGaps`, `reembedMissing`, `resyncVectorIndex`, `cleanOrphanedEmbeddings`, `getDedupStats`, `deduplicateMemories`, `pruneChunkGroups`, `pruneSingletonEntities`.
- Configuration/extensions: `listConfig`, `writeConfig`, embedding, git, harness/checkpoint, plugin, and skill methods.

> **Privileged:** These calls can expose telemetry, alter configuration, repair leases/indexes, mutate retention state, or install extensions. Authorization is enforced by the daemon; do not expose them as unrestricted model tools.

Predictor methods (`getPredictorStatus`, `getComparisonsByProject`, `getComparisonsByEntity`, `listComparisons`, `listTrainingRuns`, `getTrainingPairsCount`, `trainPredictor`) are retained compatibility members that throw after predictor removal. They are not runtime endpoints and should be removed from callers.
