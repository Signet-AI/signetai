-- Migration 035: dependency audit history
--
-- Creates entity_dependency_history for immutable per-edge audit records,
-- installs all DB-level audit triggers, backfills existing edges, then
-- stamps legacy related_to edges with a reason (the AFTER UPDATE trigger
-- is already active at that point, so the stamping is itself audited).
-- Parity with TS migration 050-related-to-audit.

CREATE TABLE IF NOT EXISTS entity_dependency_history (
    id                TEXT PRIMARY KEY,
    dependency_id     TEXT NOT NULL,
    source_entity_id  TEXT NOT NULL,
    target_entity_id  TEXT NOT NULL,
    agent_id          TEXT NOT NULL DEFAULT 'default',
    dependency_type   TEXT NOT NULL,
    event             TEXT NOT NULL,
    changed_by        TEXT NOT NULL,
    reason            TEXT NOT NULL,
    previous_reason   TEXT,
    metadata          TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entity_dependency_history_dep
    ON entity_dependency_history(dependency_id);
CREATE INDEX IF NOT EXISTS idx_entity_dependency_history_agent
    ON entity_dependency_history(agent_id);
CREATE INDEX IF NOT EXISTS idx_entity_dependency_history_created
    ON entity_dependency_history(created_at DESC);

DROP TRIGGER IF EXISTS trg_entity_dependencies_related_to_reason_insert;
DROP TRIGGER IF EXISTS trg_entity_dependencies_related_to_reason_update;
DROP TRIGGER IF EXISTS trg_entity_dependencies_audit_insert;
DROP TRIGGER IF EXISTS trg_entity_dependencies_audit_update;
DROP TRIGGER IF EXISTS trg_entity_dependencies_audit_delete;

CREATE TRIGGER trg_entity_dependencies_related_to_reason_insert
BEFORE INSERT ON entity_dependencies
FOR EACH ROW
WHEN NEW.dependency_type = 'related_to'
  AND (NEW.reason IS NULL OR length(trim(NEW.reason)) = 0)
BEGIN
    SELECT RAISE(ABORT, 'related_to dependencies require a non-empty reason');
END;

CREATE TRIGGER trg_entity_dependencies_related_to_reason_update
BEFORE UPDATE OF dependency_type, reason ON entity_dependencies
FOR EACH ROW
WHEN NEW.dependency_type = 'related_to'
  AND (NEW.reason IS NULL OR length(trim(NEW.reason)) = 0)
BEGIN
    SELECT RAISE(ABORT, 'related_to dependencies require a non-empty reason');
END;

-- DB-level audit triggers: capture all insert/update/delete events at the
-- database layer, covering FK cascades, direct SQL, and application paths.
CREATE TRIGGER trg_entity_dependencies_audit_insert
AFTER INSERT ON entity_dependencies
FOR EACH ROW
BEGIN
    INSERT INTO entity_dependency_history (
        id, dependency_id, source_entity_id, target_entity_id, agent_id,
        dependency_type, event, changed_by, reason, previous_reason,
        metadata, created_at
    ) VALUES (
        lower(hex(randomblob(16))),
        NEW.id,
        NEW.source_entity_id,
        NEW.target_entity_id,
        NEW.agent_id,
        NEW.dependency_type,
        'created',
        'db-trigger',
        COALESCE(NEW.reason, 'created without reason'),
        NULL,
        '{"source":"trg_entity_dependencies_audit_insert"}',
        datetime('now')
    );
END;

CREATE TRIGGER trg_entity_dependencies_audit_update
AFTER UPDATE ON entity_dependencies
FOR EACH ROW
BEGIN
    INSERT INTO entity_dependency_history (
        id, dependency_id, source_entity_id, target_entity_id, agent_id,
        dependency_type, event, changed_by, reason, previous_reason,
        metadata, created_at
    ) VALUES (
        lower(hex(randomblob(16))),
        NEW.id,
        NEW.source_entity_id,
        NEW.target_entity_id,
        NEW.agent_id,
        NEW.dependency_type,
        'updated',
        'db-trigger',
        COALESCE(NEW.reason, 'updated without reason'),
        OLD.reason,
        '{"source":"trg_entity_dependencies_audit_update"}',
        datetime('now')
    );
END;

CREATE TRIGGER trg_entity_dependencies_audit_delete
AFTER DELETE ON entity_dependencies
FOR EACH ROW
BEGIN
    INSERT INTO entity_dependency_history (
        id, dependency_id, source_entity_id, target_entity_id, agent_id,
        dependency_type, event, changed_by, reason, previous_reason,
        metadata, created_at
    ) VALUES (
        lower(hex(randomblob(16))),
        OLD.id,
        OLD.source_entity_id,
        OLD.target_entity_id,
        OLD.agent_id,
        OLD.dependency_type,
        'deleted',
        'db-trigger',
        COALESCE(OLD.reason, 'deleted without reason'),
        NULL,
        '{"source":"trg_entity_dependencies_audit_delete"}',
        datetime('now')
    );
END;

-- Backfill existing edges with their original state. Triggers are active now,
-- but this INSERT goes into entity_dependency_history directly so no trigger
-- fires on entity_dependencies for this step.
INSERT INTO entity_dependency_history (
    id, dependency_id, source_entity_id, target_entity_id, agent_id,
    dependency_type, event, changed_by, reason, previous_reason,
    metadata, created_at
)
SELECT
    lower(hex(randomblob(16))),
    d.id,
    d.source_entity_id,
    d.target_entity_id,
    d.agent_id,
    d.dependency_type,
    'backfill',
    'migration-035',
    CASE
        WHEN d.reason IS NULL OR length(trim(d.reason)) = 0
            THEN 'legacy dependency without recorded reason'
        ELSE d.reason
    END,
    NULL,
    '{"source":"migration-035"}',
    datetime('now')
FROM entity_dependencies d
WHERE NOT EXISTS (
    SELECT 1
    FROM entity_dependency_history h
    WHERE h.dependency_id = d.id
      AND h.event = 'backfill'
);

-- Stamp a valid reason on unattributed related_to edges. The AFTER UPDATE
-- trigger is active, so this produces an 'updated' history row per affected
-- edge, completing the audit trail for this migration step.
UPDATE entity_dependencies
SET reason = 'legacy-unattributed related_to edge'
WHERE dependency_type = 'related_to'
  AND (reason IS NULL OR length(trim(reason)) = 0);
