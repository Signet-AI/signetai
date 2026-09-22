import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentScope, ensureAgentRegistered, invalidateAgentScopeCache } from "./agent-id";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";

function makeDbPath(tag: string): string {
	const dir = join(tmpdir(), `signet-agent-scope-cache-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memories.db");
}

describe("agent-scope cache lifecycle", () => {
	test("cache is invalidated when the DB accessor is closed and replaced", async () => {
		const pathA = makeDbPath("a");
		const pathB = makeDbPath("b");
		try {
			initDbAccessor(pathA);
			await ensureAgentRegistered("reinit-agent", "shared");
			expect((await getAgentScope("reinit-agent")).readPolicy).toBe("shared");
			await closeDbAccessor();
			initDbAccessor(pathB);
			await getDbAccessor().withWriteTxAsync(
				(db) => {
					db.prepare(
						`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
						 VALUES ('reinit-agent', 'reinit-agent', 'isolated', NULL, ?, ?)`,
					).run(new Date().toISOString(), new Date().toISOString());
				},
				{ siteToken: "agent-scope-cache-lifecycle.test.ts:24", operation: "test.seed-agents" },
			);

			const scope = await getAgentScope("reinit-agent");
			expect(scope.readPolicy).toBe("isolated");
		} finally {
			invalidateAgentScopeCache();
			await closeDbAccessor();
			rmSync(join(pathA, ".."), { recursive: true, force: true });
			rmSync(join(pathB, ".."), { recursive: true, force: true });
		}
	});
});
