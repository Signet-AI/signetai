import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { loadMemoryConfig } from "./memory-config";
import { hybridRecall as scopedHybridRecall } from "./memory-search";
import { type LocalScopeHint, withLocalReadScope } from "./test-support/local-read-scope";
import type { RecallParams } from "./memory-search";

type ScopedHybridRecallRest = Parameters<typeof scopedHybridRecall> extends [unknown, ...infer Rest] ? Rest : never;
function hybridRecall(
	params: Omit<RecallParams, "readScope"> & LocalScopeHint,
	...rest: ScopedHybridRecallRest
): ReturnType<typeof scopedHybridRecall> {
	return scopedHybridRecall(withLocalReadScope(params), ...rest);
}

test("recall delivery still dedupes when parent synchronous writes are unavailable", async () => {
	const directory = mkdtempSync(join(tmpdir(), "signet-recall-owner-write-"));
	const previous = process.env.SIGNET_PATH;
	process.env.SIGNET_PATH = directory;
	try {
		mkdirSync(join(directory, "memory"));
		writeFileSync(join(directory, "agent.yaml"), "embedding:\n  provider: none\nsearch:\n  min_score: 0\n");
		initDbAccessor(join(directory, "memory", "memories.db"));
		getSyncDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"INSERT INTO memories(id,content,type,agent_id,created_at,updated_at,updated_by) VALUES ('owner-write-memory','Atlas owner delivery','fact','default','2026-11-25T00:00:00.000Z','2026-11-25T00:00:00.000Z','test')",
				)
				.run(),
		);
		const accessor = getSyncDbAccessor();
		const original = accessor.withWriteTx;
		accessor.withWriteTx = () => {
			throw new Error("Parent synchronous SQLite is unavailable");
		};
		try {
			const params = {
				query: "Atlas owner delivery",
				agentId: "default",
				sessionKey: "owner-write-session",
				trackRecallAccess: false,
				readScope: { reach: { kind: "own" as const, agentId: "default" }, compartments: [], projects: null },
			};
			const first = await hybridRecall(params, loadMemoryConfig(directory), async () => null);
			expect(first.results.map((row) => row.id)).toEqual(["owner-write-memory"]);
			expect(first.meta.dedupe?.failedOpen).toBeUndefined();
			const second = await hybridRecall(params, loadMemoryConfig(directory), async () => null);
			expect(second.results).toEqual([]);
			expect(second.meta.dedupe?.failedOpen).toBeUndefined();
		} finally {
			accessor.withWriteTx = original;
		}
	} finally {
		await closeDbAccessor();
		if (previous === undefined) delete process.env.SIGNET_PATH;
		else process.env.SIGNET_PATH = previous;
		rmSync(directory, { recursive: true, force: true });
	}
}, 30000);
