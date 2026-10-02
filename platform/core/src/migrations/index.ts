import { up as transcriptImportBytes } from "./151-transcript-import-bytes";
import { up as memoryArtifactShaIndex } from "./152-memory-artifact-sha-index";
import { up as transcriptCaptureSourceIdentity } from "./154-transcript-capture-source-identity";
import { up as sourceSyncFailures } from "./155-source-sync-failures";
import { up as retireObsoleteInvocationLedger } from "./159-retire-obsolete-invocation-ledger";

import type { Migration, MigrationArtifacts, MigrationDb } from "./contract";

import { up as baseline } from "./001-baseline";
import { up as pipelineV2 } from "./002-pipeline-v2";
import { up as uniqueContentHash } from "./003-unique-content-hash";
import { up as historyActorAndRetention } from "./004-history-actor-and-retention";
import { up as graphExtended } from "./005-graph-extended";
import { up as idempotencyKey } from "./006-idempotency-key";
import { up as documentsAndConnectors } from "./007-documents-and-connectors";
import { up as embeddingsUniqueHash } from "./008-embeddings-unique-hash";
import { up as summaryJobs } from "./009-summary-jobs";
import { up as umapCache } from "./010-umap-cache";
import { up as sessionScores } from "./011-session-scores";
import { up as scheduledTasks } from "./012-scheduled-tasks";
import { up as ingestionTracking } from "./013-ingestion-tracking";
import { up as telemetry } from "./014-telemetry";
import { up as sessionMemories } from "./015-session-memories";
import { up as sessionCheckpoints } from "./016-session-checkpoints";
import { up as taskSkills } from "./017-task-skills";
import { up as skillMeta } from "./018-skill-meta";
import { up as knowledgeStructure } from "./019-knowledge-structure";
import { up as sessionStructuralColumns } from "./020-predictor-comparisons";
import { up as checkpointStructural } from "./021-checkpoint-structural";
import { up as entityPinning } from "./022-entity-pinning";
import { up as retiredScorerGap23 } from "./023-predictor-columns";
import { up as retiredScorerGap24 } from "./024-predictor-comparison-columns";
import { up as agentFeedback } from "./025-agent-feedback";
import { up as retiredScorerGap26 } from "./026-predictor-training-pairs";
import { up as backfillCanonicalNames } from "./027-backfill-canonical-names";
import { up as losslessRetention } from "./028-lossless-retention";
import { up as sessionSummaryDag } from "./029-session-summary-dag";
import { up as nullableMemoryJobMemoryId } from "./030-nullable-memory-job-memory-id";
import { up as dependencyReason } from "./031-dependency-reason";
import { up as embeddingsVectorColumn } from "./032-embeddings-vector-column";
import { up as scope } from "./033-scope";
import { up as scopeAwareDedup } from "./034-scope-aware-dedup";
import { up as entityFts } from "./035-entity-fts";
import { up as dependencyConfidence } from "./036-dependency-confidence";
import { up as entityCommunities } from "./037-entity-communities";
import { up as memoryHints } from "./038-memory-hints";
import { up as dedupEntityDependencies } from "./039-dedup-entity-dependencies";
import { up as sessionTranscripts } from "./040-session-transcripts";
import { up as pathFeedback } from "./041-path-feedback";
import { up as sessionMemoriesAgentId } from "./042-session-memories-agent-id";
import { up as agentsTable } from "./043-agents-table";
import { up as memoryMdTemporalHead } from "./044-memory-md-temporal-head";
import { up as losslessWorkingMemoryHardening } from "./045-lossless-working-memory-hardening";
import { up as sessionSummaryUniqueness } from "./046-session-summary-uniqueness";
import { up as agentScopedTemporalUniqueness } from "./047-agent-scoped-temporal-uniqueness";
import { up as threadHeads } from "./048-thread-heads";
import { up as sessionExtractCursors } from "./049-session-extract-cursors";
import { up as relatedToAudit } from "./050-related-to-audit";
import { up as memoryMdRollingWindowLineage } from "./051-memory-md-rolling-window-lineage";
import { up as mcpInvocations } from "./052-mcp-invocations";
import { up as skillInvocations } from "./053-skill-invocations";
import { up as taskAgentScope } from "./054-task-agent-scope";
import { up as dreamingState } from "./055-dreaming-state";
import { up as agentScopedContentHash } from "./056-agent-scoped-content-hash";
import { up as memoriesFtsTokenizerRepair } from "./057-memories-fts-tokenizer-repair";
import { up as knowledgeGraphIndices } from "./058-knowledge-graph-indices";
import { up as entityAttributeClaimKey } from "./059-entity-attribute-claim-key";
import { up as entityAttributeGroupKey } from "./060-entity-attribute-group-key";
import { up as memoryArtifactSourceMtime } from "./061-memory-artifact-source-mtime";
import { up as memoryArtifactSoftDelete } from "./062-memory-artifact-soft-delete";
import { up as contentOnlyMemoriesFtsUpdate } from "./063-content-only-memories-fts-update";
import { up as sourceGraphProvenance } from "./064-source-graph-provenance";
import { up as sourceEmbeddingAgentScope } from "./065-source-embedding-agent-scope";
import { up as memorySearchTelemetry } from "./066-memory-search-telemetry";
import { up as ontologyProposals } from "./067-ontology-proposals";
import { up as dailyReflections } from "./068-daily-reflections";
import { up as dailyReflectionsMultipleInsights } from "./069-daily-reflections-multiple-insights";
import { up as ontologyControlPlaneState } from "./070-ontology-control-plane-state";
import { up as epistemicAssertions } from "./071-epistemic-assertions";
import { up as agentScopedIdempotencyKey } from "./072-agent-scoped-idempotency-key";
import { up as recallContextDedupe } from "./073-recall-context-dedupe";
import { up as aggregateMemoryLinks } from "./074-aggregate-memory-links";
import { up as memoryArtifactSourceProvenance } from "./075-memory-artifact-source-provenance";
import { up as temporalEdges } from "./076-temporal-edges";
import { up as entityAliases } from "./077-entity-aliases";
import { up as apiKeys } from "./078-api-keys";
import { up as transcriptCaptureJobs } from "./079-transcript-capture-jobs";
import { up as documentScopeColumns } from "./080-document-scope-columns";
import { up as aggregateEvidenceSources } from "./081-aggregate-evidence-sources";
import { up as skillInvocationsHarness } from "./082-skill-invocations-harness";
import { up as memoryLifecycleRepair } from "./083-memory-lifecycle-repair";
import { up as legacyMarkdownImportState } from "./084-legacy-markdown-import-state";
import { up as backfillRelationsToDependencies } from "./085-backfill-relations-to-dependencies";
import { up as summaryJobsContentHash } from "./086-summary-jobs-content-hash";
import { up as summaryJobsBoundaryReason } from "./087-summary-jobs-boundary-reason";
import { up as transcriptRecoveryFiles } from "./088-transcript-recovery-files";
import { up as jobCancellations } from "./089-job-cancellations";
import { up as jobArchive } from "./090-job-archive";
import { up as embeddingIndexGenerations } from "./091-embedding-index-generations";
import { up as embeddingStagingStore } from "./092-embedding-staging-store";
import { up as dreamingEvidenceCursor } from "./093-dreaming-evidence-cursor";
import { up as memoryKind } from "./094-memory-kind";
import { up as compactionRecallProjections } from "./095-compaction-recall-projections";
import { up as retireLegacyIngestion } from "./096-retire-legacy-ingestion";
import { up as dreamingFailureBackoff } from "./097-dreaming-failure-backoff";
import { up as dreamingEvidenceExclusions } from "./098-dreaming-evidence-exclusions";
import { up as dreamingToolCalls } from "./099-dreaming-tool-calls";
import { up as dreamingRunbook } from "./100-dreaming-runbook";
import { up as dreamingAttention } from "./101-dreaming-attention";
import { up as attributeSemanticMemories } from "./102-attribute-semantic-memories";
import { up as semanticMemoryKind } from "./103-semantic-memory-kind";
import { up as derivedMemoryProvenance } from "./104-derived-memory-provenance";
import { up as agentScopedEntityName } from "./105-agent-scoped-entity-name";
import { up as memoryReviewAfter } from "./106-memory-review-after";
import { up as dreamingPassUsage } from "./107-dreaming-pass-usage";
import { up as embeddingUsage } from "./108-embedding-usage";
import { up as telemetryInstall } from "./109-telemetry-install";
import { up as memoryMentionJoinIndex } from "./110-memory-mention-join-index";
import { up as telemetryFirstUse } from "./111-telemetry-first-use";
import { up as telemetryQueueOwnership } from "./112-telemetry-queue-ownership";
import { up as sessionClaims } from "./113-session-claims";
import { up as memoryTraversalHydrationIndex } from "./114-memory-traversal-hydration-index";
import { up as crossAgentMessageNotifications } from "./115-cross-agent-message-notifications";
import { up as acpDeliveryReconciliation } from "./116-acp-delivery-reconciliation";
import { up as retireSummaryWorker } from "./117-retire-summary-worker";
import { up as queuePressureIndices } from "./118-queue-pressure-indices";
import { up as telemetryVersionObservation } from "./119-telemetry-version-observation";
import { up as sourceLifecycleTelemetry } from "./120-source-lifecycle-telemetry";
import { up as telemetryDeliveryHealth } from "./121-telemetry-delivery-health";
import { up as dreamingEvidenceRetry } from "./122-dreaming-evidence-retry";
import { up as embeddingIndexFailures } from "./123-embedding-index-failures";
import { up as importedDerivedLifecycle } from "./124-import-derived-lifecycle";
import { up as memoryContentSafety } from "./125-memory-content-safety";
import { up as dreamingSurprisalAttention } from "./126-dreaming-surprisal-attention";
import { up as ontologyContradictions } from "./127-ontology-contradictions";
import { up as boundedQueueDiagnostics } from "./128-bounded-queue-diagnostics";
import { up as retireStructuralJobs } from "./129-retire-structural-jobs";
import { up as embeddingRepairState } from "./130-embedding-repair-state";
import { up as dreamingEvidenceConsumption } from "./131-dreaming-evidence-consumption";
import { up as observerScopedEpistemicAssertions } from "./132-observer-scoped-epistemic-assertions";
import { up as dreamingMemoryHead } from "./133-dreaming-memory-head";
import { up as scopeMemoryHeadEntries } from "./134-scope-memory-head-entries";
import { up as memoryHeadPublication } from "./135-memory-head-publication";
import { up as memoryHeadRevisions } from "./136-memory-head-revisions";
import { up as dreamingHeadManifest } from "./137-dreaming-head-manifest";
import { up as boundedStatusProjections } from "./138-bounded-status-projections";
import { up as nativeSourceSyncState } from "./139-native-source-sync-state";
import { up as transcriptRecoveryFrontier } from "./140-transcript-recovery-frontier";
import { up as sourceSyncCheckpoints } from "./141-source-sync-checkpoints";
import { up as sourceSyncFrontier } from "./142-source-sync-frontier";
import { up as embeddingIndexProgress } from "./143-embedding-index-progress";
import { up as memoryJobLeaseToken } from "./144-memory-job-lease-token";
import { up as dreamingEvidenceReviews } from "./145-dreaming-evidence-reviews";
import { up as sourceTranscriptImport } from "./146-source-transcript-import";
import { up as sourceImportReplayFileSlots } from "./147-source-import-replay-file-slots";
import { up as sourceImportAttemptProvenance } from "./148-source-import-attempt-provenance";
import { up as transcriptImportStateMachine } from "./149-transcript-import-state-machine";
import { up as memoryHeadFreshness } from "./150-memory-head-freshness";
import { up as vectorRepairCheckpoints } from "./153-vector-repair-checkpoints";
import { up as embeddingRepairCheckpoints } from "./156-embedding-repair-checkpoints";
import { up as embeddingRepairProgress } from "./157-embedding-repair-progress";
import { up as dreamingCandidateScanIndex } from "./158-dreaming-candidate-scan-index";
import { up as importAdmissionLedger } from "./160-import-admission-ledger";

export type { Migration, MigrationArtifacts, MigrationDb } from "./contract";

function defineMigration(
	version: number,
	name: string,
	up: Migration["up"],
	artifacts?: MigrationArtifacts,
): Migration {
	return { version, name, up, ...(artifacts === undefined ? {} : { artifacts }) };
}
export const MIGRATIONS: readonly Migration[] = [
	defineMigration(1, "baseline", baseline, { tables: ["memories", "conversations", "embeddings"] }),
	defineMigration(2, "pipeline-v2", pipelineV2, {
		tables: ["memory_history", "memory_jobs", "entities", "relations", "memory_entity_mentions"],
	}),
	defineMigration(3, "unique-content-hash", uniqueContentHash),
	defineMigration(4, "history-actor-and-retention", historyActorAndRetention, {
		columns: [{ table: "memory_history", column: "actor_type" }],
	}),
	defineMigration(5, "graph-extended", graphExtended, {
		columns: [{ table: "entities", column: "canonical_name" }],
	}),
	defineMigration(6, "idempotency-key", idempotencyKey, {
		columns: [{ table: "memories", column: "idempotency_key" }],
	}),
	defineMigration(7, "documents-and-connectors", documentsAndConnectors, {
		tables: ["documents", "document_memories", "connectors"],
	}),
	defineMigration(8, "embeddings-unique-hash", embeddingsUniqueHash),
	defineMigration(9, "summary-jobs", summaryJobs, { tables: ["summary_jobs"] }),
	defineMigration(10, "umap-cache", umapCache, { tables: ["umap_cache"] }),
	defineMigration(11, "session-scores", sessionScores, { tables: ["session_scores"] }),
	defineMigration(12, "scheduled-tasks", scheduledTasks, { tables: ["scheduled_tasks", "task_runs"] }),
	defineMigration(13, "ingestion-tracking", ingestionTracking, {
		columns: [
			{ table: "memories", column: "source_path" },
			{ table: "memories", column: "source_section" },
		],
	}),
	defineMigration(14, "telemetry", telemetry, { tables: ["telemetry_events"] }),
	defineMigration(15, "session-memories", sessionMemories, {
		tables: ["session_memories"],
		columns: [
			{ table: "session_scores", column: "confidence" },
			{ table: "session_scores", column: "continuity_reasoning" },
		],
	}),
	defineMigration(16, "session-checkpoints", sessionCheckpoints, { tables: ["session_checkpoints"] }),
	defineMigration(17, "task-skills", taskSkills, {
		columns: [{ table: "scheduled_tasks", column: "skill_name" }],
	}),
	defineMigration(18, "skill-meta", skillMeta, { tables: ["skill_meta"] }),
	defineMigration(19, "knowledge-structure", knowledgeStructure, {
		tables: ["entity_aspects", "entity_attributes", "entity_dependencies", "task_meta"],
		columns: [{ table: "entities", column: "agent_id" }],
	}),
	defineMigration(20, "session-structural-columns", sessionStructuralColumns, {
		columns: [
			{ table: "session_memories", column: "entity_slot" },
			{ table: "session_memories", column: "aspect_slot" },
			{ table: "session_memories", column: "is_constraint" },
			{ table: "session_memories", column: "structural_density" },
		],
	}),
	defineMigration(21, "checkpoint-structural", checkpointStructural, {
		columns: [{ table: "session_checkpoints", column: "focal_entity_ids" }],
	}),
	defineMigration(22, "entity-pinning", entityPinning, {
		columns: [
			{ table: "entities", column: "pinned" },
			{ table: "entities", column: "pinned_at" },
		],
	}),
	defineMigration(23, "retired-scorer-gap", retiredScorerGap23),
	defineMigration(24, "retired-scorer-gap", retiredScorerGap24),
	defineMigration(25, "agent-feedback", agentFeedback, {
		columns: [{ table: "session_memories", column: "agent_relevance_score" }],
	}),
	defineMigration(26, "retired-scorer-gap", retiredScorerGap26),
	defineMigration(27, "backfill-canonical-names", backfillCanonicalNames),
	defineMigration(28, "lossless-retention", losslessRetention),
	defineMigration(29, "session-summary-dag", sessionSummaryDag),
	defineMigration(30, "nullable-memory-job-memory-id", nullableMemoryJobMemoryId),
	defineMigration(31, "dependency-reason", dependencyReason, {
		columns: [
			{ table: "entity_dependencies", column: "reason" },
			{ table: "entities", column: "last_synthesized_at" },
		],
	}),
	defineMigration(32, "embeddings-vector-column", embeddingsVectorColumn, {
		columns: [{ table: "embeddings", column: "vector", optional: true }],
	}),
	defineMigration(33, "scope", scope, {
		columns: [{ table: "memories", column: "scope" }],
	}),
	defineMigration(34, "scope-aware-dedup", scopeAwareDedup),
	defineMigration(35, "entity-fts", entityFts),
	defineMigration(36, "dependency-confidence", dependencyConfidence, {
		columns: [{ table: "entity_dependencies", column: "confidence" }],
	}),
	defineMigration(37, "entity-communities", entityCommunities, {
		tables: ["entity_communities"],
		columns: [{ table: "entities", column: "community_id" }],
	}),
	defineMigration(38, "memory-hints", memoryHints, { tables: ["memory_hints"] }),
	defineMigration(39, "dedup-entity-dependencies", dedupEntityDependencies),
	defineMigration(40, "session-transcripts", sessionTranscripts, { tables: ["session_transcripts"] }),
	defineMigration(41, "path-feedback", pathFeedback, {
		tables: [
			"path_feedback_events",
			"path_feedback_stats",
			"entity_retrieval_stats",
			"entity_cooccurrence",
			"path_feedback_sessions",
		],
		columns: [{ table: "session_memories", column: "path_json" }],
	}),
	defineMigration(42, "session-memories-agent-id", sessionMemoriesAgentId, {
		columns: [{ table: "session_memories", column: "agent_id" }],
	}),
	defineMigration(43, "agents-table", agentsTable, {
		tables: ["agents"],
		columns: [
			{ table: "memories", column: "agent_id" },
			{ table: "memories", column: "visibility" },
		],
	}),
	defineMigration(44, "memory-md-temporal-head", memoryMdTemporalHead, {
		columns: [
			{ table: "session_summaries", column: "source_type" },
			{ table: "session_summaries", column: "source_ref" },
			{ table: "session_summaries", column: "meta_json" },
		],
	}),
	defineMigration(45, "lossless-working-memory-hardening", losslessWorkingMemoryHardening, {
		tables: ["session_transcripts_fts", "memory_md_heads"],
		columns: [
			{ table: "session_transcripts", column: "updated_at" },
			{ table: "summary_jobs", column: "agent_id" },
			{ table: "session_scores", column: "agent_id" },
		],
	}),
	defineMigration(46, "session-summary-uniqueness", sessionSummaryUniqueness),
	defineMigration(47, "agent-scoped-temporal-uniqueness", agentScopedTemporalUniqueness),
	defineMigration(48, "thread-heads", threadHeads, {
		tables: ["memory_thread_heads"],
	}),
	defineMigration(49, "session-extract-cursors", sessionExtractCursors, {
		tables: ["session_extract_cursors"],
	}),
	defineMigration(50, "related-to-audit", relatedToAudit, {
		tables: ["entity_dependency_history"],
	}),
	defineMigration(51, "memory-md-rolling-window-lineage", memoryMdRollingWindowLineage, {
		tables: ["memory_artifacts", "memory_artifact_tombstones", "memory_artifacts_fts"],
		columns: [
			{ table: "summary_jobs", column: "session_id" },
			{ table: "summary_jobs", column: "trigger" },
			{ table: "summary_jobs", column: "captured_at" },
			{ table: "summary_jobs", column: "started_at" },
			{ table: "summary_jobs", column: "ended_at" },
		],
	}),
	defineMigration(52, "mcp-invocations", mcpInvocations),
	defineMigration(53, "skill-invocations", skillInvocations, {
		tables: ["skill_invocations"],
	}),
	defineMigration(54, "task-agent-scope", taskAgentScope, {
		tables: ["task_scope_hints"],
	}),
	defineMigration(55, "dreaming-state", dreamingState, {
		tables: ["dreaming_state", "dreaming_passes"],
	}),
	defineMigration(56, "agent-scoped-content-hash", agentScopedContentHash),
	defineMigration(57, "memories-fts-tokenizer-repair", memoriesFtsTokenizerRepair),
	defineMigration(58, "knowledge-graph-indices", knowledgeGraphIndices),
	defineMigration(59, "entity-attribute-claim-key", entityAttributeClaimKey, {
		columns: [{ table: "entity_attributes", column: "claim_key" }],
	}),
	defineMigration(60, "entity-attribute-group-key", entityAttributeGroupKey, {
		columns: [{ table: "entity_attributes", column: "group_key" }],
	}),
	defineMigration(61, "memory-artifact-source-mtime", memoryArtifactSourceMtime, {
		columns: [{ table: "memory_artifacts", column: "source_mtime_ms" }],
	}),
	defineMigration(62, "memory-artifact-soft-delete", memoryArtifactSoftDelete, {
		columns: [
			{ table: "memory_artifacts", column: "is_deleted" },
			{ table: "memory_artifacts", column: "deleted_at" },
		],
	}),
	defineMigration(63, "content-only-memories-fts-update", contentOnlyMemoriesFtsUpdate),
	defineMigration(64, "source-graph-provenance", sourceGraphProvenance, {
		columns: [
			{ table: "entities", column: "source_path" },
			{ table: "entity_communities", column: "source_path" },
			{ table: "entity_attributes", column: "source_path" },
			{ table: "entity_dependencies", column: "source_path" },
		],
	}),
	defineMigration(65, "source-embedding-agent-scope", sourceEmbeddingAgentScope, {
		columns: [{ table: "embeddings", column: "agent_id", optional: true }],
	}),
	defineMigration(66, "memory-search-telemetry", memorySearchTelemetry, {
		tables: ["memory_search_telemetry"],
	}),
	defineMigration(67, "ontology-proposals", ontologyProposals, {
		tables: ["ontology_proposals"],
		columns: [
			{ table: "entity_attributes", column: "proposal_id" },
			{ table: "entity_attributes", column: "proposal_evidence" },
			{ table: "entity_dependencies", column: "proposal_id" },
			{ table: "entity_dependencies", column: "proposal_evidence" },
		],
	}),
	defineMigration(68, "daily-reflections", dailyReflections, {
		tables: ["daily_reflections"],
	}),
	defineMigration(69, "daily-reflections-multiple-insights", dailyReflectionsMultipleInsights, {
		tables: ["daily_reflections"],
	}),
	defineMigration(70, "ontology-control-plane-state", ontologyControlPlaneState, {
		columns: [
			{ table: "entities", column: "status" },
			{ table: "entity_aspects", column: "status" },
			{ table: "entity_attributes", column: "version" },
			{ table: "entity_attributes", column: "version_root_id" },
			{ table: "entity_attributes", column: "previous_attribute_id" },
			{ table: "entity_dependencies", column: "status" },
		],
	}),
	defineMigration(71, "epistemic-assertions", epistemicAssertions, {
		tables: ["epistemic_assertions"],
	}),
	defineMigration(72, "agent-scoped-idempotency-key", agentScopedIdempotencyKey, {
		columns: [
			{ table: "memories", column: "idempotency_key" },
			{ table: "memories", column: "runtime_path" },
		],
	}),
	defineMigration(73, "recall-context-dedupe", recallContextDedupe, {
		tables: ["session_context_epochs", "session_recall_events"],
	}),
	defineMigration(74, "aggregate-memory-links", aggregateMemoryLinks, {
		tables: ["aggregate_memory_sources"],
	}),
	defineMigration(75, "memory-artifact-source-provenance", memoryArtifactSourceProvenance, {
		columns: [
			{ table: "memory_artifacts", column: "source_id" },
			{ table: "memory_artifacts", column: "source_root" },
			{ table: "memory_artifacts", column: "source_external_id" },
			{ table: "memory_artifacts", column: "source_parent_path" },
			{ table: "memory_artifacts", column: "source_meta_json" },
		],
	}),
	defineMigration(76, "temporal-edges", temporalEdges, {
		tables: ["temporal_edges"],
	}),
	defineMigration(77, "entity-aliases", entityAliases, {
		tables: ["entity_aliases"],
	}),
	defineMigration(78, "api-keys", apiKeys, {
		tables: ["api_keys"],
	}),
	defineMigration(79, "transcript-capture-jobs", transcriptCaptureJobs, {
		tables: ["transcript_capture_jobs"],
	}),
	defineMigration(80, "document-scope-columns", documentScopeColumns, {
		columns: [
			{ table: "documents", column: "agent_id" },
			{ table: "documents", column: "project" },
		],
	}),
	defineMigration(81, "aggregate-evidence-sources", aggregateEvidenceSources, {
		tables: ["aggregate_evidence_sources"],
	}),
	defineMigration(82, "skill-invocations-harness", skillInvocationsHarness, {
		columns: [
			{ table: "skill_invocations", column: "harness" },
			{ table: "skill_invocations", column: "tool_use_id" },
		],
	}),
	defineMigration(83, "memory-lifecycle-repair", memoryLifecycleRepair, {
		tables: ["transcript_capture_jobs", "aggregate_evidence_sources", "entity_dependencies"],
		columns: [
			{ table: "documents", column: "agent_id" },
			{ table: "documents", column: "project" },
			{ table: "memories", column: "superseded_by" },
			{ table: "memories", column: "superseded_at" },
			{ table: "memories", column: "superseded_reason" },
		],
	}),
	defineMigration(84, "legacy-markdown-import-state", legacyMarkdownImportState, {
		tables: ["legacy_markdown_imports", "legacy_markdown_chunks"],
	}),
	defineMigration(85, "backfill-relations-to-dependencies", backfillRelationsToDependencies, {
		tables: ["entity_dependencies"],
	}),
	defineMigration(86, "summary-jobs-content-hash", summaryJobsContentHash, {
		columns: [{ table: "summary_jobs", column: "content_hash" }],
	}),
	defineMigration(87, "summary-jobs-boundary-reason", summaryJobsBoundaryReason, {
		columns: [{ table: "summary_jobs", column: "boundary_reason" }],
	}),
	defineMigration(88, "transcript-recovery-files", transcriptRecoveryFiles, {
		tables: ["transcript_recovery_files"],
	}),
	defineMigration(89, "job-cancellations", jobCancellations, {
		tables: ["job_cancellations"],
	}),
	defineMigration(90, "job-archive", jobArchive, {
		tables: ["job_archive"],
	}),
	defineMigration(91, "embedding-index-generations", embeddingIndexGenerations, { tables: ["embedding_index_state"] }),
	defineMigration(92, "embedding-staging-store", embeddingStagingStore, { tables: ["embeddings_staging"] }),
	defineMigration(93, "dreaming-evidence-cursor", dreamingEvidenceCursor, {
		columns: [{ table: "dreaming_state", column: "evidence_cursor" }],
	}),
	defineMigration(94, "memory-kind", memoryKind, {
		columns: [
			{ table: "memories", column: "memory_kind" },
			{ table: "memories", column: "evidence_meta" },
		],
	}),
	defineMigration(95, "compaction-recall-projections", compactionRecallProjections),
	defineMigration(96, "retire-legacy-ingestion", retireLegacyIngestion),
	defineMigration(97, "dreaming-failure-backoff", dreamingFailureBackoff, {
		columns: [{ table: "dreaming_state", column: "last_failure_at" }],
	}),
	defineMigration(98, "dreaming-evidence-exclusions", dreamingEvidenceExclusions, {
		tables: ["dreaming_evidence_exclusions"],
	}),
	defineMigration(99, "dreaming-tool-calls", dreamingToolCalls, { tables: ["dreaming_tool_calls"] }),
	defineMigration(100, "dreaming-runbook", dreamingRunbook, {
		columns: [
			{ table: "dreaming_passes", column: "evidence_window_json" },
			{ table: "dreaming_passes", column: "runbook_json" },
		],
	}),
	defineMigration(101, "dreaming-attention", dreamingAttention, { tables: ["dreaming_attention"] }),
	defineMigration(102, "attribute-semantic-memories", attributeSemanticMemories),
	defineMigration(103, "semantic-memory-kind", semanticMemoryKind),
	defineMigration(104, "derived-memory-provenance", derivedMemoryProvenance, {
		tables: ["derived_memory_sources"],
		columns: [{ table: "memories", column: "stale_at" }],
	}),
	defineMigration(105, "agent-scoped-entity-name", agentScopedEntityName),
	defineMigration(106, "memory-review-after", memoryReviewAfter, {
		columns: [{ table: "memories", column: "review_after" }],
	}),
	defineMigration(107, "dreaming-pass-usage", dreamingPassUsage, {
		columns: [
			{ table: "dreaming_passes", column: "tokens_input" },
			{ table: "dreaming_passes", column: "tokens_output" },
			{ table: "dreaming_passes", column: "tokens_cache_read" },
			{ table: "dreaming_passes", column: "tokens_cache_write" },
			{ table: "dreaming_passes", column: "tokens_cost" },
		],
	}),
	defineMigration(108, "embedding-usage", embeddingUsage, {
		tables: ["embedding_usage"],
	}),
	defineMigration(109, "telemetry-install", telemetryInstall, {
		tables: ["telemetry_install"],
	}),
	defineMigration(110, "memory-mention-join-index", memoryMentionJoinIndex),
	defineMigration(111, "telemetry-first-use", telemetryFirstUse, {
		columns: [
			{ table: "telemetry_install", column: "first_remember_at" },
			{ table: "telemetry_install", column: "first_recall_at" },
		],
	}),
	defineMigration(112, "telemetry-queue-ownership", telemetryQueueOwnership, {
		columns: [
			{ table: "telemetry_events", column: "source" },
			{ table: "telemetry_events", column: "claim_token" },
			{ table: "telemetry_events", column: "claimed_at" },
		],
	}),
	defineMigration(113, "session-claims", sessionClaims, {
		tables: ["session_claims"],
		columns: [
			{ table: "session_claims", column: "agent_id" },
			{ table: "session_claims", column: "harness" },
			{ table: "session_claims", column: "expires_at" },
			{ table: "session_claims", column: "end_marker" },
		],
	}),
	defineMigration(114, "memory-traversal-hydration-index", memoryTraversalHydrationIndex),
	defineMigration(115, "cross-agent-message-notifications", crossAgentMessageNotifications, {
		tables: ["cross_agent_messages", "cross_agent_message_receipts"],
	}),
	defineMigration(116, "acp-delivery-reconciliation", acpDeliveryReconciliation, {
		columns: [
			{ table: "cross_agent_messages", column: "delivery_state" },
			{ table: "cross_agent_messages", column: "delivery_attempt_id" },
			{ table: "cross_agent_messages", column: "delivery_lease_expires_at" },
			{ table: "cross_agent_messages", column: "acp_base_url" },
			{ table: "cross_agent_messages", column: "acp_target_agent_name" },
		],
	}),
	defineMigration(117, "retire-summary-worker", retireSummaryWorker, {
		columns: [
			{ table: "session_transcripts", column: "completed_at" },
			{ table: "session_transcripts", column: "content_hash" },
		],
	}),
	defineMigration(118, "queue-pressure-indices", queuePressureIndices),
	defineMigration(119, "telemetry-version-observation", telemetryVersionObservation, {
		columns: [{ table: "telemetry_install", column: "last_seen_version" }],
	}),
	defineMigration(120, "source-lifecycle-telemetry", sourceLifecycleTelemetry, { tables: ["source_lifecycle_state"] }),
	defineMigration(121, "telemetry-delivery-health", telemetryDeliveryHealth, {
		tables: ["telemetry_delivery_state"],
		columns: [
			{ table: "telemetry_events", column: "delivery_attempts" },
			{ table: "telemetry_events", column: "last_attempt_at" },
			{ table: "telemetry_events", column: "sent_at" },
			{ table: "telemetry_events", column: "last_failure_code" },
		],
	}),
	defineMigration(122, "dreaming-evidence-retry", dreamingEvidenceRetry, {
		columns: [
			{ table: "dreaming_evidence_exclusions", column: "failure_class" },
			{ table: "dreaming_evidence_exclusions", column: "source_fingerprint" },
			{ table: "dreaming_evidence_exclusions", column: "retry_count" },
			{ table: "dreaming_evidence_exclusions", column: "last_requeued_at" },
		],
	}),
	defineMigration(123, "embedding-index-failures", embeddingIndexFailures, { tables: ["embedding_index_failures"] }),
	defineMigration(124, "import-derived-lifecycle", importedDerivedLifecycle, {
		tables: ["imported_source_lifecycle"],
	}),
	defineMigration(125, "memory-content-safety", memoryContentSafety, { tables: ["memory_content_safety"] }),
	defineMigration(126, "dreaming-surprisal-attention", dreamingSurprisalAttention, { tables: ["dreaming_attention"] }),
	defineMigration(127, "ontology-contradictions", ontologyContradictions, { tables: ["ontology_contradictions"] }),
	defineMigration(128, "bounded-queue-diagnostics", boundedQueueDiagnostics),
	defineMigration(129, "retire-structural-jobs", retireStructuralJobs),
	defineMigration(130, "embedding-repair-state", embeddingRepairState, {
		tables: ["embedding_repair_budget", "embedding_repair_backoff"],
	}),
	defineMigration(131, "dreaming-evidence-consumption", dreamingEvidenceConsumption, {
		tables: ["dreaming_evidence_consumption"],
	}),
	defineMigration(132, "observer-scoped-epistemic-assertions", observerScopedEpistemicAssertions, {
		tables: ["epistemic_assertions"],
	}),
	defineMigration(133, "dreaming-memory-head", dreamingMemoryHead, {
		tables: ["memory_head_revisions", "memory_head_entries", "memory_head_revision_entries"],
	}),
	defineMigration(134, "scope-memory-head-entries", scopeMemoryHeadEntries, { tables: ["memory_head_entries"] }),
	defineMigration(135, "memory-head-publication", memoryHeadPublication, { tables: ["memory_head_publications"] }),
	defineMigration(136, "memory-head-revisions", memoryHeadRevisions, { tables: ["memory_head_revisions"] }),
	defineMigration(137, "dreaming-head-manifest", dreamingHeadManifest, {
		columns: [
			{ table: "dreaming_passes", column: "head_revision" },
			{ table: "dreaming_passes", column: "head_hash" },
		],
	}),
	defineMigration(138, "bounded-status-projections", boundedStatusProjections, {
		tables: ["transcript_capture_status", "memories_duplicate_hash_counts", "memories_diagnostics_state"],
	}),
	defineMigration(139, "native-source-sync-state", nativeSourceSyncState, { tables: ["native_source_sync_state"] }),
	defineMigration(140, "transcript-recovery-frontier", transcriptRecoveryFrontier, {
		tables: ["transcript_recovery_frontiers"],
	}),
	defineMigration(141, "source-sync-checkpoints", sourceSyncCheckpoints, { tables: ["source_sync_checkpoints"] }),
	defineMigration(142, "source-sync-frontier", sourceSyncFrontier, {
		columns: [{ table: "source_sync_checkpoints", column: "frontier" }],
	}),
	defineMigration(143, "embedding-index-progress", embeddingIndexProgress, {
		columns: [
			{ table: "embedding_index_state", column: "migration_phase" },
			{ table: "embedding_index_state", column: "progress_staged" },
			{ table: "embedding_index_state", column: "progress_total" },
			{ table: "embedding_index_state", column: "projection_cursor_last_id" },
			{ table: "embedding_index_state", column: "projection_cursor_slot" },
			{ table: "embedding_index_state", column: "no_progress_ticks" },
			{ table: "embedding_index_state", column: "provider_endpoint" },
		],
	}),
	defineMigration(144, "memory-job-lease-token", memoryJobLeaseToken, {
		columns: [{ table: "memory_jobs", column: "lease_token" }],
	}),
	defineMigration(145, "dreaming-evidence-reviews", dreamingEvidenceReviews, { tables: ["dreaming_evidence_reviews"] }),
	defineMigration(146, "source-transcript-import", sourceTranscriptImport, {
		tables: [
			"source_import_jobs",
			"source_import_files",
			"source_import_records",
			"transcript_import_conversations",
			"source_import_record_attempts",
		],
		columns: [
			{ table: "session_transcripts", column: "source_id" },
			{ table: "session_transcripts", column: "source_record_id" },
			{ table: "session_transcripts", column: "source_meta_json" },
		],
	}),
	defineMigration(147, "source-import-replay-file-slots", sourceImportReplayFileSlots, {
		tables: ["source_import_files"],
	}),
	defineMigration(148, "source-import-attempt-provenance", sourceImportAttemptProvenance, {
		columns: [{ table: "source_import_record_attempts", column: "source_id" }],
	}),
	defineMigration(149, "transcript-import-state-machine", transcriptImportStateMachine, {
		columns: [
			{ table: "source_import_jobs", column: "duplicate_mode" },
			{ table: "source_import_jobs", column: "next_attempt_at" },
			{ table: "source_import_files", column: "error" },
		],
	}),
	defineMigration(150, "memory-head-freshness", memoryHeadFreshness, {
		columns: [
			{ table: "memory_md_heads", column: "is_current" },
			{ table: "dreaming_passes", column: "head_base_revision" },
		],
	}),
	defineMigration(151, "transcript-import-bytes", transcriptImportBytes, {
		tables: [
			"source_import_chunks",
			"source_import_capacity",
			"source_import_migrations",
			"source_import_migration_streams",
			"source_import_migration_counts",
		],
		columns: [
			{ table: "source_import_files", column: "storage_state" },
			{ table: "source_import_files", column: "upload_generation" },
			{ table: "source_import_files", column: "upload_offset" },
			{ table: "source_import_files", column: "upload_size" },
			{ table: "source_import_files", column: "upload_digest" },
			...["checkpoint_line_number", "reserved_bytes", "original_path"].map((column) => ({
				table: "source_import_files",
				column,
			})),
			...["retry_count", "cleanup_state", "retry_cursor", "retry_requested"].map((column) => ({
				table: "source_import_jobs",
				column,
			})),
		],
	}),
	defineMigration(152, "memory-artifact-sha-index", memoryArtifactShaIndex, {
		indexes: ["idx_memory_artifacts_agent_sha"],
	}),
	defineMigration(153, "vector-repair-checkpoints", vectorRepairCheckpoints, { tables: ["vector_repair_checkpoints"] }),
	defineMigration(154, "transcript-capture-source-identity", transcriptCaptureSourceIdentity, {
		columns: [
			{ table: "transcript_capture_jobs", column: "source_identity" },
			{ table: "transcript_capture_jobs", column: "source_sha256" },
			{ table: "transcript_capture_jobs", column: "source_size_bytes" },
			{ table: "transcript_capture_jobs", column: "source_mtime_ms" },
			{ table: "transcript_capture_jobs", column: "source_format" },
			{ table: "transcript_capture_jobs", column: "audit_path" },
		],
	}),
	defineMigration(155, "source-sync-failures", sourceSyncFailures, {
		tables: ["source_sync_failures"],
		indexes: ["idx_source_sync_failures_active"],
	}),
	defineMigration(156, "embedding-repair-checkpoints", embeddingRepairCheckpoints, {
		tables: ["embedding_repair_checkpoints"],
	}),
	defineMigration(157, "embedding-repair-progress", embeddingRepairProgress, {
		tables: ["embedding_repair_progress"],
		columns: [{ table: "embedding_repair_checkpoints", column: "profile_fingerprint" }],
	}),
	defineMigration(158, "dreaming-candidate-scan-index", dreamingCandidateScanIndex, {
		indexes: ["idx_memories_agent_kind"],
	}),
	defineMigration(159, "retire-obsolete-invocation-ledger", retireObsoleteInvocationLedger),
	defineMigration(160, "import-admission-ledger", importAdmissionLedger, {
		tables: ["import_admission_ledger", "import_admission_events"],
		indexes: ["idx_import_admission_status", "idx_import_admission_events_key"],
		columns: [
			...["workspace_id", "request_fingerprint", "source_id", "lease_token", "lease_expires_at", "attempt_count"].map(
				(column) => ({ table: "import_admission_ledger", column }),
			),
		],
	}),
];
function checksum(m: Migration): string {
	let h = 0;
	const s = `${m.version}:${m.name}`;
	for (let i = 0; i < s.length; i++) {
		h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	}
	return h.toString(16);
}
function ensureMetaTables(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL,
			checksum TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS schema_migrations_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			version INTEGER NOT NULL,
			applied_at TEXT NOT NULL,
			duration_ms INTEGER,
			checksum TEXT
		);
	`);
}
function currentVersion(db: MigrationDb): number {
	const row = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get();
	if (row === undefined) return 0;
	const v = row.version;
	return typeof v === "number" ? v : 0;
}
function hasBogusVersion(db: MigrationDb): boolean {
	const current = currentVersion(db);
	if (current < 2) return false;
	const cols = db.prepare("PRAGMA table_info(memories)").all();
	return !cols.filter(hasStringName).some((r) => r.name === "content_hash");
}
function repairBogusVersion(db: MigrationDb): void {
	if (!hasBogusVersion(db)) return;
	db.exec("DELETE FROM schema_migrations WHERE version > 0");
}
function hasStringName(row: Record<string, unknown>): row is { name: string } {
	return typeof row.name === "string";
}
function hasNumericVersion(row: Record<string, unknown>): row is { version: number } {
	return typeof row.version === "number";
}
function existingTables(db: MigrationDb): Set<string> {
	const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
	return new Set(rows.filter(hasStringName).map((r) => r.name));
}
function existingIndexes(db: MigrationDb): Set<string> {
	const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
	return new Set(rows.filter(hasStringName).map((r) => r.name));
}
function tableColumns(db: MigrationDb, table: string, cache: Map<string, Set<string>>): Set<string> {
	let cols = cache.get(table);
	if (cols) return cols;
	const rows = db.prepare(`PRAGMA table_info("${table}")`).all();
	cols = new Set(rows.filter(hasStringName).map((r) => r.name));
	cache.set(table, cols);
	return cols;
}

function missingArtifact(
	db: MigrationDb,
	artifacts: MigrationArtifacts,
	tables: Set<string>,
	indexes: Set<string>,
	colCache: Map<string, Set<string>>,
): string | undefined {
	for (const table of artifacts.tables ?? []) {
		if (!tables.has(table)) return `table "${table}"`;
	}
	for (const column of artifacts.columns ?? []) {
		if (!tables.has(column.table)) {
			if (column.optional) continue;
			return `column "${column.table}.${column.column}" (table missing)`;
		}
		if (!tableColumns(db, column.table, colCache).has(column.column)) {
			if (column.optional) continue;
			return `column "${column.table}.${column.column}"`;
		}
	}
	for (const index of artifacts.indexes ?? []) {
		if (!indexes.has(index)) return `index "${index}"`;
	}
	return undefined;
}
function findPhantomVersions(db: MigrationDb, precomputedApplied?: Set<number>): Set<number> {
	const tables = existingTables(db);
	const indexes = existingIndexes(db);
	const colCache = new Map<string, Set<string>>();
	const phantoms = new Set<number>();
	const applied = precomputedApplied ?? appliedVersions(db);

	for (const migration of MIGRATIONS) {
		const artifacts = migration.artifacts;
		if (
			artifacts &&
			migration.version !== 1 &&
			applied.has(migration.version) &&
			missingArtifact(db, artifacts, tables, indexes, colCache)
		)
			phantoms.add(migration.version);
	}

	return phantoms;
}
function repairPhantomMigrations(db: MigrationDb): Set<number> {
	const applied = appliedVersions(db);
	const phantoms = findPhantomVersions(db, applied);

	for (const version of phantoms) {
		const migration = MIGRATIONS.find((m) => m.version === version);
		if (migration) {
			console.error(
				`[signet] phantom migration v${migration.version} (${migration.name}): artifact missing — will re-run`,
			);
		}
		db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
		applied.delete(version);
	}

	return applied;
}
function appliedVersions(db: MigrationDb): Set<number> {
	const rows = db.prepare("SELECT version FROM schema_migrations").all();
	return new Set(rows.filter(hasNumericVersion).map((r) => r.version));
}
function verifyArtifacts(db: MigrationDb, migration: Migration): void {
	const artifacts = migration.artifacts;
	if (!artifacts) return;
	const missing = missingArtifact(db, artifacts, existingTables(db), existingIndexes(db), new Map());
	if (missing)
		throw new Error(
			`Post-DDL verification failed: migration ${migration.version} (${migration.name}) declares ${missing} but it was not created`,
		);
}
export function hasPendingMigrations(db: MigrationDb): boolean {
	ensureMetaTables(db);
	const applied = appliedVersions(db);
	const isBogus =
		applied.has(2) &&
		!db
			.prepare("PRAGMA table_info(memories)")
			.all()
			.filter(hasStringName)
			.some((r) => r.name === "content_hash");
	const hasNew = MIGRATIONS.some((m) => !applied.has(m.version));
	const phantoms = findPhantomVersions(db, applied);
	return isBogus || hasNew || phantoms.size > 0;
}
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
function assertMigrationsSequence(): void {
	for (let i = 1; i < MIGRATIONS.length; i++) {
		const prev = MIGRATIONS[i - 1];
		const curr = MIGRATIONS[i];
		if (prev !== undefined && curr !== undefined && curr.version !== prev.version + 1) {
			throw new Error(
				`MIGRATIONS invariant violated: version ${curr.version} (${curr.name}) ` +
					`must be exactly ${prev.version + 1} (prev: ${prev.name})`,
			);
		}
	}
}
export function runMigrations(db: MigrationDb): void {
	assertMigrationsSequence();

	ensureMetaTables(db);
	repairBogusVersion(db);
	const applied = repairPhantomMigrations(db);

	for (const migration of MIGRATIONS) {
		if (applied.has(migration.version)) continue;

		const start = Date.now();
		const cs = checksum(migration);
		db.exec(`SAVEPOINT migration_${migration.version}`);
		try {
			migration.up(db);
			verifyArtifacts(db, migration);

			db.prepare(
				`INSERT OR REPLACE INTO schema_migrations
				 (version, applied_at, checksum)
				 VALUES (?, ?, ?)`,
			).run(migration.version, new Date().toISOString(), cs);

			db.prepare(
				`INSERT INTO schema_migrations_audit
				 (version, applied_at, duration_ms, checksum)
				 VALUES (?, ?, ?, ?)`,
			).run(migration.version, new Date().toISOString(), Date.now() - start, cs);

			db.exec(`RELEASE migration_${migration.version}`);
		} catch (err) {
			db.exec(`ROLLBACK TO SAVEPOINT migration_${migration.version}`);
			db.exec(`RELEASE migration_${migration.version}`);
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Migration ${migration.version} (${migration.name}) failed: ${detail}\n\nYour data is safe — the failed migration was rolled back.\nPlease report this at https://github.com/Signet-AI/signetai/issues\nwith the error message above and your signetai version.`,
			);
		}
	}
}
