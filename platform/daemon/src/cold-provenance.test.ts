import { expect, test } from "bun:test";
import { z } from "zod";
import { currentClassificationFixture } from "./test-support/classification-fixture.test";
import { executeClassification } from "./classification-owner";
import { archiveToCold } from "./pipeline/retention-worker";
import { purgeColdEvidenceInTx, purgeMemoryInTx } from "./source-purge-tx";

const actor = {
	userId: "carol",
	groupIds: [],
	local: false,
	compliance: true,
	boundAgentId: null,
	allowedProjects: null,
	credential: "session:test",
} as const;

test("cold copies inherit labels and follow classification and reclassification", () => {
	const db = currentClassificationFixture();
	try {
		archiveToCold(db, ["m"], "fixture");
		const label = z.object({ id: z.string() }).parse(
			executeClassification(db, {
				op: "create",
				actor,
				name: "Cold secret",
				color: null,
				description: null,
				audience: [{ kind: "user", id: "carol" }],
				appliers: [],
			}),
		);
		for (const remove of [false, true]) {
			const job = z.object({ jobId: z.string() }).parse(
				executeClassification(db, {
					op: "enqueue",
					actor,
					id: label.id,
					target: { kind: "memory", id: "m", agentId: "default" },
					remove,
				}),
			);
			for (
				let step = 0;
				step < 100 && db.prepare("SELECT status FROM org_jobs WHERE id=?").get(job.jobId)?.status !== "complete";
				step++
			)
				executeClassification(db, { op: "execute", jobId: job.jobId });
			expect(db.prepare("SELECT status FROM org_jobs WHERE id=?").get(job.jobId)?.status).toBe("complete");
			const source = db.prepare("SELECT compartment_id FROM memories WHERE id='m'").get();
			expect(db.prepare("SELECT compartment_id FROM memories_cold WHERE memory_id='m'").get()).toEqual(source);
			expect(source?.compartment_id === null).toBe(remove);
		}
	} finally {
		db.close();
	}
});

test("evidence deletion purges cold-only source copies", () => {
	const db = currentClassificationFixture();
	try {
		db.exec("UPDATE memories SET source_id='cold-source',source_type='transcript' WHERE id='m'");
		archiveToCold(db, ["m"], "fixture");
		db.exec("DELETE FROM memories WHERE id='m'");
		expect(purgeColdEvidenceInTx(db, "cold-source", "default")).toBe(1);
		expect(db.prepare("SELECT COUNT(*) AS n FROM memories_cold").get()).toEqual({ n: 0 });
	} finally {
		db.close();
	}
});

test("hard memory deletion also removes a cold-only copy", () => {
	const db = currentClassificationFixture();
	try {
		archiveToCold(db, ["m"], "fixture");
		db.exec("DELETE FROM memories WHERE id='m'");
		purgeMemoryInTx(db, "m");
		expect(db.prepare("SELECT COUNT(*) AS n FROM memories_cold").get()).toEqual({ n: 0 });
	} finally {
		db.close();
	}
});
