import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureAgentRegistered,
	getAgentScope,
	invalidateAgentScopeCache,
	resolveAgentId,
	resolveDaemonAgentId,
} from "./agent-id";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";

function makeDbPath(): string {
	const dir = join(tmpdir(), `signet-agent-id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memories.db");
}

describe("agent id registration", () => {
	let dbPath = "";

	afterEach(async () => {
		await closeDbAccessor();
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

	test("uses configured daemon agent id as resolveAgentId fallback", () => {
		expect(resolveAgentId({}, { SIGNET_AGENT_ID: "noam" } as NodeJS.ProcessEnv)).toBe("noam");
		expect(resolveAgentId({}, {} as NodeJS.ProcessEnv)).toBe("default");
	});
	test("resolves agent id from agent-scoped session keys", () => {
		expect(resolveAgentId({ sessionKey: "agent:agent-b:session-1" })).toBe("agent-b");
	});

	test("registers first-seen named agents with isolated read policy", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		await ensureAgentRegistered("noam");

		const row = (await getDbAccessor().withReadDbAsync((db) =>
			db.prepare("SELECT id, name, read_policy FROM agents WHERE id = 'noam'").get(),
		)) as { id: string; name: string; read_policy: string } | undefined;

		expect(row).toEqual({ id: "noam", name: "noam", read_policy: "isolated" });
		expect(await getAgentScope("noam")).toEqual({ readPolicy: "isolated", policyGroup: null });
	});

	test("keeps the seeded default agent shared", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		await ensureAgentRegistered("default");

		expect(await getAgentScope("default")).toEqual({ readPolicy: "shared", policyGroup: null });
	});

	test("does not narrow agents already registered as shared", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		const now = new Date().toISOString();
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
				 VALUES ('legacy', 'legacy', 'shared', NULL, ?, ?)`,
			).run(now, now);
		});

		await ensureAgentRegistered("legacy");

		expect(await getAgentScope("legacy")).toEqual({ readPolicy: "shared", policyGroup: null });
	});

	test("does not overwrite existing agent policies", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		const now = new Date().toISOString();
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
				 VALUES ('noam', 'Noam', 'isolated', 'private-team', ?, ?)`,
			).run(now, now);
		});

		await ensureAgentRegistered("noam");

		const row = (await getDbAccessor().withReadDbAsync((db) =>
			db.prepare("SELECT name, read_policy, policy_group FROM agents WHERE id = 'noam'").get(),
		)) as { name: string; read_policy: string; policy_group: string | null } | undefined;

		expect(row).toEqual({ name: "Noam", read_policy: "isolated", policy_group: "private-team" });
	});

	test("caches scope reads until roster invalidation", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		await ensureAgentRegistered("cache-agent");

		expect(await getAgentScope("cache-agent")).toEqual({ readPolicy: "isolated", policyGroup: null });
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare("UPDATE agents SET read_policy = 'shared' WHERE id = 'cache-agent'").run();
		});
		expect(await getAgentScope("cache-agent")).toEqual({ readPolicy: "isolated", policyGroup: null });

		invalidateAgentScopeCache("cache-agent");
		expect(await getAgentScope("cache-agent")).toEqual({ readPolicy: "shared", policyGroup: null });
	});
});
