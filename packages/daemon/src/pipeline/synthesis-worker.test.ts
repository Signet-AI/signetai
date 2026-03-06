import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const agentsDir = mkdtempSync(join(tmpdir(), "signet-synthesis-worker-"));
process.env.SIGNET_PATH = agentsDir;

const mockHandleSynthesisRequest = mock(() => ({
	harness: "daemon",
	model: "synthesis",
	prompt: "synthesize memory",
	fileCount: 1,
}));
const mockWriteMemoryMd = mock((_content: string) => {});
const mockGetSynthesisProvider = mock(() => ({ name: "mock-synthesis-provider" }));
const mockGenerateWithTracking = mock(async () => ({
	text: "# MEMORY\n",
	usage: null,
}));
const mockActiveSessionCount = mock(() => 0);

mock.module("../hooks", () => ({
	handleSynthesisRequest: mockHandleSynthesisRequest,
	writeMemoryMd: mockWriteMemoryMd,
}));

mock.module("../synthesis-llm", () => ({
	getSynthesisProvider: mockGetSynthesisProvider,
}));

mock.module("./provider", () => ({
	generateWithTracking: mockGenerateWithTracking,
}));

mock.module("../session-tracker", () => ({
	activeSessionCount: mockActiveSessionCount,
}));

mock.module("../logger", () => ({
	logger: {
		info() {},
		warn() {},
		error() {},
	},
}));

mock.module("../db-accessor", () => ({
	getDbAccessor: () => ({
		withReadDb: (fn: (db: { prepare: (sql: string) => { get: () => { last_end: string } } }) => unknown) =>
			fn({
				prepare: (_sql: string) => ({
					get: () => ({ last_end: new Date(Date.now() - 60_000).toISOString() }),
				}),
			}),
	}),
}));

const { startSynthesisWorker } = await import("./synthesis-worker");

describe("synthesis-worker", () => {
	beforeEach(() => {
		rmSync(agentsDir, { recursive: true, force: true });
		mkdirSync(agentsDir, { recursive: true });
		mockHandleSynthesisRequest.mockClear();
		mockWriteMemoryMd.mockClear();
		mockGetSynthesisProvider.mockClear();
		mockGenerateWithTracking.mockClear();
		mockActiveSessionCount.mockClear();
		mockGenerateWithTracking.mockImplementation(async () => ({
			text: "# MEMORY\n",
			usage: null,
		}));
	});

	afterEach(async () => {
		// Remove persisted last-synthesis state between tests.
		rmSync(join(agentsDir, ".daemon"), { recursive: true, force: true });
	});

	afterAll(() => {
		rmSync(agentsDir, { recursive: true, force: true });
		delete process.env.SIGNET_PATH;
	});

	it("skips manual synthesis while the shared write lock is held", async () => {
		const worker = startSynthesisWorker({
			enabled: true,
			provider: "claude-code",
			model: "sonnet",
			timeout: 1000,
			maxTokens: 8000,
			idleGapMinutes: 15,
		});

		expect(worker.acquireWriteLock()).toBe(true);
		expect(worker.isSynthesizing).toBe(true);

		const result = await worker.triggerNow();

		expect(result).toEqual({
			success: false,
			skipped: true,
			reason: "Synthesis already in progress",
		});
		expect(mockGenerateWithTracking).not.toHaveBeenCalled();

		worker.releaseWriteLock();
		worker.stop();
		await worker.drain();
	});

	it("drain waits for an in-flight synthesis to finish after stop", async () => {
		let resolveRun!: (value: { text: string; usage: null }) => void;
		mockGenerateWithTracking.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRun = resolve;
				}),
		);

		const worker = startSynthesisWorker({
			enabled: true,
			provider: "claude-code",
			model: "sonnet",
			timeout: 1000,
			maxTokens: 8000,
			idleGapMinutes: 15,
		});

		const runPromise = worker.triggerNow();
		await Promise.resolve();

		expect(worker.isSynthesizing).toBe(true);

		let drained = false;
		const drainPromise = worker.drain().then(() => {
			drained = true;
		});

		worker.stop();
		await Promise.resolve();
		expect(drained).toBe(false);

		resolveRun({ text: "# Updated memory\n", usage: null });

		const result = await runPromise;
		await drainPromise;

		expect(result).toEqual({
			success: true,
			skipped: false,
			reason: undefined,
		});
		expect(drained).toBe(true);
		expect(worker.isSynthesizing).toBe(false);
		expect(mockWriteMemoryMd).toHaveBeenCalledWith("# Updated memory\n");
	});
});
