import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { cleanupTestTempDir, createTestTempDir } from "./test-temp-dir";

let app: Hono;
let dir = "";
let prev: string | undefined;
let countConnectorsActive: (connectors: readonly { readonly status: string }[]) => number;
const originalSpawn = Bun.spawn;
const originalWhich = Bun.which;

function streamFromString(value: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(value));
			controller.close();
		},
	});
}

describe("daemon status contract", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = createTestTempDir("signet-daemon-status-");
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: true
`,
		);
		process.env.SIGNET_PATH = dir;

		const daemon = await import("./daemon");
		const { initDbAccessor } = await import("./db-accessor");
		const state = await import("./routes/state.js");
		initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
		state.reloadAuthState(dir);
		app = daemon.app;
		countConnectorsActive = daemon.countConnectorsActive;
	});

	afterAll(async () => {
		try {
			const { closeDbAccessor } = await import("./db-accessor");
			const daemon = await import("./daemon");
			await daemon.stopDaemonRuntimeForTests();
			closeDbAccessor();
		} catch {}
		if (prev === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		}
		if (prev !== undefined) process.env.SIGNET_PATH = prev;
		cleanupTestTempDir(dir);
	});

	afterEach(async () => {
		Bun.spawn = originalSpawn;
		Bun.which = originalWhich;
		const provider = await import("./pipeline/provider");
		provider.configureLlmConcurrency(2);
	});

	it("exposes process memory metrics on /api/status", async () => {
		const res = await app.request("http://localhost/api/status");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			resources?: {
				rss?: unknown;
				heapUsed?: unknown;
				physicalFootprint?: unknown;
				peakPhysicalFootprint?: unknown;
			};
		};
		expect(typeof body.resources?.rss).toBe("number");
		expect(typeof body.resources?.heapUsed).toBe("number");
		expect(body.resources?.physicalFootprint === null || typeof body.resources?.physicalFootprint === "number").toBe(
			true,
		);
		expect(
			body.resources?.peakPhysicalFootprint === null || typeof body.resources?.peakPhysicalFootprint === "number",
		).toBe(true);
	});

	it("exposes providerResolution.extraction runtime fields on /api/status", async () => {
		const res = await app.request("http://localhost/api/status");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providerResolution?: {
				extraction?: {
					configured?: unknown;
					resolved?: unknown;
					effective?: unknown;
					fallbackProvider?: unknown;
					status?: unknown;
					degraded?: unknown;
					fallbackApplied?: unknown;
					reason?: unknown;
					since?: unknown;
				};
			};
		};
		const extraction = body.providerResolution?.extraction;
		expect(extraction).toBeDefined();
		expect(typeof extraction?.resolved).toBe("string");
		expect(typeof extraction?.effective).toBe("string");
		// fallbackProvider must always be present as a string. #949 dropped this field
		// from the status object (it was sourcing from the retired flat config field),
		// which made `signet status` print "fallback: unknown". The type was widened
		// from the narrow "llama-cpp"|"ollama"|"none" enum to RuntimeProviderName
		// because the routing registry's fallbackTargetRefs can resolve to any
		// executor. Asserting presence + string type is the real regression guard.
		expect(typeof extraction?.fallbackProvider).toBe("string");
		expect(
			extraction?.status === "active" ||
				extraction?.status === "degraded" ||
				extraction?.status === "blocked" ||
				extraction?.status === "disabled" ||
				extraction?.status === "paused",
		).toBe(true);
		expect(typeof extraction?.degraded).toBe("boolean");
		expect(typeof extraction?.fallbackApplied).toBe("boolean");
		expect(extraction).toHaveProperty("reason");
		expect(extraction).toHaveProperty("since");
	});

	it("reports extraction as permanently disabled under the Dreaming cutover", async () => {
		const originalOpenAiKey = process.env.OPENAI_API_KEY;
		Reflect.deleteProperty(process.env, "OPENAI_API_KEY");

		try {
			const { closeDbAccessor, initDbAccessor } = await import("./db-accessor");
			const { loadMemoryConfig } = await import("./memory-config");
			const state = await import("./routes/state.js");
			closeDbAccessor();
			initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    enabled: true
    extraction:
      provider: ollama
      model: qwen3:4b
    synthesis:
      enabled: false
`,
			);
			expect(state.restartPipelineRuntimeRef).toBeDefined();
			await state.restartPipelineRuntimeRef?.(loadMemoryConfig(dir));

			const res = await app.request("http://localhost/api/status");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				providerResolution?: {
					extraction?: {
						effective?: unknown;
						status?: unknown;
						reason?: unknown;
					};
				};
			};
			// Dreaming owns all semantic writes; legacy extraction is permanently retired.
			expect(body.providerResolution?.extraction?.effective).toBe("none");
			expect(body.providerResolution?.extraction?.status).toBe("disabled");
			expect(body.providerResolution?.extraction?.reason).toBe("Dreaming owns semantic writes");
		} finally {
			if (originalOpenAiKey === undefined) {
				Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
			} else {
				process.env.OPENAI_API_KEY = originalOpenAiKey;
			}
		}
	});

	it("keeps legacy extraction permanently disabled under the semantic cutover", async () => {
		const { closeDbAccessor, initDbAccessor } = await import("./db-accessor");
		const { loadMemoryConfig } = await import("./memory-config");
		const { getLlmConcurrencyStatus } = await import("./pipeline/provider");
		const state = await import("./routes/state.js");
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: true
    extraction:
      provider: ollama
      model: qwen3:4b
    worker:
      maxLlmConcurrency: 1
`,
		);

		expect(state.restartPipelineRuntimeRef).toBeDefined();
		await state.restartPipelineRuntimeRef?.(loadMemoryConfig(dir));
		const res = await app.request("http://localhost/api/status");
		const body = (await res.json()) as {
			providerResolution?: {
				extraction?: {
					configured?: unknown;
					resolved?: unknown;
					effective?: unknown;
					status?: unknown;
					enabled?: unknown;
					paused?: unknown;
					workerRunning?: unknown;
					ready?: unknown;
					blockedReason?: unknown;
				};
			};
		};
		expect(res.status).toBe(200);
		expect(body.providerResolution?.extraction).toMatchObject({
			status: "disabled",
			effective: "none",
			enabled: false,
			paused: false,
			workerRunning: false,
			ready: false,
			blockedReason: null,
		});

		expect(getLlmConcurrencyStatus().limit).toBe(1);
	});

	it("counts non-errored connectors as active for heartbeat telemetry", () => {
		expect(countConnectorsActive([{ status: "idle" }, { status: "syncing" }, { status: "error" }])).toBe(2);
	});
});

describe("legacy extraction cutover sweep (#946)", () => {
	const DREAMING_ENABLED_CONFIG = `memory:
  pipelineV2:
    enabled: true
    extraction:
      provider: ollama
      model: qwen3:4b
`;

	function writeConfig(cfg: string): void {
		writeFileSync(join(dir, "agent.yaml"), cfg);
	}

	async function restartRuntime(cfg: string): Promise<void> {
		const { loadMemoryConfig } = await import("./memory-config");
		const state = await import("./routes/state.js");
		writeConfig(cfg);
		expect(state.restartPipelineRuntimeRef).toBeDefined();
		await state.restartPipelineRuntimeRef?.(loadMemoryConfig(dir));
	}

	function seedMemory(memoryId: string): void {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO memories (id, content, source_type, extraction_status, memory_kind, agent_id, created_at, updated_at) VALUES (?, ?, 'manual', 'queued', 'episodic', 'default', ?, ?)",
			).run(memoryId, `seed ${memoryId}`, now, now);
		});
	}

	function seedPendingLegacyJob(memoryId: string, jobId: string): void {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		const now = new Date().toISOString();
		seedMemory(memoryId);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_jobs
				 (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
				 VALUES (?, ?, 'extract', 'pending', 0, 3, ?, ?)`,
			).run(jobId, memoryId, now, now);
		});
	}

	function seedLeasedLegacyJob(memoryId: string, jobId: string): void {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		const now = new Date().toISOString();
		seedMemory(memoryId);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_jobs
				 (id, memory_id, job_type, status, attempts, max_attempts, leased_at, created_at, updated_at)
				 VALUES (?, ?, 'extract', 'leased', 0, 3, ?, ?, ?)`,
			).run(jobId, memoryId, now, now, now);
		});
	}

	function getJob(jobId: string): { status: string; error: string | null } {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		return getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT status, error FROM memory_jobs WHERE id = ?").get(jobId) as {
					status: string;
					error: string | null;
				},
		);
	}

	function getMemoryStatus(memoryId: string): string {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		return getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT extraction_status FROM memories WHERE id = ?").get(memoryId) as {
					extraction_status: string;
				},
		).extraction_status;
	}

	function getMemoryKind(memoryId: string): string | null {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		return getDbAccessor().withReadDb(
			(db) =>
				(db.prepare("SELECT memory_kind FROM memories WHERE id = ?").get(memoryId) as { memory_kind: string | null })
					.memory_kind,
		);
	}

	function countMemoryJobs(): number {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		return getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) as cnt FROM memory_jobs").get() as { cnt: number },
		).cnt;
	}

	beforeEach(async () => {
		// Re-init a clean DB so each assertion sees only its own seed rows.
		const { closeDbAccessor, initDbAccessor } = await import("./db-accessor");
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
	});

	it("retires pre-existing pending legacy extract jobs on startup", async () => {
		seedPendingLegacyJob("mem-cutover", "job-cutover");

		// Startup sweeps the pending backlog because Dreaming always owns semantic writes.
		await restartRuntime(DREAMING_ENABLED_CONFIG);

		const job = getJob("job-cutover");
		expect(job.status).toBe("dead");
		expect(job.error).toBe("Dreaming cutover: legacy extraction worker not started");
		expect(getMemoryStatus("mem-cutover")).toBe("retired");
		expect(getMemoryKind("mem-cutover")).toBe("episodic");
	});

	it("terminalizes leased legacy extract jobs during the sweep", async () => {
		seedPendingLegacyJob("mem-pend", "job-pend");
		seedLeasedLegacyJob("mem-leased", "job-leased");

		await restartRuntime(DREAMING_ENABLED_CONFIG);

		const pendingJob = getJob("job-pend");
		expect(pendingJob.status).toBe("dead");
		const leasedJob = getJob("job-leased");
		expect(leasedJob.status).toBe("dead");
		expect(getMemoryStatus("mem-leased")).toBe("retired");
		expect(getMemoryKind("mem-leased")).toBe("episodic");
	});

	it("is idempotent across repeated Dreaming restarts", async () => {
		seedPendingLegacyJob("mem-idem", "job-idem");
		await restartRuntime(DREAMING_ENABLED_CONFIG);
		const afterFirst = countMemoryJobs();
		expect(getJob("job-idem").status).toBe("dead");

		// A second restart must not duplicate, delete, or re-mutate rows.
		await restartRuntime(DREAMING_ENABLED_CONFIG);
		expect(countMemoryJobs()).toBe(afterFirst);
		const job = getJob("job-idem");
		expect(job.status).toBe("dead");
		expect(job.error).toBe("Dreaming cutover: legacy extraction worker not started");
	});
});

// ---------------------------------------------------------------------------
// Structural worker retirement (#946)
//
// When Dreaming owns semantic writes, the legacy structural classify and
// structural dependency workers are not started and their status shape is
// retired from /api/status. No producer may create pending structural jobs.
// ---------------------------------------------------------------------------
describe("structural worker retirement under Dreaming (#946)", () => {
	const DREAMING_ENABLED_STRUCTURAL_CONFIG = `memory:
  pipelineV2:
    enabled: true
    extraction:
      provider: ollama
      model: qwen3:4b
    graph:
      enabled: true
    structural:
      enabled: true
`;

	function writeConfig(cfg: string): void {
		writeFileSync(join(dir, "agent.yaml"), cfg);
	}

	async function restartRuntime(cfg: string): Promise<void> {
		const { loadMemoryConfig } = await import("./memory-config");
		const state = await import("./routes/state.js");
		writeConfig(cfg);
		expect(state.restartPipelineRuntimeRef).toBeDefined();
		await state.restartPipelineRuntimeRef?.(loadMemoryConfig(dir));
	}

	function seedPendingStructuralJob(memoryId: string, jobId: string, jobType: string): void {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO memories (id, content, extraction_status, agent_id, created_at, updated_at) VALUES (?, ?, 'complete', 'default', ?, ?)",
			).run(memoryId, `seed ${memoryId}`, now, now);
			db.prepare(
				`INSERT INTO memory_jobs
				 (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
				 VALUES (?, ?, ?, 'pending', 0, 3, ?, ?)`,
			).run(jobId, memoryId, jobType, now, now);
		});
	}

	function countStructuralJobs(): number {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		return getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT COUNT(*) as cnt FROM memory_jobs WHERE job_type IN ('structural_classify','structural_dependency')",
					)
					.get() as { cnt: number },
		).cnt;
	}

	beforeEach(async () => {
		const { closeDbAccessor, initDbAccessor } = await import("./db-accessor");
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
	});

	beforeAll(() => {
		// The earlier describe block's afterAll restores SIGNET_PATH to its
		// pre-test value, so re-pin it to this suite's temp dir here.
		if (process.env.SIGNET_PATH !== dir) process.env.SIGNET_PATH = dir;
	});

	afterAll(() => {
		// Restore whatever the daemon process held before this suite; the
		// top-level suite's afterAll handles the canonical restore.
		if (prev === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = prev;
	});

	it("does not expose legacy structural workers in the status shape and never starts them", async () => {
		// structural.enabled AND graph.enabled would have started both structural
		// workers under the legacy pipeline; under Dreaming they must be absent.
		await restartRuntime(DREAMING_ENABLED_STRUCTURAL_CONFIG);

		const res = await app.request("http://localhost/api/pipeline/status");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			workers?: Record<string, { running?: boolean }>;
		};
		const workers = body.workers ?? {};
		expect(workers).not.toHaveProperty("structuralClassify");
		expect(workers).not.toHaveProperty("structuralDependency");
		// The cross-entity dependency-synthesis worker was retired under the
		// full Dreaming cutover (#946): it wrote dependencies directly via
		// upsertDependency, bypassing the audited create_link path. Dreaming
		// is now the sole semantic dependency writer.
		expect(workers).not.toHaveProperty("dependencySynthesis");
		// Preserved non-semantic workers remain present.
		expect(workers).toHaveProperty("document");
		expect(workers).toHaveProperty("retention");
		expect(workers).toHaveProperty("maintenance");
		expect(workers).toHaveProperty("synthesis");
		expect(workers).toHaveProperty("hints");
		expect(workers).toHaveProperty("dreaming");
	});

	it("does not accumulate new pending structural jobs from pre-existing rows under Dreaming", async () => {
		// A pre-existing pending structural job (left from before the cutover)
		// should remain, but the runtime must not create additional pending
		// structural jobs while Dreaming owns semantic writes.
		await restartRuntime(DREAMING_ENABLED_STRUCTURAL_CONFIG);
		seedPendingStructuralJob("mem-pre", "job-struct-pre", "structural_classify");
		const before = countStructuralJobs();
		expect(before).toBe(1);

		await restartRuntime(DREAMING_ENABLED_STRUCTURAL_CONFIG);
		expect(countStructuralJobs()).toBe(before);
	});

	it("does not start the dependency-synthesis worker and cannot produce direct dependency writes under Dreaming", async () => {
		// The retired dependency-synthesis worker polled for entities whose
		// last_synthesized_at lagged updated_at, called an LLM, and wrote
		// entity_dependencies rows directly via upsertDependency — bypassing
		// the audited create_link path. Under the full Dreaming cutover the
		// worker must never start, so seeding stale entities must produce no
		// dependency rows and never set last_synthesized_at.
		await restartRuntime(DREAMING_ENABLED_STRUCTURAL_CONFIG);

		// Seed a stale entity with facts and candidate mentions — exactly the
		// inputs the retired worker would have picked up on its next tick.
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		getDbAccessor().withWriteTx((db) => {
			const now = new Date().toISOString();
			const stale = new Date(Date.now() - 3_600_000).toISOString();
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at, last_synthesized_at)
				 VALUES ('dep-src', 'dep source', 'dep source', 'system', 'default', 1, ?, ?, NULL)`,
			).run(now, stale);
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('dep-target', 'dep target', 'dep target', 'system', 'default', 9, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('asp-dep', 'dep-src', 'default', 'general', 'general', 0.5, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
				 VALUES ('attr-dep', 'asp-dep', 'default', 'fact', 'dep source uses dep target', 'dep source uses dep target', 0.9, 0.5, 'active', ?, ?)`,
			).run(now, now);
		});

		// Restart again so any worker that *did* start would observe the stale
		// entity on its first tick, then wait well past a default poll cycle.
		await restartRuntime(DREAMING_ENABLED_STRUCTURAL_CONFIG);
		await new Promise((resolve) => setTimeout(resolve, 1500));

		const res = await app.request("http://localhost/api/pipeline/status");
		const body = (await res.json()) as { workers?: Record<string, unknown> };
		expect(body.workers ?? {}).not.toHaveProperty("dependencySynthesis");

		const { getDbAccessor: getAccessor2 } = require("./db-accessor") as typeof import("./db-accessor");
		const deps = getAccessor2().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) as cnt FROM entity_dependencies").get() as { cnt: number },
		);
		expect(deps.cnt).toBe(0);

		const synthesized = getAccessor2().withReadDb(
			(db) =>
				db.prepare("SELECT last_synthesized_at FROM entities WHERE id = 'dep-src'").get() as {
					last_synthesized_at: string | null;
				},
		);
		// The retired worker's exclusive side-effect (markSynthesized) must
		// never fire — proving no dependency-synthesis tick ran.
		expect(synthesized.last_synthesized_at).toBeNull();
	});
});
