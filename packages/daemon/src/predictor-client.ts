/**
 * JSON-RPC 2.0 client for the Rust predictor sidecar process.
 *
 * Spawns `signet-predictor` as a child process, communicates via
 * newline-delimited JSON over stdin/stdout. Fails open — if the
 * sidecar is unavailable, scoring methods return null rather than
 * throwing, so the daemon continues operating without predictions.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PredictorConfig } from "@signet/core";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Public types (mirror the Rust protocol)
// ---------------------------------------------------------------------------

export interface ScoreParams {
	readonly agent_id?: string;
	readonly context_embedding: ReadonlyArray<number>;
	readonly candidate_ids: ReadonlyArray<string>;
	readonly candidate_embeddings: ReadonlyArray<ReadonlyArray<number> | null>;
	readonly candidate_texts?: ReadonlyArray<string | null>;
	readonly candidate_features?: ReadonlyArray<ReadonlyArray<number> | null>;
	readonly project_slot?: number;
}

export interface ScoreResult {
	readonly scores: ReadonlyArray<{ readonly id: string; readonly score: number }>;
}

export interface TrainFromDbParams {
	readonly agent_id?: string;
	readonly db_path: string;
	readonly checkpoint_path?: string;
	readonly limit?: number;
	readonly epochs?: number;
	readonly temperature?: number;
	readonly min_confidence?: number;
}

export interface TrainResult {
	readonly loss: number;
	readonly step: number;
	readonly samples_used: number;
	readonly samples_skipped: number;
	readonly duration_ms: number;
	readonly canary_score_variance: number;
	readonly canary_topk_stability: number;
	readonly checkpoint_saved: boolean;
}

export interface PredictorStatus {
	readonly trained: boolean;
	readonly training_pairs: number;
	readonly model_version: number;
	readonly last_trained: string | null;
}

export interface PredictorClient {
	/** Spawn the sidecar process. Resolves when first status response received. */
	start(): Promise<void>;

	/** Kill the sidecar process gracefully. */
	stop(): Promise<void>;

	/** Is the sidecar process alive? */
	isAlive(): boolean;

	/** Score candidates. Returns null if sidecar unavailable (fail open). */
	score(params: ScoreParams): Promise<ScoreResult | null>;

	/** Trigger training from database. Returns null if sidecar unavailable. */
	trainFromDb(params: TrainFromDbParams): Promise<TrainResult | null>;

	/** Get model status. Returns null if sidecar unavailable. */
	status(): Promise<PredictorStatus | null>;

	/** Save checkpoint. Returns null if sidecar unavailable. */
	saveCheckpoint(path: string): Promise<boolean>;

	/** Number of crashes since last reset window. */
	readonly crashCount: number;

	/** Whether crash threshold has been exceeded, disabling restarts. */
	readonly crashDisabled: boolean;
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id: string;
	readonly method: string;
	readonly params: unknown;
}

interface JsonRpcSuccessResponse {
	readonly jsonrpc: "2.0";
	readonly id: string | null;
	readonly result: unknown;
	readonly error?: undefined;
}

interface JsonRpcErrorResponse {
	readonly jsonrpc: "2.0";
	readonly id: string | null;
	readonly result?: undefined;
	readonly error: { readonly code: number; readonly message: string };
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ---------------------------------------------------------------------------
// Pending request tracker
// ---------------------------------------------------------------------------

interface PendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (reason: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Response parsing helpers (runtime validation at JSON boundary)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseScoreResult(value: unknown): ScoreResult | null {
	if (!isRecord(value)) return null;
	if (!Array.isArray(value.scores)) return null;
	const scores: Array<{ readonly id: string; readonly score: number }> = [];
	for (const entry of value.scores) {
		if (!isRecord(entry)) return null;
		if (typeof entry.id !== "string" || typeof entry.score !== "number") return null;
		scores.push({ id: entry.id, score: entry.score });
	}
	return { scores };
}

function parseTrainResult(value: unknown): TrainResult | null {
	if (!isRecord(value)) return null;
	if (
		typeof value.loss !== "number" ||
		typeof value.step !== "number" ||
		typeof value.samples_used !== "number" ||
		typeof value.samples_skipped !== "number" ||
		typeof value.duration_ms !== "number" ||
		typeof value.canary_score_variance !== "number" ||
		typeof value.canary_topk_stability !== "number" ||
		typeof value.checkpoint_saved !== "boolean"
	) {
		return null;
	}
	return {
		loss: value.loss,
		step: value.step,
		samples_used: value.samples_used,
		samples_skipped: value.samples_skipped,
		duration_ms: value.duration_ms,
		canary_score_variance: value.canary_score_variance,
		canary_topk_stability: value.canary_topk_stability,
		checkpoint_saved: value.checkpoint_saved,
	};
}

function parsePredictorStatus(value: unknown): PredictorStatus | null {
	if (!isRecord(value)) return null;
	if (
		typeof value.trained !== "boolean" ||
		typeof value.training_pairs !== "number" ||
		typeof value.model_version !== "number" ||
		(value.last_trained !== null && typeof value.last_trained !== "string")
	) {
		return null;
	}
	return {
		trained: value.trained,
		training_pairs: value.training_pairs,
		model_version: value.model_version,
		last_trained: typeof value.last_trained === "string" ? value.last_trained : null,
	};
}

function parseSaveCheckpointResult(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return typeof value.saved === "boolean" ? value.saved : false;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const RESTART_DELAY_MS = 1000;
const MAX_RESTART_ATTEMPTS = 3;
const CRASH_WINDOW_MS = 3600_000; // 1 hour
const CRASH_RECOVERY_MS = CRASH_WINDOW_MS * 2; // 2 hours — auto-reset cooldown

function resolveBinaryPath(configured: string | undefined): string | null {
	if (configured) return configured;

	// Check PATH via Bun.which (available in Bun runtime)
	if (typeof globalThis.Bun !== "undefined") {
		const found = Bun.which("signet-predictor");
		if (found !== null) return found;
	}

	// Fallback: check common relative locations from project root
	const candidates = [
		join(process.cwd(), "packages", "predictor", "target", "release", "signet-predictor"),
	];
	for (const candidate of candidates) {
		try {
			const stat = statSync(candidate);
			if (stat.isFile()) return candidate;
		} catch {
			// not found, continue
		}
	}

	return null;
}

function defaultCheckpointPath(): string {
	return join(homedir(), ".agents", "memory", "predictor", "model.bin");
}

export function createPredictorClient(
	config: PredictorConfig,
	agentId: string = "default",
): PredictorClient {
	let proc: ChildProcess | null = null;
	let rl: Interface | null = null;
	let nextId = 1;
	const pending = new Map<string, PendingRequest>();
	let stopping = false;
	let restartAttempts = 0;

	// Crash tracking
	const crashTimestamps: number[] = [];
	let _crashDisabled = false;

	function recordCrash(): void {
		const now = Date.now();
		crashTimestamps.push(now);
		// Prune timestamps older than the crash window
		while (crashTimestamps.length > 0 && crashTimestamps[0] < now - CRASH_WINDOW_MS) {
			crashTimestamps.shift();
		}
		if (crashTimestamps.length >= config.crashDisableThreshold) {
			_crashDisabled = true;
			logger.warn("predictor", "Crash threshold exceeded, disabling predictor restarts", {
				crashes: crashTimestamps.length,
				threshold: config.crashDisableThreshold,
			});
		}
	}

	/** Check if crash-disable should auto-recover based on cooldown. */
	function checkCrashRecovery(): void {
		if (!_crashDisabled) return;
		const now = Date.now();
		const lastCrash = crashTimestamps.length > 0
			? crashTimestamps[crashTimestamps.length - 1]
			: 0;
		if (lastCrash > 0 && now - lastCrash > CRASH_RECOVERY_MS) {
			_crashDisabled = false;
			restartAttempts = 0;
			crashTimestamps.length = 0;
			logger.info("predictor", "Crash cooldown elapsed, re-enabling predictor");
		}
	}

	function resolveAllPending(reason: string): void {
		const err = new Error(reason);
		for (const [, req] of pending) {
			clearTimeout(req.timer);
			req.reject(err);
		}
		pending.clear();
	}

	function handleLine(line: string): void {
		if (line.trim().length === 0) return;
		let parsed: JsonRpcResponse;
		try {
			parsed = JSON.parse(line) as JsonRpcResponse;
		} catch {
			logger.warn("predictor", "Unparseable response from sidecar", {
				raw: line.slice(0, 200),
			});
			return;
		}

		const id = parsed.id;
		if (id === null || id === undefined) return;

		const req = pending.get(id);
		if (!req) return;
		pending.delete(id);
		clearTimeout(req.timer);

		if (parsed.error) {
			req.reject(new Error(`Predictor RPC error [${parsed.error.code}]: ${parsed.error.message}`));
		} else {
			req.resolve(parsed.result);
		}
	}

	function sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (proc === null || proc.stdin === null || proc.killed) {
				reject(new Error("Predictor sidecar not running"));
				return;
			}

			const id = `req-${nextId++}`;
			const request: JsonRpcRequest = {
				jsonrpc: "2.0",
				id,
				method,
				params,
			};

			const timer = setTimeout(() => {
				const req = pending.get(id);
				if (req) {
					pending.delete(id);
					req.reject(new Error(`Predictor RPC timeout after ${timeoutMs}ms for method "${method}"`));
				}
			}, timeoutMs);

			pending.set(id, { resolve, reject, timer });

			const json = JSON.stringify(request);
			try {
				proc.stdin.write(json + "\n");
			} catch (err) {
				pending.delete(id);
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	function spawnProcess(): ChildProcess | null {
		const binaryPath = resolveBinaryPath(config.binaryPath);
		if (binaryPath === null) {
			logger.warn("predictor", "signet-predictor binary not found");
			return null;
		}

		const args: string[] = [];
		const checkpointPath = config.checkpointPath ?? defaultCheckpointPath();
		args.push("--checkpoint", checkpointPath);

		logger.info("predictor", "Spawning predictor sidecar", {
			binary: binaryPath,
			checkpoint: checkpointPath,
		});

		const child = spawn(binaryPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Read stdout line-by-line for JSON-RPC responses
		if (!child.stdout) {
			logger.error("predictor", "Sidecar stdout not available");
			return null;
		}
		const lineReader = createInterface({ input: child.stdout });
		lineReader.on("line", handleLine);
		rl = lineReader;

		// Pipe stderr to logger
		if (child.stderr) {
			const stderrReader = createInterface({ input: child.stderr });
			stderrReader.on("line", (line: string) => {
				if (line.trim().length > 0) {
					logger.warn("predictor", `[sidecar stderr] ${line}`);
				}
			});
		}

		child.on("error", (err) => {
			logger.error("predictor", "Sidecar process error", err);
		});

		child.on("exit", (code, signal) => {
			logger.info("predictor", "Sidecar exited", { code, signal });
			resolveAllPending("Predictor sidecar exited unexpectedly");
			proc = null;

			if (rl) {
				rl.close();
				rl = null;
			}

			if (!stopping && !_crashDisabled) {
				recordCrash();
				if (!_crashDisabled && restartAttempts < MAX_RESTART_ATTEMPTS) {
					restartAttempts++;
					logger.info("predictor", `Scheduling restart attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}`);
					setTimeout(() => {
						if (!stopping && !_crashDisabled) {
							const newProc = spawnProcess();
							if (newProc) {
								proc = newProc;
							}
						}
					}, RESTART_DELAY_MS);
				} else if (!_crashDisabled) {
					logger.warn("predictor", "Max restart attempts reached, giving up");
				}
			}
		});

		return child;
	}

	/** Inject agent_id into params if not already present. */
	function withAgentId(params: unknown): unknown {
		if (isRecord(params) && params.agent_id === undefined) {
			return { ...params, agent_id: agentId };
		}
		return params;
	}

	const client: PredictorClient = {
		get crashCount(): number {
			const now = Date.now();
			// Count only crashes within the window
			return crashTimestamps.filter((ts) => ts >= now - CRASH_WINDOW_MS).length;
		},

		get crashDisabled(): boolean {
			return _crashDisabled;
		},

		async start(): Promise<void> {
			stopping = false;
			// Reset crash state on explicit start() — gives the predictor
			// a fresh chance after config changes or manual restarts.
			_crashDisabled = false;
			restartAttempts = 0;

			const child = spawnProcess();
			if (child === null) {
				// Fail open: binary not found is not an error for new installs.
				logger.warn("predictor", "Predictor binary not found, sidecar not started");
				return;
			}
			proc = child;

			// Wait for initial status response to confirm sidecar is ready
			try {
				const result = await sendRequest("status", {}, 5000);
				if (isRecord(result)) {
					logger.info("predictor", "Sidecar ready", result);
				} else {
					logger.info("predictor", "Sidecar ready");
				}
			} catch (err) {
				// Fail open: if sidecar doesn't respond in time, leave
				// it running (it may come alive later) but don't throw.
				logger.warn(
					"predictor",
					"Sidecar did not respond to initial status check",
					{ error: err instanceof Error ? err.message : String(err) },
				);
			}
		},

		async stop(): Promise<void> {
			stopping = true;
			resolveAllPending("Predictor client stopping");

			if (rl) {
				rl.close();
				rl = null;
			}

			if (proc !== null && !proc.killed) {
				const child = proc;
				proc = null;

				// Give the process a chance to exit gracefully by closing stdin
				try {
					child.stdin?.end();
				} catch {
					// best-effort
				}

				// Wait briefly, then force kill
				await new Promise<void>((resolve) => {
					const killTimer = setTimeout(() => {
						try {
							child.kill("SIGKILL");
						} catch {
							// already dead
						}
						resolve();
					}, 2000);

					child.on("exit", () => {
						clearTimeout(killTimer);
						resolve();
					});

					// Try SIGTERM first
					try {
						child.kill("SIGTERM");
					} catch {
						clearTimeout(killTimer);
						resolve();
					}
				});
			}
		},

		isAlive(): boolean {
			checkCrashRecovery();
			return proc !== null && !proc.killed;
		},

		async score(params: ScoreParams): Promise<ScoreResult | null> {
			if (!client.isAlive()) return null;
			try {
				const result = await sendRequest("score", withAgentId(params), config.scoreTimeoutMs);
				return parseScoreResult(result);
			} catch (err) {
				logger.debug("predictor", "Score request failed", {
					error: err instanceof Error ? err.message : String(err),
				});
				return null;
			}
		},

		async trainFromDb(params: TrainFromDbParams): Promise<TrainResult | null> {
			if (!client.isAlive()) return null;
			try {
				const result = await sendRequest("train_from_db", withAgentId(params), config.trainTimeoutMs);
				return parseTrainResult(result);
			} catch (err) {
				logger.warn("predictor", "train_from_db request failed", {
					error: err instanceof Error ? err.message : String(err),
				});
				return null;
			}
		},

		async status(): Promise<PredictorStatus | null> {
			if (!client.isAlive()) return null;
			try {
				const result = await sendRequest("status", {}, 5000);
				return parsePredictorStatus(result);
			} catch (err) {
				logger.debug("predictor", "Status request failed", {
					error: err instanceof Error ? err.message : String(err),
				});
				return null;
			}
		},

		async saveCheckpoint(path: string): Promise<boolean> {
			if (!client.isAlive()) return false;
			try {
				const result = await sendRequest("save_checkpoint", { path, flags: 0 }, 10000);
				return parseSaveCheckpointResult(result);
			} catch (err) {
				logger.warn("predictor", "save_checkpoint request failed", {
					error: err instanceof Error ? err.message : String(err),
				});
				return false;
			}
		},
	};

	return client;
}
