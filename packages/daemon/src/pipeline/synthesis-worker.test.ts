import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let agentsDir = "";
let previousSignetPath: string | undefined;

const mockHandleSynthesisRequest = mock(() => ({
	harness: "daemon",
	model: "synthesis",
	prompt: "synthesize memory",
	fileCount: 1,
	indexBlock: "",
}));
const mockWriteMemoryMd = mock((_content: string, _opts?: { owner?: string }) => ({ ok: true as const }));
const mockAppendSynthesisIndexBlock = mock((content: string) => content);
const mockGetSynthesisProvider = mock(() => ({ name: "mock-synthesis-provider" }));
const mockGenerateWithTracking = mock(async () => ({
	text: "# MEMORY\n",
	usage: null,
}));
const mockActiveSessionCount = mock(() => 0);

mock.module("../hooks", () => ({
	appendSynthesisIndexBlock: mockAppendSynthesisIndexBlock,
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

let startSynthesisWorker: typeof import("./synthesis-worker").startSynthesisWorker;

describe("synthesis-worker", () => {
	beforeAll(async () => {
		previousSignetPath = process.env.SIGNET_PATH;
		agentsDir = mkdtempSync(join(tmpdir(), "signet-synthesis-worker-"));
		process.env.SIGNET_PATH = agentsDir;
		({ startSynthesisWorker } = await import("./synthesis-worker"));
	});

	beforeEach(() => {
		rmSync(agentsDir, { recursive: true, force: true });
		mkdirSync(agentsDir, { recursive: true });
		mockHandleSynthesisRequest.mockClear();
		mockWriteMemoryMd.mockClear();
		mockAppendSynthesisIndexBlock.mockClear();
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
		if (previousSignetPath === undefined) {
			process.env.SIGNET_PATH = undefined;
		} else {
			process.env.SIGNET_PATH = previousSignetPath;
		}
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

		try {
			const lockToken = worker.acquireWriteLock();
			expect(lockToken).not.toBeNull();
			expect(worker.isSynthesizing).toBe(true);

			const result = await worker.triggerNow();

			expect(result).toEqual({
				success: false,
				skipped: true,
				reason: "Synthesis already in progress",
			});
			expect(mockGenerateWithTracking).not.toHaveBeenCalled();
			if (lockToken === null) {
				throw new Error("expected write lock token");
			}
			worker.releaseWriteLock(lockToken);
		} finally {
			worker.stop();
			expect(await worker.drain()).toBe("completed");
		}
	});

	it("drain waits for an in-flight synthesis to finish after stop", async () => {
		let resolveRun: ((value: { text: string; usage: null }) => void) | null = null;
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
		try {
			await Promise.resolve();

			expect(worker.isSynthesizing).toBe(true);

			let drained = false;
			const drainPromise = worker.drain().then((result) => {
				expect(result).toBe("completed");
				drained = true;
			});

			worker.stop();
			await Promise.resolve();
			expect(drained).toBe(false);

			if (resolveRun === null) {
				throw new Error("run resolver not initialized");
			}
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
			expect(mockWriteMemoryMd).toHaveBeenCalledWith("# Updated memory\n", { owner: "synthesis-worker" });
		} finally {
			worker.stop();
			if (resolveRun !== null) {
				resolveRun({ text: "# Updated memory\n", usage: null });
			}
			await runPromise.catch(() => undefined);
			await worker.drain();
		}
	});

	it("skips manual synthesis after the worker has been stopped", async () => {
		const worker = startSynthesisWorker({
			enabled: true,
			provider: "claude-code",
			model: "sonnet",
			timeout: 1000,
			maxTokens: 8000,
			idleGapMinutes: 15,
		});

		worker.stop();
		const result = await worker.triggerNow();
		expect(await worker.drain()).toBe("completed");

		expect(result).toEqual({
			success: false,
			skipped: true,
			reason: "Synthesis worker stopped",
		});
		expect(mockGenerateWithTracking).not.toHaveBeenCalled();
	});

	it("surfaces MEMORY.md head lease contention as a retryable skip", async () => {
		mockWriteMemoryMd.mockImplementationOnce(() => ({
			ok: false as const,
			error: "MEMORY.md write busy",
			code: "busy" as const,
		}));

		const worker = startSynthesisWorker({
			enabled: true,
			provider: "claude-code",
			model: "sonnet",
			timeout: 1000,
			maxTokens: 8000,
			idleGapMinutes: 15,
		});

		try {
			const result = await worker.triggerNow();
			expect(result).toEqual({
				success: false,
				skipped: true,
				reason: "MEMORY.md head busy",
			});
		} finally {
			worker.stop();
			expect(await worker.drain()).toBe("completed");
		}
	});

	it("drain times out if an in-flight synthesis never resolves", async () => {
		let releaseRun: (() => void) | null = null;
		mockGenerateWithTracking.mockImplementationOnce(() =>
			new Promise<void>((resolve) => {
				releaseRun = resolve;
			}).then(() => ({
				text: "# MEMORY\n",
				usage: null,
			})),
		);

		const worker = startSynthesisWorker({
			enabled: true,
			provider: "claude-code",
			model: "sonnet",
			timeout: 10,
			maxTokens: 8000,
			idleGapMinutes: 15,
		});

		const runPromise = worker.triggerNow();
		await Promise.resolve();
		worker.stop();

		try {
			const drainStart = Date.now();
			const drainResult = await worker.drain();
			const drainElapsed = Date.now() - drainStart;

			expect(drainResult).toBe("timeout");
			expect(drainElapsed).toBeGreaterThanOrEqual(10 + 1000 - 5);
			expect(drainElapsed).toBeLessThan(6000);
			expect(worker.isSynthesizing).toBe(true);
		} finally {
			if (releaseRun !== null) {
				releaseRun();
			}
			await runPromise.catch(() => undefined);
		}
	}, 10_000);
});
