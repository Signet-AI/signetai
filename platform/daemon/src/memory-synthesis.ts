import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";
import { hasDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { writeMemoryHead } from "./memory-head";
import { NOISE_PURGE_REASON, purgeCanonicalNoiseSessionsOnce, renderMemoryProjection } from "./memory-lineage";
import { isObject, isRenderError, isRenderResult } from "./synthesis-worker-protocol";

export interface SynthesisRequest {
	trigger: "scheduled" | "manual";
}

export interface SynthesisResponse {
	harness: string;
	model: string;
	prompt: string;
	/** Number of source items included in the prompt. */
	fileCount: number;
	indexBlock?: string;
}

let synthesisWorker: Worker | null = null;

export function setSynthesisWorker(worker: Worker | null): void {
	synthesisWorker = worker;
}

export function getSynthesisWorker(): Worker | null {
	return synthesisWorker;
}

/**
 * Write MEMORY.md with backup of previous version.
 * Shared by the synthesis-complete endpoint and the synthesis worker.
 */
export function writeMemoryMd(
	content: string,
	opts?: {
		readonly agentId?: string;
		readonly owner?: string;
	},
): { ok: true } | { ok: false; error: string; code?: "busy" | "invalid" } {
	const result = writeMemoryHead(content, opts);
	if (result.ok) return { ok: true };
	logger.error("hooks", result.error, undefined, {
		agentId: opts?.agentId ?? "default",
		owner: opts?.owner,
	});
	return { ok: false, error: result.error, ...(result.code ? { code: result.code } : {}) };
}

export async function handleSynthesisRequest(
	req: SynthesisRequest,
	opts?: { maxTokens?: number; sinceTimestamp?: number; agentId?: string; writeToDisk?: boolean },
): Promise<SynthesisResponse> {
	logger.info("hooks", "Synthesis request", { trigger: req.trigger });

	const _sinceTimestamp = opts?.sinceTimestamp ?? 0;
	const _maxTokens = opts?.maxTokens ?? 8000;
	void _sinceTimestamp;
	void _maxTokens;

	const agentId = opts?.agentId ?? "default";
	if (hasDbAccessor()) {
		purgeCanonicalNoiseSessionsOnce(agentId, NOISE_PURGE_REASON);
	}

	const worker = getSynthesisWorker();
	if (worker === null) {
		logger.warn("hooks", "Synthesis render worker not available, falling back to synchronous render");
		const rendered = await renderMemoryProjection(agentId);
		if (opts?.writeToDisk === true) {
			writeMemoryMd(rendered.content, { agentId });
		}
		return {
			harness: "daemon",
			model: "projection",
			prompt: rendered.content,
			fileCount: rendered.fileCount,
			indexBlock: rendered.indexBlock,
		};
	}

	const requestId = randomUUID();
	const w: Worker = worker;
	return new Promise<SynthesisResponse>((resolve, reject) => {
		let settled = false;

		function cleanup(): void {
			clearTimeout(timer);
			w.off("message", handler);
			w.off("error", onError);
			w.off("exit", onExit);
		}

		async function fallbackToSync(message: string, error?: Error): Promise<void> {
			if (settled) return;
			settled = true;
			cleanup();
			setSynthesisWorker(null);
			w.terminate().catch((err) => {
				logger.debug("hooks", "Synthesis render worker terminate failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
			logger.warn("hooks", "Synthesis render worker failed, falling back to synchronous render", error ?? { message });
			try {
				const rendered = await renderMemoryProjection(agentId);
				if (opts?.writeToDisk === true) {
					writeMemoryMd(rendered.content, { agentId });
				}
				resolve({
					harness: "daemon",
					model: "projection",
					prompt: rendered.content,
					fileCount: rendered.fileCount,
					indexBlock: rendered.indexBlock,
				});
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		}

		function onError(err: Error): void {
			logger.error("hooks", "Synthesis render worker failed", err);
			void fallbackToSync("Synthesis render worker failed", err);
		}

		function onExit(code: number): void {
			if (settled) return;
			const err = new Error(`Synthesis render worker exited before responding (code=${code})`);
			logger.error("hooks", err.message, err);
			void fallbackToSync(err.message, err);
		}

		const timer = setTimeout(() => {
			const err = new Error("Synthesis render worker timed out");
			logger.warn("hooks", err.message);
			void fallbackToSync(err.message, err);
		}, 30_000);

		function handler(msg: unknown): void {
			if (!isObject(msg)) return;
			if (msg.requestId !== requestId) return;
			if (settled) return;
			if (isRenderResult(msg)) {
				settled = true;
				cleanup();
				if (opts?.writeToDisk === true) {
					writeMemoryMd(msg.content, { agentId });
				}
				resolve({
					harness: "daemon",
					model: "projection",
					prompt: msg.content,
					fileCount: msg.fileCount,
					indexBlock: msg.indexBlock,
				});
			} else if (isRenderError(msg)) {
				const err = new Error(`Synthesis render worker error: ${msg.error}`);
				logger.error("hooks", err.message, err);
				void fallbackToSync(err.message, err);
			}
		}

		w.on("message", handler);
		w.once("error", onError);
		w.once("exit", onExit);
		w.postMessage({ type: "render", agentId, requestId });
	});
}
