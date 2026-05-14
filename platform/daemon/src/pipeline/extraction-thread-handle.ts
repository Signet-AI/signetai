/**
 * Main-thread adapter for the extraction worker thread.
 *
 * Spawns a node:worker_threads Worker running extraction-thread.ts,
 * implements the WorkerHandle interface by translating method calls
 * into IPC messages. Drop-in replacement for the direct startWorker()
 * return value.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { AnalyticsCollector } from "../analytics";
import { logger } from "../logger";
import type { LogCategory } from "../logger";
import type { TelemetryCollector, TelemetryEventType, TelemetryProperties } from "../telemetry";
import type { MainToWorkerMessage, WorkerInit, WorkerToMainMessage } from "./extraction-thread-protocol";
import type { WorkerHandle, WorkerStats } from "./worker";

const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

export interface ExtractionWorker {
	on(event: "message", listener: (msg: WorkerToMainMessage) => void): ExtractionWorker;
	on(event: "error", listener: (err: Error) => void): ExtractionWorker;
	on(event: "exit", listener: (code: number) => void): ExtractionWorker;
	postMessage(msg: MainToWorkerMessage): void;
	terminate(): Promise<number> | number;
}

export type ExtractionWorkerFactory = (workerPath: string, init: WorkerInit) => ExtractionWorker;

export interface ExtractionThreadOpts {
	readonly init: WorkerInit;
	readonly analytics?: AnalyticsCollector;
	readonly telemetry?: TelemetryCollector;
	readonly workerFactory?: ExtractionWorkerFactory;
	readonly readyTimeoutMs?: number;
	readonly stopTimeoutMs?: number;
}

export function startExtractionThread(opts: ExtractionThreadOpts): Promise<WorkerHandle> {
	const { init, analytics, telemetry } = opts;
	const __dirname = dirname(fileURLToPath(import.meta.url));
	return new Promise<WorkerHandle>((resolve, reject) => {
		const bundled = join(__dirname, "extraction-thread.js");
		const workerPath = existsSync(bundled) ? bundled : join(__dirname, "extraction-thread.ts");
		const worker = (opts.workerFactory ?? createNodeWorker)(workerPath, init);

		let running = true;
		let settled = false;
		let latestStats: WorkerStats = {
			failures: 0,
			lastProgressAt: Date.now(),
			pending: 0,
			processed: 0,
			backoffMs: 0,
			overloaded: false,
			loadPerCpu: null,
			maxLoadPerCpu: 0,
			overloadBackoffMs: 0,
			overloadSince: null,
			nextTickInMs: 0,
		};

		const readyTimer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(
				new Error(
					`Extraction worker thread failed to become ready within ${opts.readyTimeoutMs ?? READY_TIMEOUT_MS}ms`,
				),
			);
			worker.terminate();
		}, opts.readyTimeoutMs ?? READY_TIMEOUT_MS);

		worker.on("message", (msg: WorkerToMainMessage) => {
			switch (msg.type) {
				case "ready":
					clearTimeout(readyTimer);
					if (settled) break;
					settled = true;
					logger.info("pipeline", "Extraction worker thread ready");
					resolve(handle);
					break;

				case "stopped":
					running = false;
					break;

				case "stats":
					latestStats = msg.stats;
					break;

				case "log": {
					const cat = msg.category as LogCategory;
					if (msg.level === "error") {
						logger.error(cat, msg.message, undefined, msg.data);
					} else if (msg.level === "warn") {
						logger.warn(cat, msg.message, msg.data);
					} else {
						logger.info(cat, msg.message, msg.data);
					}
					break;
				}

				case "error":
					logger.error("pipeline", "Extraction worker thread error", undefined, {
						error: msg.error,
						stack: msg.stack,
					});
					break;

				case "telemetry":
					telemetry?.record(msg.event as TelemetryEventType, msg.data as TelemetryProperties);
					break;

				case "analytics": {
					const fn = analytics?.[msg.method as keyof AnalyticsCollector];
					if (typeof fn === "function") {
						(fn as (...a: unknown[]) => void).apply(analytics, msg.args as unknown[]);
					}
					break;
				}
			}
		});

		worker.on("error", (err: Error) => {
			clearTimeout(readyTimer);
			logger.error("pipeline", "Extraction worker thread crashed", err);
			running = false;
			if (!settled) {
				settled = true;
				reject(err);
			}
		});

		worker.on("exit", (code: number) => {
			clearTimeout(readyTimer);
			running = false;
			if (code !== 0) {
				logger.warn("pipeline", "Extraction worker thread exited with non-zero code", { code });
			}
			if (!settled) {
				settled = true;
				reject(new Error(`Extraction worker thread exited with code ${code} before becoming ready`));
			}
		});

		const handle: WorkerHandle = {
			get running() {
				return running;
			},
			get stats(): WorkerStats {
				return latestStats;
			},
			nudge(): void {
				if (!running) return;
				worker.postMessage({ type: "nudge" });
			},
			async stop(): Promise<void> {
				if (!running) return;
				worker.postMessage({ type: "stop" });
				await new Promise<void>((res) => {
					const stopTimer = setTimeout(() => {
						logger.warn("pipeline", "Extraction worker thread stop timed out, terminating");
						worker.terminate();
						res();
					}, opts.stopTimeoutMs ?? STOP_TIMEOUT_MS);
					worker.on("message", (msg: WorkerToMainMessage) => {
						if (msg.type === "stopped") {
							clearTimeout(stopTimer);
							res();
						}
					});
				});
				await worker.terminate();
				running = false;
				logger.info("pipeline", "Extraction worker thread stopped");
			},
		};
	});
}

function createNodeWorker(workerPath: string, init: WorkerInit): ExtractionWorker {
	return new Worker(workerPath, { workerData: init });
}
