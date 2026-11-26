import { SYSTEM_AUTHOR } from "./auth/audit-owner";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDbAccessor, closeDbAccessor } from "./db-accessor";
import { createDbOwnerClient } from "./db-owner-client";
import {
	closeRegisteredDbOwnerMaintenance,
	createDbOwnerMaintenance,
	registerDbOwnerMaintenance,
} from "./db-owner-maintenance";
import { dbOwnerQuery, dbOwnerTransaction } from "./db-owner-runtime";
import { createJob } from "./transcript-import-store";

test("replay keeps one configured source identity while allowing a second file slot", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-replay-schema-"));
	const path = join(root, "memory", "memories.db");
	const owner = createDbOwnerClient({ dbPath: path });
	const options = { operation: "test.import-replay", lane: "write" } as const;
	try {
		await mkdir(join(root, "memory"), { recursive: true });
		await closeDbAccessor();
		initDbAccessor(path, { agentsDir: root });
		await owner.start();
		registerDbOwnerMaintenance(createDbOwnerMaintenance({ dbPath: path, owner }));
		await createJob({ author: SYSTEM_AUTHOR, jobId: "job-a", agentId: "agent-a" });
		await createJob({ author: SYSTEM_AUTHOR, jobId: "job-b", agentId: "agent-a" });
		await dbOwnerTransaction(
			[
				{ sql: "UPDATE source_import_jobs SET state='queued' WHERE id IN ('job-a','job-b')", result: "run" },
				...(
					[
						["job-a", "file-a"],
						["job-b", "file-b"],
					] as const
				).map(([job, file]) => ({
					sql: "INSERT INTO source_import_files (id,job_id,source_id,agent_id,ordinal,name,managed_path,state) VALUES (?,?,?,?,0,?,?, 'ready')",
					params: [
						file,
						job,
						"import:same-source",
						"agent-a",
						"source.jsonl",
						`imports/transcripts/${file}/source.jsonl`,
					],
					result: "run" as const,
				})),
			],
			options,
		);
		const rows = await dbOwnerQuery<Array<{ source_id: string; count: number }>>(
			{
				sql: "SELECT source_id, COUNT(*) AS count FROM source_import_files WHERE agent_id = ? GROUP BY source_id",
				params: ["agent-a"],
				result: "all",
				readonly: true,
			},
			{ operation: "test.import-replay.read", lane: "read" },
		);
		expect(rows).toEqual([{ source_id: "import:same-source", count: 2 }]);
	} finally {
		await closeRegisteredDbOwnerMaintenance();
		await owner.close();
		await closeDbAccessor();
		await rm(root, { recursive: true, force: true });
	}
});
