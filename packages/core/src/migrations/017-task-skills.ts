/**
 * Migration 017: Task Skills
 *
 * Adds optional skill attachment to scheduled tasks.
 * Tasks can reference a skill by name and specify a mode
 * for how the skill content is integrated into the prompt.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as ReadonlyArray<Record<string, unknown>>;
	const colNames = new Set(cols.flatMap((c) => (typeof c.name === "string" ? [c.name] : [])));

	if (!colNames.has("skill_name")) {
		db.exec("ALTER TABLE scheduled_tasks ADD COLUMN skill_name TEXT");
	}
	if (!colNames.has("skill_mode")) {
		db.exec(
			`ALTER TABLE scheduled_tasks ADD COLUMN skill_mode TEXT
			 CHECK (skill_mode IN ('inject', 'slash') OR skill_mode IS NULL)`,
		);
	}
}
