import { expect, test } from "bun:test";
import { compartmentForWrite } from "@signet/core";
import { evidenceCompartmentInTx, recordEvidenceCitationsInTx } from "./db-helpers";
import { classificationFixture } from "./test-support/classification-fixture.test";

test("derived writes union evidence labels and retain citations atomically", () => {
	const db = classificationFixture();
	db.exec(
		"INSERT INTO classifications(id,name) VALUES('cls_hr','HR'),('cls_legal','Legal'); INSERT INTO classification_assignments VALUES('memory','m','default','cls_hr','carol','now')",
	);
	const hr = compartmentForWrite(db, { agentId: "default", memoryId: "m" });
	db.prepare("UPDATE memories SET compartment_id=? WHERE id='m'").run(hr);
	db.exec("INSERT INTO classification_assignments VALUES('memory','other','default','cls_legal','carol','now')");
	const legal = compartmentForWrite(db, { agentId: "default", memoryId: "other" });
	db.prepare(
		"INSERT INTO memories(id,content,agent_id,compartment_id,created_at,updated_at) VALUES('other','legal','default',?,'now','now')",
	).run(legal);
	const evidence = [
		{ kind: "memory", id: "m" },
		{ kind: "memory", id: "other" },
	] as const;
	db.transaction(() => {
		const compartment = evidenceCompartmentInTx(db, "default", evidence);
		db.prepare(
			"INSERT INTO memories(id,content,agent_id,compartment_id,created_at,updated_at) VALUES('derived','joined','default',?,'now','now')",
		).run(compartment);
		expect(
			recordEvidenceCitationsInTx(db, { agentId: "default", derivedKind: "memory", derivedId: "derived", evidence }),
		).toBe(compartment);
	})();
	expect(
		db.prepare("SELECT evidence_id FROM evidence_citations WHERE derived_id='derived' ORDER BY evidence_id").all(),
	).toEqual([{ evidence_id: "m" }, { evidence_id: "other" }]);
	expect(
		db.prepare("SELECT key FROM compartments WHERE id=(SELECT compartment_id FROM memories WHERE id='derived')").get(),
	).toEqual({ key: "cls_hr,cls_legal" });
	expect(() =>
		db.transaction(() => {
			recordEvidenceCitationsInTx(db, {
				agentId: "default",
				derivedKind: "memory",
				derivedId: "rolled-back",
				evidence,
			});
			throw new Error("rollback");
		})(),
	).toThrow("rollback");
	expect(db.prepare("SELECT count(*) n FROM evidence_citations WHERE derived_id='rolled-back'").get()).toEqual({
		n: 0,
	});
	expect(() => evidenceCompartmentInTx(db, "other-agent", evidence)).toThrow("evidence_not_in_agent");
	db.close();
});
