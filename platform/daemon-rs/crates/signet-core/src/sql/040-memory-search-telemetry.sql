-- Migration 040: Memory Search Telemetry
--
-- Local-only recall QA ledger matching the TypeScript daemon's migration 066.
-- This table intentionally stores query text and recalled result snapshots; it is
-- for local diagnostics/export only and must not be forwarded to external
-- telemetry sinks.

CREATE TABLE IF NOT EXISTS memory_search_telemetry (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    route TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_key TEXT,
    project TEXT,
    query TEXT NOT NULL,
    keyword_query TEXT,
    filters_json TEXT NOT NULL,
    method TEXT NOT NULL,
    result_count INTEGER NOT NULL,
    top_score REAL,
    no_hits INTEGER NOT NULL DEFAULT 0,
    duration_ms REAL NOT NULL DEFAULT 0,
    timings_json TEXT NOT NULL,
    results_json TEXT NOT NULL,
    sources_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_search_telemetry_agent_time
    ON memory_search_telemetry(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_search_telemetry_session
    ON memory_search_telemetry(session_key) WHERE session_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_search_telemetry_route_time
    ON memory_search_telemetry(route, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_search_telemetry_no_hits
    ON memory_search_telemetry(no_hits, created_at DESC);
