import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDbAccessor, closeDbAccessor, getDbAccessor } from "./db-accessor";
import { createJob, createOwnerTranscriptImportStore } from "./transcript-import-store";

test("replay keeps one configured source identity while allowing a second file slot", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-replay-schema-"));
	const oldOwner = process.env.SIGNET_DB_OWNER_WORKER;
	process.env.SIGNET_DB_OWNER_WORKER = "1";
	try {
		await mkdir(join(root, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(root, "memory", "memories.db"), { agentsDir: root });
		const store = createOwnerTranscriptImportStore();
		await createJob(store, { jobId: "job-a", agentId: "agent-a" });
		await createJob(store, { jobId: "job-b", agentId: "agent-a" });
		await getDbAccessor().withWriteTxAsync((db) => {
			for (const job of ["job-a", "job-b"])
				db.prepare("UPDATE source_import_jobs SET state = 'queued' WHERE id = ?").run(job);
			for (const [job, file] of [
				["job-a", "file-a"],
				["job-b", "file-b"],
			])
				db.prepare(
					"INSERT INTO source_import_files (id,job_id,source_id,agent_id,ordinal,name,managed_path,state) VALUES (?,?,?,?,0,?,?, 'ready')",
				).run(file, job, "import:same-source", "agent-a", "source.jsonl", `imports/transcripts/${file}/source.jsonl`);
		});
		const rows = await getDbAccessor().withReadDbAsync(
			(db) =>
				db
					.prepare("SELECT source_id, COUNT(*) AS count FROM source_import_files WHERE agent_id = ? GROUP BY source_id")
					.all("agent-a") as Array<{ source_id: string; count: number }>,
		);
		expect(rows).toEqual([{ source_id: "import:same-source", count: 2 }]);
	} finally {
		closeDbAccessor();
		if (oldOwner === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_WORKER");
		else process.env.SIGNET_DB_OWNER_WORKER = oldOwner;
		await rm(root, { recursive: true, force: true });
	}
});
