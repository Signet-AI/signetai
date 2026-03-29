import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let agentsDir = "";
let previousSignetPath: string | undefined;

const mockHandleSynthesisRequest = mock(
	(_req?: { readonly trigger?: string }, opts?: { readonly agentId?: string }) => ({
		harness: "daemon",
		model: "projection",
		prompt: `# MEMORY\n\nprojection for ${opts?.agentId ?? "default"}`,
		fileCount: 1,
		indexBlock: "",
	}),
);
const mockWriteMemoryMd = mock((_content: string, _opts?: { owner?: string }) => ({ ok: true as const }));
const mockActiveSessionCount = mock(() => 0);

mock.module("../hooks", () => ({
	handleSynthesisRequest: mockHandleSynthesisRequest,
	writeMemoryMd: mockWriteMemoryMd,
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
		mockActiveSessionCount.mockClear();
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
			expect(mockHandleSynthesisRequest).not.toHaveBeenCalled();
			if (lockToken === null) {
				throw new Error("expected write lock token");
			}
			worker.releaseWriteLock(lockToken);
		} finally {
			worker.stop();
			expect(await worker.drain()).toBe("completed");
		}
	});

	it("writes the rendered projection through the shared MEMORY.md helper", async () => {
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
				success: true,
				skipped: false,
				reason: undefined,
			});
			expect(worker.isSynthesizing).toBe(false);
			expect(mockWriteMemoryMd).toHaveBeenCalledWith("# MEMORY\n\nprojection for default", {
				owner: "synthesis-worker",
			});
		} finally {
			worker.stop();
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
		expect(mockHandleSynthesisRequest).not.toHaveBeenCalled();
	});

	it("skips non-forced manual synthesis when the last run was too recent", async () => {
		mkdirSync(join(agentsDir, ".daemon"), { recursive: true });
		writeFileSync(
			join(agentsDir, ".daemon", "last-synthesis.json"),
			JSON.stringify({ lastRunAt: Date.now() - 5 * 60 * 1000 }),
		);

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
				reason: "Too recent — last run 5m ago, minimum is 60m",
			});
			expect(mockHandleSynthesisRequest).not.toHaveBeenCalled();
		} finally {
			worker.stop();
			expect(await worker.drain()).toBe("completed");
		}
	});

	it("does not apply default-agent cooldown to a different agent scope", async () => {
		mkdirSync(join(agentsDir, ".daemon"), { recursive: true });
		writeFileSync(join(agentsDir, ".daemon", "last-synthesis.json"), JSON.stringify({ lastRunAt: Date.now() }));

		const worker = startSynthesisWorker({
			enabled: true,
			provider: "claude-code",
			model: "sonnet",
			timeout: 1000,
			maxTokens: 8000,
			idleGapMinutes: 15,
		});

		try {
			const result = await worker.triggerNow({ agentId: "agent-b" });
			expect(result).toEqual({
				success: true,
				skipped: false,
				reason: undefined,
			});
		} finally {
			worker.stop();
			expect(await worker.drain()).toBe("completed");
		}
	});

	it("allows forced manual synthesis even when the last run was too recent", async () => {
		mkdirSync(join(agentsDir, ".daemon"), { recursive: true });
		writeFileSync(
			join(agentsDir, ".daemon", "last-synthesis.json"),
			JSON.stringify({ lastRunAt: Date.now() - 5 * 60 * 1000 }),
		);

		const worker = startSynthesisWorker({
			enabled: true,
			provider: "claude-code",
			model: "sonnet",
			timeout: 1000,
			maxTokens: 8000,
			idleGapMinutes: 15,
		});

		try {
			const result = await worker.triggerNow({ force: true, source: "session-summary" });
			expect(result).toEqual({
				success: true,
				skipped: false,
				reason: undefined,
			});
			expect(mockHandleSynthesisRequest).toHaveBeenCalledTimes(1);
			expect(mockWriteMemoryMd).toHaveBeenCalledWith("# MEMORY\n\nprojection for default", {
				owner: "synthesis-worker",
			});
		} finally {
			worker.stop();
			expect(await worker.drain()).toBe("completed");
		}
	});

	it("threads agent scope into forced synthesis requests", async () => {
		const worker = startSynthesisWorker({
			enabled: true,
			provider: "claude-code",
			model: "sonnet",
			timeout: 1000,
			maxTokens: 8000,
			idleGapMinutes: 15,
		});

		try {
			await worker.triggerNow({
				force: true,
				source: "session-summary",
				agentId: "agent-a",
			});
			expect(mockHandleSynthesisRequest).toHaveBeenCalledWith(
				expect.objectContaining({
					trigger: "scheduled",
				}),
				expect.objectContaining({
					agentId: "agent-a",
				}),
			);
		} finally {
			worker.stop();
			expect(await worker.drain()).toBe("completed");
		}
	});

	it("queues forced trigger when synthesis is already in progress", async () => {
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

			const result = await worker.triggerNow({ force: true, source: "session-summary" });
			expect(result).toEqual({
				success: false,
				skipped: true,
				reason: "Synthesis already in progress (queued forced retry)",
			});
			expect(mockHandleSynthesisRequest).not.toHaveBeenCalled();
			if (lockToken === null) {
				throw new Error("expected write lock token");
			}
			worker.releaseWriteLock(lockToken);
		} finally {
			worker.stop();
			expect(await worker.drain()).toBe("completed");
		}
	});

	it("keeps separate forced retry entries for different agents", async () => {
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

			const first = await worker.triggerNow({ force: true, source: "session-summary", agentId: "agent-a" });
			const second = await worker.triggerNow({ force: true, source: "compaction-complete", agentId: "agent-b" });
			expect(first.skipped).toBe(true);
			expect(second.skipped).toBe(true);
			expect(worker.pendingForceCount).toBe(2);

			if (lockToken === null) {
				throw new Error("expected write lock token");
			}
			worker.releaseWriteLock(lockToken);
		} finally {
			worker.stop();
			expect(await worker.drain()).toBe("completed");
		}
	});

	it("keeps follow-up forced retry signals for the same agent", async () => {
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

			await worker.triggerNow({ force: true, source: "session-summary", agentId: "agent-a" });
			await worker.triggerNow({ force: true, source: "compaction-complete", agentId: "agent-a" });
			expect(worker.pendingForceCount).toBe(2);

			if (lockToken === null) {
				throw new Error("expected write lock token");
			}
			worker.releaseWriteLock(lockToken);
		} finally {
			worker.stop();
			expect(await worker.drain()).toBe("completed");
		}
	});

	it("does not starve later agents when an earlier forced retry keeps returning busy", async () => {
		let current = "default";
		const seen: string[] = [];
		mockHandleSynthesisRequest.mockImplementation(
			(_req?: { readonly trigger?: string }, opts?: { readonly agentId?: string }) => {
				current = opts?.agentId ?? "default";
				seen.push(current);
				return {
					harness: "daemon",
					model: "projection",
					prompt: `# MEMORY\n\nprojection for ${current}`,
					fileCount: 1,
					indexBlock: "",
				};
			},
		);
		mockWriteMemoryMd.mockImplementation(() =>
			current === "agent-a"
				? {
						ok: false as const,
						error: "MEMORY.md write busy",
						code: "busy" as const,
					}
				: { ok: true as const },
		);

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

			await worker.triggerNow({ force: true, source: "session-summary", agentId: "agent-a" });
			await worker.triggerNow({ force: true, source: "compaction-complete", agentId: "agent-b" });

			if (lockToken === null) {
				throw new Error("expected write lock token");
			}
			worker.releaseWriteLock(lockToken);

			const deadline = Date.now() + 12_500;
			while (Date.now() < deadline) {
				if (seen.includes("agent-b")) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			expect(seen).toContain("agent-b");
		} finally {
			worker.stop();
			expect(await worker.drain()).toBe("completed");
		}
	}, 20_000);

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

	it("queues forced retry when MEMORY.md head is busy", async () => {
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
			const result = await worker.triggerNow({ force: true, source: "compaction-complete" });
			expect(result).toEqual({
				success: false,
				skipped: true,
				reason: "MEMORY.md head busy (queued forced retry)",
			});
		} finally {
			worker.stop();
			expect(await worker.drain()).toBe("completed");
		}
	});
});
