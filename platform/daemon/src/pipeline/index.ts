/**
 * Pipeline barrel — startPipeline/stopPipeline orchestration.
 *
 * The legacy extraction/decision/escalation worker runtime, the per-fact
 * structural classify/dependency workers, and the cross-entity
 * dependency-synthesis worker were all retired under the Dreaming cutover
 * (#946). Dreaming owns semantic writes; this barrel starts only the
 * non-semantic workers (document ingest, retention, maintenance,
 * synthesis, prospective/hints) and exposes their handles.
 */

import type { AnalyticsCollector } from "../analytics";
import type { DbAccessor } from "../db-accessor";
import type { ProviderTracker } from "../diagnostics";
import type { EmbeddingRole } from "../embedding-profile";
import { getLlmProvider } from "../llm";
import { logger } from "../logger";
import type { EmbeddingConfig, MemorySearchConfig, PipelineV2Config } from "../memory-config";
import type { TelemetryCollector } from "../telemetry";
import { type DocumentWorkerHandle, startDocumentWorker } from "./document-worker";
import type { DreamingWorkerHandle } from "./dreaming-worker";
import { type MaintenanceHandle, startMaintenanceWorker } from "./maintenance-worker";
import { type HintsWorkerHandle, startHintsWorker } from "./prospective-index";
import { configureLlmConcurrency, getLlmConcurrencyStatus } from "./provider";
import {
	DEFAULT_RETENTION,
	type RetentionConfig,
	type RetentionHandle,
	startRetentionWorker,
} from "./retention-worker";
import { type SynthesisWorkerHandle, startSynthesisWorker } from "./synthesis-worker";

export { enqueueDocumentIngestJob } from "./document-worker";
export {
	startRetentionWorker,
	DEFAULT_RETENTION,
} from "./retention-worker";
export type { DocumentWorkerHandle } from "./document-worker";
export type { LlmProvider } from "./provider";
export { getLlmProvider } from "../llm";
export type { RetentionHandle, RetentionConfig } from "./retention-worker";
export type { MaintenanceHandle } from "./maintenance-worker";
export { startSynthesisWorker, readLastSynthesisTime } from "./synthesis-worker";
export type { SynthesisWorkerHandle } from "./synthesis-worker";
export {
	getDreamingEpisodicTokenBacklog,
	getDreamingEvidenceExclusions,
	getDreamingToolCalls,
	getDreamingState,
	getDreamingPasses,
	recordDreamingFailure,
	requestDreamingEvidenceRequeue,
} from "./dreaming";
export { getDreamingAttention } from "./dreaming-attention";
export { getDreamingQualityReport } from "./dreaming-quality";
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

let retentionHandle: RetentionHandle | null = null;
let maintenanceHandle: MaintenanceHandle | null = null;
let documentWorkerHandle: DocumentWorkerHandle | null = null;

let synthesisWorkerHandle: SynthesisWorkerHandle | null = null;
let hintsWorkerHandle: HintsWorkerHandle | null = null;
let dreamingWorkerHandle: DreamingWorkerHandle | null = null;

type WorkerStatusEntry = {
	readonly running: boolean;
};

type LlmConcurrencyStatus = ReturnType<typeof getLlmConcurrencyStatus>;

export type PipelineWorkerStatus = {
	readonly llmConcurrency: {
		readonly running: boolean;
		readonly concurrency: LlmConcurrencyStatus;
		/** Backward-compatible alias for callers that read provider status from stats. */
		readonly stats: LlmConcurrencyStatus;
	};
	readonly summary: WorkerStatusEntry;
	readonly document: WorkerStatusEntry;
	readonly retention: WorkerStatusEntry;
	readonly maintenance: WorkerStatusEntry;
	readonly synthesis: WorkerStatusEntry;
	readonly hints: WorkerStatusEntry;
	readonly dreaming: WorkerStatusEntry;
};

/** Snapshot of running state for each worker — used by /api/pipeline/status */
export function getPipelineWorkerStatus(): PipelineWorkerStatus {
	const llmConcurrency = getLlmConcurrencyStatus();
	return {
		llmConcurrency: {
			running: llmConcurrency.running > 0,
			concurrency: llmConcurrency,
			stats: llmConcurrency,
		},
		summary: { running: false },
		document: { running: documentWorkerHandle !== null },
		retention: { running: retentionHandle !== null },
		maintenance: { running: maintenanceHandle !== null },
		synthesis: { running: synthesisWorkerHandle !== null },
		hints: { running: hintsWorkerHandle !== null },
		dreaming: { running: dreamingWorkerHandle !== null },
	};
}

export function ensureRetentionWorker(accessor: DbAccessor, cfg: RetentionConfig = DEFAULT_RETENTION): void {
	if (retentionHandle) return;
	retentionHandle = startRetentionWorker(accessor, cfg);
}

export function getRetentionWorker(): RetentionHandle | null {
	return retentionHandle;
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

export function startPipeline(
	accessor: DbAccessor,
	pipelineCfg: PipelineV2Config,
	embeddingCfg: EmbeddingConfig,
	fetchEmbedding: (text: string, cfg: EmbeddingConfig, role?: EmbeddingRole) => Promise<number[] | null>,
	_searchCfg: MemorySearchConfig,
	agentId: string,
	providerTracker?: ProviderTracker,
	_analytics?: AnalyticsCollector,
	_telemetry?: TelemetryCollector,
): void {
	if (retentionHandle || documentWorkerHandle || synthesisWorkerHandle) {
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
	configureLlmConcurrency(pipelineCfg.worker.maxLlmConcurrency);

	const provider = getLlmProvider();

	// Retention worker also managed here when pipeline is active;
	// standalone retention is started separately in main() for non-pipeline users.
	ensureRetentionWorker(accessor, DEFAULT_RETENTION);

	// Maintenance worker (F3) — runs alongside retention
	if (!maintenanceHandle && providerTracker) {
		maintenanceHandle = startMaintenanceWorker(accessor, pipelineCfg, providerTracker, retentionHandle);
	}

	// Document ingest worker runs alongside the pipeline
	if (!documentWorkerHandle) {
		documentWorkerHandle = startDocumentWorker({
			accessor,
			embeddingCfg,
			fetchEmbedding,
			pipelineCfg,
		});
	}

	// Synthesis worker — session-activity-based MEMORY.md regeneration
	if (!synthesisWorkerHandle && pipelineCfg.synthesis.enabled) {
		synthesisWorkerHandle = startSynthesisWorker(pipelineCfg.synthesis);
	}

	// Prospective indexing worker — generates hypothetical future queries
	// for memories to improve search recall.
	if (!hintsWorkerHandle && pipelineCfg.hints?.enabled && !pipelineCfg.mutationsFrozen) {
		hintsWorkerHandle = startHintsWorker({ accessor, provider, pipelineCfg });
	}

	// Daily Brief generation is dashboard-open driven. Do not start a
	// background schedule here; /api/reflections/generate creates fresh,
	// de-duplicated insights when the dashboard opens.

	logger.info("pipeline", "Pipeline started", {
		mode:
			pipelineCfg.enabled && !pipelineCfg.shadowMode && !pipelineCfg.mutationsFrozen ? "controlled-write" : "shadow",
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
	logger.info("pipeline", "Pipeline stopped");
}
