import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { MAX_READ_CONNECTIONS, closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import type { DbOwnerHealth, DbOwnerClient } from "../db-owner-client";
import {
	closeRegisteredDbOwnerMaintenance,
	createDbOwnerMaintenance,
	registerDbOwnerMaintenance,
} from "../db-owner-maintenance";
import { resetDbObservability } from "../db-observability";
import { startEventLoopMonitor, stopResourceMonitors } from "../resource-monitor";
import { mountHealthRoutes } from "./health";

/**
 * Regression tests for GitHub issue #905:
 * `/health` reports "healthy" based on process liveness alone, even when
 * db/migrations/embedding/inference/queue subsystems are down.
 *
 * Planned API (implementation follows in phase 2):
 * - `GET /health/live`  — cheap liveness: status, uptime, pid, version,
 *   shuttingDown. Never degrades on subsystem failure.
 * - `GET /health/ready` — readiness across db, migrations, embedding,
 *   inference, queue. 200 `{ status: "ready" }` or
 *   503 `{ status: "not_ready", reasons: string[] }`.
 * - `GET /health` stays unchanged for back-compat.
 */

let dir = "";
let savedSignetPath: string | undefined;

function makeApp(): Hono {
	const app = new Hono();
	mountHealthRoutes(app);
	return app;
}

beforeEach(async () => {
	stopResourceMonitors();
	resetDbObservability();
	await closeRegisteredDbOwnerMaintenance();
	await closeDbAccessor();
	dir = mkdtempSync(join(tmpdir(), "signet-health-routes-"));
	// Point the daemon's base path at the bare temp workspace and disable the
	// embedding provider: readiness must pass here without depending on
	// whatever providers happen to run on the host machine.
	savedSignetPath = process.env.SIGNET_PATH;
	process.env.SIGNET_PATH = dir;
	writeFileSync(join(dir, "agent.yaml"), "embedding:\n  provider: none\n");
	initDbAccessor(join(dir, "memory", "memories.db"));
});

afterEach(async () => {
	stopResourceMonitors();
	resetDbObservability();
	await closeRegisteredDbOwnerMaintenance();
	await closeDbAccessor();
	if (savedSignetPath === undefined) {
		delete process.env.SIGNET_PATH;
	} else {
		process.env.SIGNET_PATH = savedSignetPath;
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("GET /health owner diagnostics", () => {
	test("reports a missing configured workspace as degraded", async () => {
		const missingPath = join(dir, "moved-workspace");
		process.env.SIGNET_PATH = missingPath;

		const app = makeApp();
		const health = await app.request("http://localhost/health");
		expect(health.status).toBe(200);
		const healthBody = (await health.json()) as {
			status: string;
			workspace: { status: string; path: string; reasons: string[] };
		};
		expect(healthBody.status).toBe("degraded");
		expect(healthBody.workspace.status).toBe("missing");
		expect(healthBody.workspace.path).toBe(missingPath);
		expect(healthBody.workspace.reasons).toContain("configured workspace directory is missing");

		const ready = await app.request("http://localhost/health/ready");
		expect(ready.status).toBe(503);
		const readyBody = (await ready.json()) as { checks: { workspace: { status: string } }; reasons: string[] };
		expect(readyBody.checks.workspace.status).toBe("missing");
		expect(readyBody.reasons).toContain("configured workspace directory is missing");
	});

	test("exposes bounded per-lane owner queue and age metrics", async () => {
		const lane = {
			state: "ready",
			pid: 123,
			generation: 4,
			queuedJobs: 2,
			activeJobId: "db-owner-123-1",
			activeWorkloadClass: "maintenance",
			foregroundQueuedJobs: 1,
			maintenanceQueuedJobs: 1,
			foregroundOldestAgeMs: 12,
			maintenanceOldestAgeMs: 34,
			lastError: null,
		} as const;
		const ownerHealth = {
			...lane,
			lanes: { read: lane, maintenance: lane },
		} as DbOwnerHealth;
		const owner = { health: () => ownerHealth } as unknown as DbOwnerClient;
		const maintenance = createDbOwnerMaintenance({ dbPath: join(dir, "memory", "memories.db"), owner });
		registerDbOwnerMaintenance(maintenance);

		try {
			const res = await makeApp().request("http://localhost/health");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { dbOwner: DbOwnerHealth };
			expect(body.dbOwner.queuedJobs).toBe(2);
			expect(body.dbOwner.foregroundOldestAgeMs).toBe(12);
			expect(body.dbOwner.maintenanceOldestAgeMs).toBe(34);
			if (body.dbOwner.lanes === undefined) throw new Error("owner lanes missing from /health");
			expect(body.dbOwner.lanes.read.maintenanceQueuedJobs).toBe(1);
			expect(body.dbOwner.lanes.maintenance.foregroundQueuedJobs).toBe(1);
		} finally {
			await closeRegisteredDbOwnerMaintenance();
		}
	});
});

describe("GET /health/live", () => {
	test("returns 200 with liveness fields when subsystems are healthy", async () => {
		const app = makeApp();
		const res = await app.request("http://localhost/health/live");

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("healthy");
		expect(typeof body.uptime).toBe("number");
		expect(typeof body.pid).toBe("number");
		expect(typeof body.version).toBe("string");
		expect(body.shuttingDown).toBe(false);
		const eventLoop = body.eventLoop as Record<string, unknown>;
		expect(eventLoop.status).toBe("ok");
		expect(typeof eventLoop.stallSeconds).toBe("number");
	});

	test("stays 200 even when the database is unavailable", async () => {
		// Tear down the singleton accessor so getDbAccessor() throws —
		// liveness must not depend on any subsystem.
		closeDbAccessor();

		const app = makeApp();
		const res = await app.request("http://localhost/health/live");

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("healthy");
		expect(typeof body.uptime).toBe("number");
		expect(typeof body.pid).toBe("number");
		expect(typeof body.version).toBe("string");
	});

	test("stays responsive while the read lease pool is saturated", async () => {
		const sync = getDbAccessor() as unknown as {
			withReadDb<T>(fn: (db: import("../db-accessor").ReadDb) => T): T;
		};
		const app = makeApp();
		let livePromise: Promise<Response> | null = null;
		const acquireNestedReads = (remaining: number): void => {
			if (remaining === 0) {
				livePromise = Promise.resolve(app.request("http://localhost/health/live"));
				return;
			}
			sync.withReadDb(() => acquireNestedReads(remaining - 1));
		};
		acquireNestedReads(MAX_READ_CONNECTIONS);
		const pending = livePromise;
		if (pending === null) throw new Error("liveness request was not started");

		const liveResponse = await pending;
		expect(liveResponse.status).toBe(200);
		expect(getDbAccessor().getReadPressure?.().activeLeases).toBe(0);
	});

	test("latches a late heartbeat for a queued real-server /health/live request", async () => {
		startEventLoopMonitor(50);
		await Bun.sleep(80);

		const app = makeApp();
		app.get("/block-loop", (c) => {
			const startedAt = Date.now();
			while (Date.now() - startedAt < 2_100) {
				// Deliberate synchronous block: this is the wedge signal integration proof.
			}
			return c.json({ blocked: true });
		});

		const server = Bun.serve({ port: 0, fetch: app.fetch });
		const liveClient = Bun.spawn(
			[
				process.execPath,
				"-e",
				[
					'const { connect } = require("node:net");',
					"const target = new URL(process.argv[1]);",
					"const eol = String.fromCharCode(13, 10);",
					"function request(path) { return new Promise((resolve, reject) => {",
					'let response = "";',
					"const socket = connect({ host: target.hostname, port: Number(target.port) }, () => {",
					'socket.write("GET " + path + " HTTP/1.1" + eol + "Host: " + target.hostname + eol + "Connection: close" + eol + eol);',
					"});",
					'socket.on("data", (chunk) => { response += chunk.toString(); });',
					'socket.on("end", () => resolve(response.split("\\r\\n\\r\\n")[1] ?? ""));',
					'socket.on("error", reject);',
					"}); }",
					'const blocked = request("/block-loop");',
					"await new Promise((resolve) => setTimeout(resolve, 100));",
					'const live = request("/health/live");',
					"await blocked;",
					"console.log(await live);",
				].join(" "),
				`http://127.0.0.1:${server.port}/health/live`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);

		try {
			const output = await new Response(liveClient.stdout).text();
			expect(await liveClient.exited).toBe(0);
			const body = JSON.parse(output.trim()) as {
				eventLoop: { status: string; stallMs: number; lagP95Ms: number | null };
			};
			expect(["degraded", "wedged"]).toContain(body.eventLoop.status);
			expect(body.eventLoop.stallMs).toBeGreaterThan(0);
			expect(body.eventLoop.lagP95Ms).toBeGreaterThan(0);
		} finally {
			if (!liveClient.killed) liveClient.kill();
			server.stop(true);
		}
	});
});

describe("GET /health/ready", () => {
	test("returns 200 ready when the db is migrated and healthy", async () => {
		const app = makeApp();
		const res = await app.request("http://localhost/health/ready");

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			status: string;
			checks: Record<string, unknown>;
		};
		expect(body.status).toBe("ready");
		expect(body.checks).toBeDefined();
		expect(body.checks.db).toBe(true);
		expect(body.checks.migrations).toBe(true);
		// Per-check fields must exist for every subsystem gate, even when the
		// check cannot be fully exercised without implementation DI hooks.
		expect("embedding" in body.checks).toBe(true);
		expect("inference" in body.checks).toBe(true);
		expect("queue" in body.checks).toBe(true);
	});

	test("returns 503 with a db reason when the database is unavailable", async () => {
		closeDbAccessor();

		const app = makeApp();
		const res = await app.request("http://localhost/health/ready");

		expect(res.status).toBe(503);
		const body = (await res.json()) as { status: string; reasons: string[] };
		expect(body.status).toBe("not_ready");
		expect(Array.isArray(body.reasons)).toBe(true);
		expect(body.reasons.length).toBeGreaterThan(0);
		expect(body.reasons.every((r) => typeof r === "string")).toBe(true);
		expect(body.reasons.some((r) => /db|database/i.test(r))).toBe(true);
	});

	test("returns 503 with a migrations reason when migrations are pending", async () => {
		// Simulate pending migrations: initDbAccessor ran the full migration
		// set, so wipe schema_migrations to make hasPendingMigrations() true.
		getDbAccessor().withWriteTx((db) => {
			db.exec("DELETE FROM schema_migrations");
		});

		const app = makeApp();
		const res = await app.request("http://localhost/health/ready");

		expect(res.status).toBe(503);
		const body = (await res.json()) as { status: string; reasons: string[] };
		expect(body.status).toBe("not_ready");
		expect(body.reasons.some((r) => /migration/i.test(r))).toBe(true);
	});

	test("failure responses use a non-2xx status and a string reasons array", async () => {
		closeDbAccessor();

		const app = makeApp();
		const res = await app.request("http://localhost/health/ready");

		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(600);
		const body = (await res.json()) as { reasons: unknown };
		expect(Array.isArray(body.reasons)).toBe(true);
		for (const reason of body.reasons as unknown[]) {
			expect(typeof reason).toBe("string");
		}
	});

	test("returns a structured 503 (not a 500) when loadMemoryConfig throws on a misconfigured agent.yaml", async () => {
		// Regression guard: checkInference calls loadMemoryConfig on every probe.
		// A retired command extraction configuration throws
		// PipelineConfigValidationError; without a try/catch this turned
		// /health/ready into an unhandled 500. It must stay a structured 503.
		writeFileSync(
			join(dir, "agent.yaml"),
			"memory:\n  pipelineV2:\n    enabled: true\n    extraction:\n      provider: command\n",
		);

		const app = makeApp();
		const res = await app.request("http://localhost/health/ready");

		expect(res.status).toBe(503);
		const body = (await res.json()) as {
			status: string;
			reasons: string[];
			checks: { inference: { status: string } };
		};
		expect(body.status).toBe("not_ready");
		expect(Array.isArray(body.reasons)).toBe(true);
		// The misconfig is caught by whichever of checkEmbedding/checkInference runs
		// first (both call loadMemoryConfig); either way the endpoint must return a
		// structured 503 with a config-unavailable reason, never an unhandled 500.
		expect(body.reasons.some((r) => /config unavailable/i.test(r))).toBe(true);
		expect(body.checks.inference.status).toBe("unknown");
	});
});

describe("GET /health (back-compat)", () => {
	test("returns 200 with db false within the SLA when read admission is saturated", async () => {
		const app = makeApp();
		const accessor = getDbAccessor();
		const original = accessor.withReadDbAsync;
		accessor.withReadDbAsync = async (fn, options) => {
			if (options?.operation === "health") {
				await Bun.sleep(options.timeoutMs ?? 10_000);
				throw new Error("simulated saturated read pool");
			}
			return original(fn, options);
		};
		const startedAt = performance.now();
		const res = await app.request("http://localhost/health", {
			signal: AbortSignal.timeout(900),
		});
		const elapsedMs = performance.now() - startedAt;
		accessor.withReadDbAsync = original;

		expect(res.status).toBe(200);
		expect(elapsedMs).toBeLessThan(900);
		const body = (await res.json()) as { db: boolean };
		expect(body.db).toBe(false);
	});

	test("legacy endpoint still responds", async () => {
		const app = makeApp();
		const res = await app.request("http://localhost/health");

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(typeof body.uptime).toBe("number");
		expect(typeof body.pid).toBe("number");
		expect(typeof body.version).toBe("string");
		const dbWriter = body.dbWriter as Record<string, unknown>;
		expect(typeof dbWriter.queued).toBe("number");
		expect(typeof dbWriter.maxQueue).toBe("number");
		expect(dbWriter.oldestWaitMs === null || typeof dbWriter.oldestWaitMs === "number").toBe(true);
		expect(dbWriter.lastDurationMs === null || typeof dbWriter.lastDurationMs === "number").toBe(true);
		const dbReader = body.dbReader as Record<string, unknown>;
		expect(typeof dbReader.activeLeases).toBe("number");
		expect(typeof dbReader.maxConnections).toBe("number");
		expect(typeof dbReader.rejected).toBe("number");
		expect(typeof dbReader.syncRejected).toBe("number");
		const dbRuntime = body.dbRuntime as Record<string, unknown>;
		expect(dbRuntime.queue).toBeDefined();
		expect(dbRuntime.eventLoopLag).toBeDefined();
		const eventLoop = body.eventLoop as Record<string, unknown>;
		expect(["ok", "degraded", "wedged"]).toContain(String(eventLoop.status));
		expect(typeof eventLoop.stallSeconds).toBe("number");
		const resources = body.resources as Record<string, unknown>;
		expect(typeof resources.rss).toBe("number");
		expect(typeof resources.heapUsed).toBe("number");
		expect(resources.physicalFootprint === null || typeof resources.physicalFootprint === "number").toBe(true);
		expect(resources.peakPhysicalFootprint === null || typeof resources.peakPhysicalFootprint === "number").toBe(true);
	});
});

describe("GET /api/mode", () => {
	test("reports the local mode auth contract without any token (issue #1001)", async () => {
		const app = makeApp();
		const res = await app.request("/api/mode");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { mode: string; requiresAuth: boolean };
		expect(body.mode).toBe("local");
		expect(body.requiresAuth).toBe(false);
	});

	test("is reachable without an Authorization header (auth-open)", async () => {
		const app = makeApp();
		const res = await app.request("/api/mode", { headers: {} });
		expect(res.status).toBe(200);
	});

	test("does not expose daemon internals beyond the documented shape", async () => {
		const app = makeApp();
		const res = await app.request("/api/mode");
		const body = (await res.json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(["mode", "requiresAuth"]);
	});
});
