/**
 * Pipeline barrel — startPipeline/stopPipeline orchestration.
 */

import type { DbAccessor } from "../db-accessor";
import type { EmbeddingConfig, PipelineV2Config } from "../memory-config";
import { getLlmProvider } from "../llm";
import { startWorker, type WorkerHandle } from "./worker";
import {
	startRetentionWorker,
	DEFAULT_RETENTION,
	type RetentionHandle,
} from "./retention-worker";
import {
	startMaintenanceWorker,
	type MaintenanceHandle,
} from "./maintenance-worker";
import {
	startDocumentWorker,
	type DocumentWorkerHandle,
} from "./document-worker";
import {
	startSummaryWorker,
	type SummaryWorkerHandle,
} from "./summary-worker";
import type { DecisionConfig } from "./decision";
import type { ProviderTracker } from "../diagnostics";
import type { AnalyticsCollector } from "../analytics";
import { logger } from "../logger";

export { enqueueExtractionJob } from "./worker";
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

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let workerHandle: WorkerHandle | null = null;
let retentionHandle: RetentionHandle | null = null;
let maintenanceHandle: MaintenanceHandle | null = null;
let documentWorkerHandle: DocumentWorkerHandle | null = null;
let summaryWorkerHandle: SummaryWorkerHandle | null = null;

/** Snapshot of running state for each worker — used by /api/pipeline/status */
export function getPipelineWorkerStatus(): Record<string, { running: boolean }> {
	return {
		extraction: { running: workerHandle !== null },
		summary: { running: summaryWorkerHandle !== null },
		document: { running: documentWorkerHandle !== null },
		retention: { running: retentionHandle !== null },
		maintenance: { running: maintenanceHandle !== null },
	};
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

export function startPipeline(
	accessor: DbAccessor,
	pipelineCfg: PipelineV2Config,
	embeddingCfg: EmbeddingConfig,
	fetchEmbedding: (
		text: string,
		cfg: EmbeddingConfig,
	) => Promise<number[] | null>,
	searchCfg: { alpha: number; top_k: number; min_score: number },
	providerTracker?: ProviderTracker,
	analytics?: AnalyticsCollector,
): void {
	if (workerHandle) {
		logger.warn("pipeline", "Pipeline already running, skipping start");
		return;
	}

	const provider = getLlmProvider();

	const decisionCfg: DecisionConfig = {
		embedding: embeddingCfg,
		search: searchCfg,
		fetchEmbedding,
	};

	workerHandle = startWorker(accessor, provider, pipelineCfg, decisionCfg, analytics);

	// Retention worker also managed here when pipeline is active;
	// standalone retention is started separately in main() for non-pipeline users.
	if (!retentionHandle) {
		retentionHandle = startRetentionWorker(accessor, DEFAULT_RETENTION);
	}

	// Maintenance worker (F3) — runs alongside retention
	if (!maintenanceHandle && providerTracker) {
		maintenanceHandle = startMaintenanceWorker(
			accessor,
			pipelineCfg,
			providerTracker,
			retentionHandle,
		);
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

	logger.info("pipeline", "Pipeline started", {
		mode:
			pipelineCfg.enabled &&
			!pipelineCfg.shadowMode &&
			!pipelineCfg.mutationsFrozen
				? "controlled-write"
				: "shadow",
	});
}

export async function stopPipeline(): Promise<void> {
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
