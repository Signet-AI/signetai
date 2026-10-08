import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { acquireEmbeddingRepairLease, finishEmbeddingRepairLease } from "./embedding-repair-state";
import { computeEmbeddingRetryBackoffMs, processEmbeddingCycle, startEmbeddingTracker } from "./embedding-tracker";

const cfg = {
	provider: "ollama",
	model: "mxbai-embed-large",
	dimensions: 1024,
	base_url: "http://localhost:11434",
} as const;

describe("computeEmbeddingRetryBackoffMs", () => {
	it("backs off aggressively for repeated failures", () => {
		expect(computeEmbeddingRetryBackoffMs(1, 1_000)).toBe(60_000);
		expect(computeEmbeddingRetryBackoffMs(2, 1_000)).toBe(5 * 60_000);
		expect(computeEmbeddingRetryBackoffMs(3, 1_000)).toBe(30 * 60_000);
		expect(computeEmbeddingRetryBackoffMs(4, 1_000)).toBe(60 * 60_000);
	});

	it("respects larger poll intervals when they exceed the floor", () => {
		expect(computeEmbeddingRetryBackoffMs(1, 20_000)).toBe(100_000);
		expect(computeEmbeddingRetryBackoffMs(2, 20_000)).toBe(500_000);
	});
});

describe("processEmbeddingCycle", () => {
	it("suppresses repeated attempts across cycles for the same failed payload", async () => {
		const failures = new Map<string, { count: number; retryAt: number }>();
		const rows = [{ id: "mem-1", content: "bad", contentHash: "hash-a", currentModel: null }] as const;
		let calls = 0;

		const fetchEmbeddingFn = async () => {
			calls++;
			return null;
		};

		const first = await processEmbeddingCycle(rows, failures, cfg, 1_000, fetchEmbeddingFn, 1_000);
		const second = await processEmbeddingCycle(rows, failures, cfg, 1_000, fetchEmbeddingFn, 2_000);

		expect(first.failed).toBe(1);
		expect(second.failed).toBe(0);
		expect(second.queueDepth).toBe(0);
		expect(calls).toBe(1);
	});

	it("does not suppress a new content hash for the same memory id", async () => {
		const failures = new Map<string, { count: number; retryAt: number }>();
		const fetchCalls: string[] = [];
		const fetchEmbeddingFn = async (text: string) => {
			fetchCalls.push(text);
			return null;
		};

		await processEmbeddingCycle(
			[{ id: "mem-1", content: "bad-old", contentHash: "hash-old", currentModel: null }],
			failures,
			cfg,
			1_000,
			fetchEmbeddingFn,
			1_000,
		);
		const next = await processEmbeddingCycle(
			[{ id: "mem-1", content: "good-new-shape", contentHash: "hash-new", currentModel: null }],
			failures,
			cfg,
			1_000,
			fetchEmbeddingFn,
			2_000,
		);

		expect(next.queueDepth).toBe(1);
		expect(fetchCalls).toEqual(["bad-old", "good-new-shape"]);
	});

	it("clears suppression on success", async () => {
		const failures = new Map<string, { count: number; retryAt: number }>();
		let ok = false;
		const fetchEmbeddingFn = async () => {
			if (!ok) return null;
			return [0.1, 0.2, 0.3];
		};
		const rows = [{ id: "mem-1", content: "retry-me", contentHash: "hash-a", currentModel: null }] as const;

		await processEmbeddingCycle(rows, failures, cfg, 1_000, fetchEmbeddingFn, 1_000);
		ok = true;
		const retry = await processEmbeddingCycle(rows, failures, cfg, 1_000, fetchEmbeddingFn, 70_000);
		const after = await processEmbeddingCycle(rows, failures, cfg, 1_000, fetchEmbeddingFn, 71_000);

		expect(retry.results).toHaveLength(1);
		expect(after.results).toHaveLength(1);
		expect(after.failed).toBe(0);
	});
});

describe("startEmbeddingTracker admission", () => {
	it("embeds never-embedded memories while the re-embed repair budget is spent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-embedding-tracker-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		const accessor = getDbAccessor();
		const trackerCfg = { enabled: true, pollMs: 20, batchSize: 8 };
		const repairCfg = {
			reembedCooldownMs: 3_600_000,
			reembedHourlyBudget: 1,
			requeueCooldownMs: 0,
			requeueHourlyBudget: 1,
			dedupCooldownMs: 0,
			dedupHourlyBudget: 1,
			dedupSemanticThreshold: 0.9,
			dedupBatchSize: 1,
		};
		const now = new Date().toISOString();
		accessor.withWriteTx((db) => {
			const insert = db.prepare(
				`INSERT INTO memories (id, content, content_hash, type, agent_id, created_at, updated_at, embedding_model)
				 VALUES (?, ?, ?, 'fact', 'default', ?, ?, ?)`,
			);
			insert.run("fresh-a", "A fresh derived memory.", "hash-fresh-a", now, now, null);
			insert.run("fresh-b", "Another fresh derived memory.", "hash-fresh-b", now, now, null);
			insert.run("stale-model", "A memory embedded by an older model.", "hash-stale", now, now, "older-model");
		});
		const spent = await acquireEmbeddingRepairLease(accessor, 0, 1);
		if (!spent.allowed || spent.lease === undefined) throw new Error("expected a repair lease");
		await finishEmbeddingRepairLease(accessor, spent.lease, {
			successful: [{ id: "earlier", contentHash: "earlier" }],
			failed: [],
			model: "nomic-embed-text",
			pollMs: 20,
			eligibility: true,
		});
		const embedded: string[] = [];
		const activeCfg = {
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 768,
		} as const;
		const tracker = startEmbeddingTracker(
			accessor,
			activeCfg,
			trackerCfg,
			repairCfg,
			async (text) => {
				embedded.push(text);
				return Array.from({ length: activeCfg.dimensions }, () => 0.01);
			},
			async () => ({ available: true }),
		);
		try {
			const deadline = Date.now() + 5_000;
			while (embedded.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect([...embedded].sort()).toEqual(["A fresh derived memory.", "Another fresh derived memory."]);
			expect(
				accessor.withReadDb(
					(db) =>
						db.prepare("SELECT batches_started AS n FROM embedding_repair_budget WHERE id = 1").get() as { n: number },
				),
			).toEqual({ n: 1 });
		} finally {
			await tracker.stop();
			closeDbAccessor();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("backs off instead of embedding every poll while the profile does not match the active index", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-embedding-tracker-mismatch-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		const accessor = getDbAccessor();
		const trackerCfg = { enabled: true, pollMs: 20, batchSize: 8 };
		const repairCfg = {
			reembedCooldownMs: 0,
			reembedHourlyBudget: 100,
			requeueCooldownMs: 0,
			requeueHourlyBudget: 1,
			dedupCooldownMs: 0,
			dedupHourlyBudget: 1,
			dedupSemanticThreshold: 0.9,
			dedupBatchSize: 1,
		};
		const now = new Date().toISOString();
		accessor.withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (id, content, content_hash, type, agent_id, created_at, updated_at, embedding_model)
				 VALUES (?, ?, ?, 'fact', 'default', ?, ?, NULL)`,
			).run("fresh-a", "A fresh derived memory.", "hash-fresh-a", now, now);
		});
		let fetches = 0;
		let probes = 0;
		const tracker = startEmbeddingTracker(
			accessor,
			cfg,
			trackerCfg,
			repairCfg,
			async () => {
				fetches++;
				return Array.from({ length: cfg.dimensions }, () => 0.01);
			},
			async () => {
				probes++;
				return { available: true };
			},
		);
		try {
			const deadline = Date.now() + 2_000;
			while (tracker.getStats().skippedCycles < 5 && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			expect(fetches).toBe(0);
			expect(probes).toBe(0);
			expect(tracker.getStats().skippedCycles).toBeGreaterThanOrEqual(5);
			expect(
				accessor.withReadDb(
					(db) =>
						db.prepare("SELECT embedding_model FROM memories WHERE id = 'fresh-a'").get() as {
							embedding_model: string | null;
						},
				),
			).toEqual({ embedding_model: null });
		} finally {
			await tracker.stop();
			closeDbAccessor();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("drains a backlog of first-time embeddings without waiting a poll interval between full batches", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-embedding-tracker-drain-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		const accessor = getDbAccessor();
		const trackerCfg = { enabled: true, pollMs: 2_000, batchSize: 2 };
		const repairCfg = {
			reembedCooldownMs: 3_600_000,
			reembedHourlyBudget: 1,
			requeueCooldownMs: 0,
			requeueHourlyBudget: 1,
			dedupCooldownMs: 0,
			dedupHourlyBudget: 1,
			dedupSemanticThreshold: 0.9,
			dedupBatchSize: 1,
		};
		const now = new Date().toISOString();
		accessor.withWriteTx((db) => {
			const insert = db.prepare(
				`INSERT INTO memories (id, content, content_hash, type, agent_id, created_at, updated_at, embedding_model)
				 VALUES (?, ?, ?, 'fact', 'default', ?, ?, NULL)`,
			);
			for (let index = 0; index < 7; index++)
				insert.run(`fresh-${index}`, `Fresh memory ${index}.`, `hash-${index}`, now, now);
		});
		const activeCfg = {
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 768,
		} as const;
		const embedded: string[] = [];
		const startedAt = Date.now();
		const tracker = startEmbeddingTracker(
			accessor,
			activeCfg,
			trackerCfg,
			repairCfg,
			async (text) => {
				embedded.push(text);
				return Array.from({ length: activeCfg.dimensions }, () => 0.01);
			},
			async () => ({ available: true }),
		);
		try {
			const deadline = startedAt + 10_000;
			while (embedded.length < 7 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
			expect(embedded).toHaveLength(7);
			expect(Date.now() - startedAt).toBeLessThan(3_500);
		} finally {
			await tracker.stop();
			closeDbAccessor();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15_000);
});
