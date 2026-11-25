import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classificationFixture } from "./test-support/classification-fixture.test";
import { classificationRequest } from "./classifications";
import { initDbAccessorLite, closeDbAccessor } from "./db-accessor";
import { createDbOwnerClient } from "./db-owner-client";
import { createDbOwnerMaintenance, registerDbOwnerMaintenance } from "./db-owner-maintenance";

test("readable compartment reads overtake queued maintenance work", async () => {
	const directory = mkdtempSync(join(tmpdir(), "classification-lane-")),
		path = join(directory, "memory.db");
	const db = classificationFixture();
	db.prepare("VACUUM INTO ?").run(path);
	db.close();
	const owner = createDbOwnerClient({ dbPath: path });
	try {
		initDbAccessorLite(path, "");
		registerDbOwnerMaintenance(createDbOwnerMaintenance({ dbPath: path, owner }));
		await owner.start();
		const first = owner.submit(
			{ kind: "sleep", durationMs: 100 },
			{ operation: "test.first", lane: "maintenance", deadlineMs: 5000, estimatedWorkUnits: 1 },
		);
		for (let n = 0; owner.health().activeJobId !== first.job.id; n++) {
			if (n > 100) throw new Error("first job never active");
			await Bun.sleep(2);
		}
		const second = owner.submit(
			{ kind: "sleep", durationMs: 100 },
			{ operation: "test.second", lane: "maintenance", deadlineMs: 5000, estimatedWorkUnits: 1 },
		);
		const read = classificationRequest({ op: "readable", subject: { local: false, userId: "alice", groupIds: [] } });
		expect(await Promise.race([read.then(() => "read"), second.result.then(() => "maintenance")])).toBe("read");
		await Promise.all([first.result, second.result, read]);
	} finally {
		await closeDbAccessor();
		await owner.close();
		rmSync(directory, { recursive: true, force: true });
	}
}, 10000);
