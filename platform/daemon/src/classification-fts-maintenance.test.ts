import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compartmentFor } from "@signet/core";
import { classificationFixture } from "./test-support/classification-fixture.test";
import { createDbOwnerClient } from "./db-owner-client";
import { createDbOwnerMaintenance } from "./db-owner-maintenance";

async function partitionedMaintenance(rebuild: boolean): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "classification-fts-review-")),
		path = join(dir, "memory.db");
	const db = classificationFixture();
	db.exec("INSERT INTO classifications(id,name) VALUES('cls_hr','HR')");
	const c = compartmentFor(db, ["cls_hr"]);
	db.prepare(
		"INSERT INTO memories(id,content,agent_id,compartment_id,created_at,updated_at) VALUES('hidden','classifiedquartz','default',?,'now','now')",
	).run(c);
	db.prepare("VACUUM INTO ?").run(path);
	db.close();
	const owner = createDbOwnerClient({ dbPath: path }),
		maintenance = createDbOwnerMaintenance({ dbPath: path, owner });
	try {
		if (rebuild) await maintenance.rebuildFts();
		else await maintenance.backfillFts();
		await owner.submit(
			{
				kind: "query",
				statement: { sql: "UPDATE memories SET content='classifiedquartz changed' WHERE id='hidden'", result: "run" },
			},
			{ operation: "test.hidden-update", lane: "write", deadlineMs: 5000 },
		).result;
		const result = await owner.submit(
			{
				kind: "query",
				statement: {
					sql: "SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH 'classifiedquartz'",
					result: "get",
					readonly: true,
				},
			},
			{ operation: "test.base-count", lane: "read", deadlineMs: 5000 },
		).result;
		expect(result).toEqual({ n: 0 });
		const shard = await owner.submit(
			{
				kind: "query",
				statement: {
					sql: `SELECT count(*) n FROM memories_fts__c${c} WHERE memories_fts__c${c} MATCH 'classifiedquartz'`,
					result: "get",
					readonly: true,
				},
			},
			{ operation: "test.shard-count", lane: "read", deadlineMs: 5000 },
		).result;
		expect(shard).toEqual({ n: 1 });
		const state = await owner.submit(
			{
				kind: "query",
				statement: { sql: "SELECT memory_count,indexed_count FROM memories_fts_state", result: "get", readonly: true },
			},
			{ operation: "test.state", lane: "read", deadlineMs: 5000 },
		).result;
		expect(state).toEqual({ memory_count: 1, indexed_count: 1 });
	} finally {
		await maintenance.close();
		await owner.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
test("FTS maintenance ensure preserves base partition through a classified update", () =>
	partitionedMaintenance(false));
test("FTS owner rebuild preserves base partition and reconstructs classified shards", () =>
	partitionedMaintenance(true));
