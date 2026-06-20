INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at) VALUES
  ('agent-a', 'Agent A', 'isolated', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('agent-b', 'Agent B', 'isolated', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT INTO memories (
  id, type, content, source_id, source_type, tags, created_at, updated_at, updated_by,
  importance, content_hash, normalized_content, extraction_status, agent_id, visibility, scope
) VALUES
  (
    'mem-recall-agent-a-global', 'fact', 'scoped replay marker visible to agent a globally',
    'replay-recall-a-global', 'replay-fixture', 'replay,scope',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'replay-fixture',
    0.9, 'sha256:replay-a-global', 'scoped replay marker visible to agent a globally',
    'none', 'agent-a', 'global', NULL
  ),
  (
    'mem-recall-agent-a-private', 'fact', 'scoped replay marker private to agent a',
    'replay-recall-a-private', 'replay-fixture', 'replay,scope',
    '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z', 'replay-fixture',
    0.8, 'sha256:replay-a-private', 'scoped replay marker private to agent a',
    'none', 'agent-a', 'private', NULL
  ),
  (
    'mem-recall-agent-b-global', 'fact', 'scoped replay marker globally visible but owned by agent b',
    'replay-recall-b-global', 'replay-fixture', 'replay,scope',
    '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z', 'replay-fixture',
    0.7, 'sha256:replay-b-global', 'scoped replay marker globally visible but owned by agent b',
    'none', 'agent-b', 'global', NULL
  ),
  (
    'mem-recall-agent-a-archived', 'fact', 'scoped replay marker archived for agent a',
    'replay-recall-a-archived', 'replay-fixture', 'replay,scope',
    '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z', 'replay-fixture',
    0.6, 'sha256:replay-a-archived', 'scoped replay marker archived for agent a',
    'none', 'agent-a', 'archived', NULL
  );
