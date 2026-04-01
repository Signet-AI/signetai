import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS task_scope_hints (
			task_id     TEXT PRIMARY KEY REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
			agent_id    TEXT NOT NULL,
			created_at  TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
		);

		INSERT INTO task_scope_hints (task_id, agent_id, created_at, updated_at)
		SELECT st.id,
		       -- MIN(agent_id) is safe here because HAVING enforces exactly one distinct owner.
		       MIN(sm.agent_id),
		       datetime('now'),
		       datetime('now')
		  FROM scheduled_tasks st
		  JOIN entities e
		    ON e.entity_type = 'skill'
		   AND lower(e.name) = lower(st.skill_name)
		  JOIN skill_meta sm
		    ON sm.entity_id = e.id
		   AND sm.agent_id = e.agent_id
		   AND sm.uninstalled_at IS NULL
		 WHERE st.skill_name IS NOT NULL
		 GROUP BY st.id, lower(st.skill_name)
		HAVING COUNT(DISTINCT sm.agent_id) = 1
		ON CONFLICT(task_id) DO NOTHING;

		CREATE INDEX IF NOT EXISTS idx_task_scope_hints_agent
			ON task_scope_hints(agent_id, updated_at);
	`);
}
