import { memoriesFtsNeedsTokenizerRepair, readMemoriesFtsSql, recreateMemoriesFts } from "../fts-schema";
import type { MigrationDb } from "./index";

/**
 * Migration 057: Repair legacy porter-tokenized memories_fts tables.
 *
 * Older installs could carry forward `tokenize='porter unicode61'`,
 * which makes lexical recall over-stem soft human queries
 * (`celebrate` -> `celebrity`). Recreate the FTS table with the
 * canonical unicode61 tokenizer and backfill from the external
 * `memories` content table.
 */
export function up(db: MigrationDb): void {
	const sql = readMemoriesFtsSql(db);
	if (sql !== null && !memoriesFtsNeedsTokenizerRepair(sql)) return;
	recreateMemoriesFts(db);
}
