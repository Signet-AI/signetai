---
title: "Operations SDK"
description: "Privileged operator, repair, analytics, configuration, and extension calls."
---

Keep these methods behind an operator-only boundary. Authorization is enforced by the daemon; do not expose them as unrestricted model tools.

- Analytics: `getTelemetryEvents`, `getTelemetryStats`, `exportTelemetry`, `getMemorySearchTelemetry`, `exportMemorySearchTelemetry`, `getUsageCounters`, `getErrors`, `getLatency`, `getAnalyticsLogs`, `getMemorySafety`, `getContinuity`.
- Repair: `requeueDeadJobs()`, `releaseStaleLeases()`, `checkFts({ repair?: boolean })`, `triggerRetentionSweep()`, `getEmbeddingGaps()`, `reembedMissing({ limit?: number })`, `resyncVectorIndex()`, `cleanOrphanedEmbeddings()`, `getDedupStats()`, `deduplicateMemories({ dryRun?: boolean })`, `pruneChunkGroups()`, `pruneSingletonEntities({ minMentions?: number })`.
- Configuration/extensions: `listConfig`, `writeConfig`, embedding, git, harness/checkpoint, plugin, and skill methods.

Skill signatures are `listSkills()`, `browseSkills()`, `searchSkills(query)`, `getSkill(name, source?)`, `installSkill(name, source?)`, and `uninstallSkill(name)`. Predictor methods are retained compatibility members that throw after predictor removal; remove those calls.
