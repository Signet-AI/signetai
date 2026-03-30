import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { mountSkillAnalyticsRoutes } from "./skill-analytics";

let app: Hono;
let agentsDir: string;
const dbFiles = ["memories.db", "memories.db-shm", "memories.db-wal"];
let originalSignetPath: string | undefined;

describe("skill-analytics routes (HTTP)", () => {
	beforeAll(() => {
		originalSignetPath = process.env.SIGNET_PATH;
		agentsDir = mkdtempSync(join(tmpdir(), "signet-skill-analytics-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`memory:\n  pipelineV2:\n    enabled: false\n    shadowMode: false\n`,
		);
		process.env.SIGNET_PATH = agentsDir;
		initDbAccessor(join(agentsDir, "memory", "memories.db"), { agentsDir });

		app = new Hono();
		mountSkillAnalyticsRoutes(app, "local");
	});

	afterAll(() => {
		closeDbAccessor();
		for (const file of dbFiles) {
			rmSync(join(agentsDir, "memory", file), { force: true });
		}
		rmSync(agentsDir, { recursive: true, force: true });
		if (originalSignetPath !== undefined) {
			process.env.SIGNET_PATH = originalSignetPath;
		} else {
			delete process.env.SIGNET_PATH;
		}
	});

	beforeEach(() => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare("DELETE FROM skill_invocations").run();
		});
	});

	function seed(skillName: string, agentId = "default", success = true): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO skill_invocations (id, skill_name, agent_id, source, latency_ms, success, created_at)
				 VALUES (?, ?, ?, 'scheduled-task', 100, ?, datetime('now'))`,
			).run(
				`sinv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				skillName,
				agentId,
				success ? 1 : 0,
			);
		});
	}

	it("GET /api/skills/analytics returns 200 with empty data", async () => {
		const res = await app.request("/api/skills/analytics");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.totalInvocations).toBe(0);
		expect(body.successRate).toBe(0);
		expect(body.topSkills).toEqual([]);
	});

	it("GET /api/skills/analytics returns aggregated data", async () => {
		seed("recall");
		seed("recall");
		seed("remember", "default", false);

		const res = await app.request("/api/skills/analytics");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.totalInvocations).toBe(3);
		expect(body.topSkills.length).toBeGreaterThan(0);
		expect(body.topSkills[0].skillName).toBe("recall");
	});

	it("GET /api/skills/analytics scopes by agent_id", async () => {
		seed("recall", "agent-a");
		seed("recall", "agent-b");
		seed("recall", "default");

		const res = await app.request("/api/skills/analytics?agent_id=agent-a");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.totalInvocations).toBe(1);
	});

	it("GET /api/skills/analytics returns 400 for bad since", async () => {
		const res = await app.request("/api/skills/analytics?since=not-a-date");
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("Invalid");
	});

	it("GET /api/skills/analytics/:skill returns per-skill data", async () => {
		seed("recall");
		seed("recall");

		const res = await app.request("/api/skills/analytics/recall");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.skillName).toBe("recall");
		expect(body.totalInvocations).toBe(2);
		expect(body.timeline).toBeDefined();
		expect(body.sources).toBeDefined();
	});

	it("GET /api/skills/analytics/:skill normalizes case", async () => {
		seed("recall");

		const res = await app.request("/api/skills/analytics/Recall");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.totalInvocations).toBe(1);
	});

	it("GET /api/skills/analytics/:skill returns 400 for bad since", async () => {
		const res = await app.request("/api/skills/analytics/recall?since=garbage");
		expect(res.status).toBe(400);
	});
});
