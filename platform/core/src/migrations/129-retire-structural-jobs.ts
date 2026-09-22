import type { MigrationDb } from "./contract";

function tableExists(db: MigrationDb, table: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}
export function up(db: MigrationDb): void {
	if (!tableExists(db, "memory_jobs")) return;
	if (!tableExists(db, "job_cancellations")) {
		throw new Error("job_cancellations table missing; cannot retire structural jobs without an audit trail");
	}
	db.prepare(`
		INSERT INTO job_cancellations (
			id, source_table, source_id, status_before, payload_json,
			reason, actor, actor_type, request_id, created_at
		)
		SELECT
			'retire-structural-jobs-129:' || id,
			'memory_jobs',
			id,
			status,
			json_object(
				'id', id,
				'memory_id', memory_id,
				'document_id', document_id,
				'job_type', job_type,
				'status', status,
				'payload', payload,
				'result', result,
				'attempts', attempts,
				'max_attempts', max_attempts,
				'leased_at', leased_at,
				'completed_at', completed_at,
				'failed_at', failed_at,
				'error', error,
				'created_at', created_at,
				'updated_at', updated_at
			),
			'retired structural queue after Dreaming cutover',
			'migration:129',
			'system',
			NULL,
			strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		FROM memory_jobs
		WHERE job_type IN ('structural_classify', 'structural_dependency')
		  AND status IN ('pending', 'leased');
	`).run();

	db.exec(`
		UPDATE memory_jobs
		SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE job_type IN ('structural_classify', 'structural_dependency')
		  AND status IN ('pending', 'leased');
	`);
}
