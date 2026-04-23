/**
 * Pipeline barrel — startPipeline/stopPipeline orchestration.
 */

import type { AnalyticsCollector } from "../analytics";
import type { DbAccessor } from "../db-accessor";
import type { ProviderTracker } from "../diagnostics";
import { getLlmProvider } from "../llm";
import { logger } from "../logger";
import type { EmbeddingConfig, MemorySearchConfig, PipelineV2Config } from "../memory-config";
import type { TelemetryCollector } from "../telemetry";
import type { DecisionConfig } from "./decision";
import { type DependencySynthesisHandle, startDependencySynthesisWorker } from "./dependency-synthesis";
import { type DocumentWorkerHandle, startDocumentWorker } from "./document-worker";
import type { DreamingWorkerHandle } from "./dreaming-worker";
import { type MaintenanceHandle, startMaintenanceWorker } from "./maintenance-worker";
import { type HintsWorkerHandle, startHintsWorker } from "./prospective-index";
import {
	DEFAULT_RETENTION,
	type RetentionConfig,
	type RetentionHandle,
	startRetentionWorker,
} from "./retention-worker";
import { type StructuralClassifyHandle, startStructuralClassifyWorker } from "./structural-classify";
import { type StructuralDependencyHandle, startStructuralDependencyWorker } from "./structural-dependency";
import { type SummaryWorkerHandle, startSummaryWorker } from "./summary-worker";
import { type SynthesisWorkerHandle, startSynthesisWorker } from "./synthesis-worker";
import { type WorkerHandle, type WorkerProgressStats, type WorkerStats, startWorker } from "./worker";

export { enqueueExtractionJob } from "./worker";
export type { WorkerStats } from "./worker";
export { enqueueDocumentIngestJob } from "./document-worker";
export {
	startRetentionWorker,
	DEFAULT_RETENTION,
} from "./retention-worker";
export type { WorkerHandle } from "./worker";
export type { DocumentWorkerHandle } from "./document-worker";
export type { LlmProvider } from "./provider";
export { getLlmProvider } from "../llm";
export type { RetentionHandle, RetentionConfig } from "./retention-worker";
export type { MaintenanceHandle } from "./maintenance-worker";
export { startSummaryWorker, enqueueSummaryJob } from "./summary-worker";
export type { SummaryWorkerHandle } from "./summary-worker";
export { startSynthesisWorker, readLastSynthesisTime } from "./synthesis-worker";
export type { SynthesisWorkerHandle } from "./synthesis-worker";
export { addDreamingTokens, getDreamingState, getDreamingPasses, recordDreamingFailure } from "./dreaming";
export type { DreamingWorkerHandle } from "./dreaming-worker";

/** Get the active synthesis worker handle (for API routes). */
export function getSynthesisWorker(): SynthesisWorkerHandle | null {
	return synthesisWorkerHandle;
}

/** Get the active dreaming worker handle (for API routes). */
export function getDreamingWorker(): DreamingWorkerHandle | null {
	return dreamingWorkerHandle;
}

/** Set dreaming worker handle (managed by daemon.ts, not startPipeline). */
export function setDreamingWorker(handle: DreamingWorkerHandle | null): void {
	dreamingWorkerHandle = handle;
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let workerHandle: WorkerHandle | null = null;
let retentionHandle: RetentionHandle | null = null;
let maintenanceHandle: MaintenanceHandle | null = null;
let documentWorkerHandle: DocumentWorkerHandle | null = null;
let summaryWorkerHandle: SummaryWorkerHandle | null = null;
let synthesisWorkerHandle: SynthesisWorkerHandle | null = null;
let structuralClassifyHandle: StructuralClassifyHandle | null = null;
let structuralDependencyHandle: StructuralDependencyHandle | null = null;
let dependencySynthesisHandle: DependencySynthesisHandle | null = null;
let hintsWorkerHandle: HintsWorkerHandle | null = null;
let dreamingWorkerHandle: DreamingWorkerHandle | null = null;

/** Snapshot of running state for each worker — used by /api/pipeline/status */
export function getPipelineWorkerStatus(): Record<string, { running: boolean; stats?: WorkerStats }> {
	return {
		extraction: {
			running: workerHandle !== null,
			stats: workerHandle?.stats,
		},
		summary: { running: summaryWorkerHandle !== null },
		document: { running: documentWorkerHandle !== null },
		retention: { running: retentionHandle !== null },
		maintenance: { running: maintenanceHandle !== null },
		synthesis: { running: synthesisWorkerHandle !== null },
		structuralClassify: { running: structuralClassifyHandle !== null },
		structuralDependency: { running: structuralDependencyHandle !== null },
		dependencySynthesis: { running: dependencySynthesisHandle !== null },
		hints: { running: hintsWorkerHandle !== null },
		dreaming: { running: dreamingWorkerHandle !== null },
	};
}

/** Force the extraction worker to repoll immediately. */
export function nudgeExtractionWorker(): boolean {
	if (!workerHandle) return false;
	workerHandle.nudge();
	return true;
}

export function ensureRetentionWorker(accessor: DbAccessor, cfg: RetentionConfig = DEFAULT_RETENTION): void {
	if (retentionHandle) return;
	retentionHandle = startRetentionWorker(accessor, cfg);
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

export function startPipeline(
	accessor: DbAccessor,
	pipelineCfg: PipelineV2Config,
	embeddingCfg: EmbeddingConfig,
	fetchEmbedding: (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>,
	searchCfg: MemorySearchConfig,
	agentId: string,
	providerTracker?: ProviderTracker,
	analytics?: AnalyticsCollector,
	telemetry?: TelemetryCollector,
): void {
	if (workerHandle) {
		logger.warn("pipeline", "Pipeline already running, skipping start");
		return;
	}
	if (!pipelineCfg.enabled) {
		logger.info("pipeline", "Pipeline disabled; worker start skipped");
		return;
	}
	if (pipelineCfg.paused) {
		logger.info("pipeline", "Pipeline paused; worker start skipped");
		return;
	}

	if (pipelineCfg.extraction.provider === "command") {
		ensureRetentionWorker(accessor, DEFAULT_RETENTION);
		if (!documentWorkerHandle) {
			documentWorkerHandle = startDocumentWorker({
				accessor,
				embeddingCfg,
				fetchEmbedding,
				pipelineCfg,
			});
		}
		if (!summaryWorkerHandle) {
			summaryWorkerHandle = startSummaryWorker(accessor);
		}
		if (!synthesisWorkerHandle && pipelineCfg.synthesis.enabled && pipelineCfg.synthesis.provider !== "none") {
			synthesisWorkerHandle = startSynthesisWorker(pipelineCfg.synthesis);
		}
		logger.info("pipeline", "Pipeline started in command extraction compatibility mode", {
			mode: "command-extraction",
		});
		return;
	}

	const provider = getLlmProvider();

	const decisionCfg: DecisionConfig = {
		embedding: embeddingCfg,
		search: searchCfg,
		timeoutMs: pipelineCfg.extraction.timeout,
		fetchEmbedding,
	};

	workerHandle = startWorker(accessor, provider, pipelineCfg, decisionCfg, analytics, telemetry);

	// Retention worker also managed here when pipeline is active;
	// standalone retention is started separately in main() for non-pipeline users.
	ensureRetentionWorker(accessor, DEFAULT_RETENTION);

	// Maintenance worker (F3) — runs alongside retention
	if (!maintenanceHandle && providerTracker) {
		maintenanceHandle = startMaintenanceWorker(accessor, pipelineCfg, providerTracker, retentionHandle);
	}

	// Document ingest worker runs alongside the extraction pipeline
	if (!documentWorkerHandle) {
		documentWorkerHandle = startDocumentWorker({
			accessor,
			embeddingCfg,
			fetchEmbedding,
			pipelineCfg,
		});
	}

	// Summary worker — async session-end processing
	if (!summaryWorkerHandle) {
		summaryWorkerHandle = startSummaryWorker(accessor);
	}

	// Synthesis worker — session-activity-based MEMORY.md regeneration
	if (!synthesisWorkerHandle && pipelineCfg.synthesis.enabled && pipelineCfg.synthesis.provider !== "none") {
		synthesisWorkerHandle = startSynthesisWorker(pipelineCfg.synthesis);
	}

	// Structural assignment workers (KA-2) — classify aspects and extract
	// dependencies from entity-linked facts. Gate on both structural.enabled
	// and graph.enabled since they depend on the entity graph.
	if (pipelineCfg.structural.enabled && pipelineCfg.graph.enabled && !pipelineCfg.mutationsFrozen) {
		if (!structuralClassifyHandle) {
			structuralClassifyHandle = startStructuralClassifyWorker({
				accessor,
				provider,
				pipelineCfg,
			});
		}
		if (!structuralDependencyHandle) {
			structuralDependencyHandle = startStructuralDependencyWorker({
				accessor,
				provider,
				pipelineCfg,
			});
		}
		if (!dependencySynthesisHandle && pipelineCfg.structural.synthesisEnabled) {
			dependencySynthesisHandle = startDependencySynthesisWorker({
				accessor,
				agentId,
				provider,
				pipelineCfg,
				getExtractionStats: () => {
					const stats: WorkerStats | undefined = workerHandle?.stats;
					if (!stats) return undefined;
					const { lastProgressAt, pending } = stats;
					return {
						lastProgressAt,
						pending,
					} satisfies WorkerProgressStats;
				},
				// NOTE: The extraction worker is a singleton — its stats are
				// global, not per-agent. The stall gate measures overall
				// extraction health rather than agent-specific progress.
			});
		}
	}

	// Prospective indexing worker — generates hypothetical future queries
	// for memories to improve search recall.
	if (!hintsWorkerHandle && pipelineCfg.hints?.enabled && !pipelineCfg.mutationsFrozen) {
		hintsWorkerHandle = startHintsWorker({ accessor, provider, pipelineCfg });
	}

	logger.info("pipeline", "Pipeline started", {
		mode:
			pipelineCfg.enabled && !pipelineCfg.shadowMode && !pipelineCfg.mutationsFrozen && !pipelineCfg.nativeShadowEnabled
				? "controlled-write"
				: "shadow",
	});
}

export async function stopPipeline(): Promise<void> {
	if (hintsWorkerHandle) {
		await hintsWorkerHandle.stop();
		hintsWorkerHandle = null;
	}
	if (synthesisWorkerHandle) {
		synthesisWorkerHandle.stop();
		const drainResult = await synthesisWorkerHandle.drain();
		if (drainResult === "timeout") {
			logger.warn("pipeline", "Synthesis worker drain timed out during shutdown");
		}
		synthesisWorkerHandle = null;
	}
	if (dependencySynthesisHandle) {
		await dependencySynthesisHandle.stop();
		dependencySynthesisHandle = null;
	}
	if (structuralDependencyHandle) {
		await structuralDependencyHandle.stop();
		structuralDependencyHandle = null;
	}
	if (structuralClassifyHandle) {
		await structuralClassifyHandle.stop();
		structuralClassifyHandle = null;
	}
	if (summaryWorkerHandle) {
		summaryWorkerHandle.stop();
		summaryWorkerHandle = null;
	}
	if (documentWorkerHandle) {
		await documentWorkerHandle.stop();
		documentWorkerHandle = null;
	}
	if (maintenanceHandle) {
		maintenanceHandle.stop();
		maintenanceHandle = null;
	}
	if (retentionHandle) {
		retentionHandle.stop();
		retentionHandle = null;
	}
	if (!workerHandle) return;
	await workerHandle.stop();
	workerHandle = null;
	logger.info("pipeline", "Pipeline stopped");
}
