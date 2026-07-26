import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
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

beforeEach(() => {
	closeDbAccessor();
	dir = mkdtempSync(join(tmpdir(), "signet-health-routes-"));
	// Point the daemon's base path at the bare temp workspace and disable the
	// embedding provider: readiness must pass here without depending on
	// whatever providers happen to run on the host machine.
	savedSignetPath = process.env.SIGNET_PATH;
	process.env.SIGNET_PATH = dir;
	writeFileSync(join(dir, "agent.yaml"), "embedding:\n  provider: none\n");
	initDbAccessor(join(dir, "memory", "memories.db"));
});

afterEach(() => {
	closeDbAccessor();
	if (savedSignetPath === undefined) {
		// biome-ignore lint/performance/noDelete: deleting env keys avoids stringifying undefined in process.env.
		delete process.env.SIGNET_PATH;
	} else {
		process.env.SIGNET_PATH = savedSignetPath;
	}
	rmSync(dir, { recursive: true, force: true });
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
		// A misconfigured pipeline (extraction.provider='command' with no command
		// block) throws PipelineConfigValidationError; without a try/catch this
		// turned /health/ready into an unhandled 500. It must stay a structured 503.
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
	test("legacy endpoint still responds", async () => {
		const app = makeApp();
		const res = await app.request("http://localhost/health");

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(typeof body.uptime).toBe("number");
		expect(typeof body.pid).toBe("number");
		expect(typeof body.version).toBe("string");
		const resources = body.resources as Record<string, unknown>;
		expect(typeof resources.rss).toBe("number");
		expect(typeof resources.heapUsed).toBe("number");
		expect(resources.physicalFootprint === null || typeof resources.physicalFootprint === "number").toBe(true);
		expect(resources.peakPhysicalFootprint === null || typeof resources.peakPhysicalFootprint === "number").toBe(true);
	});
});
