import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { TokenClaims, TokenRole } from "../auth/types";
import { DbOwnerDiedError } from "../db-owner-client";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { authConfig } from "./state";
import { registerPipelineRoutes } from "./pipeline-routes";

const originalAgentId = process.env.SIGNET_AGENT_ID;

function createPipelineApp(role: TokenRole = "admin", agentScope = "agent-a"): Hono {
	const app = new Hono();
	const now = Math.floor(Date.now() / 1000);
	const claims: TokenClaims = {
		sub: "evidence-coverage-test-admin",
		scope: { agent: agentScope },
		role,
		iat: now,
		exp: now + 3600,
	};
	app.use("*", async (c, next) => {
		c.set("auth", { authenticated: true, claims });
		await next();
	});
	registerPipelineRoutes(app);
	return app;
}

function registerAgent(db: { prepare(sql: string): { run(...args: unknown[]): unknown } }, agentId: string): void {
	db.prepare(
		`INSERT INTO agents (id, name, read_policy, created_at, updated_at) VALUES (?, ?, 'isolated', datetime('now'), datetime('now'))
		 ON CONFLICT(id) DO NOTHING`,
	).run(agentId, agentId);
}

describe("GET /api/dream/evidence/coverage", () => {
	let agentsDir = "";

	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "signet-evidence-coverage-route-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		initDbAccessor(join(agentsDir, "memory", "memories.db"), { agentsDir });
		process.env.SIGNET_AGENT_ID = "agent-a";
		getDbAccessor().withWriteTx((db) => {
			registerAgent(db, "agent-a");
			registerAgent(db, "agent-b");
			for (const [id, agentId, offset] of [
				["mem-reviewed", "agent-a", 120],
				["mem-partial", "agent-a", 40],
				["mem-foreign", "agent-b", 120],
			] as const) {
				db.prepare(
					`INSERT INTO memories
					 (id, content, source_type, memory_kind, visibility, agent_id, created_at, updated_at)
					 VALUES (?, ?, 'manual', 'episodic', 'normal', ?, '2026-01-01 00:00:01', '2026-01-01 00:00:01')`,
				).run(id, "e".repeat(120), agentId);
				db.prepare(
					`INSERT INTO dreaming_evidence_consumption
					 (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision,
					  delivered_offset, source_length, pass_id, updated_at, cursor_basis, stalled_passes)
					 VALUES (?, 'memory', ?, '2026-01-01 00:00:01', '', '2026-01-01 00:00:01', ?, 120, 'pass-seed', datetime('now'), 'review', 0)`,
				).run(agentId, id, offset);
			}
		});
	});

	afterEach(async () => {
		await closeDbAccessor();
		rmSync(agentsDir, { recursive: true, force: true });
		if (originalAgentId === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		else process.env.SIGNET_AGENT_ID = originalAgentId;
	});

	it("reports scoped coverage totals for the caller's own agent", async () => {
		const app = createPipelineApp();
		const response = await app.request("/api/dream/evidence/coverage");
		expect(response.status).toBe(200);
		const coverage = (await response.json()) as {
			agentId: string;
			sources: Record<string, number>;
			chars: Record<string, number>;
			dreamedFraction: number | null;
			scanComplete: boolean;
			fullyReviewed: boolean;
			byKind: Record<string, { chars: Record<string, number> }>;
		};
		expect(coverage.agentId).toBe("agent-a");
		expect(coverage.sources.eligible).toBe(2);
		expect(coverage.sources.fullyReviewed).toBe(1);
		expect(coverage.sources.partiallyReviewed).toBe(1);
		expect(coverage.chars.eligible).toBe(240);
		expect(coverage.chars.reviewed).toBe(160);
		expect(coverage.chars.unreviewed).toBe(80);
		expect(coverage.chars.consumedWithoutReview).toBe(0);
		expect(coverage.dreamedFraction).toBeCloseTo(160 / 240, 12);
		expect(coverage.byKind.memory?.chars.eligible).toBe(240);
		expect(coverage.scanComplete).toBe(true);
		expect(coverage.fullyReviewed).toBe(false);
	});

	it("returns 404 for an agent that is not registered", async () => {
		const app = createPipelineApp();
		const response = await app.request("/api/dream/evidence/coverage?agentId=agent-ghost");
		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("agent-ghost");
	});

	it("lets an admin-scoped token read another agent's coverage, like GET /api/dream/status", async () => {
		const app = createPipelineApp("admin", "agent-a");
		const response = await app.request("/api/dream/evidence/coverage?agentId=agent-b");
		expect(response.status).toBe(200);
		const coverage = (await response.json()) as { agentId: string; sources: Record<string, number> };
		expect(coverage.agentId).toBe("agent-b");
		expect(coverage.sources.eligible).toBe(1);
	});

	it("rejects a scope the caller is not authorized for", async () => {
		const previousMode = authConfig.mode;
		(authConfig as { mode: typeof previousMode }).mode = "team";
		try {
			const app = createPipelineApp("operator");
			const response = await app.request("/api/dream/evidence/coverage?agentId=agent-b");
			expect(response.status).toBe(403);
			const body = (await response.json()) as { error: string };
			expect(typeof body.error).toBe("string");
			expect(body.error.length).toBeGreaterThan(0);
		} finally {
			(authConfig as { mode: typeof previousMode }).mode = previousMode;
		}
	});

	it("maps an owner failure during agent lookup to 503 instead of 404", async () => {
		const actualAgentId = await import("../agent-id.js");
		mock.module("../agent-id.js", () => ({
			...actualAgentId,
			isAgentRegistered: async () => {
				throw new DbOwnerDiedError();
			},
		}));
		try {
			const app = createPipelineApp();
			const response = await app.request("/api/dream/evidence/coverage?agentId=agent-a");
			expect(response.status).toBe(503);
			const body = (await response.json()) as { error: string; code: string };
			expect(body.code).toBe("DB_OWNER_DIED");
		} finally {
			mock.restore();
		}
	});
});
