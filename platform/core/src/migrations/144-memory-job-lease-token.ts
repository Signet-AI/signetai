import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const columns = new Set(
		(db.prepare("PRAGMA table_info(memory_jobs)").all() as Array<{ name?: unknown }>)
			.map((row) => row.name)
			.filter((name): name is string => typeof name === "string"),
	);
	if (!columns.has("lease_token")) {
		db.exec("ALTER TABLE memory_jobs ADD COLUMN lease_token TEXT");
	}
}
