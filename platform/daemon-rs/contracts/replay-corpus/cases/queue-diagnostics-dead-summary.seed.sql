-- Seed for queue-diagnostics-dead-summary fixture (issue #901).
-- One dead memory_jobs row + two dead summary_jobs rows.

INSERT INTO memories (
	id, type, content, confidence, tags,
	created_at, updated_at, updated_by,
	version, manual_override, is_deleted, embedding_model
) VALUES (
	'mem-1', 'fact', 'seed', 0.9, '[]',
	'2025-12-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z', 'test',
	1, 0, 0, NULL
);

INSERT INTO memory_jobs (
	id, memory_id, job_type, status,
	attempts, max_attempts, created_at, updated_at
) VALUES (
	'dead-mem-1', 'mem-1', 'extract', 'dead',
	3, 3, '2025-12-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z'
);

INSERT INTO summary_jobs (
	id, session_key, harness, project, transcript,
	status, attempts, max_attempts, created_at, error
) VALUES
	('dead-sum-1', 'session-A', 'codex', 'demo', 'transcript', 'dead', 3, 3, '2025-12-01T00:00:00.000Z', 'boom'),
	('dead-sum-2', 'session-B', 'codex', 'demo', 'transcript', 'dead', 3, 3, '2025-12-01T00:00:00.000Z', NULL);
