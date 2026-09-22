import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import { Hono } from "hono";
import { mountMcpAnalyticsRoutes } from "./mcp-analytics.js";

function seedInvocations(
	db: Database,
	rows: ReadonlyArray<{
		id: string;
		serverId: string;
		toolName: string;
		agentId?: string;
		source?: string;
		latencyMs: number;
		success?: boolean;
		errorText?: string;
		createdAt?: string;
	}>,
): void {
	const stmt = db.prepare(
		`INSERT INTO mcp_invocations (id, server_id, tool_name, agent_id, source, latency_ms, success, error_text, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const row of rows) {
		stmt.run(
			row.id,
			row.serverId,
			row.toolName,
			row.agentId ?? "default",
			row.source ?? "mcp",
			row.latencyMs,
			(row.success ?? true) ? 1 : 0,
			row.errorText ?? null,
			row.createdAt ?? new Date().toISOString(),
		);
	}
}

describe("mcp-analytics routes", () => {
	let db: Database;
	let app: Hono;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		app = new Hono();
	});

	afterEach(() => {
		if (db) db.close();
	});

	it("returns empty analytics when no invocations exist", async () => {
		const totals = db
			.prepare(
				"SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successes FROM mcp_invocations WHERE agent_id = ?",
			)
			.get("default") as { total: number; successes: number };

		expect(totals.total).toBe(0);
		expect(totals.successes).toBe(0);
	});

	it("records and aggregates invocations correctly", () => {
		seedInvocations(db, [
			{ id: "inv-1", serverId: "srv-a", toolName: "tool-1", latencyMs: 100 },
			{ id: "inv-2", serverId: "srv-a", toolName: "tool-1", latencyMs: 200 },
			{ id: "inv-3", serverId: "srv-a", toolName: "tool-2", latencyMs: 300, success: false, errorText: "timeout" },
			{ id: "inv-4", serverId: "srv-b", toolName: "tool-3", latencyMs: 50 },
		]);
		const total = db.prepare("SELECT COUNT(*) as c FROM mcp_invocations WHERE agent_id = 'default'").get() as {
			c: number;
		};
		expect(total.c).toBe(4);
		const servers = db
			.prepare(
				`SELECT server_id, COUNT(*) as count FROM mcp_invocations
			 WHERE agent_id = 'default' GROUP BY server_id ORDER BY count DESC`,
			)
			.all() as { server_id: string; count: number }[];
		expect(servers[0].server_id).toBe("srv-a");
		expect(servers[0].count).toBe(3);
		const successes = db
			.prepare(
				"SELECT SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as s FROM mcp_invocations WHERE agent_id = 'default'",
			)
			.get() as { s: number };
		expect(successes.s).toBe(3);
		const failures = db.prepare("SELECT error_text FROM mcp_invocations WHERE success = 0").all() as {
			error_text: string;
		}[];
		expect(failures.length).toBe(1);
		expect(failures[0].error_text).toBe("timeout");
	});

	it("scopes queries by agent_id", () => {
		seedInvocations(db, [
			{ id: "inv-a1", serverId: "srv-a", toolName: "tool-1", agentId: "agent-a", latencyMs: 100 },
			{ id: "inv-b1", serverId: "srv-a", toolName: "tool-1", agentId: "agent-b", latencyMs: 200 },
			{ id: "inv-a2", serverId: "srv-a", toolName: "tool-2", agentId: "agent-a", latencyMs: 150 },
		]);

		const agentA = db.prepare("SELECT COUNT(*) as c FROM mcp_invocations WHERE agent_id = 'agent-a'").get() as {
			c: number;
		};
		expect(agentA.c).toBe(2);

		const agentB = db.prepare("SELECT COUNT(*) as c FROM mcp_invocations WHERE agent_id = 'agent-b'").get() as {
			c: number;
		};
		expect(agentB.c).toBe(1);
	});

	it("computes per-server tool breakdown", () => {
		seedInvocations(db, [
			{ id: "inv-1", serverId: "srv-a", toolName: "search", latencyMs: 100 },
			{ id: "inv-2", serverId: "srv-a", toolName: "search", latencyMs: 200 },
			{ id: "inv-3", serverId: "srv-a", toolName: "create", latencyMs: 300 },
		]);

		const tools = db
			.prepare(
				`SELECT tool_name, COUNT(*) as count, CAST(AVG(latency_ms) AS INTEGER) as avgLatencyMs
			 FROM mcp_invocations WHERE agent_id = 'default' AND server_id = 'srv-a'
			 GROUP BY tool_name ORDER BY count DESC`,
			)
			.all() as { tool_name: string; count: number; avgLatencyMs: number }[];

		expect(tools.length).toBe(2);
		expect(tools[0].tool_name).toBe("search");
		expect(tools[0].count).toBe(2);
		expect(tools[0].avgLatencyMs).toBe(150);
		expect(tools[1].tool_name).toBe("create");
		expect(tools[1].count).toBe(1);
	});

	it("since filter handles ISO timestamps correctly", () => {
		seedInvocations(db, [
			{ id: "inv-old", serverId: "srv-a", toolName: "tool-1", latencyMs: 100, createdAt: "2025-01-01T00:00:00Z" },
			{ id: "inv-new", serverId: "srv-a", toolName: "tool-1", latencyMs: 200, createdAt: "2025-06-15T12:00:00Z" },
		]);

		const filtered = db
			.prepare("SELECT COUNT(*) as c FROM mcp_invocations WHERE agent_id = 'default' AND created_at >= datetime(?)")
			.get("2025-06-01T00:00:00Z") as { c: number };
		expect(filtered.c).toBe(1);
	});

	it("source column correctly stored", () => {
		seedInvocations(db, [
			{ id: "inv-cli", serverId: "srv-a", toolName: "tool-1", source: "cli", latencyMs: 100 },
			{ id: "inv-agent", serverId: "srv-a", toolName: "tool-1", source: "agent", latencyMs: 200 },
			{ id: "inv-mcp", serverId: "srv-a", toolName: "tool-1", source: "mcp", latencyMs: 150 },
		]);

		const sources = db
			.prepare("SELECT source, COUNT(*) as c FROM mcp_invocations GROUP BY source ORDER BY source")
			.all() as { source: string; c: number }[];

		expect(sources).toEqual([
			{ source: "agent", c: 1 },
			{ source: "cli", c: 1 },
			{ source: "mcp", c: 1 },
		]);
	});
});
