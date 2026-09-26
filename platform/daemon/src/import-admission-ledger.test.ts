import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { up as admissionMigration } from "../../core/src/migrations/160-import-admission-ledger";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { createDbOwnerClient, type DbOwnerClient } from "./db-owner-client";
import {
	closeRegisteredDbOwnerMaintenance,
	createDbOwnerMaintenance,
	registerDbOwnerMaintenance,
} from "./db-owner-maintenance";
import { DbOwnedImportAdmissionLedger } from "./import-admission-ledger";
import { ImportAdmissionConflictError } from "./import-inbox";

let root = "";
let owner: DbOwnerClient;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "import-admission-ledger-"));
	const path = join(root, "test.db");
	const db = new Database(path);
	admissionMigration({
		exec: (sql) => db.exec(sql),
		prepare: (sql) => db.query(sql),
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

test("keys are isolated by agent and workspace, while conflicts stay scoped", async () => {
	const row = {
		key: "scoped",
		fileName: "a.txt",
		status: "pending" as const,
		originalPath: "/a",
		sha256: "abc",
		size: 3,
	};
	const a1 = new DbOwnedImportAdmissionLedger(getDbAccessor(), { agentId: "a", workspaceId: "one" });
	const a2 = new DbOwnedImportAdmissionLedger(getDbAccessor(), { agentId: "a", workspaceId: "two" });
	const b1 = new DbOwnedImportAdmissionLedger(getDbAccessor(), { agentId: "b", workspaceId: "one" });
	await Promise.all([a1.upsert(row), a2.upsert(row), b1.upsert(row)]);
	await expect(a1.upsert({ ...row, sha256: "different" })).rejects.toBeInstanceOf(ImportAdmissionConflictError);
	expect(await a1.list()).toHaveLength(1);
	expect(await a2.list()).toHaveLength(1);
	expect(await b1.list()).toHaveLength(1);
	const events = getDbAccessor().withReadDb((db) =>
		db
			.prepare(
				"SELECT agent_id, workspace_id, event FROM import_admission_events WHERE admission_key='scoped' ORDER BY agent_id, workspace_id",
			)
			.all(),
	);
	expect(events).toEqual([
		{ agent_id: "a", workspace_id: "one", event: "admitted" },
		{ agent_id: "a", workspace_id: "two", event: "admitted" },
		{ agent_id: "b", workspace_id: "one", event: "admitted" },
	]);
});

test("migration 158 upgrades the prior global-key fixture without losing rows or events", async () => {
	const db = new Database(join(root, "legacy.db"));
	db.exec(
		`CREATE TABLE import_admission_ledger (key TEXT PRIMARY KEY, file_name TEXT NOT NULL, status TEXT NOT NULL, original_path TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE import_admission_events (id INTEGER PRIMARY KEY AUTOINCREMENT, admission_key TEXT NOT NULL, event TEXT NOT NULL, created_at TEXT NOT NULL);`,
	);
	db.exec(
		"INSERT INTO import_admission_ledger VALUES ('legacy','old.txt','imported','/old','abc',3,'t','t'); INSERT INTO import_admission_events(admission_key,event,created_at) VALUES ('legacy','admitted','t');",
	);
	admissionMigration({
		exec: (sql) => db.exec(sql),
		prepare: (sql) => db.query(sql),
	});
	admissionMigration({
		exec: (sql) => db.exec(sql),
		prepare: (sql) => db.query(sql),
	});
	db.exec(
		"INSERT INTO import_admission_ledger (key, agent_id, workspace_id, file_name, status, original_path, sha256, size_bytes, created_at, updated_at) VALUES ('legacy','other-agent','other-workspace','new.txt','pending','/new','def',3,'t','t')",
	);
	expect(
		db.query("SELECT key, agent_id, workspace_id, file_name FROM import_admission_ledger ORDER BY agent_id").all(),
	).toEqual([
		{ key: "legacy", agent_id: "", workspace_id: "", file_name: "old.txt" },
		{ key: "legacy", agent_id: "other-agent", workspace_id: "other-workspace", file_name: "new.txt" },
	]);
	expect(db.query("SELECT admission_key, agent_id, workspace_id, event FROM import_admission_events").all()).toEqual([
		{ admission_key: "legacy", agent_id: "", workspace_id: "", event: "admitted" },
	]);
	db.close(true);
});
