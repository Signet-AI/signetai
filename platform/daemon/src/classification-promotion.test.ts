import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSqliteVecExtension, compartmentFor } from "@signet/core";
import { currentClassificationFixture } from "./test-support/classification-fixture.test";
import { createDbOwnerClient } from "./db-owner-client";
import { initDbAccessorLite, getDbAccessor, closeDbAccessor } from "./db-accessor";
import { promoteStagingIndex } from "./embedding-index-migration";

async function promotion(virtual: boolean, fault = false): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "classified-promotion-")),
		path = join(directory, "memory.db"),
		db = currentClassificationFixture();
	const extension = findSqliteVecExtension();
	if (!extension) throw new Error("sqlite-vec required");
	db.loadExtension(extension);
	db.exec("INSERT INTO classifications(id,name) VALUES('cls_hr','HR')");
	const c = compartmentFor(db, ["cls_hr"]);
	db.prepare("UPDATE memories SET compartment_id=? WHERE id='m'").run(c);
	for (const [base, dims] of [
		["vec_embeddings", 3],
		["vec_embeddings_staging", 4],
	] as const)
		for (const table of [base, `${base}__c${c}`]) {
			db.exec(`DROP TABLE IF EXISTS ${table}`);
			db.exec(
				virtual
					? `CREATE VIRTUAL TABLE ${table} USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[${dims}] distance_metric=cosine)`
					: `CREATE TABLE ${table}(id TEXT PRIMARY KEY,embedding BLOB)`,
			);
		}
	for (const [store, id, vector, dims, projection] of [
		["embeddings", "old", new Float32Array([1, 0, 0]), 3, "vec_embeddings"],
		["embeddings_staging", "new", new Float32Array([0, 1, 0, 0]), 4, "vec_embeddings_staging"],
	] as const) {
		if (
			!db
				.prepare(`PRAGMA table_info(${store})`)
				.all()
				.some(
					(row) => typeof row === "object" && row !== null && "name" in row && row.name === "projection_compartment_id",
				)
		)
			db.exec(`ALTER TABLE ${store} ADD COLUMN projection_compartment_id INTEGER`);
		db.prepare(
			`INSERT INTO ${store}(id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at,agent_id,compartment_id,projection_compartment_id) VALUES (?,'hash',?,?,'memory','m','claim','now','default',?,?)`,
		).run(id, vector, dims, c, c);
		db.prepare(`INSERT INTO ${projection}__c${c}(id,embedding) VALUES(?,?)`).run(id, vector);
	}
	const active = {
		fingerprint: "old",
		provider: "ollama",
		model: "old",
		dimensions: 3,
		baseUrl: "http://127.0.0.1:1",
		projectionSlot: "active",
	};
	const staged = { ...active, fingerprint: "new", model: "new", dimensions: 4, projectionSlot: "staging" };
	db.prepare(
		"INSERT INTO embedding_index_state(id,active_profile_json,staging_profile_json,state,created_at,updated_at) VALUES(1,?,?,'building','now','now')",
	).run(JSON.stringify(active), JSON.stringify(staged));
	db.prepare("VACUUM INTO ?").run(path);
	db.close();
	const owner = createDbOwnerClient({ dbPath: path });
	try {
		initDbAccessorLite(path, extension);
		await owner.start();
		if (virtual) {
			await promoteStagingIndex(getDbAccessor(), { owner, shouldContinue: () => false }).catch(() => false);
			const old = await owner.submit(
				{ kind: "query", statement: { sql: "SELECT id,dimensions FROM embeddings", result: "all", readonly: true } },
				{ operation: "test.cancelled-state", lane: "read", deadlineMs: 5000 },
			).result;
			expect(old).toEqual([{ id: "old", dimensions: 3 }]);
		}
		if (fault) {
			await owner.submit(
				{
					kind: "query",
					statement: {
						sql: "CREATE TRIGGER crash_promotion BEFORE UPDATE ON embedding_index_state WHEN new.state='ready' BEGIN SELECT RAISE(ABORT,'promotion crash');END",
						result: "run",
					},
				},
				{ operation: "test.promotion-fault", lane: "maintenance", deadlineMs: 5000 },
			).result;
			await expect(promoteStagingIndex(getDbAccessor(), { owner })).rejects.toThrow("promotion crash");
			const before = await owner.submit(
				{ kind: "query", statement: { sql: `SELECT id FROM vec_embeddings__c${c}`, result: "all" } },
				{ operation: "test.rolled-back-generation", lane: "read", deadlineMs: 5000 },
			).result;
			expect(before).toEqual([{ id: "old" }]);
			await owner.submit(
				{ kind: "query", statement: { sql: "DROP TRIGGER crash_promotion", result: "run" } },
				{ operation: "test.promotion-retry", lane: "maintenance", deadlineMs: 5000 },
			).result;
		}
		expect(await promoteStagingIndex(getDbAccessor(), { owner })).toBe(true);
		const state = await owner.submit(
			{
				kind: "query",
				statement: {
					sql: "SELECT json_extract(active_profile_json,'$.projectionSlot') slot,json_extract(active_profile_json,'$.dimensions') dimensions,state FROM embedding_index_state",
					result: "get",
					readonly: true,
				},
			},
			{ operation: "test.profile", lane: "read", deadlineMs: 5000 },
		).result;
		const slot =
			typeof state === "object" && state !== null && "slot" in state && state.slot === "staging"
				? "vec_embeddings_staging"
				: "vec_embeddings";
		const query = virtual
			? `SELECT id FROM ${slot}__c${c} WHERE embedding MATCH ? AND k=1`
			: `SELECT id FROM ${slot}__c${c}`;
		const result = await owner.submit(
			{
				kind: "query",
				statement: {
					sql: query,
					params: virtual
						? [{ type: "bytes", base64: Buffer.from(new Float32Array([0, 1, 0, 0]).buffer).toString("base64") }]
						: [],
					result: "all",
					readonly: !virtual,
				},
			},
			{ operation: "test.active-shard", lane: "read", deadlineMs: 5000 },
		).result;
		expect(result).toEqual([{ id: "new" }]);
		expect(state).toMatchObject({ dimensions: 4, state: "ready" });
		const job = await owner.submit(
			{
				kind: "classification",
				request: {
					op: "enqueue",
					id: "cls_hr",
					actor: {
						userId: "carol",
						groupIds: [],
						local: false,
						compliance: true,
						boundAgentId: null,
						allowedProjects: null,
						credential: "session:test",
					},
					target: { kind: "memory", id: "m", agentId: "default" },
					remove: false,
				},
			},
			{ operation: "test.reclassify-promoted", lane: "maintenance", deadlineMs: 10000 },
		).result;
		if (typeof job !== "object" || job === null || !("jobId" in job) || typeof job.jobId !== "string")
			throw new Error("missing job");
		let classificationResult: unknown;
		for (let turn = 0; turn < 100; turn++) {
			classificationResult = await owner.submit(
				{ kind: "classification", request: { op: "execute", jobId: job.jobId } },
				{ operation: "test.move-both-generations", lane: "maintenance", deadlineMs: 10000 },
			).result;
			if (
				typeof classificationResult === "object" &&
				classificationResult !== null &&
				"status" in classificationResult &&
				classificationResult.status === "complete"
			)
				break;
		}
		expect(classificationResult).toMatchObject({ status: "complete" });
	} finally {
		await closeDbAccessor();
		await owner.close();
		rmSync(directory, { recursive: true, force: true });
	}
}
test("ordinary vector promotion swaps classified shards atomically", () => promotion(false), 20000);
test("failed vector publication rolls back every generation and retries cleanly", () => promotion(true, true), 20000);
test("sqlite vec dimension promotion publishes the classified generation atomically", () => promotion(true), 20000);
