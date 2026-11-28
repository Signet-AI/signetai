import { MIGRATIONS, type MigrationDb } from "@signet/core";
import { runDbOwnerWorker } from "../db-owner-worker";

const migration = MIGRATIONS.find((entry) => entry.version === 183);
if (!migration) throw new Error("Fixture migration missing");
const original = migration.up;
Object.defineProperty(migration, "up", {
	value: (db: MigrationDb): void => {
		original(db);
		db.exec("CREATE TABLE migration_fixture_rows(id INTEGER PRIMARY KEY)");
		const insert = db.prepare("INSERT INTO migration_fixture_rows VALUES(?)");
		if (process.env.SIGNET_DB_OWNER_DB_PATH?.includes("stalled")) {
			insert.run(0);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
			return;
		}
		for (let i = 0; i < 130; i++) {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
			insert.run(i);
		}
	},
});
runDbOwnerWorker();
