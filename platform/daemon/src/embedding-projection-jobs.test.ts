import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ProjectionAdmissionError,
	ProjectionJobManager,
	ProjectionWorkerCancelledError,
	ProjectionWorkerTimeoutError,
	runBoundedProjectionJob,
	runProjectionWorker,
} from "./embedding-projection-jobs";
import type { ProjectionWorkerInput } from "./embedding-projection-worker";
import type { ProjectionResult } from "./umap-projection";
import {
	projectionRequestKey,
	type ProjectionPrincipal,
	type ProjectionRequest,
} from "./embedding-projection-contract";

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
		const snapshot = readFileSync(join(import.meta.dir, "embedding-projection-snapshot.ts"), "utf8");
		const owner = readFileSync(join(import.meta.dir, "db-owner-worker.ts"), "utf8");
		expect(source).toContain('app.use("/api/embeddings", async (c, next) =>');
		expect(source).toContain('requirePermission("recall", authConfig)(c, next)');
		const projectionStart = source.indexOf('app.get("/api/embeddings/projection",');
		const projectionRoute = source.slice(projectionStart, source.indexOf("// POST /api/documents", projectionStart));
		expect(projectionRoute).toContain("resolveProjectionPrincipal");
		expect(projectionRoute).toContain("projectionRequestKey(principal, request)");
		expect(projectionRoute).toContain('kind: "embedding_projection_snapshot"');
		expect(projectionRoute).toContain("createDbOwnerClient");
		expect(projectionRoute).not.toContain("umap_cache");
		expect(projectionRoute).not.toContain("runWriteTxAsync");
		const cancellationRoute = source.slice(
			source.indexOf('app.delete("/api/embeddings/projection/:jobId"'),
			projectionStart,
		);
		expect(cancellationRoute).toContain('projectionJobs.cancel(c.req.param("jobId"), principalResult.principal)');
		expect(cancellationRoute).toContain("}, 200);");
		expect(cancellationRoute).toContain("projectionJobResponse(job)");
		expect(snapshot).toContain("m.agent_id");
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
		const startedAt = performance.now();
		let tickDelay = Number.POSITIVE_INFINITY;
		setTimeout(() => {
			tickDelay = performance.now() - startedAt;
		}, 0);
		const handle = runProjectionWorker(input(), { holdForTests: true, timeoutMs: 2_000 });
		handles.push(handle);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(tickDelay).toBeLessThan(80);
		handle.cancel();
		await expect(handle.result).rejects.toBeInstanceOf(ProjectionWorkerCancelledError);
	});

	test("keeps a 1,000-row snapshot off the parent event loop", async () => {
		const seed = input().rows;
		const largeInput: ProjectionWorkerInput = {
			dimensions: 2,
			rows: Array.from({ length: 1_000 }, (_, index) => ({
				...seed[index % seed.length],
				id: `row-${index}`,
				source_id: `row-${index}`,
			})),
		};
		const startedAt = performance.now();
		let tickDelay = Number.POSITIVE_INFINITY;
		setTimeout(() => {
			tickDelay = performance.now() - startedAt;
		}, 0);
		const handle = runProjectionWorker(largeInput, { holdForTests: true, timeoutMs: 2_000 });
		handles.push(handle);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(tickDelay).toBeLessThan(80);
		handle.cancel();
		await expect(handle.result).rejects.toBeInstanceOf(ProjectionWorkerCancelledError);
	});

	test("kills a worker at the hard deadline", async () => {
		const handle = runProjectionWorker(input(), { holdForTests: true, timeoutMs: 50 });
		handles.push(handle);
		await expect(handle.result).rejects.toBeInstanceOf(ProjectionWorkerTimeoutError);
	});

	test("bounds the complete job when the DB-owner snapshot is held", async () => {
		let cancellationCalls = 0;
		const startedAt = performance.now();
		const handle = runBoundedProjectionJob(
			async (control) => {
				control.onCancel(() => {
					cancellationCalls += 1;
				});
				await new Promise((resolve) => setTimeout(resolve, 100));
				return input();
			},
			{ deadlineMs: 30 },
		);

		await expect(handle.result).rejects.toBeInstanceOf(ProjectionWorkerTimeoutError);
		expect(performance.now() - startedAt).toBeLessThan(80);
		expect(cancellationCalls).toBe(1);
	});

	test("cancels a job while its DB-owner snapshot is in flight", async () => {
		let cancellationCalls = 0;
		const startedAt = performance.now();
		const handle = runBoundedProjectionJob(
			async (control) => {
				control.onCancel(() => {
					cancellationCalls += 1;
				});
				await new Promise((resolve) => setTimeout(resolve, 100));
				return input();
			},
			{ deadlineMs: 2_000 },
		);

		handle.cancel();
		await expect(handle.result).rejects.toBeInstanceOf(ProjectionWorkerCancelledError);
		expect(performance.now() - startedAt).toBeLessThan(50);
		expect(cancellationCalls).toBe(1);
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
		expect(() => manager.start("third", 2, run)).toThrow(ProjectionAdmissionError);
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
});
