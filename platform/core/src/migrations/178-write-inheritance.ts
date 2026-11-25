import type { MigrationArtifacts, MigrationDb } from "./contract";

const columns = {
	session_checkpoints: { author_user_id: "TEXT" },
	cross_agent_messages: { author_user_id: "TEXT", compartment_id: "INTEGER" },
} as const;
export const artifacts: MigrationArtifacts = {
	columns: Object.entries(columns).flatMap(([table, fields]) =>
		Object.keys(fields).map((column) => ({ table, column })),
	),
	indexes: ["idx_session_checkpoints_author", "idx_cross_agent_messages_compartment"],
};
export function up(db: MigrationDb): void {
	for (const [table, fields] of Object.entries(columns)) {
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
		const present = new Set(
			db
				.prepare(`PRAGMA table_info(${table})`)
				.all()
				.map((row) => row.name),
		);
		for (const [name, definition] of Object.entries(fields)) {
			if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
		}
	}
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_checkpoints'").get())
		db.exec("CREATE INDEX IF NOT EXISTS idx_session_checkpoints_author ON session_checkpoints(author_user_id)");
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cross_agent_messages'").get())
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_cross_agent_messages_compartment ON cross_agent_messages(from_agent_id,compartment_id)",
		);
}
