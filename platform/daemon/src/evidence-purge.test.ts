import { up as up178 } from "../../core/src/migrations/178-write-inheritance";
import { expect, test } from "bun:test";
import { classificationFixture } from "./test-support/classification-fixture.test";
import { writeCommunityProjectionInTx } from "./db-helpers";

test("missing community evidence fails only its item and removes stale citations", () => {
	const db = classificationFixture();
	up178(db);
	db.exec("INSERT INTO evidence_citations VALUES('entity','e','default','memory','missing')");
	expect(
		writeCommunityProjectionInTx(db, { id: "broken", agentId: "default", name: null, cohesion: 0, memberIds: ["e"] }),
	).toBe(false);
	expect(db.prepare("SELECT 1 FROM evidence_citations WHERE evidence_id='missing'").get()).toBeNull();
	expect(
		writeCommunityProjectionInTx(db, { id: "healthy", agentId: "default", name: null, cohesion: 0, memberIds: ["e"] }),
	).toBe(true);
	db.close();
});

test("evidence deletion closes citations and deletes only unsupported derivatives atomically", () => {
	const db = classificationFixture();
	db.exec(
		"INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES('remaining','R','r','concept','default','now','now'); INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('other','other','default','now','now'); INSERT INTO evidence_citations VALUES('entity','remaining','default','memory','m'),('entity','remaining','default','memory','other')",
	);
	db.exec("BEGIN; DELETE FROM memories WHERE id='m'");
	expect(db.prepare("SELECT id FROM entities ORDER BY id").all()).toEqual([{ id: "remaining" }]);
	expect(db.prepare("SELECT evidence_id FROM evidence_citations").all()).toEqual([{ evidence_id: "other" }]);
	db.exec("ROLLBACK");
	expect(db.prepare("SELECT id FROM entities ORDER BY id").all()).toEqual([{ id: "e" }, { id: "remaining" }]);
	db.close();
});

test("purging evidence removes a transitive memory copy chain on reopened owner connections", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { initDbAccessor, closeDbAccessor } = await import("./db-accessor");
	const { closeDbOwner } = await import("./db-owner-runtime");
	const { organizationWrite, organizationQuery, statement } = await import("./auth/organization-store");
	const root = mkdtempSync(join(tmpdir(), "evidence-purge-owner-"));
	try {
		initDbAccessor(join(root, "signet.db"), { agentsDir: root });
		await closeDbAccessor();
		initDbAccessor(join(root, "signet.db"), { agentsDir: root });
		await organizationWrite([
			statement(
				"INSERT INTO memories(id,content,agent_id,author_user_id,created_at,updated_at) VALUES('original','Original','default',NULL,'now','now'),('copy-a','Copy A','default',NULL,'now','now'),('copy-b','Copy B','default',NULL,'now','now')",
			),
			statement(
				"INSERT INTO evidence_citations VALUES('memory','copy-a','default','memory','original'),('memory','copy-b','default','memory','copy-a')",
			),
		]);
		await expect(
			organizationWrite([
				statement("DELETE FROM memories WHERE id='original'"),
				statement("INSERT INTO missing_purge_table VALUES(1)"),
			]),
		).rejects.toThrow("no such table");
		expect(await organizationQuery(statement("SELECT count(*) n FROM memories", [], "get"))).toEqual({ n: 3 });
		await organizationWrite([statement("DELETE FROM memories WHERE id='original'")]);
		expect(await organizationQuery(statement("SELECT count(*) n FROM memories", [], "get"))).toEqual({ n: 0 });
		expect(await organizationQuery(statement("SELECT count(*) n FROM evidence_citations", [], "get"))).toEqual({
			n: 0,
		});
	} finally {
		await closeDbOwner();
		await closeDbAccessor();
		rmSync(root, { recursive: true, force: true });
	}
});

test("message sender agent and session classification guard is enforced", () => {
	const db = classificationFixture();
	db.exec(
		"INSERT INTO classifications(id,name) VALUES('cls_secret','Secret'); INSERT INTO classification_assignments(target_kind,target_id,agent_id,classification_id) VALUES('session','sender-session','default','cls_secret')",
	);
	expect(() =>
		db
			.prepare(
				"INSERT INTO cross_agent_messages(id,from_agent_id,from_session_key,content,message_type,broadcast,delivery_path,delivery_status,created_at,expires_at) VALUES('msg','default','sender-session','hidden','info',1,'local','delivered','now','later')",
			)
			.run(),
	).toThrow("compartment_required");
	db.close();
});

test("purge recompute relabels surviving derivatives", async () => {
	const { executeClassification } = await import("./classification-owner");
	const { compartmentFor } = await import("@signet/core");
	const db = classificationFixture();
	db.exec("INSERT INTO classifications(id,name) VALUES('cls_secret','Secret')");
	const label = compartmentFor(db, ["cls_secret"]);
	db.prepare("UPDATE memories SET compartment_id=? WHERE id='m'").run(label);
	db.prepare("UPDATE entities SET compartment_id=? WHERE id='e'").run(label);
	db.exec(
		"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('other','other','default','now','now'); INSERT INTO evidence_citations VALUES('entity','e','default','memory','other'); DELETE FROM memories WHERE id='m'",
	);
	const job = db.prepare("SELECT id FROM org_jobs WHERE kind='recompute'").get();
	if (typeof job?.id !== "string") throw new Error("missing recompute job");
	for (let i = 0; i < 50; i++) {
		const result = executeClassification(db, { op: "execute", jobId: job.id });
		if (typeof result === "object" && result !== null && "status" in result && result.status === "complete") break;
	}
	expect(db.prepare("SELECT compartment_id FROM entities WHERE id='e'").get()).toEqual({ compartment_id: null });
	db.close();
});
