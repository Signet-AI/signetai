/**
 * Migration runner for Signet's SQLite database
 *
 * Reads the current schema version from `schema_migrations`, runs
 * any pending migrations in order (each inside a transaction), and
 * records execution in `schema_migrations_audit`.
 */

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

// -- Public interface consumed by Database.init() --

export interface MigrationDb {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
}

export interface MigrationArtifacts {
	readonly tables?: readonly string[];
	readonly columns?: readonly {
		readonly table: string;
		readonly column: string;
		/** Skip verification when the table itself doesn't exist (conditional/repair migrations). */
		readonly optional?: boolean;
	}[];
}

export interface Migration {
	readonly version: number;
	readonly name: string;
	readonly up: (db: MigrationDb) => void;
	readonly artifacts?: MigrationArtifacts;
}

/** Ordered list of all migrations. New migrations go at the end. */
export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "baseline",
		up: baseline,
		artifacts: { tables: ["memories", "conversations", "embeddings"] },
	},
	{
		version: 2,
		name: "pipeline-v2",
		up: pipelineV2,
		artifacts: {
			tables: ["memory_history", "memory_jobs", "entities", "relations", "memory_entity_mentions"],
		},
	},
	{
		version: 3,
		name: "unique-content-hash",
		up: uniqueContentHash,
		// No artifact declarations: v3 creates idx_memories_content_hash_unique
		// (an index), but MigrationArtifacts has no `indexes` field. The columns
		// it touches (why, project) are part of the v1 baseline, not v3.
	},
	{
		version: 4,
		name: "history-actor-and-retention",
		up: historyActorAndRetention,
		artifacts: {
			columns: [{ table: "memory_history", column: "actor_type" }],
		},
	},
	{
		version: 5,
		name: "graph-extended",
		up: graphExtended,
		artifacts: {
			columns: [{ table: "entities", column: "canonical_name" }],
		},
	},
	{
		version: 6,
		name: "idempotency-key",
		up: idempotencyKey,
		artifacts: {
			columns: [{ table: "memories", column: "idempotency_key" }],
		},
	},
	{
		version: 7,
		name: "documents-and-connectors",
		up: documentsAndConnectors,
		artifacts: { tables: ["documents", "document_memories", "connectors"] },
	},
	{
		version: 8,
		name: "embeddings-unique-hash",
		up: embeddingsUniqueHash,
	},
	{
		version: 9,
		name: "summary-jobs",
		up: summaryJobs,
		artifacts: { tables: ["summary_jobs"] },
	},
	{
		version: 10,
		name: "umap-cache",
		up: umapCache,
		artifacts: { tables: ["umap_cache"] },
	},
	{
		version: 11,
		name: "session-scores",
		up: sessionScores,
		artifacts: { tables: ["session_scores"] },
	},
	{
		version: 12,
		name: "scheduled-tasks",
		up: scheduledTasks,
		artifacts: { tables: ["scheduled_tasks", "task_runs"] },
	},
	{
		version: 13,
		name: "ingestion-tracking",
		up: ingestionTracking,
		artifacts: {
			columns: [
				{ table: "memories", column: "source_path" },
				{ table: "memories", column: "source_section" },
			],
		},
	},
	{
		version: 14,
		name: "telemetry",
		up: telemetry,
		artifacts: { tables: ["telemetry_events"] },
	},
	{
		version: 15,
		name: "session-memories",
		up: sessionMemories,
		artifacts: {
			tables: ["session_memories"],
			columns: [
				{ table: "session_scores", column: "confidence" },
				{ table: "session_scores", column: "continuity_reasoning" },
			],
		},
	},
	{
		version: 16,
		name: "session-checkpoints",
		up: sessionCheckpoints,
		artifacts: { tables: ["session_checkpoints"] },
	},
	{
		version: 17,
		name: "task-skills",
		up: taskSkills,
		artifacts: {
			columns: [{ table: "scheduled_tasks", column: "skill_name" }],
		},
	},
	{
		version: 18,
		name: "skill-meta",
		up: skillMeta,
		artifacts: { tables: ["skill_meta"] },
	},
	{
		version: 19,
		name: "knowledge-structure",
		up: knowledgeStructure,
		artifacts: {
			tables: ["entity_aspects", "entity_attributes", "entity_dependencies", "task_meta"],
			columns: [{ table: "entities", column: "agent_id" }],
		},
	},
	{
		version: 20,
		name: "session-structural-columns",
		up: sessionStructuralColumns,
		artifacts: {
			columns: [
				{ table: "session_memories", column: "entity_slot" },
				{ table: "session_memories", column: "aspect_slot" },
				{ table: "session_memories", column: "is_constraint" },
				{ table: "session_memories", column: "structural_density" },
			],
		},
	},
	{
		version: 21,
		name: "checkpoint-structural",
		up: checkpointStructural,
		artifacts: {
			columns: [{ table: "session_checkpoints", column: "focal_entity_ids" }],
		},
	},
	{
		version: 22,
		name: "entity-pinning",
		up: entityPinning,
		artifacts: {
			columns: [
				{ table: "entities", column: "pinned" },
				{ table: "entities", column: "pinned_at" },
			],
		},
	},
	{
		version: 23,
		name: "retired-scorer-gap",
		up: retiredScorerGap23,
	},
	{
		version: 24,
		name: "retired-scorer-gap",
		up: retiredScorerGap24,
	},
	{
		version: 25,
		name: "agent-feedback",
		up: agentFeedback,
		artifacts: {
			columns: [{ table: "session_memories", column: "agent_relevance_score" }],
		},
	},
	{
		version: 26,
		name: "retired-scorer-gap",
		up: retiredScorerGap26,
	},
	{
		version: 27,
		name: "backfill-canonical-names",
		up: backfillCanonicalNames,
	},
	{
		version: 28,
		name: "lossless-retention",
		up: losslessRetention,
	},
	{
		version: 29,
		name: "session-summary-dag",
		up: sessionSummaryDag,
	},
	{
		version: 30,
		name: "nullable-memory-job-memory-id",
		up: nullableMemoryJobMemoryId,
	},
	{
		version: 31,
		name: "dependency-reason",
		up: dependencyReason,
		artifacts: {
			columns: [
				{ table: "entity_dependencies", column: "reason" },
				{ table: "entities", column: "last_synthesized_at" },
			],
		},
	},
	{
		version: 32,
		name: "embeddings-vector-column",
		up: embeddingsVectorColumn,
		artifacts: {
			columns: [{ table: "embeddings", column: "vector", optional: true }],
		},
	},
	{
		version: 33,
		name: "scope",
		up: scope,
		artifacts: {
			columns: [{ table: "memories", column: "scope" }],
		},
	},
	{
		version: 34,
		name: "scope-aware-dedup",
		up: scopeAwareDedup,
	},
	{
		version: 35,
		name: "entity-fts",
		up: entityFts,
	},
	{
		version: 36,
		name: "dependency-confidence",
		up: dependencyConfidence,
		artifacts: {
			columns: [{ table: "entity_dependencies", column: "confidence" }],
		},
	},
	{
		version: 37,
		name: "entity-communities",
		up: entityCommunities,
		artifacts: {
			tables: ["entity_communities"],
			columns: [{ table: "entities", column: "community_id" }],
		},
	},
	{
		version: 38,
		name: "memory-hints",
		up: memoryHints,
		artifacts: { tables: ["memory_hints"] },
	},
	{
		version: 39,
		name: "dedup-entity-dependencies",
		up: dedupEntityDependencies,
	},
	{
		version: 40,
		name: "session-transcripts",
		up: sessionTranscripts,
		artifacts: { tables: ["session_transcripts"] },
	},
	{
		version: 41,
		name: "path-feedback",
		up: pathFeedback,
		artifacts: {
			tables: [
				"path_feedback_events",
				"path_feedback_stats",
				"entity_retrieval_stats",
				"entity_cooccurrence",
				"path_feedback_sessions",
			],
			columns: [{ table: "session_memories", column: "path_json" }],
		},
	},
	{
		version: 42,
		name: "session-memories-agent-id",
		up: sessionMemoriesAgentId,
		artifacts: {
			columns: [{ table: "session_memories", column: "agent_id" }],
		},
	},
	{
		version: 43,
		name: "agents-table",
		up: agentsTable,
		artifacts: {
			tables: ["agents"],
			columns: [
				{ table: "memories", column: "agent_id" },
				{ table: "memories", column: "visibility" },
			],
		},
	},
	{
		version: 44,
		name: "memory-md-temporal-head",
		up: memoryMdTemporalHead,
		artifacts: {
			columns: [
				{ table: "session_summaries", column: "source_type" },
				{ table: "session_summaries", column: "source_ref" },
				{ table: "session_summaries", column: "meta_json" },
			],
		},
	},
	{
		version: 45,
		name: "lossless-working-memory-hardening",
		up: losslessWorkingMemoryHardening,
		artifacts: {
			tables: ["session_transcripts_fts", "memory_md_heads"],
			columns: [
				{ table: "session_transcripts", column: "updated_at" },
				{ table: "summary_jobs", column: "agent_id" },
				{ table: "session_scores", column: "agent_id" },
			],
		},
	},
	{
		version: 46,
		name: "session-summary-uniqueness",
		up: sessionSummaryUniqueness,
	},
	{
		version: 47,
		name: "agent-scoped-temporal-uniqueness",
		up: agentScopedTemporalUniqueness,
	},
	{
		version: 48,
		name: "thread-heads",
		up: threadHeads,
		artifacts: {
			tables: ["memory_thread_heads"],
		},
	},
	{
		version: 49,
		name: "session-extract-cursors",
		up: sessionExtractCursors,
		artifacts: {
			tables: ["session_extract_cursors"],
		},
	},
	{
		version: 50,
		name: "related-to-audit",
		up: relatedToAudit,
		artifacts: {
			tables: ["entity_dependency_history"],
		},
	},
	{
		version: 51,
		name: "memory-md-rolling-window-lineage",
		up: memoryMdRollingWindowLineage,
		artifacts: {
			tables: ["memory_artifacts", "memory_artifact_tombstones", "memory_artifacts_fts"],
			columns: [
				{ table: "summary_jobs", column: "session_id" },
				{ table: "summary_jobs", column: "trigger" },
				{ table: "summary_jobs", column: "captured_at" },
				{ table: "summary_jobs", column: "started_at" },
				{ table: "summary_jobs", column: "ended_at" },
			],
		},
	},
	{
		version: 52,
		name: "mcp-invocations",
		up: mcpInvocations,
		artifacts: {
			tables: ["mcp_invocations"],
		},
	},
	{
		version: 53,
		name: "skill-invocations",
		up: skillInvocations,
		artifacts: {
			tables: ["skill_invocations"],
		},
	},
	{
		version: 54,
		name: "task-agent-scope",
		up: taskAgentScope,
		artifacts: {
			tables: ["task_scope_hints"],
		},
	},
	{
		version: 55,
		name: "dreaming-state",
		up: dreamingState,
		artifacts: {
			tables: ["dreaming_state", "dreaming_passes"],
		},
	},
	{
		version: 56,
		name: "agent-scoped-content-hash",
		up: agentScopedContentHash,
	},
	{
		version: 57,
		name: "memories-fts-tokenizer-repair",
		up: memoriesFtsTokenizerRepair,
	},
	{
		version: 58,
		name: "knowledge-graph-indices",
		up: knowledgeGraphIndices,
	},
	{
		version: 59,
		name: "entity-attribute-claim-key",
		up: entityAttributeClaimKey,
		artifacts: {
			columns: [{ table: "entity_attributes", column: "claim_key" }],
		},
	},
	{
		version: 60,
		name: "entity-attribute-group-key",
		up: entityAttributeGroupKey,
		artifacts: {
			columns: [{ table: "entity_attributes", column: "group_key" }],
		},
	},
	{
		version: 61,
		name: "memory-artifact-source-mtime",
		up: memoryArtifactSourceMtime,
		artifacts: {
			columns: [{ table: "memory_artifacts", column: "source_mtime_ms" }],
		},
	},
	{
		version: 62,
		name: "memory-artifact-soft-delete",
		up: memoryArtifactSoftDelete,
		artifacts: {
			columns: [
				{ table: "memory_artifacts", column: "is_deleted" },
				{ table: "memory_artifacts", column: "deleted_at" },
			],
		},
	},
	{
		version: 63,
		name: "content-only-memories-fts-update",
		up: contentOnlyMemoriesFtsUpdate,
	},
	{
		version: 64,
		name: "source-graph-provenance",
		up: sourceGraphProvenance,
		artifacts: {
			columns: [
				{ table: "entities", column: "source_path" },
				{ table: "entity_communities", column: "source_path" },
				{ table: "entity_attributes", column: "source_path" },
				{ table: "entity_dependencies", column: "source_path" },
			],
		},
	},
	{
		version: 65,
		name: "source-embedding-agent-scope",
		up: sourceEmbeddingAgentScope,
		artifacts: {
			columns: [{ table: "embeddings", column: "agent_id", optional: true }],
		},
	},
	{
		version: 66,
		name: "memory-search-telemetry",
		up: memorySearchTelemetry,
		artifacts: {
			tables: ["memory_search_telemetry"],
		},
	},
	{
		version: 67,
		name: "ontology-proposals",
		up: ontologyProposals,
		artifacts: {
			tables: ["ontology_proposals"],
			columns: [
				{ table: "entity_attributes", column: "proposal_id" },
				{ table: "entity_attributes", column: "proposal_evidence" },
				{ table: "entity_dependencies", column: "proposal_id" },
				{ table: "entity_dependencies", column: "proposal_evidence" },
			],
		},
	},
	{
		version: 68,
		name: "daily-reflections",
		up: dailyReflections,
		artifacts: {
			tables: ["daily_reflections"],
		},
	},
	{
		version: 69,
		name: "daily-reflections-multiple-insights",
		up: dailyReflectionsMultipleInsights,
		artifacts: {
			tables: ["daily_reflections"],
		},
	},
	{
		version: 70,
		name: "ontology-control-plane-state",
		up: ontologyControlPlaneState,
		artifacts: {
			columns: [
				{ table: "entities", column: "status" },
				{ table: "entity_aspects", column: "status" },
				{ table: "entity_attributes", column: "version" },
				{ table: "entity_attributes", column: "version_root_id" },
				{ table: "entity_attributes", column: "previous_attribute_id" },
				{ table: "entity_dependencies", column: "status" },
			],
		},
	},
	{
		version: 71,
		name: "epistemic-assertions",
		up: epistemicAssertions,
		artifacts: {
			tables: ["epistemic_assertions"],
		},
	},
	{
		version: 72,
		name: "agent-scoped-idempotency-key",
		up: agentScopedIdempotencyKey,
		artifacts: {
			columns: [
				{ table: "memories", column: "idempotency_key" },
				{ table: "memories", column: "runtime_path" },
			],
		},
	},
	{
		version: 73,
		name: "recall-context-dedupe",
		up: recallContextDedupe,
		artifacts: {
			tables: ["session_context_epochs", "session_recall_events"],
		},
	},
	{
		version: 74,
		name: "aggregate-memory-links",
		up: aggregateMemoryLinks,
		artifacts: {
			tables: ["aggregate_memory_sources"],
		},
	},
	{
		version: 75,
		name: "memory-artifact-source-provenance",
		up: memoryArtifactSourceProvenance,
		artifacts: {
			columns: [
				{ table: "memory_artifacts", column: "source_id" },
				{ table: "memory_artifacts", column: "source_root" },
				{ table: "memory_artifacts", column: "source_external_id" },
				{ table: "memory_artifacts", column: "source_parent_path" },
				{ table: "memory_artifacts", column: "source_meta_json" },
			],
		},
	},
	{
		version: 76,
		name: "temporal-edges",
		up: temporalEdges,
		artifacts: {
			tables: ["temporal_edges"],
		},
	},
	{
		version: 77,
		name: "entity-aliases",
		up: entityAliases,
		artifacts: {
			tables: ["entity_aliases"],
		},
	},
	{
		version: 78,
		name: "api-keys",
		up: apiKeys,
		artifacts: {
			tables: ["api_keys"],
		},
	},
	{
		version: 79,
		name: "transcript-capture-jobs",
		up: transcriptCaptureJobs,
		artifacts: {
			tables: ["transcript_capture_jobs"],
		},
	},
	{
		version: 80,
		name: "document-scope-columns",
		up: documentScopeColumns,
		artifacts: {
			columns: [
				{ table: "documents", column: "agent_id" },
				{ table: "documents", column: "project" },
			],
		},
	},
	{
		version: 81,
		name: "aggregate-evidence-sources",
		up: aggregateEvidenceSources,
		artifacts: {
			tables: ["aggregate_evidence_sources"],
		},
	},
	{
		version: 82,
		name: "skill-invocations-harness",
		up: skillInvocationsHarness,
		artifacts: {
			columns: [
				{ table: "skill_invocations", column: "harness" },
				{ table: "skill_invocations", column: "tool_use_id" },
			],
		},
	},
	{
		version: 83,
		name: "memory-lifecycle-repair",
		up: memoryLifecycleRepair,
		artifacts: {
			tables: ["transcript_capture_jobs", "aggregate_evidence_sources", "entity_dependencies"],
			columns: [
				{ table: "documents", column: "agent_id" },
				{ table: "documents", column: "project" },
				{ table: "memories", column: "superseded_by" },
				{ table: "memories", column: "superseded_at" },
				{ table: "memories", column: "superseded_reason" },
			],
		},
	},
	{
		version: 84,
		name: "legacy-markdown-import-state",
		up: legacyMarkdownImportState,
		artifacts: {
			tables: ["legacy_markdown_imports", "legacy_markdown_chunks"],
		},
	},
	{
		version: 85,
		name: "backfill-relations-to-dependencies",
		up: backfillRelationsToDependencies,
		artifacts: {
			tables: ["entity_dependencies"],
		},
	},
	{
		version: 86,
		name: "summary-jobs-content-hash",
		up: summaryJobsContentHash,
		artifacts: {
			columns: [{ table: "summary_jobs", column: "content_hash" }],
		},
	},
	{
		version: 87,
		name: "summary-jobs-boundary-reason",
		up: summaryJobsBoundaryReason,
		artifacts: {
			columns: [{ table: "summary_jobs", column: "boundary_reason" }],
		},
	},
	{
		version: 88,
		name: "transcript-recovery-files",
		up: transcriptRecoveryFiles,
		artifacts: {
			tables: ["transcript_recovery_files"],
		},
	},
	{
		version: 89,
		name: "job-cancellations",
		up: jobCancellations,
		artifacts: {
			tables: ["job_cancellations"],
		},
	},
	{
		version: 90,
		name: "job-archive",
		up: jobArchive,
		artifacts: {
			tables: ["job_archive"],
		},
	},
	{
		version: 91,
		name: "embedding-index-generations",
		up: embeddingIndexGenerations,
		artifacts: { tables: ["embedding_index_state"] },
	},
	{
		version: 92,
		name: "embedding-staging-store",
		up: embeddingStagingStore,
		artifacts: { tables: ["embeddings_staging"] },
	},
	{
		version: 93,
		name: "dreaming-evidence-cursor",
		up: dreamingEvidenceCursor,
		artifacts: { columns: [{ table: "dreaming_state", column: "evidence_cursor" }] },
	},
	{
		version: 94,
		name: "memory-kind",
		up: memoryKind,
		artifacts: {
			columns: [
				{ table: "memories", column: "memory_kind" },
				{ table: "memories", column: "evidence_meta" },
			],
		},
	},
	{
		version: 95,
		name: "compaction-recall-projections",
		up: compactionRecallProjections,
	},
	{
		version: 96,
		name: "retire-legacy-ingestion",
		up: retireLegacyIngestion,
	},
	{
		version: 97,
		name: "dreaming-failure-backoff",
		up: dreamingFailureBackoff,
		artifacts: { columns: [{ table: "dreaming_state", column: "last_failure_at" }] },
	},
	{
		version: 98,
		name: "dreaming-evidence-exclusions",
		up: dreamingEvidenceExclusions,
		artifacts: { tables: ["dreaming_evidence_exclusions"] },
	},
	{
		version: 99,
		name: "dreaming-tool-calls",
		up: dreamingToolCalls,
		artifacts: { tables: ["dreaming_tool_calls"] },
	},
	{
		version: 100,
		name: "dreaming-runbook",
		up: dreamingRunbook,
		artifacts: {
			columns: [
				{ table: "dreaming_passes", column: "evidence_window_json" },
				{ table: "dreaming_passes", column: "runbook_json" },
			],
		},
	},
	{
		version: 101,
		name: "dreaming-attention",
		up: dreamingAttention,
		artifacts: { tables: ["dreaming_attention"] },
	},
	{
		version: 102,
		name: "attribute-semantic-memories",
		up: attributeSemanticMemories,
	},
	{
		version: 103,
		name: "semantic-memory-kind",
		up: semanticMemoryKind,
	},
	{
		version: 104,
		name: "derived-memory-provenance",
		up: derivedMemoryProvenance,
		artifacts: {
			tables: ["derived_memory_sources"],
			columns: [{ table: "memories", column: "stale_at" }],
		},
	},
	{
		version: 105,
		name: "agent-scoped-entity-name",
		up: agentScopedEntityName,
	},
	{
		version: 106,
		name: "memory-review-after",
		up: memoryReviewAfter,
		artifacts: {
			columns: [{ table: "memories", column: "review_after" }],
		},
	},
	{
		version: 107,
		name: "dreaming-pass-usage",
		up: dreamingPassUsage,
		artifacts: {
			columns: [
				{ table: "dreaming_passes", column: "tokens_input" },
				{ table: "dreaming_passes", column: "tokens_output" },
				{ table: "dreaming_passes", column: "tokens_cache_read" },
				{ table: "dreaming_passes", column: "tokens_cache_write" },
				{ table: "dreaming_passes", column: "tokens_cost" },
			],
		},
	},
	{
		version: 108,
		name: "embedding-usage",
		up: embeddingUsage,
		artifacts: {
			tables: ["embedding_usage"],
		},
	},
	{
		version: 109,
		name: "telemetry-install",
		up: telemetryInstall,
		artifacts: {
			tables: ["telemetry_install"],
		},
	},
	{
		version: 110,
		name: "memory-mention-join-index",
		up: memoryMentionJoinIndex,
	},
	{
		version: 111,
		name: "telemetry-first-use",
		up: telemetryFirstUse,
		artifacts: {
			columns: [
				{ table: "telemetry_install", column: "first_remember_at" },
				{ table: "telemetry_install", column: "first_recall_at" },
			],
		},
	},
	{
		version: 112,
		name: "telemetry-queue-ownership",
		up: telemetryQueueOwnership,
		artifacts: {
			columns: [
				{ table: "telemetry_events", column: "source" },
				{ table: "telemetry_events", column: "claim_token" },
				{ table: "telemetry_events", column: "claimed_at" },
			],
		},
	},
	{
		version: 113,
		name: "session-claims",
		up: sessionClaims,
		artifacts: {
			tables: ["session_claims"],
			columns: [
				{ table: "session_claims", column: "agent_id" },
				{ table: "session_claims", column: "harness" },
				{ table: "session_claims", column: "expires_at" },
				{ table: "session_claims", column: "end_marker" },
			],
		},
	},
	{
		version: 114,
		name: "memory-traversal-hydration-index",
		up: memoryTraversalHydrationIndex,
	},
	{
		version: 115,
		name: "cross-agent-message-notifications",
		up: crossAgentMessageNotifications,
		artifacts: {
			tables: ["cross_agent_messages", "cross_agent_message_receipts"],
		},
	},
	{
		version: 116,
		name: "acp-delivery-reconciliation",
		up: acpDeliveryReconciliation,
		artifacts: {
			columns: [
				{ table: "cross_agent_messages", column: "delivery_state" },
				{ table: "cross_agent_messages", column: "delivery_attempt_id" },
				{ table: "cross_agent_messages", column: "delivery_lease_expires_at" },
				{ table: "cross_agent_messages", column: "acp_base_url" },
				{ table: "cross_agent_messages", column: "acp_target_agent_name" },
			],
		},
	},
	{
		version: 117,
		name: "retire-summary-worker",
		up: retireSummaryWorker,
		artifacts: {
			columns: [
				{ table: "session_transcripts", column: "completed_at" },
				{ table: "session_transcripts", column: "content_hash" },
			],
		},
	},
	{
		version: 118,
		name: "queue-pressure-indices",
		up: queuePressureIndices,
	},
	{
		version: 119,
		name: "telemetry-version-observation",
		up: telemetryVersionObservation,
		artifacts: { columns: [{ table: "telemetry_install", column: "last_seen_version" }] },
	},
	{
		version: 120,
		name: "source-lifecycle-telemetry",
		up: sourceLifecycleTelemetry,
		artifacts: { tables: ["source_lifecycle_state"] },
	},
	{
		version: 121,
		name: "telemetry-delivery-health",
		up: telemetryDeliveryHealth,
		artifacts: {
			tables: ["telemetry_delivery_state"],
			columns: [
				{ table: "telemetry_events", column: "delivery_attempts" },
				{ table: "telemetry_events", column: "last_attempt_at" },
				{ table: "telemetry_events", column: "sent_at" },
				{ table: "telemetry_events", column: "last_failure_code" },
			],
		},
	},
	{
		version: 122,
		name: "dreaming-evidence-retry",
		up: dreamingEvidenceRetry,
		artifacts: {
			columns: [
				{ table: "dreaming_evidence_exclusions", column: "failure_class" },
				{ table: "dreaming_evidence_exclusions", column: "source_fingerprint" },
				{ table: "dreaming_evidence_exclusions", column: "retry_count" },
				{ table: "dreaming_evidence_exclusions", column: "last_requeued_at" },
			],
		},
	},
	{
		version: 123,
		name: "embedding-index-failures",
		up: embeddingIndexFailures,
		artifacts: { tables: ["embedding_index_failures"] },
	},
	{
		version: 124,
		name: "import-derived-lifecycle",
		up: importedDerivedLifecycle,
		artifacts: {
			tables: ["imported_source_lifecycle"],
		},
	},
	{
		version: 125,
		name: "memory-content-safety",
		up: memoryContentSafety,
		artifacts: { tables: ["memory_content_safety"] },
	},
	{
		version: 126,
		name: "dreaming-surprisal-attention",
		up: dreamingSurprisalAttention,
		artifacts: { tables: ["dreaming_attention"] },
	},
	{
		version: 127,
		name: "ontology-contradictions",
		up: ontologyContradictions,
		artifacts: { tables: ["ontology_contradictions"] },
	},
];

/** Simple checksum for audit trail (hash of migration name + version). */
function checksum(m: Migration): string {
	let h = 0;
	const s = `${m.version}:${m.name}`;
	for (let i = 0; i < s.length; i++) {
		h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	}
	return h.toString(16);
}

/**
 * Ensure schema_migrations and schema_migrations_audit tables exist.
 * Called before reading current version so the queries don't fail
 * on a brand-new database.
 */
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

/** Read the highest applied version, or 0 if none. */
function currentVersion(db: MigrationDb): number {
	const row = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get();
	if (row === undefined) return 0;
	const v = row.version;
	return typeof v === "number" ? v : 0;
}

/**
 * Read-only detector for the v0.1.65 CLI bug: version >= 2 stamped but
 * memories table lacks the `content_hash` column added by migration 002.
 */
function hasBogusVersion(db: MigrationDb): boolean {
	const current = currentVersion(db);
	if (current < 2) return false;
	const cols = db.prepare("PRAGMA table_info(memories)").all();
	return !cols.filter(hasStringName).some((r) => r.name === "content_hash");
}

/**
 * Repair the v0.1.65 CLI bug by deleting the bogus version records so all
 * migrations re-run. Safe because every migration uses CREATE IF NOT EXISTS
 * / addColumnIfMissing. Called only inside runMigrations.
 */
function repairBogusVersion(db: MigrationDb): void {
	if (!hasBogusVersion(db)) return;
	db.exec("DELETE FROM schema_migrations WHERE version > 0");
}

/** Type guard: narrows a query row to one with a string `name` field. */
function hasStringName(row: Record<string, unknown>): row is { name: string } {
	return typeof row.name === "string";
}

/** Type guard: narrows a query row to one with a numeric `version` field. */
function hasNumericVersion(row: Record<string, unknown>): row is { version: number } {
	return typeof row.version === "number";
}

/** Get the set of table names in the database (single query). */
function existingTables(db: MigrationDb): Set<string> {
	const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
	return new Set(rows.filter(hasStringName).map((r) => r.name));
}

/** Get column names for a table, with per-call caching. */
function tableColumns(db: MigrationDb, table: string, cache: Map<string, Set<string>>): Set<string> {
	let cols = cache.get(table);
	if (cols) return cols;
	const rows = db.prepare(`PRAGMA table_info("${table}")`).all();
	cols = new Set(rows.filter(hasStringName).map((r) => r.name));
	cache.set(table, cols);
	return cols;
}

/**
 * Detect phantom migrations — versions recorded in schema_migrations whose
 * expected artifacts (tables/columns) no longer exist. Read-only; does not
 * modify the database.
 *
 * Used by both hasPendingMigrations (detection only) and
 * repairPhantomMigrations (detection + deletion).
 */
function findPhantomVersions(
	db: MigrationDb,
	// Accepts a pre-fetched applied set to avoid a redundant query when
	// the caller already has one (e.g. hasPendingMigrations).
	precomputedApplied?: Set<number>,
): Set<number> {
	const tables = existingTables(db);
	const colCache = new Map<string, Set<string>>();
	const phantoms = new Set<number>();
	const applied = precomputedApplied ?? appliedVersions(db);

	for (const migration of MIGRATIONS) {
		if (!migration.artifacts) continue;

		// Skip v1 — legacy CLI partial schemas handled by repairBogusVersion
		if (migration.version === 1) continue;

		// Not recorded as applied — not a phantom
		if (!applied.has(migration.version)) continue;

		let missing = false;

		if (migration.artifacts.tables) {
			for (const t of migration.artifacts.tables) {
				if (!tables.has(t)) {
					missing = true;
					break;
				}
			}
		}

		if (!missing && migration.artifacts.columns) {
			for (const col of migration.artifacts.columns) {
				if (!tables.has(col.table)) {
					if (col.optional) continue;
					missing = true;
					break;
				}
				const cols = tableColumns(db, col.table, colCache);
				if (!cols.has(col.column)) {
					if (col.optional) continue;
					missing = true;
					break;
				}
			}
		}

		if (missing) phantoms.add(migration.version);
	}

	return phantoms;
}

/**
 * Detect phantom migrations and delete their schema_migrations records so
 * they re-run on the next pass. Logs each repair to stderr.
 *
 * Returns the post-repair applied set so the caller (runMigrations) can
 * use it directly without issuing a redundant appliedVersions() query.
 *
 * schema_migrations_audit rows are intentionally preserved — they are a
 * durable history record that helps diagnose why the phantom occurred.
 * A fresh audit row will be inserted when the migration re-runs.
 */
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
		// Only remove from schema_migrations (re-run tracker); audit stays intact
		db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
		applied.delete(version);
	}

	return applied;
}

/** Get the set of applied migration versions. */
function appliedVersions(db: MigrationDb): Set<number> {
	const rows = db.prepare("SELECT version FROM schema_migrations").all();
	return new Set(rows.filter(hasNumericVersion).map((r) => r.version));
}

/**
 * Verify that a migration's declared artifacts exist after running.
 * Throws if any artifact is missing (SAVEPOINT catches it).
 */
function verifyArtifacts(db: MigrationDb, migration: Migration): void {
	if (!migration.artifacts) return;

	const tables = existingTables(db);

	if (migration.artifacts.tables) {
		for (const t of migration.artifacts.tables) {
			if (!tables.has(t)) {
				throw new Error(
					`Post-DDL verification failed: migration ${migration.version} (${migration.name}) ` +
						`declares table "${t}" but it was not created`,
				);
			}
		}
	}

	if (migration.artifacts.columns) {
		const colCache = new Map<string, Set<string>>();
		for (const col of migration.artifacts.columns) {
			if (!tables.has(col.table)) {
				// Optional columns skip verification when the table doesn't exist
				// (conditional/repair migrations that are no-ops on fresh schemas).
				if (col.optional) continue;
				throw new Error(
					`Post-DDL verification failed: migration ${migration.version} (${migration.name}) ` +
						`declares column "${col.table}.${col.column}" but table does not exist`,
				);
			}
			const colNames = tableColumns(db, col.table, colCache);
			if (!colNames.has(col.column)) {
				throw new Error(
					`Post-DDL verification failed: migration ${migration.version} (${migration.name}) ` +
						`declares column "${col.table}.${col.column}" but it was not created`,
				);
			}
		}
	}
}

/**
 * Check whether there are unapplied migrations without running them.
 * Useful for backup-before-migrate logic in the daemon.
 *
 * Fully read-only: uses hasBogusVersion and findPhantomVersions for
 * detection only — no deletes. All repairs run exclusively inside
 * runMigrations so the daemon's backup version label stays accurate.
 */
export function hasPendingMigrations(db: MigrationDb): boolean {
	ensureMetaTables(db);
	// Single query for applied versions; reused by all three checks below.
	const applied = appliedVersions(db);
	// Derive the bogus-version signal from the already-fetched set rather than
	// calling hasBogusVersion(db) which issues a separate SELECT MAX(version).
	// v0.1.65 bug: version >= 2 stamped but content_hash column is absent.
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

/** The highest migration version defined. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Assert that MIGRATIONS versions are strictly contiguous (each version
 * equals the previous + 1). Called at the top of runMigrations rather
 * than at module scope to comply with the effect-free module scope rule.
 * Catches registration mistakes (wrong order, gaps, copy-paste version
 * numbers) before any migration runs.
 */
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

/**
 * Run all pending migrations against `db`.
 *
 * Idempotent — safe to call on every startup. Migrations that have
 * already been applied (tracked in `schema_migrations`) are skipped.
 * Set-based skip logic handles gaps from phantom repair correctly.
 * Each migration runs inside a SAVEPOINT so a failure rolls back
 * only that migration.
 */
export function runMigrations(db: MigrationDb): void {
	// Guard against mis-registered migrations (wrong order, gaps, duplicates)
	assertMigrationsSequence();

	ensureMetaTables(db);

	// Repair v0.1.65 CLI bug (stamps version without running migrations)
	repairBogusVersion(db);

	// Repair phantom migrations (recorded but artifacts missing).
	// Returns the post-repair applied set to avoid a redundant query.
	const applied = repairPhantomMigrations(db);

	for (const migration of MIGRATIONS) {
		if (applied.has(migration.version)) continue;

		const start = Date.now();
		const cs = checksum(migration);

		// Use SAVEPOINT for nested-transaction safety
		db.exec(`SAVEPOINT migration_${migration.version}`);
		try {
			migration.up(db);

			// Post-DDL verification: confirm declared artifacts were created
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
