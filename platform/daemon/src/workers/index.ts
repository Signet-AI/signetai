import type { AnalyticsCollector } from "../telemetry/usage/analytics";
import type { DbAccessor } from "../db/owner/accessor";
import type { DbOwnerMaintenance } from "../db/maintenance/maintenance";
import type { ProviderTracker } from "../telemetry/diagnostics/diagnostics";
import type { EmbeddingRole } from "../embeddings/index/profile";
import { getLlmProvider } from "../inference/router/llm";
import { logger } from "../runtime/logging/logger";
import type { EmbeddingConfig, MemorySearchConfig, PipelineV2Config } from "../config/memory-config";
import type { TelemetryCollector } from "../telemetry/usage/telemetry";
import { DOCUMENT_WORK_MAX_IN_FLIGHT, type DocumentWorkerHandle, startDocumentWorker } from "./document";
import type { DreamingWorkerHandle } from "../dreaming/passes/worker";
import { type MaintenanceHandle, startMaintenanceWorker } from "./maintenance";
import { type HintsWorkerHandle, startHintsWorker } from "./prospective-index";
import { configureLlmConcurrency, getLlmConcurrencyStatus } from "../inference/router/provider";
import { DEFAULT_RETENTION, type RetentionConfig, type RetentionHandle, startRetentionWorker } from "./retention";
import { type SynthesisWorkerHandle, startSynthesisWorker } from "./synthesis/worker";

export { enqueueDocumentIngestJob } from "./document";
export {
	startRetentionWorker,
	DEFAULT_RETENTION,
} from "./retention";
export type { DocumentWorkerHandle } from "./document";
export type { LlmProvider } from "../inference/router/provider";
export { getLlmProvider } from "../inference/router/llm";
export type { RetentionHandle, RetentionConfig } from "./retention";
export type { MaintenanceHandle } from "./maintenance";
export { startSynthesisWorker, readLastSynthesisTime } from "./synthesis/worker";
export type { SynthesisWorkerHandle } from "./synthesis/worker";
export {
	getDreamingEpisodicTokenBacklog,
	getDreamingEvidenceExclusions,
	getDreamingToolCalls,
	getDreamingState,
	getDreamingPasses,
	getDreamingPass,
	getDreamingPassPolicy,
	getActiveDreamingPasses,
	recordDreamingFailure,
	requestDreamingEvidenceRequeue,
} from "../dreaming/passes/dreaming";
export { getDreamingReviewedEvidence, requestDreamingReviewedEvidenceRequeue } from "../dreaming/evidence/reviews";
export { getDreamingAttention } from "../dreaming/passes/attention";
export { getDreamingWorkloadDiagnostics } from "../dreaming/passes/dreaming";
export { getDreamingQualityReport } from "../ontology/graph/quality";
export type { DreamingSchedulerStatus, DreamingWorkerHandle } from "../dreaming/passes/worker";
export {
	dreamingLiveEvents,
	DreamingLiveEventHub,
	DREAMING_LIVE_HEARTBEAT_MS,
	type DreamingLiveEvent,
	type DreamingLivePassSnapshot,
	type DreamingLiveGap,
} from "../dreaming/passes/live-events";
export function getSynthesisWorker(): SynthesisWorkerHandle | null {
	return synthesisWorkerHandle;
}
export function getDreamingWorker(): DreamingWorkerHandle | null {
	return dreamingWorkerHandle;
}
export function setDreamingWorker(handle: DreamingWorkerHandle | null): void {
	dreamingWorkerHandle = handle;
}

let retentionHandle: RetentionHandle | null = null;
let maintenanceHandle: MaintenanceHandle | null = null;
let documentWorkerHandle: DocumentWorkerHandle | null = null;

let synthesisWorkerHandle: SynthesisWorkerHandle | null = null;
let hintsWorkerHandle: HintsWorkerHandle | null = null;
let dreamingWorkerHandle: DreamingWorkerHandle | null = null;

type WorkerStatusEntry = {
	readonly running: boolean;
};

type DocumentWorkerStatusEntry = WorkerStatusEntry & {
	readonly inFlight: number;
	readonly maxInFlight: number;
};

type LlmConcurrencyStatus = ReturnType<typeof getLlmConcurrencyStatus>;

export type PipelineWorkerStatus = {
	readonly llmConcurrency: {
		readonly running: boolean;
		readonly concurrency: LlmConcurrencyStatus;
		readonly stats: LlmConcurrencyStatus;
	};
	readonly summary: WorkerStatusEntry;
	readonly document: DocumentWorkerStatusEntry;
	readonly retention: WorkerStatusEntry;
	readonly maintenance: WorkerStatusEntry;
	readonly synthesis: WorkerStatusEntry;
	readonly hints: WorkerStatusEntry;
	readonly dreaming: WorkerStatusEntry;
};
export function getPipelineWorkerStatus(): PipelineWorkerStatus {
	const llmConcurrency = getLlmConcurrencyStatus();
	return {
		llmConcurrency: {
			running: llmConcurrency.running > 0,
			concurrency: llmConcurrency,
			stats: llmConcurrency,
		},
		summary: { running: false },
		document: {
			running: documentWorkerHandle !== null,
			inFlight: documentWorkerHandle?.inFlight ?? 0,
			maxInFlight: documentWorkerHandle?.maxInFlight ?? DOCUMENT_WORK_MAX_IN_FLIGHT,
		},
		retention: { running: retentionHandle !== null },
		maintenance: { running: maintenanceHandle !== null },
		synthesis: { running: synthesisWorkerHandle !== null },
		hints: { running: hintsWorkerHandle !== null },
		dreaming: { running: dreamingWorkerHandle !== null },
	};
}

export function ensureRetentionWorker(
	accessor: DbAccessor,
	cfg: RetentionConfig = DEFAULT_RETENTION,
	ownerMaintenance?: DbOwnerMaintenance,
): void {
	if (retentionHandle) return;
	retentionHandle = startRetentionWorker(accessor, cfg, ownerMaintenance);
}

export function getRetentionWorker(): RetentionHandle | null {
	return retentionHandle;
}

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
	ownerMaintenance?: DbOwnerMaintenance,
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
	ensureRetentionWorker(accessor, DEFAULT_RETENTION, ownerMaintenance);
	if (!maintenanceHandle && providerTracker) {
		maintenanceHandle = startMaintenanceWorker(
			accessor,
			pipelineCfg,
			providerTracker,
			retentionHandle,
			embeddingCfg.provider === "none"
				? undefined
				: {
						cfg: embeddingCfg,
						fetchEmbedding,
						agentId,
						batchSize: pipelineCfg.embeddingTracker.batchSize,
					},
			ownerMaintenance,
		);
	}
	if (!documentWorkerHandle) {
		documentWorkerHandle = startDocumentWorker({
			accessor,
			embeddingCfg,
			fetchEmbedding,
			pipelineCfg,
			ownerMaintenance,
		});
	}
	if (!synthesisWorkerHandle) {
		synthesisWorkerHandle = startSynthesisWorker();
	}
	if (!hintsWorkerHandle && pipelineCfg.hints?.enabled && !pipelineCfg.mutationsFrozen) {
		hintsWorkerHandle = startHintsWorker({ accessor, provider, pipelineCfg, recoverLeasesOnStart: true });
	}

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
