import { memoriesFtsNeedsTokenizerRepair, readMemoriesFtsSql, recreateMemoriesFts } from "../fts-schema";
import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const sql = readMemoriesFtsSql(db);
	if (sql !== null && !memoriesFtsNeedsTokenizerRepair(sql)) return;
	recreateMemoriesFts(db);
}
