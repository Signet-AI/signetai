import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ProjectionAdmissionError,
	ProjectionJobManager,
	ProjectionWorkerCancelledError,
	ProjectionWorkerTimeoutError,
	type ProjectionClock,
	runBoundedProjectionJob,
	runProjectionWorker,
} from "./embedding-projection-jobs";
import type { ProjectionWorkerInput } from "./embedding-projection-worker";
import type { ProjectionResult } from "./umap-projection";
import {
	PROJECTION_MAX_ROWS,
	projectionRequestKey,
	type ProjectionPrincipal,
	type ProjectionRequest,
} from "./embedding-projection-contract";

function fakeProjectionClock(): ProjectionClock & { advance: (ms: number) => void } {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
	return {
		now: () => now,
		setTimeout: (callback, delay) => {
			const id = nextId++;
			timers.set(id, { at: now + delay, callback });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: (timer) => {
			timers.delete(timer as unknown as number);
		},
		advance: (ms) => {
			now += ms;
			for (;;) {
				const due = [...timers.entries()].find(([, timer]) => timer.at <= now);
				if (due === undefined) return;
				timers.delete(due[0]);
				due[1].callback();
			}
		},
	};
}

function vectorHex(values: readonly number[]): string {
	return Buffer.from(new Float32Array(values).buffer).toString("hex");
}

function input(): ProjectionWorkerInput {
	return {
		dimensions: 2,
		rows: [
			{
				id: "one",
				content: "one",
				who: null,
				importance: null,
				type: null,
				tags: null,
				pinned: null,
				source_type: "memory",
				source_id: "one",
				created_at: "2026-01-01T00:00:00.000Z",
				vectorHex: vectorHex([1, 0, 0]),
				dimensions: 3,
			},
			{
				id: "two",
				content: "two",
				who: null,
				importance: null,
				type: null,
				tags: null,
				pinned: null,
				source_type: "memory",
				source_id: "two",
				created_at: "2026-01-02T00:00:00.000Z",
				vectorHex: vectorHex([0, 1, 0]),
				dimensions: 3,
			},
		],
	};
}

const handles: Array<ReturnType<typeof runProjectionWorker>> = [];

afterEach(() => {
	for (const handle of handles) handle.cancel();
	handles.length = 0;
});

describe("embedding projection worker boundary", () => {
	test("protects the projection route with recall permission", () => {
		const source = readFileSync(join(import.meta.dir, "routes/memory-routes.ts"), "utf8");
		const jobs = readFileSync(join(import.meta.dir, "embedding-projection-jobs.ts"), "utf8");
		const snapshot = readFileSync(join(import.meta.dir, "embedding-projection-snapshot.ts"), "utf8");
		const contract = readFileSync(join(import.meta.dir, "embedding-projection-contract.ts"), "utf8");
		const owner = readFileSync(join(import.meta.dir, "db-owner-worker.ts"), "utf8");
		expect(source).toContain('app.use("/api/embeddings", async (c, next) =>');
		expect(source).toContain('requirePermission("recall", authConfig)(c, next)');
		const embeddingsGuardStart = source.indexOf('app.use("/api/embeddings",');
		const embeddingsGuard = source.slice(embeddingsGuardStart, source.indexOf("\n\n", embeddingsGuardStart));
		expect(embeddingsGuard).toContain('requirePermission("recall", authConfig)(c, next)');
		const projectionStart = source.indexOf('app.get("/api/embeddings/projection",');
		const projectionRoute = source.slice(projectionStart, source.indexOf("// POST /api/documents", projectionStart));
		expect(source).toContain("resolveProjectionPrincipal");
		expect(projectionRoute).toContain("projectionRequestKey(principal, request)");
		expect(projectionRoute).toContain('kind: "embedding_projection_snapshot"');
		expect(projectionRoute).toContain("createDbOwnerClient");
		expect(projectionRoute).toContain("runBoundedProjectionJob(");
		expect(jobs).toContain("child = spawn(");
		expect(source).toContain('app.get("/api/embeddings/health"');
		expect(source).toContain('app.use("/api/memory/recall"');
		for (const status of ["accepted", "running", "ready", "timeout", "cancelled", "error", "overloaded"]) {
			expect(`${source}\n${jobs}`).toContain(`status: "${status}"`);
		}
		expect(projectionRoute).not.toContain("umap_cache");
		expect(projectionRoute).not.toContain("runWriteTxAsync");
		const cancellationRoute = source.slice(
			source.indexOf('app.delete("/api/embeddings/projection/:jobId"'),
			projectionStart,
		);
		expect(cancellationRoute).toContain('projectionJobs.cancel(c.req.param("jobId"), principalResult.principal)');
		expect(cancellationRoute).toContain("}, 200);");
		expect(cancellationRoute).toContain("projectionJobResponse(job)");
		expect(contract).toContain("m.agent_id");
		expect(contract).toContain("m.visibility != 'archived'");
		expect(contract).toContain("m.stale_at IS NULL");
		expect(snapshot).toContain("ORDER BY m.created_at DESC, m.id DESC");
		expect(snapshot).toContain("substr(e.vector, 1,");
		expect(snapshot).toContain("PROJECTION_SNAPSHOT_MAX_BYTES");
		expect(owner).toContain('job.request.kind === "embedding_projection_snapshot"');
		expect(owner).toContain('db.exec("BEGIN")');
	});

	test("runs projection in the worker process and returns a bounded result", async () => {
		const handle = runProjectionWorker(input(), { timeoutMs: 2_000 });
		handles.push(handle);
		const result = await handle.result;
		expect(result.nodes).toHaveLength(2);
		expect(result.edges).toEqual([[0, 1]]);
	});

	test("keeps the parent event loop responsive while the worker is held", async () => {
		let parentTurnObserved = false;
		const parentTurn = new Promise<void>((resolve) => {
			setImmediate(() => {
				parentTurnObserved = true;
				resolve();
			});
		});
		const handle = runProjectionWorker(input(), { holdForTests: true, timeoutMs: 2_000 });
		handles.push(handle);
		await parentTurn;
		expect(parentTurnObserved).toBe(true);
		handle.cancel();
		await expect(handle.result).rejects.toBeInstanceOf(ProjectionWorkerCancelledError);
	});

	test("keeps health and ordinary recall turns available while projection is active", async () => {
		const handle = runProjectionWorker(input(), { holdForTests: true, timeoutMs: 2_000 });
		handles.push(handle);
		const healthTurn = new Promise<string>((resolve) => setImmediate(() => resolve("health")));
		const recallTurn = new Promise<string>((resolve) => setImmediate(() => resolve("recall")));
		expect(await healthTurn).toBe("health");
		expect(await recallTurn).toBe("recall");
		handle.cancel();
		await expect(handle.result).rejects.toBeInstanceOf(ProjectionWorkerCancelledError);
	});

	test("keeps a 1,000-row projection within the event-loop lag contract", async () => {
		const seed = input().rows;
		const largeInput: ProjectionWorkerInput = {
			dimensions: 2,
			rows: Array.from({ length: PROJECTION_MAX_ROWS }, (_, index) => ({
				...seed[index % seed.length],
				id: `row-${index}`,
				source_id: `row-${index}`,
			})),
		};
		let spawned = 0;
		let workerPid: number | undefined;
		const parentTurn = new Promise<void>((resolve) => setImmediate(resolve));
		const handle = runProjectionWorker(largeInput, {
			timeoutMs: 10_000,
			lifecycle: {
				onSpawn: (pid) => {
					spawned += 1;
					workerPid = pid;
				},
			},
		});
		handles.push(handle);
		await parentTurn;
		expect(spawned).toBe(1);
		expect(workerPid).not.toBe(process.pid);
		expect((await handle.result).nodes).toHaveLength(PROJECTION_MAX_ROWS);
	});

	test("kills a worker at the hard deadline", async () => {
		const clock = fakeProjectionClock();
		let terminated = 0;
		const handle = runProjectionWorker(input(), {
			holdForTests: true,
			timeoutMs: 500,
			clock,
			lifecycle: {
				onTerminate: () => {
					terminated += 1;
				},
			},
		});
		handles.push(handle);
		clock.advance(500);
		await expect(handle.result).rejects.toBeInstanceOf(ProjectionWorkerTimeoutError);
		expect(terminated).toBe(1);
	});

	test("bounds the complete job when the DB-owner snapshot is held", async () => {
		const clock = fakeProjectionClock();
		let cancellationCalls = 0;
		let release!: (value: ProjectionWorkerInput) => void;
		const snapshot = new Promise<ProjectionWorkerInput>((resolve) => {
			release = resolve;
		});
		const handle = runBoundedProjectionJob(
			async (control) => {
				control.onCancel(() => {
					cancellationCalls += 1;
				});
				return await snapshot;
			},
			{ deadlineMs: 30, clock },
		);

		clock.advance(30);
		await expect(handle.result).rejects.toBeInstanceOf(ProjectionWorkerTimeoutError);
		expect(cancellationCalls).toBe(1);
		release(input());
		await handle.finished;
	});

	test("cancels a job while its DB-owner snapshot is in flight", async () => {
		let cancellationCalls = 0;
		let release!: (value: ProjectionWorkerInput) => void;
		const snapshot = new Promise<ProjectionWorkerInput>((resolve) => {
			release = resolve;
		});
		const handle = runBoundedProjectionJob(
			async (control) => {
				control.onCancel(() => {
					cancellationCalls += 1;
				});
				return await snapshot;
			},
			{ deadlineMs: 2_000 },
		);

		handle.cancel();
		await expect(handle.result).rejects.toBeInstanceOf(ProjectionWorkerCancelledError);
		expect(cancellationCalls).toBe(1);
		release(input());
		await handle.finished;
	});

	test("publishes only successful jobs", async () => {
		let published = 0;
		const failed = runBoundedProjectionJob(
			async () => {
				throw new Error("snapshot failed");
			},
			{
				publish: async () => {
					published += 1;
				},
			},
		);
		await expect(failed.result).rejects.toThrow("snapshot failed");
		expect(published).toBe(0);

		const clock = fakeProjectionClock();
		let release!: (value: ProjectionWorkerInput) => void;
		const held = new Promise<ProjectionWorkerInput>((resolve) => {
			release = resolve;
		});
		const timedOut = runBoundedProjectionJob(() => held, {
			clock,
			deadlineMs: 10,
			publish: async () => {
				published += 1;
			},
		});
		clock.advance(10);
		await expect(timedOut.result).rejects.toBeInstanceOf(ProjectionWorkerTimeoutError);
		expect(published).toBe(0);
		release(input());
		await timedOut.finished;

		const cancelled = runBoundedProjectionJob(() => held, {
			deadlineMs: 2_000,
			publish: async () => {
				published += 1;
			},
		});
		cancelled.cancel();
		await expect(cancelled.result).rejects.toBeInstanceOf(ProjectionWorkerCancelledError);
		expect(published).toBe(0);
		await cancelled.finished;
	});
});

describe("ProjectionJobManager", () => {
	test("single-flights equivalent jobs and bounds global concurrency", async () => {
		const manager = new ProjectionJobManager(2);
		let active = 0;
		let peak = 0;
		const resolvers: Array<() => void> = [];
		const run = () => {
			active += 1;
			peak = Math.max(peak, active);
			const result = new Promise<ProjectionResult>((resolve) =>
				resolvers.push(() => resolve({ nodes: [], edges: [] })),
			);
			return { result, cancel: () => undefined };
		};
		const first = manager.start("same", 2, run);
		const duplicate = manager.start("same", 2, run);
		manager.start("other", 2, run);
		expect(duplicate.jobId).toBe(first.jobId);
		expect(peak).toBe(2);
		let overload: unknown;
		try {
			manager.start("third", 2, run);
		} catch (error) {
			overload = error;
		}
		expect(overload).toBeInstanceOf(ProjectionAdmissionError);
		expect((overload as ProjectionAdmissionError).code).toBe("PROJECTION_OVERLOADED");
		for (const resolve of resolvers.splice(0)) resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(manager.get(first.jobId)?.status).toBe("ready");
		expect(peak).toBe(2);
	});

	test("does not expose or cancel a job across principals", () => {
		const manager = new ProjectionJobManager(2);
		const principalA: ProjectionPrincipal = { agentId: "agent-a", project: "project-a" };
		const principalB: ProjectionPrincipal = { agentId: "agent-b", project: "project-b" };
		const request: ProjectionRequest = { dimensions: 2, limit: 2, offset: 0, filters: {} };
		const key = projectionRequestKey(principalA, request);
		const handle = manager.start(
			key,
			2,
			() => ({ result: new Promise<ProjectionResult>(() => undefined), cancel: () => undefined }),
			{},
			principalA,
		);
		expect(manager.get(handle.jobId, principalB)).toBeNull();
		expect(manager.cancel(handle.jobId, principalB)).toBeNull();
		expect(manager.cancel(handle.jobId, principalA)?.status).toBe("cancelled");
		manager.reset();
	});

	test("normalizes equivalent filtered requests but separates distinct filters", () => {
		const principal: ProjectionPrincipal = { agentId: "agent-a", project: "project-a" };
		const base: ProjectionRequest = { dimensions: 2, limit: 10, offset: 0, filters: { who: ["b", "a", "a"] } };
		const equivalent: ProjectionRequest = { ...base, filters: { who: [" a ", "b"] } };
		const distinct: ProjectionRequest = { ...base, filters: { who: ["c"] } };
		expect(projectionRequestKey(principal, base)).toBe(projectionRequestKey(principal, equivalent));
		expect(projectionRequestKey(principal, base)).not.toBe(projectionRequestKey(principal, distinct));
	});

	test("reports stable terminal statuses and releases admission after each outcome", async () => {
		const manager = new ProjectionJobManager(1);
		const ready = manager.start("ready", 2, () => ({
			result: Promise.resolve({ nodes: [], edges: [] }),
			cancel: () => undefined,
		}));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(manager.get(ready.jobId)?.status).toBe("ready");

		const failed = manager.start("failed", 2, () => ({
			result: Promise.reject(new Error("failed")),
			cancel: () => undefined,
		}));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(manager.get(failed.jobId)?.status).toBe("error");

		const timedOut = manager.start("timeout", 2, () => ({
			result: Promise.reject(new ProjectionWorkerTimeoutError(1)),
			cancel: () => undefined,
		}));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(manager.get(timedOut.jobId)?.status).toBe("timeout");
	});
});
