import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { up as admissionMigration } from "../../core/src/migrations/158-import-admission-ledger";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { createDbOwnerClient, type DbOwnerClient } from "./db-owner-client";
import {
	closeRegisteredDbOwnerMaintenance,
	createDbOwnerMaintenance,
	registerDbOwnerMaintenance,
} from "./db-owner-maintenance";
import { DbOwnedImportAdmissionLedger } from "./import-admission-ledger";

let root = "";
let owner: DbOwnerClient;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "import-admission-ledger-"));
	const path = join(root, "test.db");
	const db = new Database(path);
	admissionMigration({
		exec: (sql) => db.exec(sql),
		prepare: () => {
			throw new Error("prepare is not used by this migration");
		},
	});
	db.close(true);
	await closeDbAccessor();
	initDbAccessor(path);
	owner = createDbOwnerClient({ dbPath: path });
	await owner.start();
	registerDbOwnerMaintenance(createDbOwnerMaintenance({ dbPath: path, owner }));
});

afterEach(async () => {
	await closeRegisteredDbOwnerMaintenance();
	await owner.close();
	await closeDbAccessor();
	rmSync(root, { recursive: true, force: true });
});

test("concurrent identical admissions converge on one durable row", async () => {
	const ledger = new DbOwnedImportAdmissionLedger(getDbAccessor(), { agentId: "a" });
	const row = {
		key: "same",
		fileName: "note.txt",
		status: "pending" as const,
		originalPath: join(root, "original"),
		sha256: "abc",
		size: 3,
	};
	const results = await Promise.all(Array.from({ length: 8 }, () => ledger.upsert(row)));
	expect(results).toHaveLength(8);
	expect(results.every((result) => result.key === "same")).toBe(true);
	expect(await ledger.list()).toHaveLength(1);
}, 20_000);
