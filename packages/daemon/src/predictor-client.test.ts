import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { PredictorConfig } from "@signet/core";
import { type PredictorClient, type PredictorSpawn, createPredictorClient } from "./predictor-client";

function makeConfig(overrides: Partial<PredictorConfig> = {}): PredictorConfig {
	return {
		enabled: true,
		trainIntervalSessions: 10,
		minTrainingSessions: 10,
		scoreTimeoutMs: 2000,
		trainTimeoutMs: 5000,
		crashDisableThreshold: 3,
		rrfK: 12,
		explorationRate: 0.05,
		driftResetWindow: 10,
		binaryPath: process.execPath,
		...overrides,
	};
}

interface MockSpawnOptions {
	readonly hang?: boolean;
	readonly crash?: boolean;
	readonly nativeDimensions?: number;
	readonly legacyStatus?: boolean;
}

class MockPredictorProcess extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	killed = false;
	pid = 42;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	spawnfile = "mock-predictor";
	spawnargs: string[] = [];
	private buffer = "";
	private requestCount = 0;
	private readonly nativeDimensions: number;

	constructor(private readonly options: MockSpawnOptions) {
		super();
		this.nativeDimensions = options.nativeDimensions ?? 768;
		this.stdin.setEncoding("utf8");
		this.stdin.on("data", (chunk: string | Buffer) => {
			this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let newlineIndex = this.buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = this.buffer.slice(0, newlineIndex);
				this.buffer = this.buffer.slice(newlineIndex + 1);
				this.handleLine(line);
				newlineIndex = this.buffer.indexOf("\n");
			}
		});
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.finish(null, signal);
		return true;
	}

	private finish(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.killed) return;
		this.killed = true;
		this.exitCode = code;
		this.signalCode = signal;
		this.stdout.end();
		this.stderr.end();
		queueMicrotask(() => {
			this.emit("exit", code, signal);
		});
	}

	private writeResponse(id: string | null, result: Record<string, unknown>): void {
		this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
	}

	private handleLine(line: string): void {
		if (line.trim().length === 0) return;
		const req = JSON.parse(line) as {
			id: string | null;
			method: string;
			params?: Record<string, unknown>;
		};

		this.requestCount++;
		if (this.options.crash && this.requestCount > 1) {
			this.finish(1, null);
			return;
		}

		if (req.method === "status") {
			if (this.options.legacyStatus) {
				this.writeResponse(req.id, {
					trained: false,
					training_pairs: 0,
					model_version: 1,
					last_trained: null,
				});
				return;
			}
			this.writeResponse(req.id, {
				trained: false,
				training_pairs: 0,
				model_version: 1,
				last_trained: null,
				native_dimensions: this.nativeDimensions,
				feature_dimensions: 17,
			});
			return;
		}

		if (req.method === "score") {
			if (this.options.hang) return;
			const candidateIds = Array.isArray(req.params?.candidate_ids) ? req.params.candidate_ids : [];
			this.writeResponse(req.id, {
				scores: candidateIds.map((id, i) => ({
					id,
					score: 1 / (i + 1),
				})),
			});
			return;
		}

		if (req.method === "train_from_db") {
			const limit = typeof req.params?.limit === "number" ? req.params.limit : 10;
			this.writeResponse(req.id, {
				loss: 0.42,
				step: 1,
				samples_used: limit,
				samples_skipped: 0,
				duration_ms: 100,
				canary_score_variance: 0.1,
				canary_topk_stability: 0.9,
				checkpoint_saved: false,
			});
			return;
		}

		if (req.method === "save_checkpoint") {
			this.writeResponse(req.id, { saved: true });
			return;
		}

		this.stdout.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: req.id,
				error: { code: -32601, message: "method not found" },
			})}\n`,
		);
	}
}

function createMockSpawn(options: MockSpawnOptions = {}): PredictorSpawn {
	return (_binaryPath, _args) => {
		return new MockPredictorProcess(options) as unknown as ReturnType<PredictorSpawn>;
	};
}

function mockConfig(overrides: Partial<PredictorConfig> = {}): PredictorConfig {
	return makeConfig(overrides);
}

let activeClient: PredictorClient | null = null;

afterEach(async () => {
	if (activeClient !== null) {
		try {
			await activeClient.stop();
		} catch {
			// best-effort
		}
		activeClient = null;
	}
});

/** Poll a condition with short intervals up to a max timeout. */
async function waitFor(condition: () => boolean, maxMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		if (condition()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
}

describe("PredictorClient", () => {
	it("starts and connects to mock sidecar", async () => {
		const client = createPredictorClient(mockConfig(), "default", 1536, createMockSpawn({ nativeDimensions: 1536 }));
		activeClient = client;

		await client.start();
		expect(client.isAlive()).toBe(true);

		const status = await client.status();
		expect(status).not.toBeNull();
		expect(status?.trained).toBe(false);
		expect(status?.model_version).toBe(1);
		expect(status?.native_dimensions).toBe(1536);
		expect(status?.feature_dimensions).toBe(17);
	});

	it("score request returns results", async () => {
		const client = createPredictorClient(mockConfig(), "default", 768, createMockSpawn());
		activeClient = client;
		await client.start();

		const result = await client.score({
			context_embedding: [0.1, 0.2, 0.3],
			candidate_ids: ["m1", "m2", "m3"],
			candidate_embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6], null],
		});

		expect(result).not.toBeNull();
		expect(result?.scores).toHaveLength(3);
		expect(result?.scores[0].id).toBe("m1");
		expect(result?.scores[0].score).toBe(1.0);
	});

	it("score request returns null on timeout", async () => {
		const client = createPredictorClient(
			mockConfig({ scoreTimeoutMs: 200 }),
			"default",
			768,
			createMockSpawn({ hang: true }),
		);
		activeClient = client;
		await client.start();

		const result = await client.score({
			context_embedding: [0.1, 0.2],
			candidate_ids: ["m1"],
			candidate_embeddings: [[0.1, 0.2]],
		});

		expect(result).toBeNull();
	});

	it("handles sidecar crash and rejects pending requests", async () => {
		const client = createPredictorClient(
			mockConfig({ scoreTimeoutMs: 2000 }),
			"default",
			768,
			createMockSpawn({ crash: true }),
		);
		activeClient = client;
		await client.start();

		// The crash mock exits after the first request (which was the
		// startup status check). The next request should trigger the crash.
		const result = await client.score({
			context_embedding: [0.1],
			candidate_ids: ["m1"],
			candidate_embeddings: [[0.1]],
		});

		// Should return null (fail open) since sidecar crashed
		expect(result).toBeNull();
	});

	it("tracks crash count", async () => {
		const client = createPredictorClient(
			mockConfig({ crashDisableThreshold: 10 }),
			"default",
			768,
			createMockSpawn({ crash: true }),
		);
		activeClient = client;
		await client.start();

		// Trigger crash
		await client.score({
			context_embedding: [0.1],
			candidate_ids: ["m1"],
			candidate_embeddings: [[0.1]],
		});

		// Poll for crash to be recorded instead of fixed sleep
		await waitFor(() => client.crashCount > 0, 2000);
		expect(client.crashCount).toBeGreaterThanOrEqual(1);
	});

	it("crash-disables after threshold", async () => {
		// Set threshold to 1 so it disables immediately
		const client = createPredictorClient(
			mockConfig({ crashDisableThreshold: 1 }),
			"default",
			768,
			createMockSpawn({ crash: true }),
		);
		activeClient = client;
		await client.start();

		// Trigger crash
		await client.score({
			context_embedding: [0.1],
			candidate_ids: ["m1"],
			candidate_embeddings: [[0.1]],
		});

		// Poll for crash-disable
		await waitFor(() => client.crashDisabled, 2000);
		expect(client.crashDisabled).toBe(true);
	});

	it("handles multiple concurrent score requests", async () => {
		const client = createPredictorClient(mockConfig(), "default", 768, createMockSpawn());
		activeClient = client;
		await client.start();

		const promises = Array.from({ length: 5 }, (_, i) =>
			client.score({
				context_embedding: [0.1 * i],
				candidate_ids: [`m${i}`],
				candidate_embeddings: [[0.1 * i]],
			}),
		);

		const results = await Promise.all(promises);
		for (const result of results) {
			expect(result).not.toBeNull();
			expect(result?.scores).toHaveLength(1);
		}
	});

	it("trainFromDb request works", async () => {
		const client = createPredictorClient(mockConfig(), "default", 768, createMockSpawn());
		activeClient = client;
		await client.start();

		const result = await client.trainFromDb({
			db_path: "/tmp/test.db",
			limit: 50,
			epochs: 3,
		});

		expect(result).not.toBeNull();
		expect(result?.loss).toBe(0.42);
		expect(result?.samples_used).toBe(50);
		expect(result?.checkpoint_saved).toBe(false);
	});

	it("returns null for incompatible legacy status responses", async () => {
		const client = createPredictorClient(mockConfig(), "default", 768, createMockSpawn({ legacyStatus: true }));
		activeClient = client;
		await client.start();

		const status = await client.status();
		expect(status).toBeNull();
	});

	it("stop kills the process cleanly", async () => {
		const client = createPredictorClient(mockConfig(), "default", 768, createMockSpawn());
		activeClient = client;
		await client.start();
		expect(client.isAlive()).toBe(true);

		await client.stop();
		expect(client.isAlive()).toBe(false);

		// Subsequent requests return null
		const result = await client.score({
			context_embedding: [0.1],
			candidate_ids: ["m1"],
			candidate_embeddings: [[0.1]],
		});
		expect(result).toBeNull();

		activeClient = null; // already stopped
	});

	it("returns null for all methods when sidecar is not running", async () => {
		const client = createPredictorClient(mockConfig(), "default", 768, createMockSpawn());
		activeClient = client;
		// Don't start

		expect(client.isAlive()).toBe(false);
		expect(await client.score({ context_embedding: [], candidate_ids: [], candidate_embeddings: [] })).toBeNull();
		expect(await client.trainFromDb({ db_path: "/tmp/test.db" })).toBeNull();
		expect(await client.status()).toBeNull();
		expect(await client.saveCheckpoint("/tmp/ckpt.bin")).toBe(false);

		activeClient = null;
	});

	it("start is a no-op when binary is missing", async () => {
		const cfg = makeConfig({ binaryPath: "/definitely/missing/signet-predictor" });
		const client = createPredictorClient(cfg);
		activeClient = client;

		// Should NOT throw — fail open
		await client.start();
		expect(client.isAlive()).toBe(false);

		activeClient = null;
	});

	it("stop resolves inflight requests with null (not hang)", async () => {
		const client = createPredictorClient(
			mockConfig({ scoreTimeoutMs: 30000 }),
			"default",
			768,
			createMockSpawn({ hang: true }),
		);
		activeClient = client;
		await client.start();

		// Fire a score request that will hang
		const scorePromise = client.score({
			context_embedding: [0.1],
			candidate_ids: ["m1"],
			candidate_embeddings: [[0.1]],
		});

		// Give the request time to be sent
		await new Promise((r) => setTimeout(r, 50));

		// Stop while request is in flight
		await client.stop();

		// The inflight request should resolve to null (fail open), not hang
		const result = await scorePromise;
		expect(result).toBeNull();

		activeClient = null; // already stopped
	});
});
