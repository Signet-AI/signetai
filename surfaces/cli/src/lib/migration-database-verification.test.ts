import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyMigrationDatabaseRows } from "../sqlite";

test("migration semantic verifier rejects altered transcript role and provenance", () => {
	const root = mkdtempSync(join(tmpdir(), "migration-semantic-"));
	try {
		const source = join(root, "source.db");
		const destination = join(root, "destination.db");
		const db = new Database(source, { create: true });
		db.exec("CREATE TABLE session_turns (session_id TEXT, ordinal INTEGER, role TEXT, provenance TEXT, text TEXT)");
		db.query("INSERT INTO session_turns VALUES (?, ?, ?, ?, ?)").run(
			"session-a",
			1,
			"user",
			"source-line:1",
			"line 1\nline 2",
		);
		db.close();
		copyFileSync(source, destination);
		const altered = new Database(destination);
		altered.exec("UPDATE session_turns SET role = 'assistant', provenance = 'fabricated'");
		altered.close();
		expect(() => verifyMigrationDatabaseRows(source, destination)).toThrow("session_turns");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
