/**
 * Migration 027: Backfill NULL canonical_name on entities
 *
 * Migration 005 added the canonical_name column but never backfilled
 * existing rows, leaving them NULL. This causes the upsertEntity
 * lookup (which queries by canonical_name) to miss existing entities,
 * leading to UNIQUE constraint violations on the name column during
 * skill reconciliation and extraction.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	// Match toCanonicalName(): trim, lowercase, collapse internal whitespace.
	// SQLite lacks regex replace, so iteratively collapse double-spaces
	// (covers the realistic cases; triple+ spaces converge after a few passes).
	db.exec(`
		UPDATE entities
		SET canonical_name = REPLACE(REPLACE(REPLACE(
			LOWER(TRIM(name)),
			'  ', ' '), '  ', ' '), '  ', ' ')
		WHERE canonical_name IS NULL
	`);
}
