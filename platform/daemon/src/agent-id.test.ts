import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAgentRegistered, resolveAgentId, resolveDaemonAgentId } from "./agent-id";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";

function makeDbPath(): string {
	const dir = join(tmpdir(), `signet-agent-id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memories.db");
}

describe("agent id registration", () => {
	let dbPath = "";

	afterEach(() => {
		closeDbAccessor();
		if (dbPath) {
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
		dbPath = "";
	});

	test("normalizes explicit agent ids", () => {
		expect(resolveAgentId({ agentId: "  noam  " })).toBe("noam");
		expect(resolveAgentId({ agentId: "   ", sessionKey: "agent:alice:session" })).toBe("alice");
	});

	test("resolves daemon agent id from SIGNET_AGENT_ID", () => {
		expect(resolveDaemonAgentId({ SIGNET_AGENT_ID: "agent-b" } as NodeJS.ProcessEnv)).toBe("agent-b");
	});

	test("falls back to default when daemon agent id is blank", () => {
		expect(resolveDaemonAgentId({ SIGNET_AGENT_ID: "  " } as NodeJS.ProcessEnv)).toBe("default");
	});

	test("resolves agent id from agent-scoped session keys", () => {
		expect(resolveAgentId({ sessionKey: "agent:agent-b:session-1" })).toBe("agent-b");
	});

	test("registers first-seen named agents with shared read policy", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		ensureAgentRegistered("noam");

		const row = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT id, name, read_policy FROM agents WHERE id = 'noam'").get(),
		) as { id: string; name: string; read_policy: string } | undefined;

		expect(row).toEqual({ id: "noam", name: "noam", read_policy: "shared" });
	});

	test("does not overwrite existing agent policies", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
				 VALUES ('noam', 'Noam', 'isolated', 'private-team', ?, ?)`,
			).run(now, now);
		});

		ensureAgentRegistered("noam");

		const row = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT name, read_policy, policy_group FROM agents WHERE id = 'noam'").get(),
		) as { name: string; read_policy: string; policy_group: string | null } | undefined;

		expect(row).toEqual({ name: "Noam", read_policy: "isolated", policy_group: "private-team" });
	});
});
