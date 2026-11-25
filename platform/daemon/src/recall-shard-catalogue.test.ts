import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import type { DbOwnerRequest, DbOwnerSubmitOptions } from "./db-owner-client";
import { getDbOwner } from "./db-owner-runtime";
import { loadMemoryConfig } from "./memory-config";
import { hybridRecall } from "./memory-search";

for (const compartments of [[], [1]]) {
	test(`a recall request reads its catalogue ${compartments.length === 0 ? "zero times for an empty audience" : "at most once across all stages"}`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-catalogue-recall-"));
		const previous = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		try {
			mkdirSync(join(dir, "memory"));
			writeFileSync(join(dir, "agent.yaml"), "embedding:\n  provider: none\nsearch:\n  min_score: 0\n");
			initDbAccessor(join(dir, "memory", "memories.db"));
			await getDbAccessor().withWriteTxAsync((db) =>
				db
					.prepare(
						"INSERT INTO memories(id,content,type,agent_id,created_at,updated_at,updated_by) VALUES ('public','atlas deployment pipeline','fact','default','2026-11-25','2026-11-25','test')",
					)
					.run(),
			);
			const owner = await getDbOwner();
			const submit = owner.submit.bind(owner);
			let reads = 0;
			owner.submit = <Result>(request: DbOwnerRequest, options: DbOwnerSubmitOptions) => {
				if (
					request.kind === "query" &&
					/SELECT name FROM sqlite_master/i.test(request.statement.sql) &&
					/shard|__c/.test(options.operation + " " + request.statement.sql)
				)
					reads++;
				return submit<Result>(request, options);
			};
			try {
				const response = await hybridRecall(
					{
						query: "atlas deployment pipeline",
						agentId: "default",
						trackRecallAccess: false,
						readScope: { reach: { kind: "own", agentId: "default" }, compartments, projects: null },
					},
					loadMemoryConfig(dir),
					async () => null,
				);
				expect(response.results.map((row) => row.id)).toContain("public");
				expect(reads).toBeLessThanOrEqual(compartments.length === 0 ? 0 : 1);
			} finally {
				owner.submit = submit;
			}
		} finally {
			await closeDbAccessor();
			if (previous === undefined) delete process.env.SIGNET_PATH;
			else process.env.SIGNET_PATH = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30000);
}
