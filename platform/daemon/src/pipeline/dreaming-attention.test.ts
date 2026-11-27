import { up as upgradeDreamingPartitions } from "../../../core/src/migrations/179-dreaming-evidence-leases";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { ReadScope } from "../read-scope";
import {
	enqueueDreamingAttentionInTx,
	getDreamingAttentionInDb,
	hasDreamingAttentionKindInDb,
	getDreamingAttentionScoped,
	getDreamingAttentionAcrossScopes,
	getDreamingAttentionById,
	getDreamingAttentionWorkloadDiagnostics,
	getDreamingAttentionSnapshots,
} from "./dreaming-attention";

const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
const scope: ReadScope = { reach: { kind: "own", agentId: "a" }, compartments: [], projects: null };
function fixture() {
	const db = new Database(":memory:");
	databases.push(db);
	db.exec(`CREATE TABLE dreaming_attention(id TEXT, agent_id TEXT, compartment_id INTEGER, kind TEXT, subject_ref TEXT, details_json TEXT, priority INTEGER, created_at TEXT, generation INTEGER, resolved_at TEXT);
		INSERT INTO dreaming_attention VALUES('public','a',NULL,'hygiene','public','{}',1,'2026-11-25',1,NULL),('secret','a',1,'review_due','secret','{}',100,'2026-11-24',1,NULL),('other','b',NULL,'review_due','other','{}',100,'2026-11-24',1,NULL);`);
	return db;
}
describe("Dreaming attention read scope", () => {
	it("filters hidden attention before LIMIT and existence checks", () => {
		const db = fixture();
		expect(getDreamingAttentionInDb(db, "a", 1, scope).map((row) => row.id)).toEqual(["public"]);
		expect(hasDreamingAttentionKindInDb(db, "a", ["review_due"], scope)).toBe(false);
		expect(hasDreamingAttentionKindInDb(db, "a", ["hygiene"], scope)).toBe(true);
	});
	it("fails closed on project restricted attention without a project column", () => {
		expect(getDreamingAttentionInDb(fixture(), "a", 20, { ...scope, projects: ["project"] })).toEqual([]);
	});
});

describe("Dreaming attention client reads", () => {
	it("scopes paged lists, snapshots, id lookups and workload counts consistently", async () => {
		const dir = mkdtempSync(join(tmpdir(), "attention-scope-"));
		try {
			initDbAccessor(join(dir, "memory.db"));
			const accessor = getDbAccessor();
			accessor.withWriteTx((db) =>
				db.exec(`INSERT INTO dreaming_attention(id,agent_id,compartment_id,kind,subject_ref,priority,created_at) VALUES
				('visible','a',NULL,'hygiene','visible',1,'2026-11-25 00:00:00'),
				('hidden','a',1,'hygiene','hidden',100,'2026-11-24 00:00:00'),
				('other','b',NULL,'hygiene','other',100,'2026-11-24 00:00:00');`),
			);
			expect(
				(await getDreamingAttentionScoped(accessor, "a", { readScope: scope, limit: 1 })).map((row) => row.id),
			).toEqual(["visible"]);
			expect(
				(await getDreamingAttentionAcrossScopes(accessor, { readScope: scope, limit: 1 })).map((row) => row.id),
			).toEqual(["visible"]);
			expect(getDreamingAttentionSnapshots(accessor, "a", 1, scope).map((row) => row.id)).toEqual(["visible"]);
			expect(getDreamingAttentionById(accessor, { agentId: "a", id: "hidden", readScope: scope })).toBeNull();
			expect(getDreamingAttentionById(accessor, { agentId: "a", id: "visible", readScope: scope })?.id).toBe("visible");
			expect(getDreamingAttentionWorkloadDiagnostics(accessor, "a", Date.parse("2026-11-25T01:00:00Z"), scope)).toEqual(
				{ pending: 1, oldestAgeMs: 3_600_000 },
			);
		} finally {
			await closeDbAccessor();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Dreaming attention partition writes", () => {
	for (const labels of [
		[1, null],
		[null, 1],
	]) {
		it(`keeps equal subjects independent in label order ${JSON.stringify(labels)}`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "attention-write-"));
			try {
				initDbAccessor(join(dir, "memory.db"));
				getDbAccessor().withWriteTx((db) => {
					upgradeDreamingPartitions(db);
					db.exec(
						"INSERT INTO entities(id,agent_id,name,entity_type,created_at,updated_at) VALUES('person','default','Alice','person','now','now')",
					);
					const parent = db.prepare("SELECT * FROM entities WHERE id='person'").get();
					const ids = labels.map((compartmentId) =>
						enqueueDreamingAttentionInTx(db, {
							agentId: "default",
							kind: "hygiene",
							subjectRef: "entity:person",
							compartmentId,
							details: { reason: compartmentId === null ? "public" : "secret" },
							priority: 10,
						}),
					);
					expect(ids[0]).not.toBe(ids[1]);
					for (const [index, compartmentId] of labels.entries()) {
						const before = db.prepare("SELECT * FROM dreaming_attention WHERE id=?").get(ids[1 - index]);
						expect(
							enqueueDreamingAttentionInTx(db, {
								agentId: "default",
								kind: "hygiene",
								subjectRef: "entity:person",
								compartmentId,
								details: { reason: "updated" },
								priority: 30,
							}),
						).toBe(ids[index]);
						expect(db.prepare("SELECT * FROM dreaming_attention WHERE id=?").get(ids[1 - index])).toEqual(before);
					}
					expect(db.prepare("SELECT * FROM entities WHERE id='person'").get()).toEqual(parent);
				});
			} finally {
				await closeDbAccessor();
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});
