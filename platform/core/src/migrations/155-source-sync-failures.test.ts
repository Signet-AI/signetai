import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { up } from "./155-source-sync-failures";

describe("migration 155 source sync failures", () => {
	test("creates durable scoped item failures with one active row per source path", () => {
		const db = new Database(":memory:");
		try {
			up(db);
			up(db);
			const columns = db.query("PRAGMA table_info(source_sync_failures)").all() as Array<{ name: string }>;
			expect(columns.map((column) => column.name)).toEqual(
				expect.arrayContaining([
					"agent_id",
					"source_key",
					"phase",
					"item_path",
					"fingerprint",
					"failure_code",
					"terminal",
					"diagnostic",
					"attempt_count",
					"first_observed_at",
					"last_observed_at",
					"resolved_at",
				]),
			);
			const indexes = db.query("PRAGMA index_list(source_sync_failures)").all() as Array<{ name: string }>;
			expect(indexes.map((index) => index.name)).toContain("idx_source_sync_failures_active");
		} finally {
			db.close();
		}
	});
});
