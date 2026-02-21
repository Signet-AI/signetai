/**
 * Pipeline barrel — startPipeline/stopPipeline orchestration.
 */

import type { DbAccessor } from "../db-accessor";
import type { EmbeddingConfig, PipelineV2Config } from "../memory-config";
import { createOllamaProvider } from "./provider";
import { startWorker, type WorkerHandle } from "./worker";
import {
	startRetentionWorker,
	DEFAULT_RETENTION,
	type RetentionHandle,
} from "./retention-worker";
import type { DecisionConfig } from "./decision";
import { logger } from "../logger";

export { enqueueExtractionJob } from "./worker";
export type { WorkerHandle } from "./worker";
export type { LlmProvider } from "./provider";
export type { RetentionHandle, RetentionConfig } from "./retention-worker";

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let workerHandle: WorkerHandle | null = null;
let retentionHandle: RetentionHandle | null = null;

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
): void {
	if (workerHandle) {
		logger.warn("pipeline", "Pipeline already running, skipping start");
		return;
	}

	const provider = createOllamaProvider({
		model: pipelineCfg.extractionModel,
		defaultTimeoutMs: pipelineCfg.extractionTimeout,
	});

	const decisionCfg: DecisionConfig = {
		embedding: embeddingCfg,
		search: searchCfg,
		fetchEmbedding,
	};

	workerHandle = startWorker(accessor, provider, pipelineCfg, decisionCfg);

	// Retention worker runs independently of pipeline mode
	if (!retentionHandle) {
		retentionHandle = startRetentionWorker(accessor, DEFAULT_RETENTION);
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
	if (retentionHandle) {
		retentionHandle.stop();
		retentionHandle = null;
	}
	if (!workerHandle) return;
	await workerHandle.stop();
	workerHandle = null;
	logger.info("pipeline", "Pipeline stopped");
}
