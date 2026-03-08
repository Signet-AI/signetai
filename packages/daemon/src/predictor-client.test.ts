import { describe, expect, it, afterEach } from "bun:test";
import { join } from "node:path";
import type { PredictorConfig } from "@signet/core";
import { createPredictorClient, type PredictorClient } from "./predictor-client";

const MOCK_SCRIPT = join(import.meta.dir, "__fixtures__", "mock-predictor.mjs");

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
		// Point at the mock script via node/bun
		binaryPath: process.execPath,
		...overrides,
	};
}

// We override the binary path to point at bun/node running our mock script.
// The predictor client spawns `binaryPath` with args, so we need to
// make the mock script the first arg. We achieve this by setting binaryPath
// to the runtime and passing the script as a checkpoint arg won't work.
// Instead, we'll use a small wrapper approach: create a config that
// points binaryPath at a shell wrapper.

// Actually, the client passes `--checkpoint <path>` as args to the binary.
// The mock script ignores unknown args, so we just need to make the
// client spawn `bun <script>` or `node <script>`. The simplest approach
// is to make the binary path point to a script that self-executes.

// The cleanest approach: make mock-predictor.mjs executable and point
// binaryPath at it. But for portability, let's use a different strategy:
// patch the binary path to use bun run.

// Let me use a wrapper script approach.
import { writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";

function createMockWrapper(extraArgs: string[] = []): string {
	const wrapperPath = join(tmpdir(), `mock-predictor-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
	const scriptArgs = extraArgs.map((a) => `"${a}"`).join(" ");
	writeFileSync(
		wrapperPath,
		`#!/bin/sh\nexec "${process.execPath}" "${MOCK_SCRIPT}" ${scriptArgs} "$@"\n`,
		{ mode: 0o755 },
	);
	return wrapperPath;
}

const wrappers: string[] = [];
function mockConfig(mockArgs: string[] = [], overrides: Partial<PredictorConfig> = {}): PredictorConfig {
	const wrapper = createMockWrapper(mockArgs);
	wrappers.push(wrapper);
	return makeConfig({ binaryPath: wrapper, ...overrides });
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
	for (const w of wrappers) {
		try {
			unlinkSync(w);
		} catch {
			// ignore
		}
	}
	wrappers.length = 0;
});

/** Poll a condition with short intervals up to a max timeout. */
async function waitFor(
	condition: () => boolean,
	maxMs: number,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		if (condition()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
}

describe("PredictorClient", () => {
	it("starts and connects to mock sidecar", async () => {
		const client = createPredictorClient(mockConfig());
		activeClient = client;

		await client.start();
		expect(client.isAlive()).toBe(true);

		const status = await client.status();
		expect(status).not.toBeNull();
		expect(status?.trained).toBe(false);
		expect(status?.model_version).toBe(1);
	});

	it("score request returns results", async () => {
		const client = createPredictorClient(mockConfig());
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
		const client = createPredictorClient(mockConfig(["--hang"], { scoreTimeoutMs: 200 }));
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
		const client = createPredictorClient(mockConfig(["--crash"], { scoreTimeoutMs: 2000 }));
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
			mockConfig(["--crash"], { crashDisableThreshold: 10 }),
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
			mockConfig(["--crash"], { crashDisableThreshold: 1 }),
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
		const client = createPredictorClient(mockConfig());
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
		const client = createPredictorClient(mockConfig());
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

	it("stop kills the process cleanly", async () => {
		const client = createPredictorClient(mockConfig());
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
		const client = createPredictorClient(mockConfig());
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
		// Use a config with no binaryPath — resolveBinaryPath will search
		// PATH and known locations, none of which should have signet-predictor.
		const cfg = makeConfig({ binaryPath: undefined });
		const client = createPredictorClient(cfg);
		activeClient = client;

		// Should NOT throw — fail open
		await client.start();
		expect(client.isAlive()).toBe(false);

		activeClient = null;
	});

	it("stop resolves inflight requests with null (not hang)", async () => {
		// Use --hang so score never responds
		const client = createPredictorClient(mockConfig(["--hang"], { scoreTimeoutMs: 30000 }));
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
